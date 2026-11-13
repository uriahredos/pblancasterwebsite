'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { sendCsv } = require('../csv');
const { clean, isYmd, labels, fmtDateTime, localDate } = require('../util');
const { history } = require('../changes');

const router = express.Router();
const { requireAdmin, flash } = auth;

const userList = () => db.prepare('SELECT id, display_name FROM users ORDER BY display_name COLLATE NOCASE').all();

/** Turn the filter boxes into a WHERE clause. `t` is the table alias. */
function buildFilter(query, t, { statuses, textCols, action = false }) {
  const f = {
    from: isYmd(query.from) ? query.from : '',
    to: isYmd(query.to) ? query.to : '',
    user: /^\d+$/.test(query.user || '') ? query.user : '',
    status: statuses[query.status] ? query.status : '',
    action: action && labels.action[query.action] ? query.action : '',
    q: clean(query.q, 100),
  };
  const where = [];
  const params = [];
  if (f.from) { where.push(`${t}.created_local_date >= ?`); params.push(f.from); }
  if (f.to) { where.push(`${t}.created_local_date <= ?`); params.push(f.to); }
  if (f.user) { where.push(`${t}.user_id = ?`); params.push(Number(f.user)); }
  if (f.status) { where.push(`${t}.status = ?`); params.push(f.status); }
  if (f.action) { where.push(`${t}.action = ?`); params.push(f.action); }
  if (f.q) {
    const like = '%' + f.q.replace(/[\\%_]/g, '\\$&') + '%';
    where.push('(' + textCols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    textCols.forEach(() => params.push(like));
  }
  return { f, sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const qs = (f) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

// ---- Parts ----------------------------------------------------------------

const PARTS_TEXT = [
  's.job_number', 's.note', 'u.display_name',
  '(SELECT group_concat(i.part_name, \' \') FROM parts_items i WHERE i.submission_id = s.id)',
];
const partsFilter = (query) => buildFilter(query, 's', { statuses: labels.partsStatus, textCols: PARTS_TEXT, action: true });

router.get('/admin', requireAdmin, (req, res) => res.redirect('/admin/parts'));

router.get('/admin/parts', requireAdmin, (req, res) => {
  const { f, sql, params } = partsFilter(req.query);
  const rows = db.prepare(
    `SELECT s.*, u.display_name,
            (SELECT group_concat(i.quantity || ' × ' || i.part_name, char(10))
             FROM parts_items i WHERE i.submission_id = s.id) AS items
     FROM parts_submissions s JOIN users u ON u.id = s.user_id
     ${sql} ORDER BY s.id DESC LIMIT 501`).all(...params);
  res.render('admin_parts', { title: 'Parts log', rows: rows.slice(0, 500), more: rows.length > 500, f, qs: qs(f), users: userList() });
});

router.get('/admin/parts.csv', requireAdmin, (req, res) => {
  const { sql, params } = partsFilter(req.query);
  const rows = db.prepare(
    `SELECT s.*, u.display_name, u.username, i.part_name, i.quantity
     FROM parts_submissions s JOIN users u ON u.id = s.user_id
     JOIN parts_items i ON i.submission_id = s.id
     ${sql} ORDER BY s.id, i.id`).all(...params);
  sendCsv(res, `parts-${localDate()}.csv`,
    ['Id', 'Submitted', 'Name', 'Username', 'Action', 'Part', 'Quantity', 'Van stock or job', 'Job number',
      'Needed by', 'Note', 'Status', 'Admin note', 'Photo', 'Edited', 'Cancelled', 'Checked'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), r.display_name, r.username, labels.action[r.action],
      r.part_name, r.quantity, labels.source[r.source], r.job_number, r.needed_by, r.note,
      r.status ? labels.partsStatus[r.status] : '', r.admin_note,
      r.photo_path ? `${config.baseUrl}/parts/photo/${r.id}` : '', fmtDateTime(r.edited_at), fmtDateTime(r.cancelled_at), fmtDateTime(r.audited_at)]));
});

// ---- Audit: every part taken, returned and requested in a date range ------

function auditRange(query) {
  const today = localDate();
  let from = isYmd(query.from) ? query.from : today.slice(0, 8) + '01'; // default: this month so far
  let to = isYmd(query.to) ? query.to : today;
  if (from > to) [from, to] = [to, from];
  return {
    from, to,
    user: /^\d+$/.test(query.user || '') ? query.user : '',
    show: query.show === 'unchecked' ? 'unchecked' : '',
  };
}

function auditData(query) {
  const f = auditRange(query);
  const where = ['s.created_local_date >= ?', 's.created_local_date <= ?'];
  const params = [f.from, f.to];
  if (f.user) { where.push('s.user_id = ?'); params.push(Number(f.user)); }
  if (f.show === 'unchecked') where.push('s.audited_at IS NULL AND s.cancelled_at IS NULL');
  const rows = db.prepare(
    `SELECT s.*, u.display_name, a.display_name AS audited_by_name,
            i.part_name, i.quantity, c.description AS part_description
     FROM parts_submissions s JOIN users u ON u.id = s.user_id
     JOIN parts_items i ON i.submission_id = s.id
     LEFT JOIN users a ON a.id = s.audited_by
     LEFT JOIN parts_catalog c ON c.part_number = TRIM(i.part_name)
     WHERE ${where.join(' AND ')} ORDER BY s.id, i.id`).all(...params);

  const sections = {};
  for (const action of ['take', 'return', 'request']) {
    sections[action] = { entries: [], count: 0, lines: 0, quantity: 0, checked: 0, cancelled: 0 };
  }
  let current = null;
  for (const r of rows) {
    const sec = sections[r.action];
    if (!current || current.id !== r.id) {
      current = { ...r, items: [] };
      sec.entries.push(current);
      if (r.cancelled_at) sec.cancelled++;
      else { sec.count++; if (r.audited_at) sec.checked++; }
    }
    current.items.push({ part_name: r.part_name, quantity: r.quantity, description: r.part_description });
    if (!r.cancelled_at) { sec.lines++; sec.quantity += r.quantity; }
  }
  return { f, sections, rows };
}

router.get('/admin/parts/audit', requireAdmin, (req, res) => {
  const data = auditData(req.query);
  const today = localDate();
  const d = new Date(today + 'T12:00:00Z');
  const ymd = (x) => x.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const lastMonthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 12));
  const weekStart = new Date(d); weekStart.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  const week = new Date(d); week.setUTCDate(d.getUTCDate() - 6);
  res.render('admin_audit', {
    title: 'Parts audit', ...data, qs: qs(data.f), users: userList(),
    presets: [
      ['Today', today, today],
      ['This week', ymd(weekStart), today],
      ['Last 7 days', ymd(week), today],
      ['This month', monthStart, today],
      ['Last month', ymd(lastMonthEnd).slice(0, 8) + '01', ymd(lastMonthEnd)],
    ],
  });
});

