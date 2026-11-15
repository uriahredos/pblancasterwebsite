'use strict';
const db = require('./db');
const { localDate, fmtDate } = require('./util');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const days = (from, to) => Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000);

/** Adds .overdue, .days and a plain "when" line such as "Due tomorrow" or "Overdue by 3 days". */
function decorate(t, today = localDate()) {
  t.days = t.due_on ? days(today, t.due_on) : null;
  t.overdue = !t.done_at && t.days !== null && t.days < 0;
  if (t.done_at) t.when = 'Done';
  else if (t.days === null) t.when = 'No due date';
  else if (t.days < 0) t.when = `Overdue by ${-t.days} ${t.days === -1 ? 'day' : 'days'} (was due ${fmtDate(t.due_on)})`;
  else if (t.days === 0) t.when = 'Due today';
  else if (t.days === 1) t.when = 'Due tomorrow';
  else if (t.days < 7) t.when = `Due ${WEEKDAYS[new Date(t.due_on + 'T12:00:00Z').getUTCDay()]}, ${fmtDate(t.due_on)}`;
  else t.when = `Due ${fmtDate(t.due_on)}`;
  return t;
}

const ORDER = 't.due_on IS NULL, t.due_on, t.id';

/** Where an open task stands. "Finished" is not in this list: finishing a task closes it (done_at). */
const STATUSES = { new: 'Not started', progress: 'In progress', waiting: 'Waiting' };
const statusName = (t) => (t.done_at ? 'Finished' : STATUSES[t.status] || STATUSES.new);

/** Attaches each task's updates (oldest first) as .notes, and its status name as .statusName. */
function withNotes(list) {
  if (!list.length) return list;
  const rows = db.prepare(
    `SELECT n.*, u.display_name AS author FROM task_notes n JOIN users u ON u.id = n.user_id
     WHERE n.task_id IN (${list.map((t) => Number(t.id)).join(',')}) ORDER BY n.id`).all();
  for (const t of list) { t.notes = rows.filter((n) => n.task_id === t.id); t.statusName = statusName(t); }
  return list;
}

function openFor(userId, limit = 200) {
  const today = localDate();
  return db.prepare(
    `SELECT t.*, b.display_name AS by_name FROM tasks t JOIN users b ON b.id = t.assigned_by
     WHERE t.assigned_to = ? AND t.done_at IS NULL ORDER BY ${ORDER} LIMIT ?`).all(userId, limit).map((t) => decorate(t, today))
    .map((t) => { t.statusName = statusName(t); return t; });
}
/** Open tasks the person has not looked at yet: these are what the bell counts. */
const newCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE assigned_to = ? AND done_at IS NULL AND seen_at IS NULL').get(userId).n;
/** The person has now seen their open tasks. */
const markSeen = (userId) => db.prepare('UPDATE tasks SET seen_at = ? WHERE assigned_to = ? AND done_at IS NULL AND seen_at IS NULL').run(new Date().toISOString(), userId).changes;
const openCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE assigned_to = ? AND done_at IS NULL').get(userId).n;

/** True when this person's newest note on the task is this same text, written in the last ten minutes. */
function sameAsLast(taskId, userId, body) {
  const last = db.prepare('SELECT user_id, body, created_at FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);
  return Boolean(last && body && last.user_id === userId && last.body === body && Date.now() - new Date(last.created_at).getTime() < 10 * 60000);
}

module.exports = { newCount, markSeen, sameAsLast, decorate, openFor, openCount, ORDER, STATUSES, statusName, withNotes };
