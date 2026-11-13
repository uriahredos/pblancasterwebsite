'use strict';
const db = require('./db');

/**
 * Everything a profile can be allowed to do. Adding a line here makes a new
 * tick-box appear on the profile page; a route then checks it with can().
 */
const GROUPS = [
  { title: 'Sending forms', items: [
    ['parts.submit', 'Take, return and request parts'],
    ['training.submit', 'Send training requests'],
    ['complaints.submit', 'Send anonymous complaints'],
  ] },
  { title: 'Parts', items: [
    ['parts.view', 'See the parts log, usage summary and exports'],
    ['parts.manage', 'Update parts requests; edit or cancel other people\'s entries'],
    ['parts.audit', 'Use the audit page and tick entries as checked'],
    ['catalog.manage', 'Manage the parts catalog'],
  ] },
  { title: 'Training', items: [
    ['training.view', 'See training requests and exports'],
    ['training.manage', 'Update training requests; edit or cancel them'],
  ] },
  { title: 'People', items: [
    ['users.manage', 'Add people, edit them, reset passwords, disable accounts, choose their profile and who manages them'],
    ['profiles.manage', 'Create profiles and change what each profile can do'],
  ] },
  { title: 'Sensitive', items: [
    ['complaints.review', 'Read and answer anonymous complaints'],
    ['backups', 'Download backups (a backup contains everything, including complaints)'],
  ] },
];
const ALL = GROUPS.flatMap((g) => g.items.map((i) => i[0]));
const SUBMIT = ['parts.submit', 'training.submit', 'complaints.submit'];

// Starting profiles. After the first start they are ordinary profiles: change them on the Profiles page.
const DEFAULTS = [
  { name: 'Technician', scope: 'all', perms: SUBMIT },
  { name: 'Warehouse', scope: 'all', perms: [...SUBMIT, 'parts.view', 'parts.manage', 'parts.audit', 'catalog.manage'] },
  { name: 'Manager', scope: 'team', perms: [...SUBMIT, 'parts.view', 'parts.manage', 'parts.audit', 'training.view', 'training.manage'] },
  { name: 'Admin', scope: 'all', perms: ALL },
];

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- 'all': sees everyone's submissions.  'team': only the people assigned to them (and their own).
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','team')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_permissions (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (profile_id, permission)
);
-- Who a manager looks after.
CREATE TABLE IF NOT EXISTS user_managers (
  manager_id INTEGER NOT NULL REFERENCES users(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (manager_id, user_id)
);
`);
for (const [col, type] of [['profile_id', 'INTEGER'], ['is_master', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?").get(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
}

const profileByName = (name) => db.prepare('SELECT * FROM profiles WHERE name = ?').get(name);

function setPermissions(profileId, perms) {
  db.prepare('DELETE FROM profile_permissions WHERE profile_id = ?').run(profileId);
  const add = db.prepare('INSERT INTO profile_permissions (profile_id, permission) VALUES (?, ?)');
  for (const p of new Set(perms)) if (ALL.includes(p)) add.run(profileId, p);
}

function createProfile(name, scope, perms) {
  const info = db.prepare('INSERT INTO profiles (name, scope, created_at) VALUES (?, ?, ?)')
    .run(name, scope === 'team' ? 'team' : 'all', new Date().toISOString());
  setPermissions(info.lastInsertRowid, perms);
  return info.lastInsertRowid;
}

/** Find a profile by name, creating it if it does not exist yet. */
function ensureProfile(name, scope, perms) {
  const existing = profileByName(name);
  return existing ? existing.id : createProfile(name, scope, perms);
}

/**
 * First start with profiles: create the starting profiles and move every
 * existing account onto the profile that matches the access it already had.
 */
function migrate() {
  db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n === 0) {
      for (const d of DEFAULTS) createProfile(d.name, d.scope, d.perms);
    }
    const withoutProfile = db.prepare('SELECT id, role, can_review_complaints AS reviewer FROM users WHERE profile_id IS NULL').all();
    const noComplaints = ALL.filter((p) => p !== 'complaints.review' && p !== 'backups');
    for (const u of withoutProfile) {
      let profileId;
      if (u.role === 'admin' && u.reviewer) profileId = ensureProfile('Admin', 'all', ALL);
      else if (u.role === 'admin') profileId = ensureProfile('Admin (no complaints)', 'all', noComplaints);
      else if (u.reviewer) profileId = ensureProfile('Complaint reviewer', 'all', [...SUBMIT, 'complaints.review']);
      else profileId = ensureProfile('Technician', 'all', SUBMIT);
      db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId, u.id);
    }
    // The master account: MASTER_USERNAME if set, otherwise the first admin ever created.
    const named = process.env.MASTER_USERNAME && db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.MASTER_USERNAME.trim());
    if (named) {
      db.prepare('UPDATE users SET is_master = (id = ?)').run(named.id);
    } else if (!db.prepare('SELECT 1 FROM users WHERE is_master = 1').get()) {
      const first = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      if (first) db.prepare('UPDATE users SET is_master = 1 WHERE id = ?').run(first.id);
    }
  })();
}
migrate();

const permsOf = (profileId) => new Set(
  db.prepare('SELECT permission FROM profile_permissions WHERE profile_id = ?').all(profileId).map((r) => r.permission));

/** Attach what this person may do. Called once per request. */
function loadAccess(user) {
  const profile = user.profile_id ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(user.profile_id) : null;
  user.profile_name = user.is_master ? 'Master' : profile ? profile.name : 'No profile';
  user.perms = user.is_master ? new Set(ALL) : profile ? permsOf(profile.id) : new Set();
  user.scope = user.is_master || !profile ? 'all' : profile.scope;
  return user;
}

const can = (user, perm) => Boolean(user && user.perms && user.perms.has(perm));

/** null = everyone. Otherwise the ids this person may see: their own and the people assigned to them. */
function visibleUserIds(user) {
  if (user.scope !== 'team') return null;
  if (!user.teamIds) {
    user.teamIds = [user.id, ...db.prepare('SELECT user_id FROM user_managers WHERE manager_id = ?').all(user.id).map((r) => r.user_id)];
  }
  return user.teamIds;
}
const canSee = (user, ownerId) => { const ids = visibleUserIds(user); return !ids || ids.includes(ownerId); };

/** May `actor` hand out (or edit) a profile holding these permissions? Only ones they hold themselves. */
const canGrant = (actor, perms) => [...perms].every((p) => actor.perms.has(p));

module.exports = {
  GROUPS, ALL, SUBMIT, DEFAULTS, profileByName, permsOf, setPermissions, createProfile, ensureProfile,
  loadAccess, can, visibleUserIds, canSee, canGrant, migrate,
};
