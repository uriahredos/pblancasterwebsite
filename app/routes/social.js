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
// A shout-out belongs to the two offices involved: the giver's and the receiver's. Nobody else's home page carries it.
// (The Corporate view, which is every office at once, lists them all.)
const reach = require('../reach');
const involved = (user) => (reach.place(user).corporate ? '1 = 1' : '(f.branch_id = @office OR t.branch_id = @office)');
const recentShoutouts = (user, limit = 3) => db.prepare(`${SHOUT} WHERE ${involved(user)} ORDER BY s.id DESC LIMIT @limit`).all({ me: user.id, office: reach.place(user).office, limit });
const shoutoutsFor = (user, userId, limit = 20) => db.prepare(`${SHOUT} WHERE s.to_user = @u AND ${involved(user)} ORDER BY s.id DESC LIMIT @limit`).all({ me: user.id, office: reach.place(user).office, u: userId, limit });
/** May this person give `targetId` a shout-out? Anyone in their own office, or in another office of their market. */
const mayShout = (user, targetBranch) => Boolean(targetBranch) && reach.marketOffices(user.branch_id).includes(targetBranch);
const PICKER_MAX = 500;   // past this many people in the company, the "who is it for" list is your own office only

/**
 * Who can be picked for a shout-out: the person's own office first. People in other offices are listed too while the
 * whole company is small enough for one list; after that they are reached from their own page, which opens this form
 * with them already chosen (`chosenId`).
 */
function shoutPicker(user, chosenId) {
  const pick = (where, ...args) => db.prepare(`SELECT u.id, u.display_name, b.name AS branch FROM users u LEFT JOIN branches b ON b.id = u.branch_id
     WHERE ${LISTED} AND u.id <> ? AND ${where} ORDER BY u.display_name COLLATE NOCASE, u.id`).all(user.id, ...args);
  // Other offices of the same market, never further: a shout-out stays between the offices that know each other.
  const near = reach.marketOffices(user.branch_id).filter((id) => id !== user.branch_id).map(Number);
  const inMarket = near.length ? `u.branch_id IN (${near.join(',')})` : '0 = 1';
  const short = !near.length || db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${LISTED} AND ${inMarket}`).get().n <= PICKER_MAX;
  return {
    people: pick('u.branch_id IS ?', user.branch_id),
    away: short ? pick(inMarket) : chosenId ? pick(`${inMarket} AND u.id = ?`, chosenId) : [],
    elsewhere: !short,
  };
}

function shoutPage(req, res, extra = {}) {
  const to = isId(req.query.to) ? Number(req.query.to) : null;
  const values = extra.values || { to_user: to };
  res.status(extra.errors ? 400 : 200).render('shoutouts', {
    title: 'Shout-outs', rows: recentShoutouts(req.user, 60), ...shoutPicker(req.user, values.to_user),
    errors: [], values, modOf: (authorId) => access.moderates(req.user, 'forum.moderate', authorId), ...extra,
  });
}
router.get('/shoutouts', requireLogin, (req, res) => shoutPage(req, res));

router.post('/shoutouts', requireLogin, (req, res) => {
  const values = { to_user: isId(req.body.to_user) ? Number(req.body.to_user) : null, message: clean(req.body.message, 400) };
  const target = values.to_user ? db.prepare(`SELECT u.id, u.display_name, u.branch_id FROM users u WHERE u.id = ? AND ${LISTED}`).get(values.to_user) : null;
  const errors = [];
  if (!target) errors.push('Choose who the shout-out is for.');
  else if (target.id === req.user.id) errors.push('A shout-out is for someone else.');
  else if (!mayShout(req.user, target.branch_id)) errors.push('Shout-outs are for people in your own office or your market.');
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
  if (s.from_user !== req.user.id && !access.moderates(req.user, 'forum.moderate', s.from_user)) return forbidden(res);
  db.prepare('DELETE FROM shoutouts WHERE id = ?').run(s.id);
  if (s.from_user !== req.user.id) activity.log(req.user, 'Shout-out removed', `one for ${s.to_name}`);
  flash(req, 'ok', 'Shout-out removed.');
  res.redirect('/shoutouts');
});

// ---- Birthdays and work anniversaries -------------------------------------------------

/**
 * Birthdays and work anniversaries over the coming week for the office being looked at and the rest of its market
 * (today first, that office first within a day). The Corporate view covers every office.
 * Birthdays are a day and month only; anniversaries come from the start date, from one year on.
 */
function thisWeek(user, today = localDate()) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const year = Number(today.slice(0, 4));
  const at = reach.place(user);
  const people = db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.birthday, u.started_on, u.branch_id, b.name AS branch FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE ${LISTED} AND (u.birthday IS NOT NULL OR u.started_on IS NOT NULL)
     ${at.corporate ? '' : `AND u.branch_id IN (${reach.marketOffices(at.office).map(Number).join(',') || 0})`}
     ORDER BY (u.branch_id = ?) DESC, u.display_name COLLATE NOCASE`).all(at.office);
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
  return out.slice(0, 15).map((o) => ({ ...o, wishes: count.get(o.id, o.kind, o.year).n, wished: Boolean(mine.get(o.id, o.kind, o.year, user.id)), mine: o.id === user.id })).filter(() => year);
}

