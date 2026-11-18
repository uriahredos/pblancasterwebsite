'use strict';
// Who reports to whom. One table (user_managers) holds it: a manager and the people who report to them.
// It draws the team chart on an office's page, fills "Managed by" on the Users page, and decides which
// people a manager-profile account can see.
const db = require('./db');

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
  tops.sort((a, b) => size(b) - size(a) || a.display_name.localeCompare(b.display_name));
  return { tops, rest };
}

module.exports = { managerOf, everyoneUnder, setManager, chart };
