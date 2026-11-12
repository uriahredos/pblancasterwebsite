'use strict';
const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { canChange } = require('../changes');

const router = express.Router();

router.get('/', requireLogin, (req, res) => res.render('home', { title: 'Home' }));

router.get('/my', requireLogin, (req, res) => {
  const parts = db.prepare(
    `SELECT s.*, (SELECT group_concat(i.quantity || ' × ' || i.part_name, char(10))
                  FROM parts_items i WHERE i.submission_id = s.id) AS items
     FROM parts_submissions s WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 200`).all(req.user.id);
  const training = db.prepare(
    'SELECT * FROM training_requests WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  for (const row of [...parts, ...training]) row.can_change = canChange(row, req.user) && row.user_id === req.user.id;
  res.render('my', { title: 'My submissions', parts, training });
});

module.exports = router;
