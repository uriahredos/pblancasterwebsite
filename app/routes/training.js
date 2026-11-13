'use strict';
const express = require('express');
const db = require('../db');
const mail = require('../mail');
const { requireLogin, requirePerm, forbidden, flash } = require('../auth');
const access = require('../permissions');
const { clean, localDate } = require('../util');
const config = require('../config');
const { canChange, logChange } = require('../changes');

const router = express.Router();

function readForm(body) {
  const values = {
    description: clean(body.description, 4000),
    wants_contact: body.wants_contact,
    is_private: body.is_private,
  };
  const errors = [];
  if (!values.description) errors.push('Describe the training you would like.');
  if (!['yes', 'no'].includes(values.wants_contact)) errors.push('Choose whether you want to be contacted.');
  if (!['yes', 'no'].includes(values.is_private)) errors.push('Choose whether to keep this private.');
  return { values, errors };
}

router.get('/training', requirePerm('training.submit'), (req, res) => {
  res.render('training', { title: 'Training request', values: {}, errors: [], editing: null });
});

router.post('/training', requirePerm('training.submit'), (req, res) => {
  const { values, errors } = readForm(req.body);
  if (errors.length) return res.status(400).render('training', { title: 'Training request', values, errors, editing: null });

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
  res.redirect('/my?sent=training');
});

// ---- Edit or cancel a request ---------------------------------------------

const backTo = (user, row) => (user.id === row.user_id ? '/my' : `/admin/training/${row.id}`);

function loadChangeable(req, res) {
  const row = /^\d+$/.test(req.params.id) ? db.prepare('SELECT t.*, u.display_name FROM training_requests t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(req.params.id) : null;
  if (!row) { res.status(404).render('error', { title: 'Page not found', message: 'That request does not exist.' }); return null; }
  const mayManage = access.can(req.user, 'training.manage') && access.canSee(req.user, row.user_id);
  if (row.user_id !== req.user.id && !mayManage) { forbidden(res); return null; }
  if (!canChange(row, req.user, 'training')) {
    res.status(403).render('error', {
      title: 'This request can no longer be changed',
      message: `Requests can be changed for ${config.editWindowHours} hours, and only until someone has acted on them. Ask an admin to correct it.`,
    });
    return null;
  }
  return row;
}

router.get('/training/:id/edit', requireLogin, (req, res) => {
  const row = loadChangeable(req, res);
  if (!row) return;
  res.render('training', {
    title: 'Edit training request', errors: [], editing: row, back: req.query.back === 'topics' ? 'topics' : '',
    values: { description: row.description, wants_contact: row.wants_contact ? 'yes' : 'no', is_private: row.is_private ? 'yes' : 'no' },
  });
});

router.post('/training/:id/edit', requireLogin, (req, res) => {
  const row = loadChangeable(req, res);
  if (!row) return;
  const { values, errors } = readForm(req.body);
  const back = req.body.back === 'topics' ? 'topics' : '';
  if (errors.length) return res.status(400).render('training', { title: 'Edit training request', values, errors, editing: row, back });
  db.transaction(() => {
    logChange('training', row.id, req.user.id, 'edited', {
      description: row.description, wants_contact: row.wants_contact, is_private: row.is_private,
    });
    db.prepare('UPDATE training_requests SET description = ?, wants_contact = ?, is_private = ?, edited_at = ? WHERE id = ?')
      .run(values.description, values.wants_contact === 'yes' ? 1 : 0, values.is_private === 'yes' ? 1 : 0, new Date().toISOString(), row.id);
  })();
  flash(req, 'ok', 'Request updated.');
  res.redirect(back === 'topics' ? `/training/topics#t${row.id}` : backTo(req.user, row));
});

router.post('/training/:id/cancel', requireLogin, (req, res) => {
  const row = loadChangeable(req, res);
  if (!row) return;
  db.transaction(() => {
    logChange('training', row.id, req.user.id, 'cancelled', null);
    db.prepare('UPDATE training_requests SET cancelled_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  })();
  flash(req, 'ok', 'Request cancelled.');
  res.redirect(backTo(req.user, row));
});

module.exports = router;
