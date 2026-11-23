'use strict';
// The on-call schedule: for each shift, who takes the calls and who backs them up.
// Several people can be on call for the same days (a market may have three or four), each with a phone number.
const db = require('./db');
const { localDate } = require('./util');

db.exec(`
CREATE TABLE IF NOT EXISTS oncall_shifts (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  start_on TEXT NOT NULL,          -- first day (the hand-over day)
  end_on TEXT NOT NULL,            -- the day it is handed on; that day belongs to the next person
  role TEXT NOT NULL DEFAULT 'tech' CHECK (role IN ('tech','backup')),
  name TEXT NOT NULL,
  phone TEXT,
  note TEXT,                       -- a holiday in that stretch, or anything else worth knowing
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oncall_branch ON oncall_shifts(branch_id, start_on);
`);

const ROLES = { tech: 'On call', backup: 'Backup' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (text) => { const k = String(text || '').trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 3); return k.length < 3 ? -1 : MONTHS.findIndex((m) => m.startsWith(k)); };
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const valid = (y, m, d) => { const t = new Date(Date.UTC(y, m, d)); return t.getUTCMonth() === m && t.getUTCDate() === d; };

/** "D. Marlow 717-555-0121" -> { name, phone }. A cell with no number is just a name. */
function person(cell) {
  const text = String(cell || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const m = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(text);
  const name = (m ? text.replace(m[0], '') : text).replace(/[\s,;:-]+$/, '').trim();
  return name ? { name: name.slice(0, 80), phone: m ? m[0].trim() : null } : null;
}

/**
 * Reads the on-call spreadsheet as it is kept today: a year at the top, then one line per stretch with the month,
 * the days ("04-11", "25-Feb 01", "28- July 06"), the technician, the manager, and a holiday if there is one.
 * More columns of people are read too: a heading containing "back" or "manager" makes them backups, anything else on call.
 * Returns { shifts, problems }.
 */
function parseSheet(rows) {
  const problems = [];
  let year = null;
  for (const r of rows.slice(0, 6)) { const y = /^(20\d\d)$/.exec(String(r[0] || '').trim()); if (y) { year = Number(y[1]); break; } }
  if (!year) return { shifts: [], problems: ['The first line of the sheet needs the year, such as 2027.'] };
  // The heading line names the columns of people.
  const headAt = rows.findIndex((r) => r.slice(2).some((c) => /technician|tech|manager|back|on.?call/i.test(String(c || ''))));
  const head = headAt >= 0 ? rows[headAt].map((c) => String(c || '').trim()) : ['', '', 'Technician', 'Manager', 'Holiday'];
  const cols = head.map((h, i) => (i < 2 || !h ? null : /holiday|note/i.test(h) ? 'note' : /manager|back/i.test(h) ? 'backup' : 'tech'));
  const shifts = [];
  let lastStart = null; let first = true;
  rows.forEach((r, at) => {
    if (at <= headAt) return;
    const m = monthIndex(r[0]);
    const range = String(r[1] || '').trim();
    if (m < 0 || !range) return;
    const parts = /^(\d{1,2})\s*-\s*([A-Za-z.]*)\s*(\d{1,2})$/.exec(range);
    if (!parts) { problems.push(`Line ${at + 1}: could not read the days "${range}".`); return; }
    const d1 = Number(parts[1]); const d2 = Number(parts[3]);
    // Which year the stretch starts in: the sheet's year, except a December line at the very top, which is the year before.
    let y = first && m === 11 ? year - 1 : lastStart ? Number(lastStart.slice(0, 4)) : year;
    if (lastStart && ymd(y, m, d1) < lastStart) y += 1;
    first = false;
    let m2 = parts[2] ? monthIndex(parts[2]) : m;
    if (m2 < 0) m2 = m;
    let y2 = y;
    if (m2 < m) y2 += 1;                                           // December into January
    else if (m2 === m && d2 <= d1) { m2 = (m + 1) % 12; if (m2 === 0) y2 += 1; }    // "28-04" with no month named: it runs into the next one
    if (!valid(y, m, d1) || !valid(y2, m2, d2)) { problems.push(`Line ${at + 1}: "${r[0]} ${range}" is not a real date.`); return; }
    const start = ymd(y, m, d1); const end = ymd(y2, m2, d2);
    lastStart = start;
    const note = cols.map((c, i) => (c === 'note' ? String(r[i] || '').trim() : '')).filter(Boolean).join(', ').slice(0, 120) || null;
    let any = false;
    cols.forEach((c, i) => {
      if (c !== 'tech' && c !== 'backup') return;
      const p = person(r[i]);
      if (p) { shifts.push({ start_on: start, end_on: end, role: c, name: p.name, phone: p.phone, note }); any = true; }
    });
    if (!any) problems.push(`Line ${at + 1}: nobody is named for ${r[0]} ${range}.`);
  });
  return { shifts, problems };
}

/** A shift covers its first day up to, but not including, the day it is handed on. */
const covering = (branchIds, day) => (branchIds.length ? db.prepare(
  `SELECT s.*, b.name AS office FROM oncall_shifts s JOIN branches b ON b.id = s.branch_id
   WHERE s.branch_id IN (${branchIds.map(Number).join(',')}) AND s.start_on <= ? AND s.end_on > ? ORDER BY s.role = 'backup', s.id`).all(day, day) : []);

/** The offices whose schedule this person sees: their own, and any other office in the same market. */
function officesFor(user) {
  const mine = db.prepare('SELECT b.id, b.name, b.market, b.market_id, m.name AS market_name FROM branches b LEFT JOIN markets m ON m.id = b.market_id WHERE b.id = ?').get(user.workBranch || user.branch_id);
  if (!mine) return [];
  // A market made on the Markets page decides it; an office not yet in one falls back to the company list's market.
  if (mine.market_id) {
    const others = db.prepare('SELECT id, name FROM branches WHERE market_id = ? AND id <> ? ORDER BY name COLLATE NOCASE').all(mine.market_id, mine.id);
    return [{ ...mine, market: mine.market_name }, ...others.map((o) => ({ ...o, market: mine.market_name }))];
  }
  const market = String(mine.market || '').trim();
  const others = market ? db.prepare('SELECT id, name, market FROM branches WHERE market = ? AND market_id IS NULL AND id <> ? ORDER BY name COLLATE NOCASE').all(market, mine.id) : [];
  return [mine, ...others];
}

/** Who is on call today for this person's office and market: [{ role, name, phone, office, ... }]. */
function now(user, today = localDate()) {
  return covering(officesFor(user).map((o) => o.id), today);
}

module.exports = { ROLES, parseSheet, person, covering, officesFor, now };
