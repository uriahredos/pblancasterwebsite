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

// What the log holds about a person's own account rather than about the office's work. SIGN_INS is the sign-in
// history; ACCOUNT is the rest. Both are written under the person's own name with the time, so only people who look
// after every office see them, and they are deleted with the person when the person is removed for good.
const SIGN_INS = ['Signed in', 'Sign-in failed', 'Sign-in paused', 'Sign-in refused', 'Wrong password at the lock screen', 'Wrong password when asked to confirm'];
const ACCOUNT = ['Password changed', 'Password reset by email', 'Email address changed', 'Face ID / fingerprint sign-in set up', 'Face ID / fingerprint sign-in removed'];
/** A list of action names as it goes into a query: ('Signed in', 'Sign-in failed', ...). */
const sqlList = (names) => `(${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ')})`;

module.exports = { log, SIGN_INS, ACCOUNT, sqlList };
