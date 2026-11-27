'use strict';
// Private messages between two people. One conversation per pair; only the two of them can read it. The one exception is a
// report (see routes/messages.js): that opens the one conversation to the people who review reports, and says so.
const db = require('./db');
const access = require('./permissions');

const pair = (a, b) => (a < b ? [a, b] : [b, a]);

/** The conversation this person has with that one, or null. */
function find(me, other) {
  const [a, b] = pair(me, other);
  return db.prepare('SELECT * FROM dm_threads WHERE user_a = ? AND user_b = ?').get(a, b) || null;
}

/** The conversation, with the other person's details, if this person is one of the two. Anyone else gets null. */
function forUser(id, userId) {
  if (!/^\d+$/.test(String(id))) return null;
  const t = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(id);
  if (!t || (t.user_a !== userId && t.user_b !== userId)) return null;
  const otherId = t.user_a === userId ? t.user_b : t.user_a;
  const other = db.prepare('SELECT id, display_name, photo_path, job_title, active FROM users WHERE id = ?').get(otherId);
  return { ...t, other };
}

function create(me, other) {
  const [a, b] = pair(me, other); const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO dm_threads (user_a, user_b, created_at, last_at) VALUES (?, ?, ?, ?)').run(a, b, now, now);
  return find(me, other);
}

/** This person's conversations, newest first, each with the other person, the last message and whether it is unread. */
function listFor(userId) {
  return db.prepare(
    `SELECT t.id, t.last_at, u.id AS other_id, u.display_name AS other_name, u.photo_path AS other_photo, u.active AS other_active,
            (SELECT m.body FROM dm_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body,
            (SELECT m.user_id FROM dm_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_from,
            (SELECT m.removed_at FROM dm_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_removed,
            (SELECT m.kind FROM dm_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_kind,
            EXISTS (SELECT 1 FROM dm_messages m WHERE m.thread_id = t.id AND m.user_id <> @me AND m.removed_at IS NULL
                    AND m.id > COALESCE((SELECT r.last_read_id FROM dm_reads r WHERE r.thread_id = t.id AND r.user_id = @me), 0)) AS unread
     FROM dm_threads t JOIN users u ON u.id = CASE WHEN t.user_a = @me THEN t.user_b ELSE t.user_a END
     WHERE (t.user_a = @me OR t.user_b = @me) AND EXISTS (SELECT 1 FROM dm_messages m WHERE m.thread_id = t.id)
     ORDER BY t.last_at DESC LIMIT 200`).all({ me: userId });
}

