'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const crypto = require('crypto');
const mail = require('../mail');
const { clean } = require('../util');
const passwords = require('../passwords');
const { rateKey } = require('../clientip');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateLimit,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateKey,
  handler: (req, res) => res.status(429).render('login', {
    title: 'Sign in', next: '', username: '', error: 'Too many attempts. Wait 15 minutes and try again.',
  }),
});

// The limit above is per connection. This one is per account, wherever the guesses come from:
// after 10 wrong passwords for one username, that username waits 15 minutes.
const FAILS = new Map(); // username -> { n, until }
const WINDOW_MS = 15 * 60 * 1000;
const NAME_LIMIT = 10;
const nameKey = (u) => String(u || '').trim().toLowerCase().slice(0, 60);
function lockedOut(username) {
  const f = FAILS.get(nameKey(username));
  if (f && f.until <= Date.now()) { FAILS.delete(nameKey(username)); return false; }
  return Boolean(f && f.n >= NAME_LIMIT);
}
function noteFailure(username) {
  const key = nameKey(username);
  if (!key) return;
  if (FAILS.size > 5000) for (const [k, v] of FAILS) if (v.until <= Date.now()) FAILS.delete(k);
  if (FAILS.size > 5000) FAILS.clear();
  const f = FAILS.get(key) || { n: 0, until: Date.now() + WINDOW_MS };
  f.n += 1;
  FAILS.set(key, f);
}

// Checking a password is slow on purpose, and it holds up everything else while it runs. So the whole site only
// checks so many a second: a flood of sign-in attempts from many places at once gets "busy" answers instead of
// freezing every page for everyone. Ordinary use never comes near it.
const budget = { tokens: config.loginRateLimit * 3, at: Date.now() };
function spendCheck() {
  const cap = config.loginRateLimit * 3; const now = Date.now();
  budget.tokens = Math.min(cap, budget.tokens + ((now - budget.at) / 1000) * config.loginRateLimit * 0.15); budget.at = now;
  if (budget.tokens < 1) return false;
  budget.tokens -= 1; return true;
}
const BUSY = 'The site is checking a lot of sign-ins right now. Wait a few seconds and try again.';

// Some things need the password typed again shortly beforehand, even on a signed-in, unlocked session:
// adding a Face ID device, changing the reset email, downloading a backup. Ten minutes covers doing it right after signing in.
const PROVED_MS = 10 * 60 * 1000;
const proved = (req) => { req.session.pwAt = Date.now(); };
const provedRecently = (req) => Boolean(req.session && req.session.pwAt && Date.now() - req.session.pwAt < PROVED_MS);
/** Check the signed-in person's password, counting wrong tries. Returns null when right, otherwise what to tell them. */
function wrongPassword(req, password) {
  if (lockedOut(req.user.username)) return 'Too many wrong passwords. Wait 15 minutes and try again.';
  if (!spendCheck()) return BUSY;
  if (!auth.checkLogin(req.user.username, password)) { noteFailure(req.user.username); return 'That password is not right.'; }
  FAILS.delete(nameKey(req.user.username));
  return null;
}

// Only allow redirects back into this site.
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/');

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', next: safeNext(req.query.next), username: '', error: null });
});

router.post('/login', loginLimiter, (req, res, next) => {
  const target = safeNext(req.body.next);
  if (lockedOut(req.body.username)) {
    return res.status(429).render('login', {
      title: 'Sign in', next: target, username: String(req.body.username || '').slice(0, 60),
      error: 'Too many wrong passwords for this username. Wait 15 minutes and try again, or ask an admin to reset it.',
    });
  }
  if (!spendCheck()) return res.status(429).render('login', { title: 'Sign in', next: target, username: String(req.body.username || '').slice(0, 60), error: BUSY });
  const user = auth.checkLogin(req.body.username, req.body.password);
  if (!user) {
    noteFailure(req.body.username);
    return res.status(401).render('login', {
      title: 'Sign in', next: target, username: String(req.body.username || '').slice(0, 60),
      error: 'Wrong username or password.',
    });
  }
  FAILS.delete(nameKey(req.body.username));
  // A password that is too easy to guess (chosen before the rules were tightened) has to be replaced before carrying on.
  const problem = passwords.problem(req.body.password, user);
  const weak = !user.must_change_password && problem;
  // The passwords this site hands out always pass the rules. One that does not was chosen by the person, so the clock on temporary passwords is not for it.
  if (problem && user.temp_set_at) { db.prepare('UPDATE users SET temp_set_at = NULL WHERE id = ?').run(user.id); user.temp_set_at = null; }
  // A temporary password that has sat unused too long no longer opens the account, even typed correctly.
  if (auth.tempExpired(user)) {
    return res.status(401).render('login', { title: 'Sign in', next: target, username: String(req.body.username || '').slice(0, 60),
      error: `That temporary password has expired. They last ${config.tempPasswordDays} days. Ask your admin for a new one.` });
  }
  if (weak) db.prepare('UPDATE users SET must_change_password = 1, temp_set_at = NULL WHERE id = ?').run(user.id);
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.seenAt = Date.now();
    req.session.fresh = true;
    req.session.csrf = auth.newCsrfToken();
    req.session.afterPassword = target;
    proved(req);
    if (weak) auth.flash(req, 'err', 'Your password is too easy to guess, so it needs replacing before you carry on.');
    res.redirect(user.must_change_password || weak ? '/account/password' : target);
  });
});

