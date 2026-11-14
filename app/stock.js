'use strict';
const db = require('./db');

// Each branch keeps its own stock. On hand = that branch's last count + its deliveries/corrections
// - parts its people took + parts they returned, all since that count.
// Entries are matched to a catalog part by part number, ignoring case and stray spaces.
const ON_HAND = `
  bs.count_qty
  + COALESCE((SELECT SUM(a.quantity) FROM stock_adjustments a WHERE a.catalog_id = c.id AND a.branch_id = bs.branch_id AND a.created_at > bs.count_at), 0)
  - COALESCE((SELECT SUM(i.quantity) FROM parts_items i JOIN parts_submissions s ON s.id = i.submission_id JOIN users su ON su.id = s.user_id
              WHERE s.action = 'take' AND s.cancelled_at IS NULL AND s.created_at > bs.count_at AND su.branch_id = bs.branch_id
                AND i.part_name = c.part_number COLLATE NOCASE), 0)
  + COALESCE((SELECT SUM(i.quantity) FROM parts_items i JOIN parts_submissions s ON s.id = i.submission_id JOIN users su ON su.id = s.user_id
              WHERE s.action = 'return' AND s.cancelled_at IS NULL AND s.created_at > bs.count_at AND su.branch_id = bs.branch_id
                AND i.part_name = c.part_number COLLATE NOCASE), 0)`;

const SELECT = `SELECT c.id, c.part_number, c.description, c.category, c.active, bs.branch_id, bs.count_qty, bs.count_at, bs.min_level, (${ON_HAND}) AS on_hand
  FROM branch_stock bs JOIN parts_catalog c ON c.id = bs.catalog_id WHERE bs.branch_id = ?`;

function list(branchId, { q = '', low = false } = {}) {
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
  return wanted.map((n) => db.prepare(SELECT + ' AND c.part_number = ?').get(branchId, n)).filter(Boolean);
}

const lowCount = (branchId) => list(branchId, { low: true }).length;

module.exports = { list, forNames, lowCount };
