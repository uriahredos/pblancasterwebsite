'use strict';
// Face ID, fingerprint, Windows Hello and the like, through the browser's built-in "passkey"
// feature. The face or fingerprint never leaves the device: the device only proves to the site
// that its owner unlocked it, using a key pair made for this site alone.
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const activity = require('../activity');
const { clean } = require('../util');

const router = express.Router();
const MAX_PER_PERSON = 10;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Math.max(config.loginRateLimit * 3, 30), standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'Too many attempts. Wait 15 minutes and try again.' }),
});

// The site's own address, as the browser sees it. A passkey only ever works on the address it was made on.
function site(req) {
  const here = `${req.protocol}://${req.get('host')}`;
  const origins = [...new Set([here, process.env.BASE_URL ? config.baseUrl : here])];
  return { rpID: String(req.get('host')).replace(/:\d+$/, ''), origins, rpIDs: [...new Set(origins.map((o) => new URL(o).hostname))] };
}

const listFor = (userId) => db.prepare('SELECT id, device, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id').all(userId);
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

// ---- Setting it up on a device (signed in and unlocked) ----------------------

router.post('/passkey/register/options', auth.requireLogin, async (req, res, next) => {
  try {
    const mine = db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').all(req.user.id);
    if (mine.length >= MAX_PER_PERSON) return fail(res, 400, `You already have ${MAX_PER_PERSON} devices set up. Remove one first.`);
    const options = await generateRegistrationOptions({
      rpName: 'Pye-Barker Employee Portal', rpID: site(req).rpID,
      userName: req.user.username, userDisplayName: req.user.display_name, userID: Buffer.from(`user-${req.user.id}`),
      attestationType: 'none',
      excludeCredentials: mine.map((c) => ({ id: c.credential_id, transports: c.transports ? c.transports.split(',') : undefined })),
      // "platform": the phone's or computer's own Face ID / fingerprint, not a separate security key.
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    });
    req.session.pkChallenge = { c: options.challenge, at: Date.now(), kind: 'register' };
    res.json({ ok: true, options });
  } catch (e) { next(e); }
});

const challengeFor = (req, kind) => {
  const ch = req.session.pkChallenge;
  delete req.session.pkChallenge;                     // each challenge is good for one try
  return ch && ch.kind === kind && Date.now() - ch.at < 5 * 60 * 1000 ? ch.c : null;
};

router.post('/passkey/register/verify', auth.requireLogin, async (req, res, next) => {
  try {
    const expectedChallenge = challengeFor(req, 'register');
    if (!expectedChallenge || !req.body.response) return fail(res, 400, 'That took too long. Try again.');
    const s = site(req);
    let result;
    try {
      result = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge, expectedOrigin: s.origins, expectedRPID: s.rpIDs, requireUserVerification: true });
    } catch (e) { return fail(res, 400, 'This device could not be set up. Try again.'); }
    if (!result.verified) return fail(res, 400, 'This device could not be set up. Try again.');
    const c = result.registrationInfo.credential;
    if (db.prepare('SELECT 1 FROM passkeys WHERE credential_id = ?').get(c.id)) return fail(res, 400, 'This device is already set up.');
    if (listFor(req.user.id).length >= MAX_PER_PERSON) return fail(res, 400, `You already have ${MAX_PER_PERSON} devices set up. Remove one first.`);
    const device = clean(req.body.device, 60) || 'This device';
    db.prepare('INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, c.id, Buffer.from(c.publicKey), c.counter || 0, (c.transports || []).join(',') || null, device, new Date().toISOString());
    activity.log(req.user, 'Face ID / fingerprint sign-in set up', device);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/passkey/:id/delete', auth.requireLogin, (req, res) => {
  const row = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id) : null;
  if (row) {
    db.prepare('DELETE FROM passkeys WHERE id = ?').run(row.id);
    activity.log(req.user, 'Face ID / fingerprint sign-in removed', row.device);
    auth.flash(req, 'ok', `${row.device} removed. It can no longer sign in with Face ID or a fingerprint.`);
  }
  res.redirect('/account/password');
});

// ---- Using it: on the sign-in page, or to unlock ------------------------------

router.post('/passkey/auth/options', limiter, async (req, res, next) => {
  try {
    // Unlocking: only this person's own devices will do. Signing in: the device says who it belongs to.
    const mine = req.user ? db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').all(req.user.id) : [];
    if (req.user && !mine.length) return fail(res, 400, 'Face ID or fingerprint sign-in is not set up for your account yet.');
    const options = await generateAuthenticationOptions({
      rpID: site(req).rpID, userVerification: 'required',
      allowCredentials: mine.map((c) => ({ id: c.credential_id, transports: c.transports ? c.transports.split(',') : undefined })),
    });
    req.session.pkChallenge = { c: options.challenge, at: Date.now(), kind: 'auth' };
    res.json({ ok: true, options });
  } catch (e) { next(e); }
});

router.post('/passkey/auth/verify', limiter, async (req, res, next) => {
  try {
    const NO = 'That did not work. Try again, or use your password.';
    const expectedChallenge = challengeFor(req, 'auth');
    const response = req.body.response;
    if (!expectedChallenge || !response || typeof response.id !== 'string') return fail(res, 400, 'That took too long. Try again.');
    const row = db.prepare('SELECT p.*, u.active, u.must_change_password FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = ?').get(response.id);
    if (!row || !row.active || (req.user && row.user_id !== req.user.id)) return fail(res, 401, NO);
    const s = site(req);
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: s.origins, expectedRPID: s.rpIDs, requireUserVerification: true,
        credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: row.transports ? row.transports.split(',') : undefined },
      });
    } catch (e) { return fail(res, 401, NO); }
    if (!result.verified) return fail(res, 401, NO);
    db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(result.authenticationInfo.newCounter, new Date().toISOString(), row.id);

    const target = require('./auth').safeNext(req.body.next);
    if (req.user) {                                   // unlocking a session that already knows who this is
      auth.unlock(req);
      return res.json({ ok: true, next: target });
    }
    req.session.regenerate((err) => {                 // signing in from scratch
      if (err) return next(err);
      req.session.userId = row.user_id;
      req.session.csrf = auth.newCsrfToken();
      req.session.afterPassword = target;
      auth.unlock(req);
      res.json({ ok: true, next: row.must_change_password ? '/account/password' : target });
    });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.listFor = listFor;
