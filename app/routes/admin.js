'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { sendCsv } = require('../csv');
const { clean, isYmd, labels, fmtDateTime, localDate } = require('../util');
const { history } = require('../changes');

const router = express.Router();
const access = require('../permissions');
const activity = require('../activity');
const mail = require('../mail');
const { requirePerm, forbidden, flash } = auth;

/** People this viewer may pick in a "Person" filter: everyone, or just their own team. */
function userList(viewer) {
  const ids = access.visibleUserIds(viewer);
  const all = db.prepare('SELECT id, display_name FROM users ORDER BY display_name COLLATE NOCASE').all();
  return ids ? all.filter((u) => ids.includes(u.id)) : all;
}

/** SQL that keeps a team-scoped viewer to their own people. Ids are integers from the database. */
function scopeSql(viewer, column) {
  const ids = access.visibleUserIds(viewer);
  return ids ? `${column} IN (${ids.map(Number).join(',')})` : null;
}

/** Turn the filter boxes into a WHERE clause. `t` is the table alias. */
function buildFilter(query, t, { statuses, textCols, action = false }, viewer) {
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
  const scope = scopeSql(viewer, `${t}.user_id`);
  if (scope) where.push(scope);
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
const partsFilter = (query, viewer) => buildFilter(query, 's', { statuses: labels.partsStatus, textCols: PARTS_TEXT, action: true }, viewer);

// Send people to the first admin page their profile allows.
router.get('/admin', auth.requireLogin, (req, res) => {
  const pages = [['parts.view', '/admin/parts'], ['parts.audit', '/admin/parts/audit'], ['training.view', '/admin/training'],
    ['catalog.manage', '/admin/catalog'], ['users.manage', '/admin/users'], ['profiles.manage', '/admin/profiles'], ['complaints.review', '/admin/complaints']];
  const first = pages.find(([perm]) => access.can(req.user, perm));
  return first ? res.redirect(first[1]) : forbidden(res);
});

router.get('/admin/parts', requirePerm('parts.view'), (req, res) => {
  const { f, sql, params } = partsFilter(req.query, req.user);
  const rows = db.prepare(
    `SELECT s.*, u.display_name,
            (SELECT group_concat(i.quantity || ' × ' || i.part_name, char(10))
             FROM parts_items i WHERE i.submission_id = s.id) AS items
     FROM parts_submissions s JOIN users u ON u.id = s.user_id
     ${sql} ORDER BY s.id DESC LIMIT 501`).all(...params);
  res.render('admin_parts', { title: 'Parts log', rows: rows.slice(0, 500), more: rows.length > 500, f, qs: qs(f), users: userList(req.user) });
});

router.get('/admin/parts.csv', requirePerm('parts.view'), (req, res) => {
  const { sql, params } = partsFilter(req.query, req.user);
  const rows = db.prepare(
    `SELECT s.*, u.display_name, u.username, i.part_name, i.quantity
     FROM parts_submissions s JOIN users u ON u.id = s.user_id
     JOIN parts_items i ON i.submission_id = s.id
     ${sql} ORDER BY s.id, i.id`).all(...params);
  sendCsv(res, `parts-${localDate()}.csv`,
    ['Id', 'Submitted', 'Name', 'Username', 'Action', 'Part', 'Quantity', 'Van stock or job', 'Job number', 'Truck',
      'Needed by', 'Note', 'Status', 'Admin note', 'Photo', 'Edited', 'Cancelled', 'Checked'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), r.display_name, r.username, labels.action[r.action],
      r.part_name, r.quantity, labels.source[r.source], r.job_number, r.truck, r.needed_by, r.note,
      r.status ? labels.partsStatus[r.status] : '', r.admin_note,
      r.photo_path ? `${config.baseUrl}/parts/photo/${r.id}` : '', fmtDateTime(r.edited_at), fmtDateTime(r.cancelled_at), fmtDateTime(r.audited_at)]));
});

// ---- Requests waiting to be ordered or handed over ------------------------