router.post('/celebrate', requireLogin, (req, res) => {
  const kind = req.body.kind === 'anniversary' ? 'anniversary' : 'birthday';
  const hit = thisWeek(req.user).find((o) => String(o.id) === String(req.body.user_id) && o.kind === kind);
  if (hit && hit.id !== req.user.id) db.prepare('INSERT OR IGNORE INTO celebrations (user_id, kind, year, from_user) VALUES (?, ?, ?, ?)').run(hit.id, kind, hit.year, req.user.id);
  res.redirect('/#thisweek');
});

// ---- Events ------------------------------------------------------------------------------

// An event is for one office, for a market, or for the whole company (see reach.js). People see the ones for the office
// they are looking at. The Corporate view, on the Events page, lists every office's.
const SEEN = reach.shown('e');
const seenIn = (user, everything) => (everything && reach.place(user).corporate ? '1 = 1' : SEEN);
function decorateEvent(e, me, today) {
  const d = new Date(`${e.event_date}T12:00:00Z`);
  const days = Math.round((d - new Date(`${today}T12:00:00Z`)) / 86400000);
  const going = db.prepare(`SELECT g.bringing, u.id, u.display_name, u.photo_path FROM event_signups g JOIN users u ON u.id = g.user_id WHERE g.event_id = ? AND u.active = 1 ORDER BY g.created_at`).all(e.id);
  return { ...e, going, mine: going.find((g) => g.id === me) || null, time: clock(e.event_time), weekday: WEEKDAYS[d.getUTCDay()], month: MONTHS[d.getUTCMonth()].slice(0, 3), day: d.getUTCDate(),
    when: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 1 ? `In ${days} days` : '', past: days < 0 };
}
const EVENT = `SELECT e.*, u.display_name AS by_name, b.name AS branch, m.name AS market FROM events e JOIN users u ON u.id = e.created_by LEFT JOIN branches b ON b.id = e.branch_id LEFT JOIN markets m ON m.id = e.market_id`;
function upcomingEvents(user, limit = 50, today = localDate(), everything = false) {
  return db.prepare(`${EVENT} WHERE ${seenIn(user, everything)} AND e.event_date >= @today ORDER BY e.event_date, (e.branch_id = @office AND e.market_id IS NULL) DESC, e.event_time, e.id LIMIT @limit`).all({ ...reach.params(user), today, limit }).map((e) => decorateEvent(e, user.id, today));
}
const mayRun = (user, e) => e.created_by === user.id || (access.can(user, 'events.post') && reach.runs(user, e));

