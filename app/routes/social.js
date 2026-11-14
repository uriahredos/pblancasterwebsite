'use strict';
// More of the community side: shout-outs, birthdays and anniversaries, events, the photo wall, branch pages.
const express = require('express');
const path = require('path');
const db = require('../db');
const access = require('../permissions');
const uploads = require('../uploads');
const activity = require('../activity');
const push = require('../push');
const { requireLogin, requirePerm, verifyCsrf, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate } = require('../util');

const router = express.Router();
const notFound = (res) => res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
const isId = (v) => /^\d+$/.test(String(v || ''));
const LISTED = '(u.active = 1 OR u.in_directory = 1)';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** "14:30" -> "2:30 PM" */
const clock = (hm) => { const m = /^(\d{2}):(\d{2})$/.exec(hm || ''); return m ? `${Number(m[1]) % 12 || 12}:${m[2]} ${Number(m[1]) < 12 ? 'AM' : 'PM'}` : ''; };

// ---- Shout-outs -------------------------------------------------------------------

const SHOUT = `SELECT s.*, f.display_name AS from_name, f.photo_path AS from_photo, t.display_name AS to_name, t.photo_path AS to_photo,
    (SELECT COUNT(*) FROM shoutout_cheers c JOIN users x ON x.id = c.user_id WHERE c.shoutout_id = s.id AND x.active = 1) AS cheers,
    EXISTS (SELECT 1 FROM shoutout_cheers c WHERE c.shoutout_id = s.id AND c.user_id = @me) AS cheered
  FROM shoutouts s JOIN users f ON f.id = s.from_user JOIN users t ON t.id = s.to_user`;
const recentShoutouts = (me, limit = 3) => db.prepare(`${SHOUT} ORDER BY s.id DESC LIMIT @limit`).all({ me, limit });
const shoutoutsFor = (me, userId, limit = 20) => db.prepare(`${SHOUT} WHERE s.to_user = @u ORDER BY s.id DESC LIMIT @limit`).all({ me, u: userId, limit });
const everyone = () => db.prepare(`SELECT u.id, u.display_name, b.name AS branch FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE ${LISTED} ORDER BY u.display_name COLLATE NOCASE`).all();

function shoutPage(req, res, extra = {}) {
  const to = isId(req.query.to) ? Number(req.query.to) : null;
  res.status(extra.errors ? 400 : 200).render('shoutouts', {
    title: 'Shout-outs', rows: db.prepare(`${SHOUT} ORDER BY s.id DESC LIMIT 60`).all({ me: req.user.id }), people: everyone().filter((p) => p.id !== req.user.id),
    errors: [], values: { to_user: to }, mod: access.can(req.user, 'forum.moderate'), ...extra,
  });
}
router.get('/shoutouts', requireLogin, (req, res) => shoutPage(req, res));

