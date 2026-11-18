'use strict';
// Who reports to whom. One table (user_managers) holds it: a manager and the people who report to them.
// It draws the team chart on an office's page, fills "Managed by" on the Users page, and decides which
// people a manager-profile account can see.
const db = require('./db');

// Who leads what: `leads` on a person is a department's name, or '*' for the whole office. `manager_manual` is 1
// when someone chose that person's manager by hand; otherwise it follows from their department (see applyAuto).
for (const [col, type] of [['leads', 'TEXT'], ['manager_manual', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?").get(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
}
// Links made before this existed (a manager's team ticked by hand) stay as they are.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'manager_manual_1'").get()) {
  db.transaction(() => {
    db.prepare('UPDATE users SET manager_manual = 1 WHERE id IN (SELECT user_id FROM user_managers)').run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('manager_manual_1', '1')").run();
  })();
}
const WHOLE = '*';

/** The person someone reports to (the first, if an older setup gave them several), or null. */
function managerOf(userId) {
  return db.prepare(`SELECT m.id, m.display_name, m.photo_path, m.job_title FROM user_managers um JOIN users m ON m.id = um.manager_id
    WHERE um.user_id = ? ORDER BY m.display_name COLLATE NOCASE LIMIT 1`).get(userId) || null;
}

/** Everyone under a manager, however many levels down. */
function everyoneUnder(managerId) {
  const seen = new Set(); let layer = [managerId];
  const kids = db.prepare('SELECT user_id FROM user_managers WHERE manager_id = ?');
  while (layer.length && seen.size < 5000) {
    const next = [];
    for (const id of layer) for (const r of kids.all(id)) if (r.user_id !== managerId && !seen.has(r.user_id)) { seen.add(r.user_id); next.push(r.user_id); }
    layer = next;
  }
  return [...seen];
}

/**
 * Set who a person reports to (null for nobody). Refused, returning a reason, when the manager is the person
 * themselves, is in another office, or already reports (directly or not) to this person.
 */
function setManager(userId, managerId) {
  if (!managerId) { db.prepare('DELETE FROM user_managers WHERE user_id = ?').run(userId); return null; }
  if (managerId === userId) return 'nobody reports to themselves';
  const pair = db.prepare('SELECT (SELECT branch_id FROM users WHERE id = ?) AS a, (SELECT branch_id FROM users WHERE id = ?) AS b').get(userId, managerId);
  if (!pair.b || pair.a !== pair.b) return 'they are in different offices';
  if (everyoneUnder(userId).includes(managerId)) return 'that person already reports to them';
  db.prepare('DELETE FROM user_managers WHERE user_id = ?').run(userId);
  db.prepare('INSERT OR IGNORE INTO user_managers (manager_id, user_id) VALUES (?, ?)').run(managerId, userId);
  return null;
}

/**
 * Arrange an office's people as a chart. Returns { tops, rest }: `tops` are the people at the head of a team
 * (each with `reports`, nested), `rest` is everyone who neither leads nor reports to anyone here.
 */
function chart(people) {
  const byId = new Map(people.map((p) => [p.id, { ...p, reports: [] }]));
  if (!people.length) return { tops: [], rest: [] };
  const links = db.prepare(`SELECT manager_id, user_id FROM user_managers WHERE user_id IN (${people.map((p) => Number(p.id)).join(',')}) ORDER BY manager_id`).all();
  const placed = new Set();
  for (const l of links) {
    const m = byId.get(l.manager_id), u = byId.get(l.user_id);
    if (!m || !u || placed.has(u.id)) continue;
    m.reports.push(u); placed.add(u.id);
  }
  const tops = [], rest = [];
  for (const p of byId.values()) { if (placed.has(p.id)) continue; (p.reports.length ? tops : rest).push(p); }
  const size = (p) => p.reports.reduce((n, r) => n + 1 + size(r), 0);
  // People who lead a team come before those who do not, at every level.
  const order = (list) => { list.sort((a, b) => size(b) - size(a) || a.display_name.localeCompare(b.display_name)); list.forEach((x) => order(x.reports)); };
  order(tops);
  return { tops, rest };
}

// ---- Job titles: one company-wide list. Each title says which title it reports to, and that is what places
// a person on the chart: pick someone's job title and who they report to follows.
db.exec(`CREATE TABLE IF NOT EXISTS job_titles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, department TEXT, parent_id INTEGER REFERENCES job_titles(id) ON DELETE SET NULL)`);

const titleByName = (name) => (name ? db.prepare('SELECT * FROM job_titles WHERE name = ? COLLATE NOCASE').get(String(name).trim()) : null) || null;

/** Every title, top of the office first, then by name, with the title it reports to and how many people hold it. */
function titles() {
  return db.prepare(`SELECT t.*, p.name AS parent_name,
      (SELECT COUNT(*) FROM users u WHERE u.job_title = t.name COLLATE NOCASE AND (u.active = 1 OR u.in_directory = 1)) AS holders
    FROM job_titles t LEFT JOIN job_titles p ON p.id = t.parent_id ORDER BY (t.parent_id IS NULL) DESC, t.name COLLATE NOCASE`).all();
}

/** Make sure a title is on the list (a contact list or an older record may bring a new one). New ones report to the top title. */
function ensureTitle(name, department) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) return null;
  const have = titleByName(clean);
  if (have) return have;
  const top = db.prepare('SELECT id FROM job_titles WHERE parent_id IS NULL ORDER BY id LIMIT 1').get();
  db.prepare('INSERT INTO job_titles (name, department, parent_id) VALUES (?, ?, ?)').run(clean, String(department || '').trim().slice(0, 60) || null, top ? top.id : null);
  return titleByName(clean);
}

