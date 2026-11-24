'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const oncall = require('../oncall');
const { requireLogin, requirePerm, verifyCsrf, flash, forbidden } = require('../auth');
const { clean, isYmd, localDate } = require('../util');

const router = express.Router();
const manage = requirePerm('oncall.manage');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8))}`;
const tel = (phone) => String(phone || '').replace(/[^0-9+]/g, '');

/** Groups shifts into stretches of days, each with its people on call and its backups. */
function stretches(rows) {
  const map = new Map();
  for (const s of rows) {
    const key = `${s.market_id ? 'm' + s.market_id : s.branch_id}|${s.start_on}|${s.end_on}`;
    if (!map.has(key)) map.set(key, { branch_id: s.branch_id, market_id: s.market_id || null, office: s.office, start_on: s.start_on, end_on: s.end_on, label: `${short(s.start_on)} to ${short(s.end_on)}`, year: s.start_on.slice(0, 4), tech: [], backup: [], notes: new Set() });
    const g = map.get(key);
    g[s.role].push({ ...s, tel: tel(s.phone) });
    if (s.note) g.notes.add(s.note);
  }
  return [...map.values()].map((g) => ({ ...g, note: [...g.notes].join(', ') }));
}

/** The offices whose schedule this person may add to: every office, their market's, or just the one they are looking at. */
const reachOf = (user) => (user.allBranches ? [] : user.marketBranches && user.marketBranches.length > 1 ? user.marketBranches : [user.workBranch]);   // [] = every office
/** The people who can be put on the schedule by this person, each with their office and the phone on their account. */
function pickable(user) {
  const reach = reachOf(user);
  return db.prepare(`SELECT u.id, u.display_name AS name, u.phone, u.branch_id, b.name AS office FROM users u JOIN branches b ON b.id = u.branch_id
    WHERE u.active = 1 AND u.display_name <> '' ${reach.length ? `AND u.branch_id IN (${reach.map(Number).join(',')})` : ''}
    ORDER BY u.branch_id = ? DESC, u.display_name COLLATE NOCASE LIMIT 6000`).all(user.workBranch);
}

function page(req, res, extra = {}) {
  const today = localDate();
  const offices = oncall.officesFor(req.user);
  const ids = offices.map((o) => o.id);
  const marketId = oncall.marketOf(offices);
  const all = ids.length ? db.prepare(
    `${oncall.SCOPED} WHERE ${oncall.seenBy(ids, marketId)} AND s.end_on > ?
     ORDER BY s.start_on, s.market_id IS NOT NULL, b.name COLLATE NOCASE, s.role = 'backup', s.id LIMIT 4000`).all(today) : [];
  // In a market, anyone can narrow the page to one of its branches, or go back to all of them. The choice is kept
  // for the rest of their visit, so it survives adding to the schedule or coming back from another page.
  if (req.query.branch !== undefined) req.session.oncallBranch = ids.includes(Number(req.query.branch)) ? Number(req.query.branch) : null;
  const only = ids.length > 1 && ids.includes(req.session.oncallBranch) ? offices.find((o) => o.id === req.session.oncallBranch) : null;
  // What covers the whole market covers that branch too, so it stays.
  const list = stretches(all).filter((g) => !only || g.market_id || g.branch_id === only.id);
  // The office being looked at first, then the rest of the market, then what covers the whole market.
  const mineFirst = (a, b) => Boolean(a.market_id) - Boolean(b.market_id) || (b.branch_id === req.user.workBranch) - (a.branch_id === req.user.workBranch);
  const current = list.filter((g) => g.start_on <= today).sort(mineFirst);
  // Offices in the market with nobody down for today: say so, so an empty space is not mistaken for "nobody is on call there".
  const missing = only ? [] : offices.filter((o) => !current.some((g) => !g.market_id && g.branch_id === o.id));
  // On a phone the whole year is a very long scroll: the next four weeks show, and the rest waits behind a button.
  const soon = new Date(`${today}T12:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 28);
  const soonUntil = soon.toISOString().slice(0, 10);
  const upcoming = list.filter((g) => g.start_on > today).map((g, i) => ({ ...g, later: i >= 4 && g.start_on > soonUntil }));
  res.status(extra.errors ? 400 : 200).render('oncall', {
    title: 'On call', wide: true, current, upcoming, laterCount: upcoming.filter((g) => g.later).length, many: !only && (offices.length > 1 || all.some((s) => s.market_id)), market: offices[0] && offices[0].market, missing, officeCount: offices.length,
    // The branches to choose between (their own first), and the one chosen, if any.
    choices: offices.length > 1 ? offices.map((o) => ({ id: o.id, name: o.name, own: o.id === req.user.branch_id })) : [], only,
    canManage: access.can(req.user, 'oncall.manage'), roles: oncall.ROLES,
    // Shifts this person may tick to remove: those of the offices they run.
    canPick: (g) => access.can(req.user, 'oncall.manage') && (!reachOf(req.user).length || reachOf(req.user).includes(g.branch_id)),
    rates: ratesOf(req.user.workBranch),
    // For whoever keeps the schedule: the people of this office to pick from, each with the phone number on their account.
    people: access.can(req.user, 'oncall.manage') ? pickable(req.user) : [], widePick: reachOf(req.user).length !== 1,
    rateOffice: (db.prepare('SELECT name FROM branches WHERE id = ?').get(req.user.workBranch) || {}).name, mine: req.user.workBranch, errors: [], values: {}, problems: [], ...extra,
  });
}
router.get('/oncall', requireLogin, (req, res) => page(req, res));

