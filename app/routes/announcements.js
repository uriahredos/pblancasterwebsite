'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const { requireLogin, requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate } = require('../util');

const router = express.Router();

// An announcement reaches everyone, or (when a manager posted it) that manager's people and the manager.
const FOR_ME = `(a.audience = 'all' OR a.created_by = @me OR EXISTS (SELECT 1 FROM user_managers um WHERE um.manager_id = a.created_by AND um.user_id = @me))`;
const CURRENT = `(a.expires_on IS NULL OR a.expires_on >= @today)`;

// What an announcement is about. 'general' shows no label.
const CATEGORIES = { general: 'General', hr: 'HR', training: 'Training', safety: 'Safety', event: 'Event' };

/** Current announcements for this person: unread first, then pinned, then newest. */
function forUser(userId) {
  return db.prepare(
    `SELECT a.*, u.display_name AS author, r.read_at FROM announcements a JOIN users u ON u.id = a.created_by
     LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = @me
     WHERE ${FOR_ME} AND ${CURRENT} ORDER BY r.read_at IS NOT NULL, a.pinned DESC, a.id DESC LIMIT 100`).all({ me: userId, today: localDate() });
}
const unreadCount = (userId) => db.prepare(
  `SELECT COUNT(*) AS n FROM announcements a WHERE ${FOR_ME} AND ${CURRENT}
   AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = @me)`).get({ me: userId, today: localDate() }).n;

/** Everyone an announcement is meant for (active accounts only). */
function audience(a) {
  if (a.audience === 'all') return db.prepare('SELECT id, display_name FROM users WHERE active = 1 ORDER BY display_name COLLATE NOCASE').all();
  return db.prepare(
    `SELECT u.id, u.display_name FROM users u WHERE u.active = 1 AND (u.id = ? OR u.id IN (SELECT user_id FROM user_managers WHERE manager_id = ?))
     ORDER BY u.display_name COLLATE NOCASE`).all(a.created_by, a.created_by);
}

router.get('/notices', requireLogin, (req, res) => {
  res.render('notices', { title: 'Notices', notices: forUser(req.user.id), categories: CATEGORIES });
});

router.post('/notices/:id/read', requireLogin, (req, res) => {
  const a = db.prepare(`SELECT a.id FROM announcements a WHERE a.id = @id AND ${FOR_ME}`).get({ id: req.params.id, me: req.user.id });
  if (a) db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)').run(a.id, req.user.id, new Date().toISOString());
  res.redirect(req.body.back === 'home' ? '/' : '/notices');
});

// ---- Posting and seeing who has read -------------------------------------------

// Someone who sees everyone manages every announcement; a manager manages their own.
const mine = (user, a) => user.scope !== 'team' || a.created_by === user.id;

function listPage(req, res, extra = {}) {
  const rows = db.prepare(
    `SELECT a.*, u.display_name AS author FROM announcements a JOIN users u ON u.id = a.created_by ORDER BY a.id DESC LIMIT 200`).all()
    .filter((a) => mine(req.user, a))
    .map((a) => {
      const people = audience(a);
      const read = db.prepare(`SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ? AND user_id IN (${people.map((p) => p.id).join(',') || 0})`).get(a.id).n;
      return { ...a, total: people.length, read, expired: Boolean(a.expires_on && a.expires_on < localDate()) };
    });
  res.status(extra.errors ? 400 : 200).render('admin_announcements', {
    title: 'Announcements', rows, errors: [], values: {}, team: req.user.scope === 'team', categories: CATEGORIES, ...extra,
  });
}

router.get('/admin/announcements', requirePerm('announcements.post'), (req, res) => listPage(req, res));

router.post('/admin/announcements', requirePerm('announcements.post'), (req, res) => {
  const values = {
    title: clean(req.body.title, 120), body: clean(req.body.body, 4000), expires_on: clean(req.body.expires_on, 10),
    category: Object.hasOwn(CATEGORIES, req.body.category) ? req.body.category : 'general', pinned: req.body.pinned === '1' ? 1 : 0,
  };
  const errors = [];
  if (!values.title) errors.push('Enter a title.');
  if (!values.body) errors.push('Enter the announcement.');
  if (values.expires_on && !isYmd(values.expires_on)) errors.push('The "show until" date does not look right.');
  if (errors.length) return listPage(req, res, { errors, values });
  const info = db.prepare('INSERT INTO announcements (title, body, audience, expires_on, category, pinned, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(values.title, values.body, req.user.scope === 'team' ? 'team' : 'all', values.expires_on || null, values.category, values.pinned, req.user.id, new Date().toISOString());
  // The person posting has obviously read it.
  db.prepare('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)').run(info.lastInsertRowid, req.user.id, new Date().toISOString());
  activity.log(req.user, 'Announcement posted', values.title);
  flash(req, 'ok', 'Announcement posted.');
  res.redirect('/admin/announcements');
});

function load(req, res) {
  const a = /^\d+$/.test(req.params.id) ? db.prepare(
    'SELECT a.*, u.display_name AS author FROM announcements a JOIN users u ON u.id = a.created_by WHERE a.id = ?').get(req.params.id) : null;
  if (!a) { res.redirect('/admin/announcements'); return null; }
  if (!mine(req.user, a)) { forbidden(res); return null; }
  return a;
}

router.get('/admin/announcements/:id', requirePerm('announcements.post'), (req, res) => {
  const a = load(req, res);
  if (!a) return;
  const reads = new Map(db.prepare('SELECT user_id, read_at FROM announcement_reads WHERE announcement_id = ?').all(a.id).map((r) => [r.user_id, r.read_at]));
  const people = audience(a).map((p) => ({ ...p, read_at: reads.get(p.id) || null }));
  res.render('admin_announcement', {
    title: a.title, a, categories: CATEGORIES, read: people.filter((p) => p.read_at).sort((x, y) => x.read_at.localeCompare(y.read_at)), unread: people.filter((p) => !p.read_at),
  });
});

// Pinned announcements stay at the top of the notice board on the home page.
router.post('/admin/announcements/:id/pin', requirePerm('announcements.post'), (req, res) => {
  const a = load(req, res);
  if (!a) return;
  db.prepare('UPDATE announcements SET pinned = ? WHERE id = ?').run(a.pinned ? 0 : 1, a.id);
  activity.log(req.user, a.pinned ? 'Announcement unpinned' : 'Announcement pinned', a.title);
  flash(req, 'ok', a.pinned ? 'No longer pinned.' : 'Pinned to the top of the notice board.');
  res.redirect(`/admin/announcements/${a.id}`);
});

router.post('/admin/announcements/:id/delete', requirePerm('announcements.post'), (req, res) => {
  const a = load(req, res);
  if (!a) return;
  db.prepare('DELETE FROM announcements WHERE id = ?').run(a.id);
  activity.log(req.user, 'Announcement removed', a.title);
  flash(req, 'ok', 'Announcement removed.');
  res.redirect('/admin/announcements');
});

module.exports = router;
module.exports.forUser = forUser;
module.exports.unreadCount = unreadCount;
module.exports.CATEGORIES = CATEGORIES;
