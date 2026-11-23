'use strict';
// Markets: groups of offices. Corporate admins make them, put offices in them and appoint each market's admins.
// A market admin (a profile with "every office in their own market") runs each office in the market their own
// office belongs to, choosing one at a time from the office box.
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const auth = require('../auth');
const { requireLogin, forbidden, flash } = auth;
const { clean } = require('../util');

const router = express.Router();
const isId = (v) => /^\d+$/.test(String(v || ''));
const everyOffice = (req, res, next) => requireLogin(req, res, () => (req.user.allBranches ? next() : forbidden(res)));
const market = (id) => (isId(id) ? db.prepare('SELECT * FROM markets WHERE id = ?').get(id) : null) || null;

/** Profiles that make someone a market admin: every office in their market, but not every office. */
const marketProfiles = () => db.prepare('SELECT id, name, scope FROM profiles ORDER BY name COLLATE NOCASE').all()
  .map((p) => ({ ...p, perms: access.permsOf(p.id) })).filter((p) => p.perms.has('market.all') && !p.perms.has('branches.all'));
const grantable = (req) => marketProfiles().filter((p) => access.canGrant(req.user, p.perms));

// Once: a Market admin profile to hand out (an office admin's permissions, plus the market). It is an ordinary
// profile afterwards and can be changed on the Profiles page.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'market_admin_profile_1'").get()) {
  if (!marketProfiles().length && !access.profileByName('Market admin')) access.createProfile('Market admin', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'backups'));
  db.prepare("INSERT INTO meta (key, value) VALUES ('market_admin_profile_1', ?)").run(new Date().toISOString());
}

// Once: the first market, with the offices it was asked to hold. Offices are found by name; any that are not on the
// site yet are simply left for a corporate admin to add on the Markets page.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'market_seed_1'").get()) {
  db.transaction(() => {
    const near = "(state IS NULL OR state = '' OR state IN ('PA', 'DE', 'NJ'))";
    const wanted = ['Ephrata', 'Allentown', 'Downingtown', 'North Wales', 'King of Prussia', 'KOP', 'Wilmington', 'Dover', 'Deptford', 'West Deptford'];
    const found = new Set();
    for (const name of wanted) {
      const exact = db.prepare(`SELECT id FROM branches WHERE name = ? COLLATE NOCASE AND ${near}`).all(name);
      const hits = exact.length ? exact : db.prepare(`SELECT id FROM branches WHERE (name LIKE ? OR name LIKE ?) AND ${near}`).all(`${name} (%`, `${name},%`);
      hits.forEach((h) => found.add(h.id));
    }
    if (found.size && !db.prepare('SELECT 1 FROM markets').get()) {
      const id = db.prepare('INSERT INTO markets (name, created_at) VALUES (?, ?)').run('NJ/PA/DE', new Date().toISOString()).lastInsertRowid;
      for (const b of found) db.prepare('UPDATE branches SET market_id = ? WHERE id = ? AND market_id IS NULL').run(id, b);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('market_seed_1', ?)").run(new Date().toISOString());
  })();
}

