'use strict';
// The community side of the site: who everyone is, welcoming new people, and the daily question.
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const uploads = require('../uploads');
const daily = require('../daily');
const activity = require('../activity');
const { requireLogin, requirePerm, verifyCsrf, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate } = require('../util');

const router = express.Router();
const notFound = (res) => res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
const isId = (v) => /^\d+$/.test(String(v || ''));
const MAX_PHOTO = 4 * 1024 * 1024;   // the page shrinks photos before sending, so this is generous
const WELCOME_DAYS = 14;

// (for the People filter: only offices that have someone listed)
const branches = () => db.prepare('SELECT * FROM branches b WHERE EXISTS (SELECT 1 FROM users u WHERE u.branch_id = b.id AND (u.active = 1 OR u.in_directory = 1)) ORDER BY name COLLATE NOCASE').all();
/** "EST3, Notifier , sprinklers" -> ["EST3", "Notifier", "sprinklers"] */
const skillList = (text) => [...new Set(String(text || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
function tenure(startedOn, today = localDate()) {
  if (!isYmd(startedOn) || startedOn > today) return '';
  const months = (Number(today.slice(0, 4)) - Number(startedOn.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(startedOn.slice(5, 7)) - (today.slice(8) < startedOn.slice(8) ? 1 : 0);
  if (months < 1) return 'Just started';
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} with us`;
  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? 'year' : 'years'} with us`;
}
const PERSON = `SELECT u.id, u.display_name, u.birthday, u.active, u.department, u.job_title, u.started_on, u.about, u.skills, u.photo_path, u.branch_id, b.name AS branch,
  CASE WHEN u.show_phone = 1 THEN u.phone END AS phone, CASE WHEN u.show_email = 1 THEN u.email END AS email
  FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE (u.active = 1 OR u.in_directory = 1)`;
const decorate = (p) => ({ ...p, skillList: skillList(p.skills), tenure: tenure(p.started_on) });

// ---- People -----------------------------------------------------------------

router.get('/people', requireLogin, (req, res) => {
  const q = clean(req.query.q, 60);
  const branch = isId(req.query.branch) ? Number(req.query.branch) : null;
  const where = []; const params = [];
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(u.display_name LIKE ? ESCAPE '\\' OR u.job_title LIKE ? ESCAPE '\\' OR u.skills LIKE ? ESCAPE '\\' OR u.about LIKE ? ESCAPE '\\' OR u.department LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like);
  }
  if (branch) { where.push('u.branch_id = ?'); params.push(branch); }
  const departments = db.prepare("SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND (active = 1 OR in_directory = 1) ORDER BY department COLLATE NOCASE").all().map((r) => r.department);
  const dept = departments.includes(req.query.dept) ? req.query.dept : '';
  if (dept) { where.push('u.department = ?'); params.push(dept); }
  const people = db.prepare(`${PERSON} ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY u.display_name COLLATE NOCASE LIMIT 500`).all(...params).map(decorate);
  res.render('people', { title: 'People', wide: true, people, q, branch, dept, departments, branches: branches(), total: db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1 OR in_directory = 1').get().n });
});

router.get('/people/photo/:id', requireLogin, (req, res) => {
  const row = isId(req.params.id) ? db.prepare('SELECT photo_path FROM users WHERE id = ? AND (active = 1 OR in_directory = 1)').get(req.params.id) : null;
  if (!row || !row.photo_path) return notFound(res);
  res.sendFile(require('path').basename(row.photo_path), { root: uploads.uploadDir, headers: { 'Cache-Control': 'private, max-age=86400' } },
    (err) => { if (err && !res.headersSent) notFound(res); });
});

router.get('/people/:id', requireLogin, (req, res) => {
  const p = isId(req.params.id) ? db.prepare(`${PERSON} AND u.id = ?`).get(req.params.id) : null;
  if (!p) return notFound(res);
  // Certifications by name only: when they run out is between the person and whoever keeps the records.
  const certs = db.prepare('SELECT DISTINCT name FROM certifications WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(p.id).map((c) => c.name);
  const welcome = db.prepare('SELECT * FROM welcomes WHERE user_id = ?').get(p.id);
  const notes = welcome ? db.prepare(
    `SELECT n.message, n.created_at, u.id, u.display_name, u.photo_path FROM welcome_notes n JOIN users u ON u.id = n.user_id
     WHERE n.welcome_id = ? AND u.active = 1 ORDER BY n.created_at`).all(welcome.id) : [];
  const social = require('./social');
  const bday = /^\d\d-\d\d$/.test(p.birthday || '') ? `${social.MONTHS[Number(p.birthday.slice(0, 2)) - 1]} ${Number(p.birthday.slice(3))}` : '';
  const canPosition = access.can(req.user, 'users.manage') && access.canSee(req.user, p.id);
  const team = require('../team');
  const reportsTo = team.managerOf(p.id);
  const theirTeam = db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.job_title FROM user_managers um JOIN users u ON u.id = um.user_id WHERE um.manager_id = ? AND (u.active = 1 OR u.in_directory = 1) ORDER BY u.display_name COLLATE NOCASE`).all(p.id);
  res.render('person', { canPosition, reportsTo, theirTeam, title: p.display_name, p: decorate(p), certs, welcome, notes, me: p.id === req.user.id, bday, shouts: social.shoutoutsFor(req.user.id, p.id) });
});

// ---- Positions: job titles and departments for a whole office, edited in one table -------------

const deptList = () => db.prepare("SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department <> '' AND (active = 1 OR in_directory = 1) ORDER BY department COLLATE NOCASE").all().map((r) => r.department);
function positionPeople(user) {
  const ids = access.visibleUserIds(user);
  return db.prepare(`SELECT u.id, u.display_name, u.job_title, u.department, u.photo_path, u.branch_id, u.leads, u.manager_manual, u.profile_id, u.is_master, b.name AS branch,
      (SELECT um.manager_id FROM user_managers um JOIN users m ON m.id = um.manager_id WHERE um.user_id = u.id ORDER BY m.display_name COLLATE NOCASE LIMIT 1) AS manager_id
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id
    WHERE (u.active = 1 OR u.in_directory = 1) ${ids ? `AND u.id IN (${ids.map(Number).join(',') || 0})` : ''} ORDER BY u.display_name COLLATE NOCASE LIMIT 1000`).all();
}
router.get('/admin/positions', requirePerm('users.manage'), (req, res) => res.redirect('/admin/users/positions' + (isId(req.query.who) ? `?who=${req.query.who}` : '')));   // its old address
router.get('/admin/users/chart', requirePerm('users.manage'), (req, res) => {
  const officeId = req.user.viewBranch || (req.user.allBranches ? null : req.user.branch_id);
  const office = officeId ? db.prepare('SELECT id, name FROM branches WHERE id = ?').get(officeId) : null;
  const ids = access.visibleUserIds(req.user);
  const people = office ? db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.job_title, u.department FROM users u WHERE u.branch_id = ? AND (u.active = 1 OR u.in_directory = 1) ORDER BY u.display_name COLLATE NOCASE`).all(office.id).filter((u) => !ids || ids.includes(u.id)) : [];
  res.render('admin_org', { title: 'Organization chart', wide: true, office, teamChart: require('../team').chart(people) });
});
router.get('/admin/users/positions', requirePerm('users.manage'), (req, res) => {
  const saved = req.session.positionsSaved; delete req.session.positionsSaved;
  const problemsOnce = req.session.positionsProblems || []; delete req.session.positionsProblems;
  const people = positionPeople(req.user);
  // Who each person could report to: the people of their own office.
  const byOffice = new Map();
  for (const p of people) { if (!byOffice.has(p.branch_id)) byOffice.set(p.branch_id, []); byOffice.get(p.branch_id).push(p); }
  res.render('admin_positions', { title: 'Positions and reporting', wide: true, people, byOffice, problems: problemsOnce, profiles: db.prepare('SELECT id, name FROM profiles ORDER BY name COLLATE NOCASE').all().filter((pr) => access.canGrant(req.user, access.permsOf(pr.id))), titles: require('../team').titles(), roleTree: require('../team').roleTree(), canTitles: Boolean(req.user.allBranches), saved, focus: isId(req.query.who) ? Number(req.query.who) : 0, showOffice: req.user.viewBranch === null });
});
router.post('/admin/users/positions', requirePerm('users.manage'), (req, res) => {
  let changed = 0; const problems = []; const offices = new Set();
  const team = require('../team');
  db.transaction(() => {
    const people = positionPeople(req.user); const names = new Map(people.map((p) => [p.id, p.display_name]));
    for (const p of people) {
      if (req.body[`job_${p.id}`] === undefined && req.body[`mgr_${p.id}`] === undefined) continue;
      let touched = false;
      offices.add(p.branch_id);
      // Job title: one from the list, or none. The title carries its department.
      if (req.body[`job_${p.id}`] !== undefined) {
        const typed = clean(req.body[`job_${p.id}`], 80);
        const title = typed ? team.titleByName(typed) : null;
        if ((!typed || title) && (title ? title.name : null) !== (p.job_title || null)) {
          const dept = title ? title.department || p.department || null : p.department || null;
          db.prepare('UPDATE users SET job_title = ?, department = ? WHERE id = ?').run(title ? title.name : null, dept, p.id); touched = true;
          activity.log(req.user, 'Position changed', `${p.display_name}: ${[title && title.name, dept].filter(Boolean).join(' · ') || 'cleared'}`);
          // A role that carries a profile gives it to the person: never to yourself or the master account, and only a profile you could hand out anyway.
          if (title && title.profile_id && title.profile_id !== p.profile_id && p.id !== req.user.id && !p.is_master
              && access.canGrant(req.user, access.permsOf(title.profile_id)) && (!p.profile_id || access.canGrant(req.user, access.permsOf(p.profile_id)))) {
            db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(title.profile_id, p.id);
            activity.log(req.user, 'Profile set by role', `${p.display_name}: ${db.prepare('SELECT name FROM profiles WHERE id = ?').get(title.profile_id).name}`);
          }
        }
      }
      // Reports to: automatic (from the job title), or someone from the same office chosen by hand, or nobody.
      if (req.body[`mgr_${p.id}`] !== undefined) {
        const choice = String(req.body[`mgr_${p.id}`]);
        if (choice === 'auto') {
          if (p.manager_manual) { db.prepare('UPDATE users SET manager_manual = 0 WHERE id = ?').run(p.id); touched = true; activity.log(req.user, 'Reports to changed', `${p.display_name}: automatic`); }
        } else {
          const mgr = isId(choice) ? Number(choice) : null;
          if ((!p.manager_manual || mgr !== (p.manager_id || null)) && (!mgr || names.has(mgr))) {
            const why = team.setManager(p.id, mgr);
            if (why) problems.push(`${p.display_name} could not be set to report to ${names.get(mgr)}: ${why}.`);
            else { db.prepare('UPDATE users SET manager_manual = 1 WHERE id = ?').run(p.id); touched = true; activity.log(req.user, 'Reports to changed', `${p.display_name}: ${mgr ? names.get(mgr) : 'nobody'}`); }
          }
        }
      }
      if (touched) changed += 1;
    }
  })();
  for (const office of offices) team.applyAuto(office);
  req.session.positionsSaved = changed; req.session.positionsProblems = problems;
  res.redirect('/admin/users/positions');
});

// The company's list of job titles: what each is called, its department, and which title it reports to. Corporate only.
router.post('/admin/users/titles', requireLogin, (req, res) => {
  if (!req.user.allBranches || !access.can(req.user, 'users.manage')) return forbidden(res);
  const team = require('../team'); const problems = []; let changed = 0;
  db.transaction(() => {
    for (const t of team.titles()) {
      if (req.body[`tname_${t.id}`] === undefined) continue;
      const act = String(req.body[`tact_${t.id}`] || '');
      if (/^merge:\d+$/.test(act)) {
        const into = Number(act.slice(6));
        if (into === t.id || !db.prepare('SELECT 1 FROM job_titles WHERE id = ?').get(into)) continue;
        const intoName = db.prepare('SELECT name FROM job_titles WHERE id = ?').get(into).name;
        const moved = team.mergeTitle(t.id, into); changed += 1;
        activity.log(req.user, 'Roles merged', `${t.name} into ${intoName} (${moved} ${moved === 1 ? 'person' : 'people'})`); continue;
      }
      if (req.body[`tdel_${t.id}`] === '1' || act === 'del') {
        if (t.holders) { problems.push(`${t.name} is still someone's job title, so it was kept. Give those people another title first.`); continue; }
        db.prepare('DELETE FROM job_titles WHERE id = ?').run(t.id); changed += 1; activity.log(req.user, 'Job title removed', t.name); continue;
      }
      const name = clean(req.body[`tname_${t.id}`], 80) || t.name; const dept = clean(req.body[`tdept_${t.id}`], 60) || null;
      const parent = isId(req.body[`tparent_${t.id}`]) ? Number(req.body[`tparent_${t.id}`]) : null;
      if (name.toLowerCase() !== t.name.toLowerCase() && team.titleByName(name)) { problems.push(`There is already a job title called ${name}.`); continue; }
      if (parent && (parent === t.id || team.titleLoop(t.id, parent))) { problems.push(`${t.name} cannot report to a title that reports to it.`); continue; }
      // The profile a role carries: only one you could hand out yourself. Left out of the form, it stays as it is.
      const sent = req.body[`tprofile_${t.id}`];
      let prof = t.profile_id || null;
      if (sent !== undefined) { const want = isId(sent) ? Number(sent) : null; if (!want || (db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(want) && access.canGrant(req.user, access.permsOf(want)))) prof = want; }
      if (!db.prepare('SELECT 1 FROM job_titles WHERE id = ?').get(t.id)) continue;   // merged away earlier in this save
      if (name === t.name && dept === (t.department || null) && parent === (t.parent_id || null) && prof === (t.profile_id || null)) continue;
      db.prepare('UPDATE job_titles SET name = ?, department = ?, parent_id = ?, profile_id = ? WHERE id = ?').run(name, dept, parent, prof, t.id);
      if (name !== t.name) db.prepare('UPDATE users SET job_title = ? WHERE job_title = ? COLLATE NOCASE').run(name, t.name);
      if (dept !== (t.department || null) && dept) db.prepare('UPDATE users SET department = ? WHERE job_title = ? COLLATE NOCASE').run(dept, name);
      changed += 1; activity.log(req.user, 'Job title changed', name);
    }
    const fresh = clean(req.body.new_name, 80);
    if (fresh) {
      if (team.titleByName(fresh)) problems.push(`There is already a job title called ${fresh}.`);
      else {
        const np = isId(req.body.new_profile) && access.canGrant(req.user, access.permsOf(Number(req.body.new_profile))) ? Number(req.body.new_profile) : null;
        db.prepare('INSERT INTO job_titles (name, department, parent_id, profile_id) VALUES (?, ?, ?, ?)').run(fresh, clean(req.body.new_dept, 60) || null, isId(req.body.new_parent) ? Number(req.body.new_parent) : null, np);
        changed += 1; activity.log(req.user, 'Job title added', fresh);
      }
    }
  })();
  team.applyAutoEverywhere();
  req.session.positionsSaved = changed; req.session.positionsProblems = problems;
  res.redirect('/admin/users/positions');
});

// ---- My own profile ------------------------------------------------------------

function profileForm(req, res, extra = {}) {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const values = extra.values || me;
  const [bMonth, bDay] = /^\d\d-\d\d$/.test(values.birthday || '') ? values.birthday.split('-').map(Number) : [null, null];
  res.status(extra.errors ? 400 : 200).render('profile_edit', { title: 'My profile', me, errors: [], months: require('./social').MONTHS, ...extra, values, bMonth, bDay });
}
router.get('/profile', requireLogin, (req, res) => profileForm(req, res));

router.post('/profile', requireLogin, uploads.photos('photo', 1), verifyCsrf, (req, res) => {
  const file = req.files[0] || null;
  const values = {
    started_on: clean(req.body.started_on, 10), about: clean(req.body.about, 1000),
    skills: skillList(clean(req.body.skills, 800)).map((s) => s.slice(0, 40)).slice(0, 25).join(', '),
    birthday: null,
    phone: clean(req.body.phone, 30), show_phone: req.body.show_phone === '1' ? 1 : 0, show_email: req.body.show_email === '1' ? 1 : 0,
  };
  const errors = [];
  const bm = Number(req.body.birth_month), bd = Number(req.body.birth_day);
  if (req.body.birth_month || req.body.birth_day) {
    if (bm >= 1 && bm <= 12 && bd >= 1 && bd <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][bm - 1]) values.birthday = `${String(bm).padStart(2, '0')}-${String(bd).padStart(2, '0')}`;
    else errors.push('Choose both a month and a day for your birthday, or neither.');
  }
  if (values.started_on && (!isYmd(values.started_on) || values.started_on > localDate())) errors.push('The start date does not look right.');
  if (values.phone && !/^[0-9 ()+.x-]{7,30}$/.test(values.phone)) errors.push('The phone number does not look right.');
  if (req.photoError) errors.push(req.photoError);
  else if (file && !uploads.looksLikeImage(file.path)) errors.push('The photo must be a JPEG, PNG, WebP or GIF image.');
  else if (file && file.size > MAX_PHOTO) errors.push('That photo is too large. Choose a smaller one.');
  if (errors.length) { if (file) uploads.remove(file.filename); return profileForm(req, res, { errors, values: { ...values, photo_path: req.user.photo_path } }); }

  const old = req.user.photo_path;
  const photo = file ? file.filename : req.body.remove_photo === '1' ? null : old;
  db.prepare('UPDATE users SET started_on = ?, about = ?, skills = ?, phone = ?, show_phone = ?, show_email = ?, photo_path = ?, birthday = ? WHERE id = ?')
    .run(values.started_on || null, values.about || null, values.skills || null, values.phone || null, values.show_phone, values.show_email, photo, values.birthday, req.user.id);
  if (old && old !== photo) uploads.remove(old);
  flash(req, 'ok', 'Profile saved.');
  res.redirect(`/people/${req.user.id}`);
});

// ---- Bringing in a contact list ---------------------------------------------------
// A spreadsheet saved as CSV with Name, Title, Email and Phone columns. A row with only a name
// (MANAGEMENT, SERVICE, ...) is a heading: the people under it belong to that department.

const ACRONYMS = new Set(['CED', 'HR', 'IT', 'GM', 'PM', 'VP', 'CEO', 'CFO', 'COO', 'II', 'III', 'IV', 'NICET', 'HVAC']);
const SMALL = new Set(['of', 'and', 'the', 'for', 'to', 'in']);
/** "MIKE MCDONNELL" -> "Mike McDonnell". Left alone if it already has lower-case letters. */
function tidyName(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (/[a-z]/.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase()).replace(/\bMc([a-z])/g, (m, ch) => 'Mc' + ch.toUpperCase());
}
/** "LEAD FIRE ALARM INSPECTOR" -> "Lead Fire Alarm Inspector", keeping CED and the like in capitals. */
function tidyTitle(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ');
  if (/[a-z]/.test(t)) return t;
  return t.split(' ').map((w, i) => (ACRONYMS.has(w) ? w : SMALL.has(w.toLowerCase()) && i ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
}
const lettersOnly = (text) => String(text || '').toLowerCase().replace(/[^a-z]/g, '');

function readContacts(rows) {
  const h = rows[0].map((c) => c.trim().toLowerCase());
  const col = (re) => h.findIndex((c) => re.test(c));
  const cName = col(/name/), cTitle = col(/title|position|role|job/), cEmail = col(/e-?mail/), cPhone = col(/phone|cell|mobile/);
  if (cName < 0) return { error: 'The file needs a "Name" column. "Title", "Email" and "Phone" are optional.' };
  const people = []; let department = null;
  for (const r of rows.slice(1)) {
    const name = clean(r[cName], 80);
    const rest = [cTitle, cEmail, cPhone].map((i) => (i >= 0 ? clean(r[i], 120) : ''));
    if (!name) continue;
    if (rest.every((v) => !v)) { department = tidyTitle(name).slice(0, 60); continue; }   // a heading row
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rest[1]) ? rest[1].toLowerCase() : '';
    const phone = /^[0-9 ()+.x-]{7,30}$/.test(rest[2]) && /\d{7}/.test(rest[2].replace(/\D/g, '')) ? rest[2].replace(/\)(\d)/, ') $1') : '';
    people.push({ name: tidyName(name), title: tidyTitle(rest[0]).slice(0, 80), email, phone, department });
  }
  return { people };
}

/** The account a contact belongs to: same email, or the email's "first.last" matches a name or username, or the same name. */
function findAccount(c, users) {
  const local = lettersOnly(c.email.split('@')[0]);
  return (c.email && users.find((u) => (u.email || '').toLowerCase() === c.email))
    || (local && users.find((u) => lettersOnly(u.display_name) === local || lettersOnly(u.username) === local))
    || users.find((u) => lettersOnly(u.display_name) === lettersOnly(c.name)) || null;
}

const csvUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');
router.post('/admin/people/import', requirePerm('users.manage'), (req, res, next) => csvUpload(req, res, (err) => {
  req.body = req.body || {}; req.uploadFailed = Boolean(err); next();
}), verifyCsrf, (req, res) => {
  if (req.user.scope !== 'all') return forbidden(res);
  const fail = (msg) => { flash(req, 'err', msg); res.redirect('/admin/import#contacts'); };
  if (req.uploadFailed || !req.file) return fail('Choose the contact list file (up to 2 MB).');
  if (req.file.buffer.subarray(0, 2).toString('latin1') === 'PK') return fail('That is an Excel workbook. In Excel choose File > Save As > CSV, then upload the CSV file.');
  const rows = require('./catalog').parseCsv(req.file.buffer.toString('utf8'));
  if (rows.length < 2) return fail('The file needs a header row and at least one person.');
  const read = readContacts(rows);
  if (read.error) return fail(read.error);
  if (read.people.length > 2000) return fail('That file has too many people in it.');

  const auth = require('../auth');
  const technician = access.profileByName('Technician') || db.prepare('SELECT * FROM profiles ORDER BY id LIMIT 1').get();
  const result = { updated: [], created: [] };
  db.transaction(() => {
    // Matching looks only at the branch being imported into; usernames must still be unique across the site.
    const taken = new Set(db.prepare('SELECT username FROM users').all().map((x) => x.username.toLowerCase()));
    const users = db.prepare('SELECT id, username, display_name, email FROM users WHERE branch_id = ?').all(req.user.workBranch);
    for (const c of read.people) {
      let u = findAccount(c, users);
      if (!u) {
        let username = (c.email ? c.email.split('@')[0] : c.name.replace(/\s+/g, '.')).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 36).padEnd(3, 'x');
        for (let i = 2; taken.has(username); i++) username = `${username.replace(/\d+$/, '')}${i}`;
        taken.add(username);
        // A random password nobody knows, and switched off: listed for everyone to see, but no sign-in until an admin enables it.
        const id = auth.createUser({ username, displayName: c.name, email: c.email, password: require('crypto').randomBytes(24).toString('hex'), profile: technician.id, branchId: req.user.workBranch });
        db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
        u = { id, username, display_name: c.name, email: c.email };
        users.push(u); result.created.push(c.name);
      } else result.updated.push(u.display_name);
      // The list is the branch's own record of titles and work contact details, so it sets those (the work email included) and shows them.
      db.prepare(`UPDATE users SET in_directory = 1, job_title = COALESCE(NULLIF(?, ''), job_title), department = COALESCE(?, department),
                    email = COALESCE(NULLIF(?, ''), email), phone = COALESCE(NULLIF(?, ''), phone),
                    show_phone = CASE WHEN ? <> '' THEN 1 ELSE show_phone END, show_email = CASE WHEN ? <> '' THEN 1 ELSE show_email END WHERE id = ?`)
        .run(c.title, c.department, c.email, c.phone, c.phone, c.email, u.id);
      if (c.title) require('../team').ensureTitle(c.title, c.department);
    }
  })();
  activity.log(req.user, 'Contact list imported', `${result.updated.length} existing accounts updated, ${result.created.length} people added`);
  req.session.contactResult = result;
  res.redirect('/admin/import#contacts');
});

// ---- Branches -----------------------------------------------------------------------
// Only for people who can see every branch (the master account, or a profile with that tick-box).

const everyBranch = (req, res, next) => requireLogin(req, res, () => (req.user.allBranches ? next() : forbidden(res)));

// Choose which branch the logs, stock and other branch pages show.
router.post('/branch/view', everyBranch, (req, res) => {
  const b = req.body.branch === 'all' ? 'all' : isId(req.body.branch) && db.prepare('SELECT id FROM branches WHERE id = ?').get(req.body.branch) ? Number(req.body.branch) : null;
  if (b !== null) req.session.viewBranch = b;
  const back = String(req.body.back || '/');
  res.redirect(/^\/(?![/\\])/.test(back) ? back : '/');
});

// Profiles that make someone an office's admin (they manage that office's people, and nothing outside it),
// and profiles that make someone a corporate admin (every office).
const profilePerms = () => db.prepare('SELECT p.id, p.name, p.scope FROM profiles p ORDER BY p.name COLLATE NOCASE').all().map((p) => ({ ...p, perms: access.permsOf(p.id) }));
const officeAdminProfiles = () => profilePerms().filter((p) => p.scope === 'all' && p.perms.has('users.manage') && !p.perms.has('branches.all'));
const corporateProfiles = () => profilePerms().filter((p) => p.scope === 'all' && p.perms.has('branches.all'));
const grantable = (req, list) => list.filter((p) => access.canGrant(req.user, p.perms));

function branchPage(req, res, extra = {}) {
  const office = officeAdminProfiles(); const corp = corporateProfiles();
  const inList = (list) => list.map((p) => p.id).join(',') || '0';
  const rows = db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.active = 1) AS people,
            (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.active = 0) AS off
     FROM branches b ORDER BY b.name COLLATE NOCASE`).all();
  // With a couple of hundred offices, only the ones in use (or the one asked for) are shown in full.
  const wanted = isId(req.query.office) ? Number(req.query.office) : extra.values && extra.values.office ? extra.values.office : null;
  const oq = clean(req.query.oq, 40).toLowerCase();
  const others = rows.filter((b) => !b.people && !b.off && b.id !== wanted)
    .filter((b) => !oq || [b.name, b.number, b.city, b.state, b.region].some((v) => String(v || '').toLowerCase().includes(oq)));
  const shown = rows.filter((b) => b.people || b.off || b.id === wanted).map((b) => ({
    ...b,
    admins: db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.active, u.must_change_password, p.name AS profile FROM users u JOIN profiles p ON p.id = u.profile_id
                        WHERE u.branch_id = ? AND u.is_master = 0 AND u.profile_id IN (${inList(office)}) ORDER BY u.display_name COLLATE NOCASE`).all(b.id),
    others: db.prepare(`SELECT u.id, u.display_name FROM users u WHERE u.branch_id = ? AND u.is_master = 0 AND u.id <> ? AND (u.profile_id IS NULL OR u.profile_id NOT IN (${inList([...office, ...corp])}))
                        ORDER BY u.display_name COLLATE NOCASE`).all(b.id, req.user.id),
  }));
  const corporate = db.prepare(`SELECT u.id, u.display_name, u.photo_path, u.is_master, u.active, b.name AS branch, p.name AS profile FROM users u
     LEFT JOIN profiles p ON p.id = u.profile_id LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.is_master = 1 OR u.profile_id IN (${inList(corp)}) ORDER BY u.is_master DESC, u.display_name COLLATE NOCASE`).all();
  const created = req.session.created || null;   // a temporary password, shown once
  delete req.session.created;
  const company = require('./company');
  res.status(extra.errors ? 400 : 200).render('admin_branches', {
    title: 'Corporate', wide: true, rows: shown, others, oq, totalOffices: rows.length, corporate, created, errors: [], values: {},
    list: company.officeListStatus(), listOptions: require('../offices').all(), services: company.allServices(),
    contactCount: db.prepare('SELECT COUNT(*) AS n FROM company_contacts').get().n,
    officeProfiles: grantable(req, office), corporateProfiles: grantable(req, corp),
    everyone: db.prepare(`SELECT u.id, u.display_name, b.name AS branch FROM users u LEFT JOIN branches b ON b.id = u.branch_id
                          WHERE u.active = 1 AND u.is_master = 0 AND u.id <> ? AND (u.profile_id IS NULL OR u.profile_id NOT IN (${inList(corp)})) ORDER BY u.display_name COLLATE NOCASE`).all(req.user.id),
    ...extra,
  });
}
router.get('/admin/branches', everyBranch, (req, res) => branchPage(req, res));