router.get('/admin/requests', requirePerm('parts.view'), (req, res) => {
  const scope = scopeSql(req.user, 's.user_id');
  const rows = db.prepare(
    `SELECT s.*, u.display_name,
            (SELECT group_concat(i.quantity || ' × ' || i.part_name, char(10)) FROM parts_items i WHERE i.submission_id = s.id) AS items
     FROM parts_submissions s JOIN users u ON u.id = s.user_id
     WHERE s.action = 'request' AND s.cancelled_at IS NULL AND s.status IN ('new','ordered') ${scope ? 'AND ' + scope : ''}
     ORDER BY s.needed_by IS NULL, s.needed_by, s.id`).all();
  const today = localDate();
  const soon = new Date(today + 'T12:00:00Z'); soon.setUTCDate(soon.getUTCDate() + 3);
  const soonYmd = soon.toISOString().slice(0, 10);
  for (const r of rows) r.due = !r.needed_by ? '' : r.needed_by < today ? 'overdue' : r.needed_by <= soonYmd ? 'soon' : '';
  res.render('admin_requests', { title: 'Parts requests', rows, overdue: rows.filter((r) => r.due === 'overdue').length });
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

function auditData(query, viewer) {
  const f = auditRange(query);
  const where = ['s.created_local_date >= ?', 's.created_local_date <= ?'];
  const params = [f.from, f.to];
  const scope = scopeSql(viewer, 's.user_id');
  if (scope) where.push(scope);
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

router.get('/admin/parts/audit', requirePerm('parts.audit'), (req, res) => {
  const data = auditData(req.query, req.user);
  const today = localDate();
  const d = new Date(today + 'T12:00:00Z');
  const ymd = (x) => x.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const lastMonthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 12));
  const weekStart = new Date(d); weekStart.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  const week = new Date(d); week.setUTCDate(d.getUTCDate() - 6);
  res.render('admin_audit', {
    title: 'Parts audit', ...data, qs: qs(data.f), users: userList(req.user),
    presets: [
      ['Today', today, today],
      ['This week', ymd(weekStart), today],
      ['Last 7 days', ymd(week), today],
      ['This month', monthStart, today],
      ['Last month', ymd(lastMonthEnd).slice(0, 8) + '01', ymd(lastMonthEnd)],
    ],
  });
});

router.get('/admin/parts/audit.csv', requirePerm('parts.audit'), (req, res) => {
  const { f, rows } = auditData(req.query, req.user);
  sendCsv(res, `parts-audit-${f.from}-to-${f.to}.csv`,
    ['Entry', 'Submitted', 'Action', 'Name', 'Part', 'Description', 'Quantity', 'Van stock or job', 'Job number', 'Truck', 'Needed by',
      'Status', 'Note', 'Edited', 'Cancelled', 'Checked', 'Checked by'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), labels.action[r.action], r.display_name, r.part_name, r.part_description,
      r.quantity, labels.source[r.source], r.job_number, r.truck, r.needed_by, r.status ? labels.partsStatus[r.status] : '', r.note,
      fmtDateTime(r.edited_at), fmtDateTime(r.cancelled_at), fmtDateTime(r.audited_at), r.audited_by_name]));
});

const auditBack = (body) => '/admin/parts/audit' + (typeof body.qs === 'string' && body.qs ? '?' + qs(auditRange(Object.fromEntries(new URLSearchParams(body.qs)))) : '');

// Tick (or untick) one entry as checked.
router.post('/admin/parts/:id/audit', requirePerm('parts.audit'), (req, res) => {
  const row = db.prepare('SELECT id, user_id, audited_at, cancelled_at FROM parts_submissions WHERE id = ?').get(req.params.id);
  if (row && !access.canSee(req.user, row.user_id)) return forbidden(res);
  if (row && !row.cancelled_at) {
    if (row.audited_at) db.prepare('UPDATE parts_submissions SET audited_at = NULL, audited_by = NULL WHERE id = ?').run(row.id);
    else db.prepare('UPDATE parts_submissions SET audited_at = ?, audited_by = ? WHERE id = ?').run(new Date().toISOString(), req.user.id, row.id);
  }
  res.redirect(auditBack(req.body) + '#e' + req.params.id);
});

