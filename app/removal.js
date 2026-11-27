'use strict';
// Removing a person for good. Their sign-in, contact details, profile photo and personal settings are erased and they vanish
// from every list. What they recorded for the office (parts taken, inspections, posts, tasks they gave) stays,
// with their name on it, because the office still needs those records. Someone with nothing on record is deleted outright.
const crypto = require('crypto');
const db = require('./db');
const activity = require('./activity');

if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'removed_at'").get()) db.exec('ALTER TABLE users ADD COLUMN removed_at TEXT');

// Rows that are about the person only: deleted with them.
const PERSONAL = [
  ['passkeys', 'user_id'], ['push_subscriptions', 'user_id'], ['push_prefs', 'user_id'], ['password_resets', 'user_id'],
  ['user_managers', 'user_id'], ['user_managers', 'manager_id'], ['forum_reads', 'user_id'], ['announcement_reads', 'user_id'],
  ['daily_answers', 'user_id'], ['wall_likes', 'user_id'], ['shoutout_cheers', 'user_id'], ['event_signups', 'user_id'],
  ['training_votes', 'user_id'], ['training_attendance', 'user_id'], ['reactions', 'user_id'], ['certifications', 'user_id'],
  ['dm_reads', 'user_id'], ['dm_favorites', 'user_id'], ['dm_favorites', 'other_id'], ['welcomes', 'user_id'], ['welcome_notes', 'user_id'], ['shoutouts', 'to_user'], ['celebrations', 'user_id'], ['celebrations', 'from_user'],
];

/** Every table and column that points at a user. */
function userColumns() {
  const out = [];
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const f of db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t.name)})`).all()) if (f.table === 'users') out.push({ table: t.name, column: f.from });
  }
  return out;
}

/**
 * Remove an account. Returns 'deleted' (nothing was on record, the row is gone), 'kept-records' (erased and hidden,
 * their name stays on what they recorded) or null (not allowed: the master account, or already removed).
 */
function remove(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || u.is_master || u.removed_at) return null;
  let outcome = 'deleted';
  db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(u.id);
    for (const [table, column] of PERSONAL) db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(u.id);
    // Their sign-in history, and when they changed a password or reset address, is about them and nobody else: it goes too,
    // so having signed in (or someone having guessed at the password) is not a record that keeps the name on file.
    db.prepare(`DELETE FROM activity_log WHERE user_id = ? AND action IN ${activity.sqlList([...activity.SIGN_INS, ...activity.ACCOUNT])}`).run(u.id);
    db.prepare('DELETE FROM tasks WHERE assigned_to = ? AND done_at IS NULL AND id NOT IN (SELECT task_id FROM task_notes)').run(u.id);   // open tasks nobody wrote on
    db.prepare('UPDATE leads SET owner_id = NULL WHERE owner_id = ?').run(u.id);                                                           // their leads go back to the office
    db.prepare('UPDATE daily_questions SET suggested_by = NULL WHERE suggested_by = ?').run(u.id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'inv_locations'").get()) db.prepare('UPDATE inv_locations SET user_id = NULL WHERE user_id = ?').run(u.id);   // their vehicle stays, with nobody's name on it
    const left = userColumns().some(({ table, column }) => db.prepare(`SELECT 1 FROM "${table}" WHERE "${column}" = ? LIMIT 1`).get(u.id));
    if (!left) { db.prepare('DELETE FROM users WHERE id = ?').run(u.id); return; }
    outcome = 'kept-records';
    db.prepare(`UPDATE users SET active = 0, in_directory = 0, removed_at = ?, username = ?, password_hash = ?, email = NULL, phone = NULL, photo_path = NULL,
        about = NULL, skills = NULL, birthday = NULL, started_on = NULL, job_title = NULL, department = NULL, default_truck = NULL, profile_id = NULL,
        show_phone = 0, show_email = 0, must_change_password = 1 WHERE id = ?`)
      .run(new Date().toISOString(), `removed-${u.id}`, crypto.randomBytes(32).toString('hex'), u.id);
  })();
  require('./uploads').remove(u.photo_path);   // the photo file itself, not only the mention of it
  require('./team').applyAuto(u.branch_id);
  return outcome;
}

module.exports = { remove, userColumns };
