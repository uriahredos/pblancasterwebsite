'use strict';
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { canChange } = require('../changes');
const certs = require('../certs');
const { localDate } = require('../util');
const access = require('../permissions');
const config = require('../config');
const newsletters = require('./newsletters');

const router = express.Router();

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymdDate = (ymd) => new Date(`${ymd}T12:00:00Z`);
const daysBetween = (from, to) => Math.round((ymdDate(to) - ymdDate(from)) / 86400000);
/** "14:30" -> "2:30 PM" */
function clock(hm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hm || '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

// The home page is a dashboard: what needs attention, quick actions, the newsletter,
// the notice board, what is coming up, and where this person's own submissions stand.
router.get('/', requireLogin, (req, res) => {
  const me = req.user.id;
  const can = (perm) => access.can(req.user, perm);
  const today = localDate();
  const all = require('./announcements').forUser(me);
  // Unread announcements sit at the top until read; after that they stay on the notice board.
  // Critical ones are always first on the page, read or not.
  const critical = all.filter((n) => n.critical).sort((x, y) => y.id - x.id);
  const notices = all.filter((n) => !n.read_at && !n.critical);
  const board = all.filter((n) => n.read_at && !n.critical).sort((x, y) => y.pinned - x.pinned || y.id - x.id).slice(0, 4);
  const myCerts = db.prepare('SELECT * FROM certifications WHERE user_id = ? AND expires_on IS NOT NULL').all(me)
    .map((c) => certs.decorate(c, today)).filter((c) => c.status === 'expired' || (c.status === 'soon' && c.days <= 30));

  const issues = newsletters.latest(4);

  // Training sessions on the calendar. Ones scheduled from a private request are left out.
  const upcoming = !can('training.submit') && !can('training.view') ? [] : db.prepare(
    `SELECT s.title, s.session_date, s.session_time, s.location FROM training_sessions s
     LEFT JOIN training_requests t ON t.id = s.request_id
     WHERE s.completed_at IS NULL AND s.session_date >= ? AND (t.id IS NULL OR t.is_private = 0)
     ORDER BY s.session_date, s.session_time LIMIT 4`).all(today).map((s) => {
    const d = ymdDate(s.session_date);
    const days = daysBetween(today, s.session_date);
    return { ...s, weekday: WEEKDAYS[d.getUTCDay()], month: MONTHS[d.getUTCMonth()], day: d.getUTCDate(), time: clock(s.session_time),
      when: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days` };
  });

  // Where this person's own things stand.
  const status = [];
  if (can('parts.submit')) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM parts_submissions WHERE user_id = ? AND action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered')").get(me).n;
    status.push({ label: 'Parts requests', value: String(n), sub: n === 1 ? 'open request' : 'open requests' });
  }
  if (can('training.submit')) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM training_requests WHERE user_id = ? AND cancelled_at IS NULL AND status IN ('new','reviewed','scheduled')").get(me).n;
    status.push({ label: 'Training requests', value: String(n), sub: n === 1 ? 'open request' : 'open requests' });
  }
  if (can('inspections.submit')) {
    const last = db.prepare('SELECT MAX(created_local_date) AS d FROM inspections WHERE user_id = ?').get(me).d;
    const days = last ? daysBetween(last, today) : null;
    status.push({ label: 'Truck inspection', value: last ? (days <= 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`) : 'None',
      sub: last ? (days <= 0 ? 'last sent' : 'since the last one') : 'sent yet' });
  }
  const certCount = db.prepare('SELECT COUNT(*) AS n FROM certifications WHERE user_id = ?').get(me).n;
  if (certCount) status.push({ label: 'Certifications', value: String(certCount), sub: myCerts.length ? `${myCerts.length} need${myCerts.length === 1 ? 's' : ''} attention` : 'all current', warn: myCerts.length > 0 });

  const now = new Date();
  const dateLine = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(now);
  res.render('home', {
    title: 'Home', wide: true, critical, notices, board, myCerts, issue: issues[0] || null, pastIssues: issues.slice(1), upcoming, status, dateLine,
    categories: require('./announcements').CATEGORIES,
  });
});

router.get('/my', requireLogin, (req, res) => {
  const parts = db.prepare(
    `SELECT s.*, (SELECT group_concat(i.quantity || ' × ' || i.part_name, char(10))
                  FROM parts_items i WHERE i.submission_id = s.id) AS items
     FROM parts_submissions s WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 200`).all(req.user.id);
  const training = db.prepare(
    'SELECT * FROM training_requests WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  for (const row of parts) row.can_change = canChange(row, req.user, 'parts');
  for (const row of training) row.can_change = canChange(row, req.user, 'training');
  const attended = db.prepare(
    `SELECT t.title, t.session_date, t.location FROM training_attendance a JOIN training_sessions t ON t.id = a.session_id
     WHERE a.user_id = ? AND t.completed_at IS NOT NULL ORDER BY t.session_date DESC LIMIT 100`).all(req.user.id);
  const myCerts = db.prepare('SELECT * FROM certifications WHERE user_id = ? ORDER BY expires_on IS NULL, expires_on').all(req.user.id).map((c) => certs.decorate(c));
  const inspections = db.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM inspection_photos p WHERE p.inspection_id = i.id) AS photos FROM inspections i
     WHERE i.user_id = ? ORDER BY i.id DESC LIMIT 20`).all(req.user.id);
  res.render('my', { title: 'My submissions', parts, training, attended, myCerts, inspections });
  // They have now seen any status changes.
  db.prepare('UPDATE parts_submissions SET unseen = 0 WHERE user_id = ? AND unseen = 1').run(req.user.id);
  db.prepare('UPDATE training_requests SET unseen = 0 WHERE user_id = ? AND unseen = 1').run(req.user.id);
});

module.exports = router;