/** How many conversations have something this person has not read. */
function unreadCount(userId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM dm_threads t
     WHERE (t.user_a = @me OR t.user_b = @me) AND EXISTS (
       SELECT 1 FROM dm_messages m WHERE m.thread_id = t.id AND m.user_id <> @me AND m.removed_at IS NULL
         AND m.id > COALESCE((SELECT r.last_read_id FROM dm_reads r WHERE r.thread_id = t.id AND r.user_id = @me), 0))`).get({ me: userId }).n;
}

/** The latest messages in a conversation, oldest first. */
function messages(threadId, limit = 200) {
  return db.prepare(
    `SELECT * FROM (SELECT m.*, u.display_name AS author FROM dm_messages m JOIN users u ON u.id = m.user_id WHERE m.thread_id = ? ORDER BY m.id DESC LIMIT ?) ORDER BY id`).all(threadId, limit);
}

/** This person has read the conversation up to its newest message. */
function markRead(threadId, userId) {
  const last = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM dm_messages WHERE thread_id = ?').get(threadId).id;
  db.prepare('INSERT INTO dm_reads (thread_id, user_id, last_read_id) VALUES (?, ?, ?) ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)').run(threadId, userId, last);
}
const lastRead = (threadId, userId) => (db.prepare('SELECT last_read_id FROM dm_reads WHERE thread_id = ? AND user_id = ?').get(threadId, userId) || { last_read_id: 0 }).last_read_id;

function add(threadId, userId, body, kind = null) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO dm_messages (thread_id, user_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?)').run(threadId, userId, body, now, kind).lastInsertRowid;
    db.prepare('UPDATE dm_threads SET last_at = ? WHERE id = ?').run(now, threadId);
    markRead(threadId, userId);                       // what you just wrote is read by you
    return id;
  })();
}

/** Can this person get private messages? Only someone who is still here and whose profile includes them: otherwise a message would sit where nobody can read it. */
function reachable(userId) {
  const u = db.prepare('SELECT active, is_master, profile_id FROM users WHERE id = ?').get(userId);
  return Boolean(u && u.active && (u.is_master || (u.profile_id && access.permsOf(u.profile_id).has('messages.use'))));
}

/** People to start a conversation with: active, able to get messages, not this person, matched on name. */
function people(me, q) {
  const like = `%${String(q || '').replace(/[\\%_]/g, '\\$&')}%`;
  return db.prepare(
    `SELECT u.id, u.display_name, u.photo_path, u.job_title, b.name AS branch FROM users u LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.active = 1 AND u.id <> ? AND u.display_name LIKE ? ESCAPE '\\' ORDER BY u.display_name COLLATE NOCASE LIMIT 100`).all(me, like)
    .filter((u) => reachable(u.id)).slice(0, 25);
}

/** The people this person has starred, by name. */
function favorites(userId) {
  return db.prepare(
    `SELECT u.id, u.display_name, u.photo_path, u.job_title, b.name AS branch FROM dm_favorites f JOIN users u ON u.id = f.other_id LEFT JOIN branches b ON b.id = u.branch_id
     WHERE f.user_id = ? AND u.active = 1 ORDER BY u.display_name COLLATE NOCASE LIMIT 50`).all(userId).filter((u) => reachable(u.id));
}
const isFavorite = (userId, otherId) => Boolean(db.prepare('SELECT 1 FROM dm_favorites WHERE user_id = ? AND other_id = ?').get(userId, otherId));
/** Star or unstar someone. Returns whether they are now a favorite. */
function toggleFavorite(userId, otherId) {
  if (isFavorite(userId, otherId)) { db.prepare('DELETE FROM dm_favorites WHERE user_id = ? AND other_id = ?').run(userId, otherId); return false; }
  db.prepare('INSERT INTO dm_favorites (user_id, other_id, created_at) VALUES (?, ?, ?)').run(userId, otherId, new Date().toISOString());
  return true;
}

/** Reports nobody has opened yet, among those this person may handle (see routes/messages.js for the rule). */
function waitingReports(user) {
  return db.prepare(`SELECT r.reported_by, t.user_a, t.user_b FROM dm_reports r JOIN dm_threads t ON t.id = r.thread_id WHERE r.closed_at IS NULL AND r.opened_at IS NULL LIMIT 200`).all()
    .filter((r) => r.user_a !== user.id && r.user_b !== user.id && access.canSee(user, r.reported_by)).length;
}

/** What a reviewer may read for a report: the conversation as it stood when it was reported, and nothing written since. */
function asReported(threadId, reportedAt, limit = 500) {
  return db.prepare(
    `SELECT * FROM (SELECT m.*, u.display_name AS author FROM dm_messages m JOIN users u ON u.id = m.user_id
       WHERE m.thread_id = ? AND m.created_at <= ? ORDER BY m.id DESC LIMIT ?) ORDER BY id`).all(threadId, reportedAt, limit);
}

/**
 * Two accounts for one person are being folded into one: the conversations of the account that goes move to the one kept.
 * Where both had a conversation with the same person, the messages join the kept account's. Call inside the merge's transaction.
 */
function moveUser(fromId, toId) {
  for (const t of db.prepare('SELECT * FROM dm_threads WHERE user_a = ? OR user_b = ?').all(fromId, fromId)) {
    const other = t.user_a === fromId ? t.user_b : t.user_a;
    if (other !== toId) {
      const into = create(toId, other);
      db.prepare('UPDATE dm_messages SET thread_id = ? WHERE thread_id = ?').run(into.id, t.id);
      db.prepare('UPDATE dm_reports SET thread_id = ? WHERE thread_id = ?').run(into.id, t.id);
      db.prepare('UPDATE OR IGNORE dm_reads SET thread_id = ? WHERE thread_id = ?').run(into.id, t.id);
      db.prepare('UPDATE dm_threads SET last_at = MAX(last_at, ?) WHERE id = ?').run(t.last_at, into.id);
    }
    db.prepare('DELETE FROM dm_threads WHERE id = ?').run(t.id);   // a conversation between the two accounts themselves goes with the extra one
  }
}

module.exports = { find, forUser, create, listFor, unreadCount, messages, markRead, lastRead, add, people, reachable, asReported, moveUser, waitingReports, favorites, isFavorite, toggleFavorite };
