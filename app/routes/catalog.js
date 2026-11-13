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
  if (number < 0) return null;
  return { number, description, manufacturer, category };
}

function importRows(rows) {
  if (!rows.length) return { error: 'The file is empty.' };
  let cols = pickColumns(rows[0]);
  let body = rows.slice(1);
  if (!cols) { // no recognisable header: first column is the part number, second the description
    cols = { number: 0, description: rows[0].length > 1 ? 1 : -1, manufacturer: -1, category: -1 };
    body = rows;
  }
  const find = db.prepare('SELECT id, description, manufacturer, category FROM parts_catalog WHERE part_number = ?');
  const insert = db.prepare('INSERT INTO parts_catalog (part_number, description, manufacturer, category, created_at) VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE parts_catalog SET description = ?, manufacturer = ?, category = ? WHERE id = ?');
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
      if (!existing) { insert.run(number, description, manufacturer, category, now); result.added++; }
      else if (existing.description !== description || (existing.manufacturer || null) !== manufacturer || (existing.category || null) !== category) {
        update.run(description, manufacturer, category, existing.id); result.updated++;
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
  res.status(extra.errors ? 400 : 200).render('admin_catalog', { title: 'Parts catalog', rows, total, matching, q, errors: [], values: {}, ...extra });
}

router.get('/admin/catalog', requireAdmin, (req, res) => render(req, res));

router.post('/admin/catalog', requireAdmin, (req, res) => {
  const values = { part_number: clean(req.body.part_number, 100), description: clean(req.body.description, 300), manufacturer: clean(req.body.manufacturer, 100), category: clean(req.body.category, 100) };
  const errors = [];
  if (!values.part_number) errors.push('Enter the part number.');
  else if (db.prepare('SELECT 1 FROM parts_catalog WHERE part_number = ?').get(values.part_number)) errors.push('That part number is already in the catalog.');
  if (errors.length) return render(req, res, { errors, values });
  db.prepare('INSERT INTO parts_catalog (part_number, description, manufacturer, category, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(values.part_number, values.description, values.manufacturer || null, values.category || null, new Date().toISOString());
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

router.post('/admin/catalog/:id/toggle', requireAdmin, (req, res) => {
  db.prepare('UPDATE parts_catalog SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/catalog' + (req.body.q ? '?q=' + encodeURIComponent(req.body.q) : ''));
});

module.exports = router;
module.exports.parseCsv = parseCsv;
module.exports.importRows = importRows;
