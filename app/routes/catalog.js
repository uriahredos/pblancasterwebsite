'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requirePerm, verifyCsrf, flash } = require('../auth');
const requireAdmin = requirePerm('catalog.manage');
const { clean } = require('../util');
const activity = require('../activity');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } }).single('file');

/** Small CSV reader: quoted fields, embedded commas/newlines, comma or tab separated. */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/**
 * Work out which columns hold the part number, description and manufacturer.
 * Every other column (prices, costs, quantities...) is ignored and never stored.
 */
function pickColumns(header) {
  const h = header.map((c) => c.trim().toLowerCase());
  const find = (...tests) => { for (const t of tests) { const i = h.findIndex((c) => t.test(c)); if (i >= 0) return i; } return -1; };
  const number = find(/^(part|item|product|stock)[\s_]*(code|number|num|no\.?|#|id)$/, /^(part|item|sku|code|part ?code|model)$/, /part|item|sku/);
  const description = find(/^(description|desc|part description|item description|name)$/, /desc/);
  const manufacturer = find(/^(manufacturer|mfg|mfr|vendor|brand)$/, /manufact|mfg|mfr/);
  const category = find(/^(category|group|type|product line|class)$/, /categ/);
  // Only a column that says cost (the accounting system's list calls it Cost/Price): a selling price is something else and is not kept.
  const cost = find(/^(unit[\s_]*)?cost$/, /^cost\s*\/\s*price$/, /^(cost[\s_]*(each|per[\s_]*unit)|average[\s_]*cost|avg[\s_]*cost|std[\s_]*cost|standard[\s_]*cost)$/);
  if (number < 0) return null;
  return { number, description, manufacturer, category, cost };
}

function importRows(rows) {
  if (!rows.length) return { error: 'The file is empty.' };
  let cols = pickColumns(rows[0]);
  let body = rows.slice(1);
  if (!cols) { // no recognisable header: first column is the part number, second the description
    cols = { number: 0, description: rows[0].length > 1 ? 1 : -1, manufacturer: -1, category: -1, cost: -1 };
    body = rows;
  }
  const find = db.prepare('SELECT id, description, manufacturer, category, cost_cents FROM parts_catalog WHERE part_number = ?');
  const insert = db.prepare('INSERT INTO parts_catalog (part_number, description, manufacturer, category, cost_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE parts_catalog SET description = ?, manufacturer = ?, category = ?, cost_cents = ? WHERE id = ?');
  const { cents } = require('../inventory');
  const result = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of body) {
      const number = clean(r[cols.number], 100);
      if (!number) { result.skipped++; continue; }
      const description = cols.description >= 0 ? clean(r[cols.description], 300) : '';
      const existing = find.get(number);
      // A column the file does not have leaves that detail as it was.
      const manufacturer = cols.manufacturer >= 0 ? clean(r[cols.manufacturer], 100) || null : (existing ? existing.manufacturer || null : null);
      const category = cols.category >= 0 ? clean(r[cols.category], 100) || null : (existing ? existing.category || null : null);
      // A cost that cannot be read as money leaves the cost as it was, like a file with no cost column.
      const read = cols.cost >= 0 ? cents(r[cols.cost]) : null;
      const cost = read !== null ? read : (existing ? existing.cost_cents : null);
      if (!existing) { insert.run(number, description, manufacturer, category, cost, now); result.added++; }
      else if (existing.description !== description || (existing.manufacturer || null) !== manufacturer || (existing.category || null) !== category || existing.cost_cents !== cost) {
        update.run(description, manufacturer, category, cost, existing.id); result.updated++;
      } else result.unchanged++;
    }
  })();
  return result;
}

