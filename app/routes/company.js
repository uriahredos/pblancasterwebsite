'use strict';
// The company at a glance: every office with what it does, the regions, and who to contact for what.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const offices = require('../offices');
const { requireLogin, verifyCsrf, forbidden, flash } = require('../auth');
const { clean } = require('../util');

const router = express.Router();
const isId = (v) => /^\d+$/.test(String(v || ''));
const everyOffice = (req, res, next) => requireLogin(req, res, () => (req.user.allBranches ? next() : forbidden(res)));
const LISTED = '(u.active = 1 OR u.in_directory = 1)';
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

const allServices = () => db.prepare('SELECT s.*, (SELECT COUNT(*) FROM branch_services bs WHERE bs.service_id = s.id) AS offices FROM services s ORDER BY s.sort, s.name').all();
const servicesOf = (branchId) => db.prepare('SELECT s.* FROM branch_services bs JOIN services s ON s.id = bs.service_id WHERE bs.branch_id = ? ORDER BY s.sort, s.name').all(branchId);

/** Offices matching the finder's filters, each with its services and how many of its people are on the site. */
function findOffices({ q = '', region = '', state = '', service = null } = {}) {
  const where = []; const params = [];
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(b.name LIKE ? ESCAPE '\\' OR b.city LIKE ? ESCAPE '\\' OR b.number LIKE ? ESCAPE '\\' OR b.street LIKE ? ESCAPE '\\' OR b.about LIKE ? ESCAPE '\\' OR b.marketing_name LIKE ? ESCAPE '\\' OR b.market LIKE ? ESCAPE '\\' OR b.product_lines LIKE ? ESCAPE '\\' OR b.address LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like, like, like, like, like);
  }
  if (region) { where.push('b.region = ?'); params.push(region); }
  if (state) { where.push('b.state = ?'); params.push(state); }
  if (service) { where.push('EXISTS (SELECT 1 FROM branch_services bs WHERE bs.branch_id = b.id AND bs.service_id = ?)'); params.push(service); }
  const rows = db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND ${LISTED}) AS people FROM branches b
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.state IS NULL, b.state, b.name COLLATE NOCASE`).all(...params);
  const map = new Map();
  for (const r of db.prepare('SELECT bs.branch_id, s.code, s.name FROM branch_services bs JOIN services s ON s.id = bs.service_id ORDER BY s.sort').all()) {
    if (!map.has(r.branch_id)) map.set(r.branch_id, []);
    map.get(r.branch_id).push(r);
  }
  return rows.map((b) => ({ ...b, services: map.get(b.id) || [] }));
}

const contactRows = () => db.prepare('SELECT * FROM company_contacts ORDER BY sort').all();
/** Each region's vice president and directors, from the "Regional Layout" part of the contact list. */
function regionLeaders() {
  const out = new Map();
  for (const c of db.prepare("SELECT * FROM company_contacts WHERE section = 'Regional Layout' ORDER BY sort").all()) {
    if (!out.has(c.grp)) out.set(c.grp, { vp: null, directors: [] });
    if (/vice president/i.test(c.topic || '')) out.get(c.grp).vp = c; else out.get(c.grp).directors.push(c);
  }
  return out;
}

// ---- The main page -----------------------------------------------------------------

router.get('/company', requireLogin, (req, res) => {
  const all = findOffices();
  const leaders = regionLeaders();
  const regions = [...new Set(all.map((b) => b.region).filter(Boolean))].sort().map((name) => {
    const mine = all.filter((b) => b.region === name);
    return { name, offices: mine.length, states: [...new Set(mine.map((b) => b.state).filter(Boolean))].sort(), ...(leaders.get(name) || { vp: null, directors: [] }) };
  });
  const sections = [...new Set(contactRows().filter((c) => c.section !== 'Regional Layout').map((c) => c.section))];
  res.render('company', {
    title: 'Company', wide: true, regions, services: allServices(), sections,
    total: all.length, states: new Set(all.map((b) => b.state).filter(Boolean)).size,
    people: db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${LISTED}`).get().n,
    described: all.filter((b) => b.services.length).length,
    mine: all.find((b) => b.id === req.user.branch_id) || null,
  });
});

