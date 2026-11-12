'use strict';
const session = require('express-session');

/** Minimal express-session store on the app's SQLite database. */
class SqliteStore extends session.Store {
  constructor(db, ttlMs) {
    super();
    this.ttlMs = ttlMs;
    this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data');
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.purgeStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this.timer = setInterval(() => this.purgeStmt.run(Date.now()), 60 * 60 * 1000);
    this.timer.unref();
  }
  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + this.ttlMs;
  }
  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.setStmt.run(sid, this.expiry(sess), JSON.stringify(sess)); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try { this.touchStmt.run(this.expiry(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