// Tick everything in the chosen range that is not checked yet.
router.post('/admin/parts/audit/check-all', requirePerm('parts.audit'), (req, res) => {
  const f = auditRange(Object.fromEntries(new URLSearchParams(String(req.body.qs || ''))));
  const where = ['created_local_date >= ?', 'created_local_date <= ?', 'audited_at IS NULL', 'cancelled_at IS NULL'];
  const params = [f.from, f.to];
  const scope = scopeSql(req.user, 'user_id');
  if (scope) where.push(scope);
  if (f.user) { where.push('user_id = ?'); params.push(Number(f.user)); }
  if (labels.action[req.body.action]) { where.push('action = ?'); params.push(req.body.action); }
  const info = db.prepare(`UPDATE parts_submissions SET audited_at = ?, audited_by = ? WHERE ${where.join(' AND ')}`)
    .run(new Date().toISOString(), req.user.id, ...params);
  flash(req, 'ok', `${info.changes} ${info.changes === 1 ? 'entry' : 'entries'} marked as checked.`);
  res.redirect(auditBack(req.body));
});

// What was used: totals per part, per person and per job. Cancelled entries are left out.
function summaryData(query, viewer) {
  const { f, sql, params } = buildFilter({ from: query.from, to: query.to, user: query.user, q: query.q }, 's',
    { statuses: {}, textCols: ['i.part_name', 's.job_number'] }, viewer);
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
  const byTruck = db.prepare(
    `SELECT s.truck AS truck, ${sums} ${from} ${where} AND s.truck IS NOT NULL
     GROUP BY UPPER(TRIM(s.truck)) ORDER BY taken DESC, truck COLLATE NOCASE`).all(...params);
  return { f, byPart, byPerson, byJob, byTruck };
}

router.get('/admin/parts/summary', requirePerm('parts.view'), (req, res) => {
  const data = summaryData(req.query, req.user);
  res.render('admin_summary', { title: 'Parts usage', ...data, qs: qs(data.f), users: userList(req.user) });
});

router.get('/admin/parts/summary.csv', requirePerm('parts.view'), (req, res) => {
  const { byPart } = summaryData(req.query, req.user);
  sendCsv(res, `parts-usage-${localDate()}.csv`,
    ['Part', 'Description', 'Taken', 'Returned', 'Net used', 'Requested', 'Entries'],
    byPart.map((r) => [r.part, r.description, r.taken, r.returned, r.taken - r.returned, r.requested, r.entries]));
});

