'use strict';
// Private messages: a conversation between two people that only they can read. A report is the one way anyone else sees
// one: it opens that single conversation to the people who review reports, and each time one is opened it is recorded.
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const dm = require('../messages');
const live = require('../live');
const push = require('../push');
const activity = require('../activity');
const { allow } = require('../allowance');
const { requirePerm, flash } = require('../auth');
const { clean } = require('../util');

const router = express.Router();
const use = requirePerm('messages.use');
const review = requirePerm('messages.review');
const isId = (v) => /^\d+$/.test(String(v));
const DOUBLE_POST_MS = 30 * 1000;
const asksForJson = (req) => req.get('x-requested-with') === 'fetch';
const notFound = (res) => res.status(404).render('error', { title: 'Page not found', message: 'That conversation is not here.' });
const topics = (t) => [`dm:${t.id}`, `inbox:${t.user_a}`, `inbox:${t.user_b}`];

// ---- Inbox and finding someone ---------------------------------------------------------------------

router.get('/messages', use, (req, res) => {
  const q = clean(req.query.q, 60);
  res.render('messages', { title: 'Messages', threads: dm.listFor(req.user.id), q, found: q ? dm.people(req.user.id, q) : [], me: req.user.id });
});

router.get('/messages/with/:id', use, (req, res) => {
  const other = isId(req.params.id) ? db.prepare('SELECT id, display_name, photo_path, job_title, active FROM users WHERE id = ?').get(req.params.id) : null;
  if (!other || !other.active || other.id === req.user.id) return notFound(res);
  const t = dm.find(req.user.id, other.id);
  if (t && db.prepare('SELECT 1 FROM dm_messages WHERE thread_id = ?').get(t.id)) return res.redirect(`/messages/c/${t.id}`);
  if (!dm.reachable(other.id)) return res.status(409).render('error', { title: 'Cannot message', message: `${other.display_name} does not have private messages, so a message would not reach them.` });
  res.render('messages_new', { title: `Message ${other.display_name}`, other, errors: [], values: {} });
});

// The first message creates the conversation.
router.post('/messages/with/:id', use, (req, res) => {
  const other = isId(req.params.id) ? db.prepare('SELECT id, display_name, photo_path, job_title, active FROM users WHERE id = ?').get(req.params.id) : null;
  if (!other || !other.active || other.id === req.user.id) return notFound(res);
  if (!dm.reachable(other.id)) return res.status(409).render('error', { title: 'Cannot message', message: `${other.display_name} does not have private messages, so a message would not reach them.` });
  const body = clean(req.body.body, 4000);
  if (!allow(req.user.id, 'dm', 60, 60 * 1000)) return res.status(429).render('messages_new', { title: `Message ${other.display_name}`, other, errors: ['That is a lot of messages at once. Wait a moment.'], values: {} });
  if (!body) return res.status(400).render('messages_new', { title: `Message ${other.display_name}`, other, errors: ['Write your message.'], values: {} });
  const t = dm.create(req.user.id, other.id);
  deliver(req, t, other.id, body);
  res.redirect(`/messages/c/${t.id}`);
});

// ---- A conversation -------------------------------------------------------------------------------

router.get('/messages/c/:id', use, (req, res) => {
  const t = dm.forUser(req.params.id, req.user.id);
  if (!t) return notFound(res);
  const read = dm.lastRead(t.id, req.user.id);
  const rows = dm.messages(t.id);
  dm.markRead(t.id, req.user.id);
  // Reading it clears it from the count shown around this very page.
  if (rows.some((m) => m.user_id !== req.user.id && !m.removed_at && m.id > read)) res.locals.badges.messages = Math.max(0, res.locals.badges.messages - 1);
  res.render('messages_thread', { title: t.other.display_name, t, rows, read, me: req.user.id, errors: [], canSend: dm.reachable(t.other.id) });
});

function deliver(req, t, otherId, body) {
  // The same message sent twice in a row (a double tap) is kept once.
  const last = db.prepare('SELECT user_id, body, created_at FROM dm_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(t.id);
  if (last && last.user_id === req.user.id && last.body === body && last.created_at > new Date(Date.now() - DOUBLE_POST_MS).toISOString()) return null;
  const id = dm.add(t.id, req.user.id, body);
  live.publish(topics(t));
  // No preview of the words: they would show on a locked screen.
  push.notify([otherId], 'message', { title: `${req.user.display_name} sent you a message`, body: 'Tap to read it.', url: `/messages/c/${t.id}` });
  return id;
}

router.post('/messages/c/:id/send', use, (req, res) => {
  const t = dm.forUser(req.params.id, req.user.id);
  if (!t) return notFound(res);
  const fail = (code, message) => (asksForJson(req) ? res.status(code).json({ error: message }) : (flash(req, 'err', message), res.redirect(`/messages/c/${t.id}`)));
  const body = clean(req.body.body, 4000);
  if (!dm.reachable(t.other.id)) return fail(409, `${t.other.display_name} cannot get messages any more.`);
  if (!body) return fail(400, 'Write your message.');
  if (!allow(req.user.id, 'dm', 60, 60 * 1000)) return fail(429, 'That is a lot of messages at once. Wait a moment.');
  deliver(req, t, t.other.id, body);
  if (asksForJson(req)) return res.json({ ok: true });
  res.redirect(`/messages/c/${t.id}#end`);
});

// Remove one of your own messages: neither person sees its words again, and the place it held stays. The words are kept
// out of sight so that removing something cannot undo a report: only someone reviewing a report of this conversation sees them.
router.post('/messages/m/:id/delete', use, (req, res) => {
  const m = isId(req.params.id) ? db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id) : null;
  const t = m && dm.forUser(m.thread_id, req.user.id);
  if (!m || !t || m.user_id !== req.user.id) return notFound(res);
  if (!m.removed_at) db.prepare('UPDATE dm_messages SET removed_at = ? WHERE id = ?').run(new Date().toISOString(), m.id);
  live.publish(topics(t));
  flash(req, 'ok', 'Message removed.');
  res.redirect(`/messages/c/${t.id}`);
});

