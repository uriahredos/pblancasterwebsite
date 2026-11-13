'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const mail = require('../mail');
const { requireLogin, requirePerm, verifyCsrf, forbidden, flash } = require('../auth');
const access = require('../permissions');
const stock = require('../stock');
const push = require('../push');
const { clean, localDate, isYmd } = require('../util');
const { canChange, logChange } = require('../changes');

const router = express.Router();
const uploadDir = path.join(config.dataDir, 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_ITEMS = 40;

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: config.maxPhotoBytes, files: 1, fields: 200 },
  fileFilter: (req, file, cb) => {
    if (EXT[file.mimetype]) return cb(null, true);
    req.photoError = 'The photo must be a JPEG, PNG, WebP or GIF image.';
    cb(null, false);
  },
}).single('photo');

function parseUpload(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      req.photoError = err.code === 'LIMIT_FILE_SIZE' ? 'The photo is larger than 10 MB.' : 'The photo could not be uploaded.';
    }
    req.body = req.body || {};
    next();
  });
}

/** Check the file really is the image type it claims to be. */
function looksLikeImage(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  const hex = b.toString('hex');
  return hex.startsWith('ffd8ff') || hex.startsWith('89504e47') || b.toString('latin1', 0, 4) === 'GIF8' ||
    (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
}

const removeFile = (file) => { if (file) fs.rm(file.path, { force: true }, () => {}); };
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function readForm(body) {
  const names = asArray(body.part_name);
  const qtys = asArray(body.quantity);
  const items = [];
  const errors = [];
  names.slice(0, MAX_ITEMS).forEach((raw, i) => {
    const part_name = clean(raw, 200);
    const qtyText = clean(qtys[i], 10);
    if (!part_name && !qtyText) return; // blank row
    const quantity = /^\d{1,5}$/.test(qtyText) ? Number(qtyText) : NaN;
    items.push({ part_name, quantity: qtyText });
    if (!part_name) errors.push(`Row ${i + 1}: enter the part name or number.`);
    else if (!(quantity >= 1)) errors.push(`${part_name}: quantity must be a whole number, 1 or more.`);
  });
  const values = {
    action: body.action, source: body.source, items,
    job_number: clean(body.job_number, 60), note: clean(body.note, 1000), needed_by: clean(body.needed_by, 10),
    truck: clean(body.truck, 20),
  };
  if (!['take', 'return', 'request'].includes(values.action)) errors.unshift('Choose what you would like to do.');
  if (items.length === 0) errors.push('Add at least one part.');
  if (!['van', 'job'].includes(values.source)) errors.push('Choose Van stock or Job.');
  if (values.source === 'job' && !values.job_number) errors.push('Enter the job number.');
  if (values.action === 'request' && !isYmd(values.needed_by)) errors.push('Enter the date the parts are needed by.');
  return { values, errors };
}

/** The parts this person uses most, for one-tap buttons on the form. */
function frequentParts(userId) {
  return db.prepare(
    `SELECT MIN(i.part_name) AS name, COUNT(*) AS uses, MAX(s.id) AS last FROM parts_items i
     JOIN parts_submissions s ON s.id = i.submission_id
     WHERE s.user_id = ? AND s.cancelled_at IS NULL
     GROUP BY UPPER(i.part_name) ORDER BY uses DESC, last DESC LIMIT 8`).all(userId).map((r) => r.name);
}

router.get('/parts', requirePerm('parts.submit'), (req, res) => {
  const action = ['take', 'return', 'request'].includes(req.query.action) ? req.query.action : '';
  res.render('parts', { title: 'Parts', values: { action, items: [], truck: req.user.default_truck || '' }, errors: [], editing: null, frequent: frequentParts(req.user.id) });
});

router.post('/parts', requirePerm('parts.submit'), parseUpload, verifyCsrf, (req, res) => {
  const { values, errors } = readForm(req.body);
  let photo = req.file || null;
  if (req.photoError) errors.push(req.photoError);
  if (photo && values.action !== 'return') { removeFile(photo); photo = null; }
  if (photo && !looksLikeImage(photo.path)) errors.push('The photo must be a JPEG, PNG, WebP or GIF image.');

  if (errors.length) {
    removeFile(photo);
    return res.status(400).render('parts', { title: 'Parts', values, errors, editing: null, frequent: frequentParts(req.user.id) });
  }

  const now = new Date();
  const isRequest = values.action === 'request';
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO parts_submissions
         (user_id, action, source, job_number, note, needed_by, photo_path, status, truck, created_at, created_local_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(req.user.id, values.action, values.source, values.source === 'job' ? values.job_number : null,
      values.note || null, isRequest ? values.needed_by : null, photo ? photo.filename : null,
      isRequest ? 'new' : null, values.truck || null, now.toISOString(), localDate(now));
    // Remember the truck so it is filled in next time.
    if (values.truck) db.prepare('UPDATE users SET default_truck = ? WHERE id = ?').run(values.truck, req.user.id);
    const add = db.prepare('INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, ?, ?)');
    for (const it of values.items) add.run(info.lastInsertRowid, it.part_name, Number(it.quantity));
    return info.lastInsertRowid;
  })();

  // Taking parts may have pushed something to or below its minimum: tell the people who order.
  if (values.action === 'take') {
    const taken = {};
    for (const it of values.items) taken[it.part_name.toUpperCase()] = (taken[it.part_name.toUpperCase()] || 0) + Number(it.quantity);
    const crossed = stock.forNames(Object.keys(taken)).filter((p) => p.min_level !== null && p.on_hand <= p.min_level &&
      p.on_hand + taken[p.part_number.toUpperCase()] > p.min_level);
    if (crossed.length) {
      mail.notifyLowStock(crossed);
      push.notify(push.peopleWith('stock.manage'), 'low_stock', {
        title: crossed.length === 1 ? `Low stock: ${crossed[0].part_number}` : `Low stock: ${crossed.length} parts`,
        body: crossed.map((p) => `${p.part_number}: ${p.on_hand} left (minimum ${p.min_level})`).join(', '), url: '/admin/stock?low=1' });
    }
  }
  if (isRequest) {
    push.notify(push.peopleWith('parts.manage', req.user.id, req.user.id), 'parts_request', {
      title: `Parts request from ${req.user.display_name}`,
      body: values.items.map((i) => `${i.quantity} × ${i.part_name}`).join(', ') + `. Needed by ${values.needed_by}.`, url: '/admin/requests' });
    mail.notifyPartsRequest({
      id, name: req.user.display_name, items: values.items, source: values.source,
      jobNumber: values.job_number, neededBy: values.needed_by,
    });
  }
  const done = { take: 'Parts signed out.', return: 'Return recorded.', request: 'Parts request sent.' };
  flash(req, 'ok', `${done[values.action]} Thank you.`);
  res.redirect('/my?sent=parts');
});

