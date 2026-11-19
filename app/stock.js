'use strict';
const db = require('./db');

// Each branch keeps its own stock. On hand = that branch's last count + its deliveries/corrections
// - parts its people took + parts they returned, all since that count.
// Entries are matched to a catalog part by part number, ignoring case and stray spaces.

// What the branch's people took (counted as minus) and returned (plus) since each part's count, for every part in
// one pass. It starts from the branch's own people, in that order on purpose (CROSS JOIN keeps the order as
// written), so another branch's entries are never read however many there are.
const MOVED = `
  SELECT k.catalog_id, SUM(CASE WHEN s.action = 'take' THEN -i.quantity ELSE i.quantity END) AS net
  FROM users su CROSS JOIN parts_submissions s ON s.user_id = su.id CROSS JOIN parts_items i ON i.submission_id = s.id
  CROSS JOIN parts_catalog kc ON i.part_name = kc.part_number COLLATE NOCASE
  CROSS JOIN branch_stock k ON k.branch_id = su.branch_id AND k.catalog_id = kc.id
  WHERE su.branch_id = ? AND s.action IN ('take', 'return') AND s.cancelled_at IS NULL AND s.created_at > k.count_at
  GROUP BY k.catalog_id`;

const ON_HAND = `
  bs.count_qty
  + COALESCE((SELECT SUM(a.quantity) FROM stock_adjustments a WHERE a.catalog_id = c.id AND a.branch_id = bs.branch_id AND a.created_at > bs.count_at), 0)
  + COALESCE(m.net, 0)`;

const SELECT = `SELECT c.id, c.part_number, c.description, c.category, c.active, bs.branch_id, bs.count_qty, bs.count_at, bs.min_level, (${ON_HAND}) AS on_hand
  FROM branch_stock bs JOIN parts_catalog c ON c.id = bs.catalog_id LEFT JOIN (${MOVED}) m ON m.catalog_id = bs.catalog_id WHERE bs.branch_id = ?`;

function list(branchId, { q = '', low = false } = {}) {
  const params = [branchId, branchId];   // once for the branch's entries, once for its shelf
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
  return wanted.map((n) => db.prepare(SELECT + ' AND c.part_number = ?').get(branchId, branchId, n)).filter(Boolean);
}

const lowCount = (branchId) => list(branchId, { low: true }).length;

module.exports = { list, forNames, lowCount };
