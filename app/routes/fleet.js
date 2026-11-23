'use strict';
// Fleet: the office's trucks and vans, trailers, lifts and other equipment, and signing shared equipment out.
// A technician's truck that is already an inventory location (see inventory.js) is listed here too, so there is one
// place to see everything the office runs.
const express = require('express');
const db = require('../db');
const config = require('../config');
const access = require('../permissions');
const activity = require('../activity');
const inv = require('../inventory');
const { requireLogin, requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd } = require('../util');

const router = express.Router();

db.exec(`
CREATE TABLE IF NOT EXISTS fleet_items (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  kind TEXT NOT NULL CHECK (kind IN ('truck','trailer','lift','other')),
  name TEXT NOT NULL,
  details TEXT,                                   -- make, model, size
  ident TEXT,                                     -- plate, serial or unit number
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- whose it is, if it is one person's
  bookable INTEGER NOT NULL DEFAULT 0,            -- shared: people sign it out
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_items_branch ON fleet_items(branch_id);
-- Times are the office's own clock, written 2026-11-23T14:30, so they sort and compare as text.
CREATE TABLE IF NOT EXISTS fleet_signouts (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES fleet_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  place TEXT NOT NULL,
  job_number TEXT,
  note TEXT,
  returned_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_signouts_item ON fleet_signouts(item_id, end_at);
`);

const KINDS = [['truck', 'Trucks and vans'], ['trailer', 'Trailers'], ['lift', 'Lifts'], ['other', 'Other equipment']];
const KIND_NAME = { truck: 'Truck or van', trailer: 'Trailer', lift: 'Lift', other: 'Other equipment' };
const isId = (v) => /^\d+$/.test(String(v || ''));
const mayManage = (user) => access.can(user, 'fleet.manage');
const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** The office's clock now, as 2026-11-23T14:30. */
const nowLocal = () => stamp.format(new Date()).replace(' ', 'T').replace(/^(\d{4}-\d\d-\d\d)T24/, '$1T00');
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 2026-11-23T14:30 as "Mon 11/23, 2:30 PM". */
function when(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(String(s || '')); if (!m) return '';
  const day = DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]; const h = +m[4];
  return `${day} ${+m[2]}/${+m[3]}, ${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`;
}
const minutes = (a, b) => Math.round((Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000);
/** How long, in words: "3 hours", "2 days", "1 day 4 hours". */
function howLong(a, b) {
  const min = minutes(a, b); const d = Math.floor(min / 1440); const h = Math.round((min % 1440) / 60 * 2) / 2;
  const part = (n, w) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '');
  return [part(d, 'day'), part(h, 'hour')].filter(Boolean).join(' ') || `${min} minutes`;
}

const item = (id, branchId) => (isId(id) ? db.prepare('SELECT * FROM fleet_items WHERE id = ? AND branch_id = ?').get(id, branchId) : null) || null;
const OUT = `SELECT s.*, i.name AS item, i.kind, u.display_name FROM fleet_signouts s JOIN fleet_items i ON i.id = s.item_id JOIN users u ON u.id = s.user_id`;
/** Sign-outs not yet returned, for an office: the ones out now (or late back) first, then the ones still to come. */
function open(branchId, now) {
  return db.prepare(`${OUT} WHERE i.branch_id = ? AND s.returned_at IS NULL ORDER BY s.start_at, s.id`).all(branchId)
    .map((s) => ({ ...s, state: s.start_at > now ? 'coming' : s.end_at < now ? 'late' : 'out', from: when(s.start_at), until: when(s.end_at), length: howLong(s.start_at, s.end_at) }));
}
const people = (branchId) => db.prepare("SELECT id, display_name FROM users WHERE branch_id = ? AND active = 1 ORDER BY display_name COLLATE NOCASE").all(branchId);

router.get('/fleet', requireLogin, (req, res) => {
  const branchId = req.user.workBranch; const now = nowLocal(); const out = open(branchId, now);
  const own = db.prepare(`SELECT f.*, u.display_name AS person FROM fleet_items f LEFT JOIN users u ON u.id = f.user_id WHERE f.branch_id = ? ORDER BY f.active DESC, f.name COLLATE NOCASE`).all(branchId)
    .map((f) => ({ ...f, out: out.find((s) => s.item_id === f.id && s.state !== 'coming') || null, next: out.find((s) => s.item_id === f.id && s.state === 'coming') || null }));
  // Technicians' trucks that are kept as inventory locations: shown with the rest, managed on the Inventory page.
  const stocked = branchId ? inv.locations(branchId).filter((l) => l.kind === 'vehicle' && l.active).map((l) => ({ name: l.name, person: l.technician, stocked: true, id: l.id })) : [];
  const groups = KINDS.map(([kind, title]) => ({ kind, title, items: [...(kind === 'truck' ? stocked : []), ...own.filter((f) => f.kind === kind && f.active)] })).filter((g) => g.items.length);
  res.render('fleet', { title: 'Fleet', wide: true, groups, retired: own.filter((f) => !f.active), out, mayManage: mayManage(req.user), maySign: access.can(req.user, 'fleet.signout'),
    seesInventory: access.can(req.user, 'parts.view') || access.can(req.user, 'inventory.manage'), kinds: KIND_NAME, people: mayManage(req.user) ? people(branchId) : [],
    office: (db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId) || {}).name || '' });
});

