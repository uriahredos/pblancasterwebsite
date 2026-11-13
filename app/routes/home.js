'use strict';
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { canChange } = require('../changes');
const certs = require('../certs');
const { localDate } = require('../util');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  // Announcements this person has not read yet sit at the top of the home page.
  const notices = require('./announcements').forUser(req.user.id).filter((n) => !n.read_at);
  const today = localDate();
  const myCerts = db.prepare('SELECT * FROM certifications WHERE user_id = ? AND expires_on IS NOT NULL').all(req.user.id)
    .map((c) => certs.decorate(c, today)).filter((c) => c.status === 'expired' || (c.status === 'soon' && c.days <= 30));
  res.render('home', { title: 'Home', notices, myCerts });
});

router.get('/my', requireLogin, (req, res) => {
  const parts = db.prepare(
    `SELECT s.*, (SELECT group_concat(i.quantity || ' × ' || i.part_name, char(10))
                  FROM parts_items i WHERE i.submission_id = s.id) AS items
     FROM parts_submissions s WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 200`).all(req.user.id);
  const training = db.prepare(
    'SELECT * FROM training_requests WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  for (const row of parts) row.can_change = canChange(row, req.user, 'parts');
  for (const row of training) row.can_change = canChange(row, req.user, 'training');
  const attended = db.prepare(
    `SELECT t.title, t.session_date, t.location FROM training_attendance a JOIN training_sessions t ON t.id = a.session_id
     WHERE a.user_id = ? AND t.completed_at IS NOT NULL ORDER BY t.session_date DESC LIMIT 100`).all(req.user.id);
  const myCerts = db.prepare('SELECT * FROM certifications WHERE user_id = ? ORDER BY expires_on IS NULL, expires_on').all(req.user.id).map((c) => certs.decorate(c));
  const inspections = db.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM inspection_photos p WHERE p.inspection_id = i.id) AS photos FROM inspections i
     WHERE i.user_id = ? ORDER BY i.id DESC LIMIT 20`).all(req.user.id);
  res.render('my', { title: 'My submissions', parts, training, attended, myCerts, inspections });
  // They have now seen any status changes.
  db.prepare('UPDATE parts_submissions SET unseen = 0 WHERE user_id = ? AND unseen = 1').run(req.user.id);
  db.prepare('UPDATE training_requests SET unseen = 0 WHERE user_id = ? AND unseen = 1').run(req.user.id);
});

module.exports = router;