router.get('/admin/parts/:id', requirePerm('parts.view'), (req, res) => {
  const s = db.prepare(
    `SELECT s.*, u.display_name FROM parts_submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(req.params.id);
  if (!s) return res.status(404).render('error', { title: 'Page not found', message: 'That entry does not exist.' });
  if (!access.canSee(req.user, s.user_id)) return forbidden(res);
  const items = db.prepare('SELECT part_name, quantity FROM parts_items WHERE submission_id = ? ORDER BY id').all(s.id);
  res.render('admin_parts_detail', { title: `Parts entry ${s.id}`, s, items, history: history('parts', s.id) });
});

router.post('/admin/parts/:id/status', requirePerm('parts.manage'), (req, res) => {
  const row = db.prepare('SELECT user_id FROM parts_submissions WHERE id = ?').get(req.params.id);
  if (row && !access.canSee(req.user, row.user_id)) return forbidden(res);
  if (row && labels.partsStatus[req.body.status]) {
    const before = db.prepare('SELECT status, admin_note, user_id FROM parts_submissions WHERE id = ?').get(req.params.id);
    // From the queue's one-tap buttons there is no note box, so keep the note that is already there.
    const note = req.body.admin_note === undefined ? before.admin_note : clean(req.body.admin_note, 1000) || null;
    const info = db.prepare("UPDATE parts_submissions SET status = ?, admin_note = ? WHERE id = ? AND action = 'request' AND cancelled_at IS NULL")
      .run(req.body.status, note, req.params.id);
    if (info.changes && (before.status !== req.body.status || (before.admin_note || null) !== note) && before.user_id !== req.user.id) {
      db.prepare('UPDATE parts_submissions SET unseen = 1 WHERE id = ?').run(req.params.id);
      mail.notifyStatus(db.prepare('SELECT display_name, email FROM users WHERE id = ?').get(before.user_id),
        'parts request', labels.partsStatus[req.body.status], note, '/my');
    }
    flash(req, 'ok', 'Request updated.');
  }
  res.redirect(req.body.back === 'requests' ? '/admin/requests' : `/admin/parts/${req.params.id}`);
});

// Permanently remove a parts entry. Stock goes back to what it would be without it.
router.post('/admin/parts/:id/delete', requirePerm('records.delete'), (req, res) => {
  const s = db.prepare('SELECT s.*, u.display_name FROM parts_submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(req.params.id);
  if (!s) return res.redirect('/admin/parts');
  if (!access.canSee(req.user, s.user_id)) return forbidden(res);
  const items = db.prepare('SELECT part_name, quantity FROM parts_items WHERE submission_id = ? ORDER BY id').all(s.id);
  db.transaction(() => {
    db.prepare("DELETE FROM change_log WHERE kind = 'parts' AND record_id = ?").run(s.id);
    db.prepare('DELETE FROM parts_submissions WHERE id = ?').run(s.id); // its part lines go with it
  })();
  if (s.photo_path) require('../uploads').remove(s.photo_path);
  activity.log(req.user, 'Parts entry deleted',
    `${labels.action[s.action]} by ${s.display_name}, ${fmtDateTime(s.created_at)}: ${items.map((i) => i.quantity + ' × ' + i.part_name).join(', ')}`);
  flash(req, 'ok', 'Entry deleted.');
  res.redirect(req.body.back === 'requests' ? '/admin/requests' : '/admin/parts');
});

// ---- Training -------------------------------------------------------------

const trainingFilter = (query, viewer) => buildFilter(query, 't', { statuses: labels.trainingStatus, textCols: ['t.description', 'u.display_name'] }, viewer);

router.get('/admin/training', requirePerm('training.view'), (req, res) => {
  const { f, sql, params } = trainingFilter(req.query, req.user);
  const rows = db.prepare(
    `SELECT t.*, u.display_name, (SELECT COUNT(*) FROM training_votes v WHERE v.request_id = t.id) AS votes
     FROM training_requests t JOIN users u ON u.id = t.user_id
     ${sql} ORDER BY t.id DESC LIMIT 501`).all(...params);
  res.render('admin_training', { title: 'Training requests', rows: rows.slice(0, 500), more: rows.length > 500, f, qs: qs(f), users: userList(req.user) });
});

router.get('/admin/training.csv', requirePerm('training.view'), (req, res) => {
  const { sql, params } = trainingFilter(req.query, req.user);
  const rows = db.prepare(
    `SELECT t.*, u.display_name, u.username FROM training_requests t JOIN users u ON u.id = t.user_id
     ${sql} ORDER BY t.id`).all(...params);
  sendCsv(res, `training-${localDate()}.csv`,
    ['Id', 'Submitted', 'Name', 'Username', 'Training description', 'Wants contact', 'Private', 'Status', 'Admin note', 'Edited', 'Cancelled'],
    rows.map((r) => [r.id, fmtDateTime(r.created_at), r.display_name, r.username, r.description,
      r.wants_contact ? 'Yes' : 'No', r.is_private ? 'Yes' : 'No', labels.trainingStatus[r.status], r.admin_note,
      fmtDateTime(r.edited_at), fmtDateTime(r.cancelled_at)]));
});

router.get('/admin/training/:id', requirePerm('training.view'), (req, res) => {
  const t = db.prepare(
    'SELECT t.*, u.display_name, u.email FROM training_requests t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(req.params.id);
  if (!t) return res.status(404).render('error', { title: 'Page not found', message: 'That request does not exist.' });
  if (!access.canSee(req.user, t.user_id)) return forbidden(res);
  res.render('admin_training_detail', {
    title: `Training request ${t.id}`, t, history: history('training', t.id),
    voters: db.prepare('SELECT u.display_name FROM training_votes v JOIN users u ON u.id = v.user_id WHERE v.request_id = ? ORDER BY u.display_name COLLATE NOCASE').all(t.id),
    sessions: db.prepare('SELECT id, title, session_date, completed_at FROM training_sessions WHERE request_id = ? ORDER BY session_date').all(t.id),
  });
});

router.post('/admin/training/:id/status', requirePerm('training.manage'), (req, res) => {
  const row = db.prepare('SELECT user_id FROM training_requests WHERE id = ?').get(req.params.id);
  if (row && !access.canSee(req.user, row.user_id)) return forbidden(res);
  if (row && labels.trainingStatus[req.body.status]) {
    const before = db.prepare('SELECT status, admin_note, user_id FROM training_requests WHERE id = ?').get(req.params.id);
    const note = clean(req.body.admin_note, 1000) || null;
    db.prepare('UPDATE training_requests SET status = ?, admin_note = ? WHERE id = ?').run(req.body.status, note, req.params.id);
    if ((before.status !== req.body.status || (before.admin_note || null) !== note) && before.user_id !== req.user.id) {
      db.prepare('UPDATE training_requests SET unseen = 1 WHERE id = ?').run(req.params.id);
      mail.notifyStatus(db.prepare('SELECT display_name, email FROM users WHERE id = ?').get(before.user_id),
        'training request', labels.trainingStatus[req.body.status], note, '/my');
    }
    flash(req, 'ok', 'Request updated.');
  }
  res.redirect(`/admin/training/${req.params.id}`);
});

router.post('/admin/training/:id/delete', requirePerm('records.delete'), (req, res) => {
  const t = db.prepare('SELECT t.*, u.display_name FROM training_requests t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(req.params.id);
  if (!t) return res.redirect('/admin/training');
  if (!access.canSee(req.user, t.user_id)) return forbidden(res);
  db.transaction(() => {
    db.prepare("DELETE FROM change_log WHERE kind = 'training' AND record_id = ?").run(t.id);
    db.prepare('UPDATE training_sessions SET request_id = NULL WHERE request_id = ?').run(t.id); // sessions and attendance are kept
    db.prepare('DELETE FROM training_requests WHERE id = ?').run(t.id);
  })();
  // A private request's wording is not copied into the log.
  activity.log(req.user, 'Training request deleted',
    `by ${t.display_name}, ${fmtDateTime(t.created_at)}${t.is_private ? ' (private)' : ': ' + t.description.slice(0, 120)}`);
  flash(req, 'ok', 'Training request deleted.');
  res.redirect('/admin/training');
});

// ---- Users ----------------------------------------------------------------

const allProfiles = () => db.prepare('SELECT * FROM profiles ORDER BY name COLLATE NOCASE').all();
const getUser = (id) => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null);

/** Profiles this person is allowed to hand out: only ones that hold nothing they lack themselves. */
const grantableProfiles = (actor) => allProfiles().filter((p) => access.canGrant(actor, access.permsOf(p.id)));

/**
 * May `actor` change `target`'s account? Never the master account (except the
 * master themselves), never someone outside their team, and never someone
 * whose profile can do more than their own.
 */
function mayManage(actor, target) {
  if (!target) return false;
  if (target.is_master) return Boolean(actor.is_master);
  if (!access.canSee(actor, target.id)) return false;
  return !target.profile_id || access.canGrant(actor, access.permsOf(target.profile_id));
}

function renderUsers(req, res, extra = {}) {
  const ids = access.visibleUserIds(req.user);
  const users = db.prepare(
    `SELECT u.*, p.name AS profile_name, p.scope AS profile_scope,
            (SELECT group_concat(m.display_name, ', ') FROM user_managers um JOIN users m ON m.id = um.manager_id WHERE um.user_id = u.id) AS managers,
            (SELECT COUNT(*) FROM user_managers um WHERE um.manager_id = u.id) AS team_size
     FROM users u LEFT JOIN profiles p ON p.id = u.profile_id
     ORDER BY u.active DESC, u.display_name COLLATE NOCASE`).all()
    .filter((u) => !ids || ids.includes(u.id))
    .map((u) => ({ ...u, manageable: mayManage(req.user, u) }));
  res.status(extra.errors ? 400 : 200).render('admin_users', {
    title: 'Users', errors: [], values: {}, created: null, users,
    profiles: grantableProfiles(req.user), canAdd: req.user.scope === 'all', ...extra,
  });
}

router.get('/admin/users', requirePerm('users.manage'), (req, res) => {
  const created = req.session.created || null; // temp password, shown once
  delete req.session.created;
  renderUsers(req, res, { created });
});

function readPerson(body, exceptId) {
  const values = { username: clean(body.username, 40), display_name: clean(body.display_name, 80), email: clean(body.email, 120) };
  const errors = [];
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(values.username)) errors.push('Username: 3-40 letters, numbers, dot, dash or underscore.');
  else if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(values.username, exceptId || 0)) errors.push('That username is already taken.');
  if (!values.display_name) errors.push('Enter the person\'s name.');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('That email address does not look right.');
  return { values, errors };
}

router.post('/admin/users', requirePerm('users.manage'), (req, res) => {
  if (req.user.scope !== 'all') return forbidden(res); // team managers do not create accounts
  const { values, errors } = readPerson(req.body);
  const profile = grantableProfiles(req.user).find((p) => String(p.id) === String(req.body.profile_id));
  values.profile_id = req.body.profile_id;
  if (!profile) errors.push('Choose a profile.');
  if (errors.length) return renderUsers(req, res, { errors, values });

  const password = auth.tempPassword();
  auth.createUser({ username: values.username, displayName: values.display_name, email: values.email, password, profile: profile.id });
  activity.log(req.user, 'Person added', `${values.display_name} (${values.username}) as ${profile.name}`);
  req.session.created = { username: values.username, password, what: 'created' };
  res.redirect('/admin/users');
});

function editPage(req, res, target, extra = {}) {
  const profile = target.profile_id ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(target.profile_id) : null;
  const fullAccess = req.user.scope === 'all';
  res.status(extra.errors ? 400 : 200).render('admin_user_edit', {
    title: 'Edit person', target, values: target, errors: [], profile,
    profiles: grantableProfiles(req.user),
    // Changing someone's profile or team is for people who see everyone; nobody changes their own profile.
    canSetProfile: fullAccess && !target.is_master && target.id !== req.user.id,
    canSetTeam: Boolean(fullAccess && profile && profile.scope === 'team' && !target.is_master),
    people: db.prepare('SELECT id, display_name, active FROM users WHERE id <> ? ORDER BY display_name COLLATE NOCASE').all(target.id),
    team: db.prepare('SELECT user_id FROM user_managers WHERE manager_id = ?').all(target.id).map((r) => r.user_id),
    ...extra,
  });
}

// Change a person's name, username, email, profile, and (for managers) who they look after.
router.get('/admin/users/:id/edit', requirePerm('users.manage'), (req, res) => {
  const target = getUser(req.params.id);
  if (!target) return res.redirect('/admin/users');
  if (!mayManage(req.user, target)) return forbidden(res);
  editPage(req, res, target);
});

router.post('/admin/users/:id/edit', requirePerm('users.manage'), (req, res) => {
  const target = getUser(req.params.id);
  if (!target) return res.redirect('/admin/users');
  if (!mayManage(req.user, target)) return forbidden(res);
  const { values, errors } = readPerson(req.body, target.id);
  const fullAccess = req.user.scope === 'all';

  let profileId = target.profile_id;
  if (fullAccess && !target.is_master && target.id !== req.user.id && req.body.profile_id !== undefined) {
    const chosen = grantableProfiles(req.user).find((p) => String(p.id) === String(req.body.profile_id));
    if (!chosen) errors.push('Choose a profile.');
    else profileId = chosen.id;
  }
  if (errors.length) return editPage(req, res, target, { errors, values: { ...target, ...values } });

  db.transaction(() => {
    db.prepare('UPDATE users SET username = ?, display_name = ?, email = ?, profile_id = ?, default_truck = ? WHERE id = ?')
      .run(values.username, values.display_name, values.email || null, profileId, clean(req.body.default_truck, 20) || null, target.id);
    const changes = [];
    if (values.display_name !== target.display_name) changes.push(`name ${target.display_name} → ${values.display_name}`);
    if (values.username !== target.username) changes.push(`username ${target.username} → ${values.username}`);
    if ((values.email || null) !== (target.email || null)) changes.push('email changed');
    if (profileId !== target.profile_id) changes.push(`profile → ${db.prepare('SELECT name FROM profiles WHERE id = ?').get(profileId).name}`);
    if (changes.length) activity.log(req.user, 'Person edited', `${values.display_name}: ${changes.join(', ')}`);
    const newProfile = profileId ? db.prepare('SELECT scope FROM profiles WHERE id = ?').get(profileId) : null;
    if (fullAccess && req.body.team_form === '1' && newProfile && newProfile.scope === 'team') {
      const picked = [].concat(req.body.team || []).filter((v) => /^\d+$/.test(v)).map(Number).filter((id) => id !== target.id);
      db.prepare('DELETE FROM user_managers WHERE manager_id = ?').run(target.id);
      const add = db.prepare('INSERT OR IGNORE INTO user_managers (manager_id, user_id) SELECT ?, id FROM users WHERE id = ?');
      for (const id of picked) add.run(target.id, id);
      activity.log(req.user, 'Team set', `${values.display_name} manages ${picked.length} ${picked.length === 1 ? 'person' : 'people'}`);
    }
  })();
  flash(req, 'ok', `${values.display_name} updated.`);
  // After moving someone onto a manager profile, go straight to choosing their people.
  const becameManager = profileId !== target.profile_id && db.prepare("SELECT 1 FROM profiles WHERE id = ? AND scope = 'team'").get(profileId);
  res.redirect(becameManager ? `/admin/users/${target.id}/edit` : '/admin/users');
});

router.post('/admin/users/:id/:op', requirePerm('users.manage'), (req, res) => {
  const target = getUser(req.params.id);
  if (!target) return res.redirect('/admin/users');
  if (!mayManage(req.user, target)) return forbidden(res);
  switch (req.params.op) {
    case 'reset-password': {
      const password = auth.tempPassword();
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(auth.hashPassword(password), target.id);
      req.session.created = { username: target.username, password, what: 'reset' };
      activity.log(req.user, 'Password reset', target.display_name);
      break;
    }
    case 'toggle-active':
      if (target.id === req.user.id) flash(req, 'err', 'You cannot disable your own account.');
      else if (target.is_master) flash(req, 'err', 'The master account cannot be disabled.');
      else {
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(target.active ? 0 : 1, target.id);
        activity.log(req.user, target.active ? 'Account disabled' : 'Account enabled', target.display_name);
      }
      break;
    default:
  }
  res.redirect('/admin/users');
});

// ---- Profiles: what each kind of account may do ----------------------------

const getProfile = (id) => (/^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) : null);
const profileRows = () => db.prepare(
  `SELECT p.*, (SELECT COUNT(*) FROM users u WHERE u.profile_id = p.id) AS people,
          (SELECT COUNT(*) FROM profile_permissions pp WHERE pp.profile_id = p.id) AS perm_count
   FROM profiles p ORDER BY p.name COLLATE NOCASE`).all();

router.get('/admin/profiles', requirePerm('profiles.manage'), (req, res) => {
  res.render('admin_profiles', { title: 'Profiles', profiles: profileRows(), total: access.ALL.length, errors: [], values: {} });
});

router.post('/admin/profiles', requirePerm('profiles.manage'), (req, res) => {
  const name = clean(req.body.name, 40);
  const errors = [];
  if (name.length < 2) errors.push('Enter a name for the profile.');
  else if (access.profileByName(name) || name.toLowerCase() === 'master') errors.push('There is already a profile with that name.');
  if (errors.length) {
    return res.status(400).render('admin_profiles', { title: 'Profiles', profiles: profileRows(), total: access.ALL.length, errors, values: { name } });
  }
  // A new profile starts with the three "send a form" boxes ticked (where the creator has them).
  const id = access.createProfile(name, 'all', access.SUBMIT.filter((p) => access.can(req.user, p)));
  activity.log(req.user, 'Profile added', name);
  res.redirect(`/admin/profiles/${id}`);
});

function profilePage(req, res, profile, extra = {}) {
  res.status(extra.errors ? 400 : 200).render('admin_profile_edit', {
    title: `Profile: ${profile.name}`, profile, groups: access.GROUPS, held: access.permsOf(profile.id),
    people: db.prepare('SELECT display_name FROM users WHERE profile_id = ? ORDER BY display_name COLLATE NOCASE').all(profile.id),
    errors: [], values: profile, ...extra,
  });
}

router.get('/admin/profiles/:id', requirePerm('profiles.manage'), (req, res) => {
  const profile = getProfile(req.params.id);
  if (!profile) return res.redirect('/admin/profiles');
  profilePage(req, res, profile);
});

router.post('/admin/profiles/:id', requirePerm('profiles.manage'), (req, res) => {
  const profile = getProfile(req.params.id);
  if (!profile) return res.redirect('/admin/profiles');
  const name = clean(req.body.name, 40);
  const scope = req.body.scope === 'team' ? 'team' : 'all';
  const errors = [];
  const clash = access.profileByName(name);
  if (name.length < 2) errors.push('Enter a name for the profile.');
  else if ((clash && clash.id !== profile.id) || name.toLowerCase() === 'master') errors.push('There is already a profile with that name.');
  if (errors.length) return profilePage(req, res, profile, { errors, values: { ...profile, name, scope } });

  // You can only tick or untick boxes you hold yourself; the rest stay as they were.
  const ticked = new Set([].concat(req.body.perms || []));
  const held = access.permsOf(profile.id);
  const perms = access.ALL.filter((p) => (access.can(req.user, p) ? ticked.has(p) : held.has(p)));
  // Do not let someone lock themselves out of this page by unticking it on their own profile.
  if (!req.user.is_master && req.user.profile_id === profile.id && !perms.includes('profiles.manage')) perms.push('profiles.manage');

  db.transaction(() => {
    db.prepare('UPDATE profiles SET name = ?, scope = ? WHERE id = ?').run(name, scope, profile.id);
    access.setPermissions(profile.id, perms);
  })();
  const added = perms.filter((p) => !held.has(p));
  const removed = [...held].filter((p) => !perms.includes(p));
  const what = [];
  if (name !== profile.name) what.push(`renamed from ${profile.name}`);
  if (scope !== profile.scope) what.push(scope === 'team' ? 'now sees only their own people' : 'now sees everyone');
  if (added.length) what.push(`added: ${added.join(', ')}`);
  if (removed.length) what.push(`removed: ${removed.join(', ')}`);
  if (what.length) activity.log(req.user, 'Profile changed', `${name}: ${what.join('; ')}`);
  flash(req, 'ok', `${name} saved. It applies to everyone on that profile straight away.`);
  res.redirect('/admin/profiles');
});

router.post('/admin/profiles/:id/delete', requirePerm('profiles.manage'), (req, res) => {
  const profile = getProfile(req.params.id);
  if (!profile) return res.redirect('/admin/profiles');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users WHERE profile_id = ?').get(profile.id);
  if (n > 0) flash(req, 'err', `${profile.name} is still used by ${n} ${n === 1 ? 'person' : 'people'}. Move them to another profile first.`);
  else if (!access.canGrant(req.user, access.permsOf(profile.id))) flash(req, 'err', 'You cannot delete a profile that can do more than your own.');
  else {
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
    activity.log(req.user, 'Profile deleted', profile.name);
    flash(req, 'ok', `${profile.name} deleted.`);
  }
  res.redirect('/admin/profiles');
});

// ---- Activity log ----------------------------------------------------------

router.get('/admin/activity', requirePerm('activity.view'), (req, res) => {
  const q = clean(req.query.q, 60);
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = db.prepare(
    `SELECT a.at, a.action, a.detail, u.display_name FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
     ${q ? "WHERE a.action LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'" : ''}
     ORDER BY a.id DESC LIMIT 500`).all(...(q ? [like, like, like] : []));
  res.render('admin_activity', { title: 'Activity log', rows, q });
});

module.exports = router;