// Adding to the fleet, changing it, putting it away.
function readItem(body) {
  const v = { kind: KIND_NAME[body.kind] ? body.kind : '', name: clean(body.name, 60), details: clean(body.details, 120), ident: clean(body.ident, 60),
    user_id: isId(body.user_id) ? Number(body.user_id) : null, bookable: body.bookable === '1' ? 1 : 0 };
  const errors = [];
  if (!v.kind) errors.push('Choose what kind of thing it is.');
  if (!v.name) errors.push('Give it a name or number, such as Scissor lift 1.');
  return { v, errors };
}
router.post('/fleet', requirePerm('fleet.manage'), (req, res) => {
  const { v, errors } = readItem(req.body); const branchId = req.user.workBranch;
  if (v.user_id && !db.prepare('SELECT 1 FROM users WHERE id = ? AND branch_id = ?').get(v.user_id, branchId)) v.user_id = null;
  if (!errors.length && db.prepare('SELECT 1 FROM fleet_items WHERE branch_id = ? AND name = ? COLLATE NOCASE AND active = 1').get(branchId, v.name)) errors.push(`${v.name} is already in the fleet.`);
  if (errors.length) { flash(req, 'err', errors.join(' ')); return res.redirect('/fleet#add'); }
  db.prepare('INSERT INTO fleet_items (branch_id, kind, name, details, ident, user_id, bookable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(branchId, v.kind, v.name, v.details || null, v.ident || null, v.user_id, v.bookable, new Date().toISOString());
  activity.log(req.user, 'Fleet changed', `${v.name} added (${KIND_NAME[v.kind]})`);
  flash(req, 'ok', `${v.name} added to the fleet.`);
  res.redirect('/fleet');
});

// Signing equipment out. (Declared before /fleet/:id so "signout" is not taken for an id.)
function signoutPage(req, res, extra = {}) {
  const branchId = req.user.workBranch; const now = nowLocal(); const out = open(branchId, now);
  const choices = db.prepare('SELECT id, name, kind, details FROM fleet_items WHERE branch_id = ? AND active = 1 AND bookable = 1 ORDER BY kind = \'lift\' DESC, name COLLATE NOCASE').all(branchId);
  res.status(extra.errors ? 400 : 200).render('fleet_signout', { title: 'Sign out equipment', choices, out, mine: out.filter((s) => s.user_id === req.user.id), mayManage: mayManage(req.user),
    today: now.slice(0, 10), errors: [], values: { item: isId(req.query.item) ? req.query.item : '', start_date: now.slice(0, 10) }, ...extra });
}
router.get('/fleet/signout', requirePerm('fleet.signout'), (req, res) => signoutPage(req, res));
router.post('/fleet/signout', requirePerm('fleet.signout'), (req, res) => {
  const b = req.body; const branchId = req.user.workBranch;
  const values = { item: clean(b.item, 10), start_date: clean(b.start_date, 10), start_time: clean(b.start_time, 5), end_date: clean(b.end_date, 10), end_time: clean(b.end_time, 5),
    place: clean(b.place, 120), job_number: clean(b.job_number, 40), note: clean(b.note, 300) };
  const errors = []; const it = item(values.item, branchId);
  if (!it || !it.active || !it.bookable) errors.push('Choose which lift or piece of equipment you are taking.');
  const okStart = isYmd(values.start_date) && isTime(values.start_time); const okEnd = isYmd(values.end_date) && isTime(values.end_time);
  if (!okStart) errors.push('Enter the day and time you are taking it.');
  if (!okEnd) errors.push('Enter the day and time you will bring it back.');
  const start = `${values.start_date}T${values.start_time}`; const end = `${values.end_date}T${values.end_time}`;
  if (okStart && okEnd && end <= start) errors.push('The time it comes back has to be after the time it goes out.');
  if (okStart && okEnd && end > start && minutes(start, end) > 60 * 24 * 60) errors.push('That is more than 60 days. Check the dates.');
  if (okEnd && end < nowLocal()) errors.push('That time has already passed. Check the dates.');
  if (!values.place) errors.push('Say where it will be used: the job site or customer.');
  if (!errors.length) {
    // Two people cannot have the same lift at the same time.
    const clash = db.prepare(`${OUT} WHERE s.item_id = ? AND s.returned_at IS NULL AND s.start_at < ? AND s.end_at > ? ORDER BY s.start_at LIMIT 1`).get(it.id, end, start);
    if (clash) errors.push(`${it.name} is already signed out by ${clash.display_name} from ${when(clash.start_at)} until ${when(clash.end_at)} (${clash.place}). Pick another time, or ask them.`);
  }
  if (errors.length) return signoutPage(req, res, { errors, values });
  db.prepare('INSERT INTO fleet_signouts (item_id, user_id, start_at, end_at, place, job_number, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(it.id, req.user.id, start, end, values.place, values.job_number || null, values.note || null, new Date().toISOString());
  activity.log(req.user, 'Equipment signed out', `${it.name}: ${when(start)} until ${when(end)}, ${values.place}`);
  flash(req, 'ok', `${it.name} is signed out to you from ${when(start)} until ${when(end)}.`);
  res.redirect('/fleet/signout');
});
// Bringing it back (or, before it has gone out, cancelling): the person who signed it out, or whoever runs the fleet.
router.post('/fleet/signout/:id/return', requireLogin, (req, res) => {
  const s = isId(req.params.id) ? db.prepare(`${OUT} WHERE s.id = ?`).get(req.params.id) : null;
  const it = s ? db.prepare('SELECT * FROM fleet_items WHERE id = ?').get(s.item_id) : null;
  if (!s || !it || it.branch_id !== req.user.workBranch) return res.redirect('/fleet');
  if (s.user_id !== req.user.id && !mayManage(req.user)) return forbidden(res);
  const back = req.body.back === 'fleet' ? '/fleet' : '/fleet/signout';
  if (s.returned_at) return res.redirect(back);
  const now = nowLocal();
  if (s.start_at > now) { db.prepare('DELETE FROM fleet_signouts WHERE id = ?').run(s.id); flash(req, 'ok', `The sign-out of ${s.item} was cancelled.`); }
  else { db.prepare('UPDATE fleet_signouts SET returned_at = ? WHERE id = ?').run(now, s.id); flash(req, 'ok', `${s.item} is back.`); }
  if (s.user_id !== req.user.id) activity.log(req.user, 'Equipment sign-out closed', `${s.item}, signed out by ${s.display_name}`);
  res.redirect(back);
});

router.get('/fleet/:id', requireLogin, (req, res) => {
  const it = item(req.params.id, req.user.workBranch);
  if (!it) return res.status(404).render('error', { title: 'Page not found', message: 'That is not in this office\'s fleet.' });
  const history = db.prepare(`${OUT} WHERE s.item_id = ? ORDER BY s.start_at DESC LIMIT 40`).all(it.id)
    .map((s) => ({ ...s, from: when(s.start_at), until: when(s.end_at), length: howLong(s.start_at, s.end_at), back: s.returned_at ? when(s.returned_at) : '' }));
  res.render('fleet_item', { title: it.name, item: it, history, kinds: KIND_NAME, mayManage: mayManage(req.user), maySign: access.can(req.user, 'fleet.signout'),
    person: it.user_id ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(it.user_id) : null, people: mayManage(req.user) ? people(req.user.workBranch) : [] });
});
router.post('/fleet/:id', requirePerm('fleet.manage'), (req, res) => {
  const it = item(req.params.id, req.user.workBranch);
  if (!it) return res.redirect('/fleet');
  if (req.body.op === 'retire' || req.body.op === 'restore') {
    db.prepare('UPDATE fleet_items SET active = ? WHERE id = ?').run(req.body.op === 'restore' ? 1 : 0, it.id);
    activity.log(req.user, 'Fleet changed', `${it.name} ${req.body.op === 'restore' ? 'brought back' : 'put away'}`);
    flash(req, 'ok', req.body.op === 'restore' ? `${it.name} is back in the fleet.` : `${it.name} was put away. Its history is kept.`);
    return res.redirect('/fleet');
  }
  const { v, errors } = readItem(req.body);
  if (v.user_id && !db.prepare('SELECT 1 FROM users WHERE id = ? AND branch_id = ?').get(v.user_id, it.branch_id)) v.user_id = null;
  if (errors.length) { flash(req, 'err', errors.join(' ')); return res.redirect(`/fleet/${it.id}`); }
  db.prepare('UPDATE fleet_items SET kind = ?, name = ?, details = ?, ident = ?, user_id = ?, bookable = ? WHERE id = ?').run(v.kind, v.name, v.details || null, v.ident || null, v.user_id, v.bookable, it.id);
  activity.log(req.user, 'Fleet changed', `${v.name} edited`);
  flash(req, 'ok', 'Saved.');
  res.redirect(`/fleet/${it.id}`);
});

module.exports = router;