router.get('/admin/parts/audit.csv', requireAdmin, (req, res) => {
  const { f, rows } = auditData(req.query);
  sendCsv(res, `parts-audit-${f.from}-to-${f.to}.csv`,
    ['Entry', 'Submitted', 'Action', 'Name', 'Part', 'Description', 'Quantity', 'Van stock or job', 'Job number', 'Needed by',
      'Status', 'Note', 'Edited', 'Cancelled', 'Checked', 'Checked by'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), labels.action[r.action], r.display_name, r.part_name, r.part_description,
      r.quantity, labels.source[r.source], r.job_number, r.needed_by, r.status ? labels.partsStatus[r.status] : '', r.note,
      fmtDateTime(r.edited_at), fmtDateTime(r.cancelled_at), fmtDateTime(r.audited_at), r.audited_by_name]));
});

const auditBack = (body) => '/admin/parts/audit' + (typeof body.qs === 'string' && body.qs ? '?' + qs(auditRange(Object.fromEntries(new URLSearchParams(body.qs)))) : '');

// Tick (or untick) one entry as checked.
router.post('/admin/parts/:id/audit', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id, audited_at, cancelled_at FROM parts_submissions WHERE id = ?').get(req.params.id);
  if (row && !row.cancelled_at) {
    if (row.audited_at) db.prepare('UPDATE parts_submissions SET audited_at = NULL, audited_by = NULL WHERE id = ?').run(row.id);
    else db.prepare('UPDATE parts_submissions SET audited_at = ?, audited_by = ? WHERE id = ?').run(new Date().toISOString(), req.user.id, row.id);
  }
  res.redirect(auditBack(req.body) + '#e' + req.params.id);
});

// Tick everything in the chosen range that is not checked yet.
router.post('/admin/parts/audit/check-all', requireAdmin, (req, res) => {
  const f = auditRange(Object.fromEntries(new URLSearchParams(String(req.body.qs || ''))));
  const where = ['created_local_date >= ?', 'created_local_date <= ?', 'audited_at IS NULL', 'cancelled_at IS NULL'];
  const params = [f.from, f.to];
  if (f.user) { where.push('user_id = ?'); params.push(Number(f.user)); }
  if (labels.action[req.body.action]) { where.push('action = ?'); params.push(req.body.action); }
  const info = db.prepare(`UPDATE parts_submissions SET audited_at = ?, audited_by = ? WHERE ${where.join(' AND ')}`)
    .run(new Date().toISOString(), req.user.id, ...params);
  flash(req, 'ok', `${info.changes} ${info.changes === 1 ? 'entry' : 'entries'} marked as checked.`);
  res.redirect(auditBack(req.body));
});