router.post('/admin/branches', everyBranch, (req, res) => {
  const name = clean(req.body.name, 60).replace(/\s+(branch|office)$/i, '');
  const errors = [];
  if (!name) errors.push('Give the office a name, such as the town it is in.');
  else if (db.prepare('SELECT 1 FROM branches WHERE name = ?').get(name)) errors.push('There is already an office with that name.');
  if (errors.length) return branchPage(req, res, { errors, values: { name } });
  const id = db.prepare('INSERT INTO branches (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString()).lastInsertRowid;
  require('../branches').setUp(id);
  activity.log(req.user, 'Office added', name);
  flash(req, 'ok', `${name} office added. Appoint its admin below; they can then add its people.`);
  res.redirect(`/admin/branches?office=${id}#o${id}`);
});

router.post('/admin/branches/:id', everyBranch, (req, res) => {
  const b = isId(req.params.id) ? db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id) : null;
  const name = clean(req.body.name, 60).replace(/\s+(branch|office)$/i, '');
  if (!b) return res.redirect('/admin/branches');
  if (!name || db.prepare('SELECT 1 FROM branches WHERE name = ? AND id <> ?').get(name, b.id)) flash(req, 'err', 'That name is empty or already used.');
  else {
    db.prepare('UPDATE branches SET name = ? WHERE id = ?').run(name, b.id);
    activity.log(req.user, 'Office renamed', `${b.name} to ${name}`);
    flash(req, 'ok', 'Office renamed.');
  }
  res.redirect('/admin/branches');
});

