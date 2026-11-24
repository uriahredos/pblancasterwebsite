'use strict';
const db = require('./db');

// Each branch keeps its own stock. On hand is what that branch's main warehouse holds, going by the movements in and
// out of it (see inventory.js): deliveries and counts in, parts taken out, returns back.
const inv = require('./inventory');

const ON_HAND = `
  COALESCE((SELECT SUM(m.quantity) FROM inv_moves m WHERE m.to_id = w.id AND m.catalog_id = c.id), 0)
  - COALESCE((SELECT SUM(m.quantity) FROM inv_moves m WHERE m.from_id = w.id AND m.catalog_id = c.id), 0)`;

// Parts in the warehouse that are assigned to jobs and not collected yet (see inventory.js). They are on the shelf,
// so they count as on hand, but nobody else should plan on them: available is on hand less these.
const ASSIGNED = `
  COALESCE((SELECT SUM(MAX(0, h.quantity - COALESCE((SELECT SUM(hm.quantity) FROM inv_moves hm WHERE hm.hold_id = h.id), 0)))
            FROM inv_holds h WHERE h.location_id = w.id AND h.catalog_id = c.id AND h.released_at IS NULL), 0)`;

// Every part the warehouse holds or has held, and every part given a level, so this page and the Inventory page
// never disagree about what is in the warehouse. A part with no level set simply has no minimum or maximum.
const SELECT = `SELECT c.id, c.part_number, c.description, c.category, c.active, w.branch_id, c.cost_cents, bs.count_qty, bs.count_at, bs.min_level, bs.max_level,
    bs.catalog_id IS NOT NULL AS tracked, (${ON_HAND}) AS on_hand, (${ASSIGNED}) AS assigned
  FROM inv_locations w JOIN parts_catalog c LEFT JOIN branch_stock bs ON bs.branch_id = w.branch_id AND bs.catalog_id = c.id
  WHERE w.kind = 'warehouse' AND w.branch_id = ?
    AND c.id IN (SELECT catalog_id FROM branch_stock WHERE branch_id = w.branch_id
                 UNION SELECT catalog_id FROM inv_moves WHERE to_id = w.id UNION SELECT catalog_id FROM inv_moves WHERE from_id = w.id)`;
const withAvailable = (r) => { r.available = r.on_hand - r.assigned; return r; };

function list(branchId, { q = '', low = false, everything = false } = {}) {
  inv.ensureOffice(branchId);
  const params = [branchId];
  let sql = SELECT;
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    sql += " AND (c.part_number LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')";
    params.push(like, like);
  }
  let rows = db.prepare(sql + ' ORDER BY c.part_number').all(...params).map(withAvailable).filter((r) => everything || r.tracked || r.on_hand !== 0);   // gone and never given a level: not listed
  // What left the warehouse in the last 30 days for work (taken to a job or out to a vehicle), not corrections.
  const since = new Date(Date.now() - USE_DAYS * 86400000).toISOString();
  const used = new Map(db.prepare(
    `SELECT m.catalog_id AS id, SUM(m.quantity) AS n FROM inv_moves m JOIN inv_locations w ON w.id = m.from_id
     WHERE w.branch_id = ? AND w.kind = 'warehouse' AND m.kind IN ('use', 'transfer') AND m.created_at >= ? GROUP BY m.catalog_id`).all(branchId, since).map((r) => [r.id, r.n]));
  rows.forEach((r) => {
    // Low and out go by what is available, not by what is on the shelf: a part that is all assigned to jobs is as
    // good as gone for anyone else, and has to be ordered just the same.
    r.low = r.min_level !== null && r.available <= r.min_level;
    r.out = r.available <= 0;
    r.short = r.low || r.out;                 // what the people who look after stock are told about: low, or none left
    r.over = r.max_level !== null && r.on_hand > r.max_level;
    r.used = used.get(r.id) || 0;
    // At the pace of the last 30 days, how many days the shelf lasts. Nothing used: no guess.
    r.days_left = r.used > 0 && r.on_hand > 0 ? Math.floor(r.on_hand / (r.used / USE_DAYS)) : r.used > 0 ? 0 : null;
    // How many to order: enough to bring a low part back up to its maximum (or just past its minimum if it has none).
    // A part that ran out with no levels set: enough to cover what is owed and have one on the shelf.
    r.order = !r.short ? 0 : Math.max(1, (r.max_level !== null ? r.max_level : r.min_level !== null ? r.min_level + 1 : 1) - r.available);
  });
  if (low) rows = rows.filter((r) => r.short);
  return rows;
}
const USE_DAYS = 30;

