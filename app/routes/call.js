'use strict';
// Calls: video in support threads, and voice or video between two people from their private conversation. This only helps two phones find each other: the pictures and sound go straight between
// them (or through Cloudflare's relay when they cannot), never through this site, and nothing is recorded or kept.
const express = require('express');
const db = require('../db');
const live = require('../live');
const calls = require('../calls');
const ice = require('../ice');
const dm = require('../messages');
const push = require('../push');
const { requirePerm } = require('../auth');

const router = express.Router();
const MAX_SIGNAL = 20000;                       // characters in one setup message (a description of a phone's video, a few thousand)
const KINDS = new Set(['offer', 'answer', 'candidate']);
const RING_AGAIN_MS = 6000;

const fail = (res, code, error) => res.status(code).json({ error });
const nameOf = (c) => (c ? c.name : '');

/** The support thread this is about, or null (after answering). */
function thread(req, res) {
  const t = /^\d+$/.test(req.params.id) ? db.prepare(
    'SELECT t.id, s.kind FROM forum_threads t JOIN forum_sections s ON s.id = t.section_id WHERE t.id = ?').get(req.params.id) : null;
  if (!t || t.kind !== 'support') { fail(res, 404, 'Video calls are for tech-support discussions.'); return null; }
  return { key: t.id };
}

/** The private conversation this is about, if this person is one of its two people. */
function conversation(req, res) {
  const t = dm.forUser(req.params.id, req.user.id);
  if (!t) { fail(res, 404, 'That conversation is not here.'); return null; }
  return { key: `dm:${t.id}`, dm: t };
}

/** The same six steps for both kinds of place a call can happen. */
function mount(base, perm, place) {
  const use = requirePerm(perm);

  // The servers a phone should use. Asked first, so the phone is ready before anyone can send it a setup message.
  router.post(`${base}/ice`, use, async (req, res) => {
    const p = place(req, res); if (!p) return;
    if (!calls.allow(req.user.id, 'ice', 30, 60 * 60 * 1000)) return fail(res, 429, 'Too many calls started. Wait a little and try again.');
    const { servers, relay } = await ice.iceServers();
    res.json({ servers, relay });
  });

  router.post(`${base}/start`, use, (req, res) => {
    const p = place(req, res); if (!p) return;
    const mode = req.body.mode === 'audio' ? 'audio' : 'video';
    if (p.dm) {
      // Calling a person: they must be able to answer, and the two of them are the only ones who can be in it.
      if (!dm.reachable(p.dm.other.id)) return fail(res, 409, `${p.dm.other.display_name} cannot take calls here.`);
      const now = calls.get(p.key);
      if (now && now.host.id !== req.user.id) return fail(res, 409, `${now.host.name} is already calling you here. Answer that call instead.`);
      if (!now && !calls.allow(req.user.id, 'ring', 20, 10 * 60 * 1000)) return fail(res, 429, 'That is a lot of calls. Wait a little and try again.');
    }
    const r = calls.start(p.key, req.user, p.dm ? { mode, ring: p.dm.other.id } : {});
    if (r.error) return fail(res, 409, 'Someone else is already on a video call in this discussion.');
    if (p.dm && r.fresh) {
      const what = r.call.mode === 'audio' ? 'voice' : 'video';
      dm.add(p.dm.id, req.user.id, r.call.mode === 'audio' ? 'Voice call' : 'Video call', 'call');     // a line in the conversation, so a missed call is seen
      live.publish([p.key, `inbox:${p.dm.user_a}`, `inbox:${p.dm.user_b}`]);
      const ring = r.call.ring;
      live.sendTo(p.dm.other.id, `inbox:${p.dm.other.id}`, 'ring', { key: p.key, id: p.dm.id, from: req.user.display_name, fromId: req.user.id, mode: r.call.mode, token: ring.token });
      // The phone rings the way a phone does: the alert comes again every few seconds until it is answered, declined or given up on.
      const alert = () => push.notify([p.dm.other.id], 'call', { title: `${req.user.display_name} is calling`, body: `Incoming ${what} call`, url: `/messages/c/${p.dm.id}?answer=${ring.token}`,
        extra: { call: p.dm.id, token: ring.token, mode: r.call.mode } });
      alert();
      const again = setInterval(() => { const c = calls.get(p.key); if (c && c.ring && c.ring.token === ring.token) alert(); else clearInterval(again); }, RING_AGAIN_MS);
      again.unref();
    }
    res.json({ ok: true, role: 'host', waiting: !r.call.guest, mode: r.call.mode });
  });

  router.post(`${base}/join`, use, (req, res) => {
    const p = place(req, res); if (!p) return;
    const r = calls.join(p.key, req.user);
    if (r.error === 'none') return fail(res, 404, 'That call has ended.');
    if (r.error === 'own') return fail(res, 409, 'You started this call.');
    if (r.error === 'full') return fail(res, 409, 'That call already has two people in it.');
    // The one who started it is told, and makes the offer.
    live.sendTo(r.call.host.id, calls.topic(p.key), 'signal', { type: 'joined', name: req.user.display_name });
    res.json({ ok: true, role: 'guest', host: nameOf(r.call.host), mode: r.call.mode });
  });

  // Setup messages between the two phones. Only the two people in the call may send, and each goes only to the other one.
  router.post(`${base}/signal`, use, (req, res) => {
    const p = place(req, res); if (!p) return;
    if (!calls.allow(req.user.id, 'signal', 600, 10 * 60 * 1000)) return fail(res, 429, 'Too many messages.');
    const kind = String(req.body.kind || '');
    const raw = String(req.body.data || '');
    if (!KINDS.has(kind) || !raw || raw.length > MAX_SIGNAL) return fail(res, 400, 'That message is not valid.');
    let data;
    try { data = JSON.parse(raw); } catch (e) { return fail(res, 400, 'That message is not valid.'); }
    if (!data || typeof data !== 'object' || ((kind === 'offer' || kind === 'answer') && typeof data.sdp !== 'string')) return fail(res, 400, 'That message is not valid.');
    const me = calls.peerOf(p.key, req.user.id);
    if (!me.in) return fail(res, 403, 'You are not in this call.');
    if (!me.peer) return fail(res, 409, 'There is nobody on the other end yet.');
    live.sendTo(me.peer.id, calls.topic(p.key), 'signal', { type: kind, data });
    res.json({ ok: true });
  });

  // "Still here", every 20 seconds while a call is open. Also how a page learns the call has ended.
  router.post(`${base}/beat`, use, (req, res) => {
    const p = place(req, res); if (!p) return;
    const b = calls.beat(p.key, req.user.id);
    res.json({ active: Boolean(b), peer: Boolean(b && b.peer) });
  });

  router.post(`${base}/leave`, use, (req, res) => {
    const p = place(req, res); if (!p) return;
    calls.leave(p.key, req.user.id);
    res.json({ ok: true });
  });
}

