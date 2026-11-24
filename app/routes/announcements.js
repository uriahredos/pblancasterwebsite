'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const { requireLogin, requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate } = require('../util');

const router = express.Router();

// An announcement reaches everyone, or (when a manager posted it) that manager's people and the manager.
// 'all' means everyone in the branch it was posted for, or every branch when it has no branch.
// Which ones follow the office being looked at: that office's, its market's and the company's (see reach.js).
const reach = require('../reach');
const FOR_ME = `((a.audience = 'all' AND ${reach.shown('a')}) OR (a.audience <> 'all' AND (a.created_by = @me OR EXISTS (SELECT 1 FROM user_managers um WHERE um.manager_id = a.created_by AND um.user_id = @me))))`;
const seenBy = (user) => ({ me: user.id, ...reach.params(user) });
const CURRENT = `(a.expires_on IS NULL OR a.expires_on >= @today)`;

// What an announcement is about. 'general' shows no label.
const CATEGORIES = { general: 'General', hr: 'HR', training: 'Training', safety: 'Safety', event: 'Event' };

/** Current announcements for this person: unread first, then critical, then pinned, then newest. */
function forUser(user) {
  return db.prepare(
    `SELECT a.*, u.display_name AS author, r.read_at FROM announcements a JOIN users u ON u.id = a.created_by
     LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = @me
     WHERE ${FOR_ME} AND ${CURRENT} ORDER BY r.read_at IS NOT NULL, a.critical DESC, a.pinned DESC, a.id DESC LIMIT 100`).all({ ...seenBy(user), today: localDate() });
}
const unreadCount = (user) => db.prepare(
  `SELECT COUNT(*) AS n FROM announcements a WHERE ${FOR_ME} AND ${CURRENT}
   AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = @me)`).get({ ...seenBy(user), today: localDate() }).n;

/** Everyone an announcement is meant for (active accounts only). */
function audience(a) {
  if (a.audience === 'all' && a.market_id) return db.prepare('SELECT id, display_name FROM users WHERE active = 1 AND branch_id IN (SELECT id FROM branches WHERE market_id = ?) ORDER BY display_name COLLATE NOCASE').all(a.market_id);
  if (a.audience === 'all') return db.prepare('SELECT id, display_name FROM users WHERE active = 1 AND (? IS NULL OR branch_id = ?) ORDER BY display_name COLLATE NOCASE').all(a.branch_id ?? null, a.branch_id ?? null);
  return db.prepare(
    `SELECT u.id, u.display_name FROM users u WHERE u.active = 1 AND (u.id = ? OR u.id IN (SELECT user_id FROM user_managers WHERE manager_id = ?))
     ORDER BY u.display_name COLLATE NOCASE`).all(a.created_by, a.created_by);
}

router.get('/notices', requireLogin, (req, res) => {
  const notices = require('../reactions').attach('notice', forUser(req.user), req.user.id);
  withComments(notices);
  res.render('notices', { title: 'Announcements', notices, categories: CATEGORIES, mayRemove: (n, c) => c.user_id === req.user.id || n.created_by === req.user.id || access.moderates(req.user, 'announcements.post', c.user_id) });
});

/** Attaches each announcement's comments (oldest first) as .comments. */
function withComments(list) {
  if (!list.length) return list;
  const rows = db.prepare(
    `SELECT c.*, u.display_name AS author, u.photo_path, b.name AS office FROM announcement_comments c JOIN users u ON u.id = c.user_id LEFT JOIN branches b ON b.id = u.branch_id
     WHERE c.announcement_id IN (${list.map((n) => Number(n.id)).join(',')}) ORDER BY c.id`).all();
  for (const n of list) n.comments = rows.filter((c) => c.announcement_id === n.id);
  return list;
}