router.post('/shoutouts', requireLogin, (req, res) => {
  const values = { to_user: isId(req.body.to_user) ? Number(req.body.to_user) : null, message: clean(req.body.message, 400) };
  const target = values.to_user ? db.prepare(`SELECT u.id, u.display_name FROM users u WHERE u.id = ? AND ${LISTED}`).get(values.to_user) : null;
  const errors = [];
  if (!target) errors.push('Choose who the shout-out is for.');
  else if (target.id === req.user.id) errors.push('A shout-out is for someone else.');
  if (!values.message) errors.push('Say what they did.');
  if (!errors.length && db.prepare('SELECT COUNT(*) AS n FROM shoutouts WHERE from_user = ? AND created_at > ?').get(req.user.id, new Date(Date.now() - 86400000).toISOString()).n >= 20) errors.push('That is a lot of shout-outs for one day. Save some for tomorrow.');
  if (errors.length) return shoutPage(req, res, { errors, values });
  db.prepare('INSERT INTO shoutouts (from_user, to_user, message, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, target.id, values.message, new Date().toISOString());
  push.notify([target.id], 'shoutout', { title: `${req.user.display_name} gave you a shout-out`, body: values.message, url: `/people/${target.id}#shoutouts` });
  flash(req, 'ok', `Shout-out sent to ${target.display_name}.`);
  res.redirect('/shoutouts');
});

router.post('/shoutouts/:id/cheer', requireLogin, (req, res) => {
  const s = isId(req.params.id) ? db.prepare('SELECT id, to_user FROM shoutouts WHERE id = ?').get(req.params.id) : null;
  if (s) {
    const had = db.prepare('DELETE FROM shoutout_cheers WHERE shoutout_id = ? AND user_id = ?').run(s.id, req.user.id).changes;
    if (!had) db.prepare('INSERT INTO shoutout_cheers (shoutout_id, user_id) VALUES (?, ?)').run(s.id, req.user.id);
  }
  res.redirect(req.body.back === 'home' ? '/#shoutouts' : req.body.back === 'person' && s ? `/people/${s.to_user}#shoutouts` : `/shoutouts#s${req.params.id}`);
});

// Whoever wrote it, or a moderator, can take one down.
router.post('/shoutouts/:id/delete', requireLogin, (req, res) => {
  const s = isId(req.params.id) ? db.prepare('SELECT s.*, t.display_name AS to_name FROM shoutouts s JOIN users t ON t.id = s.to_user WHERE s.id = ?').get(req.params.id) : null;
  if (!s) return res.redirect('/shoutouts');
  if (s.from_user !== req.user.id && !access.can(req.user, 'forum.moderate')) return forbidden(res);
  db.prepare('DELETE FROM shoutouts WHERE id = ?').run(s.id);
  if (s.from_user !== req.user.id) activity.log(req.user, 'Shout-out removed', `one for ${s.to_name}`);
  flash(req, 'ok', 'Shout-out removed.');
  res.redirect('/shoutouts');
});

// ---- Birthdays and work anniversaries -------------------------------------------------

/**
 * Birthdays and work anniversaries in this person's branch over the coming week (today first).
 * Birthdays are a day and month only; anniversaries come from the start date, from one year on.
 */
function thisWeek(user, today = localDate()) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const year = Number(today.slice(0, 4));
  const people = db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.birthday, u.started_on FROM users u WHERE ${LISTED} AND u.branch_id = ? AND (u.birthday IS NOT NULL OR u.started_on IS NOT NULL)`).all(user.branch_id);
  const out = [];
  days.forEach((ymd, offset) => {
    const md = ymd.slice(5);
    const when = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : `${WEEKDAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]}, ${MONTHS[Number(md.slice(0, 2)) - 1].slice(0, 3)} ${Number(md.slice(3))}`;
    for (const p of people) {
      if (p.birthday === md) out.push({ ...p, kind: 'birthday', when, today: offset === 0, year: Number(ymd.slice(0, 4)), text: 'Birthday' });
      const years = p.started_on && p.started_on.slice(5) === md ? Number(ymd.slice(0, 4)) - Number(p.started_on.slice(0, 4)) : 0;
      if (years >= 1) out.push({ ...p, kind: 'anniversary', when, today: offset === 0, year: Number(ymd.slice(0, 4)), text: `${years} ${years === 1 ? 'year' : 'years'} with us` });
    }
  });
  const count = db.prepare('SELECT COUNT(*) AS n FROM celebrations c JOIN users x ON x.id = c.from_user WHERE c.user_id = ? AND c.kind = ? AND c.year = ? AND x.active = 1');
  const mine = db.prepare('SELECT 1 FROM celebrations WHERE user_id = ? AND kind = ? AND year = ? AND from_user = ?');
  return out.map((o) => ({ ...o, wishes: count.get(o.id, o.kind, o.year).n, wished: Boolean(mine.get(o.id, o.kind, o.year, user.id)), mine: o.id === user.id })).filter(() => year);
}

router.post('/celebrate', requireLogin, (req, res) => {
  const kind = req.body.kind === 'anniversary' ? 'anniversary' : 'birthday';
  const hit = thisWeek(req.user).find((o) => String(o.id) === String(req.body.user_id) && o.kind === kind);
  if (hit && hit.id !== req.user.id) db.prepare('INSERT OR IGNORE INTO celebrations (user_id, kind, year, from_user) VALUES (?, ?, ?, ?)').run(hit.id, kind, hit.year, req.user.id);
  res.redirect('/#thisweek');
});

// ---- Events ------------------------------------------------------------------------------

// An event is for one branch, or for every branch.
const FOR_BRANCH = '(e.branch_id IS NULL OR e.branch_id = @branch)';
function decorateEvent(e, me, today) {
  const d = new Date(`${e.event_date}T12:00:00Z`);
  const days = Math.round((d - new Date(`${today}T12:00:00Z`)) / 86400000);
  const going = db.prepare(`SELECT g.bringing, u.id, u.display_name, u.photo_path FROM event_signups g JOIN users u ON u.id = g.user_id WHERE g.event_id = ? AND u.active = 1 ORDER BY g.created_at`).all(e.id);
  return { ...e, going, mine: going.find((g) => g.id === me) || null, time: clock(e.event_time), weekday: WEEKDAYS[d.getUTCDay()], month: MONTHS[d.getUTCMonth()].slice(0, 3), day: d.getUTCDate(),
    when: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 ? `In ${days} days` : '', past: days < 0 };
}
const EVENT = `SELECT e.*, u.display_name AS by_name, b.name AS branch FROM events e JOIN users u ON u.id = e.created_by LEFT JOIN branches b ON b.id = e.branch_id`;
function upcomingEvents(user, limit = 50, today = localDate()) {
  return db.prepare(`${EVENT} WHERE ${FOR_BRANCH} AND e.event_date >= @today ORDER BY e.event_date, e.event_time, e.id LIMIT @limit`).all({ branch: user.branch_id, today, limit }).map((e) => decorateEvent(e, user.id, today));
}
const mayRun = (user, e) => e.created_by === user.id || (access.can(user, 'events.post') && (e.branch_id === null ? user.allBranches : e.branch_id === user.branch_id || user.allBranches));

function eventsPage(req, res, extra = {}) {
  const today = localDate();
  const past = db.prepare(`${EVENT} WHERE ${FOR_BRANCH} AND e.event_date < @today ORDER BY e.event_date DESC LIMIT 6`).all({ branch: req.user.branch_id, today }).map((e) => decorateEvent(e, req.user.id, today));
  res.status(extra.errors ? 400 : 200).render('events', {
    title: 'Events', upcoming: upcomingEvents(req.user).map((e) => ({ ...e, mayRun: mayRun(req.user, e) })), past, errors: [], values: {},
    canPost: access.can(req.user, 'events.post'), canReachAll: req.user.allBranches && db.prepare('SELECT COUNT(*) AS n FROM branches').get().n > 1, ...extra,
  });
}
router.get('/events', requireLogin, (req, res) => eventsPage(req, res));

router.post('/events', requirePerm('events.post'), (req, res) => {
  const values = { title: clean(req.body.title, 120), details: clean(req.body.details, 2000), event_date: clean(req.body.event_date, 10), event_time: clean(req.body.event_time, 5),
    location: clean(req.body.location, 120), potluck: req.body.potluck === '1' ? 1 : 0, reach: req.body.reach };
  const errors = [];
  if (!values.title) errors.push('Give the event a name.');
  if (!isYmd(values.event_date) || values.event_date < localDate()) errors.push('Choose a date, today or later.');
  if (values.event_time && !/^\d{2}:\d{2}$/.test(values.event_time)) errors.push('The time does not look right.');
  if (errors.length) return eventsPage(req, res, { errors, values });
  const branchId = req.user.allBranches && values.reach === 'everyone' ? null : req.user.branch_id;
  db.prepare('INSERT INTO events (title, details, event_date, event_time, location, branch_id, potluck, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(values.title, values.details || null, values.event_date, values.event_time || null, values.location || null, branchId, values.potluck, req.user.id, new Date().toISOString());
  activity.log(req.user, 'Event posted', values.title);
  flash(req, 'ok', 'Event posted.');
  res.redirect('/events');
});

const visibleEvent = (req) => (isId(req.params.id) ? db.prepare(`SELECT e.* FROM events e WHERE e.id = @id AND ${FOR_BRANCH}`).get({ id: req.params.id, branch: req.user.branch_id }) : null);

// "I'm in" (with what you are bringing, for a potluck), or change it, or back out.
router.post('/events/:id/signup', requireLogin, (req, res) => {
  const e = visibleEvent(req);
  if (!e) return notFound(res);
  if (e.event_date >= localDate()) {
    if (req.body.out === '1') db.prepare('DELETE FROM event_signups WHERE event_id = ? AND user_id = ?').run(e.id, req.user.id);
    else db.prepare(`INSERT INTO event_signups (event_id, user_id, bringing, created_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT(event_id, user_id) DO UPDATE SET bringing = excluded.bringing`).run(e.id, req.user.id, clean(req.body.bringing, 120) || null, new Date().toISOString());
  }
  res.redirect(`/events#e${e.id}`);
});

