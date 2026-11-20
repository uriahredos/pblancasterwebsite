'use strict';
// The monthly count. An office counts what is really in each of its locations; the site sets that against what the
// movements said, a manager looks over the differences and closes the month. Closing writes one movement per
// difference, so the records agree with the shelves, and keeps a copy of every location's figures as they stood:
// that copy is the month's inventory, and nothing done afterwards changes it.
const db = require('./db');
const inv = require('./inventory');

db.exec(`
CREATE TABLE IF NOT EXISTS inv_audits (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  month TEXT NOT NULL,                              -- 2026-11
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  started_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  UNIQUE (branch_id, month)
);
CREATE UNIQUE INDEX IF NOT EXISTS inv_audits_open ON inv_audits(branch_id) WHERE status = 'open';
-- What someone counted, and what the movements said was there at that moment.
CREATE TABLE IF NOT EXISTS inv_counts (
  audit_id INTEGER NOT NULL REFERENCES inv_audits(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES inv_locations(id),
  catalog_id INTEGER NOT NULL REFERENCES parts_catalog(id),
  expected INTEGER NOT NULL,
  counted INTEGER NOT NULL CHECK (counted >= 0),
  counted_by INTEGER REFERENCES users(id),
  counted_at TEXT NOT NULL,
  PRIMARY KEY (audit_id, location_id, catalog_id)
);
-- The month as it was closed: every location, every part, how many and what one cost that day.
CREATE TABLE IF NOT EXISTS inv_snapshots (
  audit_id INTEGER NOT NULL REFERENCES inv_audits(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES inv_locations(id),
  catalog_id INTEGER NOT NULL REFERENCES parts_catalog(id),
  quantity INTEGER NOT NULL,
  cost_cents INTEGER,
  PRIMARY KEY (audit_id, location_id, catalog_id)
);
`);

const now = () => new Date().toISOString();
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => (isMonth(m) ? `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` : String(m));

const get = (id) => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM inv_audits WHERE id = ?').get(id) : null);
const open = (branchId) => db.prepare("SELECT * FROM inv_audits WHERE branch_id = ? AND status = 'open'").get(branchId) || null;
const past = (branchId) => db.prepare(
  `SELECT a.*, u.display_name AS closed_name FROM inv_audits a LEFT JOIN users u ON u.id = a.closed_by
   WHERE a.branch_id = ? AND a.status = 'closed' ORDER BY a.month DESC`).all(branchId);

/** Start a month's count. Returns its id, or a sentence saying why not. */
function start(branchId, month, userId) {
  if (!isMonth(month)) return 'Choose the month.';
  if (open(branchId)) return 'A count is already under way. Close it, or set it aside, before starting another.';
  if (db.prepare('SELECT 1 FROM inv_audits WHERE branch_id = ? AND month = ?').get(branchId, month)) return `${monthName(month)} has already been counted and closed.`;
  return db.prepare('INSERT INTO inv_audits (branch_id, month, started_by, started_at) VALUES (?, ?, ?, ?)').run(branchId, month, userId, now()).lastInsertRowid;
}

/** The parts to count in a location: what it holds, what has already been counted there, and (for the warehouse) every part the office tracks. */
function sheet(audit, place) {
  return db.prepare(
    `SELECT c.id, c.part_number, c.description, k.counted FROM parts_catalog c
     LEFT JOIN inv_counts k ON k.audit_id = ? AND k.location_id = ? AND k.catalog_id = c.id
     WHERE k.catalog_id IS NOT NULL
        OR c.id IN (SELECT catalog_id FROM (SELECT catalog_id, quantity AS q FROM inv_moves WHERE to_id = ? UNION ALL SELECT catalog_id, -quantity FROM inv_moves WHERE from_id = ?) GROUP BY catalog_id HAVING SUM(q) <> 0)
        OR (? = 'warehouse' AND c.id IN (SELECT catalog_id FROM branch_stock WHERE branch_id = ?))
     ORDER BY c.part_number`).all(audit.id, place.id, place.id, place.id, place.kind, place.branch_id);
}

/** Write down one count (or, with nothing given, take it back). What the movements say is there is noted at the same moment. */
function count(audit, place, catalogId, counted, userId) {
  if (counted === null) return db.prepare('DELETE FROM inv_counts WHERE audit_id = ? AND location_id = ? AND catalog_id = ?').run(audit.id, place.id, catalogId);
  return db.prepare(
    `INSERT INTO inv_counts (audit_id, location_id, catalog_id, expected, counted, counted_by, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(audit_id, location_id, catalog_id) DO UPDATE SET expected = excluded.expected, counted = excluded.counted, counted_by = excluded.counted_by, counted_at = excluded.counted_at`)
    .run(audit.id, place.id, catalogId, inv.onHand(place.id, catalogId), counted, userId, now());
}

