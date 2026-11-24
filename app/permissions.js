'use strict';
const db = require('./db');

/**
 * Everything a profile can be allowed to do. Adding a line here makes a new
 * tick-box appear on the profile page; a route then checks it with can().
 */
const GROUPS = [
  // Grouped the way the menu is, each line saying in a few words what ticking it lets someone do.
  { title: 'Everyday', items: [
    ['parts.submit', 'Use the parts form: take, return and request parts'],
    ['fleet.signout', 'Sign out lifts and shared equipment'],
    ['inspections.submit', 'Do truck inspections'],
    ['training.submit', 'Ask for training'],
    ['complaints.submit', 'Send anonymous complaints'],
    ['forum.use', 'Post and comment on Social and in Discussions'],
  ] },
  { title: 'Parts and inventory', items: [
    ['parts.view', 'See the parts log, parts requests, stock and inventory'],
    ['parts.manage', 'Answer parts requests; fix or cancel anyone\'s parts entry'],
    ['parts.audit', 'Audit parts entries'],
    ['catalog.manage', 'Edit the parts catalog and see costs'],
    ['stock.manage', 'Change warehouse stock: deliveries, counts, minimums and maximums'],
    ['inventory.manage', 'Add vehicles and locations; move parts between them'],
    ['inventory.count', 'Count any location during an inventory count'],
    ['inventory.approve', 'Start and close an inventory count'],
    ['inventory.export', 'Export inventory spreadsheets'],
  ] },
  { title: 'Fleet', items: [
    ['fleet.manage', 'Add and edit the fleet list; return anyone\'s equipment sign-out'],
    ['inspections.view', 'See truck inspections'],
    ['inspections.manage', 'Mark truck problems fixed; edit the inspection checklist'],
  ] },
  { title: 'Training', items: [
    ['training.view', 'See training requests'],
    ['training.manage', 'Answer, edit or cancel training requests'],
    ['certs.manage', 'Record licenses and certifications'],
  ] },
  { title: 'Team', items: [
    ['users.manage', 'Add and edit people; reset passwords; disable accounts'],
    ['tasks.assign', 'Assign tasks'],
    ['oncall.manage', 'Edit the on-call schedule and rates'],
  ] },
  { title: 'News and community', items: [
    ['announcements.post', 'Post announcements'],
    ['events.post', 'Post events'],
    ['newsletters.manage', 'Upload newsletters'],
    ['daily.manage', 'Run the daily question'],
    ['forum.moderate', 'Remove anyone\'s posts and comments; lock and move discussions'],
  ] },
  { title: 'Sales', items: [
    ['sales.use', 'Use Sales: add and work leads'],
    ['sales.manage', 'Manage everyone\'s leads and export them'],
  ] },
  { title: 'Running the site', items: [
    ['activity.view', 'See the activity log'],
    ['profiles.manage', 'Create and change profiles'],
    ['digest.weekly', 'Get the weekly parts email'],
  ] },
  { title: 'Sensitive', items: [
    ['market.all', 'See and manage every branch in their own market'],
    ['branches.all', 'See and manage every branch'],
    ['complaints.review', 'Read and answer anonymous complaints'],
    ['backups', 'Download backups (a backup holds everything, complaints included)'],
    ['records.delete', 'Permanently delete records'],
  ] },
];
const ALL = GROUPS.flatMap((g) => g.items.map((i) => i[0]));

