'use strict';
const db = require('./db');

/**
 * Record an admin-side action: who, what, and a short plain description.
 * Never call this for anything to do with anonymous complaints.
 */
function log(user, action, detail) {
  try {
    db.prepare('INSERT INTO activity_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), user ? user.id : null, action, detail ? String(detail).slice(0, 500) : null);
  } catch (e) { console.error('[activity] could not record:', e.message); }
}

module.exports = { log };
