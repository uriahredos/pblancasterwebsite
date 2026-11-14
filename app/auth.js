'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const access = require('./permissions');
const { localDate } = require('./util');

const userById = db.prepare('SELECT * FROM users WHERE id = ?');
const userByName = db.prepare('SELECT * FROM users WHERE username = ?');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

const hashPassword = (pw) => bcrypt.hashSync(pw, config.bcryptRounds);

/** Returns the user row when the credentials are right and the account is active. */
function checkLogin(username, password) {
  const user = userByName.get(String(username || '').trim());
  const ok = bcrypt.compareSync(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  return ok && user && user.active ? user : null;
}

/** Readable temporary password, e.g. "kx7f-m2qp-9wtc". */
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `${pick()}-${pick()}-${pick()}`;
}

/**
 * profile: a profile name or id. The very first account, and any account made
 * with master: true, becomes the master account.
 */
function createUser({ username, displayName, email, password, profile = 'Technician', master = false, branchId = null }) {
  const profileId = typeof profile === 'number' ? profile : (access.profileByName(profile) || {}).id;
  if (!profileId) throw new Error(`Unknown profile: ${profile}`);
  const info = db.prepare(
    `INSERT INTO users (username, display_name, email, password_hash, profile_id, is_master, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT MIN(id) FROM branches)))`
  ).run(username, displayName, email || null, hashPassword(password), profileId, master ? 1 : 0, new Date().toISOString(), branchId);
  return info.lastInsertRowid;
}

/** Attach req.user from the session on every request. */
function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    const user = userById.get(req.session.userId);
    if (user && user.active) req.user = access.loadAccess(user, req.session.viewBranch);
    else delete req.session.userId;
  }
  res.locals.user = req.user;
  res.locals.can = (perm) => access.can(req.user, perm);
  res.locals.badges = { updates: 0, requests: 0, notices: 0, certs: 0, inspections: 0, forum: 0, tasks: 0 };
  res.locals.myTasks = [];
  res.locals.alerts = [];
  res.locals.branchName = null; res.locals.branchChoices = [];
  if (req.user) {
    const all = db.prepare('SELECT id, name FROM branches ORDER BY name COLLATE NOCASE').all();
    res.locals.branchName = (all.find((b) => b.id === req.user.branch_id) || {}).name || null;
    // Someone who can see every branch chooses which one they are looking at.
    if (req.user.allBranches && all.length > 1) {
      const used = new Set(db.prepare('SELECT DISTINCT branch_id FROM users').all().map((r) => r.branch_id));
      res.locals.branchChoices = all.filter((b) => used.has(b.id) || b.id === req.user.viewBranch);
    }
  }
  if (req.user) {
    // Tasks assigned to this person and not done yet: overdue first, then soonest due, then ones with no date.
    const tasks = require('./tasks');
    res.locals.myTasks = tasks.openFor(req.user.id, 6);
    res.locals.badges.tasks = tasks.openCount(req.user.id);
    // "My activity": status changes this person has not looked at yet.
    res.locals.badges.updates =
      db.prepare('SELECT COUNT(*) AS n FROM parts_submissions WHERE user_id = ? AND unseen = 1').get(req.user.id).n +
      db.prepare('SELECT COUNT(*) AS n FROM training_requests WHERE user_id = ? AND unseen = 1').get(req.user.id).n;
    res.locals.badges.notices = require('./routes/announcements').unreadCount(req.user.id);
    // Discussions: threads this person follows that someone else has replied to since they last looked.
    if (access.can(req.user, 'forum.use')) {
      res.locals.badges.forum = db.prepare(
        `SELECT COUNT(*) AS n FROM forum_reads r JOIN forum_threads t ON t.id = r.thread_id
         WHERE r.user_id = @me AND r.following = 1 AND t.last_post_user_id <> @me
           AND (r.last_read_at IS NULL OR t.last_post_at > r.last_read_at)`).get({ me: req.user.id }).n;
    }
    const scopeIds = access.visibleUserIds(req.user);
    const inScope = (col) => (scopeIds ? `AND ${col} IN (${scopeIds.map(Number).join(',')})` : '');
    // Certifications expired or expiring within 30 days, for people who keep those records.
    if (access.can(req.user, 'certs.manage')) {
      const limit = new Date(localDate() + 'T12:00:00Z'); limit.setUTCDate(limit.getUTCDate() + 30);
      res.locals.badges.certs = db.prepare(
        `SELECT COUNT(*) AS n FROM certifications c JOIN users u ON u.id = c.user_id
         WHERE u.active = 1 AND c.expires_on IS NOT NULL AND c.expires_on <= ? ${inScope('c.user_id')}`).get(limit.toISOString().slice(0, 10)).n;
    }
    // Truck problems nobody has marked as fixed.
    if (access.can(req.user, 'inspections.view')) {
      res.locals.badges.inspections = db.prepare(
        `SELECT COUNT(*) AS n FROM inspections WHERE problems > 0 AND resolved_at IS NULL ${inScope('user_id')}`).get().n;
    }
    // "Requests": open parts requests waiting on someone who can act on them.
    if (access.can(req.user, 'parts.manage')) {
      const ids = access.visibleUserIds(req.user);
      res.locals.badges.requests = db.prepare(
        `SELECT COUNT(*) AS n FROM parts_submissions WHERE action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered')
         ${ids ? `AND user_id IN (${ids.map(Number).join(',')})` : ''}`).get().n;
    }
    // Everything waiting on this person apart from tasks, for the bell and the Alerts page.
    // Each entry is [count, link, wording for one, wording for several].
    const b = res.locals.badges;
    res.locals.alerts = [
      [b.notices, '/notices', 'unread announcement', 'unread announcements'],
      [b.forum, '/discussions', 'discussion with new replies', 'discussions with new replies'],
      [b.updates, '/my', 'update on your requests', 'updates on your requests'],
      [b.requests, '/admin/requests', 'open parts request', 'open parts requests'],
      [b.inspections, '/admin/inspections?show=open', 'truck problem not fixed', 'truck problems not fixed'],
      [b.certs, '/admin/certs?show=attention', 'certification expired or expiring', 'certifications expired or expiring'],
    ].filter((a) => a[0] > 0);
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    const target = req.method === 'GET' ? req.originalUrl : '/';
    return res.redirect('/login?next=' + encodeURIComponent(target));
  }
  if (req.user.must_change_password) return res.redirect('/account/password');
  next();
}

