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

/**
 * Work out who everyone in an office reports to from what people lead, for everybody not set by hand:
 * - someone leads your department: you report to them;
 * - otherwise you report to whoever leads the whole office;
 * - the person who leads the whole office reports to nobody.
 * A choice that would make a loop falls back to the office lead, then to nobody.
 */
function applyAuto(branchId) {
  if (!branchId) return;
  const people = db.prepare(`SELECT id, display_name, department, leads, manager_manual FROM users WHERE branch_id = ? AND (active = 1 OR in_directory = 1)
    ORDER BY (leads = '${WHOLE}') DESC, (leads IS NOT NULL AND leads <> '') DESC, display_name COLLATE NOCASE`).all(branchId);
  const key = (s) => String(s || '').trim().toLowerCase();
  const head = people.find((p) => p.leads === WHOLE) || null;
  const leadOf = new Map();
  for (const p of people) if (p.leads && p.leads !== WHOLE && !leadOf.has(key(p.leads))) leadOf.set(key(p.leads), p);
  const current = db.prepare('SELECT manager_id FROM user_managers WHERE user_id = ?');
  db.transaction(() => {
    for (const p of people) {
      if (p.manager_manual) continue;
      const lead = leadOf.get(key(p.department));
      const wanted = [lead && lead.id !== p.id ? lead.id : null, head && head.id !== p.id ? head.id : null].filter(Boolean);
      const target = p === head ? null : wanted[0] || null;
      const now = current.all(p.id).map((r) => r.manager_id);
      if ((target === null && !now.length) || (now.length === 1 && now[0] === target)) continue;
      if (setManager(p.id, target) && (!wanted[1] || setManager(p.id, wanted[1]))) setManager(p.id, null);
    }
  })();
}

module.exports = { managerOf, everyoneUnder, setManager, chart, applyAuto, WHOLE };