// Anyone the announcement is for can ask a question or answer one under it.
router.post('/notices/:id/comment', requireLogin, (req, res) => {
  const a = forUser(req.user).find((n) => String(n.id) === String(req.params.id));
  if (!a) return forbidden(res);
  const body = clean(req.body.body, 1000);
  if (body) {
    const last = db.prepare('SELECT user_id, body FROM announcement_comments WHERE announcement_id = ? ORDER BY id DESC LIMIT 1').get(a.id);
    if (!(last && last.user_id === req.user.id && last.body === body)) {            // a double tap does not post twice
      db.prepare('INSERT INTO announcement_comments (announcement_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(a.id, req.user.id, body, new Date().toISOString());
      if (a.created_by !== req.user.id) require('../push').notify([a.created_by], 'task_done', { title: `Comment on: ${a.title}`, body: `${req.user.display_name}: "${body.slice(0, 140)}"`, url: `/notices#n${a.id}` });
    }
    flash(req, 'ok', 'Comment added.');
  }
  res.redirect(`/notices#n${a.id}`);
});

// Change the words of your own comment.
router.post('/notices/comment/:id/edit', requireLogin, (req, res) => {
  const c = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM announcement_comments WHERE id = ?').get(req.params.id) : null;
  if (!c) return res.redirect('/notices');
  if (c.user_id !== req.user.id) return forbidden(res);
  const body = String(req.body.body || '').trim().slice(0, 500);
  if (!body) flash(req, 'err', 'A comment cannot be empty. Remove it instead.');
  else if (body !== c.body) { db.prepare('UPDATE announcement_comments SET body = ?, edited_at = ? WHERE id = ?').run(body, new Date().toISOString(), c.id); flash(req, 'ok', 'Comment updated.'); }
  res.redirect(`/notices#n${c.announcement_id}`);
});

// Your own comment, or any comment if you post announcements.
router.post('/notices/comment/:id/delete', requireLogin, (req, res) => {
  const c = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM announcement_comments WHERE id = ?').get(req.params.id) : null;
  if (!c) return res.redirect('/notices');
  const a = db.prepare('SELECT created_by FROM announcements WHERE id = ?').get(c.announcement_id);
  const mine = c.user_id === req.user.id || (a && a.created_by === req.user.id);
  if (!mine && !access.moderates(req.user, 'announcements.post', c.user_id)) return forbidden(res);
  if (!forUser(req.user).some((n) => n.id === c.announcement_id) && !mine) return forbidden(res);
  db.prepare('DELETE FROM announcement_comments WHERE id = ?').run(c.id);
  flash(req, 'ok', 'Comment removed.');
  res.redirect(`/notices#n${c.announcement_id}`);
});

router.post('/notices/:id/read', requireLogin, (req, res) => {
  const a = db.prepare(`SELECT a.id FROM announcements a WHERE a.id = @id AND ${FOR_ME}`).get({ id: req.params.id, ...seenBy(req.user) });
  if (a) db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)').run(a.id, req.user.id, new Date().toISOString());
  res.redirect(req.body.back === 'home' ? '/' : '/notices');
});

// ---- Posting and seeing who has read -------------------------------------------

// Someone who sees everyone manages every announcement; a manager manages their own.
// ...within the branch they are looking at. Ones for every branch are managed by people who can see every branch.
// A market's are managed by its market admins and by corporate; the Corporate view lists them all.
const mine = (user, a) => (user.scope === 'team' ? a.created_by === user.id
  : reach.place(user).corporate ? true : reach.isShown(user, a) && reach.runs(user, a));

function listPage(req, res, extra = {}) {
  const rows = db.prepare(
    `SELECT a.*, u.display_name AS author FROM announcements a JOIN users u ON u.id = a.created_by ORDER BY a.id DESC LIMIT 200`).all()
    .filter((a) => mine(req.user, a))
    .map((a) => {
      const people = audience(a);
      const read = db.prepare(`SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ? AND user_id IN (${people.map((p) => p.id).join(',') || 0})`).get(a.id).n;
      return { ...a, total: people.length, read, expired: Boolean(a.expires_on && a.expires_on < localDate()), for: a.audience === 'all' ? reach.label(a) : 'Their team' };
    });
  res.status(extra.errors ? 400 : 200).render('admin_announcements', {
    title: 'Post announcements', rows, errors: [], values: {}, team: req.user.scope === 'team', categories: CATEGORIES,
    reaches: reach.choices(req.user), ...extra,
  });
}

