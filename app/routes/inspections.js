'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const mail = require('../mail');
const config = require('../config');
const uploads = require('../uploads');
const { sendCsv } = require('../csv');
const { requireLogin, requirePerm, verifyCsrf, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate, fmtDateTime } = require('../util');

const router = express.Router();
const MAX_PHOTOS = 4;
const activeItems = () => db.prepare('SELECT * FROM inspection_items WHERE active = 1 ORDER BY sort, id').all();

// ---- The form ---------------------------------------------------------------

router.get('/inspection', requirePerm('inspections.submit'), (req, res) => {
  res.render('inspection', { title: 'Truck inspection', items: activeItems(), values: { truck: req.user.default_truck || '', results: {}, notes: {} }, errors: [], maxPhotos: MAX_PHOTOS });
});

router.post('/inspection', requirePerm('inspections.submit'), uploads.photos('photos', MAX_PHOTOS), verifyCsrf, (req, res) => {
  const items = activeItems();
  const values = { truck: clean(req.body.truck, 20), odometer: clean(req.body.odometer, 12), notes_all: clean(req.body.notes, 1000), results: {}, notes: {} };
  const errors = [];
  if (!values.truck) errors.push('Enter the truck number.');
  for (const it of items) {
    const v = req.body[`item_${it.id}`];
    values.results[it.id] = v;
    values.notes[it.id] = clean(req.body[`note_${it.id}`], 300);
    if (v !== 'ok' && v !== 'problem') errors.push(`${it.label}: choose OK or Problem.`);
    else if (v === 'problem' && !values.notes[it.id]) errors.push(`${it.label}: say what is wrong.`);
  }
  if (req.photoError) errors.push(req.photoError);
  for (const f of req.files) if (!uploads.looksLikeImage(f.path)) { errors.push('Photos must be JPEG, PNG, WebP or GIF images.'); break; }
  if (errors.length) {
    req.files.forEach((f) => uploads.remove(f.filename));
    return res.status(400).render('inspection', { title: 'Truck inspection', items, values: { ...values, notes_text: values.notes_all }, errors, maxPhotos: MAX_PHOTOS });
  }

  const now = new Date();
  const problems = items.filter((it) => values.results[it.id] === 'problem');
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO inspections (user_id, truck, odometer, notes, problems, created_at, created_local_date) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(req.user.id, values.truck, values.odometer || null, values.notes_all || null, problems.length, now.toISOString(), localDate(now));
    const add = db.prepare('INSERT INTO inspection_results (inspection_id, label, ok, note) VALUES (?, ?, ?, ?)');
    for (const it of items) add.run(info.lastInsertRowid, it.label, values.results[it.id] === 'ok' ? 1 : 0, values.notes[it.id] || null);
    const photo = db.prepare('INSERT INTO inspection_photos (inspection_id, path) VALUES (?, ?)');
    for (const f of req.files) photo.run(info.lastInsertRowid, f.filename);
    db.prepare('UPDATE users SET default_truck = ? WHERE id = ?').run(values.truck, req.user.id);
    return info.lastInsertRowid;
  })();

  if (problems.length) {
    const push = require('../push');
    push.notify(push.peopleWith('inspections.view', req.user.id, req.user.id), 'truck_problem', {
      title: `Truck ${values.truck}: ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} reported`,
      body: `${req.user.display_name}: ` + problems.map((it) => `${it.label}: ${values.notes[it.id]}`).join('; '), url: `/admin/inspections/${id}` });
    mail.send(config.notifyTo, `Truck ${values.truck}: ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} reported`,
      `${req.user.display_name} inspected truck ${values.truck} and reported:\n\n` +
      problems.map((it) => `  ${it.label}: ${values.notes[it.id]}`).join('\n') + `\n\n${config.baseUrl}/admin/inspections/${id}\n`);
  }
  flash(req, 'ok', problems.length ? `Inspection sent with ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} reported. Thank you.` : 'Inspection sent. Thank you.');
  res.redirect('/my?sent=inspection');
});

// Photos: the person who took them, or someone allowed to see that person's inspections.
router.get('/inspection/photo/:id', requireLogin, (req, res) => {
  const row = db.prepare('SELECT p.path, i.user_id FROM inspection_photos p JOIN inspections i ON i.id = p.inspection_id WHERE p.id = ?').get(req.params.id);
  if (!row) return res.status(404).render('error', { title: 'Page not found', message: 'No photo here.' });
  if (row.user_id !== req.user.id && !(access.can(req.user, 'inspections.view') && access.canSee(req.user, row.user_id))) return forbidden(res);
  res.sendFile(require('path').basename(row.path), { root: uploads.uploadDir, headers: { 'Cache-Control': 'private, no-store' } });
});

