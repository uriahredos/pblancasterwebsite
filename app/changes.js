'use strict';
const db = require('./db');
const config = require('./config');

/**
 * Admins may edit or cancel any live entry. The person who sent it may do so
 * for a limited time, and only while nobody has acted on it yet.
 */
function canChange(row, user) {
  if (!row || row.cancelled_at) return false;
  if (user.role === 'admin') return true;
  if (row.user_id !== user.id) return false;
  if (row.status && row.status !== 'new') return false;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  return ageMs <= config.editWindowHours * 60 * 60 * 1000;
}

function logChange(kind, recordId, userId, change, before) {
  db.prepare(
    'INSERT INTO change_log (kind, record_id, user_id, changed_at, change, before_json) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(kind, recordId, userId, new Date().toISOString(), change, before ? JSON.stringify(before) : null);
}

function history(kind, recordId) {
  return db.prepare(
    `SELECT c.changed_at, c.change, c.before_json, u.display_name
     FROM change_log c JOIN users u ON u.id = c.user_id
     WHERE c.kind = ? AND c.record_id = ? ORDER BY c.id`).all(kind, recordId)
    .map((h) => ({ ...h, before: h.before_json ? JSON.parse(h.before_json) : null }));
}

module.exports = { canChange, logChange, history };