router.post('/events/:id/delete', requireLogin, (req, res) => {
  const e = visibleEvent(req);
  if (!e) return res.redirect('/events');
  if (!mayRun(req.user, e)) return forbidden(res);
  db.prepare('DELETE FROM events WHERE id = ?').run(e.id);
  activity.log(req.user, 'Event removed', e.title);
  flash(req, 'ok', 'Event removed.');
  res.redirect('/events');
});

// ---- The photo wall ---------------------------------------------------------------------

const WALL = `SELECT p.*, u.display_name, u.photo_path AS user_photo, b.name AS branch,
    (SELECT COUNT(*) FROM wall_likes l JOIN users x ON x.id = l.user_id WHERE l.photo_id = p.id AND x.active = 1) AS likes,
    EXISTS (SELECT 1 FROM wall_likes l WHERE l.photo_id = p.id AND l.user_id = @me) AS liked
  FROM wall_photos p JOIN users u ON u.id = p.user_id LEFT JOIN branches b ON b.id = u.branch_id`;
const recentPhotos = (me, limit = 4) => db.prepare(`${WALL} ORDER BY p.id DESC LIMIT @limit`).all({ me, limit });
const post = requirePerm('forum.use');
const PER_PAGE = 30;

function wallPage(req, res, extra = {}) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = db.prepare(`${WALL} ORDER BY p.id DESC LIMIT @n OFFSET @o`).all({ me: req.user.id, n: PER_PAGE + 1, o: (page - 1) * PER_PAGE });
  res.status(extra.errors ? 400 : 200).render('wall', {
    title: 'Photos', wide: true, rows: rows.slice(0, PER_PAGE), page, more: rows.length > PER_PAGE, errors: [], values: {},
    canPost: access.can(req.user, 'forum.use'), mod: access.can(req.user, 'forum.moderate'), ...extra,
  });
}
router.get('/photos', requireLogin, (req, res) => wallPage(req, res));

