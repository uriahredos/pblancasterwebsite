'use strict';
// The Manage page: for anyone who runs something, the jobs they do, grouped, each with the number waiting on them.
const db = require('./db');
const access = require('./permissions');

/** [who may, address, name, how many are waiting (a function of what the page already knows)] by section. */
function sections(user, badges) {
  const can = (p) => access.can(user, p);
  const today = require('./util').localDate();
  const lowStock = () => require('./stock').lowCount(user.workBranch);
  const overdue = () => db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE assigned_by = ? AND done_at IS NULL AND due_on IS NOT NULL AND due_on < ?').get(user.id, today).n;
  const counting = (can('inventory.count') || can('inventory.approve')) && user.workBranch && require('./invcount').open(user.workBranch);
  const all = [
    ['People', [
      [can('users.manage') && user.scope === 'all', '/admin/users/invite', 'Add a person'],
      [can('users.manage'), '/admin/users', 'People and passwords'],
      [can('certs.manage'), '/admin/certs?show=attention', 'Certifications', () => badges.certs],
      [can('complaints.review'), '/admin/complaints', 'Complaints'],
    ]],
    ['Schedule and news', [
      [can('tasks.assign'), '/admin/tasks', 'Assign a task', overdue],
      [can('oncall.manage'), '/oncall', 'On-call schedule'],
      [can('announcements.post'), '/admin/announcements', 'Post an announcement'],
      [can('newsletters.manage'), '/admin/newsletters', 'Upload a newsletter'],
    ]],
    ['Parts', [
      [can('parts.view'), '/admin/requests', 'Parts requests', () => badges.requests],
      [(can('parts.view') || can('stock.manage')) && user.workBranch, '/admin/stock?low=1', 'Low stock', lowStock],
      [can('parts.view') || can('inventory.manage'), '/admin/inventory', 'Inventory'],
      [Boolean(counting), '/admin/inventory/count', 'Inventory count under way', () => 1],
      [can('parts.view'), '/admin/parts', 'Parts log'],
    ]],
    ['Fleet and training', [
      [can('fleet.manage'), '/fleet', 'Fleet list'],
      [can('inspections.view'), '/admin/inspections?show=open', 'Truck problems', () => badges.inspections],
      [can('training.view'), '/admin/training', 'Training log'],
    ]],
    ['The site', [
      [can('activity.view'), '/admin/activity', 'Activity log'],
      [can('profiles.manage') && user.allBranches, '/admin/profiles', 'Profiles and permissions'],
    ]],
  ];
  return all.map(([title, jobs]) => ({ title, jobs: jobs.filter((j) => j[0]).map(([, url, label, n]) => ({ url, label, n: n ? Number(n()) || 0 : 0, flag: label === 'Inventory count under way' })) }))
    .filter((s) => s.jobs.length);
}

const PERMS = ['users.manage', 'certs.manage', 'complaints.review', 'tasks.assign', 'oncall.manage', 'announcements.post', 'newsletters.manage', 'parts.view', 'stock.manage',
  'inventory.manage', 'fleet.manage', 'inspections.view', 'training.view', 'activity.view', 'profiles.manage'];
/** Whether this person runs anything at all (and so gets the Manage link). */
const has = (user) => Boolean(user) && PERMS.some((p) => access.can(user, p));

module.exports = { sections, has };