// Suggestions while typing a part: the catalog first, then names people have used before.
router.get('/parts/suggest', requirePerm('parts.submit'), (req, res) => {
  const q = clean(req.query.q, 60);
  if (q.length < 2) return res.json([]);
  const esc = q.replace(/[\\%_]/g, '\\$&');
  const rows = db.prepare(
    `SELECT part_number AS n, description AS d FROM parts_catalog
     WHERE active = 1 AND (part_number LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
     ORDER BY (part_number = ?) DESC, (part_number LIKE ? ESCAPE '\\') DESC, (part_number LIKE ? ESCAPE '\\') DESC, part_number LIMIT 8`
  ).all(`%${esc}%`, `%${esc}%`, q, `${esc}%`, `%${esc}%`);
  if (rows.length < 8) {
    const seen = new Set(rows.map((r) => r.n.toUpperCase()));
    const used = db.prepare(
      `SELECT MIN(part_name) AS n, COUNT(*) AS c FROM parts_items WHERE part_name LIKE ? ESCAPE '\\'
         AND NOT EXISTS (SELECT 1 FROM parts_catalog c WHERE c.part_number = TRIM(part_name) AND c.active = 0)
       GROUP BY UPPER(TRIM(part_name)) ORDER BY c DESC LIMIT 8`).all(`%${esc}%`);
    for (const u of used) {
      if (rows.length >= 8) break;
      if (!seen.has(u.n.trim().toUpperCase())) rows.push({ n: u.n.trim(), d: '' });
    }
  }
  res.json(rows);
});

// ---- Edit or cancel an entry ----------------------------------------------

const getEntry = (id) => db.prepare('SELECT * FROM parts_submissions WHERE id = ?').get(id);
const getItems = (id) => db.prepare('SELECT part_name, quantity FROM parts_items WHERE submission_id = ? ORDER BY id').all(id);
const backTo = (user, row) => (user.id === row.user_id ? '/my' : `/admin/parts/${row.id}`);

