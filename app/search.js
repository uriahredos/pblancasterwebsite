'use strict';
// One search for the whole site: pages, how-to guides, people, offices and parts. Everything it returns is something
// the person asking may already open; it is a quicker way there, never a way round a permission.
const db = require('./db');
const access = require('./permissions');
const help = require('./help');

// Every page in the menu, with other words people might type for it. Kept in step with the menu in
// views/partials/header.ejs (a test checks that no menu link is missing here).
// [who may see it, address, name, other words]. "Who": '' = everyone, a permission, or a function of the person.
const everyOffice = (u) => Boolean(u.allBranches);
const PAGES = [
  ['', '/', 'Home', 'start front page dashboard'],
  ['', '/tasks', 'Tasks', 'my tasks to do jobs todo'],
  ['', '/social', 'Social', 'feed post photos pictures wall'],
  ['', '/branches', 'Offices', 'branches locations office list'],
  ['', '/company', 'Company', 'about'],
  ['', '/contacts', 'Who to contact', 'contacts payroll hr human resources safety it help desk phone numbers'],
  ['', '/feed', 'Activity feed', 'recent news whats new'],
  ['forum.use', '/discussions', 'Discussions', 'forum threads questions talk chat'],
  ['', '/people', 'People', 'directory coworkers employees staff phone book find someone'],
  ['', '/shoutouts', 'Shout-outs', 'kudos thanks recognition praise'],
  ['', '/events', 'Events', 'calendar sign up'],
  ['', '/notices', 'Announcements', 'notices news bulletin'],
  ['', '/daily', 'Daily question', 'question of the day poll'],
  ['', '/newsletters', 'Newsletters', 'monthly barker newsletter'],
  ['parts.submit', '/parts', 'Take, return or request', 'parts form sign out parts'],
  ['parts.submit', '/parts?action=take', 'Take parts', 'sign out parts van stock job'],
  ['parts.submit', '/parts?action=return', 'Return parts', 'bring back parts'],
  ['parts.submit', '/parts?action=request', 'Request parts', 'order parts need parts'],
  ['parts.view', '/admin/parts', 'Parts log', 'parts entries history signed out'],
  ['parts.view', '/admin/requests', 'Parts requests', 'requests to order orders waiting'],
  ['parts.audit', '/admin/parts/audit', 'Audit', 'check parts entries'],
  ['parts.view', '/admin/stock', 'Warehouse stock and minimums', 'stock warehouse on hand minimum low stock delivery count'],
  ['parts.view', '/admin/inventory', 'Inventory', 'vehicles trucks warehouse locations export count sedona'],
  ['parts.view', '/admin/parts/summary', 'Usage summary', 'parts report usage weekly'],
  ['catalog.manage', '/admin/catalog', 'Catalog', 'parts list part numbers prices cost import'],
  ['', '/fleet', 'Fleet list', 'fleet trucks vans trailers lifts scissor lift equipment vehicles'],
  ['fleet.signout', '/fleet/signout', 'Sign out equipment', 'scissor lift sign out borrow reserve book equipment trailer'],
  ['inspections.submit', '/inspection', 'Truck inspection', 'vehicle check walk around van'],
  ['inspections.view', '/admin/inspections', 'Inspection log', 'truck problems vehicle inspections'],
  ['inspections.manage', '/admin/inspections/checklist', 'Checklist', 'inspection questions truck checklist'],
  ['training.submit', '/training', 'Request training', 'class course ask for training'],
  ['training.submit', '/training/topics', 'Topics', 'training topics subjects'],
  ['training.view', '/admin/training', 'Training log', 'training requests'],
  ['training.view', '/admin/training/sessions', 'Sessions', 'training sessions classes attendance'],
  ['certs.manage', '/admin/certs', 'Certifications', 'licenses nicet expiring certs'],
  ['', '/oncall', 'On call', 'after hours on-call schedule rota rates who is on call'],
  ['sales.use', '/sales', 'Sales', 'leads prospects customers'],
  ['complaints.submit', '/complaint', 'Anonymous complaint', 'report a problem concern complain'],
  ['users.manage', '/admin/users', 'Users', 'add a person new employee reset password disable account edit people'],
  ['tasks.assign', '/admin/tasks', 'Manage tasks', 'assign a task give a job'],
  ['announcements.post', '/admin/announcements', 'Post announcements', 'new announcement notice'],
  ['newsletters.manage', '/admin/newsletters', 'Newsletters (upload)', 'upload newsletter monthly barker'],
  ['complaints.review', '/admin/complaints', 'Complaints', 'read answer anonymous complaints'],
  ['users.manage', '/poster', 'QR code sign', 'poster sign qr code print'],
  ['activity.view', '/admin/activity', 'Activity log', 'who changed what history audit trail'],
  [(u) => u.scope === 'all' && access.can(u, 'users.manage'), '/admin/import', 'Import', 'upload contact list many people spreadsheet'],
  [everyOffice, '/admin/branches', 'Offices and admins', 'add an office corporate branches'],
  [(u) => everyOffice(u) && access.can(u, 'profiles.manage'), '/admin/profiles', 'Profiles', 'permissions roles what people can do'],
  [(u) => everyOffice(u) && access.can(u, 'backups'), '/admin/backups', 'Backups', 'download backup copy restore'],
  [(u) => everyOffice(u) && access.can(u, 'users.manage'), '/admin/security', 'Security check', 'security sign everyone out'],
  // Not in the menu bar: a person's own pages.
  ['', '/profile', 'My profile', 'my photo picture about me edit profile'],
  ['', '/my', 'My activity', 'what i sent my entries my requests'],
  ['', '/settings/notifications', 'Notification settings', 'alerts push notifications turn on turn off'],
  ['', '/account/password', 'Password and Face ID', 'change password reset my password fingerprint passkey face id'],
  [(u) => require('./manage').has(u), '/manage', 'Manage', 'manager jobs admin run things waiting'],
  ['', '/help', 'Help', 'how to guides manual instructions'],
];
const maySee = (user, who) => (typeof who === 'function' ? who(user) : !who || access.can(user, who));
const like = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;

