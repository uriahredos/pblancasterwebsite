'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const crypto = require('crypto');
const mail = require('../mail');
const { clean } = require('../util');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateLimit,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
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
  const user = auth.checkLogin(req.body.username, req.body.password);
  if (!user) {
    noteFailure(req.body.username);
    return res.status(401).render('login', {
      title: 'Sign in', next: target, username: String(req.body.username || '').slice(0, 60),
      error: 'Wrong username or password.',
    });
  }
  FAILS.delete(nameKey(req.body.username));
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.csrf = auth.newCsrfToken();
    req.session.afterPassword = target;
    res.redirect(user.must_change_password ? '/account/password' : target);
  });
});

// ---- Forgot password --------------------------------------------------------

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: config.loginRateLimit, standardHeaders: true, legacyHeaders: false,
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
  const { password = '', confirm = '' } = req.body;
  let error = null;
  if (password.length < config.minPasswordLength) error = `The password must be at least ${config.minPasswordLength} characters.`;
  else if (password.length > 200) error = 'The password is too long.';
  else if (password !== confirm) error = 'The two passwords do not match.';
  if (error) return res.status(400).render('reset', { title: 'Choose a new password', valid: true, token: req.params.token, error });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword(password), found.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(found.user_id);
  auth.endSessions(found.user_id);                       // anyone still signed in as this person is signed out
  FAILS.delete(nameKey(found.username));
  auth.flash(req, 'ok', 'Password changed. Sign in with your new password.');
  res.redirect('/login');
});

// The address password-reset links and status updates are sent to.
router.post('/account/email', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const email = clean(req.body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) auth.flash(req, 'err', 'That email address does not look right.');
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
  res.render('password', { title: 'Change password', error: null });
});

router.post('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { current = '', password = '', confirm = '' } = req.body;
  let error = null;
  if (!auth.checkLogin(req.user.username, current)) error = 'Current password is not right.';
  else if (password.length < config.minPasswordLength) error = `New password must be at least ${config.minPasswordLength} characters.`;
  else if (password.length > 200) error = 'New password is too long.';
  else if (password !== confirm) error = 'The two new passwords do not match.';
  else if (password === current) error = 'Choose a password different from the current one.';
  if (error) return res.status(400).render('password', { title: 'Change password', error });

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(auth.hashPassword(password), req.user.id);
  auth.endSessions(req.user.id, req.sessionID);          // other devices are signed out; this one stays in
  const target = safeNext(req.session.afterPassword);
  delete req.session.afterPassword;
  auth.flash(req, 'ok', 'Password changed.');
  res.redirect(target);
});

module.exports = router;
module.exports.clearLoginFailures = () => FAILS.clear();