// ---- Looking at them ----------------------------------------------------------

function filter(viewer, query) {
  const f = {
    from: isYmd(query.from) ? query.from : '', to: isYmd(query.to) ? query.to : '',
    user: /^\d+$/.test(query.user || '') ? query.user : '', truck: clean(query.truck, 20),
    show: query.show === 'open' ? 'open' : query.show === 'problems' ? 'problems' : '',
  };
  const where = [];
  const params = [];
  const ids = access.visibleUserIds(viewer);
  if (ids) where.push(`i.user_id IN (${ids.map(Number).join(',')})`);
  if (f.from) { where.push('i.created_local_date >= ?'); params.push(f.from); }
  if (f.to) { where.push('i.created_local_date <= ?'); params.push(f.to); }
  if (f.user) { where.push('i.user_id = ?'); params.push(Number(f.user)); }
  if (f.truck) { where.push('i.truck = ? COLLATE NOCASE'); params.push(f.truck); }
  if (f.show === 'open') where.push('i.problems > 0 AND i.resolved_at IS NULL');
  if (f.show === 'problems') where.push('i.problems > 0');
  return { f, sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, ids };
}
const qs = (f) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

router.get('/admin/inspections', requirePerm('inspections.view'), (req, res) => {
  const { f, sql, params, ids } = filter(req.user, req.query);
  const rows = db.prepare(
    `SELECT i.*, u.display_name, (SELECT COUNT(*) FROM inspection_photos p WHERE p.inspection_id = i.id) AS photos
     FROM inspections i JOIN users u ON u.id = i.user_id ${sql} ORDER BY i.id DESC LIMIT 500`).all(...params);
  // Who is due: everyone who can send inspections, with the date of their last one.
  const today = localDate();
  const people = db.prepare(
    `SELECT u.id, u.display_name, u.default_truck, u.profile_id, u.is_master,
            (SELECT MAX(created_local_date) FROM inspections i WHERE i.user_id = u.id) AS last
     FROM users u WHERE u.active = 1 ORDER BY last IS NOT NULL, last, u.display_name COLLATE NOCASE`).all()
    .filter((u) => (!ids || ids.includes(u.id)) && (u.is_master || access.permsOf(u.profile_id).has('inspections.submit')) && (u.default_truck || u.last))
    .map((u) => ({ ...u, days: u.last ? Math.round((new Date(today + 'T12:00:00Z') - new Date(u.last + 'T12:00:00Z')) / 86400000) : null }));
  const users = db.prepare('SELECT id, display_name FROM users ORDER BY display_name COLLATE NOCASE').all().filter((u) => !ids || ids.includes(u.id));
  const open = db.prepare(`SELECT COUNT(*) AS n FROM inspections i WHERE i.problems > 0 AND i.resolved_at IS NULL ${ids ? `AND i.user_id IN (${ids.map(Number).join(',')})` : ''}`).get().n;
  res.render('admin_inspections', { title: 'Truck inspections', rows, f, qs: qs(f), users, people, open });
});

router.get('/admin/inspections.csv', requirePerm('inspections.view'), (req, res) => {
  const { sql, params } = filter(req.user, req.query);
  const rows = db.prepare(
    `SELECT i.id, i.created_at, i.truck, i.odometer, i.notes, i.resolved_at, u.display_name, r.label, r.ok, r.note
     FROM inspections i JOIN users u ON u.id = i.user_id JOIN inspection_results r ON r.inspection_id = i.id
     ${sql} ORDER BY i.id, r.id`).all(...params);
  sendCsv(res, `truck-inspections-${localDate()}.csv`, ['Inspection', 'Date', 'Name', 'Truck', 'Odometer', 'Item', 'Result', 'What is wrong', 'Fixed', 'Notes'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), r.display_name, r.truck, r.odometer, r.label, r.ok ? 'OK' : 'Problem', r.note,
      r.ok ? '' : r.resolved_at ? fmtDateTime(r.resolved_at) : 'Not yet', r.notes]));
});

// ---- The checklist --------------------------------------------------------------

router.get('/admin/inspections/checklist', requirePerm('inspections.manage'), (req, res) => {
  res.render('admin_checklist', { title: 'Inspection checklist', items: db.prepare('SELECT * FROM inspection_items ORDER BY active DESC, sort, id').all() });
});