/** The warehouse in a few numbers, for the top of the page. */
function figures(rows) {
  const priced = rows.filter((r) => r.cost_cents !== null && r.on_hand > 0);
  return {
    tracked: rows.length, items: rows.reduce((n, r) => n + Math.max(0, r.on_hand), 0), noLevel: rows.filter((r) => r.min_level === null).length, low: rows.filter((r) => r.low && r.available > 0).length, out: rows.filter((r) => r.available <= 0).length,
    assigned: rows.reduce((n, r) => n + r.assigned, 0), assignedParts: rows.filter((r) => r.assigned > 0).length,
    over: rows.filter((r) => r.over).length, toOrder: rows.filter((r) => r.order).length, orderUnits: rows.reduce((n, r) => n + r.order, 0),
    valueCents: priced.reduce((n, r) => n + r.on_hand * r.cost_cents, 0), unpriced: rows.filter((r) => r.cost_cents === null && r.on_hand > 0).length,
    used: rows.reduce((n, r) => n + r.used, 0),
    movers: rows.filter((r) => r.used > 0).sort((a, b) => b.used - a.used).slice(0, 5),
    soonest: rows.filter((r) => r.days_left !== null && r.on_hand > 0).sort((a, b) => a.days_left - b.days_left).slice(0, 5),
  };
}

/**
 * Alerts for anything that takes parts out of the warehouse. Call levels() first, do the work, then tellLow():
 * the branch's own stock people hear once, at the moment a part goes from above its minimum to at or below it,
 * or from some on the shelf to none (whether or not it has a minimum). `after`: the rows to look at, when the
 * caller already knows which parts moved; otherwise the whole warehouse.
 * (What is low or out right now is also on their bell for as long as it stays that way: see auth.js.)
 */
const levels = (branchId) => new Map(list(branchId, { everything: true }).map((r) => [r.id, r.available]));
function tellLow(user, branchId, before, after) {
  const rows = (after || list(branchId, { everything: true })).filter((p) => before.has(p.id));
  const out = rows.filter((p) => p.available <= 0 && before.get(p.id) > 0);
  const low = rows.filter((p) => !out.includes(p) && p.min_level !== null && p.available <= p.min_level && before.get(p.id) > p.min_level);
  const crossed = [...out, ...low];
  if (!crossed.length) return crossed;
  const push = require('./push');
  // With nothing assigned to jobs it reads as it always has. With some assigned, it says what is free and why.
  const held = (p) => (p.assigned > 0 ? `${p.assigned} assigned to jobs` : '');
  const line = (p) => (out.includes(p) ? `${p.part_number}: none ${held(p) ? `available (${held(p)})` : 'left'}`
    : `${p.part_number}: ${p.available} ${held(p) ? 'available' : 'left'} (minimum ${p.min_level}${held(p) ? ', ' + held(p) : ''})`);
  push.notify(push.inBranch('stock.manage', branchId), 'low_stock', {
    title: crossed.length > 1 ? `Low or out: ${crossed.length} parts` : out.length ? `${crossed[0].on_hand > 0 ? 'All assigned' : 'Out of stock'}: ${crossed[0].part_number}` : `Low stock: ${crossed[0].part_number}`,
    body: crossed.map(line).join(', '), url: '/admin/stock?low=1' });
  return crossed;
}

/** A branch's stock rows for these part names (as typed on the form). */
function forNames(branchId, names) {
  const wanted = [...new Set(names.map((n) => String(n).trim().toUpperCase()))];
  inv.ensureOffice(branchId);
  return wanted.map((n) => db.prepare(SELECT + ' AND c.part_number = ?').get(branchId, n)).filter(Boolean).map(withAvailable);
}

const lowCount = (branchId) => list(branchId, { low: true }).length;

module.exports = { list, forNames, lowCount, figures, levels, tellLow, USE_DAYS };
