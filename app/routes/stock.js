'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const stock = require('../stock');
const inv = require('../inventory');
const access = require('../permissions');
const activity = require('../activity');
const { requireLogin, requirePerm, verifyCsrf, forbidden, flash } = require('../auth');
const { clean } = require('../util');
const { parseCsv } = require('./catalog');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');
const manage = requirePerm('stock.manage');
const wholeNumber = (v, { signed = false } = {}) => {
  const t = String(v ?? '').trim();
  return (signed ? /^-?\d{1,6}$/ : /^\d{1,6}$/).test(t) ? Number(t) : null;
};
const getPart = (id) => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(id) : null);

/** Start (or restart) tracking a part from a physical count. */
function setCount(branchId, part, qty, minLevel, userId) {
  // The count is the truth: whatever the warehouse's movements said, one more movement makes them agree with it.
  const w = inv.warehouseOf(branchId); const had = inv.onHand(w.id, part.id);
  if (qty > had) inv.move({ branchId, catalogId: part.id, to: w.id, quantity: qty - had, kind: 'adjust', note: 'Counted', userId });
  if (qty < had) inv.move({ branchId, catalogId: part.id, from: w.id, quantity: had - qty, kind: 'adjust', note: 'Counted', userId });
  db.prepare(`INSERT INTO branch_stock (branch_id, catalog_id, count_qty, count_at, min_level) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(branch_id, catalog_id) DO UPDATE SET count_qty = excluded.count_qty, count_at = excluded.count_at, min_level = COALESCE(excluded.min_level, min_level)`)
    .run(branchId, part.id, qty, new Date().toISOString(), minLevel);
}
const tracked = (branchId, part) => Boolean(part && db.prepare('SELECT 1 FROM branch_stock WHERE branch_id = ? AND catalog_id = ?').get(branchId, part.id));

// Anyone who can see the parts log can see stock; changing it needs "manage stock".
router.get('/admin/stock', requireLogin, (req, res) => {
  if (!access.can(req.user, 'parts.view') && !access.can(req.user, 'stock.manage')) return forbidden(res);
  const q = clean(req.query.q, 60);
  const low = req.query.low === '1';
  res.render('admin_stock', page(req, { q, low }));
});
const seesCost = (user) => access.can(user, 'inventory.manage') || access.can(user, 'catalog.manage') || access.can(user, 'inventory.approve');
function page(req, { q = '', low = false, errors = [], values = {} } = {}) {
  const all = stock.list(req.user.workBranch);
  return { title: 'Warehouse stock', rows: q || low ? stock.list(req.user.workBranch, { q, low }) : all, q, low, errors, values,
    total: all.length, lowTotal: all.filter((r) => r.low).length, figures: stock.figures(all), showCost: seesCost(req.user), dollars: inv.dollars, useDays: stock.USE_DAYS };
}

// What to order: every part at or below its minimum, with how many it takes to bring it back up.
router.get('/admin/stock/reorder.csv', requireLogin, (req, res) => {
  if (!access.can(req.user, 'parts.view') && !access.can(req.user, 'stock.manage')) return forbidden(res);
  const office = (db.prepare('SELECT name FROM branches WHERE id = ?').get(req.user.workBranch) || {}).name || '';
  const rows = stock.list(req.user.workBranch, { low: true });
  activity.log(req.user, 'Export downloaded', `Reorder list, ${rows.length} parts`);
  require('../csv').sendCsv(res, `reorder-${office.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${require('../util').localDate()}.csv`,
    ['Branch', 'Part number', 'Description', 'On hand', 'Minimum', 'Maximum', `Used in ${stock.USE_DAYS} days`, 'Order'],
    rows.map((r) => [office, r.part_number, r.description, r.on_hand, r.min_level, r.max_level === null ? '' : r.max_level, r.used, r.order]));
});