// Appoint an admin for an office: someone already in it, or a new person (who gets a temporary password).
router.post('/admin/branches/:id/admins', everyBranch, (req, res) => {
  const b = isId(req.params.id) ? db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id) : null;
  if (!b) return res.redirect('/admin/branches');
  const profile = grantable(req, officeAdminProfiles()).find((p) => String(p.id) === String(req.body.profile_id));
  if (!profile) return branchPage(req, res, { errors: ['Choose which admin profile they get.'] });
  const auth = require('../auth');
  if (isId(req.body.user_id)) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND branch_id = ? AND is_master = 0').get(req.body.user_id, b.id);
    if (!u || u.id === req.user.id) return branchPage(req, res, { errors: ['Choose someone from that office.'] });
    db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profile.id, u.id);
    activity.log(req.user, 'Office admin appointed', `${u.display_name} for ${b.name} (${profile.name})`);
    flash(req, 'ok', `${u.display_name} is now an admin for the ${b.name} office.${u.active ? '' : ' Their sign-in is switched off: enable it and reset their password under Users.'}`);
    return res.redirect(`/admin/branches#o${b.id}`);
  }
  const values = { username: clean(req.body.username, 40), display_name: clean(req.body.display_name, 80), email: clean(req.body.email, 120) };
  const errors = [];
  if (!values.display_name) errors.push('Choose someone from the office, or enter a new person\'s name.');
  else if (!/^[a-zA-Z0-9._-]{3,40}$/.test(values.username)) errors.push('Username: 3-40 letters, numbers, dot, dash or underscore.');
  else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(values.username)) errors.push('That username is already taken.');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('That email address does not look right.');
  if (errors.length) return branchPage(req, res, { errors, values: { ...values, office: b.id } });
  const password = auth.tempPassword();
  auth.createUser({ username: values.username, displayName: values.display_name, email: values.email, password, profile: profile.id, branchId: b.id });
  activity.log(req.user, 'Office admin appointed', `${values.display_name} (${values.username}) for ${b.name} (${profile.name})`);
  req.session.created = { username: values.username, password, what: 'created', office: b.name };
  res.redirect('/admin/branches');
});

