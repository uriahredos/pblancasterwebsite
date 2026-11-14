'use strict';
const express = require('express');
const QRCode = require('qrcode');
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

// A printable sign with a QR code that opens this site. The address is BASE_URL when that
// is set, otherwise whatever address the page was opened at.
router.get('/poster', requireLogin, async (req, res, next) => {
  try {
    const url = process.env.BASE_URL ? config.baseUrl : `${req.protocol}://${req.get('host')}`;
    const qr = await QRCode.toString(`${url}/`, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 });
    res.render('poster', { title: 'QR code sign', url, qr });
  } catch (err) { next(err); }
});

// Everything waiting on this person, as a page. On a phone this is the Alerts button in the
// bottom bar; on a computer the same list drops down from the bell.
router.get('/alerts', requireLogin, (req, res) => {
  res.render('alerts', { title: 'Alerts' });
});

// The home page, in the order people need it: critical announcements, the branch numbers for
// people who run things, this person's tasks, the form buttons, announcements, then what is
// coming up, where their own requests stand, the newsletter and discussions.
router.get('/', requireLogin, (req, res) => {
  const me = req.user.id;
  const can = (perm) => access.can(req.user, perm);
  const today = localDate();
  const all = require('./announcements').forUser(me);
  // Unread announcements lead the Announcements panel until read; after that the latest few stay listed.
  // Critical ones are always first on the page, read or not.
  const critical = all.filter((n) => n.critical).sort((x, y) => y.id - x.id);
  const notices = all.filter((n) => !n.read_at && !n.critical);
  const board = all.filter((n) => n.read_at && !n.critical).sort((x, y) => y.pinned - x.pinned || y.id - x.id).slice(0, 4);
  const myCerts = db.prepare('SELECT * FROM certifications WHERE user_id = ? AND expires_on IS NOT NULL').all(me)
    .map((c) => certs.decorate(c, today)).filter((c) => c.status === 'expired' || (c.status === 'soon' && c.days <= 30));

  const issues = newsletters.latest(4);
  // Discussions: replies to threads this person follows, and the latest activity.
  const forum = can('forum.use') ? require('./forum') : null;
  const replies = forum ? forum.repliesFor(me) : [];
  const talk = forum ? forum.recent(me, 4) : [];


  // Training sessions on the calendar. Ones scheduled from a private request are left out.
  const upcoming = !can('training.submit') && !can('training.view') ? [] : db.prepare(
    `SELECT s.title, s.session_date, s.session_time, s.location FROM training_sessions s
     LEFT JOIN training_requests t ON t.id = s.request_id
     WHERE s.completed_at IS NULL AND s.session_date >= ? AND (t.id IS NULL OR t.is_private = 0) AND s.branch_id = ?
     ORDER BY s.session_date, s.session_time LIMIT 4`).all(today, req.user.branch_id).map((s) => {
    const d = ymdDate(s.session_date);
    const days = daysBetween(today, s.session_date);
    return { ...s, date: s.session_date, kind: 'Training', weekday: WEEKDAYS[d.getUTCDay()], month: MONTHS[d.getUTCMonth()], day: d.getUTCDate(), time: clock(s.session_time),
      when: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days` };
  });
  // Events share the "Coming up" list with training sessions, soonest first.
  const social = require('./social');
  for (const e of social.upcomingEvents(req.user, 4, today)) {
    upcoming.push({ title: e.title, date: e.event_date, kind: e.mine ? "You're in" : `${e.going.length} in`, url: `/events#e${e.id}`, weekday: e.weekday, month: e.month, day: e.day, time: e.time, location: e.location, when: e.when });
  }
  upcoming.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  upcoming.splice(5);

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

  if (res.locals.badges.tasks) {
    const late = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE assigned_to = ? AND done_at IS NULL AND due_on < ?').get(me, today).n;
    status.unshift({ label: 'Tasks', value: String(res.locals.badges.tasks), sub: late ? `${late} overdue` : 'to do', warn: late > 0, url: '/tasks' });
  }

  // For people who run things: the branch (or their own team) in a handful of numbers, each one
  // a link to the list behind it. A person only gets the numbers their profile lets them act on,
  // and a manager's numbers cover only the people assigned to them.
  const b = res.locals.badges;
  const ids = access.visibleUserIds(req.user);
  const scoped = (col) => (ids ? `AND ${col} IN (${ids.map(Number).join(',')})` : '');
  const branch = [];
  if (can('parts.manage')) {
    const late = db.prepare(
      `SELECT COUNT(*) AS n FROM parts_submissions WHERE action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered')
       AND needed_by IS NOT NULL AND needed_by < ? ${scoped('user_id')}`).get(today).n;
    branch.push({ label: 'Parts requests', value: b.requests, sub: !b.requests ? 'none open' : late ? `open · ${late} past the needed-by date` : 'open', level: late ? 'bad' : b.requests ? 'warn' : '', url: '/admin/requests' });
  }
  if (can('inspections.view')) {
    branch.push({ label: 'Truck problems', value: b.inspections, sub: b.inspections ? 'not fixed yet' : 'none waiting', level: b.inspections ? 'bad' : '', url: '/admin/inspections?show=open' });
  }
  if (can('stock.manage') || can('parts.view')) {
    const low = require('../stock').lowCount(req.user.workBranch);
    branch.push({ label: 'Low stock', value: low, sub: low === 1 ? 'part at or below its minimum' : 'parts at or below their minimum', level: low ? 'warn' : '', url: '/admin/stock?low=1' });
  }
  if (can('tasks.assign')) {
    const given = db.prepare('SELECT assigned_to, assigned_by, due_on FROM tasks WHERE done_at IS NULL').all()
      .filter((t) => t.assigned_by === me || access.canSee(req.user, t.assigned_to));
    const late = given.filter((t) => t.due_on && t.due_on < today).length;
    branch.push({ label: 'Overdue tasks', value: late, sub: `${given.length} open in all`, level: late ? 'bad' : '', url: late ? '/admin/tasks?show=overdue' : '/admin/tasks' });
  }
  if (can('certs.manage')) {
    branch.push({ label: 'Certifications', value: b.certs, sub: b.certs ? 'expired or expiring in 30 days' : 'all current', level: b.certs ? 'warn' : '', url: '/admin/certs?show=attention' });
  }
  if (can('parts.audit')) {
    const from = new Date(`${today}T12:00:00Z`); from.setUTCDate(from.getUTCDate() - 30);
    const fromYmd = from.toISOString().slice(0, 10);
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM parts_submissions WHERE created_local_date >= ? AND created_local_date <= ?
       AND audited_at IS NULL AND cancelled_at IS NULL ${scoped('user_id')}`).get(fromYmd, today).n;
    branch.push({ label: 'Audit', value: n, sub: n === 1 ? 'entry not checked, last 30 days' : 'entries not checked, last 30 days', level: '', url: `/admin/parts/audit?from=${fromYmd}&to=${today}&show=unchecked` });
  }

  const now = new Date();
  const dateLine = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(now);
  res.render('home', {
    shouts: social.recentShoutouts(me, 3), thisWeek: social.thisWeek(req.user, today), wallPhotos: social.recentPhotos(me, 4),
    dailyCard: require('../daily').card(me), welcomes: require('./community').recentWelcomes(me),
    profileEmpty: !req.user.photo_path && !req.user.about && !req.user.skills,
    title: 'Home', wide: true, hasPasskey: db.prepare('SELECT 1 FROM passkeys WHERE user_id = ?').get(me) !== undefined, branch, branchTitle: req.user.scope === 'team' ? 'Your team at a glance' : ids ? 'Office at a glance' : 'All offices at a glance', critical, notices, board, replies, talk, myCerts, issue: issues[0] || null, pastIssues: issues.slice(1), upcoming, status, dateLine,
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
  res.render('my', { title: 'My activity', parts, training, attended, myCerts, inspections });
  // They have now seen any status changes.
  db.prepare('UPDATE parts_submissions SET unseen = 0 WHERE user_id = ? AND unseen = 1').run(req.user.id);
  db.prepare('UPDATE training_requests SET unseen = 0 WHERE user_id = ? AND unseen = 1').run(req.user.id);
});

module.exports = router;