// The page calls this now and then while someone is typing or tapping, so that writing a long post or
// filling in a profile does not count as "left unused" and lock the site just as they press Save.
// The lock gate has already refreshed the idle clock by the time a request gets here.
router.get('/alive', (req, res) => res.status(req.user && !res.locals.locked ? 204 : 401).end());

// The page asks for this every half minute to keep the bell and the counts current. It is only the header.
router.get('/pulse', (req, res) => {
  if (!req.user || res.locals.locked) return res.status(401).end();
  res.render('pulse', { title: 'Alerts' });
});

// ---- Lock and unlock --------------------------------------------------------
// The page calls this when it finds the site was closed and opened again.
router.post('/lock', (req, res) => {
  if (req.user) req.session.locked = true;
  res.status(204).end();
});

const passkeyCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;

router.get('/unlock', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const target = safeNext(req.query.next);
  if (!req.session.locked) return res.redirect(target);
  res.render('unlock', { title: 'Welcome back', next: target, error: null, hasPasskey: passkeyCount(req.user.id) > 0 });
});

router.post('/unlock', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const target = safeNext(req.body.next);
  if (!req.session.locked) return res.redirect(target);
  const page = (status, error) => res.status(status).render('unlock', { title: 'Welcome back', next: target, error, hasPasskey: passkeyCount(req.user.id) > 0 });
  if (lockedOut(req.user.username)) return page(429, 'Too many wrong passwords. Wait 15 minutes and try again, or ask an admin to reset it.');
  if (!spendCheck()) return page(429, BUSY);
  if (!auth.checkLogin(req.user.username, req.body.password)) { noteFailure(req.user.username); return page(401, 'That password is not right.'); }
  FAILS.delete(nameKey(req.user.username));
  if (passwords.problem(req.body.password, req.user)) {
    db.prepare('UPDATE users SET must_change_password = 1, temp_set_at = NULL WHERE id = ?').run(req.user.id);
    auth.flash(req, 'err', 'Your password is too easy to guess, so it needs replacing before you carry on.');
  }
  auth.unlock(req); proved(req);
  res.redirect(target);
});

// ---- Forgot password --------------------------------------------------------

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: config.loginRateLimit, standardHeaders: true, legacyHeaders: false, keyGenerator: rateKey,
  handler: (req, res) => res.status(429).render('forgot', { title: 'Forgot password', sent: false, available: true, error: 'Too many attempts. Wait 15 minutes and try again.' }),
});
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const findReset = (token) => db.prepare(
  'SELECT r.user_id, u.username FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at > ? AND u.active = 1'
).get(hashToken(token), new Date().toISOString());

router.get('/forgot', (req, res) => {
  res.render('forgot', { title: 'Forgot password', sent: false, available: mail.isConfigured(), error: null });
});

router.post('/forgot', resetLimiter, (req, res) => {
  const who = clean(req.body.who, 120);
  // Same answer whether or not the account exists, so this page cannot be used to find usernames.
  const user = who ? db.prepare('SELECT * FROM users WHERE (username = ? OR email = ? COLLATE NOCASE) AND active = 1').get(who, who) : null;
  if (user && user.email && mail.isConfigured()) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at <= ?').run(user.id, new Date().toISOString());
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), user.id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
    mail.send([user.email], 'Reset your password',
      `Hi ${user.display_name},\n\nUse this link to choose a new password. It works once and expires in one hour.\n\n` +
      `${config.baseUrl}/reset/${token}\n\nIf you did not ask for this, ignore this email; your password has not changed.\n`);
  }
  res.render('forgot', { title: 'Forgot password', sent: true, available: mail.isConfigured(), error: null });
});