// ---- Levels ---------------------------------------------------------------------------------------------------
// How far a profile reaches, narrowest first. It is stored as the profile's scope plus two permissions, which is
// what every check in the site reads; the profile page shows it as one choice so the three can never disagree.
const LEVELS = [
  ['team', 'Their own team', 'Only the people assigned to them. You choose their people on the Users page.'],
  ['office', 'Their branch', 'Everyone in their own branch.'],
  ['market', 'Their market', 'Every branch in their market, one at a time.'],
  ['company', 'The whole company', 'Every branch, and the Corporate view of all of them together.'],
];
const LEVEL_PERMS = ['market.all', 'branches.all'];
const levelOf = (scope, perms) => (scope === 'team' ? 'team' : perms.has('branches.all') ? 'company' : perms.has('market.all') ? 'market' : 'office');
/** The scope and the level permissions that make up a level. The company holds the market too, so it can hand it out. */
const forLevel = (level) => ({ scope: level === 'team' ? 'team' : 'all', perms: level === 'company' ? ['market.all', 'branches.all'] : level === 'market' ? ['market.all'] : [] });
/** An admin adds people and changes access; a manager runs the day-to-day; anyone else is staff. */
const kindOf = (perms) => (perms.has('users.manage') ? 'admin' : perms.has('tasks.assign') ? 'manager' : 'staff');
const LEVEL_WORD = { company: 'Corporate', market: 'Market', office: 'Branch', team: 'Team' };
/** Where a profile sits in the chain of command: { level, kind, label, rank }. A higher rank is further up. */
function position(scope, perms) {
  const level = levelOf(scope, perms); const kind = kindOf(perms);
  const rank = kind === 'staff' ? 0 : ['team', 'office', 'market', 'company'].indexOf(level) * 2 + (kind === 'admin' ? 2 : 1);
  return { level, kind, rank, label: kind === 'staff' ? '' : level === 'team' ? 'Team manager' : `${LEVEL_WORD[level]} ${kind}` };
}
// What an admin has that a manager does not: people and access, the records behind the site, and the shared catalog.
const ADMIN_ONLY = ['users.manage', 'profiles.manage', 'activity.view', 'backups', 'records.delete', 'complaints.review', 'catalog.manage'];
// Sales is its own side of the site. Besides the two Sales profiles, only Admin and Corporate admin start with it.
const SALES = ['sales.use', 'sales.manage'];
const SUBMIT = ['parts.submit', 'training.submit', 'complaints.submit', 'inspections.submit', 'fleet.signout'];

