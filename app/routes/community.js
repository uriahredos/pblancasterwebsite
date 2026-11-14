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

const branches = () => db.prepare('SELECT * FROM branches ORDER BY name COLLATE NOCASE').all();
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
const PERSON = `SELECT u.id, u.display_name, u.job_title, u.started_on, u.about, u.skills, u.photo_path, u.branch_id, b.name AS branch,
  CASE WHEN u.show_phone = 1 THEN u.phone END AS phone, CASE WHEN u.show_email = 1 THEN u.email END AS email
  FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.active = 1`;
const decorate = (p) => ({ ...p, skillList: skillList(p.skills), tenure: tenure(p.started_on) });

// ---- People -----------------------------------------------------------------

router.get('/people', requireLogin, (req, res) => {
  const q = clean(req.query.q, 60);
  const branch = isId(req.query.branch) ? Number(req.query.branch) : null;
  const where = []; const params = [];
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    where.push("(u.display_name LIKE ? ESCAPE '\\' OR u.job_title LIKE ? ESCAPE '\\' OR u.skills LIKE ? ESCAPE '\\' OR u.about LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  if (branch) { where.push('u.branch_id = ?'); params.push(branch); }
  const people = db.prepare(`${PERSON} ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY u.display_name COLLATE NOCASE LIMIT 500`).all(...params).map(decorate);
  res.render('people', { title: 'People', wide: true, people, q, branch, branches: branches(), total: db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n });
});

router.get('/people/photo/:id', requireLogin, (req, res) => {
  const row = isId(req.params.id) ? db.prepare('SELECT photo_path FROM users WHERE id = ? AND active = 1').get(req.params.id) : null;
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
  res.render('person', { title: p.display_name, p: decorate(p), certs, welcome, notes, me: p.id === req.user.id });
});

// ---- My own profile ------------------------------------------------------------

function profileForm(req, res, extra = {}) {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.status(extra.errors ? 400 : 200).render('profile_edit', { title: 'My profile', me, values: me, errors: [], ...extra });
}
router.get('/profile', requireLogin, (req, res) => profileForm(req, res));

router.post('/profile', requireLogin, uploads.photos('photo', 1), verifyCsrf, (req, res) => {
  const file = req.files[0] || null;
  const values = {
    job_title: clean(req.body.job_title, 80), started_on: clean(req.body.started_on, 10), about: clean(req.body.about, 1000),
    skills: skillList(clean(req.body.skills, 800)).map((s) => s.slice(0, 40)).slice(0, 25).join(', '),
    phone: clean(req.body.phone, 30), show_phone: req.body.show_phone === '1' ? 1 : 0, show_email: req.body.show_email === '1' ? 1 : 0,
  };
  const errors = [];
  if (values.started_on && (!isYmd(values.started_on) || values.started_on > localDate())) errors.push('The start date does not look right.');
  if (values.phone && !/^[0-9 ()+.x-]{7,30}$/.test(values.phone)) errors.push('The phone number does not look right.');
  if (req.photoError) errors.push(req.photoError);
  else if (file && !uploads.looksLikeImage(file.path)) errors.push('The photo must be a JPEG, PNG, WebP or GIF image.');
  else if (file && file.size > MAX_PHOTO) errors.push('That photo is too large. Choose a smaller one.');
  if (errors.length) { if (file) uploads.remove(file.filename); return profileForm(req, res, { errors, values: { ...values, photo_path: req.user.photo_path } }); }

  const old = req.user.photo_path;
  const photo = file ? file.filename : req.body.remove_photo === '1' ? null : old;
  db.prepare('UPDATE users SET job_title = ?, started_on = ?, about = ?, skills = ?, phone = ?, show_phone = ?, show_email = ?, photo_path = ? WHERE id = ?')
    .run(values.job_title || null, values.started_on || null, values.about || null, values.skills || null, values.phone || null, values.show_phone, values.show_email, photo, req.user.id);
  if (old && old !== photo) uploads.remove(old);
  flash(req, 'ok', 'Profile saved.');
  res.redirect(`/people/${req.user.id}`);
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