// ---- Who to contact ------------------------------------------------------------------

router.get('/contacts', requireLogin, (req, res) => {
  const q = clean(req.query.q, 60).toLowerCase();
  const rows = contactRows().filter((c) => !q || [c.section, c.grp, c.topic, c.name, c.email, c.note].some((v) => String(v || '').toLowerCase().includes(q)));
  const sections = [];
  for (const c of rows) {
    let s = sections[sections.length - 1];
    if (!s || s.title !== c.section) { s = { title: c.section, groups: [] }; sections.push(s); }
    let g = s.groups[s.groups.length - 1];
    if (!g || g.title !== (c.grp || '')) { g = { title: c.grp || '', rows: [] }; s.groups.push(g); }
    g.rows.push(c);
  }
  res.render('contacts', { title: 'Who to contact', wide: true, sections, q, total: db.prepare('SELECT COUNT(*) AS n FROM company_contacts').get().n, canManage: req.user.allBranches });
});

// Replace the whole list from the file prepared from the "Who To Contact" spreadsheet.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');
router.post('/admin/company/contacts', everyOffice, (req, res, next) => upload(req, res, (err) => { req.body = req.body || {}; req.uploadFailed = Boolean(err); next(); }), verifyCsrf, (req, res) => {
  const fail = (msg) => { flash(req, 'err', msg); res.redirect('/admin/branches#company'); };
  if (req.uploadFailed || !req.file) return fail('Choose the contacts file (up to 2 MB).');
  let data;
  try { data = JSON.parse(req.file.buffer.toString('utf8')); } catch (e) { return fail('That file could not be read. Use the contacts file that was prepared for this site.'); }
  if (!data || data.format !== 'pb-company-contacts-1' || !Array.isArray(data.contacts) || data.contacts.length > 2000) return fail('That is not a company contacts file.');
  const rows = data.contacts.map((c) => ({ section: clean(c.section, 80), grp: clean(c.group, 80), topic: clean(c.topic, 300), name: clean(c.name, 120), email: clean(c.email, 240), note: clean(c.note, 200) }))
    .filter((c) => c.section && (c.name || c.email));
  if (!rows.length) return fail('That file has no contacts in it.');
  db.transaction(() => {
    db.prepare('DELETE FROM company_contacts').run();
    const add = db.prepare('INSERT INTO company_contacts (section, grp, topic, name, email, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    rows.forEach((c, i) => add.run(c.section, c.grp || null, c.topic || null, c.name || null, c.email || null, c.note || null, i + 1));
  })();
  activity.log(req.user, 'Company contacts loaded', `${rows.length} entries`);
  flash(req, 'ok', `Who to contact now has ${rows.length} entries.`);
  res.redirect('/admin/branches#company');
});

// ---- Loading the company's office list -----------------------------------------------

/** Offices on the list that are not on the site yet, and offices here that have no number (so might be one of them). */
function officeListStatus() {
  const have = new Set(db.prepare('SELECT number FROM branches WHERE number IS NOT NULL').all().map((r) => r.number));
  const missing = offices.all().filter((o) => !have.has(o.number));
  return {
    missing,
    // An office here whose name is what a listed office goes by ("Lancaster" for the Ephrata office) is offered as that one.
    unnumbered: db.prepare('SELECT id, name FROM branches WHERE number IS NULL ORDER BY name COLLATE NOCASE').all()
      .map((u) => ({ ...u, guess: (missing.find((o) => [o.marketing, o.name, o.labelCity].some((n) => n && n.toLowerCase() === u.name.toLowerCase())) || {}).number || '' })),
  };
}

router.post('/admin/company/offices', everyOffice, (req, res) => {
  const list = offices.all();
  const byNumber = new Map(list.map((o) => [o.number, o]));
  const codes = new Map(db.prepare('SELECT id, code FROM services').all().map((s) => [s.code.toUpperCase(), s.id]));
  const result = { added: 0, linked: 0, filled: 0 };
  db.transaction(() => {
    const fill = db.prepare('UPDATE branches SET number = ?, city = ?, state = ?, street = ?, region = ? WHERE id = ?');
    const tick = db.prepare('INSERT OR IGNORE INTO branch_services (branch_id, service_id) VALUES (?, ?)');
    // What the company list says about an office goes in wherever the site has nothing yet; it never overwrites what an office's admin has put in.
    const details = db.prepare(`UPDATE branches SET address = COALESCE(address, NULLIF(?, '')), phone = COALESCE(phone, NULLIF(?, '')), marketing_name = COALESCE(marketing_name, NULLIF(?, '')),
                                 market = COALESCE(market, NULLIF(?, '')), product_lines = COALESCE(product_lines, NULLIF(?, '')) WHERE id = ?`);
    const hint = (id, o) => {
      const changed = details.run(o.address, o.phone, o.marketing, o.market, o.products, id).changes;
      if (!db.prepare('SELECT 1 FROM branch_services WHERE branch_id = ?').get(id)) o.services.forEach((code) => { if (codes.has(code)) tick.run(id, codes.get(code)); });
      return changed;
    };
    // First, offices that are already here under another name ("Lancaster" being the Ephrata office, say).
    for (const b of db.prepare('SELECT id FROM branches WHERE number IS NULL').all()) {
      const o = byNumber.get(String(req.body[`is_${b.id}`] || ''));
      if (o && !db.prepare('SELECT 1 FROM branches WHERE number = ?').get(o.number)) { fill.run(o.number, o.city, o.state, o.street, o.region, b.id); hint(b.id, o); result.linked++; }
    }
    const add = db.prepare('INSERT INTO branches (name, created_at, number, city, state, street, region) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const o of list) {
      const here = db.prepare('SELECT id, address, phone, market FROM branches WHERE number = ?').get(o.number);
      if (here) { if (!here.address || !here.phone || !here.market) result.filled++; hint(here.id, o); continue; }
      let name = o.name;
      if (db.prepare('SELECT 1 FROM branches WHERE name = ?').get(name)) name = `${o.name} (${o.number})`;
      const id = add.run(name, new Date().toISOString(), o.number, o.city, o.state, o.street, o.region).lastInsertRowid;
      require('../branches').setUp(id);
      hint(id, o); result.added++;
    }
  })();
  activity.log(req.user, 'Office list loaded', `${result.added} offices added, ${result.linked} matched to offices already here`);
  flash(req, 'ok', `${result.added} offices added${result.linked ? `, ${result.linked} matched to an office already here` : ''}, each with its services, address and phone from the company list. An office's own admin can correct them on the office's page.`);
  res.redirect('/admin/branches#company');
});

// Office details in bulk: a CSV with an office Number column and any of Services, Address, Phone, About.
// Services are codes or names separated by commas, slashes or semicolons ("FE, KH" or "Fire Alarm; Backflow").
router.post('/admin/company/details', everyOffice, (req, res, next) => upload(req, res, (err) => { req.body = req.body || {}; req.uploadFailed = Boolean(err); next(); }), verifyCsrf, (req, res) => {
  const fail = (msg) => { flash(req, 'err', msg); res.redirect('/admin/branches#company'); };
  if (req.uploadFailed || !req.file) return fail('Choose the office details file (up to 2 MB).');
  if (req.file.buffer.subarray(0, 2).toString('latin1') === 'PK') return fail('That is an Excel workbook. In Excel choose File > Save As > CSV, then upload the CSV file.');
  const rows = require('./catalog').parseCsv(req.file.buffer.toString('utf8'));
  if (rows.length < 2) return fail('The file needs a header row and at least one office.');
  const h = rows[0].map((c) => c.trim().toLowerCase());
  const col = (re) => h.findIndex((c) => re.test(c));
  const cNum = col(/number|branch|office|code|#/), cSvc = col(/service|does|capabil|line/), cAddr = col(/address|street/), cPhone = col(/phone/), cAbout = col(/about|note|descr/);
  if (cNum < 0) return fail('The file needs a column with each office\'s number. Services, Address, Phone and About are optional.');
  const svc = db.prepare('SELECT id, code, name FROM services').all();
  const result = { updated: 0, unknownOffices: [], unknownServices: new Set() };
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      const number = (clean(r[cNum], 20).match(/\d{3,5}/) || [''])[0];
      const b = number ? db.prepare('SELECT id FROM branches WHERE number = ?').get(number) : null;
      if (!b) { if (number) result.unknownOffices.push(number); continue; }
      if (cSvc >= 0 && clean(r[cSvc], 400)) {
        db.prepare('DELETE FROM branch_services WHERE branch_id = ?').run(b.id);
        for (const part of clean(r[cSvc], 400).split(/[,;/|]+/).map((x) => x.trim()).filter(Boolean)) {
          const hit = svc.find((x) => x.code.toLowerCase() === part.toLowerCase() || x.name.toLowerCase() === part.toLowerCase());
          if (hit) db.prepare('INSERT OR IGNORE INTO branch_services (branch_id, service_id) VALUES (?, ?)').run(b.id, hit.id); else result.unknownServices.add(part);
        }
      }
      if (cAddr >= 0 && clean(r[cAddr], 200)) db.prepare('UPDATE branches SET address = ? WHERE id = ?').run(clean(r[cAddr], 200), b.id);
      if (cPhone >= 0 && /^[0-9 ()+.x-]{7,30}$/.test(clean(r[cPhone], 30))) db.prepare('UPDATE branches SET phone = ? WHERE id = ?').run(clean(r[cPhone], 30), b.id);
      if (cAbout >= 0 && clean(r[cAbout], 1500)) db.prepare('UPDATE branches SET about = ? WHERE id = ?').run(clean(r[cAbout], 1500), b.id);
      result.updated++;
    }
  })();
  activity.log(req.user, 'Office details loaded', `${result.updated} offices updated`);
  flash(req, result.updated ? 'ok' : 'err', `${result.updated} offices updated.` +
    (result.unknownServices.size ? ` Not recognised as services (add them to the list first): ${[...result.unknownServices].slice(0, 12).join(', ')}.` : '') +
    (result.unknownOffices.length ? ` No office with number: ${result.unknownOffices.slice(0, 12).join(', ')}.` : ''));
  res.redirect('/admin/branches#company');
});

