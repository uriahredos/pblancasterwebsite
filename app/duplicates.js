'use strict';
// The same person entered twice in one office (usually a real account plus a leftover from a contact list).
// Finds them, says which to keep, and folds the other into it so nothing recorded under either is lost.
const db = require('./db');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Groups of accounts in the same office with the same name or the same email address. Each group has `keep`
 * (the account that stays) and `extras` (the rest, each marked `removable` when it is disabled or has no role).
 * `ids` limits the search to accounts the viewer may see (null = everyone).
 */
function find(ids) {
  const users = db.prepare(`SELECT u.id, u.username, u.display_name, u.email, u.active, u.must_change_password, u.job_title, u.branch_id, u.is_master, u.profile_id,
      (SELECT name FROM branches b WHERE b.id = u.branch_id) AS branch_name FROM users u WHERE u.removed_at IS NULL ORDER BY u.id`).all().filter((u) => !ids || ids.includes(u.id));
  const groupOf = new Map(); const groups = [];
  const join = (key, u) => {
    if (!key) return;
    const g = groupOf.get(key);
    if (g) { if (!g.includes(u)) g.push(u); } else { const fresh = [u]; groupOf.set(key, fresh); groups.push(fresh); }
  };
  for (const u of users) {
    const byName = `${u.branch_id}|n|${norm(u.display_name)}`; const byMail = u.email ? `${u.branch_id}|e|${norm(u.email)}` : '';
    // Someone already grouped by email joins that group under their name too, and the other way round.
    const existing = groupOf.get(byName) || (byMail && groupOf.get(byMail));
    if (existing) { if (!existing.includes(u)) existing.push(u); groupOf.set(byName, existing); if (byMail) groupOf.set(byMail, existing); }
    else { join(byName, u); if (byMail) groupOf.set(byMail, groupOf.get(byName)); }
  }
  // The one to keep: a working account before a disabled one, one that has signed in before one that has not, one with a role, then the oldest.
  const rank = (u) => [u.is_master ? 0 : 1, u.active ? 0 : 1, u.must_change_password ? 1 : 0, u.job_title ? 0 : 1, u.id];
  const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  return groups.filter((g) => g.length > 1).map((g) => {
    const sorted = [...g].sort(cmp); const keep = sorted[0];
    const extras = sorted.slice(1).map((u) => ({ ...u, removable: !u.is_master && (!u.active || !u.job_title) }));
    return { keep, extras };
  }).filter((g) => g.extras.some((e) => e.removable));
}

/** Every table and column that points at a user. */
function userColumns() {
  const out = [];
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const f of db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t.name)})`).all()) if (f.table === 'users') out.push({ table: t.name, column: f.from });
  }
  return out;
}

/**
 * Fold `extraId` into `keepId`: everything recorded under the extra account moves to the one kept, details the
 * kept account is missing (role, email, phone, photo, start date) are copied across, and the extra account is deleted.
 */
function merge(keepId, extraId) {
  const keep = db.prepare('SELECT * FROM users WHERE id = ?').get(keepId), extra = db.prepare('SELECT * FROM users WHERE id = ?').get(extraId);
  if (!keep || !extra || keep.id === extra.id || extra.is_master) return false;
  db.transaction(() => {
    for (const { table, column } of userColumns()) {
      db.prepare(`UPDATE OR IGNORE "${table}" SET "${column}" = ? WHERE "${column}" = ?`).run(keep.id, extra.id);   // moved across
      db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(extra.id);                                       // what the kept account already had its own of
    }
    db.prepare('DELETE FROM user_managers WHERE manager_id = user_id').run();
    const fill = ['job_title', 'department', 'email', 'phone', 'photo_path', 'started_on', 'about', 'skills', 'birthday', 'default_truck'].filter((c) => !keep[c] && extra[c]);
    for (const c of fill) db.prepare(`UPDATE users SET ${c} = ? WHERE id = ?`).run(extra[c], keep.id);
    if (extra.in_directory) db.prepare('UPDATE users SET in_directory = 1 WHERE id = ?').run(keep.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(extra.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(extra.id);
  })();
  require('./team').applyAuto(keep.branch_id);
  return true;
}

module.exports = { find, merge };
