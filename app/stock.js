'use strict';
const db = require('./db');

// Each branch keeps its own stock. On hand is what that branch's main warehouse holds, going by the movements in and
// out of it (see inventory.js): deliveries and counts in, parts taken out, returns back.
const inv = require('./inventory');

const ON_HAND = `
  COALESCE((SELECT SUM(m.quantity) FROM inv_moves m WHERE m.to_id = w.id AND m.catalog_id = c.id), 0)
  - COALESCE((SELECT SUM(m.quantity) FROM inv_moves m WHERE m.from_id = w.id AND m.catalog_id = c.id), 0)`;

const SELECT = `SELECT c.id, c.part_number, c.description, c.category, c.active, bs.branch_id, c.cost_cents, bs.count_qty, bs.count_at, bs.min_level, bs.max_level, (${ON_HAND}) AS on_hand
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
  // What left the warehouse in the last 30 days for work (taken to a job or out to a vehicle), not corrections.
  const since = new Date(Date.now() - USE_DAYS * 86400000).toISOString();
  const used = new Map(db.prepare(
    `SELECT m.catalog_id AS id, SUM(m.quantity) AS n FROM inv_moves m JOIN inv_locations w ON w.id = m.from_id
     WHERE w.branch_id = ? AND w.kind = 'warehouse' AND m.kind IN ('use', 'transfer') AND m.created_at >= ? GROUP BY m.catalog_id`).all(branchId, since).map((r) => [r.id, r.n]));
  rows.forEach((r) => {
    r.low = r.min_level !== null && r.on_hand <= r.min_level;
    r.over = r.max_level !== null && r.on_hand > r.max_level;
    r.used = used.get(r.id) || 0;
    // At the pace of the last 30 days, how many days the shelf lasts. Nothing used: no guess.
    r.days_left = r.used > 0 && r.on_hand > 0 ? Math.floor(r.on_hand / (r.used / USE_DAYS)) : r.used > 0 ? 0 : null;
    // How many to order: enough to bring a low part back up to its maximum (or just past its minimum if it has none).
    r.order = !r.low ? 0 : Math.max(1, (r.max_level !== null ? r.max_level : r.min_level + 1) - r.on_hand);
  });
  if (low) rows = rows.filter((r) => r.low);
  return rows;
}
const USE_DAYS = 30;

/** The warehouse in a few numbers, for the top of the page. */
function figures(rows) {
  const priced = rows.filter((r) => r.cost_cents !== null && r.on_hand > 0);
  return {
    tracked: rows.length, low: rows.filter((r) => r.low && r.on_hand > 0).length, out: rows.filter((r) => r.on_hand <= 0).length,
    over: rows.filter((r) => r.over).length, toOrder: rows.filter((r) => r.order).length, orderUnits: rows.reduce((n, r) => n + r.order, 0),
    valueCents: priced.reduce((n, r) => n + r.on_hand * r.cost_cents, 0), unpriced: rows.filter((r) => r.cost_cents === null && r.on_hand > 0).length,
    used: rows.reduce((n, r) => n + r.used, 0),
    movers: rows.filter((r) => r.used > 0).sort((a, b) => b.used - a.used).slice(0, 5),
    soonest: rows.filter((r) => r.days_left !== null && r.on_hand > 0).sort((a, b) => a.days_left - b.days_left).slice(0, 5),
  };
}

/**
 * Low-stock alerts for anything that takes parts out of the warehouse. Call before() first, do the work, then
 * tell(): the people who look after stock hear once, when a part goes from above its minimum to at or below it.
 */
const levels = (branchId) => new Map(list(branchId).map((r) => [r.id, r.on_hand]));
function tellLow(user, branchId, before) {
  const crossed = list(branchId).filter((p) => p.min_level !== null && p.on_hand <= p.min_level && before.has(p.id) && before.get(p.id) > p.min_level);
  if (!crossed.length) return crossed;
  const push = require('./push');
  push.notify(push.peopleWith('stock.manage', user.id), 'low_stock', {
    title: crossed.length === 1 ? `Low stock: ${crossed[0].part_number}` : `Low stock: ${crossed.length} parts`,
    body: crossed.map((p) => `${p.part_number}: ${p.on_hand} left (minimum ${p.min_level})`).join(', '), url: '/admin/stock?low=1' });
  return crossed;
}

/** A branch's stock rows for these part names (as typed on the form). */
function forNames(branchId, names) {
  const wanted = [...new Set(names.map((n) => String(n).trim().toUpperCase()))];
  inv.ensureOffice(branchId);
  return wanted.map((n) => db.prepare(SELECT + ' AND c.part_number = ?').get(branchId, n)).filter(Boolean);
}

const lowCount = (branchId) => list(branchId, { low: true }).length;

module.exports = { list, forNames, lowCount, figures, levels, tellLow, USE_DAYS };