function page(req, res, extra = {}) {
  const profiles = marketProfiles().map((p) => p.id);
  const markets = db.prepare('SELECT * FROM markets ORDER BY name COLLATE NOCASE').all().map((m) => {
    const offices = db.prepare(`SELECT b.id, b.name, b.number, b.state, (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.active = 1) AS people
                                FROM branches b WHERE b.market_id = ? ORDER BY b.name COLLATE NOCASE`).all(m.id);
    const ids = offices.map((o) => o.id);
    const inMarket = ids.length ? `u.branch_id IN (${ids.join(',')}) AND u.is_master = 0 AND u.removed_at IS NULL` : '0';
    return { ...m, offices,
      admins: profiles.length ? db.prepare(`SELECT u.id, u.display_name, b.name AS office, p.name AS profile FROM users u JOIN profiles p ON p.id = u.profile_id JOIN branches b ON b.id = u.branch_id
                                            WHERE ${inMarket} AND u.profile_id IN (${profiles.join(',')}) ORDER BY u.display_name COLLATE NOCASE`).all() : [],
      people: db.prepare(`SELECT u.id, u.display_name, b.name AS office FROM users u JOIN branches b ON b.id = u.branch_id
                          WHERE ${inMarket} AND u.id <> ? ${profiles.length ? `AND (u.profile_id IS NULL OR u.profile_id NOT IN (${profiles.join(',')}))` : ''}
                          AND (u.profile_id IS NULL OR u.profile_id NOT IN (SELECT profile_id FROM profile_permissions WHERE permission = 'branches.all'))
                          ORDER BY u.display_name COLLATE NOCASE`).all(req.user.id) };
  });
  const created = req.session.created || null; delete req.session.created;
  res.status(extra.errors ? 400 : 200).render('admin_markets', {
    title: 'Markets', wide: true, markets, created, errors: [], values: {}, adminProfiles: grantable(req),
    offices: db.prepare('SELECT b.id, b.name, b.number, b.city, b.state, b.region, b.marketing_name, m.name AS market FROM branches b LEFT JOIN markets m ON m.id = b.market_id ORDER BY b.name COLLATE NOCASE').all()
      .map((b) => ({ ...b, find: require('../util').officeWords(b) })),
    loose: db.prepare('SELECT COUNT(*) AS n FROM branches WHERE market_id IS NULL').get().n, ...extra,
  });
}
router.get('/admin/markets', everyOffice, (req, res) => page(req, res));

