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
  closed_at TEXT
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

/** This person's open leads whose follow-up date is today or has passed. */
function dueCount(userId, today = localDate()) {
  return db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE owner_id = ? AND stage IN ('new','contacted','quoted') AND next_on IS NOT NULL AND next_on <= ?`).get(userId, today).n;
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

module.exports = { STAGES, OPEN, SOURCES, stageName, dueCount, similar };