// ---- On-call rates: what the office pays or charges for on-call work, a line each. Kept by whoever keeps the schedule. ----
db.exec(`
CREATE TABLE IF NOT EXISTS oncall_rates (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  label TEXT NOT NULL,
  rate TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oncall_rates_branch ON oncall_rates(branch_id);
`);
const ratesOf = (branchId) => db.prepare('SELECT * FROM oncall_rates WHERE branch_id = ? ORDER BY position, id').all(branchId);

// Add a rate, change one, or remove one. Always for the office being looked at; another office's line cannot be reached.
router.post('/admin/oncall/rates', manage, (req, res) => {
  const office = req.user.workBranch; const back = '/oncall#rates';
  const line = /^\d+$/.test(String(req.body.id || '')) ? db.prepare('SELECT * FROM oncall_rates WHERE id = ? AND branch_id = ?').get(req.body.id, office) : null;
  if (req.body.id && !line) return forbidden(res);
  if (line && req.body.remove === '1') {
    db.prepare('DELETE FROM oncall_rates WHERE id = ?').run(line.id);
    activity.log(req.user, 'On-call rate removed', line.label);
    flash(req, 'ok', `"${line.label}" was removed.`); return res.redirect(back);
  }
  const label = clean(req.body.label, 80); const rate = clean(req.body.rate, 80);
  if (!label || !rate) { flash(req, 'err', 'Say what the rate is for, and the rate. For example "Weeknight" and "$50".'); return res.redirect(back); }
  const now = new Date().toISOString();
  if (line) {
    db.prepare('UPDATE oncall_rates SET label = ?, rate = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(label, rate, req.user.id, now, line.id);
    activity.log(req.user, 'On-call rate changed', `${label}: ${rate}`);
  } else {
    const last = db.prepare('SELECT COALESCE(MAX(position), 0) AS n FROM oncall_rates WHERE branch_id = ?').get(office).n;
    db.prepare('INSERT INTO oncall_rates (branch_id, label, rate, position, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(office, label, rate, last + 1, req.user.id, now);
    activity.log(req.user, 'On-call rate added', `${label}: ${rate}`);
  }
  flash(req, 'ok', 'Saved.');
  res.redirect(back);
});

// ---- Keeping the schedule: one shift at a time, or the whole year from the spreadsheet ----

router.post('/admin/oncall', manage, (req, res) => {
  const v = { start_on: clean(req.body.start_on, 10), end_on: clean(req.body.end_on, 10), role: req.body.role === 'backup' ? 'backup' : 'tech', name: clean(req.body.name, 80), phone: clean(req.body.phone, 30), note: clean(req.body.note, 120) };
  const errors = [];
  if (!isYmd(v.start_on) || !isYmd(v.end_on)) errors.push('Choose the first day and the day it is handed on.');
  else if (v.end_on <= v.start_on) errors.push('The hand-over day must be after the first day.');
  if (!v.name) errors.push('Enter the person\'s name.');
  if (errors.length) return page(req, res, { errors, values: v, addOpen: true });
  // Someone picked from the list goes on the schedule of their own office, whichever office is being looked at
  // (as long as it is one this person runs). A name typed by hand goes on the office being looked at.
  let branch = req.user.workBranch; let office = '';
  const picked = /^\d+$/.test(String(req.body.user_id || '')) ? db.prepare("SELECT u.branch_id, b.name AS office FROM users u JOIN branches b ON b.id = u.branch_id WHERE u.id = ? AND u.display_name = ? COLLATE NOCASE").get(req.body.user_id, v.name) : null;
  if (picked) { const reach = reachOf(req.user); if (!reach.length || reach.includes(picked.branch_id)) { branch = picked.branch_id; office = picked.office; } }
  const covers = clean(req.body.covers, 60) || null;
  db.prepare('INSERT INTO oncall_shifts (branch_id, start_on, end_on, role, name, phone, covers, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(branch, v.start_on, v.end_on, v.role, v.name, v.phone || null, covers, v.note || null, new Date().toISOString());
  activity.log(req.user, 'On-call schedule changed', `${v.name} added${office ? ' (' + office + ')' : ''}, ${v.start_on} to ${v.end_on}`);
  flash(req, 'ok', office && branch !== req.user.workBranch ? `${v.name} added to the ${office} branch's schedule.` : `${v.name} added to the schedule.`);
  res.redirect('/oncall#schedule');
});

// (Before the routes that take an id, so "import" is not read as one.)
const sheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');
router.post('/admin/oncall/import', manage, (req, res, next) => sheet(req, res, (err) => { req.body = req.body || {}; req.uploadFailed = Boolean(err); next(); }), verifyCsrf, (req, res) => {
  const fail = (msg, problems = []) => page(req, res, { errors: [msg], problems, importOpen: true });
  if (req.uploadFailed || !req.file) return fail('Choose the on-call schedule file (up to 2 MB).');
  if (req.file.buffer.subarray(0, 2).toString('latin1') === 'PK') return fail('That is an Excel workbook. In Excel choose File > Save As > CSV, then upload the CSV file.');
  if (req.file.buffer.subarray(0, 4).toString('latin1') === '%PDF') return fail('That is a PDF. Upload the spreadsheet saved as CSV instead.');
  const rows = require('./catalog').parseCsv(req.file.buffer.toString('utf8'));
  if (oncall.isLong(rows)) return importLong(req, res, rows, fail);
  const { shifts, problems } = oncall.parseSheet(rows);
  if (!shifts.length) return fail(problems[0] || 'No on-call shifts could be read from that file.', problems.slice(1));
  // The sheet replaces whatever the schedule held for the days it covers; anything outside those days is left alone.
  const from = shifts.reduce((a, s) => (s.start_on < a ? s.start_on : a), shifts[0].start_on);
  const to = shifts.reduce((a, s) => (s.end_on > a ? s.end_on : a), shifts[0].end_on);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM oncall_shifts WHERE branch_id = ? AND start_on >= ? AND start_on < ?').run(req.user.workBranch, from, to);
    const add = db.prepare('INSERT INTO oncall_shifts (branch_id, start_on, end_on, role, name, phone, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of shifts) add.run(req.user.workBranch, s.start_on, s.end_on, s.role, s.name, s.phone, s.note, now);
  })();
  activity.log(req.user, 'On-call schedule uploaded', `${shifts.length} entries, ${from} to ${to}`);
  flash(req, 'ok', `Schedule loaded: ${new Set(shifts.map((s) => s.start_on)).size} shifts from ${short(from)} ${from.slice(0, 4)} to ${short(to)} ${to.slice(0, 4)}.${problems.length ? ' ' + problems.length + ' line(s) could not be read: ' + problems.slice(0, 3).join(' ') : ''}`);
  res.redirect('/oncall#schedule');
});

/**
 * A schedule with one line per person, which can cover several offices and the whole market in one file.
 * Each line goes to the office it names (one this person may run), or to the market. A missing phone number is
 * taken from the account of the person with that name. For each office (and the market) in the file, what the
 * schedule held for the days the file covers is replaced.
 */
function importLong(req, res, rows, fail) {
  const { shifts, problems } = oncall.parseLong(rows);
  if (!shifts.length) return fail(problems[0] || 'No on-call shifts could be read from that file.', problems.slice(1));
  const here = req.user.workBranch;
  const reach = req.user.allBranches ? null : (req.user.marketBranches && req.user.marketBranches.length ? req.user.marketBranches : [here]);
  let market = (db.prepare('SELECT market_id FROM branches WHERE id = ?').get(here) || {}).market_id || null;
  let marketHome = here;
  const officeByName = new Map(); const bad = new Set();
  const officeFor = (name) => {
    if (!name) return { branch: here, market: null };
    if (/^(the )?(whole )?market$/i.test(name)) return market ? { branch: marketHome, market } : null;
    if (!officeByName.has(name)) {
      const hits = db.prepare('SELECT id FROM branches WHERE name = ? COLLATE NOCASE OR number = ?').all(name, name.replace(/^#/, '')).filter((b) => !reach || reach.includes(b.id));
      officeByName.set(name, hits.length === 1 ? hits[0].id : null);
    }
    const id = officeByName.get(name);
    return id ? { branch: id, market: null } : null;
  };
  // Looking at an office outside any market (or at Corporate): "Market" means the one market the file's own offices share.
  if (!market && (req.user.allBranches || (req.user.marketBranches || []).length)) {
    const named = [...new Set(shifts.map((x) => x.office).filter((n) => n && !/^(the )?(whole )?market$/i.test(n)))].map((n) => (officeFor(n) || {}).branch).filter(Boolean);
    const found = named.map((id) => ({ id, m: (db.prepare('SELECT market_id FROM branches WHERE id = ?').get(id) || {}).market_id })).filter((x) => x.m);
    if (found.length && new Set(found.map((x) => x.m)).size === 1) { market = found[0].m; marketHome = found[0].id; }
  }
  // Phone numbers from accounts: the one active or listed person with that name, looked for in the market first.
  const phoneOf = (name, branch) => {
    const all = db.prepare("SELECT phone, branch_id FROM users WHERE display_name = ? COLLATE NOCASE AND phone IS NOT NULL AND phone <> '' AND removed_at IS NULL").all(name);
    const near = all.filter((u) => u.branch_id === branch || (market && db.prepare('SELECT 1 FROM branches WHERE id = ? AND market_id = ?').get(u.branch_id, market)));
    const pick = near.length === 1 ? near : all.length === 1 ? all : [];
    return pick.length ? pick[0].phone : null;
  };
  const placed = [];
  for (const s of shifts) { const where = officeFor(s.office); if (!where) { bad.add(s.office); continue; } placed.push(s.clear ? { ...s, ...where } : { ...s, ...where, phone: s.phone || phoneOf(s.name, where.branch) }); }
  if (!placed.length) return fail(`None of the lines could be placed. ${[...bad].length ? 'Not a branch you run, or not found: ' + [...bad].join(', ') + '.' : ''}${market ? '' : ' Lines for "Market" need the branch you are looking at to be in a market.'}`, problems);
  const scopes = new Map();
  for (const s of placed) { const k = s.market ? `m${s.market}` : `b${s.branch}`; const sc = scopes.get(k) || { ...s, from: s.start_on, to: s.end_on }; if (s.start_on < sc.from) sc.from = s.start_on; if (s.end_on > sc.to) sc.to = s.end_on; scopes.set(k, sc); }
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const sc of scopes.values()) {
      if (sc.market) db.prepare('DELETE FROM oncall_shifts WHERE market_id = ? AND start_on >= ? AND start_on < ?').run(sc.market, sc.from, sc.to);
      else db.prepare('DELETE FROM oncall_shifts WHERE branch_id = ? AND market_id IS NULL AND start_on >= ? AND start_on < ?').run(sc.branch, sc.from, sc.to);
    }
    const add = db.prepare('INSERT INTO oncall_shifts (branch_id, market_id, start_on, end_on, role, name, phone, covers, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of placed) if (!s.clear) add.run(s.branch, s.market, s.start_on, s.end_on, s.role, s.name, s.phone, s.covers, s.note, now);
  })();
  const entered = placed.filter((s) => !s.clear); const cleared = placed.filter((s) => s.clear).length;
  const noPhone = [...new Set(entered.filter((s) => !s.phone).map((s) => s.name))];
  activity.log(req.user, 'On-call schedule uploaded', `${entered.length} entries across ${scopes.size} ${scopes.size === 1 ? 'place' : 'places'}`);
  flash(req, 'ok', `Schedule loaded: ${entered.length} entries.${cleared ? ' Earlier entries were cleared where the file asked.' : ''}${bad.size ? ` Skipped lines for: ${[...bad].join(', ')} (not found, or not a branch you run).` : ''}${noPhone.length ? ` No phone number on file for ${noPhone.length}: ${noPhone.slice(0, 12).join(', ')}${noPhone.length > 12 ? '…' : ''}.` : ''}${problems.length ? ` ${problems.length} line(s) could not be read.` : ''}`);
  res.redirect('/oncall#schedule');
}

// Remove the ticked shifts in one go (tick them all to clear the schedule). Only shifts of offices this person runs.
router.post('/admin/oncall/clear', manage, (req, res) => {
  const ids = [...new Set([].concat(req.body.ids || []).join(',').split(',').filter((x) => /^\d{1,12}$/.test(x)).map(Number))].slice(0, 5000);
  const reach = reachOf(req.user);
  const mine = ids.length ? db.prepare(`SELECT id FROM oncall_shifts WHERE id IN (${ids.join(',')}) ${reach.length ? `AND branch_id IN (${reach.map(Number).join(',')})` : ''}`).all().map((r) => r.id) : [];
  if (mine.length) {
    db.prepare(`DELETE FROM oncall_shifts WHERE id IN (${mine.join(',')})`).run();
    activity.log(req.user, 'On-call schedule changed', `${mine.length} ${mine.length === 1 ? 'entry' : 'entries'} removed`);
    flash(req, 'ok', `Removed ${mine.length} ${mine.length === 1 ? 'person' : 'people'} from the schedule.`);
  } else flash(req, 'error', 'Tick the shifts to remove first.');
  res.redirect('/oncall#schedule');
});

router.post('/admin/oncall/:id/delete', manage, (req, res) => {
  const s = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM oncall_shifts WHERE id = ? AND branch_id = ?').get(req.params.id, req.user.workBranch) : null;
  if (s) { db.prepare('DELETE FROM oncall_shifts WHERE id = ?').run(s.id); activity.log(req.user, 'On-call schedule changed', `${s.name} removed, ${s.start_on} to ${s.end_on}`); flash(req, 'ok', `${s.name} removed from that shift.`); }
  res.redirect('/oncall#schedule');
});

// Swap one person for another on a shift (someone covering for a colleague).
router.post('/admin/oncall/:id', manage, (req, res) => {
  const s = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM oncall_shifts WHERE id = ? AND branch_id = ?').get(req.params.id, req.user.workBranch) : null;
  const name = clean(req.body.name, 80);
  if (s && name) {
    db.prepare('UPDATE oncall_shifts SET name = ?, phone = ? WHERE id = ?').run(name, clean(req.body.phone, 30) || null, s.id);
    activity.log(req.user, 'On-call schedule changed', `${s.name} swapped for ${name}, ${s.start_on} to ${s.end_on}`);
    flash(req, 'ok', 'Saved.');
  }
  res.redirect('/oncall#schedule');
});

module.exports = router;
