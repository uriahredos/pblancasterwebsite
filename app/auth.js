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

// Temporary passwords do not last: an old sign-in message found in a chat months later must not be a way in.
// temp_set_at is when the current temporary password was made; it is empty for a password the person chose.
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'temp_set_at'").get()) db.exec('ALTER TABLE users ADD COLUMN temp_set_at TEXT');
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'temp_expiry_1'").get()) {
  // The clock starts now for temporary passwords that were already out when this rule arrived.
  // An account that already has a Face ID sign-in is not waiting on a temporary password, so it is left alone.
  db.prepare('UPDATE users SET temp_set_at = ? WHERE must_change_password = 1 AND temp_set_at IS NULL AND id NOT IN (SELECT user_id FROM passkeys)').run(new Date().toISOString());
  db.prepare("INSERT INTO meta (key, value) VALUES ('temp_expiry_1', '1')").run();
}
// The master account is left out: nobody else could hand it a new one.
const tempExpired = (user) => Boolean(user && !user.is_master && user.must_change_password && user.temp_set_at && Date.now() - new Date(user.temp_set_at).getTime() > config.tempPasswordDays * 86400000);
/** Give an account a fresh temporary password and return it. */
function issueTemp(userId) {
  const password = tempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, temp_set_at = ? WHERE id = ?').run(hashPassword(password), new Date().toISOString(), userId);
  return password;
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
    `INSERT INTO users (username, display_name, email, password_hash, profile_id, is_master, created_at, branch_id, temp_set_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT MIN(id) FROM branches)), ?)`
  ).run(username, displayName, email || null, hashPassword(password), profileId, master ? 1 : 0, new Date().toISOString(), branchId, new Date().toISOString());
  return info.lastInsertRowid;
}

/** Attach req.user from the session on every request. */
function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    const user = userById.get(req.session.userId);
    // A sign-in made with a temporary password ends when that password expires, so it cannot be finished off weeks later.
    if (user && user.active && !tempExpired(user)) req.user = access.loadAccess(user, req.session.viewBranch);
    else delete req.session.userId;
  }
  res.locals.user = req.user;
  res.locals.can = (perm) => access.can(req.user, perm);
  res.locals.badges = { updates: 0, requests: 0, notices: 0, certs: 0, inspections: 0, forum: 0, tasks: 0, newTasks: 0, leads: 0 };
  res.locals.myTasks = [];
  res.locals.newThreads = [];
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
    res.locals.badges.newTasks = tasks.newCount(req.user.id);
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
    // Discussions with new replies are listed by name, each going straight to its newest reply.
    if (b.forum) {
      res.locals.newThreads = db.prepare(
        `SELECT t.id, t.title, u.display_name AS last_author, (SELECT MAX(p.id) FROM forum_posts p WHERE p.thread_id = t.id) AS last_post
         FROM forum_threads t JOIN forum_reads r ON r.thread_id = t.id AND r.user_id = @me JOIN users u ON u.id = t.last_post_user_id
         WHERE r.following = 1 AND t.last_post_user_id <> @me AND (r.last_read_at IS NULL OR t.last_post_at > r.last_read_at)
         ORDER BY t.last_post_at DESC LIMIT 5`).all({ me: req.user.id });
    }
    // Sales: this person's own leads whose follow-up date has arrived.
    if (access.can(req.user, 'sales.use')) b.leads = require('./sales').dueCount(req.user.id);
    res.locals.alerts = [
      [b.notices, '/notices', 'unread announcement', 'unread announcements'],
      [b.leads, '/sales?show=due', 'lead to follow up', 'leads to follow up'],
      [Math.max(0, b.forum - res.locals.newThreads.length), '/discussions', 'more discussion with new replies', 'more discussions with new replies'],
      [b.updates, '/my', 'update on your requests', 'updates on your requests'],
      [b.requests, '/admin/requests', 'open parts request', 'open parts requests'],
      [b.inspections, '/admin/inspections?show=open', 'truck problem not fixed', 'truck problems not fixed'],
      [b.certs, '/admin/certs?show=attention', 'certification expired or expiring', 'certifications expired or expiring'],
      // For the people who look after backups: the last one did not work, and none has since.
      [req.user.allBranches && access.can(req.user, 'backups') && require('./backup').failing() ? 1 : 0, '/admin/backups', 'backup did not work', 'backups did not work'],
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
/** The form token for this session, made the first time a page with a form needs one. */
function formToken(req, res) {
  if (!req.session.csrf) req.session.csrf = newCsrfToken();
  res.locals.csrf = req.session.csrf;
  return req.session.csrf;
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
  hashPassword, checkLogin, tempPassword, tempExpired, issueTemp, createUser, loadUser,
  requireLogin, requirePerm, requireEveryBranch, forbidden, newCsrfToken, formToken, verifyCsrf, flash, endSessions, unlock,
};
