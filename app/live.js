'use strict';
// Live updates. A page that wants to stay current (a discussion thread, the list of threads) opens one long-lived
// request to /live/stream and says which topics it cares about. When something changes, the site sends a short
// "this changed" note and the page fetches its own fresh copy the ordinary way, so what someone may see is still
// decided by the normal page routes and nothing private travels down the stream.
//
// The hub lives in this process's memory, which is right for this site (one server, one database file). If the site is
// ever run as several servers, this is the part that would need a shared channel between them.
const db = require('./db');

const MAX_PER_USER = 16;       // every open page listens for calls and messages, and some listen for their own content too
const MAX_TOTAL = 1000;
const BEAT_MS = 25000;         // a quiet line keeps proxies from closing the connection, and is when we re-check the session
const TOPIC = /^(forum|thread:\d+|dm:\d+|inbox:\d+)$/;

const streams = new Set();     // { res, userId, sid, store, lockAfter, topics:Set }

/** Parse "forum,thread:42" into a set of valid topics (at most 4); null if anything is off. */
function parseTopics(text) {
  const list = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.length > 4 || !list.every((t) => TOPIC.test(t))) return null;
  return new Set(list);
}

function send(entry, event, data) {
  try { entry.res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`); return true; } catch (e) { drop(entry); return false; }
}

function drop(entry) { streams.delete(entry); }

function end(entry, event) {
  if (event) send(entry, event);
  drop(entry);
  try { entry.res.end(); } catch (e) { /* already gone */ }
}

/** Tell everyone listening to any of these topics that something changed. */
function publish(topics) {
  const list = Array.isArray(topics) ? topics : [topics];
  for (const entry of [...streams]) {
    const hit = list.filter((t) => entry.topics.has(t));
    if (hit.length) send(entry, 'update', { topics: hit });
  }
}

/** Send one person (on every screen of theirs listening to this topic) a message meant only for them: a call's setup details. */
function sendTo(userId, topic, event, data) {
  let n = 0;
  for (const entry of [...streams]) if (entry.userId === userId && entry.topics.has(topic) && send(entry, event, data)) n += 1;
  return n;
}

/** Is this person still signed in, unlocked and active? Asked again on every beat, because a stream can outlive all three. */
function stillIn(entry, done) {
  entry.store.get(entry.sid, (err, sess) => {
    if (err) return done(true);                                         // a passing hiccup: try again next beat
    if (!sess || sess.userId !== entry.userId || sess.locked) return done(false);
    if (entry.lockAfter && sess.seenAt && Date.now() - sess.seenAt > entry.lockAfter) return done(false);
    let user = null;
    try { user = db.prepare('SELECT active FROM users WHERE id = ?').get(entry.userId); } catch (e) { return done(true); }
    done(Boolean(user && user.active));
  });
}

function beat() {
  for (const entry of [...streams]) {
    if (!send(entry, 'ping')) continue;
    stillIn(entry, (ok) => { if (!ok && streams.has(entry)) end(entry, 'bye'); });
  }
}
const timer = setInterval(beat, BEAT_MS);
timer.unref();

/** Open the stream for this request. Returns false (after answering) if it cannot be opened. */
function attach(req, res, topics) {
  if (streams.size >= MAX_TOTAL) { res.status(503).end(); return false; }
  let mine = 0;
  for (const s of streams) if (s.userId === req.user.id) mine += 1;
  if (mine >= MAX_PER_USER) { res.status(429).end(); return false; }
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  if (req.socket) { req.socket.setTimeout(0); req.socket.setNoDelay(true); }
  res.write('retry: 5000\n\n: open\n\n');
  const entry = { res, userId: req.user.id, sid: req.sessionID, store: req.sessionStore, lockAfter: res.locals.lockAfterMs, topics };
  streams.add(entry);
  req.on('close', () => drop(entry));
  return true;
}

module.exports = { publish, sendTo, attach, parseTopics, count: () => streams.size, _beat: beat };