router.post('/photos', post, uploads.photos('photos', 6), verifyCsrf, (req, res) => {
  const drop = () => req.files.forEach((f) => uploads.remove(f.filename));
  const caption = clean(req.body.caption, 200);
  const errors = [];
  if (req.photoError) errors.push(req.photoError);
  else if (!req.files.length) errors.push('Choose at least one photo.');
  else if (req.files.some((f) => !uploads.looksLikeImage(f.path))) errors.push('Photos must be JPEG, PNG, WebP or GIF images.');
  if (errors.length) { drop(); return wallPage(req, res, { errors, values: { caption } }); }
  const add = db.prepare('INSERT INTO wall_photos (user_id, path, caption, created_at) VALUES (?, ?, ?, ?)');
  db.transaction(() => { for (const f of req.files) add.run(req.user.id, f.filename, caption || null, new Date().toISOString()); })();
  flash(req, 'ok', req.files.length === 1 ? 'Photo posted.' : `${req.files.length} photos posted.`);
  res.redirect('/photos');
});

router.get('/wall/photo/:id', requireLogin, (req, res) => {
  const row = isId(req.params.id) ? db.prepare('SELECT path FROM wall_photos WHERE id = ?').get(req.params.id) : null;
  if (!row) return notFound(res);
  res.sendFile(path.basename(row.path), { root: uploads.uploadDir, headers: { 'Cache-Control': 'private, max-age=86400' } }, (err) => { if (err && !res.headersSent) notFound(res); });
});

router.post('/photos/:id/like', requireLogin, (req, res) => {
  const p = isId(req.params.id) ? db.prepare('SELECT id FROM wall_photos WHERE id = ?').get(req.params.id) : null;
  if (p) {
    const had = db.prepare('DELETE FROM wall_likes WHERE photo_id = ? AND user_id = ?').run(p.id, req.user.id).changes;
    if (!had) db.prepare('INSERT INTO wall_likes (photo_id, user_id) VALUES (?, ?)').run(p.id, req.user.id);
  }
  res.redirect(`/photos${isId(req.body.page) && Number(req.body.page) > 1 ? '?page=' + Number(req.body.page) : ''}#w${req.params.id}`);
});

