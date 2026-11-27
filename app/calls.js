'use strict';
// Calls: who is in the call for each place one can happen. A place is a support thread (its number) or a private
// conversation ("dm:" and its number). One call per place, two people (the one who started it and one who joined). A call
// in a private conversation also rings the other person, and is voice-only or video. Held in memory, like the live hub: a call is a moment, not a record. Nothing about a call is
// stored, and the video never passes through here at all.
const live = require('./live');
const { allow } = require('./allowance');

const STALE_MS = 60 * 1000;            // a person who has not said "still here" for this long has left
const MAX_MS = 2 * 60 * 60 * 1000;     // no call outlasts the credentials it was set up with

const RING_MS = 45 * 1000;             // how long a call to a person rings before it counts as not answered

const calls = new Map();               // key -> { host: {id, name, seen}, guest: {id, name, seen} | null, startedAt, mode, ring: {userId, until} | null, answered }
const keyOf = (k) => (typeof k === 'string' && /^dm:\d+$/.test(k) ? k : Number(k));
const topic = (k) => (typeof k === 'string' && k.indexOf('dm:') === 0 ? k : `thread:${k}`);

/** Stop the ringing on the other person's screens (answered, given up, declined or timed out). */
function stopRing(key, c) {
  if (!c || !c.ring) return;
  const to = c.ring.userId; c.ring = null;
  live.sendTo(to, `inbox:${to}`, 'ringend', { key: String(key) });
}

/** Take a call away and tell whoever needs to know. */
function drop(key, c) { stopRing(key, c); calls.delete(key); }
const changed = (threadId) => live.publish([topic(threadId)]);

/** Drop people who have gone quiet, and calls that have run their course. Returns true if anything changed. */
function prune(threadId, now = Date.now()) {
  const c = calls.get(threadId);
  if (!c) return false;
  if (c.ring && now > c.ring.until) {                       // nobody answered: the call ends and the caller is told
    drop(threadId, c);
    live.sendTo(c.host.id, topic(threadId), 'signal', { type: 'noanswer' });
    return true;
  }
  if (now - c.startedAt > MAX_MS || now - c.host.seen > STALE_MS) {
    drop(threadId, c);
    if (c.guest) live.sendTo(c.guest.id, topic(threadId), 'signal', { type: 'bye' });
    return true;
  }
  if (c.guest && now - c.guest.seen > STALE_MS) {
    c.guest = null;
    live.sendTo(c.host.id, topic(threadId), 'signal', { type: 'bye' });
    return true;
  }
  return false;
}

const timer = setInterval(() => { for (const id of [...calls.keys()]) if (prune(id)) changed(id); }, 5000);
timer.unref();

function get(threadId) { prune(keyOf(threadId)); return calls.get(keyOf(threadId)) || null; }

/** Start a call. Whoever already holds it may start again (their page was reloaded); anyone else is told it is taken. */
function start(threadId, user, opts = {}) {
  threadId = keyOf(threadId);
  const c = get(threadId);
  if (c && c.host.id !== user.id) return { error: 'busy' };
  const now = Date.now();
  const fresh = !c;
  calls.set(threadId, { host: { id: user.id, name: user.display_name, seen: now }, guest: c ? c.guest : null, startedAt: c ? c.startedAt : now,
    mode: c ? c.mode : opts.mode === 'audio' ? 'audio' : 'video', answered: c ? c.answered : false,
    ring: c ? c.ring : opts.ring ? { userId: opts.ring, until: now + RING_MS } : null });
  changed(threadId);
  return { call: calls.get(threadId), fresh };
}

function join(threadId, user) {
  threadId = keyOf(threadId);
  const c = get(threadId);
  if (!c) return { error: 'none' };
  if (c.host.id === user.id) return { error: 'own' };
  if (c.guest && c.guest.id !== user.id) return { error: 'full' };
  c.guest = { id: user.id, name: user.display_name, seen: Date.now() };
  c.answered = true; stopRing(threadId, c);
  changed(threadId);
  return { call: c };
}

/** Who is the other person in this call, if this person is in it. */
function peerOf(threadId, userId) {
  const c = get(threadId);
  if (!c) return { in: false };
  if (c.host.id === userId) return { in: true, role: 'host', peer: c.guest };
  if (c.guest && c.guest.id === userId) return { in: true, role: 'guest', peer: c.host };
  return { in: false };
}

function beat(threadId, userId) {
  const c = get(threadId);
  if (!c) return null;
  const me = c.host.id === userId ? c.host : c.guest && c.guest.id === userId ? c.guest : null;
  if (!me) return null;
  me.seen = Date.now();
  return { peer: Boolean(c.host.id === userId ? c.guest : c.host) };
}

/** Someone leaves. The one who started it ends the call for both; the one who joined just frees the place. */
function leave(threadId, userId) {
  threadId = keyOf(threadId);
  const c = get(threadId);
  if (!c) return false;
  if (c.host.id === userId) {
    drop(threadId, c);
    if (c.guest) live.sendTo(c.guest.id, topic(threadId), 'signal', { type: 'bye' });
  } else if (c.guest && c.guest.id === userId) {
    c.guest = null;
    live.sendTo(c.host.id, topic(threadId), 'signal', { type: 'bye' });
  } else return false;
  changed(threadId);
  return true;
}

/** The person being rung says no. The call ends and the caller is told. */
function decline(key, userId) {
  key = keyOf(key);
  const c = get(key);
  if (!c || !c.ring || c.ring.userId !== userId) return false;
  drop(key, c);
  live.sendTo(c.host.id, topic(key), 'signal', { type: 'declined' });
  changed(key);
  return true;
}

/** Calls ringing for this person right now. */
function ringingFor(userId) {
  const out = [];
  for (const key of [...calls.keys()]) { const c = get(key); if (c && c.ring && c.ring.userId === userId) out.push({ key: String(key), from: c.host.name, fromId: c.host.id, mode: c.mode }); }
  return out;
}

/** What a thread page needs to draw the call banner for this person. */
function viewFor(threadId, user) {
  const c = get(threadId);
  if (!c) return null;
  const mineHost = c.host.id === user.id, mineGuest = Boolean(c.guest && c.guest.id === user.id);
  return { hostName: c.host.name, mineHost, mineGuest, full: Boolean(c.guest) && !mineGuest && !mineHost, mode: c.mode, ringing: Boolean(c.ring && c.ring.userId === user.id) };
}

module.exports = { get, start, join, peerOf, beat, leave, decline, ringingFor, allow, viewFor, prune, topic, _calls: calls, _STALE_MS: STALE_MS };