function forbidden(res) {
  res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to this page.' });
}

/** Route guard: signed in, and their profile includes this permission. */
function requirePerm(perm) {
  return (req, res, next) => requireLogin(req, res, () => (access.can(req.user, perm) ? next() : forbidden(res)));
}

/** Route guard for the things that span every branch: profiles, backups, the history import. */
function requireEveryBranch(perm) {
  return (req, res, next) => requirePerm(perm)(req, res, () => (req.user.allBranches ? next() : forbidden(res)));
}
function newCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

function verifyCsrf(req, res, next) {
  const sent = String((req.body && req.body._csrf) || '');
  const want = String(req.session.csrf || '');
  const ok = sent.length === want.length && want.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
  if (!ok) {
    return res.status(403).render('error', {
      title: 'Form expired',
      message: 'This form expired or was sent from another page. Go back, reload the page and try again.',
    });
  }
  next();
}

/**
 * Sign this person out everywhere, except (optionally) the session making the change.
 * Used whenever a password changes or an account is disabled, so an old sign-in on a
 * lost phone or someone else's computer stops working at once.
 */
function endSessions(userId, exceptSid) {
  return db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ? AND sid <> ?").run(userId, exceptSid || '').changes;
}
/** Mark this session as just opened by its owner (after a password, Face ID or fingerprint). */
function unlock(req) {
  req.session.locked = false;
  req.session.seenAt = Date.now();
  req.session.fresh = true;
}
function flash(req, type, text) {
  req.session.flash = { type, text };
}

module.exports = {
  hashPassword, checkLogin, tempPassword, createUser, loadUser,
  requireLogin, requirePerm, requireEveryBranch, forbidden, newCsrfToken, verifyCsrf, flash, endSessions, unlock,
};
