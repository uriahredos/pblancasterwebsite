'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const sales = require('../sales');
const push = require('../push');
const { sendCsv } = require('../csv');
const { requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate, fmtDate } = require('../util');

const router = express.Router();
const use = requirePerm('sales.use');
const notFound = (res) => res.status(404).render('error', { title: 'Page not found', message: 'That lead does not exist.' });
const isId = (v) => /^\d+$/.test(String(v || ''));

/** The office whose leads this person is looking at; null = every office (someone who can see them all). */
const officeOf = (user) => (user.allBranches && user.viewBranch === null ? null : user.workBranch);
const inOffice = (user, lead) => { const o = officeOf(user); return o === null || lead.branch_id === o; };
/** The owner works their own lead; a sales manager works any; a lead nobody owns is open to all of sales. */
const mayEdit = (user, lead) => access.can(user, 'sales.manage') || lead.owner_id === user.id || lead.owner_id === null;

/** People in an office whose profile puts them on the sales side. */
function salesPeople(branchId) {
  return db.prepare('SELECT * FROM users WHERE active = 1 AND branch_id = ? ORDER BY display_name COLLATE NOCASE').all(branchId)
    .filter((u) => access.can(access.loadAccess(u), 'sales.use')).map((u) => ({ id: u.id, display_name: u.display_name }));
}

function decorate(l, today = localDate()) {
  l.stageName = sales.stageName(l.stage);
  l.open = sales.OPEN.includes(l.stage);
  l.due = l.open && l.next_on && l.next_on <= today;
  l.overdue = l.open && l.next_on && l.next_on < today;
  return l;
}
const LEAD = `SELECT l.*, u.display_name AS owner, b.name AS office FROM leads l
  LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN branches b ON b.id = l.branch_id`;