/** Everything matching what was typed, in groups: [{ name, items: [{ label, sub, url }] }]. Every word typed must match. */
function find(user, typed) {
  const q = String(typed || '').trim().toLowerCase().slice(0, 60);
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
  if (q.length < 2 || !terms.length) return [];
  const all = (text) => terms.every((t) => text.includes(t));
  const groups = [];
  const add = (name, items) => { if (items.length) groups.push({ name, items }); };

  // Pages: a match in the name comes before a match in the other words.
  const pages = PAGES.filter((p) => maySee(user, p[0])).map((p) => {
    const name = p[2].toLowerCase();
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : all(name) ? 2 : all(`${name} ${p[3]}`) ? 3 : -1;
    return { rank, label: p[2], sub: 'Page', url: p[1] };
  }).filter((p) => p.rank >= 0).sort((a, b) => a.rank - b.rank).slice(0, 6).map(({ label, sub, url }) => ({ label, sub, url }));
  add('Pages', pages);

  const guides = help.forUser(user).map((g) => ({ g, rank: all(g.title.toLowerCase()) ? 0 : all(help.words(g)) ? 1 : -1 }))
    .filter((x) => x.rank >= 0).sort((a, b) => a.rank - b.rank).slice(0, 5).map(({ g }) => ({ label: g.title, sub: 'How-to guide', url: `/help/${g.slug}` }));
  add('How-to guides', guides);

  const where = (cols) => terms.map(() => `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND ');
  const args = (n) => terms.flatMap((t) => Array(n).fill(like(t)));
  add('People', db.prepare(
    `SELECT u.id, u.display_name, u.job_title, b.name AS office FROM users u LEFT JOIN branches b ON b.id = u.branch_id
     WHERE (u.active = 1 OR u.in_directory = 1) AND ${where(['u.display_name', "COALESCE(u.job_title, '')"])} ORDER BY u.display_name COLLATE NOCASE LIMIT 6`).all(...args(2))
    .map((p) => ({ label: p.display_name, sub: [p.job_title, p.office].filter(Boolean).join(' · ') || 'Person', url: `/people/${p.id}` })));

  add('Offices', db.prepare(
    `SELECT b.id, b.name FROM branches b WHERE ${where(['b.name'])} AND EXISTS (SELECT 1 FROM users u WHERE u.branch_id = b.id AND (u.active = 1 OR u.in_directory = 1))
     ORDER BY b.name COLLATE NOCASE LIMIT 4`).all(...args(1)).map((b) => ({ label: b.name, sub: 'Office', url: `/branches/${b.id}` })));

  // Parts from the catalog, for people who work with parts: managers land on Stock, everyone else on the parts form.
  const stock = access.can(user, 'parts.view');
  if (stock || access.can(user, 'parts.submit')) {
    add('Parts', db.prepare(
      `SELECT part_number, description FROM parts_catalog WHERE active = 1 AND ${where(['part_number', 'description'])}
       ORDER BY part_number LIKE ? ESCAPE '\\' DESC, part_number COLLATE NOCASE LIMIT 6`).all(...args(2), `${like(terms[0]).slice(1)}`)
      .map((p) => ({ label: p.part_number, sub: p.description || 'Part',
        url: stock ? `/admin/stock?q=${encodeURIComponent(p.part_number)}` : `/parts?action=take&part=${encodeURIComponent(p.part_number)}` })));
  }
  return groups;
}

module.exports = { PAGES, find };
