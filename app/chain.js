'use strict';
// The chain of command: an office answers to its market, and a market to corporate. Nothing is stored for it. It is
// worked out from where each person's profile sits (position() in permissions.js: a level, and admin or manager)
// and from the office they belong to. Who reports to whom inside an office is separate: see team.js.
const db = require('./db');
const access = require('./permissions');

const SHOWN = 12;   // names listed for one step; a long corporate list says how many more there are

/** Where each profile sits: id -> { name, level, kind, rank }. */
function places() {
  const out = new Map();
  for (const p of db.prepare('SELECT id, name, scope FROM profiles').all()) out.set(p.id, { name: p.name, ...access.position(p.scope, access.permsOf(p.id)) });
  return out;
}

/** The admins and managers at one level, among the people matched by `where`. Admins first. */
function leaders(pl, level, where, args) {
  const ids = [...pl].filter(([, at]) => at.level === level && at.kind !== 'staff').map(([id]) => Number(id));
  // The master account is at the top whatever profile it carries, and nowhere else.
  const who = level === 'company' ? `(u.is_master = 1 OR u.profile_id IN (${ids.join(',') || 0}))` : `u.is_master = 0 AND u.profile_id IN (${ids.join(',') || 0})`;
  if (!ids.length && level !== 'company') return [];
  return db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.job_title, u.profile_id, u.is_master FROM users u
      WHERE u.active = 1 AND u.removed_at IS NULL AND ${who} AND ${where}`).all(...args)
    .map((u) => { const at = u.is_master ? { name: 'Master account', kind: 'admin', rank: 9 } : pl.get(u.profile_id); return { id: u.id, display_name: u.display_name, photo_path: u.photo_path, job_title: u.job_title, role: at.name, kind: at.kind, rank: at.rank }; })
    .sort((x, y) => y.rank - x.rank || x.display_name.localeCompare(y.display_name));
}

/**
 * What a branch's own page shows: the people who run that branch, and nothing above them. (For Corporate, which is
 * not a branch, the corporate admins and managers.) The levels above are met one at a time: see above().
 */
function forOffice(officeId) { const steps = whole(officeId); return steps.slice(-1).map(cut); }
/** A step with its first few names, and how many more there are. */
const cut = (s) => ({ ...s, more: Math.max(0, s.people.length - SHOWN), people: s.people.slice(0, SHOWN) });
function whole(officeId) {
  const office = db.prepare('SELECT b.id, b.name, b.market_id, m.name AS market FROM branches b LEFT JOIN markets m ON m.id = b.market_id WHERE b.id = ?').get(officeId);
  if (!office) return [];
  const pl = places();
  const steps = [{ key: 'company', label: 'Corporate', people: leaders(pl, 'company', '1 = 1', []) }];
  if (office.market_id) steps.push({ key: 'market', label: `${office.market} market management`, people: leaders(pl, 'market', 'u.branch_id IN (SELECT id FROM branches WHERE market_id = ?)', [office.market_id]) });
  // Corporate is not a branch: its people answer straight to the corporate admins and managers.
  if (!require('./branches').isCorporate(office.id)) steps.push({ key: 'office', label: `${office.name} branch management`, people: leaders(pl, 'office', 'u.branch_id = ?', [office.id]) });
  return steps;
}

/**
 * Who is directly above one person: one step only, so nobody's page carries the whole ladder. Staff see the people
 * who run their branch; those people see their market's management; the market's see corporate. A manager sees
 * the admins of their own level first. Where a level has nobody yet, the next one up stands in. Empty at the top.
 */
function above(userId) {
  const u = db.prepare('SELECT id, branch_id, profile_id, is_master FROM users WHERE id = ?').get(userId);
  if (!u || !u.branch_id || u.is_master) return [];
  const mine = u.profile_id ? places().get(u.profile_id) : null;
  const rank = mine ? mine.rank : 0;
  return whole(u.branch_id).reverse()
    .map((s) => ({ ...s, people: s.people.filter((p) => p.id !== u.id && p.rank > rank) }))
    .filter((s) => s.people.length).slice(0, 1).map(cut);
}

module.exports = { forOffice, above };