router.get('/reset/:token', (req, res) => {
  const found = findReset(req.params.token);
  res.status(found ? 200 : 404).render('reset', { title: 'Choose a new password', valid: Boolean(found), token: req.params.token, error: null });
});

router.post('/reset/:token', resetLimiter, (req, res) => {
  const found = findReset(req.params.token);
  if (!found) return res.status(404).render('reset', { title: 'Choose a new password', valid: false, token: '', error: null });
  const password = typeof req.body.password === 'string' ? req.body.password : ''; const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';
  let error = passwords.problem(password, db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(found.user_id));
  if (!error && password !== confirm) error = 'The two passwords do not match.';
  if (error) return res.status(400).render('reset', { title: 'Choose a new password', valid: true, token: req.params.token, error });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, temp_set_at = NULL WHERE id = ?').run(auth.hashPassword(password), found.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(found.user_id);
  auth.endSessions(found.user_id);                       // anyone still signed in as this person is signed out
  FAILS.delete(nameKey(found.username));
  auth.flash(req, 'ok', 'Password changed. Sign in with your new password.');
  res.redirect('/login');
});

// Typing the password again, for the things that ask for it (see provedRecently). Works as a plain form or from the page's own code.
router.post('/account/confirm', (req, res) => {
  const wantsJson = req.is('application/json');
  if (!req.user) return wantsJson ? res.status(401).json({ ok: false }) : res.redirect('/login');
  const error = wrongPassword(req, req.body.password);
  if (!error) proved(req);
  if (wantsJson) return res.status(error ? 401 : 200).json({ ok: !error, error: error || undefined });
  if (error) auth.flash(req, 'err', error);
  res.redirect(safeNext(req.body.next));
});

// The address password-reset links and status updates are sent to. Whoever controls it can reset the password,
// so changing it takes the password, not just an open session.
router.post('/account/email', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const email = clean(req.body.email, 120);
  const wrong = (email || null) === (req.user.email || null) ? null : wrongPassword(req, req.body.current);
  if (wrong) auth.flash(req, 'err', wrong === 'That password is not right.' ? 'Type your current password to change your email address.' : wrong);
  else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) auth.flash(req, 'err', 'That email address does not look right.');
  else {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || null, req.user.id);
    auth.flash(req, 'ok', email ? 'Email saved.' : 'Email removed.');
  }
  res.redirect('/account/password');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('portal.sid');
    res.redirect('/login');
  });
});

router.get('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login?next=/account/password');
  res.render('password', { title: 'Password and Face ID', error: null, passkeys: require('./passkeys').listFor(req.user.id) });
});

router.post('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const str = (v) => (typeof v === 'string' ? v : '');
  const current = str(req.body.current), password = str(req.body.password), confirm = str(req.body.confirm);
  let error = wrongPassword(req, current);
  if (error === 'That password is not right.') error = 'Current password is not right.';
  if (!error) error = passwords.problem(password, req.user);
  if (!error && password !== confirm) error = 'The two new passwords do not match.';
  if (!error && password === current) error = 'Choose a password different from the current one.';
  if (error) return res.status(400).render('password', { title: 'Password and Face ID', error, passkeys: require('./passkeys').listFor(req.user.id) });

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, temp_set_at = NULL WHERE id = ?')
    .run(auth.hashPassword(password), req.user.id);
  auth.endSessions(req.user.id, req.sessionID);          // other devices are signed out; this one stays in
  proved(req);
  const target = safeNext(req.session.afterPassword);
  delete req.session.afterPassword;
  auth.flash(req, 'ok', 'Password changed.');
  res.redirect(target);
});

module.exports = router;
module.exports.safeNext = safeNext;
module.exports.clearLoginFailures = () => FAILS.clear();
module.exports.provedRecently = provedRecently;
module.exports.proved = proved;
module.exports.lockedNames = () => [...FAILS.entries()].filter(([, f]) => f.n >= NAME_LIMIT && f.until > Date.now()).length;