// What was used: totals per part, per person and per job. Cancelled entries are left out.
function summaryData(query) {
  const { f, sql, params } = buildFilter({ from: query.from, to: query.to, user: query.user, q: query.q }, 's',
    { statuses: {}, textCols: ['i.part_name', 's.job_number'] });
  const where = (sql ? sql + ' AND ' : 'WHERE ') + 's.cancelled_at IS NULL';
  const sums = `SUM(CASE WHEN s.action = 'take' THEN i.quantity ELSE 0 END) AS taken,
                SUM(CASE WHEN s.action = 'return' THEN i.quantity ELSE 0 END) AS returned,
                SUM(CASE WHEN s.action = 'request' THEN i.quantity ELSE 0 END) AS requested,
                COUNT(DISTINCT s.id) AS entries`;
  const from = `FROM parts_items i JOIN parts_submissions s ON s.id = i.submission_id JOIN users u ON u.id = s.user_id`;
  const byPart = db.prepare(
    `SELECT MIN(TRIM(i.part_name)) AS part, MAX(c.description) AS description, ${sums}
     ${from} LEFT JOIN parts_catalog c ON c.part_number = TRIM(i.part_name)
     ${where} GROUP BY UPPER(TRIM(i.part_name)) ORDER BY taken DESC, part COLLATE NOCASE`).all(...params);
  const byPerson = db.prepare(
    `SELECT u.display_name AS name, ${sums} ${from} ${where} GROUP BY u.id ORDER BY taken DESC, name COLLATE NOCASE`).all(...params);
  const byJob = db.prepare(
    `SELECT s.job_number AS job, ${sums} ${from} ${where} AND s.source = 'job'
     GROUP BY UPPER(TRIM(s.job_number)) ORDER BY MAX(s.id) DESC LIMIT 300`).all(...params);
  return { f, byPart, byPerson, byJob };
}

router.get('/admin/parts/summary', requireAdmin, (req, res) => {
  const data = summaryData(req.query);
  res.render('admin_summary', { title: 'Parts usage', ...data, qs: qs(data.f), users: userList() });
});

router.get('/admin/parts/summary.csv', requireAdmin, (req, res) => {
  const { byPart } = summaryData(req.query);
  sendCsv(res, `parts-usage-${localDate()}.csv`,
    ['Part', 'Description', 'Taken', 'Returned', 'Net used', 'Requested', 'Entries'],
    byPart.map((r) => [r.part, r.description, r.taken, r.returned, r.taken - r.returned, r.requested, r.entries]));
});