// Stand an office admin down: they go back to the Technician profile.
router.post('/admin/branches/:id/admins/:uid/remove', everyBranch, (req, res) => {
  const u = isId(req.params.uid) ? db.prepare('SELECT * FROM users WHERE id = ? AND branch_id = ? AND is_master = 0').get(req.params.uid, req.params.id) : null;
  const tech = access.profileByName('Technician');
  if (u && tech && officeAdminProfiles().some((p) => p.id === u.profile_id) && access.canGrant(req.user, access.permsOf(u.profile_id))) {
    db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(tech.id, u.id);
    activity.log(req.user, 'Office admin stood down', u.display_name);
    flash(req, 'ok', `${u.display_name} is no longer an office admin. They are on the Technician profile now; change it under Users if needed.`);
  }
  res.redirect(`/admin/branches#o${req.params.id}`);
});

// Corporate admins: people who can see and manage every office.
router.post('/admin/corporate/admins', everyBranch, (req, res) => {
  const profile = grantable(req, corporateProfiles()).find((p) => String(p.id) === String(req.body.profile_id));
  const u = isId(req.body.user_id) ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1 AND is_master = 0').get(req.body.user_id) : null;
  if (!profile || !u || u.id === req.user.id) return branchPage(req, res, { errors: ['Choose a person and a corporate profile.'] });
  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profile.id, u.id);
  activity.log(req.user, 'Corporate admin appointed', `${u.display_name} (${profile.name})`);
  flash(req, 'ok', `${u.display_name} is now a corporate admin and can see and manage every office.`);
  res.redirect('/admin/branches#corporate');
});

