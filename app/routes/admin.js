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
      'Needed by', 'Note', 'Status', 'Admin note', 'Photo', 'Edited', 'Cancelled'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), r.display_name, r.username, labels.action[r.action],
      r.part_name, r.quantity, labels.source[r.source], r.job_number, r.needed_by, r.note,
      r.status ? labels.partsStatus[r.status] : '', r.admin_note,
      r.photo_path ? `${config.baseUrl}/parts/photo/${r.id}` : '', fmtDateTime(r.edited_at), fmtDateTime(r.cancelled_at)]));
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