/** Would making `parentId` the parent of `titleId` create a loop? */
function titleLoop(titleId, parentId) {
  const up = db.prepare('SELECT parent_id FROM job_titles WHERE id = ?');
  for (let cur = parentId, n = 0; cur && n < 200; n++) { if (cur === titleId) return true; cur = (up.get(cur) || {}).parent_id; }
  return false;
}

let seededNow = false;
// The starting list, made once: the usual management titles, then every title people already have.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'job_titles_1'").get()) {
  db.transaction(() => {
    const add = (name, dept, parent) => { if (!titleByName(name)) db.prepare('INSERT INTO job_titles (name, department, parent_id) VALUES (?, ?, ?)').run(name, dept, parent ? titleByName(parent).id : null); };
    add('General Manager', 'Management', null); add('Operations Manager', 'Management', 'General Manager'); add('Office Manager', 'Management', 'General Manager');
    add('Installation Manager', 'Management', 'Operations Manager'); add('Service Manager', 'Management', 'Operations Manager');
    const used = db.prepare(`SELECT job_title AS name, MAX(department) AS department FROM users WHERE job_title IS NOT NULL AND TRIM(job_title) <> '' GROUP BY job_title COLLATE NOCASE`).all();
    for (const u of used) {
      const n = u.name.trim();
      add(n, u.department || null, /^install(ation)?\s+tech/i.test(n) ? 'Installation Manager' : /^service\s+tech/i.test(n) ? 'Service Manager' : 'General Manager');
    }
    if (!used.some((u) => /^install(ation)?\s+tech/i.test(u.name.trim()))) add('Installation Tech', 'Installation', 'Installation Manager');
    if (!used.some((u) => /^service\s+tech/i.test(u.name.trim()))) add('Service Tech', 'Service', 'Service Manager');
    db.prepare("INSERT INTO meta (key, value) VALUES ('job_titles_1', '1')").run();
  })();
  seededNow = true;
}

/**
 * Work out who everyone in an office reports to from their job title, for everybody not set by hand:
 * the person in the office who holds the title theirs reports to. If nobody there holds it, the next title
 * up is tried, and so on. Someone with no job title, or the top title, reports to nobody.
 */
function applyAuto(branchId) {
  if (!branchId) return;
  const people = db.prepare('SELECT id, display_name, job_title, manager_manual FROM users WHERE branch_id = ? AND (active = 1 OR in_directory = 1) ORDER BY display_name COLLATE NOCASE').all(branchId);
  const list = db.prepare('SELECT id, name, parent_id FROM job_titles').all();
  const byId = new Map(list.map((t) => [t.id, t])); const byName = new Map(list.map((t) => [t.name.toLowerCase(), t]));
  const holders = new Map();
  for (const p of people) { const t = byName.get(String(p.job_title || '').trim().toLowerCase()); p.title = t || null; if (t) { if (!holders.has(t.id)) holders.set(t.id, []); holders.get(t.id).push(p); } }
  const current = db.prepare('SELECT manager_id FROM user_managers WHERE user_id = ?');
  db.transaction(() => {
    for (const p of people) {
      if (p.manager_manual) continue;
      let target = null; const seen = new Set();
      for (let cur = p.title && p.title.parent_id; cur && !seen.has(cur) && !target; cur = (byId.get(cur) || {}).parent_id) {
        seen.add(cur);
        const boss = (holders.get(cur) || []).find((h) => h.id !== p.id);
        if (boss) target = boss.id;
      }
      const now = current.all(p.id).map((r) => r.manager_id);
      if ((target === null && !now.length) || (now.length === 1 && now[0] === target)) continue;
      if (setManager(p.id, target)) setManager(p.id, null);
    }
  })();
}

/** Run applyAuto for every office that has people (after the list of titles changes). */
function applyAutoEverywhere() {
  for (const r of db.prepare('SELECT DISTINCT branch_id FROM users WHERE branch_id IS NOT NULL').all()) applyAuto(r.branch_id);
}

// The first time the list exists, place everyone from the titles they already have.
if (seededNow) applyAutoEverywhere();

module.exports = { managerOf, everyoneUnder, setManager, chart, applyAuto, applyAutoEverywhere, titles, titleByName, ensureTitle, titleLoop, WHOLE };