/** How the count stands: each location with how much of it is done, and every line where the count and the records differ. */
function progress(audit) {
  const places = inv.locations(audit.branch_id).map((l) => {
    const due = sheet(audit, l);
    return { ...l, due: due.length, done: due.filter((p) => p.counted !== null).length };
  });
  const differences = db.prepare(
    `SELECT k.*, l.name AS location, c.part_number, c.description, c.cost_cents, u.display_name AS counted_name FROM inv_counts k
     JOIN inv_locations l ON l.id = k.location_id JOIN parts_catalog c ON c.id = k.catalog_id LEFT JOIN users u ON u.id = k.counted_by
     WHERE k.audit_id = ? AND k.counted <> k.expected ORDER BY l.name COLLATE NOCASE, c.part_number`).all(audit.id);
  const lines = db.prepare('SELECT COUNT(*) AS n FROM inv_counts WHERE audit_id = ?').get(audit.id).n;
  return { places, differences, lines, notStarted: places.filter((l) => l.due && !l.done), value: differences.reduce((n, d) => n + (d.cost_cents === null ? 0 : (d.counted - d.expected) * d.cost_cents), 0) };
}

/**
 * Close the month. Each difference becomes a movement, so the records say what was counted (parts that moved after
 * they were counted are left as they moved). What was marked "to check" in a counted place is settled. Then every
 * location's figures are copied as they stand, with what each part costs today.
 */
function close(audit, userId) {
  return db.transaction(() => {
    const lines = db.prepare('SELECT * FROM inv_counts WHERE audit_id = ?').all(audit.id);
    let changed = 0;
    for (const k of lines) {
      const note = `Counted for ${monthName(audit.month)}`;
      if (k.counted > k.expected) { inv.move({ branchId: audit.branch_id, catalogId: k.catalog_id, to: k.location_id, quantity: k.counted - k.expected, kind: 'adjust', note, userId }); changed += 1; }
      if (k.counted < k.expected) { inv.move({ branchId: audit.branch_id, catalogId: k.catalog_id, from: k.location_id, quantity: k.expected - k.counted, kind: 'adjust', note, userId }); changed += 1; }
      db.prepare('UPDATE inv_moves SET flagged = 0 WHERE from_id = ? AND catalog_id = ? AND flagged = 1').run(k.location_id, k.catalog_id);
      // The Stock page's "last counted" follows a count of the warehouse.
      db.prepare(`UPDATE branch_stock SET count_qty = ?, count_at = ? WHERE branch_id = ? AND catalog_id = ?
                    AND EXISTS (SELECT 1 FROM inv_locations l WHERE l.id = ? AND l.kind = 'warehouse')`).run(k.counted, k.counted_at, audit.branch_id, k.catalog_id, k.location_id);
    }
    const keep = db.prepare('INSERT INTO inv_snapshots (audit_id, location_id, catalog_id, quantity, cost_cents) VALUES (?, ?, ?, ?, ?)');
    for (const l of inv.locations(audit.branch_id, { withRetired: true })) for (const p of inv.contents(l.id)) keep.run(audit.id, l.id, p.id, p.on_hand, p.cost_cents);
    db.prepare("UPDATE inv_audits SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?").run(userId, now(), audit.id);
    return { lines: lines.length, changed };
  })();
}

/** A closed month's figures: one row per part per location, as they stood when it was closed. */
function closedFigures(auditId) {
  return db.prepare(
    `SELECT l.name AS location, l.kind, c.part_number, c.description, s.quantity, s.cost_cents FROM inv_snapshots s
     JOIN inv_locations l ON l.id = s.location_id JOIN parts_catalog c ON c.id = s.catalog_id
     WHERE s.audit_id = ? ORDER BY CASE l.kind WHEN 'warehouse' THEN 0 WHEN 'vehicle' THEN 1 ELSE 2 END, l.name COLLATE NOCASE, c.part_number`).all(auditId);
}

/** Set an open count aside: what was counted is thrown away and nothing else changes. */
const discard = (audit) => db.prepare("DELETE FROM inv_audits WHERE id = ? AND status = 'open'").run(audit.id);

/** For the bell: this person's own vehicle, when a count is under way and nothing in it has been counted yet. */
function vehicleToCount(user) {
  const a = open(user.branch_id); if (!a) return null;
  const v = inv.vehicleOf(user.id); if (!v || v.branch_id !== user.branch_id) return null;
  if (db.prepare('SELECT 1 FROM inv_counts WHERE audit_id = ? AND location_id = ?').get(a.id, v.id)) return null;
  return `/admin/inventory/count/${a.id}/${v.id}`;
}

module.exports = { isMonth, monthName, get, open, past, start, sheet, count, progress, close, closedFigures, discard, vehicleToCount };
