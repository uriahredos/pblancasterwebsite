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
  // Everything on this page that belongs to an office follows the office being looked at (see reach.js). In the
  // Corporate view, which is every office at once, that means the company's own posts and totals across the offices.
  const at = require('../reach').place(req.user);
  const all = require('./announcements').forUser(req.user);
  // Unread announcements lead the Announcements panel until read; after that the latest few stay listed.
  // Critical ones are always first on the page, read or not.
  const critical = all.filter((n) => n.critical).sort((x, y) => y.id - x.id);
  const notices = all.filter((n) => !n.read_at && !n.critical);
  const board = all.filter((n) => n.read_at && !n.critical).sort((x, y) => y.pinned - x.pinned || y.id - x.id).slice(0, 4);
  const myCerts = db.prepare('SELECT * FROM certifications WHERE user_id = ? AND expires_on IS NOT NULL').all(me)
    .map((c) => certs.decorate(c, today)).filter((c) => c.status === 'expired' || (c.status === 'soon' && c.days <= 30));

  const issues = newsletters.latest(req.user, 4);
  // Discussions: replies to threads this person follows, and the latest activity.
  const forum = can('forum.use') ? require('./forum') : null;
  const replies = forum ? forum.repliesFor(me) : [];
  const talk = forum ? forum.recent(me, 4) : [];


  // Training sessions on the calendar. Ones scheduled from a private request are left out.
  const upcoming = !can('training.submit') && !can('training.view') ? [] : db.prepare(
    `SELECT s.title, s.session_date, s.session_time, s.location FROM training_sessions s
     LEFT JOIN training_requests t ON t.id = s.request_id
     WHERE s.completed_at IS NULL AND s.session_date >= ? AND (t.id IS NULL OR t.is_private = 0) AND s.branch_id = ?
     ORDER BY s.session_date, s.session_time LIMIT 4`).all(today, at.office).map((s) => {
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
  if (!at.corporate && (can('stock.manage') || can('parts.view'))) {
    const low = require('../stock').lowCount(req.user.workBranch);
    branch.push({ label: 'Low stock', value: low, sub: low === 1 ? 'part at or below its minimum' : 'parts at or below their minimum', level: low ? 'warn' : '', url: '/admin/stock?low=1' });
  }
  if (can('tasks.assign')) {
    // Open tasks this person gave, or that belong to the people they look after.
    const given = db.prepare(`SELECT assigned_to, assigned_by, due_on FROM tasks WHERE done_at IS NULL
       ${ids ? `AND (assigned_by = ${Number(me)} OR assigned_to IN (${ids.map(Number).join(',')}))` : ''}`).all();
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

  // Office at a glance: a few quick facts about the office that fit anyone, then the things waiting on this
  // person because of what they run. A number that is zero and needs nothing from them is left out,
  // so someone who never touches parts or trucks is not shown empty parts and truck boxes.
  const waiting = branch.filter((t) => Number(t.value) > 0);
  branch.length = 0;
  const office = at.office ? db.prepare('SELECT id, name FROM branches WHERE id = ?').get(at.office) : null;
  const inOffice = at.corporate ? db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1 OR in_directory = 1').get().n
    : db.prepare('SELECT COUNT(*) AS n FROM users WHERE branch_id = ? AND (active = 1 OR in_directory = 1)').get(at.office).n;
  branch.push({ label: 'People', value: inOffice, sub: at.corporate ? 'across every office' : office ? `in the ${office.name} office` : 'in your office', level: '', url: office ? `/branches/${office.id}` : '/people' });
  const unread = res.locals.badges.notices;
  branch.push({ label: 'Announcements', value: unread, sub: unread ? 'for you to read' : 'all read', level: unread ? 'warn' : '', url: '/notices' });
  const homeWeek = social.thisWeek(req.user, today);   // worked out once, used here and for the panel further down
  const mineWeek = at.corporate ? homeWeek : homeWeek.filter((o) => o.branch_id === at.office);
  branch.push({ label: 'This week', value: mineWeek.length, sub: mineWeek.length === 1 ? 'birthday or anniversary here' : 'birthdays and anniversaries here', level: '', url: '/#thisweek' });
  const soon = upcoming.length;
  branch.push({ label: 'Coming up', value: soon, sub: soon === 1 ? 'event or training session' : 'events and training sessions', level: '', url: '/events' });
  const newFaces = db.prepare(`SELECT COUNT(*) AS n FROM welcomes w JOIN users u ON u.id = w.user_id WHERE ${at.corporate ? '1 = 1' : 'u.branch_id = @office'} AND u.active = 1 AND w.created_at >= @since`).get({ office: at.office, since: new Date(Date.now() - 14 * 86400000).toISOString() }).n;
  if (newFaces) branch.push({ label: 'New faces', value: newFaces, sub: newFaces === 1 ? 'person to welcome' : 'people to welcome', level: '', url: '/#welcome' });
  branch.push(...waiting);

  // The jobs someone runs have their own page (Manage); here it only matters whether they run anything.
  const manage = require('../manage').has(req.user) ? [1] : [];

  // First-time checklist: shown until the person puts it away or has done the three things the site can see.
  const help = require('../help');
  const hasPasskey = db.prepare('SELECT 1 FROM passkeys WHERE user_id = ?').get(me) !== undefined;
  const hasAlerts = db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(me) !== undefined;
  const steps = [
    { key: 'photo', done: Boolean(req.user.photo_path), url: '/profile', label: 'Add your photo' },
    { key: 'alerts', done: hasAlerts, url: '/settings/notifications', label: 'Turn on alerts on this phone or computer' },
    { key: 'passkey', done: hasPasskey, url: '/account/password#face-id', label: 'Set up Face ID or fingerprint' },
    { key: 'app', done: false, url: '/help/get-the-app-and-alerts', label: 'Put the site on your phone\'s home screen' },
  ];
  const welcome = req.user.welcomed_at || steps.slice(0, 3).every((s) => s.done) ? null : {
    steps, first: help.get(req.user, 'find-your-way-around'),
    guides: manage.length ? ['add-a-person', 'edit-a-person', 'assign-a-task', 'keep-the-on-call-schedule', 'post-an-announcement', 'parts-requests', 'inventory-overview']
      .map((s) => help.get(req.user, s)).filter(Boolean).slice(0, 5) : [],
  };

  // The person's own open things sit under the office numbers. Tasks have their own list, and a zero is left out.
  const mine = status.filter((t) => t.label !== 'Tasks' && (t.warn || !/^(0|None)$/.test(t.value)))
    .map((t) => ({ ...t, label: `My ${t.label.charAt(0).toLowerCase()}${t.label.slice(1)}` }));
  // The newsletter gets its full cover only while the issue is new; after that it is a single line.
  const issueIsNew = !!issues[0] && (issues[0].issue_month === today.slice(0, 7) || String(issues[0].created_at || '') >= new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10));

  const now = new Date();
  const dateLine = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(now);
  // Only the office being looked at: its own people on call today. The rest of the market is on the On call page.
  const onCall = require('../oncall').covering([at.office].filter(Boolean), today).map((p) => ({ ...p, tel: String(p.phone || '').replace(/[^0-9+]/g, '') }));
  onCall.sort((x, y) => (x.role === 'backup') - (y.role === 'backup'));
  const feed = require('../feed');
  const around = feed.recent(req.user, 8); const company = feed.company(req.user, today);
  const homeShouts = social.recentShoutouts(req.user, 3);
  res.render('home', {
    onCall, onCallOffices: new Set(onCall.map((p) => p.branch_id)).size, around, company, slides: feed.slides(req.user, { around, shouts: homeShouts, week: homeWeek, spot: company.spot }),
    shouts: homeShouts, thisWeek: homeWeek, wallPhotos: social.recentPhotos(me, 4),
    dailyCard: require('../daily').card(me), welcomes: require('./community').recentWelcomes(me),
    profileEmpty: !welcome && !req.user.photo_path && !req.user.about && !req.user.skills, welcome,
    title: 'Home', wide: true, hasPasskey: hasPasskey || Boolean(welcome), branch, branchTitle: 'Office at a glance', officeId: office ? office.id : null, critical, notices, board, replies, talk, myCerts, issue: issues[0] || null, issueIsNew, upcoming, mine, dateLine,
    categories: require('./announcements').CATEGORIES,
  });
});

