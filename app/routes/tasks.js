'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const mail = require('../mail');
const config = require('../config');
const tasks = require('../tasks');
const push = require('../push');
const { requireLogin, requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate, fmtDate } = require('../util');

const router = express.Router();
const assign = requirePerm('tasks.assign');

// ---- My tasks -----------------------------------------------------------------

router.get('/tasks', requireLogin, (req, res) => {
  const today = localDate();
  const done = db.prepare(
    `SELECT t.*, b.display_name AS by_name FROM tasks t JOIN users b ON b.id = t.assigned_by
     WHERE t.assigned_to = ? AND t.done_at IS NOT NULL ORDER BY t.done_at DESC LIMIT 30`).all(req.user.id).map((t) => tasks.decorate(t, today));
  const open = tasks.withNotes(tasks.openFor(req.user.id));
  // A task is new until the person opens that one task. New ones are folded shut here with a "New" label.
  for (const t of open) t.isNew = !t.seen_at;
  res.render('tasks', { title: 'Tasks', open, done: tasks.withNotes(done), statuses: tasks.STATUSES });
});

// The person opened one of their tasks: it stops counting as new. Answers with the page header, so the
// bell and the counts on the page can be brought up to date without a reload.
router.post('/tasks/:id/seen', requireLogin, (req, res) => {
  const t = /^\d+$/.test(req.params.id) ? db.prepare('SELECT id, assigned_to FROM tasks WHERE id = ?').get(req.params.id) : null;
  if (!t) return res.status(404).end();
  if (t.assigned_to !== req.user.id) return forbidden(res);
  if (tasks.markSeen(t.id)) {
    res.locals.badges.newTasks = tasks.newCount(req.user.id);
    res.locals.myTasks = tasks.openFor(req.user.id, 6);
  }
  res.render('pulse', { title: 'Tasks' });
});

// Say where my task stands and leave a note, without closing it. Choosing "Finished" closes it.
router.post('/tasks/:id/update', requireLogin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.redirect('/tasks');
  if (t.assigned_to !== req.user.id) return forbidden(res);
  const note = clean(req.body.note, 500) || null;
  const status = req.body.status === 'done' ? 'done' : Object.keys(tasks.STATUSES).includes(req.body.status) ? req.body.status : t.status;
  const now = new Date().toISOString();
  if (t.done_at) return res.redirect('/tasks');
  if (status === 'done' && t.kind === 'inspection') { flash(req, 'err', 'This task is finished by doing the vehicle inspection.'); return res.redirect(`/tasks#t${t.id}`); }
  if (status === t.status && !note) { flash(req, 'ok', 'Nothing was changed.'); return res.redirect(`/tasks#t${t.id}`); }
  // The same note sent again straight away (a double tap, a retry on a slow connection) is not added twice.
  if (status === t.status && tasks.sameAsLast(t.id, req.user.id, note)) return res.redirect(`/tasks#t${t.id}`);
  if (status === 'done') db.prepare('UPDATE tasks SET done_at = ?, done_note = ? WHERE id = ?').run(now, note, t.id);
  else db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id);
  db.prepare('INSERT INTO task_notes (task_id, user_id, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(t.id, req.user.id, status !== t.status ? status : null, note, now);
  if (t.assigned_by !== req.user.id) {
    const name = status === 'done' ? 'Finished' : tasks.STATUSES[status];
    push.notify([t.assigned_by], 'task_done', { title: `${status === 'done' ? 'Done' : name}: ${t.title}`, body: `${req.user.display_name}${status === 'done' ? ' marked it done.' : status !== t.status ? ' set it to ' + name + '.' : ' added a note.'}${note ? ' "' + note + '"' : ''}`, url: status === 'done' ? '/admin/tasks?show=done' : `/admin/tasks/${t.id}` });
  }
  flash(req, 'ok', status === 'done' ? 'Task marked as finished.' : 'Update saved.');
  res.redirect(status === 'done' ? '/tasks' : `/tasks#t${t.id}`);
});

// Mark my own task done (with an optional note), or put it back.
router.post('/tasks/:id/done', requireLogin, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.redirect('/tasks');
  if (t.assigned_to !== req.user.id) return forbidden(res);
  if (t.done_at) db.prepare('UPDATE tasks SET done_at = NULL, done_note = NULL, seen_at = NULL WHERE id = ?').run(t.id);
  else if (t.kind === 'inspection') { flash(req, 'err', 'This task is finished by doing the vehicle inspection.'); return res.redirect(`/tasks#t${t.id}`); }
  else {
    const note = clean(req.body.done_note, 500) || null;
    db.prepare('UPDATE tasks SET done_at = ?, done_note = ? WHERE id = ?').run(new Date().toISOString(), note, t.id);
    if (t.assigned_by !== req.user.id) {
      push.notify([t.assigned_by], 'task_done', { title: `Done: ${t.title}`, body: `${req.user.display_name} marked it done.${note ? ' "' + note + '"' : ''}`, url: '/admin/tasks?show=done' });
    }
  }
  flash(req, 'ok', t.done_at ? 'Task reopened.' : 'Task marked as done.');
  res.redirect('/tasks');
});

