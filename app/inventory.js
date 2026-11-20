'use strict';
// Inventory: where an office's parts are. Every office has one main warehouse, a location for each technician's
// vehicle, and any others it adds for itself (a trailer, a second stockroom). What is in a location is never typed
// over: it is worked out from the movements in and out of it, so there is always a record of who moved what, and when.
const db = require('./db');
require('./removal');   // people's records carry a "removed" mark this file reads; that file adds the column

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inv_locations (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  kind TEXT NOT NULL CHECK (kind IN ('warehouse','vehicle','custom')),
  name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),          -- a vehicle's technician; nobody for the others
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inv_locations_branch ON inv_locations(branch_id);
-- One warehouse an office, and one vehicle a technician.
CREATE UNIQUE INDEX IF NOT EXISTS inv_locations_warehouse ON inv_locations(branch_id) WHERE kind = 'warehouse';
CREATE UNIQUE INDEX IF NOT EXISTS inv_locations_vehicle ON inv_locations(user_id) WHERE kind = 'vehicle' AND active = 1;

-- A movement: so many of a part out of one place and into another. Parts arriving have no "from"; parts used on a
-- job have no "to". On hand in a location is everything moved in, less everything moved out.
CREATE TABLE IF NOT EXISTS inv_moves (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  catalog_id INTEGER NOT NULL REFERENCES parts_catalog(id),
  from_id INTEGER REFERENCES inv_locations(id),
  to_id INTEGER REFERENCES inv_locations(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  kind TEXT NOT NULL CHECK (kind IN ('opening','receive','transfer','use','return','adjust')),
  submission_id INTEGER REFERENCES parts_submissions(id) ON DELETE CASCADE,   -- an entry deleted for good takes its movements with it
  flagged INTEGER NOT NULL DEFAULT 0,            -- the place it came from did not have that many on record
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (from_id IS NOT NULL OR to_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS inv_moves_from ON inv_moves(from_id, catalog_id);
CREATE INDEX IF NOT EXISTS inv_moves_to ON inv_moves(to_id, catalog_id);
CREATE INDEX IF NOT EXISTS inv_moves_submission ON inv_moves(submission_id);
`;
db.exec(SCHEMA);

// The first release made the movements table without "ON DELETE CASCADE". Nothing had been written to it then, so it is made again.
if (!/ON DELETE CASCADE/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'inv_moves'").get().sql) && !db.prepare('SELECT 1 FROM inv_moves').get()) {
  db.exec('DROP TABLE inv_moves'); db.exec(SCHEMA);
}

const now = () => new Date().toISOString();
const KINDS = { warehouse: 'Main warehouse', vehicle: 'Vehicle', custom: 'Other' };

/**
 * Make sure an office has its warehouse, and a vehicle for each of its people who has a truck number on file.
 * Safe to call as often as wanted: it only ever adds what is missing.
 */
function ensureOffice(branchId) {
  if (!branchId) return;
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO inv_locations (branch_id, kind, name, created_at) VALUES (?, 'warehouse', 'Main warehouse', ?)").run(branchId, now());
    const people = db.prepare(
      `SELECT u.id, u.default_truck FROM users u
       WHERE u.branch_id = ? AND u.active = 1 AND u.removed_at IS NULL AND TRIM(COALESCE(u.default_truck, '')) <> ''
         AND NOT EXISTS (SELECT 1 FROM inv_locations l WHERE l.kind = 'vehicle' AND l.user_id = u.id)`).all(branchId);
    const add = db.prepare("INSERT OR IGNORE INTO inv_locations (branch_id, kind, name, user_id, created_at) VALUES (?, 'vehicle', ?, ?, ?)");
    for (const p of people) add.run(branchId, `Truck ${String(p.default_truck).trim()}`, p.id, now());
  })();
}

/** An office's locations: the warehouse first, then vehicles by name, then the others. `parts` and `units` say what each holds. */
function locations(branchId, { withRetired = false } = {}) {
  ensureOffice(branchId);
  return db.prepare(
    `SELECT l.*, u.display_name AS technician,
       (SELECT COUNT(*) FROM (SELECT catalog_id FROM (
          SELECT catalog_id, quantity AS q FROM inv_moves WHERE to_id = l.id UNION ALL SELECT catalog_id, -quantity FROM inv_moves WHERE from_id = l.id)
          GROUP BY catalog_id HAVING SUM(q) <> 0)) AS parts,
       COALESCE((SELECT SUM(quantity) FROM inv_moves WHERE to_id = l.id), 0) - COALESCE((SELECT SUM(quantity) FROM inv_moves WHERE from_id = l.id), 0) AS units,
       (SELECT COUNT(*) FROM inv_moves WHERE from_id = l.id AND flagged = 1) AS flagged
     FROM inv_locations l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.branch_id = ? ${withRetired ? '' : 'AND l.active = 1'}
     ORDER BY CASE l.kind WHEN 'warehouse' THEN 0 WHEN 'vehicle' THEN 1 ELSE 2 END, l.active DESC, l.name COLLATE NOCASE`).all(branchId);
}

const location = (id) => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM inv_locations WHERE id = ?').get(id) : null);

/** What a location holds, part by part, with nothing listed that nets to zero. */
function contents(locationId) {
  return db.prepare(
    `SELECT c.id, c.part_number, c.description, c.cost_cents, SUM(m.q) AS on_hand FROM (
       SELECT catalog_id, quantity AS q FROM inv_moves WHERE to_id = ? UNION ALL SELECT catalog_id, -quantity FROM inv_moves WHERE from_id = ?) m
     JOIN parts_catalog c ON c.id = m.catalog_id GROUP BY c.id HAVING SUM(m.q) <> 0 ORDER BY c.part_number`).all(locationId, locationId);
}

/**
 * Everything held in an office's locations (or in every office's, with no office given), one row per part per location.
 * A location given by id narrows it to that one. Nothing that nets to zero is listed.
 */
function holdings({ branchId = null, locationId = null } = {}) {
  return db.prepare(
    `SELECT b.name AS office, l.id AS location_id, l.name AS location, l.kind, u.display_name AS technician,
            c.part_number, c.description, c.cost_cents, SUM(m.q) AS on_hand
     FROM (SELECT to_id AS loc, catalog_id, quantity AS q FROM inv_moves WHERE to_id IS NOT NULL
           UNION ALL SELECT from_id, catalog_id, -quantity FROM inv_moves WHERE from_id IS NOT NULL) m
     JOIN inv_locations l ON l.id = m.loc JOIN branches b ON b.id = l.branch_id JOIN parts_catalog c ON c.id = m.catalog_id
     LEFT JOIN users u ON u.id = l.user_id
     WHERE (? IS NULL OR l.branch_id = ?) AND (? IS NULL OR l.id = ?)
     GROUP BY l.id, c.id HAVING SUM(m.q) <> 0
     ORDER BY b.name COLLATE NOCASE, CASE l.kind WHEN 'warehouse' THEN 0 WHEN 'vehicle' THEN 1 ELSE 2 END, l.name COLLATE NOCASE, c.part_number`)
    .all(branchId, branchId, locationId, locationId);
}

/** People of an office who could be given a vehicle: active, and without one already. */
function withoutVehicle(branchId) {
  return db.prepare(
    `SELECT u.id, u.display_name FROM users u WHERE u.branch_id = ? AND u.active = 1 AND u.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM inv_locations l WHERE l.kind = 'vehicle' AND l.active = 1 AND l.user_id = u.id)
     ORDER BY u.display_name COLLATE NOCASE`).all(branchId);
}

function addVehicle(branchId, name, userId) {
  return db.prepare("INSERT INTO inv_locations (branch_id, kind, name, user_id, created_at) VALUES (?, 'vehicle', ?, ?, ?)").run(branchId, name, userId, now()).lastInsertRowid;
}
function addCustom(branchId, name) {
  return db.prepare("INSERT INTO inv_locations (branch_id, kind, name, created_at) VALUES (?, 'custom', ?, ?)").run(branchId, name, now()).lastInsertRowid;
}

const warehouseOf = (branchId) => { ensureOffice(branchId); return db.prepare("SELECT * FROM inv_locations WHERE branch_id = ? AND kind = 'warehouse'").get(branchId); };
const vehicleOf = (userId) => db.prepare("SELECT * FROM inv_locations WHERE kind = 'vehicle' AND active = 1 AND user_id = ?").get(userId) || null;

/** How many of a part a location holds, going by its movements. */
function onHand(locationId, catalogId) {
  const sum = (col) => db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS n FROM inv_moves WHERE ${col} = ? AND catalog_id = ?`).get(locationId, catalogId).n;
  return sum('to_id') - sum('from_id');
}

