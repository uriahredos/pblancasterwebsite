'use strict';
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const access = require('../permissions');
const activity = require('../activity');
const { clean, isYmd, labels } = require('../util');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single('file');
const { requirePerm, verifyCsrf, forbidden, flash } = auth;

// Bringing in history creates accounts, so it is for people who manage everyone.
function guard(req, res, next) {
  requirePerm('users.manage')(req, res, () => (req.user.scope === 'all' ? next() : forbidden(res)));
}
// The Forms history belongs to the first branch and makes accounts, so it is for people who can see every branch.
const everyBranch = (req, res, next) => guard(req, res, () => (req.user.allBranches ? next() : forbidden(res)));

const counts = () => ({
  parts: db.prepare("SELECT COUNT(*) AS n FROM parts_submissions WHERE import_ref IS NOT NULL").get().n,
  training: db.prepare("SELECT COUNT(*) AS n FROM training_requests WHERE import_ref IS NOT NULL").get().n,
});

router.get('/admin/import', guard, (req, res) => {
  const result = req.session.importResult || null;
  delete req.session.importResult;
  const contacts = req.session.contactResult || null;
  delete req.session.contactResult;
  res.render('admin_import', { title: 'Import', counts: counts(), result, contacts });
});

const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(s) && !Number.isNaN(Date.parse(s));
const isRef = (s) => typeof s === 'string' && /^[a-z0-9-]{3,60}$/.test(s);

/** Find the account for a person in the file, or make a disabled one to hold their history. */
function resolvePeople(people, result) {
  const map = new Map();
  const technician = access.profileByName('Technician') || db.prepare('SELECT * FROM profiles ORDER BY id LIMIT 1').get();
  for (const p of people) {
    const name = clean(p.name, 80);
    const email = clean(p.email, 120).toLowerCase();
    if (!p.key || !name) continue;
    let user = (email && db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) ||
      db.prepare('SELECT id FROM users WHERE display_name = ? COLLATE NOCASE').get(name);
    if (user) result.matched.push(name);
    else {
      let username = (clean(p.username, 40).toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'person').padEnd(3, 'x');
      for (let i = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); i++) username = `${username.replace(/\d+$/, '')}${i}`;
      // A random password nobody knows: the account cannot be used until an admin enables it and resets the password.
      const id = auth.createUser({ username, displayName: name, email, password: crypto.randomBytes(24).toString('hex'), profile: technician.id });
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
      user = { id };
      result.created.push(name);
    }
    map.set(p.key, user.id);
  }
  return map;
}

router.post('/admin/import', everyBranch, (req, res, next) => upload(req, res, (err) => {
  req.body = req.body || {}; req.uploadFailed = Boolean(err); next();
}), verifyCsrf, (req, res) => {
  const fail = (msg) => { flash(req, 'err', msg); res.redirect('/admin/import'); };
  if (req.uploadFailed || !req.file) return fail('Choose the import file (up to 10 MB).');
  let data;
  try { data = JSON.parse(req.file.buffer.toString('utf8')); } catch (e) { return fail('That file could not be read. Use the import file that was prepared for this site.'); }
  if (!data || data.format !== 'pb-portal-import-1' || !Array.isArray(data.people) || !Array.isArray(data.parts) || !Array.isArray(data.training)) {
    return fail('That is not an import file for this site.');
  }
  const closeRequests = req.body.close_requests === '1';
  const result = { created: [], matched: [], parts: 0, training: 0, already: 0, skipped: 0 };

  db.transaction(() => {
    const people = resolvePeople(data.people, result);
    const hasPart = db.prepare('SELECT 1 FROM parts_submissions WHERE import_ref = ?');
    const addPart = db.prepare(
      `INSERT INTO parts_submissions (user_id, action, source, job_number, note, needed_by, status, admin_note, truck, created_at, created_local_date, import_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addItem = db.prepare('INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, ?, ?)');
    for (const e of data.parts) {
      const userId = people.get(e.person);
      const items = (Array.isArray(e.items) ? e.items : [])
        .map((i) => ({ part_name: clean(i.part_name, 200), quantity: Number(i.quantity) }))
        .filter((i) => i.part_name && Number.isInteger(i.quantity) && i.quantity >= 1 && i.quantity <= 99999);
      if (!userId || !isRef(e.ref) || !labels.action[e.action] || !['van', 'job'].includes(e.source) || !isIso(e.created_at) || !isYmd(e.local_date) || !items.length) { result.skipped++; continue; }
      if (hasPart.get(e.ref)) { result.already++; continue; }
      const isRequest = e.action === 'request';
      const info = addPart.run(userId, e.action, e.source, e.source === 'job' ? clean(e.job_number, 60) || null : null, clean(e.note, 1000) || null,
        isRequest && isYmd(e.needed_by) ? e.needed_by : null,
        isRequest ? (closeRequests ? 'fulfilled' : 'new') : null,
        isRequest && closeRequests ? 'Imported from the old form, which did not record whether this was filled.' : null,
        clean(e.truck, 20) || null, e.created_at, e.local_date, e.ref);
      for (const i of items) addItem.run(info.lastInsertRowid, i.part_name, i.quantity);
      result.parts++;
    }
    const hasTraining = db.prepare('SELECT 1 FROM training_requests WHERE import_ref = ?');
    const addTraining = db.prepare(
      `INSERT INTO training_requests (user_id, description, wants_contact, is_private, created_at, created_local_date, import_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const t of data.training) {
      const userId = people.get(t.person);
      const description = clean(t.description, 4000);
      if (!userId || !isRef(t.ref) || !description || !isIso(t.created_at) || !isYmd(t.local_date)) { result.skipped++; continue; }
      if (hasTraining.get(t.ref)) { result.already++; continue; }
      addTraining.run(userId, description, t.wants_contact ? 1 : 0, t.is_private ? 1 : 0, t.created_at, t.local_date, t.ref);
      result.training++;
    }
  })();

  activity.log(req.user, 'Old data imported',
    `${result.parts} parts entries, ${result.training} training requests, ${result.created.length} accounts created (disabled)`);
  req.session.importResult = result;
  res.redirect('/admin/import');
});

// Take the imported entries back out (for example to import a corrected file). Accounts are left alone.
router.post('/admin/import/undo', requirePerm('records.delete'), (req, res) => {
  if (req.user.scope !== 'all' || !req.user.allBranches) return forbidden(res);
  const before = counts();
  db.transaction(() => {
    db.prepare("DELETE FROM change_log WHERE kind = 'parts' AND record_id IN (SELECT id FROM parts_submissions WHERE import_ref IS NOT NULL)").run();
    db.prepare("DELETE FROM change_log WHERE kind = 'training' AND record_id IN (SELECT id FROM training_requests WHERE import_ref IS NOT NULL)").run();
    db.prepare('UPDATE training_sessions SET request_id = NULL WHERE request_id IN (SELECT id FROM training_requests WHERE import_ref IS NOT NULL)').run();
    db.prepare('DELETE FROM parts_submissions WHERE import_ref IS NOT NULL').run();
    db.prepare('DELETE FROM training_requests WHERE import_ref IS NOT NULL').run();
  })();
  activity.log(req.user, 'Imported data removed', `${before.parts} parts entries, ${before.training} training requests`);
  flash(req, 'ok', `Removed ${before.parts} imported parts entries and ${before.training} imported training requests. The accounts were left as they are.`);
  res.redirect('/admin/import');
});

module.exports = router;
