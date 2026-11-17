'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const sales = require('../sales');
const push = require('../push');
const { sendCsv } = require('../csv');
const { requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate, fmtDate, money: fmtMoney } = require('../util');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const uploads = require('../uploads');
const config = require('../config');
const { verifyCsrf } = require('../auth');

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
  l.idleDays = sales.daysSince(l.updated_at, today);
  l.stale = l.open && l.idleDays >= sales.STALE_DAYS;                 // flagged to its owner
  l.released = l.open && l.idleDays >= sales.RELEASE_DAYS;            // a colleague may take it
  l.quoteWaiting = l.stage === 'quoted' && l.quoted_on && sales.daysSince(l.quoted_on, today) >= sales.QUOTE_WAIT_DAYS;
  l.renewDue = l.stage === 'won' && l.renew_on && !l.renewed_as && l.renew_on <= sales.addDays(today, sales.RENEW_AHEAD_DAYS);
  return l;
}
const LEAD = `SELECT l.*, u.display_name AS owner, b.name AS office, r.display_name AS referrer, rb.name AS referrer_office FROM leads l
  LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN branches b ON b.id = l.branch_id
  LEFT JOIN users r ON r.id = l.referred_by LEFT JOIN branches rb ON rb.id = l.referred_from`;

function readLead(body) {
  const v = {
    company: clean(body.company, 120), contact_name: clean(body.contact_name, 80), phone: clean(body.phone, 30), email: clean(body.email, 120),
    address: clean(body.address, 200), interest: clean(body.interest, 120), source: sales.SOURCES.includes(body.source) ? body.source : '',
    value: clean(body.value, 12).replace(/[$,\s]/g, ''), next_on: clean(body.next_on, 10), note: clean(body.note, 1000),
  };
  const errors = [];
  if (!v.company) errors.push('Enter the customer or company name.');
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.push('That email address does not look right.');
  if (v.value && !/^\d{1,9}(\.\d{1,2})?$/.test(v.value)) errors.push('Enter the estimated value as an amount in dollars, such as 4500 or 4500.50.');
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
    { label: 'Open in the office', value: all.filter((l) => l.open).length, sub: `$${fmtMoney(all.filter((l) => l.open).reduce((n, l) => n + (l.value || 0), 0))} estimated`, url: '/sales?show=all' },
    { label: 'Won this month', value: wonThisMonth.length, sub: `$${fmtMoney(wonThisMonth.reduce((n, l) => n + (l.value || 0), 0))} estimated`, url: '/sales?show=closed' },
  ];
  let rows = all.filter((l) => (show === 'closed' ? !l.open : show === 'all' ? l.open : show === 'due' ? l.open && l.owner_id === req.user.id && l.due : l.open && l.owner_id === req.user.id));
  if (q) { const k = q.toLowerCase(); rows = all.filter((l) => [l.company, l.contact_name, l.phone, l.email, l.address, l.owner].some((x) => String(x || '').toLowerCase().includes(k))); }
  const groups = (show === 'closed' && !q ? [['won', 'Won'], ['lost', 'Lost']] : sales.STAGES).map(([key, name]) => ({ key, name, leads: rows.filter((l) => l.stage === key) })).filter((g) => g.leads.length);
  const unowned = all.filter((l) => l.open && l.owner_id === null).length;
  // My day: what to pick up first, in the order a salesperson would work it.
  const mine = all.filter((l) => l.owner_id === req.user.id);
  const myDay = show === 'mine' && !q ? [
    { title: 'Follow up today', hint: 'The date you set has arrived.', leads: mine.filter((l) => l.due) },
    { title: 'Quotes waiting on an answer', hint: `Sent ${sales.QUOTE_WAIT_DAYS} or more days ago.`, leads: mine.filter((l) => l.quoteWaiting && !l.due) },
    { title: 'Repeat work coming round', hint: 'Won before, and due again soon.', leads: mine.filter((l) => l.renewDue) },
    { title: 'Gone quiet', hint: `No activity for ${sales.STALE_DAYS} days or more. After ${sales.RELEASE_DAYS} days a colleague may take it.`, leads: mine.filter((l) => l.stale && !l.due && !l.quoteWaiting) },
    { title: 'Nobody on these yet', hint: 'Take one if it is yours to work.', leads: all.filter((l) => l.open && l.owner_id === null) },
  ].filter((g) => g.leads.length) : [];
  // Who has what: a line per salesperson, so the team can see the spread at a glance.
  const byPerson = [...all.filter((l) => l.open && l.owner).reduce((m, l) => m.set(l.owner, (m.get(l.owner) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
  res.status(extra.errors ? 400 : 200).render('sales', {
    title: 'Sales', wide: true, summary, groups, show, q, count: rows.length, unowned, byPerson, sources: sales.SOURCES,
    canExport: access.can(req.user, 'sales.manage'), allOffices: office === null, errors: [], values: {}, matches: [], territory: null, myDay, ...extra,
  });
}
router.get('/sales', use, (req, res) => board(req, res));

// Asked by the "new lead" form while someone types: is anyone already on this customer?
router.get('/sales/check', use, (req, res) => {
  const office = officeOf(req.user);
  const matches = sales.similar({ company: clean(req.query.company, 120), phone: clean(req.query.phone, 30), email: clean(req.query.email, 120), address: clean(req.query.address, 200) });
  const t = sales.territoryFor(req.user.workBranch, { company: clean(req.query.company, 120), address: clean(req.query.address, 200) });
  res.json({ territory: t ? { owner: t.owner, what: t.what, mine: t.user_id === req.user.id } : null, matches: matches.map((m) => ({
    company: m.company, owner: m.owner || 'nobody yet', office: m.office, stage: m.stageName, why: m.why,
    url: office === null || m.branch_id === office ? `/sales/${m.id}` : null,      // another office's lead is named, not opened
  })) });
});

router.post('/sales', use, (req, res) => {
  const { v, errors } = readLead(req.body);
  const matches = errors.length ? [] : sales.similar(v);
  // Someone may already be on this customer: say so once, and let the person decide.
  const territory = errors.length ? null : sales.territoryFor(req.user.workBranch, v);
  const theirs = territory && territory.user_id !== req.user.id ? territory : null;
  if (!errors.length && (matches.length || theirs) && req.body.anyway !== '1') {
    const why = [matches.length ? 'This looks like a customer someone is already working.' : '', theirs ? `This is in ${theirs.owner}'s territory (${theirs.what}).` : ''].filter(Boolean).join(' ');
    return board(req, res, { errors: [`${why} Check below, then tick the box to add it anyway.`], values: v, matches, territory: theirs, addOpen: true });
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

// ---- Territories: who covers which towns, zip codes and named accounts ---------------

const manage = requirePerm('sales.manage');
const listOf = (text, max) => [...new Set(String(text || '').split(/[,\n]/).map((x) => x.trim().slice(0, max)).filter(Boolean))].slice(0, 200);
function territoryPage(req, res, extra = {}) {
  const people = salesPeople(req.user.workBranch);
  const rows = db.prepare('SELECT * FROM sales_territories WHERE branch_id = ? ORDER BY value COLLATE NOCASE').all(req.user.workBranch);
  for (const p of people) for (const kind of ['town', 'zip', 'account']) p[kind] = rows.filter((r) => r.user_id === p.id && r.kind === kind).map((r) => r.value).join(', ');
  res.status(extra.errors ? 400 : 200).render('sales_territories', { title: 'Territories', people, canManage: access.can(req.user, 'sales.manage'), errors: [], ...extra });
}
router.get('/sales/territories', use, (req, res) => territoryPage(req, res));
router.post('/sales/territories', manage, (req, res) => {
  const people = salesPeople(req.user.workBranch);
  const wanted = []; const seen = new Map(); const errors = [];
  for (const p of people) {
    for (const [kind, max] of [['town', 60], ['zip', 5], ['account', 120]]) {
      for (const value of listOf(req.body[`${kind}_${p.id}`], max)) {
        if (kind === 'zip' && !/^\d{5}$/.test(value)) { errors.push(`"${value}" is not a five-digit zip code.`); continue; }
        const key = `${kind}:${value.toLowerCase()}`;
        if (seen.has(key) && seen.get(key) !== p.display_name) errors.push(`${value} is listed for both ${seen.get(key)} and ${p.display_name}. Give it to one of them.`);
        seen.set(key, p.display_name);
        wanted.push([p.id, kind, value]);
      }
    }
  }
  if (errors.length) return territoryPage(req, res, { errors: [...new Set(errors)] });
  db.transaction(() => {
    db.prepare('DELETE FROM sales_territories WHERE branch_id = ?').run(req.user.workBranch);
    const add = db.prepare('INSERT INTO sales_territories (branch_id, user_id, kind, value) VALUES (?, ?, ?, ?)');
    for (const w of wanted) add.run(req.user.workBranch, ...w);
  })();
  activity.log(req.user, 'Sales territories changed', `${wanted.length} entries`);
  flash(req, 'ok', 'Territories saved.');
  res.redirect('/sales/territories');
});

// ---- The manager's view: how the team is doing ----------------------------------------

router.get('/sales/summary', manage, (req, res) => {
  const today = localDate(); const office = officeOf(req.user);
  const since = sales.addDays(today, -90);
  const all = db.prepare(`${LEAD} ${office === null ? '' : 'WHERE l.branch_id = ?'} LIMIT 5000`).all(...(office === null ? [] : [office])).map((l) => decorate(l, today));
  const recent = (l, field) => String(l[field] || '').slice(0, 10) >= since;
  const money = (list, f = 'value') => list.reduce((n, l) => n + (l[f] || 0), 0);
  const names = [...new Set(all.map((l) => l.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const people = names.map((name) => {
    const mine = all.filter((l) => l.owner === name);
    const won = mine.filter((l) => l.stage === 'won' && recent(l, 'closed_at')); const lost = mine.filter((l) => l.stage === 'lost' && recent(l, 'closed_at'));
    return { name, open: mine.filter((l) => l.open).length, openValue: money(mine.filter((l) => l.open)), added: mine.filter((l) => recent(l, 'created_at')).length,
      won: won.length, wonValue: money(won), lost: lost.length, rate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : null,
      stale: mine.filter((l) => l.stale).length };
  });
  const closed = all.filter((l) => !l.open && recent(l, 'closed_at'));
  const won = closed.filter((l) => l.stage === 'won'); const lost = closed.filter((l) => l.stage === 'lost');
  const quoted = closed.filter((l) => l.quoted_on && l.closed_at);
  const count = (list, f) => [...list.reduce((m, l) => m.set(l[f] || 'Not recorded', (m.get(l[f] || 'Not recorded') || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
  res.render('sales_summary', {
    title: 'Sales summary', wide: true, people,
    totals: [
      { label: 'Won, last 90 days', value: won.length, sub: `$${fmtMoney(money(won))} estimated` },
      { label: 'Win rate', value: closed.length ? `${Math.round((won.length / closed.length) * 100)}%` : 'n/a', sub: `${won.length} won, ${lost.length} lost` },
      { label: 'Quote to decision', value: quoted.length ? `${Math.round(quoted.reduce((n, l) => n + sales.daysSince(l.quoted_on, l.closed_at.slice(0, 10)), 0) / quoted.length)} days` : 'n/a', sub: `average over ${quoted.length} ${quoted.length === 1 ? 'quote' : 'quotes'}` },
      { label: 'Quoted and still open', value: all.filter((l) => l.stage === 'quoted').length, sub: `$${fmtMoney(money(all.filter((l) => l.stage === 'quoted'), 'quote_amount'))} quoted` },
    ],
    sources: count(all.filter((l) => recent(l, 'created_at')), 'source'), reasons: count(lost, 'lost_reason'),
    stale: all.filter((l) => l.stale).sort((a, b) => b.idleDays - a.idleDays).slice(0, 30),
    referrals: all.filter((l) => l.referred_by && recent(l, 'updated_at')),
  });
});

// ---- The shared library: brochures, service sheets, standard answers -----------------

const FILE_TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx' };
const takeFile = multer({
  storage: multer.diskStorage({ destination: uploads.uploadDir, filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + FILE_TYPES[file.mimetype]) }),
  limits: { fileSize: config.maxPhotoBytes, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => { if (FILE_TYPES[file.mimetype]) return cb(null, true); req.fileError = 'That kind of file cannot be added. Use a PDF, Word, Excel or PowerPoint file, or a picture.'; cb(null, false); },
}).single('file');
function libraryPage(req, res, extra = {}) {
  const files = db.prepare('SELECT f.*, u.display_name AS by_name FROM sales_files f JOIN users u ON u.id = f.uploaded_by ORDER BY f.title COLLATE NOCASE').all();
  res.status(extra.errors ? 400 : 200).render('sales_library', { title: 'Sales library', files, canManage: access.can(req.user, 'sales.manage'), errors: [], values: {}, ...extra });
}
router.get('/sales/library', use, (req, res) => libraryPage(req, res));
router.post('/sales/library', manage, (req, res, next) => takeFile(req, res, (err) => {
  if (err) req.fileError = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 10 MB.' : 'The file could not be uploaded.';
  req.body = req.body || {}; next();
}), verifyCsrf, (req, res) => {
  const v = { title: clean(req.body.title, 120), note: clean(req.body.note, 300), link: clean(req.body.link, 300) };
  const errors = [];
  if (req.fileError) errors.push(req.fileError);
  if (!v.title) errors.push('Give it a name.');
  if (v.link && !/^https:\/\/[^\s]+$/.test(v.link)) errors.push('The link must start with https://');
  if (!req.file && !v.link && !req.fileError) errors.push('Choose a file or paste a link.');
  if (errors.length) { if (req.file) uploads.remove(req.file.filename); return libraryPage(req, res, { errors, values: v }); }
  db.prepare('INSERT INTO sales_files (title, note, path, original_name, mime, link, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(v.title, v.note || null, req.file ? req.file.filename : null, req.file ? clean(req.file.originalname, 120) : null, req.file ? req.file.mimetype : null, req.file ? null : v.link, req.user.id, new Date().toISOString());
  activity.log(req.user, 'Sales library: added', v.title);
  flash(req, 'ok', 'Added to the library.');
  res.redirect('/sales/library');
});
router.get('/sales/library/:id', use, (req, res) => {
  const f = isId(req.params.id) ? db.prepare('SELECT * FROM sales_files WHERE id = ?').get(req.params.id) : null;
  if (!f || !f.path) return notFound(res);
  const name = `${f.title.replace(/[^\w .-]+/g, '').trim() || 'file'}${path.extname(f.path)}`;
  res.sendFile(path.basename(f.path), { root: uploads.uploadDir, headers: { 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } },
    (err) => { if (err && !res.headersSent) notFound(res); });
});
router.post('/sales/library/:id/delete', manage, (req, res) => {
  const f = isId(req.params.id) ? db.prepare('SELECT * FROM sales_files WHERE id = ?').get(req.params.id) : null;
  if (f) { db.prepare('DELETE FROM sales_files WHERE id = ?').run(f.id); if (f.path) uploads.remove(f.path); activity.log(req.user, 'Sales library: removed', f.title); flash(req, 'ok', 'Removed from the library.'); }
  res.redirect('/sales/library');
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
    territory: sales.territoryFor(lead.branch_id, lead), mayTake: lead.open && lead.owner_id !== req.user.id && (lead.owner_id === null || lead.released), releaseDays: sales.RELEASE_DAYS,
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
  const quote = clean(req.body.quote_amount, 12).replace(/[$,\s]/g, ''); const renew = clean(req.body.renew_on, 10);
  const errors = [];
  if (next && !isYmd(next)) errors.push('The follow-up date does not look right.');
  if (quote && !/^\d{1,9}(\.\d{1,2})?$/.test(quote)) errors.push('Enter the quote as an amount in dollars, such as 3200 or 3200.75.');
  if (renew && !isYmd(renew)) errors.push('The date it comes round again does not look right.');
  if (errors.length) return page(req, res, lead, { errors });
  const closing = !sales.OPEN.includes(stage);
  const today = localDate();
  // The day a quote first goes out is kept, so "how long has it been waiting" can be worked out.
  const quotedOn = stage === 'quoted' || quote ? lead.quoted_on || today : lead.quoted_on;
  db.prepare(`UPDATE leads SET stage = ?, next_on = ?, lost_reason = ?, closed_at = ?, owner_id = COALESCE(owner_id, ?), updated_at = ?,
              quote_amount = ?, quoted_on = ?, renew_on = ? WHERE id = ?`)
    .run(stage, closing ? null : next || null, stage === 'lost' ? reason || null : null, closing ? lead.closed_at || new Date().toISOString() : null, req.user.id, new Date().toISOString(),
      quote ? Number(quote) : lead.quote_amount, quotedOn || null, stage === 'won' ? renew || null : null, lead.id);
  if (quote && Number(quote) !== lead.quote_amount) log(lead, req.user, 'stage', `Quoted $${fmtMoney(Number(quote))}`);
  // Credit where it is due: the person in another office who passed this lead on hears that it was won.
  if (stage === 'won' && lead.stage !== 'won' && lead.referred_by) {
    log(lead, req.user, 'refer', `Won. Thank you to ${lead.referrer || 'the colleague'}${lead.referrer_office ? ' in the ' + lead.referrer_office + ' office' : ''} for passing it on.`);
    push.notify([lead.referred_by], 'task_assigned', { title: `Your referral was won: ${lead.company}`, body: `${req.user.display_name} in the ${lead.office} office closed it. Thank you for passing it on.`, url: '/sales' });
  }
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
  // A lead that has sat untouched long enough can be taken by a colleague, so a claim never blocks a customer for good.
  const first = load(req, res);
  if (!first) return;
  if (!(mayEdit(req.user, first) || (first.released && req.body.owner === 'me'))) return forbidden(res);
  const lead = first;
  const to = req.body.owner === 'me' ? { id: req.user.id, display_name: req.user.display_name } : salesPeople(lead.branch_id).find((u) => String(u.id) === String(req.body.owner));
  if (!to) return page(req, res, lead, { errors: ['Choose who the lead is for.'] });
  if (to.id !== lead.owner_id) {
    db.prepare('UPDATE leads SET owner_id = ?, updated_at = ? WHERE id = ?').run(to.id, new Date().toISOString(), lead.id);
    log(lead, req.user, 'owner', to.id === req.user.id ? `Took this lead${lead.owner && lead.owner_id !== req.user.id ? ' from ' + lead.owner + ' after ' + lead.idleDays + ' quiet days' : ''}` : `Handed to ${to.display_name}`);
    if (to.id === req.user.id && lead.owner_id && lead.owner_id !== req.user.id) push.notify([lead.owner_id], 'task_assigned', { title: `${req.user.display_name} took your lead: ${lead.company}`, body: `It had no activity for ${lead.idleDays} days.`, url: `/sales/${lead.id}` });
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
  db.prepare("UPDATE leads SET branch_id = ?, owner_id = NULL, source = COALESCE(source, 'Another office'), referred_by = ?, referred_from = ?, updated_at = ? WHERE id = ?").run(office.id, req.user.id, lead.branch_id, new Date().toISOString(), lead.id);
  log(lead, req.user, 'refer', `Passed from the ${lead.office} office to the ${office.name} office${why ? ': ' + why : ''}`);
  activity.log(req.user, 'Lead passed to another office', `${lead.company} to ${office.name}`);
  push.notify(salesPeople(office.id).map((u) => u.id), 'task_assigned', { title: `New lead from the ${lead.office} office`, body: `${lead.company}${why ? ': ' + why : ''}`, url: `/sales/${lead.id}` });
  flash(req, 'ok', `Passed to the ${office.name} office.`);
  res.redirect('/sales');
});

// Repeat work: start this year's lead from last year's win. The new one carries the customer's details over.
router.post('/sales/:id/renew', use, (req, res) => {
  const lead = editable(req, res);
  if (!lead) return;
  if (lead.stage !== 'won' || lead.renewed_as) return res.redirect(`/sales/${lead.id}`);
  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO leads (branch_id, company, contact_name, phone, email, address, interest, source, value, stage, owner_id, next_on, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Existing customer', ?, 'new', ?, ?, ?, ?, ?)`)
      .run(lead.branch_id, lead.company, lead.contact_name, lead.phone, lead.email, lead.address, lead.interest, lead.value, lead.owner_id || req.user.id, lead.renew_on, req.user.id, now, now);
    db.prepare('UPDATE leads SET renewed_as = ? WHERE id = ?').run(info.lastInsertRowid, lead.id);
    db.prepare("INSERT INTO lead_notes (lead_id, user_id, kind, body, created_at) VALUES (?, ?, 'stage', ?, ?)").run(info.lastInsertRowid, req.user.id, `Repeat work, following the job won on ${fmtDate((lead.closed_at || now).slice(0, 10))}`, now);
    return info.lastInsertRowid;
  })();
  log(lead, req.user, 'stage', 'Repeat work started as a new lead');
  flash(req, 'ok', 'Started as a new lead with the same details.');
  res.redirect(`/sales/${id}`);
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
