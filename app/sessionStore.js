'use strict';
const session = require('express-session');

/** Minimal express-session store on the app's SQLite database. */
class SqliteStore extends session.Store {
  /** ttlMs: how long a signed-in session lasts. visitorTtlMs: how long one that never signed in does. */
  constructor(db, ttlMs, visitorTtlMs = ttlMs) {
    super();
    this.ttlMs = ttlMs;
    this.visitorTtlMs = visitorTtlMs;
    this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data');
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.purgeStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    // Sessions of visitors who never signed in used to be kept as long as everyone else's. Any still here get the short life
    // from now (so a sign-in page that is open at this moment still works), and the expired ones go.
    // A tidy-up only: if it cannot run, the site still starts.
    try {
      const soon = Date.now() + visitorTtlMs;
      db.prepare("UPDATE sessions SET expires = ? WHERE json_extract(data, '$.userId') IS NULL AND expires > ?").run(soon, soon);
      this.purgeStmt.run(Date.now());
    } catch (e) { console.error('[sessions] could not clear old sessions:', e.message); }
    this.timer = setInterval(() => this.purgeStmt.run(Date.now()), 60 * 60 * 1000);
    this.timer.unref();
  }
  expiry(sess) {
    // Nobody signed in: this session only carries a form (sign-in, forgot password) from the page to the answer, so it is short-lived.
    if (!sess || !sess.userId) return Date.now() + this.visitorTtlMs;
    const e = sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + this.ttlMs;
  }
  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  // A request marked "leaveAlone" (the anonymous complaint pages, see app.js) writes nothing here at all: the row keeps
  // the contents and the times it had, so it cannot show that the request happened or when.
  set(sid, sess, cb) {
    if (sess && sess.leaveAlone) return cb && cb(null);
    try { this.setStmt.run(sid, this.expiry(sess), JSON.stringify(sess)); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    if (sess && sess.leaveAlone) return cb && cb(null);
    try { this.touchStmt.run(this.expiry(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