function loadChangeable(req, res) {
  const row = /^\d+$/.test(req.params.id) ? getEntry(req.params.id) : null;
  if (!row) { res.status(404).render('error', { title: 'Page not found', message: 'That entry does not exist.' }); return null; }
  const mayManage = access.can(req.user, 'parts.manage') && access.canSee(req.user, row.user_id);
  if (row.user_id !== req.user.id && !mayManage) { forbidden(res); return null; }
  if (!canChange(row, req.user, 'parts')) {
    res.status(403).render('error', {
      title: 'This entry can no longer be changed',
      message: `Entries can be changed for ${config.editWindowHours} hours, and only until someone has acted on them. Ask an admin to correct it.`,
    });
    return null;
  }
  return row;
}

router.get('/parts/:id/edit', requireLogin, (req, res) => {
  const row = loadChangeable(req, res);
  if (!row) return;
  const items = getItems(row.id).map((i) => ({ part_name: i.part_name, quantity: String(i.quantity) }));
  res.render('parts', { title: 'Edit parts entry', values: { ...row, items }, errors: [], editing: row, frequent: [] });
});

router.post('/parts/:id/edit', requireLogin, parseUpload, verifyCsrf, (req, res) => {
  const row = loadChangeable(req, res);
  if (!row) return removeFile(req.file);
  // What was done (take / return / request) is fixed; to change that, cancel and send a new one.
  const { values, errors } = readForm({ ...req.body, action: row.action });
  let photo = req.file || null;
  if (req.photoError) errors.push(req.photoError);
  if (photo && row.action !== 'return') { removeFile(photo); photo = null; }
  if (photo && !looksLikeImage(photo.path)) errors.push('The photo must be a JPEG, PNG, WebP or GIF image.');
  if (errors.length) {
    removeFile(photo);
    return res.status(400).render('parts', { title: 'Edit parts entry', values: { ...values, photo_path: row.photo_path }, errors, editing: row, frequent: [] });
  }

  db.transaction(() => {
    logChange('parts', row.id, req.user.id, 'edited', {
      items: getItems(row.id), source: row.source, job_number: row.job_number, note: row.note, needed_by: row.needed_by, truck: row.truck,
    });
    db.prepare(
      `UPDATE parts_submissions SET source = ?, job_number = ?, note = ?, needed_by = ?, photo_path = ?, truck = ?, edited_at = ?,
         audited_at = NULL, audited_by = NULL WHERE id = ?` // an edited entry needs checking again
    ).run(values.source, values.source === 'job' ? values.job_number : null, values.note || null,
      row.action === 'request' ? values.needed_by : null, photo ? photo.filename : row.photo_path, values.truck || null,
      new Date().toISOString(), row.id);
    db.prepare('DELETE FROM parts_items WHERE submission_id = ?').run(row.id);
    const add = db.prepare('INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, ?, ?)');
    for (const it of values.items) add.run(row.id, it.part_name, Number(it.quantity));
  })();
  if (photo && row.photo_path) fs.rm(path.join(uploadDir, path.basename(row.photo_path)), { force: true }, () => {});
  flash(req, 'ok', 'Entry updated.');
  res.redirect(backTo(req.user, row));
});

router.post('/parts/:id/cancel', requireLogin, (req, res) => {
  const row = loadChangeable(req, res);
  if (!row) return;
  db.transaction(() => {
    logChange('parts', row.id, req.user.id, 'cancelled', null);
    db.prepare('UPDATE parts_submissions SET cancelled_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  })();
  flash(req, 'ok', 'Entry cancelled.');
  res.redirect(backTo(req.user, row));
});

// Photos are only shown to the person who uploaded them and to admins.
router.get('/parts/photo/:id', requireLogin, (req, res) => {
  const row = db.prepare('SELECT user_id, photo_path FROM parts_submissions WHERE id = ?').get(req.params.id);
  if (!row || !row.photo_path) return res.status(404).render('error', { title: 'Page not found', message: 'No photo here.' });
  if (row.user_id !== req.user.id && !(access.can(req.user, 'parts.view') && access.canSee(req.user, row.user_id))) return forbidden(res);
  res.sendFile(path.basename(row.photo_path), { root: uploadDir, headers: { 'Cache-Control': 'private, no-store' } });
});

module.exports = router;