function render(req, res, extra = {}) {
  const q = clean(req.query.q, 60);
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const where = q ? "WHERE part_number LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR manufacturer LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'" : '';
  const params = q ? [like, like, like, like] : [];
  const rows = db.prepare(`SELECT * FROM parts_catalog ${where} ORDER BY active DESC, part_number LIMIT 300`).all(...params);
  const { n: total } = db.prepare('SELECT COUNT(*) AS n FROM parts_catalog').get();
  const { n: matching } = db.prepare(`SELECT COUNT(*) AS n FROM parts_catalog ${where}`).get(...params);
  res.status(extra.errors ? 400 : 200).render('admin_catalog', { title: 'Parts catalog', rows, total, matching, q, errors: [], values: {}, dollars: require('../inventory').dollars, ...extra });
}

// Parts from the catalog for any box where a part is typed (stock, inventory moves, count sheets): number and
// description only, never the cost. Anyone signed in may ask, since a technician counting their own vehicle needs it.
router.get('/catalog/suggest', require('../auth').requireLogin, (req, res) => {
  const q = clean(req.query.q, 60);
  if (q.length < 2) return res.json([]);
  const esc = q.replace(/[\\%_]/g, '\\$&');
  res.json(db.prepare(
    `SELECT part_number AS n, description AS d FROM parts_catalog
     WHERE active = 1 AND (part_number LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
     ORDER BY (part_number = ?) DESC, (part_number LIKE ? ESCAPE '\\') DESC, part_number COLLATE NOCASE LIMIT 8`).all(`%${esc}%`, `%${esc}%`, q, `${esc}%`));
});

router.get('/admin/catalog', requireAdmin, (req, res) => render(req, res));

