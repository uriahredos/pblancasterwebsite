'use strict';
const db = require('./db');

// On hand = last count + deliveries/corrections - taken + returned, all since that count.
// Entries are matched to a catalog part by part number, ignoring case and stray spaces.
const ON_HAND = `
  c.count_qty
  + COALESCE((SELECT SUM(a.quantity) FROM stock_adjustments a WHERE a.catalog_id = c.id AND a.created_at > c.count_at), 0)
  - COALESCE((SELECT SUM(i.quantity) FROM parts_items i JOIN parts_submissions s ON s.id = i.submission_id
              WHERE s.action = 'take' AND s.cancelled_at IS NULL AND s.created_at > c.count_at
                AND i.part_name = c.part_number COLLATE NOCASE), 0)
  + COALESCE((SELECT SUM(i.quantity) FROM parts_items i JOIN parts_submissions s ON s.id = i.submission_id
              WHERE s.action = 'return' AND s.cancelled_at IS NULL AND s.created_at > c.count_at
                AND i.part_name = c.part_number COLLATE NOCASE), 0)`;

const SELECT = `SELECT c.*, (${ON_HAND}) AS on_hand FROM parts_catalog c WHERE c.stocked = 1`;

function list({ q = '', low = false } = {}) {
  const params = [];
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

/** Stock rows for these part names (as typed on the form). */
function forNames(names) {
  const wanted = [...new Set(names.map((n) => String(n).trim().toUpperCase()))];
  return wanted.map((n) => db.prepare(SELECT + ' AND c.part_number = ?').get(n)).filter(Boolean);
}

const lowCount = () => list({ low: true }).length;

module.exports = { list, forNames, lowCount };