router.post('/admin/stock', manage, (req, res) => {
  const number = clean(req.body.part_number, 100);
  // The form asks only for the levels. (A count may still be sent with it, as the count upload does.)
  const given = (v) => String(v ?? '').trim() !== '';
  const withCount = given(req.body.count);
  const count = withCount ? wholeNumber(req.body.count) : null;
  const min = given(req.body.min_level) ? wholeNumber(req.body.min_level) : null;
  const max = given(req.body.max_level) ? wholeNumber(req.body.max_level) : null;
  const errors = [];
  if (!number) errors.push('Enter the part.');
  if (withCount && count === null) errors.push('Enter how many are on the shelf now (a whole number).');
  if (given(req.body.min_level) && min === null) errors.push('The minimum must be a whole number.');
  if (given(req.body.max_level) && max === null) errors.push('The maximum must be a whole number.');
  if (!withCount && !given(req.body.min_level) && !given(req.body.max_level)) errors.push('Enter a minimum, a maximum, or both.');
  if (min !== null && max !== null && max < min) errors.push('The maximum cannot be less than the minimum.');
  if (errors.length) return res.status(400).render('admin_stock', page(req, { errors, values: req.body }));
  let part = db.prepare('SELECT * FROM parts_catalog WHERE part_number = ?').get(number);
  if (!part) { // not in the catalog yet: add it so it can be tracked
    const info = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES (?, '', ?)").run(number, new Date().toISOString());
    part = getPart(info.lastInsertRowid);
  }
  const branchId = req.user.workBranch;
  if (withCount) {
    db.transaction(() => { setCount(branchId, part, count, min, req.user.id); if (max !== null) db.prepare('UPDATE branch_stock SET max_level = ? WHERE branch_id = ? AND catalog_id = ?').run(max, branchId, part.id); })();
    activity.log(req.user, 'Stock count', `${part.part_number}: counted ${count}${min !== null ? ', minimum ' + min : ''}`);
    flash(req, 'ok', `${part.part_number} is now tracked with ${count} on hand.`);
    return res.redirect('/admin/stock');
  }
  // Levels only: nothing is counted and nothing moves. A part not tracked before starts from what the records already hold.
  const had = inv.onHand(inv.warehouseOf(branchId).id, part.id);
  db.prepare(`INSERT INTO branch_stock (branch_id, catalog_id, count_qty, count_at, min_level, max_level) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(branch_id, catalog_id) DO UPDATE SET min_level = COALESCE(excluded.min_level, min_level), max_level = COALESCE(excluded.max_level, max_level)`)
    .run(branchId, part.id, had, new Date().toISOString(), min, max);
  const said = [min !== null ? `minimum ${min}` : '', max !== null ? `maximum ${max}` : ''].filter(Boolean).join(', ');
  activity.log(req.user, 'Stock levels', `${part.part_number}: ${said}`);
  flash(req, 'ok', `${part.part_number}: ${said}. ${had} on hand now.`);
  res.redirect('/admin/stock');
});

// Bulk starting count: a CSV with part number, on hand and (optionally) minimum.
router.post('/admin/stock/import', manage, (req, res, next) => upload(req, res, (err) => {
  req.body = req.body || {}; req.uploadFailed = Boolean(err); next();
}), verifyCsrf, (req, res) => {
  const fail = (msg) => { flash(req, 'err', msg); res.redirect('/admin/stock'); };
  if (req.uploadFailed || !req.file) return fail('Choose a CSV file of up to 5 MB.');
  if (req.file.buffer.subarray(0, 2).toString('latin1') === 'PK') return fail('That is an Excel workbook. Save it as CSV first, then upload the CSV.');
  const rows = parseCsv(req.file.buffer.toString('utf8'));
  if (rows.length < 2) return fail('The file needs a header row and at least one part.');
  const h = rows[0].map((c) => c.trim().toLowerCase());
  const col = (...tests) => { for (const t of tests) { const i = h.findIndex((c) => t.test(c)); if (i >= 0) return i; } return -1; };
  const cNum = col(/^(part|item)[\s_]*(code|number|num|no\.?|#)?$/, /part|item|sku/);
  const cQty = col(/on[\s_]*hand|count|qty|quantity|stock/);
  const cMin = col(/min/); const cMax = col(/max/);
  if (cNum < 0 || cQty < 0) return fail('The file needs a "Part Number" column and an "On hand" column. "Minimum" is optional.');
  const result = { set: 0, added: 0, skipped: 0 };
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      const number = clean(r[cNum], 100);
      const qty = wholeNumber(r[cQty]);
      if (!number || qty === null) { result.skipped++; continue; }
      let part = db.prepare('SELECT * FROM parts_catalog WHERE part_number = ?').get(number);
      if (!part) {
        const info = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES (?, '', ?)").run(number, new Date().toISOString());
        part = getPart(info.lastInsertRowid); result.added++;
      }
      setCount(req.user.workBranch, part, qty, cMin >= 0 ? wholeNumber(r[cMin]) : null, req.user.id);
      const top = cMax >= 0 ? wholeNumber(r[cMax]) : null;
      if (top !== null) db.prepare('UPDATE branch_stock SET max_level = ? WHERE branch_id = ? AND catalog_id = ?').run(top, req.user.workBranch, part.id);
      result.set++;
    }
  })();
  activity.log(req.user, 'Stock import', `${result.set} parts counted from a file`);
  flash(req, 'ok', `Counts set for ${result.set} parts` + (result.added ? `, ${result.added} of them new to the catalog` : '') + (result.skipped ? `. ${result.skipped} rows skipped (no part number or count).` : '.'));
  res.redirect('/admin/stock');
});

