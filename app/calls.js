'use strict';
// Video calls in support threads: who is in the call for each thread. One call per thread, two people (the one who started
// it and one who joined). Held in memory, like the live hub: a call is a moment, not a record. Nothing about a call is
// stored, and the video never passes through here at all.
const live = require('./live');

const STALE_MS = 60 * 1000;            // a person who has not said "still here" for this long has left
const MAX_MS = 2 * 60 * 60 * 1000;     // no call outlasts the credentials it was set up with

const calls = new Map();               // threadId -> { host: {id, name, seen}, guest: {id, name, seen} | null, startedAt }
const topic = (threadId) => `thread:${threadId}`;
const changed = (threadId) => live.publish([topic(threadId)]);

/** Drop people who have gone quiet, and calls that have run their course. Returns true if anything changed. */
function prune(threadId, now = Date.now()) {
  const c = calls.get(threadId);
  if (!c) return false;
  if (now - c.startedAt > MAX_MS || now - c.host.seen > STALE_MS) {
    calls.delete(threadId);
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

const timer = setInterval(() => { for (const id of [...calls.keys()]) if (prune(id)) changed(id); }, 15000);
timer.unref();

function get(threadId) { prune(Number(threadId)); return calls.get(Number(threadId)) || null; }

/** Start a call. Whoever already holds it may start again (their page was reloaded); anyone else is told it is taken. */
function start(threadId, user) {
  threadId = Number(threadId);
  const c = get(threadId);
  if (c && c.host.id !== user.id) return { error: 'busy' };
  const now = Date.now();
  calls.set(threadId, { host: { id: user.id, name: user.display_name, seen: now }, guest: c ? c.guest : null, startedAt: c ? c.startedAt : now });
  changed(threadId);
  return { call: calls.get(threadId) };
}

function join(threadId, user) {
  threadId = Number(threadId);
  const c = get(threadId);
  if (!c) return { error: 'none' };
  if (c.host.id === user.id) return { error: 'own' };
  if (c.guest && c.guest.id !== user.id) return { error: 'full' };
  c.guest = { id: user.id, name: user.display_name, seen: Date.now() };
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
  threadId = Number(threadId);
  const c = get(threadId);
  if (!c) return false;
  if (c.host.id === userId) {
    calls.delete(threadId);
    if (c.guest) live.sendTo(c.guest.id, topic(threadId), 'signal', { type: 'bye' });
  } else if (c.guest && c.guest.id === userId) {
    c.guest = null;
    live.sendTo(c.host.id, topic(threadId), 'signal', { type: 'bye' });
  } else return false;
  changed(threadId);
  return true;
}

// A simple per-person allowance, so a stuck page cannot hammer the relay provider or flood the stream.
const used = new Map();
function allow(userId, kind, max, windowMs, now = Date.now()) {
  const key = `${kind}:${userId}`;
  const hits = (used.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { used.set(key, hits); return false; }
  hits.push(now); used.set(key, hits);
  if (used.size > 5000) for (const [k, v] of used) if (!v.some((t) => now - t < windowMs)) used.delete(k);
  return true;
}

/** What a thread page needs to draw the call banner for this person. */
function viewFor(threadId, user) {
  const c = get(threadId);
  if (!c) return null;
  const mineHost = c.host.id === user.id, mineGuest = Boolean(c.guest && c.guest.id === user.id);
  return { hostName: c.host.name, mineHost, mineGuest, full: Boolean(c.guest) && !mineGuest && !mineHost };
}

module.exports = { get, start, join, peerOf, beat, leave, allow, viewFor, prune, topic, _calls: calls, _STALE_MS: STALE_MS };