// ---- Assigning and following up ---------------------------------------------------

/** People this person may give a task to: everyone, or their own team (and themselves). */
function assignable(viewer) {
  const ids = access.visibleUserIds(viewer);
  return db.prepare(
    `SELECT u.id, u.display_name, u.profile_id, p.name AS profile_name FROM users u LEFT JOIN profiles p ON p.id = u.profile_id
     WHERE u.active = 1 ORDER BY u.display_name COLLATE NOCASE`).all().filter((u) => !ids || ids.includes(u.id));
}

/** The profiles those people are on, with how many of them, for "give it to everyone on this profile". */
function groups(people) {
  const map = new Map();
  for (const u of people) {
    if (!u.profile_id) continue;
    const g = map.get(u.profile_id) || { id: u.profile_id, name: u.profile_name, count: 0 };
    g.count++; map.set(u.profile_id, g);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tasks this person may see and manage: any for their people, plus any they assigned. */
const mine = (viewer, t) => t.assigned_by === viewer.id || access.canSee(viewer, t.assigned_to);

function readForm(body) {
  const kind = body.kind === 'inspection' ? 'inspection' : 'general';
  const values = { kind, title: clean(body.title, 150) || (kind === 'inspection' ? 'Vehicle inspection' : ''), details: clean(body.details, 2000), due_on: clean(body.due_on, 10) };
  const errors = [];
  if (!values.title) errors.push('Say what needs doing.');
  if (values.due_on && !isYmd(values.due_on)) errors.push('The due date does not look right.');
  return { values, errors };
}

function listPage(req, res, extra = {}) {
  const show = ['overdue', 'done', 'all'].includes(req.query.show) ? req.query.show : 'open';
  const person = /^\d+$/.test(req.query.user || '') ? Number(req.query.user) : null;
  const today = localDate();
  const rows = db.prepare(
    `SELECT t.*, a.display_name AS to_name, b.display_name AS by_name FROM tasks t
     JOIN users a ON a.id = t.assigned_to JOIN users b ON b.id = t.assigned_by
     ORDER BY t.done_at IS NOT NULL, ${tasks.ORDER} LIMIT 1000`).all()
    .filter((t) => mine(req.user, t) && (!person || t.assigned_to === person))
    .map((t) => tasks.decorate(t, today));
  tasks.withNotes(rows);
  const counts = { open: rows.filter((t) => !t.done_at).length, overdue: rows.filter((t) => t.overdue).length, done: rows.filter((t) => t.done_at).length };
  const shown = rows.filter((t) => (show === 'all' ? true : show === 'done' ? t.done_at : show === 'overdue' ? t.overdue : !t.done_at));
  res.status(extra.errors ? 400 : 200).render('admin_tasks', {
    title: 'Manage tasks', rows: shown, counts, show, person, people: assignable(req.user), groups: groups(assignable(req.user)), errors: [], values: { to: [], groups: [] }, ...extra,
  });
}

router.get('/admin/tasks', assign, (req, res) => listPage(req, res));

router.post('/admin/tasks', assign, (req, res) => {
  const { values, errors } = readForm(req.body);
  const allowed = assignable(req.user);
  // People ticked one by one, plus everyone on any profile that was ticked (or simply everyone).
  const picked = [...new Set([].concat(req.body.to || []).map(String))];
  const pickedGroups = [...new Set([].concat(req.body.group || []).map(String))];
  const everyone = pickedGroups.includes('all');
  const to = allowed.filter((u) => everyone || picked.includes(String(u.id)) || pickedGroups.includes(String(u.profile_id)));
  values.to = picked; values.groups = pickedGroups;
  if (!to.length) errors.unshift('Choose who the task is for.');
  // A vehicle inspection can only go to people whose profile lets them send inspections.
  if (values.kind === 'inspection') {
    const cannot = to.filter((u) => !access.can(access.loadAccess(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)), 'inspections.submit'));
    if (cannot.length) errors.push(`${cannot.slice(0, 5).map((u) => u.display_name).join(', ')}${cannot.length > 5 ? ' and others' : ''} cannot send vehicle inspections with their profile.`);
  }
  if (errors.length) return listPage(req, res, { errors, values });

  const now = new Date().toISOString();
  const add = db.prepare('INSERT INTO tasks (title, details, assigned_to, assigned_by, due_on, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => { for (const u of to) add.run(values.title, values.details || null, u.id, req.user.id, values.due_on || null, now, values.kind); })();
  activity.log(req.user, 'Task assigned', `"${values.title}" to ${to.length > 6 ? to.length + ' people' : to.map((u) => u.display_name).join(', ')}${values.due_on ? ', due ' + fmtDate(values.due_on) : ''}`);
  push.notify(to.filter((u) => u.id !== req.user.id).map((u) => u.id), 'task_assigned',
    { title: `New task: ${values.title}`, body: `From ${req.user.display_name}. ${values.due_on ? 'Due ' + fmtDate(values.due_on) : 'No due date'}.`, url: '/tasks' });
  // Tell each person by email if they have one (the bell tells them either way).
  for (const u of to) {
    if (u.id === req.user.id) continue;
    const person = db.prepare('SELECT display_name, email FROM users WHERE id = ?').get(u.id);
    if (person.email) {
      mail.send([person.email], `New task: ${values.title}`,
        `Hi ${person.display_name},\n\n${req.user.display_name} gave you a task.\n\n${values.title}\n${values.details ? values.details + '\n' : ''}` +
        `${values.due_on ? 'Due: ' + fmtDate(values.due_on) : 'No due date'}\n\n${config.baseUrl}/tasks\n`);
    }
  }
  flash(req, 'ok', to.length === 1 ? `Task given to ${to[0].display_name}.` : `Task given to ${to.length} people.`);
  res.redirect('/admin/tasks');
});

function load(req, res) {
  const t = /^\d+$/.test(req.params.id) ? db.prepare(
    `SELECT t.*, a.display_name AS to_name, b.display_name AS by_name FROM tasks t
     JOIN users a ON a.id = t.assigned_to JOIN users b ON b.id = t.assigned_by WHERE t.id = ?`).get(req.params.id) : null;
  if (!t) { res.redirect('/admin/tasks'); return null; }
  if (!mine(req.user, t)) { forbidden(res); return null; }
  return t;
}

router.get('/admin/tasks/:id', assign, (req, res) => {
  const t = load(req, res);
  if (t) res.render('admin_task_edit', { title: 'Edit task', t: tasks.withNotes([tasks.decorate(t)])[0], values: t, errors: [], people: assignable(req.user) });
});

router.post('/admin/tasks/:id', assign, (req, res) => {
  const t = load(req, res);
  if (!t) return;
  const { values, errors } = readForm(req.body);
  const people = assignable(req.user);
  const to = people.find((u) => String(u.id) === String(req.body.assigned_to)) || (String(req.body.assigned_to) === String(t.assigned_to) ? { id: t.assigned_to } : null);
  if (!to) errors.unshift('Choose who the task is for.');
  if (errors.length) return res.status(400).render('admin_task_edit', { title: 'Edit task', t: tasks.withNotes([tasks.decorate(t)])[0], values: { ...t, ...values, assigned_to: Number(req.body.assigned_to) }, errors, people });
  db.prepare('UPDATE tasks SET title = ?, details = ?, due_on = ?, assigned_to = ? WHERE id = ?')
    .run(values.title, values.details || null, values.due_on || null, to.id, t.id);
  if (to.id !== t.assigned_to) db.prepare('UPDATE tasks SET seen_at = NULL WHERE id = ?').run(t.id);
  flash(req, 'ok', 'Task saved.');
  res.redirect('/admin/tasks');
});

// The person who assigned it (or manages that person) can also tick it off or reopen it.
router.post('/admin/tasks/:id/done', assign, (req, res) => {
  const t = load(req, res);
  if (!t) return;
  if (t.done_at) db.prepare('UPDATE tasks SET done_at = NULL, done_note = NULL, seen_at = NULL WHERE id = ?').run(t.id);
  else db.prepare('UPDATE tasks SET done_at = ?, done_note = ? WHERE id = ?').run(new Date().toISOString(), `Marked done by ${req.user.display_name}`, t.id);
  res.redirect('/admin/tasks' + (req.body.show ? '?show=' + encodeURIComponent(req.body.show) : ''));
});

// A manager can answer in the same thread of updates.
router.post('/admin/tasks/:id/note', assign, (req, res) => {
  const t = load(req, res);
  if (!t) return;
  const note = clean(req.body.note, 500);
  if (note && !tasks.sameAsLast(t.id, req.user.id, note)) {
    db.prepare('INSERT INTO task_notes (task_id, user_id, status, body, created_at) VALUES (?, ?, NULL, ?, ?)').run(t.id, req.user.id, note, new Date().toISOString());
    if (t.assigned_to !== req.user.id) db.prepare('UPDATE tasks SET seen_at = NULL WHERE id = ?').run(t.id);   // a note from the manager makes it new again
    if (t.assigned_to !== req.user.id) push.notify([t.assigned_to], 'task_assigned', { title: `Note on: ${t.title}`, body: `${req.user.display_name}: "${note}"`, url: `/tasks#t${t.id}` });
    flash(req, 'ok', 'Note added.');
  }
  res.redirect(`/admin/tasks/${t.id}`);
});

router.post('/admin/tasks/:id/delete', assign, (req, res) => {
  const t = load(req, res);
  if (!t) return;
  db.prepare('DELETE FROM task_notes WHERE task_id = ?').run(t.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  activity.log(req.user, 'Task removed', `"${t.title}" for ${t.to_name}`);
  flash(req, 'ok', `Task "${t.title}" deleted.`);
  res.redirect(req.body.back === 'mine' ? '/tasks' : `/admin/tasks${/^(open|done|all)$/.test(String(req.body.show || '')) ? '?show=' + req.body.show : ''}`);
});

module.exports = router;