router.get('/admin/stock/:id', requireLogin, (req, res) => {
  if (!access.can(req.user, 'parts.view') && !access.can(req.user, 'stock.manage')) return forbidden(res);
  const part = stock.list(req.user.workBranch).find((r) => String(r.id) === req.params.id);
  if (!part) return res.status(404).render('error', { title: 'Page not found', message: 'That part is not being tracked.' });
  const history = db.prepare(
    `SELECT a.quantity, a.reason, a.created_at, u.display_name FROM stock_adjustments a JOIN users u ON u.id = a.user_id
     WHERE a.catalog_id = ? AND a.branch_id = ? ORDER BY a.id DESC LIMIT 50`).all(part.id, req.user.workBranch);
  const moves = db.prepare(
    `SELECT s.id, s.action, s.created_at, i.quantity, u.display_name FROM parts_items i
     JOIN parts_submissions s ON s.id = i.submission_id JOIN users u ON u.id = s.user_id
     WHERE i.part_name = ? COLLATE NOCASE AND s.action IN ('take','return') AND s.cancelled_at IS NULL AND s.created_at > ? AND u.branch_id = ?
     ORDER BY s.id DESC LIMIT 50`).all(part.part_number, part.count_at, req.user.workBranch);
  res.render('admin_stock_part', { title: `Stock: ${part.part_number}`, part, history, moves });
});

router.post('/admin/stock/:id/:op', manage, (req, res) => {
  const part = getPart(req.params.id);
  const branchId = req.user.workBranch;
  if (!part) return res.redirect('/admin/stock');
  const back = `/admin/stock/${part.id}`;
  switch (req.params.op) {
    case 'adjust': {
      const qty = wholeNumber(req.body.quantity, { signed: true });
      if (!qty) { flash(req, 'err', 'Enter a whole number: positive for a delivery, negative to take stock off.'); break; }
      const reason = clean(req.body.reason, 200);
      const before = stock.levels(branchId);
      db.transaction(() => {
        db.prepare('INSERT INTO stock_adjustments (catalog_id, quantity, reason, user_id, created_at, branch_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(part.id, qty, reason || null, req.user.id, new Date().toISOString(), branchId);
        const w = inv.warehouseOf(branchId);
        if (qty > 0) inv.move({ branchId, catalogId: part.id, to: w.id, quantity: qty, kind: 'receive', note: reason || null, userId: req.user.id });
        else inv.move({ branchId, catalogId: part.id, from: w.id, quantity: -qty, kind: 'adjust', note: reason || null, userId: req.user.id });
      })();
      stock.tellLow(req.user, branchId, before);
      activity.log(req.user, 'Stock adjusted', `${part.part_number}: ${qty > 0 ? '+' : ''}${qty}${reason ? ' (' + reason + ')' : ''}`);
      flash(req, 'ok', `${qty > 0 ? 'Added ' + qty : 'Removed ' + -qty}.`);
      break;
    }
    case 'count': {
      const qty = wholeNumber(req.body.count);
      if (qty === null) { flash(req, 'err', 'Enter how many are on the shelf (a whole number).'); break; }
      db.transaction(() => setCount(branchId, part, qty, null, req.user.id))();
      activity.log(req.user, 'Stock count', `${part.part_number}: counted ${qty}`);
      flash(req, 'ok', `Count set to ${qty}.`);
      break;
    }
    case 'min': {
      const blank = String(req.body.min_level ?? '').trim() === '';
      const min = blank ? null : wholeNumber(req.body.min_level);
      if (!blank && min === null) { flash(req, 'err', 'The minimum must be a whole number, or blank for none.'); break; }
      // The same form carries the maximum. (Without that box, as older pages sent it, the maximum is left alone.)
      const hasMax = req.body.max_level !== undefined; const noMax = String(req.body.max_level ?? '').trim() === '';
      const max = noMax ? null : wholeNumber(req.body.max_level);
      if (hasMax && !noMax && max === null) { flash(req, 'err', 'The maximum must be a whole number, or blank for none.'); break; }
      if (min !== null && max !== null && max < min) { flash(req, 'err', 'The maximum cannot be less than the minimum.'); break; }
      // A part that is in the warehouse but has never had a level starts its record here, from what the records hold.
      db.prepare('INSERT OR IGNORE INTO branch_stock (branch_id, catalog_id, count_qty, count_at) VALUES (?, ?, ?, ?)').run(branchId, part.id, inv.onHand(inv.warehouseOf(branchId).id, part.id), new Date().toISOString());
      db.prepare('UPDATE branch_stock SET min_level = ? WHERE branch_id = ? AND catalog_id = ?').run(min, branchId, part.id);
      if (hasMax) db.prepare('UPDATE branch_stock SET max_level = ? WHERE branch_id = ? AND catalog_id = ?').run(max, branchId, part.id);
      activity.log(req.user, 'Stock minimum', `${part.part_number}: ${blank ? 'no minimum' : 'minimum ' + min}${hasMax ? (noMax ? ', no maximum' : ', maximum ' + max) : ''}`);
      flash(req, 'ok', hasMax ? 'Levels saved.' : blank ? 'Minimum removed.' : `Minimum set to ${min}.`);
      break;
    }
    case 'stop':
      db.prepare('DELETE FROM branch_stock WHERE branch_id = ? AND catalog_id = ?').run(branchId, part.id);
      activity.log(req.user, 'Stock tracking stopped', part.part_number);
      flash(req, 'ok', `${part.part_number} is no longer tracked.`);
      return res.redirect('/admin/stock');
    default:
  }
  res.redirect(back);
});

module.exports = router;
