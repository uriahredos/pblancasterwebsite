'use strict';
// Video calls in support threads. This only helps two phones find each other: the pictures and sound go straight between
// them (or through Cloudflare's relay when they cannot), never through this site, and nothing is recorded or kept.
const express = require('express');
const db = require('../db');
const live = require('../live');
const calls = require('../calls');
const ice = require('../ice');
const { requirePerm } = require('../auth');

const router = express.Router();
const use = requirePerm('forum.use');
const MAX_SIGNAL = 20000;                       // characters in one setup message (a description of a phone's video, a few thousand)
const KINDS = new Set(['offer', 'answer', 'candidate']);

const fail = (res, code, error) => res.status(code).json({ error });
const nameOf = (c) => (c ? c.name : '');

/** The support thread this is about, or null (after answering). Calls belong to tech-support threads only. */
function thread(req, res) {
  const t = /^\d+$/.test(req.params.id) ? db.prepare(
    'SELECT t.id, s.kind FROM forum_threads t JOIN forum_sections s ON s.id = t.section_id WHERE t.id = ?').get(req.params.id) : null;
  if (!t || t.kind !== 'support') { fail(res, 404, 'Video calls are for tech-support discussions.'); return null; }
  return t;
}

// The servers a phone should use. Asked first, so the phone is ready before anyone can send it a setup message.
router.post('/call/t/:id/ice', use, async (req, res) => {
  const t = thread(req, res); if (!t) return;
  if (!calls.allow(req.user.id, 'ice', 30, 60 * 60 * 1000)) return fail(res, 429, 'Too many calls started. Wait a little and try again.');
  const { servers, relay } = await ice.iceServers();
  res.json({ servers, relay });
});

router.post('/call/t/:id/start', use, (req, res) => {
  const t = thread(req, res); if (!t) return;
  const r = calls.start(t.id, req.user);
  if (r.error) return fail(res, 409, 'Someone else is already on a video call in this discussion.');
  res.json({ ok: true, role: 'host', waiting: !r.call.guest });
});

router.post('/call/t/:id/join', use, (req, res) => {
  const t = thread(req, res); if (!t) return;
  const r = calls.join(t.id, req.user);
  if (r.error === 'none') return fail(res, 404, 'That call has ended.');
  if (r.error === 'own') return fail(res, 409, 'You started this call.');
  if (r.error === 'full') return fail(res, 409, 'That call already has two people in it.');
  // The one who started it is told, and makes the offer.
  live.sendTo(r.call.host.id, calls.topic(t.id), 'signal', { type: 'joined', name: req.user.display_name });
  res.json({ ok: true, role: 'guest', host: nameOf(r.call.host) });
});

// Setup messages between the two phones. Only the two people in the call may send, and each goes only to the other one.
router.post('/call/t/:id/signal', use, (req, res) => {
  const t = thread(req, res); if (!t) return;
  if (!calls.allow(req.user.id, 'signal', 600, 10 * 60 * 1000)) return fail(res, 429, 'Too many messages.');
  const kind = String(req.body.kind || '');
  const raw = String(req.body.data || '');
  if (!KINDS.has(kind) || !raw || raw.length > MAX_SIGNAL) return fail(res, 400, 'That message is not valid.');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return fail(res, 400, 'That message is not valid.'); }
  if (!data || typeof data !== 'object' || ((kind === 'offer' || kind === 'answer') && typeof data.sdp !== 'string')) return fail(res, 400, 'That message is not valid.');
  const me = calls.peerOf(t.id, req.user.id);
  if (!me.in) return fail(res, 403, 'You are not in this call.');
  if (!me.peer) return fail(res, 409, 'There is nobody on the other end yet.');
  live.sendTo(me.peer.id, calls.topic(t.id), 'signal', { type: kind, data });
  res.json({ ok: true });
});

// "Still here", every 20 seconds while a call is open. Also how a page learns the call has ended.
router.post('/call/t/:id/beat', use, (req, res) => {
  const t = thread(req, res); if (!t) return;
  const b = calls.beat(t.id, req.user.id);
  res.json({ active: Boolean(b), peer: Boolean(b && b.peer) });
});

router.post('/call/t/:id/leave', use, (req, res) => {
  const t = thread(req, res); if (!t) return;
  calls.leave(t.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
