'use strict';
// Quick reactions on things people post. One table serves every kind of thing ("post" = a discussion
// message, "notice" = an announcement); each person can give each reaction once, and take it back.
const db = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS reactions (
  kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, target_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS reactions_target ON reactions(kind, target_id);
`);

const CHOICES = [['like', '👍', 'Like'], ['love', '❤️', 'Love'], ['laugh', '😂', 'Funny'], ['party', '🎉', 'Congratulations'], ['thanks', '🙏', 'Thanks']];
const KINDS = ['post', 'notice', 'social'];

/** Adds .reactions to each item: every choice with how many people gave it, whether this person did, and who. */
function attach(kind, items, userId) {
  if (!items.length) return items;
  const rows = db.prepare(
    `SELECT r.target_id, r.emoji, r.user_id, u.display_name FROM reactions r JOIN users u ON u.id = r.user_id
     WHERE r.kind = ? AND r.target_id IN (${items.map((i) => Number(i.id)).join(',')}) AND u.active = 1 ORDER BY r.created_at`).all(kind);
  for (const item of items) {
    const mine = rows.filter((r) => r.target_id === item.id);
    item.reactions = CHOICES.map(([key, emoji, label]) => {
      const who = mine.filter((r) => r.emoji === key);
      const latest = who.slice(-8).reverse();   // the most recent first, for the list a long press shows on a phone
      return { key, emoji, label, n: who.length, recent: latest.map((r) => r.display_name).join(', ') + (who.length > 8 ? ` and ${who.length - 8} more` : ''), mine: who.some((r) => r.user_id === userId), names: who.slice(0, 12).map((r) => r.display_name).join(', ') + (who.length > 12 ? ` and ${who.length - 12} more` : '') };
    });
  }
  return items;
}

/** Gives the reaction, or takes it back if this person had already given it. */
function toggle(kind, targetId, userId, key) {
  if (!KINDS.includes(kind) || !CHOICES.some((c) => c[0] === key)) return false;
  const had = db.prepare('DELETE FROM reactions WHERE kind = ? AND target_id = ? AND user_id = ? AND emoji = ?').run(kind, targetId, userId, key).changes;
  if (!had) db.prepare('INSERT INTO reactions (kind, target_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)').run(kind, targetId, userId, key, new Date().toISOString());
  return true;
}
const clear = (kind, targetId) => db.prepare('DELETE FROM reactions WHERE kind = ? AND target_id = ?').run(kind, targetId);

module.exports = { CHOICES, KINDS, attach, toggle, clear };