// ---- The list of services ----------------------------------------------------------------

router.post('/admin/company/services', everyOffice, (req, res) => {
  const code = clean(req.body.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, ''); const name = clean(req.body.name, 60);
  if (!code || !name) flash(req, 'err', 'A service needs a short code (such as FA) and a name.');
  else if (db.prepare('SELECT 1 FROM services WHERE code = ?').get(code)) flash(req, 'err', `There is already a service with the code ${code}.`);
  else {
    db.prepare('INSERT INTO services (code, name, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM services))').run(code, name);
    activity.log(req.user, 'Service added', `${code}: ${name}`); flash(req, 'ok', `${name} added.`);
  }
  res.redirect('/admin/branches#services');
});

router.post('/admin/company/services/:id', everyOffice, (req, res) => {
  const s = isId(req.params.id) ? db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id) : null;
  if (s && req.body.remove === '1') {
    db.prepare('DELETE FROM services WHERE id = ?').run(s.id);
    activity.log(req.user, 'Service removed', `${s.code}: ${s.name}`); flash(req, 'ok', `${s.name} removed from the list and from every office.`);
  } else if (s) {
    const name = clean(req.body.name, 60);
    if (name) { db.prepare('UPDATE services SET name = ? WHERE id = ?').run(name, s.id); flash(req, 'ok', 'Service renamed.'); }
  }
  res.redirect('/admin/branches#services');
});

module.exports = router;
Object.assign(module.exports, { findOffices, allServices, servicesOf, officeListStatus, regionLeaders, STATES });
