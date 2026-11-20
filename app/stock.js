'use strict';
const db = require('./db');

// Each branch keeps its own stock. On hand is what that branch's main warehouse holds, going by the movements in and
// out of it (see inventory.js): deliveries and counts in, parts taken out, returns back.
const inv = require('./inventory');

const ON_HAND = `
  COALESCE((SELECT SUM(m.quantity) FROM inv_moves m WHERE m.to_id = w.id AND m.catalog_id = c.id), 0)
  - COALESCE((SELECT SUM(m.quantity) FROM inv_moves m WHERE m.from_id = w.id AND m.catalog_id = c.id), 0)`;

const SELECT = `SELECT c.id, c.part_number, c.description, c.category, c.active, bs.branch_id, bs.count_qty, bs.count_at, bs.min_level, (${ON_HAND}) AS on_hand
  FROM branch_stock bs JOIN parts_catalog c ON c.id = bs.catalog_id JOIN inv_locations w ON w.branch_id = bs.branch_id AND w.kind = 'warehouse' WHERE bs.branch_id = ?`;

function list(branchId, { q = '', low = false } = {}) {
  inv.ensureOffice(branchId);
  const params = [branchId];
  let sql = SELECT;
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    sql += " AND (c.part_number LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')";
    params.push(like, like);
  }
  let rows = db.prepare(sql + ' ORDER BY c.part_number').all(...params);
  rows.forEach((r) => { r.low = r.min_level !== null && r.on_hand <= r.min_level; });
  if (low) rows = rows.filter((r) => r.low);
  return rows;
}

/** A branch's stock rows for these part names (as typed on the form). */
function forNames(branchId, names) {
  const wanted = [...new Set(names.map((n) => String(n).trim().toUpperCase()))];
  inv.ensureOffice(branchId);
  return wanted.map((n) => db.prepare(SELECT + ' AND c.part_number = ?').get(branchId, n)).filter(Boolean);
}

const lowCount = (branchId) => list(branchId, { low: true }).length;

module.exports = { list, forNames, lowCount };