function eventsPage(req, res, extra = {}) {
  const today = localDate();
  const past = db.prepare(`${EVENT} WHERE ${seenIn(req.user, true)} AND e.event_date < @today ORDER BY e.event_date DESC LIMIT 6`).all({ ...reach.params(req.user), today }).map((e) => decorateEvent(e, req.user.id, today));
  res.status(extra.errors ? 400 : 200).render('events', {
    title: 'Events', upcoming: upcomingEvents(req.user, 50, today, true).map((e) => ({ ...e, mayRun: mayRun(req.user, e) })), past, errors: [], values: {},
    canPost: access.can(req.user, 'events.post'), reaches: reach.choices(req.user), ...extra,
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
  // For the office being looked at, or (from someone who runs them) its market or the whole company.
  const where = reach.target(req.user, values.reach);
  db.prepare('INSERT INTO events (title, details, event_date, event_time, location, branch_id, market_id, potluck, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(values.title, values.details || null, values.event_date, values.event_time || null, values.location || null, where.branch_id, where.market_id, values.potluck, req.user.id, new Date().toISOString());
  activity.log(req.user, 'Event posted', values.title);
  flash(req, 'ok', 'Event posted.');
  res.redirect('/events');
});

const visibleEvent = (req) => (isId(req.params.id) ? db.prepare(`SELECT e.* FROM events e WHERE e.id = @id AND ${seenIn(req.user, true)}`).get({ id: req.params.id, ...reach.params(req.user) }) : null);

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

router.get('/wall/photo/:id', requireLogin, (req, res) => {
  const row = isId(req.params.id) ? db.prepare('SELECT path FROM wall_photos WHERE id = ?').get(req.params.id) : null;
  if (!row) return notFound(res);
  uploads.send(res, row.path, { 'Cache-Control': 'private, max-age=86400' }, () => notFound(res));
});

// ---- Branch pages ------------------------------------------------------------------------

// The office finder: every office, searchable by town, number, state, region and what it does.
router.get('/branches', requireLogin, (req, res) => {
  const company = require('./company');
  const services = company.allServices();
  const f = { q: clean(req.query.q, 60), region: clean(req.query.region, 40), state: clean(req.query.state, 2).toUpperCase(), service: services.find((s) => String(s.id) === String(req.query.service)) || null };
  const everything = company.findOffices();
  const rows = company.findOffices({ q: f.q, region: f.region, state: f.state, service: f.service ? f.service.id : null });
  res.render('branches', {
    title: 'Offices', wide: true, rows, f, services, total: everything.length, stateNames: company.STATES,
    regions: [...new Set(everything.map((b) => b.region).filter(Boolean))].sort(), states: [...new Set(everything.map((b) => b.state).filter(Boolean))].sort(),
  });
});

router.get('/branches/photo/:id', requireLogin, (req, res) => {
  const row = isId(req.params.id) ? db.prepare('SELECT photo_path FROM branches WHERE id = ?').get(req.params.id) : null;
  if (!row || !row.photo_path) return notFound(res);
  uploads.send(res, row.photo_path, { 'Cache-Control': 'private, max-age=86400' }, () => notFound(res));
});

// The people who keep a branch's page: anyone who can see every branch, or whoever manages people in that branch.
// Whoever runs the office: its own admin, an admin of its market, or a corporate admin.
const mayEditBranch = (user, b) => user.scope === 'all' && access.can(user, 'users.manage') && (user.allBranches || user.branch_id === b.id || (user.marketBranches || []).includes(b.id));
const getBranch = (id) => (isId(id) ? db.prepare('SELECT * FROM branches WHERE id = ?').get(id) : null);

function branchPage(req, res, b, extra = {}) {
  const inside = reach.place(req.user).office === b.id || req.user.allBranches || (req.user.marketBranches || []).includes(b.id);
  const people = db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.job_title, u.department FROM users u WHERE u.branch_id = ? AND ${LISTED} ORDER BY u.display_name COLLATE NOCASE`).all(b.id);
  const teamChart = require('../team').chart(people);
  const groups = new Map();
  for (const p of people) { const k = p.department || 'Team'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  // Management first, then the rest by name; people with no department last.
  const order = [...groups.keys()].sort((x, y) => (x === 'Management' ? -1 : y === 'Management' ? 1 : x === 'Team' ? 1 : y === 'Team' ? -1 : x.localeCompare(y)));
  res.status(extra.errors ? 400 : 200).render('branch', {
    title: `${b.name} office`, wide: true, b, people, teamChart, groups: order.map((k) => ({ name: k, people: groups.get(k) })), canEdit: mayEditBranch(req.user, b), errors: [], editing: false,
    services: require('./company').servicesOf(b.id), allServices: require('./company').allServices(), stateNames: require('./company').STATES,
    many: db.prepare('SELECT COUNT(*) AS n FROM branches').get().n > 1,
    // An office's shout-outs and events are its own: shown to whoever is looking at that office or runs it, not to visitors.
    inside,
    shouts: inside ? db.prepare(`${SHOUT} WHERE t.branch_id = @b ORDER BY s.id DESC LIMIT 4`).all({ me: req.user.id, b: b.id }) : [],
    photos: db.prepare(`${WALL} WHERE u.branch_id = @b ORDER BY p.id DESC LIMIT 8`).all({ me: req.user.id, b: b.id }),
    events: inside ? db.prepare(`${EVENT} WHERE ${SEEN} AND e.event_date >= @today ORDER BY e.event_date LIMIT 4`).all({ office: b.id, market: b.market_id || null, today: localDate() }).map((e) => decorateEvent(e, req.user.id, localDate())) : [],
    ...extra,
  });
}
// The office's organization chart as a PDF, for people who manage users (everyone else sees the chart on screen).
router.get('/branches/:id/chart.pdf', requireLogin, (req, res) => {
  if (!access.can(req.user, 'users.manage')) return forbidden(res);
  const b = getBranch(req.params.id);
  if (!b) return notFound(res);
  const people = db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.job_title, u.department FROM users u WHERE u.branch_id = ? AND ${LISTED} ORDER BY u.display_name COLLATE NOCASE`).all(b.id);
  const { fmtDate, localDate } = require('../util');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${b.name.replace(/[^A-Za-z0-9]+/g, '-')}-organization-chart-${localDate()}.pdf"`);
  require('../chartpdf').write(res, { office: b, teamChart: require('../team').chart(people), when: fmtDate(localDate()) });
});

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
  const values = { address: clean(req.body.address, 200), phone: clean(req.body.phone, 40), about: clean(req.body.about, 1500) };
  const errors = [];
  if (values.phone && !/^[0-9 ()+.x\/-]{7,40}$/.test(values.phone)) errors.push('The phone number does not look right.');
  if (req.photoError) errors.push(req.photoError);
  else if (file && !uploads.looksLikeImage(file.path)) errors.push('The photo must be a JPEG, PNG, WebP or GIF image.');
  if (errors.length) { drop(); return branchPage(req, res, { ...b, ...values }, { errors, editing: true }); }
  const photo = file ? file.filename : req.body.remove_photo === '1' ? null : b.photo_path;
  db.transaction(() => {
    db.prepare('UPDATE branches SET address = ?, phone = ?, about = ?, photo_path = ? WHERE id = ?').run(values.address || null, values.phone || null, values.about || null, photo, b.id);
    // What this office does: the boxes that were ticked.
    if (req.body.services_form === '1') {
      db.prepare('DELETE FROM branch_services WHERE branch_id = ?').run(b.id);
      const tick = db.prepare('INSERT OR IGNORE INTO branch_services (branch_id, service_id) SELECT ?, id FROM services WHERE id = ?');
      for (const id of [].concat(req.body.services || []).filter(isId)) tick.run(b.id, Number(id));
    }
  })();
  if (b.photo_path && b.photo_path !== photo) uploads.remove(b.photo_path);
  activity.log(req.user, 'Office page edited', b.name);
  flash(req, 'ok', 'Office page saved.');
  res.redirect(`/branches/${b.id}`);
});

module.exports = router;
Object.assign(module.exports, { recentShoutouts, shoutoutsFor, mayShout, thisWeek, upcomingEvents, recentPhotos, MONTHS });
