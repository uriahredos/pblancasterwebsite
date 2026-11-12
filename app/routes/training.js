'use strict';
const express = require('express');
const db = require('../db');
const mail = require('../mail');
const { requireLogin, flash } = require('../auth');
const { clean, localDate } = require('../util');

const router = express.Router();

router.get('/training', requireLogin, (req, res) => {
  res.render('training', { title: 'Training request', values: {}, errors: [] });
});

router.post('/training', requireLogin, (req, res) => {
  const values = {
    description: clean(req.body.description, 4000),
    wants_contact: req.body.wants_contact,
    is_private: req.body.is_private,
  };
  const errors = [];
  if (!values.description) errors.push('Describe the training you would like.');
  if (!['yes', 'no'].includes(values.wants_contact)) errors.push('Choose whether you want to be contacted.');
  if (!['yes', 'no'].includes(values.is_private)) errors.push('Choose whether to keep this private.');
  if (errors.length) return res.status(400).render('training', { title: 'Training request', values, errors });

  const now = new Date();
  const wantsContact = values.wants_contact === 'yes';
  const isPrivate = values.is_private === 'yes';
  const info = db.prepare(
    `INSERT INTO training_requests (user_id, description, wants_contact, is_private, created_at, created_local_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, values.description, wantsContact ? 1 : 0, isPrivate ? 1 : 0, now.toISOString(), localDate(now));

  mail.notifyTraining({
    id: info.lastInsertRowid, name: req.user.display_name, description: values.description, wantsContact, isPrivate,
  });
  flash(req, 'ok', 'Training request sent. Thank you.');
  res.redirect('/my');
});

module.exports = router;
