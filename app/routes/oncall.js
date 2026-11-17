'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const oncall = require('../oncall');
const { requireLogin, requirePerm, verifyCsrf, flash } = require('../auth');
const { clean, isYmd, localDate } = require('../util');

const router = express.Router();
const manage = requirePerm('oncall.manage');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8))}`;
const tel = (phone) => String(phone || '').replace(/[^0-9+]/g, '');

/** Groups shifts into stretches of days, each with its people on call and its backups. */
function stretches(rows) {
  const map = new Map();
  for (const s of rows) {
    const key = `${s.branch_id}|${s.start_on}|${s.end_on}`;
    if (!map.has(key)) map.set(key, { branch_id: s.branch_id, office: s.office, start_on: s.start_on, end_on: s.end_on, label: `${short(s.start_on)} to ${short(s.end_on)}`, year: s.start_on.slice(0, 4), tech: [], backup: [], notes: new Set() });
    const g = map.get(key);
    g[s.role].push({ ...s, tel: tel(s.phone) });
    if (s.note) g.notes.add(s.note);
  }
  return [...map.values()].map((g) => ({ ...g, note: [...g.notes].join(', ') }));
}

function page(req, res, extra = {}) {
  const today = localDate();
  const offices = oncall.officesFor(req.user);
  const ids = offices.map((o) => o.id);
  const all = ids.length ? db.prepare(
    `SELECT s.*, b.name AS office FROM oncall_shifts s JOIN branches b ON b.id = s.branch_id
     WHERE s.branch_id IN (${ids.map(Number).join(',')}) AND s.end_on > ? ORDER BY s.start_on, b.name COLLATE NOCASE, s.role = 'backup', s.id LIMIT 3000`).all(today) : [];
  const list = stretches(all);
  const current = list.filter((g) => g.start_on <= today);
  res.status(extra.errors ? 400 : 200).render('oncall', {
    title: 'On call', wide: true, current, upcoming: list.filter((g) => g.start_on > today), many: offices.length > 1, market: offices[0] && offices[0].market,
    canManage: access.can(req.user, 'oncall.manage'), roles: oncall.ROLES, mine: req.user.workBranch, errors: [], values: {}, problems: [], ...extra,
  });
}
router.get('/oncall', requireLogin, (req, res) => page(req, res));

// ---- Keeping the schedule: one shift at a time, or the whole year from the spreadsheet ----

router.post('/admin/oncall', manage, (req, res) => {
  const v = { start_on: clean(req.body.start_on, 10), end_on: clean(req.body.end_on, 10), role: req.body.role === 'backup' ? 'backup' : 'tech', name: clean(req.body.name, 80), phone: clean(req.body.phone, 30), note: clean(req.body.note, 120) };
  const errors = [];
  if (!isYmd(v.start_on) || !isYmd(v.end_on)) errors.push('Choose the first day and the day it is handed on.');
  else if (v.end_on <= v.start_on) errors.push('The hand-over day must be after the first day.');
  if (!v.name) errors.push('Enter the person\'s name.');
  if (errors.length) return page(req, res, { errors, values: v, addOpen: true });
  db.prepare('INSERT INTO oncall_shifts (branch_id, start_on, end_on, role, name, phone, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.workBranch, v.start_on, v.end_on, v.role, v.name, v.phone || null, v.note || null, new Date().toISOString());
  activity.log(req.user, 'On-call schedule changed', `${v.name} added, ${v.start_on} to ${v.end_on}`);
  flash(req, 'ok', `${v.name} added to the schedule.`);
  res.redirect('/oncall#schedule');
});

// (Before the routes that take an id, so "import" is not read as one.)
const sheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');
router.post('/admin/oncall/import', manage, (req, res, next) => sheet(req, res, (err) => { req.body = req.body || {}; req.uploadFailed = Boolean(err); next(); }), verifyCsrf, (req, res) => {
  const fail = (msg, problems = []) => page(req, res, { errors: [msg], problems, importOpen: true });
  if (req.uploadFailed || !req.file) return fail('Choose the on-call schedule file (up to 2 MB).');
  if (req.file.buffer.subarray(0, 2).toString('latin1') === 'PK') return fail('That is an Excel workbook. In Excel choose File > Save As > CSV, then upload the CSV file.');
  if (req.file.buffer.subarray(0, 4).toString('latin1') === '%PDF') return fail('That is a PDF. Upload the spreadsheet saved as CSV instead.');
  const rows = require('./catalog').parseCsv(req.file.buffer.toString('utf8'));
  const { shifts, problems } = oncall.parseSheet(rows);
  if (!shifts.length) return fail(problems[0] || 'No on-call shifts could be read from that file.', problems.slice(1));
  // The sheet replaces whatever the schedule held for the days it covers; anything outside those days is left alone.
  const from = shifts.reduce((a, s) => (s.start_on < a ? s.start_on : a), shifts[0].start_on);
  const to = shifts.reduce((a, s) => (s.end_on > a ? s.end_on : a), shifts[0].end_on);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM oncall_shifts WHERE branch_id = ? AND start_on >= ? AND start_on < ?').run(req.user.workBranch, from, to);
    const add = db.prepare('INSERT INTO oncall_shifts (branch_id, start_on, end_on, role, name, phone, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of shifts) add.run(req.user.workBranch, s.start_on, s.end_on, s.role, s.name, s.phone, s.note, now);
  })();
  activity.log(req.user, 'On-call schedule uploaded', `${shifts.length} entries, ${from} to ${to}`);
  flash(req, 'ok', `Schedule loaded: ${new Set(shifts.map((s) => s.start_on)).size} shifts from ${short(from)} ${from.slice(0, 4)} to ${short(to)} ${to.slice(0, 4)}.${problems.length ? ' ' + problems.length + ' line(s) could not be read: ' + problems.slice(0, 3).join(' ') : ''}`);
  res.redirect('/oncall#schedule');
});

router.post('/admin/oncall/:id/delete', manage, (req, res) => {
  const s = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM oncall_shifts WHERE id = ? AND branch_id = ?').get(req.params.id, req.user.workBranch) : null;
  if (s) { db.prepare('DELETE FROM oncall_shifts WHERE id = ?').run(s.id); activity.log(req.user, 'On-call schedule changed', `${s.name} removed, ${s.start_on} to ${s.end_on}`); flash(req, 'ok', `${s.name} removed from that shift.`); }
  res.redirect('/oncall#schedule');
});

// Swap one person for another on a shift (someone covering for a colleague).
router.post('/admin/oncall/:id', manage, (req, res) => {
  const s = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM oncall_shifts WHERE id = ? AND branch_id = ?').get(req.params.id, req.user.workBranch) : null;
  const name = clean(req.body.name, 80);
  if (s && name) {
    db.prepare('UPDATE oncall_shifts SET name = ?, phone = ? WHERE id = ?').run(name, clean(req.body.phone, 30) || null, s.id);
    activity.log(req.user, 'On-call schedule changed', `${s.name} swapped for ${name}, ${s.start_on} to ${s.end_on}`);
    flash(req, 'ok', 'Saved.');
  }
  res.redirect('/oncall#schedule');
});

module.exports = router;
