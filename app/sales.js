'use strict';
// Sales leads: who is working which customer, where each one stands, and when to follow up.
// Only people whose profile has the sales permission ever see any of it.
const db = require('./db');
const { localDate } = require('./util');

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  company TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  interest TEXT,
  source TEXT,
  value INTEGER,
  stage TEXT NOT NULL DEFAULT 'new',
  owner_id INTEGER REFERENCES users(id),
  next_on TEXT,
  lost_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  quote_amount INTEGER,           -- what was quoted, in whole dollars
  quoted_on TEXT,                 -- when the quote went out
  renew_on TEXT,                  -- for won work that comes round again: when to pick it back up
  renewed_as INTEGER,             -- the lead that renewal became
  referred_by INTEGER REFERENCES users(id),      -- who passed it from another office
  referred_from INTEGER REFERENCES branches(id)
);
-- Who covers what: a town, a zip code or a named account belongs to one salesperson in an office.
CREATE TABLE IF NOT EXISTS sales_territories (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('town','zip','account')),
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sales_territories_branch ON sales_territories(branch_id);
-- Brochures, service sheets and standard answers the whole sales team shares.
CREATE TABLE IF NOT EXISTS sales_files (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT,
  path TEXT,
  original_name TEXT,
  mime TEXT,
  link TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_branch ON leads(branch_id, stage);
CREATE INDEX IF NOT EXISTS leads_owner ON leads(owner_id, stage);
CREATE TABLE IF NOT EXISTS lead_notes (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_notes_lead ON lead_notes(lead_id, id);
`);

const STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['quoted', 'Quote sent'], ['won', 'Won'], ['lost', 'Lost']];
const OPEN = ['new', 'contacted', 'quoted'];
const SOURCES = ['Referral', 'Existing customer', 'Cold call', 'Walk-in or phone-in', 'Website', 'Another office', 'Other'];
const stageName = (key) => (STAGES.find((s) => s[0] === key) || STAGES[0])[1];

const STALE_DAYS = 14;        // an open lead nobody has touched for this long is flagged to its owner
const RELEASE_DAYS = 30;      // ...and after this long a colleague may take it
const QUOTE_WAIT_DAYS = 7;    // a quote with no answer for this long is worth a call
const RENEW_AHEAD_DAYS = 45;  // repeat work shows up this far ahead of its date
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysSince = (iso, today = localDate()) => Math.max(0, Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)) / 86400000));

/** What the bell counts for a salesperson: follow-ups that have arrived, and repeat work coming round. */
function dueCount(userId, today = localDate()) {
  const follow = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE owner_id = ? AND stage IN ('new','contacted','quoted') AND next_on IS NOT NULL AND next_on <= ?`).get(userId, today).n;
  const renew = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE owner_id = ? AND stage = 'won' AND renew_on IS NOT NULL AND renewed_as IS NULL AND renew_on <= ?`).get(userId, addDays(today, RENEW_AHEAD_DAYS)).n;
  return follow + renew;
}

// ---- Territories ----------------------------------------------------------------
const words = (text) => ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
/** Whose patch a customer falls in, by named account first, then zip code, then town. Null when nobody's. */
function territoryFor(branchId, { company, address }) {
  const rows = db.prepare(`SELECT t.*, u.display_name AS owner FROM sales_territories t JOIN users u ON u.id = t.user_id WHERE t.branch_id = ? AND u.active = 1`).all(branchId);
  const n = nameKey(company); const zips = String(address || '').match(/\b\d{5}\b/g) || []; const w = words(address);
  const hit = rows.find((r) => r.kind === 'account' && n && (nameKey(r.value) === n || (nameKey(r.value).length >= 5 && n.includes(nameKey(r.value)))))
    || rows.find((r) => r.kind === 'zip' && zips.includes(r.value))
    || rows.find((r) => r.kind === 'town' && w.includes(words(r.value)) && words(r.value).trim());
  return hit ? { user_id: hit.user_id, owner: hit.owner, kind: hit.kind, value: hit.value, what: hit.kind === 'account' ? `${hit.value} is their account` : hit.kind === 'zip' ? `zip code ${hit.value}` : hit.value } : null;
}

// ---- "Is someone already on this?" ----------------------------------------------
// Names are compared loosely: case, punctuation and words like Inc or LLC are ignored.
const DROP = new Set(['inc', 'incorporated', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of']);
const nameKey = (text) => String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !DROP.has(w)).join(' ');
const phoneKey = (text) => { const d = String(text || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : ''; };
const emailKey = (text) => String(text || '').trim().toLowerCase();

/**
 * Leads anywhere in the company that look like the same customer. Each match says who has it and why
 * it matched; the caller decides how much of it to show.
 */
function similar({ company, phone, email, address }, exceptId) {
  const n = nameKey(company); const p = phoneKey(phone); const e = emailKey(email); const a = nameKey(address);
  if (!n && !p && !e) return [];
  const rows = db.prepare(
    `SELECT l.id, l.company, l.phone, l.email, l.address, l.stage, l.branch_id, l.owner_id, l.updated_at, u.display_name AS owner, b.name AS office
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN branches b ON b.id = l.branch_id
     WHERE l.id <> ? AND (l.stage IN ('new','contacted','quoted') OR l.updated_at >= ?) ORDER BY l.updated_at DESC LIMIT 5000`)
    .all(exceptId || 0, new Date(Date.now() - 365 * 86400000).toISOString());
  const out = [];
  for (const r of rows) {
    const rn = nameKey(r.company);
    const why = [];
    if (n && rn && (rn === n || (n.length >= 5 && rn.includes(n)) || (rn.length >= 5 && n.includes(rn)))) why.push('same name');
    if (p && phoneKey(r.phone) === p) why.push('same phone number');
    if (e && emailKey(r.email) === e) why.push('same email');
    if (a && a.length >= 8 && nameKey(r.address) === a) why.push('same address');
    if (why.length) out.push({ ...r, why: why.join(', '), stageName: stageName(r.stage) });
    if (out.length >= 8) break;
  }
  return out;
}

module.exports = { STAGES, OPEN, SOURCES, STALE_DAYS, RELEASE_DAYS, QUOTE_WAIT_DAYS, RENEW_AHEAD_DAYS, addDays, daysSince, stageName, dueCount, similar, territoryFor };
