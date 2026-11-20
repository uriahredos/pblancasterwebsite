'use strict';
// Inventory: where an office's parts are. Every office has one main warehouse, a location for each technician's
// vehicle, and any others it adds for itself (a trailer, a second stockroom). What is in a location is never typed
// over: it is worked out from the movements in and out of it, so there is always a record of who moved what, and when.
const db = require('./db');

db.exec(`
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
  submission_id INTEGER REFERENCES parts_submissions(id),
  flagged INTEGER NOT NULL DEFAULT 0,            -- the place it came from did not have that many on record
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (from_id IS NOT NULL OR to_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS inv_moves_from ON inv_moves(from_id, catalog_id);
CREATE INDEX IF NOT EXISTS inv_moves_to ON inv_moves(to_id, catalog_id);
CREATE INDEX IF NOT EXISTS inv_moves_submission ON inv_moves(submission_id);
`);

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
       COALESCE((SELECT SUM(quantity) FROM inv_moves WHERE to_id = l.id), 0) - COALESCE((SELECT SUM(quantity) FROM inv_moves WHERE from_id = l.id), 0) AS units
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

/** "12.50", "$1,204.5" or "7" as cents; null for anything that is not an amount of money. */
function cents(text) {
  const t = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,4})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
const dollars = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));

module.exports = { KINDS, ensureOffice, locations, location, contents, withoutVehicle, addVehicle, addCustom, cents, dollars };