// Stand a corporate admin down to an admin of their own office. Never the master account, and not yourself.
router.post('/admin/corporate/admins/:uid/remove', everyBranch, (req, res) => {
  const u = isId(req.params.uid) ? db.prepare('SELECT * FROM users WHERE id = ? AND is_master = 0').get(req.params.uid) : null;
  const to = officeAdminProfiles()[0] || access.profileByName('Technician');
  if (u && u.id !== req.user.id && to && corporateProfiles().some((p) => p.id === u.profile_id) && access.canGrant(req.user, access.permsOf(u.profile_id))) {
    db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(to.id, u.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(u.id);   // their wider view ends at once
    activity.log(req.user, 'Corporate admin stood down', `${u.display_name}, now ${to.name}`);
    flash(req, 'ok', `${u.display_name} is no longer a corporate admin. They are on the ${to.name} profile for their own office.`);
  }
  res.redirect('/admin/branches#corporate');
});

// ---- Welcoming new people -------------------------------------------------------

/** New hires announced in the last two weeks, newest first, with who has said hello. */
function recentWelcomes(userId) {
  const since = new Date(Date.now() - WELCOME_DAYS * 86400000).toISOString();
  return db.prepare(
    `SELECT w.id, w.intro, w.created_at, u.id AS user_id, u.display_name, u.job_title, u.photo_path, b.name AS branch,
            (SELECT COUNT(*) FROM welcome_notes n JOIN users x ON x.id = n.user_id WHERE n.welcome_id = w.id AND x.active = 1) AS waves,
            EXISTS (SELECT 1 FROM welcome_notes n WHERE n.welcome_id = w.id AND n.user_id = @me) AS waved
     FROM welcomes w JOIN users u ON u.id = w.user_id LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.active = 1 AND w.created_at >= @since ORDER BY w.created_at DESC LIMIT 6`).all({ me: userId, since });
}

// Announce someone as a new hire (or update the announcement). From the Edit person page.
router.post('/admin/users/:id/welcome', requirePerm('users.manage'), (req, res) => {
  const target = isId(req.params.id) ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) : null;
  if (!target) return res.redirect('/admin/users');
  if (!access.canSee(req.user, target.id)) return forbidden(res);
  const back = `/admin/users/${target.id}/edit`;
  const job = clean(req.body.job_title, 80); const started = clean(req.body.started_on, 10);
  if (started && !isYmd(started)) { flash(req, 'err', 'The start date does not look right.'); return res.redirect(back); }
  if (req.body.remove === '1') {
    db.prepare('DELETE FROM welcomes WHERE user_id = ?').run(target.id);
    flash(req, 'ok', 'Welcome announcement taken down.');
    return res.redirect(back);
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET job_title = COALESCE(?, job_title), started_on = COALESCE(?, started_on) WHERE id = ?').run(job || null, started || null, target.id);
    if (job) require('../team').ensureTitle(job, target.department);
    db.prepare(`INSERT INTO welcomes (user_id, intro, created_by, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET intro = excluded.intro`).run(target.id, clean(req.body.intro, 600) || null, req.user.id, new Date().toISOString());
  })();
  activity.log(req.user, 'New hire announced', target.display_name);
  flash(req, 'ok', `${target.display_name} is announced on everyone's home page for the next ${WELCOME_DAYS} days.`);
  res.redirect(back);
});