// Report someone's message: this opens the conversation, and only this one, to the people who review reports.
router.post('/messages/m/:id/report', use, (req, res) => {
  const m = isId(req.params.id) ? db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id) : null;
  const t = m && dm.forUser(m.thread_id, req.user.id);
  if (!m || !t || m.user_id === req.user.id) return notFound(res);
  if (!allow(req.user.id, 'dm-report', 10, 60 * 60 * 1000)) { flash(req, 'err', 'Too many reports. Wait a little.'); return res.redirect(`/messages/c/${t.id}`); }
  // One open report per message. Reporting a later message is a new report, because a reviewer reads only up to the moment of each one.
  const open = db.prepare('SELECT 1 FROM dm_reports WHERE thread_id = ? AND reported_by = ? AND message_id = ? AND closed_at IS NULL').get(t.id, req.user.id, m.id);
  if (!open) db.prepare('INSERT INTO dm_reports (thread_id, message_id, reported_by, note, created_at) VALUES (?, ?, ?, ?, ?)').run(t.id, m.id, req.user.id, clean(req.body.note, 500) || null, new Date().toISOString());
  flash(req, 'ok', 'Reported. The people who review reports can now read this conversation, and nobody else.');
  res.redirect(`/messages/c/${t.id}`);
});

// ---- Reviewing reports --------------------------------------------------------------------------------

/**
 * Reports this person may handle: every office's for someone who sees them all, otherwise those from the people they look
 * after. Never one about a conversation they are in themselves: nobody reviews a report they made or one made about them.
 */
const visibleReports = (user, where = '') => db.prepare(
  `SELECT r.*, u.display_name AS reporter, t.user_a, t.user_b, ua.display_name AS name_a, ub.display_name AS name_b
   FROM dm_reports r JOIN users u ON u.id = r.reported_by JOIN dm_threads t ON t.id = r.thread_id
   JOIN users ua ON ua.id = t.user_a JOIN users ub ON ub.id = t.user_b ${where} ORDER BY (r.closed_at IS NOT NULL), r.created_at DESC LIMIT 200`).all()
  .filter((r) => r.user_a !== user.id && r.user_b !== user.id && access.canSee(user, r.reported_by));

router.get('/admin/message-reports', review, (req, res) => {
  res.render('admin_message_reports', { title: 'Reported messages', rows: visibleReports(req.user) });
});

router.get('/admin/message-reports/:id', review, (req, res) => {
  const r = isId(req.params.id) ? visibleReports(req.user, `WHERE r.id = ${Number(req.params.id)}`)[0] : null;
  if (!r) return notFound(res);
  // A closed report no longer opens the conversation: what is left is the record of who reported, who closed it and what was done.
  if (r.closed_at) return res.render('admin_message_report', { title: 'Reported conversation', r, rows: [] });
  // Opening it is recorded, here and in the activity log, so nobody reads a conversation without it being known.
  db.prepare('UPDATE dm_reports SET opened_by = ?, opened_at = ? WHERE id = ?').run(req.user.id, new Date().toISOString(), r.id);
  activity.log(req.user, 'Opened a reported private conversation', `Report ${r.id}: ${r.name_a} and ${r.name_b}`);
  res.render('admin_message_report', { title: 'Reported conversation', r, rows: dm.asReported(r.thread_id, r.created_at) });
});

router.post('/admin/message-reports/:id/close', review, (req, res) => {
  const r = isId(req.params.id) ? visibleReports(req.user, `WHERE r.id = ${Number(req.params.id)}`)[0] : null;
  if (!r) return notFound(res);
  db.prepare('UPDATE dm_reports SET closed_by = ?, closed_at = ?, outcome = ? WHERE id = ? AND closed_at IS NULL').run(req.user.id, new Date().toISOString(), clean(req.body.outcome, 500) || null, r.id);
  flash(req, 'ok', 'Report closed.');
  res.redirect('/admin/message-reports');
});

module.exports = router;