router.post('/photos/:id/delete', requireLogin, (req, res) => {
  const p = isId(req.params.id) ? db.prepare('SELECT p.*, u.display_name FROM wall_photos p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(req.params.id) : null;
  if (!p) return res.redirect('/photos');
  if (p.user_id !== req.user.id && !access.can(req.user, 'forum.moderate')) return forbidden(res);
  db.prepare('DELETE FROM wall_photos WHERE id = ?').run(p.id);
  uploads.remove(p.path);
  if (p.user_id !== req.user.id) activity.log(req.user, 'Photo removed', `one posted by ${p.display_name}`);
  flash(req, 'ok', 'Photo removed.');
  res.redirect('/photos');
});

// ---- Branch pages ------------------------------------------------------------------------

router.get('/branches', requireLogin, (req, res) => {
  const rows = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND ${LISTED}) AS people FROM branches b ORDER BY b.name COLLATE NOCASE`).all();
  if (rows.length === 1) return res.redirect(`/branches/${rows[0].id}`);
  res.render('branches', { title: 'Branches', rows });
});

router.get('/branches/photo/:id', requireLogin, (req, res) => {
  const row = isId(req.params.id) ? db.prepare('SELECT photo_path FROM branches WHERE id = ?').get(req.params.id) : null;
  if (!row || !row.photo_path) return notFound(res);
  res.sendFile(path.basename(row.photo_path), { root: uploads.uploadDir, headers: { 'Cache-Control': 'private, max-age=86400' } }, (err) => { if (err && !res.headersSent) notFound(res); });
});

// The people who keep a branch's page: anyone who can see every branch, or whoever manages people in that branch.
const mayEditBranch = (user, b) => user.allBranches || (user.branch_id === b.id && user.scope === 'all' && access.can(user, 'users.manage'));
const getBranch = (id) => (isId(id) ? db.prepare('SELECT * FROM branches WHERE id = ?').get(id) : null);

function branchPage(req, res, b, extra = {}) {
  const people = db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.job_title, u.department FROM users u WHERE u.branch_id = ? AND ${LISTED} ORDER BY u.display_name COLLATE NOCASE`).all(b.id);
  const groups = new Map();
  for (const p of people) { const k = p.department || 'Team'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  // Management first, then the rest by name; people with no department last.
  const order = [...groups.keys()].sort((x, y) => (x === 'Management' ? -1 : y === 'Management' ? 1 : x === 'Team' ? 1 : y === 'Team' ? -1 : x.localeCompare(y)));
  res.status(extra.errors ? 400 : 200).render('branch', {
    title: `${b.name} branch`, wide: true, b, people, groups: order.map((k) => ({ name: k, people: groups.get(k) })), canEdit: mayEditBranch(req.user, b), errors: [], editing: false,
    many: db.prepare('SELECT COUNT(*) AS n FROM branches').get().n > 1,
    shouts: db.prepare(`${SHOUT} WHERE t.branch_id = @b ORDER BY s.id DESC LIMIT 4`).all({ me: req.user.id, b: b.id }),
    photos: db.prepare(`${WALL} WHERE u.branch_id = @b ORDER BY p.id DESC LIMIT 8`).all({ me: req.user.id, b: b.id }),
    events: db.prepare(`${EVENT} WHERE (e.branch_id = @b OR e.branch_id IS NULL) AND e.event_date >= @today ORDER BY e.event_date LIMIT 4`).all({ b: b.id, today: localDate() }).map((e) => decorateEvent(e, req.user.id, localDate())),
    ...extra,
  });
}
router.get('/branches/:id', requireLogin, (req, res) => {
  const b = getBranch(req.params.id);
  if (!b) return notFound(res);
  branchPage(req, res, b, { editing: req.query.edit === '1' && mayEditBranch(req.user, b) });
});

router.post('/branches/:id', requireLogin, uploads.photos('photo', 1), verifyCsrf, (req, res) => {
  const b = getBranch(req.params.id);
  const file = req.files[0] || null;
  const drop = () => { if (file) uploads.remove(file.filename); };
  if (!b) { drop(); return notFound(res); }
  if (!mayEditBranch(req.user, b)) { drop(); return forbidden(res); }
  const values = { address: clean(req.body.address, 200), phone: clean(req.body.phone, 30), about: clean(req.body.about, 1500) };
  const errors = [];
  if (values.phone && !/^[0-9 ()+.x-]{7,30}$/.test(values.phone)) errors.push('The phone number does not look right.');
  if (req.photoError) errors.push(req.photoError);
  else if (file && !uploads.looksLikeImage(file.path)) errors.push('The photo must be a JPEG, PNG, WebP or GIF image.');
  if (errors.length) { drop(); return branchPage(req, res, { ...b, ...values }, { errors, editing: true }); }
  const photo = file ? file.filename : req.body.remove_photo === '1' ? null : b.photo_path;
  db.prepare('UPDATE branches SET address = ?, phone = ?, about = ?, photo_path = ? WHERE id = ?').run(values.address || null, values.phone || null, values.about || null, photo, b.id);
  if (b.photo_path && b.photo_path !== photo) uploads.remove(b.photo_path);
  activity.log(req.user, 'Branch page edited', b.name);
  flash(req, 'ok', 'Branch page saved.');
  res.redirect(`/branches/${b.id}`);
});

module.exports = router;
Object.assign(module.exports, { recentShoutouts, shoutoutsFor, thisWeek, upcomingEvents, recentPhotos, MONTHS });