router.post('/admin/catalog', requireAdmin, (req, res) => {
  const values = { part_number: clean(req.body.part_number, 100), description: clean(req.body.description, 300), manufacturer: clean(req.body.manufacturer, 100), category: clean(req.body.category, 100), cost: clean(req.body.cost, 20) };
  const errors = [];
  const cost = values.cost ? require('../inventory').cents(values.cost) : null;
  if (values.cost && cost === null) errors.push('The cost does not look like an amount of money.');
  if (!values.part_number) errors.push('Enter the part number.');
  else if (db.prepare('SELECT 1 FROM parts_catalog WHERE part_number = ?').get(values.part_number)) errors.push('That part number is already in the catalog.');
  if (errors.length) return render(req, res, { errors, values });
  db.prepare('INSERT INTO parts_catalog (part_number, description, manufacturer, category, cost_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(values.part_number, values.description, values.manufacturer || null, values.category || null, cost, new Date().toISOString());
  activity.log(req.user, 'Catalog part added', values.part_number);
  flash(req, 'ok', `${values.part_number} added.`);
  res.redirect('/admin/catalog');
});

router.post('/admin/catalog/import', requireAdmin, (req, res, next) => upload(req, res, (err) => {
  req.body = req.body || {};
  req.uploadFailed = Boolean(err);
  next();
}), verifyCsrf, (req, res) => {
  if (req.uploadFailed || !req.file) return render(req, res, { errors: ['Choose a CSV file of up to 20 MB.'] });
  if (req.file.buffer.subarray(0, 2).toString('latin1') === 'PK') {
    return render(req, res, { errors: ['That is an Excel workbook. In Excel choose File > Save As > CSV, then upload the CSV file.'] });
  }
  const result = importRows(parseCsv(req.file.buffer.toString('utf8')));
  if (result.error) return render(req, res, { errors: [result.error] });
  activity.log(req.user, 'Catalog import', `${result.added} added, ${result.updated} updated`);
  flash(req, 'ok', `Import finished: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged` +
    (result.skipped ? `, ${result.skipped} rows skipped (no part number).` : '.'));
  res.redirect('/admin/catalog');
});

// ---- Changing one part ---------------------------------------------------------------------------------------
// The catalog is one list for every branch. A part is never deleted, because stock, counts and past parts entries
// point at it: it is corrected here, or switched off so it stops being suggested.
const getPart = (id) => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM parts_catalog WHERE id = ?').get(id) : null);
const backTo = (q) => '/admin/catalog' + (q ? '?q=' + encodeURIComponent(q) : '');
/** How many lines on past parts entries name this part: they follow it when its number is corrected. */
const usesOf = (partNumber) => db.prepare('SELECT COUNT(*) AS n FROM parts_items WHERE TRIM(part_name) = ? COLLATE NOCASE').get(partNumber).n;

function editPage(req, res, part, extra = {}) {
  const inv = require('../inventory');
  res.status(extra.errors ? 400 : 200).render('admin_catalog_edit', {
    title: `Edit ${part.part_number}`, part, q: clean(req.query.q || req.body.q, 60), uses: usesOf(part.part_number), errors: [],
    values: { part_number: part.part_number, description: part.description, category: part.category || '', manufacturer: part.manufacturer || '', cost: inv.dollars(part.cost_cents), active: part.active }, ...extra,
  });
}

router.get('/admin/catalog/:id/edit', requireAdmin, (req, res) => {
  const part = getPart(req.params.id);
  if (!part) return res.redirect('/admin/catalog');
  editPage(req, res, part);
});

router.post('/admin/catalog/:id', requireAdmin, (req, res) => {
  const part = getPart(req.params.id);
  if (!part) return res.redirect('/admin/catalog');
  const inv = require('../inventory');
  const values = { part_number: clean(req.body.part_number, 100), description: clean(req.body.description, 300), manufacturer: clean(req.body.manufacturer, 100),
    category: clean(req.body.category, 100), cost: clean(req.body.cost, 20), active: req.body.active === '1' ? 1 : 0 };
  const errors = [];
  const cost = values.cost ? inv.cents(values.cost) : null;
  if (values.cost && cost === null) errors.push('The cost does not look like an amount of money.');
  if (!values.part_number) errors.push('Enter the part number.');
  else if (db.prepare('SELECT 1 FROM parts_catalog WHERE part_number = ? AND id <> ?').get(values.part_number, part.id)) errors.push('Another part already has that number.');
  if (errors.length) return editPage(req, res, part, { errors, values });

  const changed = [];
  if (values.part_number !== part.part_number) changed.push(`number ${part.part_number} → ${values.part_number}`);
  if (values.description !== (part.description || '')) changed.push('description');
  if ((values.category || null) !== (part.category || null)) changed.push('category');
  if ((values.manufacturer || null) !== (part.manufacturer || null)) changed.push('manufacturer');
  if (cost !== part.cost_cents) changed.push('cost');                       // the amount itself stays out of the activity log
  if (values.active !== part.active) changed.push(values.active ? 'suggested again' : 'no longer suggested');
  let carried = 0;
  db.transaction(() => {
    db.prepare('UPDATE parts_catalog SET part_number = ?, description = ?, manufacturer = ?, category = ?, cost_cents = ?, active = ? WHERE id = ?')
      .run(values.part_number, values.description, values.manufacturer || null, values.category || null, cost, values.active, part.id);
    // Past parts entries name the part by its number, so a corrected number is corrected there too: they stay tied to the part.
    if (values.part_number.toLowerCase() !== part.part_number.toLowerCase()) {
      carried = db.prepare('UPDATE parts_items SET part_name = ? WHERE TRIM(part_name) = ? COLLATE NOCASE').run(values.part_number, part.part_number).changes;
    }
  })();
  if (changed.length) activity.log(req.user, 'Catalog part edited', `${values.part_number}: ${changed.join(', ')}${carried ? ` (${carried} past ${carried === 1 ? 'entry' : 'entries'} follow)` : ''}`);
  flash(req, 'ok', changed.length ? `${values.part_number} saved.` : 'Nothing was changed.');
  res.redirect(backTo(clean(req.body.q, 60)));
});

router.post('/admin/catalog/:id/toggle', requireAdmin, (req, res) => {
  db.prepare('UPDATE parts_catalog SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/catalog' + (req.body.q ? '?q=' + encodeURIComponent(req.body.q) : ''));
});

module.exports = router;
module.exports.parseCsv = parseCsv;
module.exports.importRows = importRows;
