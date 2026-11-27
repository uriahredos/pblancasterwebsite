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

// What the person covers (Sprinkler, Security, Supervisor...), and whether the shift is for the whole market
// rather than one office. A market-wide shift still belongs to the office that entered it, which keeps it editable.
for (const [col, type] of [['covers', 'TEXT'], ['market_id', 'INTEGER']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('oncall_shifts') WHERE name = ?").get(col)) db.exec(`ALTER TABLE oncall_shifts ADD COLUMN ${col} ${type}`);
}

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
// The schedule holds names as typed. Where a name is exactly one active person's, the row carries who that is, so the name can open their card.
const SCOPED = `SELECT s.*, (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(u.id) END FROM users u WHERE u.active = 1 AND u.display_name = s.name COLLATE NOCASE) AS user_id, CASE WHEN s.market_id IS NULL THEN b.name ELSE m.name || ' market' END AS office FROM oncall_shifts s
   JOIN branches b ON b.id = s.branch_id LEFT JOIN markets m ON m.id = s.market_id`;
/** WHERE that picks out the shifts these offices see: their own, and their market's market-wide ones. */
const seenBy = (branchIds, marketId) => `((s.market_id IS NULL AND s.branch_id IN (${branchIds.map(Number).join(',') || 0}))${marketId ? ` OR s.market_id = ${Number(marketId)}` : ''})`;
const marketOf = (offices) => (offices[0] && offices[0].market_id) || null;
const covering = (branchIds, day, marketId = null) => (branchIds.length ? db.prepare(
  `${SCOPED} WHERE ${seenBy(branchIds, marketId)} AND s.start_on <= ? AND s.end_on > ?
   ORDER BY s.market_id IS NOT NULL, s.role = 'backup', s.id`).all(day, day) : []);

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
  const offices = officesFor(user);
  return covering(offices.map((o) => o.id), today, marketOf(offices));
}

const iso = (text) => {
  const t = String(text || '').trim().replace(/\*+$/, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t); if (m) return valid(+m[1], +m[2] - 1, +m[3]) ? ymd(+m[1], +m[2] - 1, +m[3]) : null;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); if (m) return valid(+m[3], +m[1] - 1, +m[2]) ? ymd(+m[3], +m[1] - 1, +m[2]) : null;
  return null;
};
/** Is this the one-line-per-person layout (it has Start, End and Name columns)? */
const isLong = (rows) => rows.slice(0, 5).some((r) => { const h = r.map((c) => String(c || '').trim().toLowerCase()); return h.includes('start') && h.includes('end') && h.includes('name'); });
/**
 * Reads a schedule with one line per person: Start, End, Office, Covers, Role, Name, Phone, Holiday.
 * Office is an office's name, empty for the office being looked at, or "Market" for the whole market.
 * Returns { shifts: [{ start_on, end_on, office, covers, role, name, phone, note }], problems }.
 */
function parseLong(rows) {
  const at = rows.findIndex((r) => { const h = r.map((c) => String(c || '').trim().toLowerCase()); return h.includes('start') && h.includes('name'); });
  const head = rows[at].map((c) => String(c || '').trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const c = { start: col('start'), end: col('end'), office: col('branch', 'office'), covers: col('covers', 'cover', 'trade', 'type'), role: col('role'), name: col('name'), phone: col('phone'), note: col('holiday', 'note') };
  const shifts = []; const problems = [];
  rows.forEach((r, i) => {
    if (i <= at || !r.some((x) => String(x || '').trim())) return;
    const get = (k) => (c[k] >= 0 ? String(r[c[k]] || '').replace(/\s+/g, ' ').trim() : '');
    const start = iso(get('start')); const end = iso(get('end')); const who = person(`${get('name')} ${get('phone')}`);
    if (!start || !end || end <= start) { problems.push(`Line ${i + 1}: the dates "${get('start')}" to "${get('end')}" could not be read.`); return; }
    // A line whose role is "Clear" names nobody: it empties that office (or the market) for those days, and nothing more.
    if (/^clear$/i.test(get('role'))) { shifts.push({ start_on: start, end_on: end, office: get('office'), clear: true }); return; }
    if (!who) { problems.push(`Line ${i + 1}: nobody is named.`); return; }
    shifts.push({ start_on: start, end_on: end, office: get('office'), covers: get('covers').slice(0, 60) || null, role: /back|second/i.test(get('role')) ? 'backup' : 'tech',
      name: who.name, phone: who.phone, note: get('note').slice(0, 120) || null });
  });
  return { shifts, problems };
}

module.exports = { ROLES, parseSheet, parseLong, isLong, person, covering, seenBy, marketOf, SCOPED, officesFor, now };