router.post('/admin/markets', everyOffice, (req, res) => {
  const name = clean(req.body.name, 60);
  if (!name) return page(req, res, { errors: ['Give the market a name.'] });
  if (db.prepare('SELECT 1 FROM markets WHERE name = ?').get(name)) return page(req, res, { errors: ['There is already a market with that name.'], values: { name } });
  const id = db.prepare('INSERT INTO markets (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString()).lastInsertRowid;
  activity.log(req.user, 'Market added', name);
  flash(req, 'ok', `${name} market added. Add its offices below.`);
  res.redirect(`/admin/markets#m${id}`);
});

// Rename a market, or remove it (its offices stay; they are simply in no market).
router.post('/admin/markets/:id', everyOffice, (req, res) => {
  const m = market(req.params.id);
  if (!m) return res.redirect('/admin/markets');
  if (req.body.op === 'remove') {
    db.transaction(() => { db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(m.id); db.prepare('DELETE FROM markets WHERE id = ?').run(m.id); })();
    activity.log(req.user, 'Market removed', m.name);
    flash(req, 'ok', `${m.name} market removed. Its offices are in no market now.`);
    return res.redirect('/admin/markets');
  }
  const name = clean(req.body.name, 60);
  if (!name || db.prepare('SELECT 1 FROM markets WHERE name = ? AND id <> ?').get(name, m.id)) flash(req, 'err', 'That name is empty or already used.');
  else { db.prepare('UPDATE markets SET name = ? WHERE id = ?').run(name, m.id); activity.log(req.user, 'Market renamed', `${m.name} to ${name}`); flash(req, 'ok', 'Market renamed.'); }
  res.redirect(`/admin/markets#m${m.id}`);
});

// Put an office in a market: picked from the list (its id is sent), or its name or number typed in full.
router.post('/admin/markets/:id/offices', everyOffice, (req, res) => {
  const m = market(req.params.id);
  if (!m) return res.redirect('/admin/markets');
  const typed = clean(req.body.office, 80);
  let hits = isId(req.body.branch) ? db.prepare('SELECT * FROM branches WHERE id = ?').all(req.body.branch) : [];
  if (!hits.length && typed) hits = db.prepare('SELECT * FROM branches WHERE name = ? COLLATE NOCASE OR number = ?').all(typed, typed.replace(/^#/, ''));
  if (hits.length !== 1) { flash(req, 'err', typed ? `No single office matches "${typed}". Pick one from the list as you type.` : 'Choose an office.'); return res.redirect(`/admin/markets#m${m.id}`); }
  const b = hits[0]; const was = b.market_id && b.market_id !== m.id ? market(b.market_id) : null;
  db.prepare('UPDATE branches SET market_id = ? WHERE id = ?').run(m.id, b.id);
  activity.log(req.user, 'Market changed', `${b.name} added to ${m.name}${was ? ` (was in ${was.name})` : ''}`);
  flash(req, 'ok', `${b.name} is now in the ${m.name} market.${was ? ` It was moved from ${was.name}.` : ''}`);
  res.redirect(`/admin/markets#m${m.id}`);
});
router.post('/admin/markets/:id/offices/:bid/remove', everyOffice, (req, res) => {
  const m = market(req.params.id); const b = m && isId(req.params.bid) ? db.prepare('SELECT * FROM branches WHERE id = ? AND market_id = ?').get(req.params.bid, m.id) : null;
  if (b) { db.prepare('UPDATE branches SET market_id = NULL WHERE id = ?').run(b.id); activity.log(req.user, 'Market changed', `${b.name} taken out of ${m.name}`); flash(req, 'ok', `${b.name} is no longer in the ${m.name} market.`); }
  res.redirect(m ? `/admin/markets#m${m.id}` : '/admin/markets');
});

// A market's admin: always someone already on the site in one of its offices, chosen by a corporate admin.
router.post('/admin/markets/:id/admins', everyOffice, (req, res) => {
  const m = market(req.params.id);
  if (!m) return res.redirect('/admin/markets');
  const profile = grantable(req).find((p) => String(p.id) === String(req.body.profile_id));
  if (!profile) return page(req, res, { errors: ['Choose which market admin profile they get.'] });
  const inMarket = 'u.branch_id IN (SELECT id FROM branches WHERE market_id = ?) AND u.is_master = 0 AND u.removed_at IS NULL';
  let u = isId(req.body.user_id) ? db.prepare(`SELECT u.* FROM users u WHERE u.id = ? AND ${inMarket}`).get(req.body.user_id, m.id) : null;
  const typed = clean(req.body.person, 80);
  if (!u && typed && !isId(req.body.user_id)) {
    const same = db.prepare(`SELECT u.* FROM users u WHERE u.display_name = ? COLLATE NOCASE AND ${inMarket}`).all(typed, m.id);
    if (same.length === 1) u = same[0];
    else if (same.length > 1) return page(req, res, { errors: [`More than one person in ${m.name} is called ${typed}. Pick the one you mean from the list.`] });
  }
  if (!u || u.id === req.user.id) return page(req, res, { errors: [`Choose someone from one of the ${m.name} market's offices. A person who is not on the site yet is added under Users first.`] });
  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profile.id, u.id);
  activity.log(req.user, 'Market admin appointed', `${u.display_name} for ${m.name} (${profile.name})`);
  if (!u.active) {
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(u.id);
    req.session.created = { username: u.username, name: u.display_name, password: auth.issueTemp(u.id), market: m.name };
    return res.redirect('/admin/markets');
  }
  flash(req, 'ok', `${u.display_name} is now an admin for the ${m.name} market.`);
  res.redirect(`/admin/markets#m${m.id}`);
});
// Stand a market admin down: back to the Technician profile, and signed out so the wider view ends at once.
router.post('/admin/markets/:id/admins/:uid/remove', everyOffice, (req, res) => {
  const m = market(req.params.id);
  const u = m && isId(req.params.uid) ? db.prepare('SELECT u.* FROM users u WHERE u.id = ? AND u.is_master = 0 AND u.branch_id IN (SELECT id FROM branches WHERE market_id = ?)').get(req.params.uid, m.id) : null;
  const tech = access.profileByName('Technician');
  if (u && tech && u.id !== req.user.id && marketProfiles().some((p) => p.id === u.profile_id) && access.canGrant(req.user, access.permsOf(u.profile_id))) {
    db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(tech.id, u.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(u.id);
    activity.log(req.user, 'Market admin stood down', `${u.display_name}, ${m.name}`);
    flash(req, 'ok', `${u.display_name} is no longer a market admin. They are on the Technician profile now; change it under Users if needed.`);
  }
  res.redirect(m ? `/admin/markets#m${m.id}` : '/admin/markets');
});

module.exports = router;