router.get('/admin/announcements', requirePerm('announcements.post'), (req, res) => listPage(req, res));

router.post('/admin/announcements', requirePerm('announcements.post'), (req, res) => {
  const values = {
    title: clean(req.body.title, 120), body: clean(req.body.body, 4000), expires_on: clean(req.body.expires_on, 10),
    category: Object.hasOwn(CATEGORIES, req.body.category) ? req.body.category : 'general', pinned: req.body.pinned === '1' ? 1 : 0,
    critical: req.body.critical === '1' ? 1 : 0,
  };
  const errors = [];
  if (!values.title) errors.push('Enter a title.');
  if (!values.body) errors.push('Enter the announcement.');
  if (values.expires_on && !isYmd(values.expires_on)) errors.push('The "show until" date does not look right.');
  if (errors.length) return listPage(req, res, { errors, values });
  // For the branch being looked at, or (only from someone who can see every branch) for every branch.
  const where = reach.target(req.user, req.body.reach);
  const branchId = where.branch_id;
  const info = db.prepare('INSERT INTO announcements (title, body, audience, expires_on, category, pinned, critical, created_by, created_at, branch_id, market_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(values.title, values.body, req.user.scope === 'team' ? 'team' : 'all', values.expires_on || null, values.category, values.pinned, values.critical, req.user.id, new Date().toISOString(), branchId, where.market_id);
  // The person posting has obviously read it.
  db.prepare('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)').run(info.lastInsertRowid, req.user.id, new Date().toISOString());
  if (values.critical) {
    const who = audience({ audience: req.user.scope === 'team' ? 'team' : 'all', created_by: req.user.id, branch_id: branchId, market_id: where.market_id }).map((p) => p.id).filter((id) => id !== req.user.id);
    require('../push').notify(who, 'critical_notice', { title: `Critical: ${values.title}`, body: values.body, url: '/notices' });
  }
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

// Critical announcements show at the very top of the home page every time it is opened,
// even after they are read, until their "show until" date passes or this is switched off.
router.post('/admin/announcements/:id/critical', requirePerm('announcements.post'), (req, res) => {
  const a = load(req, res);
  if (!a) return;
  db.prepare('UPDATE announcements SET critical = ? WHERE id = ?').run(a.critical ? 0 : 1, a.id);
  activity.log(req.user, a.critical ? 'Announcement no longer critical' : 'Announcement marked critical', a.title);
  flash(req, 'ok', a.critical ? 'No longer critical. It is back with the other announcements.' : 'Marked critical. It now stays at the top of the home page.');
  res.redirect(`/admin/announcements/${a.id}`);
});

// Pinned announcements stay at the top of the announcements on the home page.
router.post('/admin/announcements/:id/pin', requirePerm('announcements.post'), (req, res) => {
  const a = load(req, res);
  if (!a) return;
  db.prepare('UPDATE announcements SET pinned = ? WHERE id = ?').run(a.pinned ? 0 : 1, a.id);
  activity.log(req.user, a.pinned ? 'Announcement unpinned' : 'Announcement pinned', a.title);
  flash(req, 'ok', a.pinned ? 'No longer pinned.' : 'Pinned to the top of the announcements.');
  res.redirect(`/admin/announcements/${a.id}`);
});

router.post('/admin/announcements/:id/delete', requirePerm('announcements.post'), (req, res) => {
  const a = load(req, res);
  if (!a) return;
  require('../reactions').clear('notice', a.id);
  db.prepare('DELETE FROM announcements WHERE id = ?').run(a.id);
  activity.log(req.user, 'Announcement removed', a.title);
  flash(req, 'ok', 'Announcement removed.');
  res.redirect('/admin/announcements');
});

module.exports = router;
module.exports.forUser = forUser;
module.exports.unreadCount = unreadCount;
module.exports.CATEGORIES = CATEGORIES;