// Putting the first-time checklist away for good.
router.post('/welcome/done', requireLogin, (req, res) => {
  db.prepare('UPDATE users SET welcomed_at = ? WHERE id = ? AND welcomed_at IS NULL').run(new Date().toISOString(), req.user.id);
  res.redirect('/');
});

// Manage: everything this person runs, grouped, with what is waiting.
router.get('/manage', requireLogin, (req, res) => {
  const lib = require('../manage');
  if (!lib.has(req.user)) return require('../auth').forbidden(res);
  res.render('manage', { title: 'Manage', wide: true, sections: lib.sections(req.user, res.locals.badges) });
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

// The activity feed in full: everything on the home page's short list and further back, with shout-outs too.
const FEED_KINDS = { talk: 'Discussions', photo: 'Photos', event: 'Events', shout: 'Shout-outs', hire: 'New people' };
router.get('/feed', requireLogin, (req, res) => {
  const show = Object.prototype.hasOwnProperty.call(FEED_KINDS, req.query.show) ? req.query.show : '';
  const all = require('../feed').recent(req.user, 400, { full: true });
  const kinds = Object.keys(FEED_KINDS).filter((k) => all.some((i) => i.kind === k)).map((k) => ({ key: k, label: FEED_KINDS[k], n: all.filter((i) => i.kind === k).length }));
  res.render('feed', { title: 'Activity feed', items: (show ? all.filter((i) => i.kind === show) : all).slice(0, 100), kinds, show, total: all.length });
});

module.exports = router;
