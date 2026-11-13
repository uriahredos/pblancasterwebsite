'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const certs = require('../certs');
const { sendCsv } = require('../csv');
const { requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate } = require('../util');

const router = express.Router();
const guard = requirePerm('certs.manage');

const people = (viewer) => {
  const ids = access.visibleUserIds(viewer);
  return db.prepare('SELECT id, display_name FROM users WHERE active = 1 ORDER BY display_name COLLATE NOCASE').all().filter((u) => !ids || ids.includes(u.id));
};

function rows(viewer, query) {
  const ids = access.visibleUserIds(viewer);
  const person = /^\d+$/.test(query.user || '') ? Number(query.user) : null;
  const show = ['attention', 'expired'].includes(query.show) ? query.show : '';
  const today = localDate();
  let list = db.prepare(
    `SELECT c.*, u.display_name, u.username FROM certifications c JOIN users u ON u.id = c.user_id
     ORDER BY c.expires_on IS NULL, c.expires_on, u.display_name COLLATE NOCASE`).all()
    .filter((c) => (!ids || ids.includes(c.user_id)) && (!person || c.user_id === person))
    .map((c) => certs.decorate(c, today));
  const counts = { expired: list.filter((c) => c.status === 'expired').length, soon: list.filter((c) => c.status === 'soon').length };
  if (show === 'attention') list = list.filter((c) => c.status === 'expired' || c.status === 'soon');
  if (show === 'expired') list = list.filter((c) => c.status === 'expired');
  return { list, counts, f: { user: person ? String(person) : '', show } };
}

function readForm(body) {
  const values = {
    user_id: body.user_id, name: clean(body.name, 120), issuer: clean(body.issuer, 120), number: clean(body.number, 80),
    issued_on: clean(body.issued_on, 10), expires_on: clean(body.expires_on, 10), notes: clean(body.notes, 500),
  };
  const errors = [];
  if (!values.name) errors.push('Enter the name of the license or certification.');
  if (values.issued_on && !isYmd(values.issued_on)) errors.push('The issued date does not look right.');
  if (values.expires_on && !isYmd(values.expires_on)) errors.push('The expiry date does not look right.');
  if (isYmd(values.issued_on) && isYmd(values.expires_on) && values.expires_on < values.issued_on) errors.push('The expiry date is before the issued date.');
  return { values, errors };
}

function listPage(req, res, extra = {}) {
  const data = rows(req.user, req.query);
  res.status(extra.errors ? 400 : 200).render('admin_certs', {
    title: 'Certifications', ...data, people: people(req.user), errors: [], values: {}, soonDays: certs.SOON_DAYS, ...extra,
  });
}

router.get('/admin/certs', guard, (req, res) => listPage(req, res));

router.get('/admin/certs.csv', guard, (req, res) => {
  const { list } = rows(req.user, req.query);
  const label = { none: 'No expiry', expired: 'Expired', soon: 'Expiring soon', ok: 'Current' };
  sendCsv(res, `certifications-${localDate()}.csv`, ['Name', 'Username', 'Certification', 'Issued by', 'Number', 'Issued', 'Expires', 'Status', 'Notes'],
    list.map((c) => [c.display_name, c.username, c.name, c.issuer, c.number, c.issued_on, c.expires_on, label[c.status], c.notes]));
});

router.post('/admin/certs', guard, (req, res) => {
  const { values, errors } = readForm(req.body);
  const person = people(req.user).find((u) => String(u.id) === String(values.user_id));
  if (!person) errors.unshift('Choose the person.');
  if (errors.length) return listPage(req, res, { errors, values });
  db.prepare(
    `INSERT INTO certifications (user_id, name, issuer, number, issued_on, expires_on, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(person.id, values.name, values.issuer || null, values.number || null, values.issued_on || null, values.expires_on || null,
    values.notes || null, new Date().toISOString());
  activity.log(req.user, 'Certification added', `${person.display_name}: ${values.name}`);
  flash(req, 'ok', `${values.name} added for ${person.display_name}.`);
  res.redirect('/admin/certs');
});

function load(req, res) {
  const c = /^\d+$/.test(req.params.id) ? db.prepare(
    'SELECT c.*, u.display_name FROM certifications c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(req.params.id) : null;
  if (!c) { res.redirect('/admin/certs'); return null; }
  if (!access.canSee(req.user, c.user_id)) { forbidden(res); return null; }
  return c;
}

router.get('/admin/certs/:id', guard, (req, res) => {
  const c = load(req, res);
  if (c) res.render('admin_cert_edit', { title: 'Edit certification', c, values: c, errors: [] });
});

router.post('/admin/certs/:id', guard, (req, res) => {
  const c = load(req, res);
  if (!c) return;
  const { values, errors } = readForm(req.body);
  if (errors.length) return res.status(400).render('admin_cert_edit', { title: 'Edit certification', c, values, errors });
  // A new expiry date means the reminders should go out again for it.
  const renewed = (values.expires_on || null) !== (c.expires_on || null);
  db.prepare(
    `UPDATE certifications SET name = ?, issuer = ?, number = ?, issued_on = ?, expires_on = ?, notes = ?,
       reminded_30 = CASE WHEN ? THEN 0 ELSE reminded_30 END, reminded_7 = CASE WHEN ? THEN 0 ELSE reminded_7 END WHERE id = ?`
  ).run(values.name, values.issuer || null, values.number || null, values.issued_on || null, values.expires_on || null,
    values.notes || null, renewed ? 1 : 0, renewed ? 1 : 0, c.id);
  activity.log(req.user, 'Certification edited', `${c.display_name}: ${values.name}${renewed ? ', expiry ' + (values.expires_on || 'removed') : ''}`);
  flash(req, 'ok', 'Certification saved.');
  res.redirect('/admin/certs');
});

router.post('/admin/certs/:id/delete', guard, (req, res) => {
  const c = load(req, res);
  if (!c) return;
  db.prepare('DELETE FROM certifications WHERE id = ?').run(c.id);
  activity.log(req.user, 'Certification removed', `${c.display_name}: ${c.name}`);
  flash(req, 'ok', 'Certification removed.');
  res.redirect('/admin/certs');
});

module.exports = router;