// Say hello to a new person, with an optional short message. Once each; sending again changes the message.
router.post('/welcome/:id/wave', requireLogin, (req, res) => {
  const w = isId(req.params.id) ? db.prepare('SELECT w.*, u.active FROM welcomes w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(req.params.id) : null;
  if (!w || !w.active) return notFound(res);
  if (w.user_id !== req.user.id) {
    db.prepare(`INSERT INTO welcome_notes (welcome_id, user_id, message, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(welcome_id, user_id) DO UPDATE SET message = COALESCE(excluded.message, message)`)
      .run(w.id, req.user.id, clean(req.body.message, 200) || null, new Date().toISOString());
  }
  res.redirect(req.body.back === 'home' ? '/#welcome' : `/people/${w.user_id}#welcome`);
});

// ---- The daily question -----------------------------------------------------------

function dailyPage(req, res, extra = {}) {
  const today = daily.card(req.user.id);
  const past = db.prepare('SELECT * FROM daily_questions WHERE used_on IS NOT NULL AND used_on < ? ORDER BY used_on DESC LIMIT 10').all(daily.questionDay())
    .map((q) => ({ q, ...daily.results(q, req.user.id) }));
  const manage = access.can(req.user, 'daily.manage');
  res.status(extra.errors ? 400 : 200).render('daily', {
    title: 'Daily question', today, past, errors: [], values: {}, manage,
    mine: db.prepare("SELECT * FROM daily_questions WHERE suggested_by = ? AND source = 'suggested' ORDER BY id DESC LIMIT 10").all(req.user.id),
    pending: manage ? db.prepare("SELECT q.*, u.display_name AS by_name FROM daily_questions q LEFT JOIN users u ON u.id = q.suggested_by WHERE q.status = 'pending' ORDER BY q.id").all() : [],
    upcoming: manage ? db.prepare("SELECT * FROM daily_questions WHERE status = 'active' AND used_on IS NULL AND (scheduled_on IS NOT NULL OR source <> 'builtin') ORDER BY scheduled_on IS NULL, scheduled_on, id LIMIT 30").all() : [],
    waiting: manage ? db.prepare("SELECT COUNT(*) AS n FROM daily_questions WHERE status = 'active' AND used_on IS NULL").get().n : 0,
    ...extra,
  });
}
router.get('/daily', requireLogin, (req, res) => dailyPage(req, res));

router.post('/daily/answer', requireLogin, (req, res) => {
  const q = daily.forDay();
  const choice = Number(req.body.choice);
  if (q && String(req.body.question_id) === String(q.id) && Number.isInteger(choice) && choice >= 0 && choice < daily.optionsOf(q).length) {
    db.prepare(`INSERT INTO daily_answers (question_id, user_id, choice, answered_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(question_id, user_id) DO UPDATE SET choice = excluded.choice`).run(q.id, req.user.id, choice, new Date().toISOString());
  }
  res.redirect(req.body.back === 'home' ? '/#daily' : '/daily');
});

function readQuestion(body) {
  const values = { prompt: clean(body.prompt, 140), a: clean(body.a, 80), b: clean(body.b, 80), c: clean(body.c, 80), d: clean(body.d, 80), scheduled_on: clean(body.scheduled_on, 10) };
  const errors = [];
  if (!values.prompt) errors.push('Write the question.');
  if (!values.a || !values.b) errors.push('Give at least two choices.');
  if (!values.c && values.d) { values.c = values.d; values.d = ''; }
  return { values, errors };
}

// Anyone can suggest one. It waits for someone who runs the daily question to approve it.
router.post('/daily/suggest', requireLogin, (req, res) => {
  const { values, errors } = readQuestion(req.body);
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM daily_questions WHERE suggested_by = ? AND status = 'pending'").get(req.user.id).n;
  if (waiting >= 10) errors.push('You already have 10 suggestions waiting. Give them a chance first.');
  if (errors.length) return dailyPage(req, res, { errors, values });
  db.prepare("INSERT INTO daily_questions (prompt, a, b, c, d, source, status, suggested_by, created_at) VALUES (?, ?, ?, ?, ?, 'suggested', 'pending', ?, ?)")
    .run(values.prompt, values.a, values.b, values.c || null, values.d || null, req.user.id, new Date().toISOString());
  flash(req, 'ok', 'Thanks. Your question is waiting to be approved.');
  res.redirect('/daily#suggest');
});

const run = requirePerm('daily.manage');

router.post('/admin/daily', run, (req, res) => {
  const { values, errors } = readQuestion(req.body);
  if (values.scheduled_on && (!isYmd(values.scheduled_on) || values.scheduled_on < localDate())) errors.push('Choose today or a later day.');
  else if (values.scheduled_on && db.prepare('SELECT 1 FROM daily_questions WHERE scheduled_on = ? OR used_on = ?').get(values.scheduled_on, values.scheduled_on)) errors.push('That day already has a question.');
  if (errors.length) return dailyPage(req, res, { errors, values, adding: true });
  db.prepare("INSERT INTO daily_questions (prompt, a, b, c, d, source, status, suggested_by, scheduled_on, created_at) VALUES (?, ?, ?, ?, ?, 'custom', 'active', ?, ?, ?)")
    .run(values.prompt, values.a, values.b, values.c || null, values.d || null, req.user.id, values.scheduled_on || null, new Date().toISOString());
  flash(req, 'ok', values.scheduled_on ? 'Question added for that day.' : 'Question added. It will come up soon.');
  res.redirect('/daily#manage');
});

router.post('/admin/daily/:id/:op', run, (req, res) => {
  const q = isId(req.params.id) ? db.prepare('SELECT * FROM daily_questions WHERE id = ?').get(req.params.id) : null;
  if (q && req.params.op === 'approve' && q.status === 'pending') {
    db.prepare("UPDATE daily_questions SET status = 'active' WHERE id = ?").run(q.id);
    flash(req, 'ok', 'Approved. It will come up soon.');
  } else if (q && req.params.op === 'reject' && q.status === 'pending') {
    db.prepare("UPDATE daily_questions SET status = 'rejected' WHERE id = ?").run(q.id);
    flash(req, 'ok', 'Suggestion declined.');
  } else if (q && req.params.op === 'delete' && !q.used_on) {
    db.prepare('DELETE FROM daily_questions WHERE id = ?').run(q.id);
    flash(req, 'ok', 'Question removed.');
  }
  res.redirect('/daily#manage');
});

module.exports = router;
module.exports.recentWelcomes = recentWelcomes;
module.exports.branches = branches;