mount('/call/t/:id', 'forum.use', thread);
mount('/call/dm/:id', 'messages.use', conversation);

// When the ringing stops, the phones that were ringing are told: the alert goes away, and an unanswered call leaves a note behind.
calls.onRingEnd((key, c, ring, reason) => {
  const id = Number(String(key).slice(3));
  const missed = reason === 'noanswer' || reason === 'cancelled';
  push.notify([ring.userId], 'call', { title: missed ? `Missed ${c.mode === 'audio' ? 'voice' : 'video'} call from ${c.host.name}` : 'Call ended', body: missed ? 'Tap to open the conversation.' : '',
    url: `/messages/c/${id}`, extra: { call: id, ended: reason, quiet: true, ring: false } });
});

// Declining from the phone's own alert, where there is no page to send a form from. The address carries the ring's own
// unguessable token, which only the person being rung is ever sent.
router.get('/call/ring/:token/decline', requirePerm('messages.use'), (req, res) => {
  const mine = calls.ringingFor(req.user.id).find((c) => c.token === req.params.token);
  if (mine) calls.decline(mine.key, req.user.id);
  res.json({ ok: Boolean(mine) });
});

// "Not now" on a ringing call.
router.post('/call/dm/:id/decline', requirePerm('messages.use'), (req, res) => {
  const p = conversation(req, res); if (!p) return;
  calls.decline(p.key, req.user.id);
  res.json({ ok: true });
});

// Calls ringing for this person: asked when a page opens, in case the ring was sent before it was listening.
router.get('/call/ringing', requirePerm('messages.use'), (req, res) => {
  res.json({ calls: calls.ringingFor(req.user.id).map((c) => ({ ...c, id: Number(c.key.slice(3)) })) });
});

module.exports = router;
