'use strict';
// Who a post is for: one office, every office of a market, or the whole company.
// A post carries branch_id and market_id. Both empty = the whole company; market_id set = that market
// (branch_id then says which office it was posted from); otherwise it is for the one office in branch_id.
// What a person sees follows the office they are looking at: that office's posts, its market's, and the company's.
const db = require('./db');

const marketOf = (officeId) => (officeId ? (db.prepare('SELECT market_id FROM branches WHERE id = ?').get(officeId) || {}).market_id || null : null);
const officeName = (id) => (id ? (db.prepare('SELECT name FROM branches WHERE id = ?').get(id) || {}).name || '' : '');
const marketName = (id) => (id ? (db.prepare('SELECT name FROM markets WHERE id = ?').get(id) || {}).name || '' : '');

/** The office being looked at and its market. `corporate` = every office at once (the Corporate view). */
function place(user) {
  if (!user.place) {
    const corporate = Boolean(user.allBranches && user.viewBranch === null);
    const office = corporate ? null : (user.workBranch || user.branch_id || null);
    user.place = { corporate, office, market: marketOf(office) };
  }
  return user.place;
}

/** The values for @office and @market in the SQL below. */
const params = (user) => { const p = place(user); return { office: p.office, market: p.market }; };

/** SQL: is the row with alias `x` shown in the place? The Corporate view has no office, so it gets company posts only. */
const shown = (x) => `((${x}.branch_id IS NULL AND ${x}.market_id IS NULL) OR (${x}.market_id IS NOT NULL AND ${x}.market_id = @market) OR (${x}.market_id IS NULL AND ${x}.branch_id = @office))`;

/** The same test for one row already read. */
function isShown(user, row) {
  const p = place(user);
  if (row.market_id) return row.market_id === p.market;
  if (row.branch_id === null || row.branch_id === undefined) return true;
  return row.branch_id === p.office;
}

/** The offices this person runs: null = every office. */
const runsOffices = (user) => (user.allBranches ? null : user.marketBranches && user.marketBranches.length ? user.marketBranches : [user.branch_id]);

/** May this person change or remove the post? A company post needs every office; a market post needs the market. */
function runs(user, row) {
  if (user.allBranches) return true;
  if (row.branch_id === null || row.branch_id === undefined) return false;
  if (row.market_id && !(user.perms && user.perms.has('market.all'))) return false;
  return runsOffices(user).includes(row.branch_id);
}

/**
 * Who this person may post for, narrowest first: [{ key: 'office' | 'market' | 'company', label }].
 * Anyone posts for the office they are looking at; the market needs a market admin; the company a corporate admin.
 */
function choices(user) {
  if (user.scope === 'team') return [];
  const p = place(user); const out = [];
  if (p.office) out.push({ key: 'office', label: `${officeName(p.office)} branch only` });
  if (p.market && (user.allBranches || (user.perms && user.perms.has('market.all')))) out.push({ key: 'market', label: `The ${marketName(p.market)} market` });
  if (user.allBranches) out.push({ key: 'company', label: 'The whole company' });
  return out;
}

/** Where a new post goes for the choice made. A choice that is not theirs to make falls back to the narrowest they have. */
function target(user, key) {
  const list = choices(user);
  const want = key === 'everyone' ? 'company' : key === 'branch' ? 'office' : key;
  const pick = list.find((c) => c.key === want) || list[0];
  const p = place(user);
  if (!pick) return { branch_id: user.branch_id, market_id: null, key: 'office' };
  if (pick.key === 'company') return { branch_id: null, market_id: null, key: 'company' };
  if (pick.key === 'market') return { branch_id: p.office, market_id: p.market, key: 'market' };
  return { branch_id: p.office, market_id: null, key: 'office' };
}

/** "Ephrata office", "Del-Valley market" or "Whole company". */
function label(row) {
  if (row.market_id) return `${marketName(row.market_id)} market`;
  if (row.branch_id === null || row.branch_id === undefined) return 'Whole company';
  return `${officeName(row.branch_id)} branch`;
}

/** The offices whose people share birthdays, new faces and shout-outs with this office: its market, or just itself. */
function marketOffices(officeId) {
  if (!officeId) return [];
  const m = marketOf(officeId);
  return m ? db.prepare('SELECT id FROM branches WHERE market_id = ? ORDER BY name COLLATE NOCASE').all(m).map((r) => r.id) : [officeId];
}

module.exports = { place, params, shown, isShown, runs, runsOffices, choices, target, label, marketOffices, marketOf, officeName, marketName };
