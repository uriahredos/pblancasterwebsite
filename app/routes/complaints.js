'use strict';
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { requireLogin, requirePerm, flash } = require('../auth');
const requireReviewer = requirePerm('complaints.review');
const { clean, localDate, labels } = require('../util');

const router = express.Router();

// ---------------------------------------------------------------------------
// Anonymity rules for this file: never write req.user, req.ip, a time of day or
// the tracking code to the database, the session, the log or an email.
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function newTrackingCode() {
  let out = '';
  while (out.length < 12) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) out += CODE_ALPHABET[b % 31]; // 248 = 8 * 31, keeps it unbiased
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}
const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code) => crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');

// Flood guard held in memory only: user id -> count for today. Never stored.
let limitDay = '';
let limitCounts = new Map();
function overDailyLimit(userId) {
  const today = localDate();
  if (today !== limitDay) { limitDay = today; limitCounts = new Map(); }
  const n = (limitCounts.get(userId) || 0) + 1;
  limitCounts.set(userId, n);
  return n > config.complaintDailyLimit;
}

const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: false, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('complaint_status', {
    title: 'Check a complaint', code: '', complaint: null, error: 'Too many tries. Wait 15 minutes and try again.',
  }),
});

router.get('/complaint', requirePerm('complaints.submit'), (req, res) => {
  res.render('complaint', { title: 'Anonymous complaint', values: {}, errors: [] });
});

router.post('/complaint', requirePerm('complaints.submit'), (req, res) => {
  const values = {
    category: req.body.category,
    description: clean(req.body.description, 6000),
    occurred_text: clean(req.body.occurred_text, 300),
  };
  const errors = [];
  if (!labels.complaintCategory[values.category]) errors.push('Choose a category.');
  if (!values.description) errors.push('Describe the problem.');
  if (!errors.length && overDailyLimit(req.user.id)) {
    errors.push('The daily limit for complaints has been reached. Please try again tomorrow.');
  }
  if (errors.length) return res.status(400).render('complaint', { title: 'Anonymous complaint', values, errors });

  const code = newTrackingCode();
  db.prepare(
    `INSERT INTO complaints (id, category, description, occurred_text, tracking_code_hash, created_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomBytes(8).toString('hex'), values.category, values.description,
    values.occurred_text || null, hashCode(code), localDate());

  // Shown once, straight in this response. It is not kept anywhere on the server.
  res.render('complaint_done', { title: 'Complaint sent', code });
});

router.get('/complaint/status', requireLogin, (req, res) => {
  res.render('complaint_status', { title: 'Check a complaint', code: '', complaint: null, error: null });
});

router.post('/complaint/status', requireLogin, lookupLimiter, (req, res) => {
  const code = normalizeCode(req.body.code);
  const complaint = code.length === 12
    ? db.prepare('SELECT category, status, reviewer_reply, created_date FROM complaints WHERE tracking_code_hash = ?').get(hashCode(code))
    : null;
  res.status(complaint ? 200 : 404).render('complaint_status', {
    title: 'Check a complaint', code: '', complaint: complaint || null,
    error: complaint ? null : 'No complaint matches that code. Check it and try again.',
  });
});

// ---- Reviewers only -------------------------------------------------------

router.get('/admin/complaints', requireReviewer, (req, res) => {
  const status = labels.complaintStatus[req.query.status] ? req.query.status : '';
  const rows = db.prepare(
    `SELECT id, category, description, status, created_date FROM complaints
     ${status ? 'WHERE status = ?' : ''} ORDER BY created_date DESC, id LIMIT 500`
  ).all(...(status ? [status] : []));
  res.render('admin_complaints', { title: 'Complaints', rows, status });
});

router.get('/admin/complaints/:id', requireReviewer, (req, res) => {
  const c = db.prepare('SELECT id, category, description, occurred_text, status, reviewer_reply, created_date FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).render('error', { title: 'Page not found', message: 'That complaint does not exist.' });
  res.render('admin_complaint_detail', { title: 'Complaint', c });
});

router.post('/admin/complaints/:id', requireReviewer, (req, res) => {
  const status = req.body.status;
  if (!labels.complaintStatus[status]) return res.redirect(`/admin/complaints/${req.params.id}`);
  db.prepare('UPDATE complaints SET status = ?, reviewer_reply = ? WHERE id = ?')
    .run(status, clean(req.body.reviewer_reply, 4000) || null, req.params.id);
  flash(req, 'ok', 'Complaint updated.');
  res.redirect(`/admin/complaints/${req.params.id}`);
});

module.exports = router;