/** The vehicles of an office, for the people who look after its stock and sign parts in and out of other people's vehicles. */
function vehiclesOf(branchId) {
  ensureOffice(branchId);
  return db.prepare(
    `SELECT l.id, l.name, l.user_id, u.display_name AS technician FROM inv_locations l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.branch_id = ? AND l.kind = 'vehicle' AND l.active = 1 ORDER BY l.name COLLATE NOCASE`).all(branchId);
}

/** One movement, written down. `flagged` is worked out here: the place it left did not have that many on record. */
function move({ branchId, catalogId, from = null, to = null, quantity, kind, note = null, userId = null, submissionId = null, at = null }) {
  const short = from ? onHand(from, catalogId) < quantity : false;
  return db.prepare(
    `INSERT INTO inv_moves (branch_id, catalog_id, from_id, to_id, quantity, kind, submission_id, flagged, note, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(branchId, catalogId, from, to, quantity, kind, submissionId, short ? 1 : 0, note, userId, at || now()).lastInsertRowid;
}

/**
 * The movements that go with a parts entry, made afresh from the entry as it now stands (so an edit or a cancel only
 * has to call this again). Parts that are not in the catalog move nothing: there is nothing to count them against.
 *
 *   Take for van stock   from the warehouse into the vehicle
 *   Take for a job       out of the vehicle (out of the warehouse for someone with no vehicle)
 *   Return van stock     out of the vehicle, back into the warehouse
 *   Return from a job    back into the vehicle (or the warehouse)
 *
 * "The vehicle" is the one assigned to whoever made the entry. Someone who looks after the office's stock can name
 * another vehicle on the form (place_id), and then it is that one.
 */
function record(submissionId) {
  db.prepare('DELETE FROM inv_moves WHERE submission_id = ?').run(submissionId);
  const s = db.prepare('SELECT s.*, u.branch_id FROM parts_submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(submissionId);
  if (!s || s.cancelled_at || !['take', 'return'].includes(s.action) || !s.branch_id) return 0;
  const warehouse = warehouseOf(s.branch_id); const vehicle = vehicleOf(s.user_id);
  let chosen = s.place_id ? location(s.place_id) : null;
  if (chosen && (chosen.branch_id !== s.branch_id || !chosen.active)) chosen = null;
  // A vehicle named on the form stands in for the person's own. (Entries from the first days could name the warehouse
  // or another place instead: those still read as they were written.)
  const named = chosen && chosen.kind === 'vehicle' ? chosen : null; const place = chosen && chosen.kind !== 'vehicle' ? chosen : null;
  const own = named || (vehicle && vehicle.branch_id === s.branch_id ? vehicle : null);
  let from = null, to = null, kind;
  if (s.action === 'take' && s.source === 'job') { from = place || own || warehouse; kind = 'use'; }
  else if (s.action === 'take') { from = place || warehouse; to = own; kind = own ? 'transfer' : 'use'; }
  else if (s.source === 'job') { to = place || own || warehouse; kind = 'return'; }
  else { to = place || warehouse; from = own; kind = own ? 'transfer' : 'return'; }
  let made = 0;
  for (const it of db.prepare('SELECT part_name, quantity FROM parts_items WHERE submission_id = ? ORDER BY id').all(submissionId)) {
    const part = db.prepare('SELECT id FROM parts_catalog WHERE part_number = ?').get(String(it.part_name).trim());
    if (!part) continue;
    move({ branchId: s.branch_id, catalogId: part.id, from: from && from.id, to: to && to.id, quantity: it.quantity, kind, userId: s.user_id, submissionId, at: s.created_at });
    made += 1;
  }
  return made;
}

/** The latest movements in or out of a location, newest first. */
function history(locationId, limit = 60) {
  return db.prepare(
    `SELECT m.*, c.part_number, u.display_name, f.name AS from_name, t.name AS to_name FROM inv_moves m
     JOIN parts_catalog c ON c.id = m.catalog_id LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN inv_locations f ON f.id = m.from_id LEFT JOIN inv_locations t ON t.id = m.to_id
     WHERE m.from_id = ? OR m.to_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(locationId, locationId, limit);
}

// ---- Once: what the Stock page said was on each office's shelf becomes that office's opening warehouse stock ----
// Until now "on hand" was the last count, plus deliveries, less what people took since. From here on it is the sum of
// the warehouse's movements, so this writes one opening movement per tracked part and nothing is counted twice.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'inv_opening_1'").get()) {
  db.transaction(() => {
    const rows = db.prepare(
      `SELECT bs.branch_id, bs.catalog_id, bs.count_qty
         + COALESCE((SELECT SUM(a.quantity) FROM stock_adjustments a WHERE a.catalog_id = bs.catalog_id AND a.branch_id = bs.branch_id AND a.created_at > bs.count_at), 0)
         + COALESCE((SELECT SUM(CASE WHEN s.action = 'take' THEN -i.quantity ELSE i.quantity END)
             FROM parts_items i JOIN parts_submissions s ON s.id = i.submission_id JOIN users su ON su.id = s.user_id JOIN parts_catalog kc ON kc.id = bs.catalog_id
             WHERE su.branch_id = bs.branch_id AND i.part_name = kc.part_number COLLATE NOCASE AND s.action IN ('take', 'return') AND s.cancelled_at IS NULL AND s.created_at > bs.count_at), 0) AS on_hand
       FROM branch_stock bs`).all();
    for (const r of rows) {
      if (r.on_hand <= 0) continue;
      const w = warehouseOf(r.branch_id);
      move({ branchId: r.branch_id, catalogId: r.catalog_id, to: w.id, quantity: r.on_hand, kind: 'opening', note: 'On hand when inventory began' });
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('inv_opening_1', ?)").run(now());
  })();
}

/** "12.50", "$1,204.5" or "7" as cents; null for anything that is not an amount of money. */
function cents(text) {
  const t = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,4})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
const dollars = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));

module.exports = { KINDS, ensureOffice, locations, location, contents, withoutVehicle, addVehicle, addCustom, cents, dollars,
  warehouseOf, vehicleOf, onHand, vehiclesOf, move, record, history, holdings };