function readLead(body) {
  const v = {
    company: clean(body.company, 120), contact_name: clean(body.contact_name, 80), phone: clean(body.phone, 30), email: clean(body.email, 120),
    address: clean(body.address, 200), interest: clean(body.interest, 120), source: sales.SOURCES.includes(body.source) ? body.source : '',
    value: clean(body.value, 12).replace(/[$,\s]/g, ''), next_on: clean(body.next_on, 10), note: clean(body.note, 1000),
  };
  const errors = [];
  if (!v.company) errors.push('Enter the customer or company name.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.push('That email address does not look right.');
  if (v.value && !/^\d{1,9}$/.test(v.value)) errors.push('Enter the estimated value as a whole number of dollars.');
  if (v.next_on && !isYmd(v.next_on)) errors.push('The follow-up date does not look right.');
  return { v, errors };
}

// ---- The board ------------------------------------------------------------------

function board(req, res, extra = {}) {
  const today = localDate();
  const office = officeOf(req.user);
  const show = ['mine', 'due', 'all', 'closed'].includes(req.query.show) ? req.query.show : 'mine';
  const q = clean(req.query.q, 60);
  const all = db.prepare(`${LEAD} ${office === null ? '' : 'WHERE l.branch_id = ?'} ORDER BY l.next_on IS NULL, l.next_on, l.updated_at DESC LIMIT 3000`)
    .all(...(office === null ? [] : [office])).map((l) => decorate(l, today));
  const mineOpen = all.filter((l) => l.open && l.owner_id === req.user.id);
  const month = today.slice(0, 7);
  const wonThisMonth = all.filter((l) => l.stage === 'won' && (l.closed_at || '').slice(0, 7) === month);
  const summary = [
    { label: 'My open leads', value: mineOpen.length, sub: 'being worked by you', url: '/sales' },
    { label: 'Follow-ups due', value: mineOpen.filter((l) => l.due).length, sub: 'today or overdue', url: '/sales?show=due', warn: mineOpen.some((l) => l.due) },
    { label: 'Open in the office', value: all.filter((l) => l.open).length, sub: `$${all.filter((l) => l.open).reduce((n, l) => n + (l.value || 0), 0).toLocaleString('en-US')} estimated`, url: '/sales?show=all' },
    { label: 'Won this month', value: wonThisMonth.length, sub: `$${wonThisMonth.reduce((n, l) => n + (l.value || 0), 0).toLocaleString('en-US')} estimated`, url: '/sales?show=closed' },
  ];
  let rows = all.filter((l) => (show === 'closed' ? !l.open : show === 'all' ? l.open : show === 'due' ? l.open && l.owner_id === req.user.id && l.due : l.open && l.owner_id === req.user.id));
  if (q) { const k = q.toLowerCase(); rows = all.filter((l) => [l.company, l.contact_name, l.phone, l.email, l.address, l.owner].some((x) => String(x || '').toLowerCase().includes(k))); }
  const groups = (show === 'closed' && !q ? [['won', 'Won'], ['lost', 'Lost']] : sales.STAGES).map(([key, name]) => ({ key, name, leads: rows.filter((l) => l.stage === key) })).filter((g) => g.leads.length);
  const unowned = all.filter((l) => l.open && l.owner_id === null).length;
  // Who has what: a line per salesperson, so the team can see the spread at a glance.
  const byPerson = [...all.filter((l) => l.open && l.owner).reduce((m, l) => m.set(l.owner, (m.get(l.owner) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
  res.status(extra.errors ? 400 : 200).render('sales', {
    title: 'Sales', wide: true, summary, groups, show, q, count: rows.length, unowned, byPerson, sources: sales.SOURCES,
    canExport: access.can(req.user, 'sales.manage'), allOffices: office === null, errors: [], values: {}, matches: [], ...extra,
  });
}
router.get('/sales', use, (req, res) => board(req, res));

// Asked by the "new lead" form while someone types: is anyone already on this customer?
router.get('/sales/check', use, (req, res) => {
  const office = officeOf(req.user);
  const matches = sales.similar({ company: clean(req.query.company, 120), phone: clean(req.query.phone, 30), email: clean(req.query.email, 120), address: clean(req.query.address, 200) });
  res.json(matches.map((m) => ({
    company: m.company, owner: m.owner || 'nobody yet', office: m.office, stage: m.stageName, why: m.why,
    url: office === null || m.branch_id === office ? `/sales/${m.id}` : null,      // another office's lead is named, not opened
  })));
});

router.post('/sales', use, (req, res) => {
  const { v, errors } = readLead(req.body);
  const matches = errors.length ? [] : sales.similar(v);
  // Someone may already be on this customer: say so once, and let the person decide.
  if (!errors.length && matches.length && req.body.anyway !== '1') {
    return board(req, res, { errors: ['This looks like a customer someone is already working. Check the list below, then tick the box to add it anyway.'], values: v, matches, addOpen: true });
  }
  if (errors.length) return board(req, res, { errors, values: v, addOpen: true });
  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO leads (branch_id, company, contact_name, phone, email, address, interest, source, value, stage, owner_id, next_on, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`)
      .run(req.user.workBranch, v.company, v.contact_name || null, v.phone || null, v.email || null, v.address || null, v.interest || null, v.source || null,
        v.value ? Number(v.value) : null, req.user.id, v.next_on || null, req.user.id, now, now);
    if (v.note) db.prepare("INSERT INTO lead_notes (lead_id, user_id, kind, body, created_at) VALUES (?, ?, 'note', ?, ?)").run(info.lastInsertRowid, req.user.id, v.note, now);
    return info.lastInsertRowid;
  })();
  flash(req, 'ok', 'Lead added. It is yours.');
  res.redirect(`/sales/${id}`);
});

router.get('/sales.csv', requirePerm('sales.manage'), (req, res) => {
  const office = officeOf(req.user);
  const rows = db.prepare(`${LEAD} ${office === null ? '' : 'WHERE l.branch_id = ?'} ORDER BY l.id`).all(...(office === null ? [] : [office]));
  activity.log(req.user, 'Sales leads exported', `${rows.length} leads`);
  sendCsv(res, `sales-leads-${localDate()}.csv`, ['Lead', 'Office', 'Customer', 'Contact', 'Phone', 'Email', 'Address', 'Interested in', 'Source', 'Estimated value', 'Stage', 'Owner', 'Follow up on', 'Added', 'Closed', 'Why lost'],
    rows.map((l) => [l.id, l.office, l.company, l.contact_name, l.phone, l.email, l.address, l.interest, l.source, l.value, sales.stageName(l.stage), l.owner, l.next_on, (l.created_at || '').slice(0, 10), (l.closed_at || '').slice(0, 10), l.lost_reason]));
});

// ---- One lead ---------------------------------------------------------------------

function load(req, res) {
  const lead = isId(req.params.id) ? db.prepare(`${LEAD} WHERE l.id = ?`).get(req.params.id) : null;
  if (!lead) { notFound(res); return null; }
  if (!inOffice(req.user, lead)) { forbidden(res); return null; }
  return decorate(lead);
}
function page(req, res, lead, extra = {}) {
  const notes = db.prepare('SELECT n.*, u.display_name AS author FROM lead_notes n JOIN users u ON u.id = n.user_id WHERE n.lead_id = ? ORDER BY n.id').all(lead.id);
  const offices = db.prepare('SELECT id, name, number FROM branches WHERE id <> ? ORDER BY name COLLATE NOCASE').all(lead.branch_id);
  res.status(extra.errors ? 400 : 200).render('sales_lead', {
    title: lead.company, lead, notes, stages: sales.STAGES, sources: sales.SOURCES, people: salesPeople(lead.branch_id), offices,
    canEdit: mayEdit(req.user, lead), isManager: access.can(req.user, 'sales.manage'), errors: [], values: lead, ...extra,
  });
}
const log = (lead, user, kind, body) => db.prepare('INSERT INTO lead_notes (lead_id, user_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)').run(lead.id, user.id, kind, body, new Date().toISOString());
const touch = (lead) => db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), lead.id);
/** Loads the lead and checks this person may change it. */
function editable(req, res) {
  const lead = load(req, res);
  if (!lead) return null;
  if (!mayEdit(req.user, lead)) { forbidden(res); return null; }
  return lead;
}

router.get('/sales/:id', use, (req, res) => { const lead = load(req, res); if (lead) page(req, res, lead); });

// Anyone on sales can leave a note on any lead in the office ("I know the owner there").
router.post('/sales/:id/note', use, (req, res) => {
  const lead = load(req, res);
  if (!lead) return;
  const note = clean(req.body.note, 1000);
  if (note) {
    log(lead, req.user, 'note', note); touch(lead);
    if (lead.owner_id && lead.owner_id !== req.user.id) push.notify([lead.owner_id], 'task_assigned', { title: `Note on your lead: ${lead.company}`, body: `${req.user.display_name}: "${note}"`, url: `/sales/${lead.id}` });
    flash(req, 'ok', 'Note added.');
  }
  res.redirect(`/sales/${lead.id}#notes`);
});

router.post('/sales/:id/stage', use, (req, res) => {
  const lead = editable(req, res);
  if (!lead) return;
  const stage = sales.STAGES.some((s) => s[0] === req.body.stage) ? req.body.stage : lead.stage;
  const next = clean(req.body.next_on, 10); const reason = clean(req.body.lost_reason, 200);
  if (next && !isYmd(next)) return page(req, res, lead, { errors: ['The follow-up date does not look right.'] });
  const closing = !sales.OPEN.includes(stage);
  db.prepare('UPDATE leads SET stage = ?, next_on = ?, lost_reason = ?, closed_at = ?, owner_id = COALESCE(owner_id, ?), updated_at = ? WHERE id = ?')
    .run(stage, closing ? null : next || null, stage === 'lost' ? reason || null : null, closing ? lead.closed_at || new Date().toISOString() : null, req.user.id, new Date().toISOString(), lead.id);
  if (stage !== lead.stage) log(lead, req.user, 'stage', `Moved to ${sales.stageName(stage)}${stage === 'lost' && reason ? ': ' + reason : ''}`);
  else if ((next || '') !== (lead.next_on || '')) log(lead, req.user, 'stage', next ? `Follow up on ${fmtDate(next)}` : 'Follow-up date cleared');
  flash(req, 'ok', stage === 'won' ? 'Marked as won. Well done.' : 'Saved.');
  res.redirect(`/sales/${lead.id}`);
});

router.post('/sales/:id', use, (req, res) => {
  const lead = editable(req, res);
  if (!lead) return;
  const { v, errors } = readLead(req.body);
  if (errors.length) return page(req, res, lead, { errors, values: { ...lead, ...v }, editOpen: true });
  db.prepare('UPDATE leads SET company = ?, contact_name = ?, phone = ?, email = ?, address = ?, interest = ?, source = ?, value = ?, updated_at = ? WHERE id = ?')
    .run(v.company, v.contact_name || null, v.phone || null, v.email || null, v.address || null, v.interest || null, v.source || null, v.value ? Number(v.value) : null, new Date().toISOString(), lead.id);
  flash(req, 'ok', 'Lead saved.');
  res.redirect(`/sales/${lead.id}`);
});

// Take a lead nobody owns, or hand yours to a colleague. A manager can move anyone's.
router.post('/sales/:id/owner', use, (req, res) => {
  const lead = editable(req, res);
  if (!lead) return;
  const to = req.body.owner === 'me' ? { id: req.user.id, display_name: req.user.display_name } : salesPeople(lead.branch_id).find((u) => String(u.id) === String(req.body.owner));
  if (!to) return page(req, res, lead, { errors: ['Choose who the lead is for.'] });
  if (to.id !== lead.owner_id) {
    db.prepare('UPDATE leads SET owner_id = ?, updated_at = ? WHERE id = ?').run(to.id, new Date().toISOString(), lead.id);
    log(lead, req.user, 'owner', to.id === req.user.id ? 'Took this lead' : `Handed to ${to.display_name}`);
    if (to.id !== req.user.id) push.notify([to.id], 'task_assigned', { title: `Lead handed to you: ${lead.company}`, body: `From ${req.user.display_name}.`, url: `/sales/${lead.id}` });
  }
  flash(req, 'ok', to.id === req.user.id ? 'The lead is yours.' : `Handed to ${to.display_name}.`);
  res.redirect(`/sales/${lead.id}`);
});

// Pass a lead to another office (they do the work we do not). It arrives there with nobody on it yet.
router.post('/sales/:id/refer', use, (req, res) => {
  const lead = editable(req, res);
  if (!lead) return;
  const office = isId(req.body.office) ? db.prepare('SELECT id, name FROM branches WHERE id = ? AND id <> ?').get(req.body.office, lead.branch_id) : null;
  if (!office) return page(req, res, lead, { errors: ['Choose the office to pass it to.'] });
  const why = clean(req.body.why, 300);
  db.prepare("UPDATE leads SET branch_id = ?, owner_id = NULL, source = COALESCE(source, 'Another office'), updated_at = ? WHERE id = ?").run(office.id, new Date().toISOString(), lead.id);
  log(lead, req.user, 'refer', `Passed from the ${lead.office} office to the ${office.name} office${why ? ': ' + why : ''}`);
  activity.log(req.user, 'Lead passed to another office', `${lead.company} to ${office.name}`);
  push.notify(salesPeople(office.id).map((u) => u.id), 'task_assigned', { title: `New lead from the ${lead.office} office`, body: `${lead.company}${why ? ': ' + why : ''}`, url: `/sales/${lead.id}` });
  flash(req, 'ok', `Passed to the ${office.name} office.`);
  res.redirect('/sales');
});

router.post('/sales/:id/delete', requirePerm('sales.manage'), (req, res) => {
  const lead = load(req, res);
  if (!lead) return;
  db.prepare('DELETE FROM lead_notes WHERE lead_id = ?').run(lead.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
  activity.log(req.user, 'Lead removed', lead.company);
  flash(req, 'ok', 'Lead removed.');
  res.redirect('/sales');
});

module.exports = router;