router.post('/admin/inspections/checklist', requirePerm('inspections.manage'), (req, res) => {
  const label = clean(req.body.label, 120);
  if (!label) flash(req, 'err', 'Enter what to check.');
  else {
    const { m } = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM inspection_items').get();
    db.prepare('INSERT INTO inspection_items (label, sort) VALUES (?, ?)').run(label, m + 1);
    activity.log(req.user, 'Inspection checklist', `added "${label}"`);
  }
  res.redirect('/admin/inspections/checklist');
});

router.post('/admin/inspections/checklist/:id/:op', requirePerm('inspections.manage'), (req, res) => {
  const item = db.prepare('SELECT * FROM inspection_items WHERE id = ?').get(req.params.id);
  if (item && req.params.op === 'toggle') {
    db.prepare('UPDATE inspection_items SET active = 1 - active WHERE id = ?').run(item.id);
    activity.log(req.user, 'Inspection checklist', `${item.active ? 'removed' : 'restored'} "${item.label}"`);
  } else if (item && req.params.op === 'rename') {
    const label = clean(req.body.label, 120);
    if (label && label !== item.label) {
      db.prepare('UPDATE inspection_items SET label = ? WHERE id = ?').run(label, item.id);
      activity.log(req.user, 'Inspection checklist', `"${item.label}" renamed to "${label}"`);
    }
  } else if (item && (req.params.op === 'up' || req.params.op === 'down')) {
    const other = db.prepare(
      `SELECT * FROM inspection_items WHERE active = 1 AND sort ${req.params.op === 'up' ? '<' : '>'} ? ORDER BY sort ${req.params.op === 'up' ? 'DESC' : 'ASC'} LIMIT 1`).get(item.sort);
    if (other) {
      db.prepare('UPDATE inspection_items SET sort = ? WHERE id = ?').run(other.sort, item.id);
      db.prepare('UPDATE inspection_items SET sort = ? WHERE id = ?').run(item.sort, other.id);
    }
  }
  res.redirect('/admin/inspections/checklist');
});

// ---- One inspection -------------------------------------------------------------

function load(req, res) {
  const i = /^\d+$/.test(req.params.id) ? db.prepare(
    `SELECT i.*, u.display_name, r.display_name AS resolved_by_name FROM inspections i JOIN users u ON u.id = i.user_id
     LEFT JOIN users r ON r.id = i.resolved_by WHERE i.id = ?`).get(req.params.id) : null;
  if (!i) { res.status(404).render('error', { title: 'Page not found', message: 'That inspection does not exist.' }); return null; }
  if (!access.canSee(req.user, i.user_id)) { forbidden(res); return null; }
  return i;
}

router.get('/admin/inspections/:id', requirePerm('inspections.view'), (req, res) => {
  const i = load(req, res);
  if (!i) return;
  res.render('admin_inspection', {
    title: `Inspection: truck ${i.truck}`, i,
    results: db.prepare('SELECT * FROM inspection_results WHERE inspection_id = ? ORDER BY id').all(i.id),
    photos: db.prepare('SELECT id FROM inspection_photos WHERE inspection_id = ? ORDER BY id').all(i.id),
  });
});

router.post('/admin/inspections/:id/resolve', requirePerm('inspections.manage'), (req, res) => {
  const i = load(req, res);
  if (!i) return;
  if (i.resolved_at) db.prepare('UPDATE inspections SET resolved_at = NULL, resolved_by = NULL, resolved_note = NULL WHERE id = ?').run(i.id);
  else {
    db.prepare('UPDATE inspections SET resolved_at = ?, resolved_by = ?, resolved_note = ? WHERE id = ?')
      .run(new Date().toISOString(), req.user.id, clean(req.body.resolved_note, 500) || null, i.id);
  }
  flash(req, 'ok', i.resolved_at ? 'Marked as not fixed yet.' : 'Marked as fixed.');
  res.redirect(`/admin/inspections/${i.id}`);
});

router.post('/admin/inspections/:id/delete', requirePerm('records.delete'), (req, res) => {
  const i = load(req, res);
  if (!i) return;
  const photos = db.prepare('SELECT path FROM inspection_photos WHERE inspection_id = ?').all(i.id);
  db.prepare('DELETE FROM inspections WHERE id = ?').run(i.id);
  photos.forEach((p) => uploads.remove(p.path));
  activity.log(req.user, 'Inspection deleted', `truck ${i.truck} by ${i.display_name}, ${fmtDateTime(i.created_at)}`);
  flash(req, 'ok', 'Inspection deleted.');
  res.redirect('/admin/inspections');
});

module.exports = router;
