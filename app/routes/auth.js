'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');

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

// Only allow redirects back into this site.
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/');

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', next: safeNext(req.query.next), username: '', error: null });
});

router.post('/login', loginLimiter, (req, res, next) => {
  const user = auth.checkLogin(req.body.username, req.body.password);
  const target = safeNext(req.body.next);
  if (!user) {
    return res.status(401).render('login', {
      title: 'Sign in', next: target, username: String(req.body.username || '').slice(0, 60),
      error: 'Wrong username or password.',
    });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.csrf = auth.newCsrfToken();
    req.session.afterPassword = target;
    res.redirect(user.must_change_password ? '/account/password' : target);
  });
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
  const target = safeNext(req.session.afterPassword);
  delete req.session.afterPassword;
  auth.flash(req, 'ok', 'Password changed.');
  res.redirect(target);
});

module.exports = router;
