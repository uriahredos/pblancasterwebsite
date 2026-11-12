'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');

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

function createUser({ username, displayName, email, password, role = 'user', reviewer = false }) {
  const info = db.prepare(
    `INSERT INTO users (username, display_name, email, password_hash, role, can_review_complaints, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(username, displayName, email || null, hashPassword(password), role, reviewer ? 1 : 0, new Date().toISOString());
  return info.lastInsertRowid;
}

/** Attach req.user from the session on every request. */
function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    const user = userById.get(req.session.userId);
    if (user && user.active) req.user = user;
    else delete req.session.userId;
  }
  res.locals.user = req.user;
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

function requireAdmin(req, res, next) {
  requireLogin(req, res, () => (req.user.role === 'admin' ? next() : forbidden(res)));
}

function requireReviewer(req, res, next) {
  requireLogin(req, res, () => (req.user.can_review_complaints ? next() : forbidden(res)));
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

function flash(req, type, text) {
  req.session.flash = { type, text };
}

module.exports = {
  hashPassword, checkLogin, tempPassword, createUser, loadUser,
  requireLogin, requireAdmin, requireReviewer, forbidden, newCsrfToken, verifyCsrf, flash,
};