// Starting profiles. After the first start they are ordinary profiles: change them on the Profiles page.
const DEFAULTS = [
  { name: 'Technician', scope: 'all', perms: [...SUBMIT, 'forum.use'] },
  { name: 'Warehouse', scope: 'all', perms: [...SUBMIT, 'forum.use', 'parts.view', 'parts.manage', 'parts.audit', 'catalog.manage', 'stock.manage', 'inventory.manage', 'inventory.count', 'inventory.export', 'inspections.view', 'inspections.manage'] },
  { name: 'Manager', scope: 'team', perms: [...SUBMIT, 'forum.use', 'parts.view', 'parts.manage', 'parts.audit', 'training.view', 'training.manage', 'digest.weekly', 'inspections.view', 'inspections.manage', 'certs.manage', 'announcements.post', 'tasks.assign'] },
  { name: 'Admin', scope: 'all', perms: ALL.filter((p) => p !== 'branches.all' && p !== 'market.all' && p !== 'backups') },   // an admin runs one branch (backups hold every branch)
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
-- The key above answers "who reports to this manager"; this one answers "who does this person report to".
CREATE INDEX IF NOT EXISTS user_managers_user ON user_managers(user_id);
`);
for (const [col, type] of [['profile_id', 'INTEGER'], ['is_master', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?").get(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
}

// "Admin" is the branch admin's first name on the site: asked for by that name, it is still found after being renamed.
const profileByName = (name) => db.prepare('SELECT * FROM profiles WHERE name = ?').get(name)
  || (String(name).toLowerCase() === 'admin' ? db.prepare("SELECT * FROM profiles WHERE name = 'Branch admin'").get() : undefined);

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
    const oneBranch = ALL.filter((p) => p !== 'branches.all' && p !== 'market.all' && p !== 'backups');
    const noComplaints = oneBranch.filter((p) => p !== 'complaints.review' && p !== 'backups');
    for (const u of withoutProfile) {
      let profileId;
      if (u.role === 'admin' && u.reviewer) profileId = ensureProfile('Admin', 'all', oneBranch);
      else if (u.role === 'admin') profileId = ensureProfile('Admin (no complaints)', 'all', noComplaints);
      else if (u.reviewer) profileId = ensureProfile('Complaint reviewer', 'all', [...SUBMIT, 'complaints.review']);
      else profileId = ensureProfile('Technician', 'all', SUBMIT);
      db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId, u.id);
    }
    // Permissions added in a later release: give each one, once, to the profiles that already
    // hold the closest existing permission, so nobody has to re-tick boxes after an update.
    const INHERIT = {
      'stock.manage': 'catalog.manage', 'inventory.manage': 'stock.manage', 'inventory.count': 'stock.manage', 'inventory.approve': 'users.manage', 'inventory.export': 'inventory.manage', 'activity.view': 'profiles.manage',
      'inspections.submit': 'parts.submit', 'inspections.view': 'parts.view', 'inspections.manage': 'parts.manage', 'fleet.signout': 'parts.submit', 'fleet.manage': 'inspections.manage',
      'certs.manage': 'training.manage', 'announcements.post': 'training.manage', 'records.delete': 'profiles.manage',
      'tasks.assign': 'announcements.post',
      'newsletters.manage': 'users.manage', 'forum.use': 'parts.submit', 'forum.moderate': 'users.manage', 'daily.manage': 'users.manage', 'events.post': 'announcements.post', 'oncall.manage': 'tasks.assign',
    };
    for (const [perm, from] of Object.entries(INHERIT)) {
      const key = `perm_granted:${perm}`;
      if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key)) continue;
      db.prepare(`INSERT OR IGNORE INTO profile_permissions (profile_id, permission)
                  SELECT profile_id, ? FROM profile_permissions WHERE permission = ?`).run(perm, from);
      db.prepare("INSERT INTO meta (key, value) VALUES (?, '1')").run(key);
    }
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'perm_granted:digest.weekly'").get()) {
      db.prepare(`INSERT OR IGNORE INTO profile_permissions (profile_id, permission)
                  SELECT p.id, 'digest.weekly' FROM profiles p
                  WHERE p.scope = 'team' AND EXISTS (SELECT 1 FROM profile_permissions x WHERE x.profile_id = p.id AND x.permission = 'parts.view')`).run();
      db.prepare("INSERT INTO meta (key, value) VALUES ('perm_granted:digest.weekly', '1')").run();
    }
    // The corporate level: a profile that can do everything in every office. Made once; after that it is an ordinary profile.
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'corporate_profile_1'").get()) {
      if (!db.prepare("SELECT 1 FROM profiles WHERE name = 'Corporate admin'").get()) createProfile('Corporate admin', 'all', ALL);
      db.prepare("INSERT INTO meta (key, value) VALUES ('corporate_profile_1', '1')").run();
    }
    // Managers: one profile for each level, made once. A manager runs the day-to-day (requests, stock, fleet, training,
    // tasks, on call, news) without the admin's side: people, access, the activity log, records and the shared catalog.
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'manager_profiles_1'").get()) {
      const manager = ALL.filter((p) => !ADMIN_ONLY.includes(p) && !LEVEL_PERMS.includes(p) && !SALES.includes(p) && p !== 'digest.weekly');
      for (const [name, level] of [['Branch manager', 'office'], ['Market manager', 'market'], ['Corporate manager', 'company']]) {
        if (!profileByName(name)) createProfile(name, 'all', [...manager, ...forLevel(level).perms]);
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('manager_profiles_1', '1')").run();
    }
    // Backups hold every office, so only someone who sees every office can use them. The box is taken off the profiles
    // where it did nothing, once: a market admin can then hand out an office admin profile (nobody grants what they lack).
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'backups_company_only_1'").get()) {
      db.prepare(`DELETE FROM profile_permissions WHERE permission = 'backups'
                  AND profile_id NOT IN (SELECT profile_id FROM profile_permissions WHERE permission = 'branches.all')`).run();
      db.prepare("INSERT INTO meta (key, value) VALUES ('backups_company_only_1', '1')").run();
    }
    // A profile that sees every office holds the market level too, so its people can appoint market admins and managers.
    // (Profiles made before markets existed did not have it.) Given once.
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'company_holds_market_1'").get()) {
      db.prepare(`INSERT OR IGNORE INTO profile_permissions (profile_id, permission)
                  SELECT profile_id, 'market.all' FROM profile_permissions WHERE permission = 'branches.all'`).run();
      db.prepare("INSERT INTO meta (key, value) VALUES ('company_holds_market_1', '1')").run();
    }
    // The six roles by name: the branch's admin profile, first called just "Admin", becomes "Branch admin" beside
    // "Branch manager". Once, and only on a site that already groups branches into markets (so a brand-new site
    // keeps the names it starts with).
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'branch_admin_name_1'").get()) {
      const inUse = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'markets'").get() && db.prepare('SELECT 1 FROM markets').get();
      const admin = db.prepare("SELECT id, scope FROM profiles WHERE name = 'Admin'").get();
      const wider = admin && db.prepare("SELECT 1 FROM profile_permissions WHERE profile_id = ? AND permission IN ('branches.all', 'market.all')").get(admin.id);
      if (inUse && admin && admin.scope === 'all' && !wider && !db.prepare("SELECT 1 FROM profiles WHERE name = 'Branch admin'").get()) {
        db.prepare("UPDATE profiles SET name = 'Branch admin' WHERE id = ?").run(admin.id);
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('branch_admin_name_1', '1')").run();
    }
    // Sales: two profiles made once, for the sales side of the site.
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'sales_profiles_1'").get()) {
      const base = ['training.submit', 'complaints.submit', 'forum.use', 'sales.use'];
      if (!profileByName('Sales')) createProfile('Sales', 'all', base);
      if (!profileByName('Sales manager')) createProfile('Sales manager', 'all', [...base, 'sales.manage']);
      db.prepare("INSERT INTO meta (key, value) VALUES ('sales_profiles_1', '1')").run();
    }
    // Admins and corporate admins see the sales side too. Given once to the profiles that exist; after that it is an ordinary setting.
    if (!db.prepare("SELECT 1 FROM meta WHERE key = 'sales_admins_1'").get()) {
      const give = db.prepare('INSERT OR IGNORE INTO profile_permissions (profile_id, permission) VALUES (?, ?)');
      for (const row of db.prepare("SELECT id FROM profiles WHERE name IN ('Admin', 'Corporate admin')").all()) for (const perm of SALES) give.run(row.id, perm);
      db.prepare("INSERT INTO meta (key, value) VALUES ('sales_admins_1', '1')").run();
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

/**
 * Attach what this person may do. Called once per request.
 * viewBranch: for someone who can see every branch, the branch they have chosen to look at
 * (a branch id, or 'all'). Everyone else always looks at their own.
 */
function loadAccess(user, viewBranch, viewProfile) {
  const profile = user.profile_id ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(user.profile_id) : null;
  user.profile_name = user.is_master ? 'Master' : profile ? profile.name : 'No profile';
  user.perms = user.is_master ? new Set(ALL) : profile ? permsOf(profile.id) : new Set();
  user.scope = user.is_master || !profile ? 'all' : profile.scope;
  user.allBranches = Boolean(user.is_master || user.perms.has('branches.all'));
  // A market admin runs every office in the market their own office belongs to, one at a time: never all at once,
  // and never an office outside it.
  user.marketBranches = !user.allBranches && user.perms.has('market.all') ? marketOffices(user.branch_id) : [];
  const inMarket = user.marketBranches.includes(Number(viewBranch));
  const chosen = (user.allBranches || inMarket) && viewBranch !== undefined && viewBranch !== null ? viewBranch : user.branch_id;
  // null = every branch at once. workBranch is the one branch that stock, the truck checklist and new training sessions belong to.
  user.viewBranch = chosen === 'all' ? null : (db.prepare('SELECT id FROM branches WHERE id = ?').get(chosen) || { id: user.branch_id }).id;
  // Fail closed: an account with no office (which should not happen) sees no office's records rather than every office's.
  if (!user.allBranches && !user.viewBranch) user.viewBranch = -1;
  user.workBranch = user.viewBranch || user.branch_id;
  // The master account and people who see every office can look at the site the way another profile sees it.
  user.canViewAs = user.allBranches;
  user.own = { master: Boolean(user.is_master), perms: user.perms };     // what the account itself may do, whatever view is on
  if (viewProfile && user.canViewAs) {
    const as = db.prepare('SELECT * FROM profiles WHERE id = ?').get(viewProfile);
    // Never a profile that can do more than their own: this only ever takes things away.
    if (as && (user.is_master || canGrant(user, permsOf(as.id)))) {
      user.viewingAs = { id: as.id, name: as.name };
      user.is_master = 0;                                     // for this request only: nothing here is saved
      user.perms = permsOf(as.id); user.scope = as.scope; user.profile_name = as.name;
      user.allBranches = user.perms.has('branches.all');
      // Looking as a market admin: the offices of the market the office in view belongs to, so the box to move between them is there.
      user.marketBranches = !user.allBranches && user.perms.has('market.all') ? marketOffices(user.viewBranch || user.branch_id) : [];
      // Without "every office" they stay in the office they were looking at (their own, if that was all of them).
      if (!user.allBranches && !user.viewBranch) user.viewBranch = user.branch_id || -1;
      user.workBranch = user.viewBranch || user.branch_id;
    }
  }
  return user;
}

/** The offices in the same market as this one (itself included); just itself when it is in no market. */
function marketOffices(branchId) {
  if (!branchId) return [];
  const mine = db.prepare('SELECT market_id FROM branches WHERE id = ?').get(branchId);
  if (!mine || !mine.market_id) return [branchId];
  return db.prepare('SELECT id FROM branches WHERE market_id = ? ORDER BY name COLLATE NOCASE').all(mine.market_id).map((r) => r.id);
}

const can = (user, perm) => Boolean(user && user.perms && user.perms.has(perm));

/**
 * null = everyone in every branch. Otherwise the ids this person may see: for a manager, their own
 * and the people assigned to them; for anyone else, the people in the branch they are looking at.
 */
function visibleUserIds(user) {
  if (user.scope === 'team') {
    if (!user.teamIds) {
      user.teamIds = [user.id, ...require('./team').everyoneUnder(user.id)];
    }
    return user.teamIds;
  }
  if (!user.viewBranch) return null;
  if (!user.branchIds) user.branchIds = db.prepare('SELECT id FROM users WHERE branch_id = ?').all(user.viewBranch).map((r) => r.id);
  return user.branchIds;
}
const canSee = (user, ownerId) => { const ids = visibleUserIds(user); return !ids || ids.includes(ownerId); };

/**
 * May this person take down something `authorId` wrote? With the permission, a corporate admin may anywhere;
 * everyone else only for the people they look after (their own office, or their own team).
 */
function moderates(user, perm, authorId) {
  if (!can(user, perm)) return false;
  if (user.allBranches) return true;
  if (user.scope === 'team') return canSee(user, authorId);
  const row = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(authorId);
  // Their own office, or (for a market admin) any office of their market.
  const mine = user.marketBranches && user.marketBranches.length ? user.marketBranches : [user.branch_id];
  return Boolean(row && row.branch_id && mine.includes(row.branch_id));
}

/** May `actor` hand out (or edit) a profile holding these permissions? Only ones they hold themselves. */
// (Backups hold every office, so the box does nothing on a profile that does not see every office: it is not counted there.)
const canGrant = (actor, perms) => { const set = new Set(perms); return [...set].every((p) => actor.perms.has(p) || (p === 'backups' && !set.has('branches.all'))); };

/**
 * May `actor` change `target`'s account? Never the master account (except the
 * master themselves), never someone outside their team, and never someone
 * whose profile can do more than their own.
 */
function mayManage(actor, target) {
  if (!target) return false;
  if (target.is_master) return Boolean(actor.is_master);
  if (!canSee(actor, target.id)) return false;
  return !target.profile_id || canGrant(actor, permsOf(target.profile_id));
}

/** The profiles this person may look at the site as: for the master account all of them, otherwise none that can do more than their own. */
function viewAsChoices(user) {
  if (!user || !user.canViewAs) return [];
  return db.prepare('SELECT id, name FROM profiles ORDER BY name COLLATE NOCASE').all().filter((p) => user.own.master || canGrant({ perms: user.own.perms }, permsOf(p.id)));
}

module.exports = {
  viewAsChoices, GROUPS, ALL, SUBMIT, DEFAULTS, LEVELS, LEVEL_PERMS, levelOf, forLevel, kindOf, position, ADMIN_ONLY, profileByName, permsOf, setPermissions, createProfile, ensureProfile,
  loadAccess, marketOffices, can, visibleUserIds, canSee, canGrant, mayManage, moderates, migrate,
};
