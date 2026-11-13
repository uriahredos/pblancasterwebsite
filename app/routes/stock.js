'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const stock = require('../stock');
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
function setCount(part, qty, minLevel) {
  db.prepare('UPDATE parts_catalog SET stocked = 1, count_qty = ?, count_at = ?, min_level = COALESCE(?, min_level) WHERE id = ?')
    .run(qty, new Date().toISOString(), minLevel, part.id);
}

// Anyone who can see the parts log can see stock; changing it needs "manage stock".
router.get('/admin/stock', requireLogin, (req, res) => {
  if (!access.can(req.user, 'parts.view') && !access.can(req.user, 'stock.manage')) return forbidden(res);
  const q = clean(req.query.q, 60);
  const low = req.query.low === '1';
  const all = stock.list();
  res.render('admin_stock', {
    title: 'Stock', rows: stock.list({ q, low }), q, low, errors: [], values: {},
    total: all.length, lowTotal: all.filter((r) => r.low).length,
  });
});

router.post('/admin/stock', manage, (req, res) => {
  const number = clean(req.body.part_number, 100);
  const count = wholeNumber(req.body.count);
  const min = String(req.body.min_level ?? '').trim() === '' ? null : wholeNumber(req.body.min_level);
  const errors = [];
  if (!number) errors.push('Enter the part number.');
  if (count === null) errors.push('Enter how many are on the shelf now (a whole number).');
  if (String(req.body.min_level ?? '').trim() !== '' && min === null) errors.push('The minimum must be a whole number.');
  if (errors.length) {
    const all = stock.list();
    return res.status(400).render('admin_stock', { title: 'Stock', rows: all, q: '', low: false, errors, values: req.body, total: all.length, lowTotal: all.filter((r) => r.low).length });
  }
  let part = db.prepare('SELECT * FROM parts_catalog WHERE part_number = ?').get(number);
  if (!part) { // not in the catalog yet: add it so it can be tracked
    const info = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES (?, '', ?)").run(number, new Date().toISOString());
    part = getPart(info.lastInsertRowid);
  }
  setCount(part, count, min);
  activity.log(req.user, 'Stock count', `${part.part_number}: counted ${count}${min !== null ? ', minimum ' + min : ''}`);
  flash(req, 'ok', `${part.part_number} is now tracked with ${count} on hand.`);
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
  const cMin = col(/min/);
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
      setCount(part, qty, cMin >= 0 ? wholeNumber(r[cMin]) : null);
      result.set++;
    }
  })();
  activity.log(req.user, 'Stock import', `${result.set} parts counted from a file`);
  flash(req, 'ok', `Counts set for ${result.set} parts` + (result.added ? `, ${result.added} of them new to the catalog` : '') + (result.skipped ? `. ${result.skipped} rows skipped (no part number or count).` : '.'));
  res.redirect('/admin/stock');
});

router.get('/admin/stock/:id', requireLogin, (req, res) => {
  if (!access.can(req.user, 'parts.view') && !access.can(req.user, 'stock.manage')) return forbidden(res);
  const part = stock.list().find((r) => String(r.id) === req.params.id);
  if (!part) return res.status(404).render('error', { title: 'Page not found', message: 'That part is not being tracked.' });
  const history = db.prepare(
    `SELECT a.quantity, a.reason, a.created_at, u.display_name FROM stock_adjustments a JOIN users u ON u.id = a.user_id
     WHERE a.catalog_id = ? ORDER BY a.id DESC LIMIT 50`).all(part.id);
  const moves = db.prepare(
    `SELECT s.id, s.action, s.created_at, i.quantity, u.display_name FROM parts_items i
     JOIN parts_submissions s ON s.id = i.submission_id JOIN users u ON u.id = s.user_id
     WHERE i.part_name = ? COLLATE NOCASE AND s.action IN ('take','return') AND s.cancelled_at IS NULL AND s.created_at > ?
     ORDER BY s.id DESC LIMIT 50`).all(part.part_number, part.count_at);
  res.render('admin_stock_part', { title: `Stock: ${part.part_number}`, part, history, moves });
});

router.post('/admin/stock/:id/:op', manage, (req, res) => {
  const part = getPart(req.params.id);
  if (!part || !part.stocked) return res.redirect('/admin/stock');
  const back = `/admin/stock/${part.id}`;
  switch (req.params.op) {
    case 'adjust': {
      const qty = wholeNumber(req.body.quantity, { signed: true });
      if (!qty) { flash(req, 'err', 'Enter a whole number: positive for a delivery, negative to take stock off.'); break; }
      const reason = clean(req.body.reason, 200);
      db.prepare('INSERT INTO stock_adjustments (catalog_id, quantity, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(part.id, qty, reason || null, req.user.id, new Date().toISOString());
      activity.log(req.user, 'Stock adjusted', `${part.part_number}: ${qty > 0 ? '+' : ''}${qty}${reason ? ' (' + reason + ')' : ''}`);
      flash(req, 'ok', `${qty > 0 ? 'Added ' + qty : 'Removed ' + -qty}.`);
      break;
    }
    case 'count': {
      const qty = wholeNumber(req.body.count);
      if (qty === null) { flash(req, 'err', 'Enter how many are on the shelf (a whole number).'); break; }
      setCount(part, qty, null);
      activity.log(req.user, 'Stock count', `${part.part_number}: counted ${qty}`);
      flash(req, 'ok', `Count set to ${qty}.`);
      break;
    }
    case 'min': {
      const blank = String(req.body.min_level ?? '').trim() === '';
      const min = blank ? null : wholeNumber(req.body.min_level);
      if (!blank && min === null) { flash(req, 'err', 'The minimum must be a whole number, or blank for none.'); break; }
      db.prepare('UPDATE parts_catalog SET min_level = ? WHERE id = ?').run(min, part.id);
      activity.log(req.user, 'Stock minimum', `${part.part_number}: ${blank ? 'no minimum' : 'minimum ' + min}`);
      flash(req, 'ok', blank ? 'Minimum removed.' : `Minimum set to ${min}.`);
      break;
    }
    case 'stop':
      db.prepare('UPDATE parts_catalog SET stocked = 0 WHERE id = ?').run(part.id);
      activity.log(req.user, 'Stock tracking stopped', part.part_number);
      flash(req, 'ok', `${part.part_number} is no longer tracked.`);
      return res.redirect('/admin/stock');
    default:
  }
  res.redirect(back);
});

module.exports = router;