router.get('/admin/parts/:id', requireAdmin, (req, res) => {
  const s = db.prepare(
    `SELECT s.*, u.display_name FROM parts_submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(req.params.id);
  if (!s) return res.status(404).render('error', { title: 'Page not found', message: 'That entry does not exist.' });
  const items = db.prepare('SELECT part_name, quantity FROM parts_items WHERE submission_id = ? ORDER BY id').all(s.id);
  res.render('admin_parts_detail', { title: `Parts entry ${s.id}`, s, items, history: history('parts', s.id) });
});

router.post('/admin/parts/:id/status', requireAdmin, (req, res) => {
  if (labels.partsStatus[req.body.status]) {
    db.prepare("UPDATE parts_submissions SET status = ?, admin_note = ? WHERE id = ? AND action = 'request'")
      .run(req.body.status, clean(req.body.admin_note, 1000) || null, req.params.id);
    flash(req, 'ok', 'Request updated.');
  }
  res.redirect(`/admin/parts/${req.params.id}`);
});

// ---- Training -------------------------------------------------------------

const trainingFilter = (query) => buildFilter(query, 't', { statuses: labels.trainingStatus, textCols: ['t.description', 'u.display_name'] });

router.get('/admin/training', requireAdmin, (req, res) => {
  const { f, sql, params } = trainingFilter(req.query);
  const rows = db.prepare(
    `SELECT t.*, u.display_name FROM training_requests t JOIN users u ON u.id = t.user_id
     ${sql} ORDER BY t.id DESC LIMIT 501`).all(...params);
  res.render('admin_training', { title: 'Training requests', rows: rows.slice(0, 500), more: rows.length > 500, f, qs: qs(f), users: userList() });
});

router.get('/admin/training.csv', requireAdmin, (req, res) => {
  const { sql, params } = trainingFilter(req.query);
  const rows = db.prepare(
    `SELECT t.*, u.display_name, u.username FROM training_requests t JOIN users u ON u.id = t.user_id
     ${sql} ORDER BY t.id`).all(...params);
  sendCsv(res, `training-${localDate()}.csv`,
    ['Id', 'Submitted', 'Name', 'Username', 'Training description', 'Wants contact', 'Private', 'Status', 'Admin note', 'Edited', 'Cancelled'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), r.display_name, r.username, r.description,
      r.wants_contact ? 'Yes' : 'No', r.is_private ? 'Yes' : 'No', labels.trainingStatus[r.status], r.admin_note,
      fmtDateTime(r.edited_at), fmtDateTime(r.cancelled_at)]));
});

router.get('/admin/training/:id', requireAdmin, (req, res) => {
  const t = db.prepare(
    'SELECT t.*, u.display_name, u.email FROM training_requests t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(req.params.id);
  if (!t) return res.status(404).render('error', { title: 'Page not found', message: 'That request does not exist.' });
  res.render('admin_training_detail', { title: `Training request ${t.id}`, t, history: history('training', t.id) });
});

router.post('/admin/training/:id/status', requireAdmin, (req, res) => {
  if (labels.trainingStatus[req.body.status]) {
    db.prepare('UPDATE training_requests SET status = ?, admin_note = ? WHERE id = ?')
      .run(req.body.status, clean(req.body.admin_note, 1000) || null, req.params.id);
    flash(req, 'ok', 'Request updated.');
  }
  res.redirect(`/admin/training/${req.params.id}`);
});

// ---- Users ----------------------------------------------------------------

const renderUsers = (req, res, extra = {}) => res.status(extra.errors ? 400 : 200).render('admin_users', {
  title: 'Users', errors: [], values: {}, created: null,
  users: db.prepare('SELECT * FROM users ORDER BY active DESC, display_name COLLATE NOCASE').all(),
  ...extra,
});

router.get('/admin/users', requireAdmin, (req, res) => {
  const created = req.session.created || null; // temp password, shown once
  delete req.session.created;
  renderUsers(req, res, { created });
});

router.post('/admin/users', requireAdmin, (req, res) => {
  const values = {
    username: clean(req.body.username, 40), display_name: clean(req.body.display_name, 80),
    email: clean(req.body.email, 120), role: req.body.role === 'admin' ? 'admin' : 'user',
    reviewer: req.body.reviewer === '1',
  };
  const errors = [];
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(values.username)) errors.push('Username: 3-40 letters, numbers, dot, dash or underscore.');
  else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) errors.push('That username is already taken.');
  if (!values.display_name) errors.push('Enter the person\'s name.');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('That email address does not look right.');
  if (errors.length) return renderUsers(req, res, { errors, values });

  const password = auth.tempPassword();
  auth.createUser({ username: values.username, displayName: values.display_name, email: values.email, password, role: values.role, reviewer: values.reviewer });
  req.session.created = { username: values.username, password, what: 'created' };
  res.redirect('/admin/users');
});

// Change a person's name, username or email after the account exists.
router.get('/admin/users/:id/edit', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  res.render('admin_user_edit', { title: 'Edit person', target, values: target, errors: [] });
});

router.post('/admin/users/:id/edit', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const values = { username: clean(req.body.username, 40), display_name: clean(req.body.display_name, 80), email: clean(req.body.email, 120) };
  const errors = [];
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(values.username)) errors.push('Username: 3-40 letters, numbers, dot, dash or underscore.');
  else if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(values.username, target.id)) errors.push('That username is already taken.');
  if (!values.display_name) errors.push('Enter the person\'s name.');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('That email address does not look right.');
  if (errors.length) return res.status(400).render('admin_user_edit', { title: 'Edit person', target, values, errors });
  db.prepare('UPDATE users SET username = ?, display_name = ?, email = ? WHERE id = ?')
    .run(values.username, values.display_name, values.email || null, target.id);
  flash(req, 'ok', `${values.display_name} updated.`);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/:op', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const self = target.id === req.user.id;
  const set = (col, val) => db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, target.id);
  switch (req.params.op) {
    case 'reset-password': {
      const password = auth.tempPassword();
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(password), target.id);
      req.session.created = { username: target.username, password, what: 'reset' };
      break;
    }
    case 'toggle-active':
      if (self) flash(req, 'err', 'You cannot disable your own account.');
      else set('active', target.active ? 0 : 1);
      break;
    case 'toggle-admin':
      if (self) flash(req, 'err', 'You cannot remove your own admin access.');
      else set('role', target.role === 'admin' ? 'user' : 'admin');
      break;
    case 'toggle-reviewer':
      set('can_review_complaints', target.can_review_complaints ? 0 : 1);
      break;
    default:
  }
  res.redirect('/admin/users');
});

module.exports = router;
