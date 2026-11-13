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

function openFor(userId, limit = 200) {
  const today = localDate();
  return db.prepare(
    `SELECT t.*, b.display_name AS by_name FROM tasks t JOIN users b ON b.id = t.assigned_by
     WHERE t.assigned_to = ? AND t.done_at IS NULL ORDER BY ${ORDER} LIMIT ?`).all(userId, limit).map((t) => decorate(t, today));
}
const openCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE assigned_to = ? AND done_at IS NULL').get(userId).n;

module.exports = { decorate, openFor, openCount, ORDER };
