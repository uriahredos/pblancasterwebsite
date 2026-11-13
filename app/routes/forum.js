'use strict';
const path = require('path');
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const uploads = require('../uploads');
const { requirePerm, verifyCsrf, flash } = require('../auth');
const { clean } = require('../util');

const router = express.Router();
const use = requirePerm('forum.use');
const MAX_PHOTOS = 4;
const PER_PAGE = 30;
const isId = (v) => /^\d+$/.test(String(v));
const isMod = (user) => access.can(user, 'forum.moderate');
const notFound = (res) => res.status(404).render('error', { title: 'Page not found', message: 'That discussion is not here. It may have been removed.' });

const sections = () => db.prepare(
  `SELECT s.*, (SELECT COUNT(*) FROM forum_threads t WHERE t.section_id = s.id) AS threads,
          (SELECT MAX(last_post_at) FROM forum_threads t WHERE t.section_id = s.id) AS last_post_at
   FROM forum_sections s ORDER BY s.sort_order, s.id`).all();

// A thread row for lists, with whether this person has something new to read in it.
const THREAD_LIST = `
  SELECT t.*, s.name AS section, s.kind, u.display_name AS author, lu.display_name AS last_author, r.following,
         (t.last_post_user_id <> @me AND (r.last_read_at IS NULL OR t.last_post_at > r.last_read_at)) AS unread
  FROM forum_threads t
  JOIN forum_sections s ON s.id = t.section_id
  JOIN users u ON u.id = t.user_id
  JOIN users lu ON lu.id = t.last_post_user_id
  LEFT JOIN forum_reads r ON r.thread_id = t.id AND r.user_id = @me`;

/** The newest activity across every section. */
function recent(userId, limit) {
  return db.prepare(`${THREAD_LIST} ORDER BY t.last_post_at DESC LIMIT @limit`).all({ me: userId, limit });
}

/** Threads this person follows where someone else has posted since they last looked. */
function repliesFor(userId) {
  return db.prepare(
    `${THREAD_LIST} WHERE r.following = 1 AND t.last_post_user_id <> @me AND (r.last_read_at IS NULL OR t.last_post_at > r.last_read_at)
     ORDER BY t.last_post_at DESC LIMIT 10`).all({ me: userId });
}

function loadThread(id) {
  return isId(id) ? db.prepare(
    `SELECT t.*, s.name AS section, s.kind, u.display_name AS author FROM forum_threads t
     JOIN forum_sections s ON s.id = t.section_id JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(id) : null;
}

/** Record that this person has read the thread up to now; optionally start following it. */
function markRead(threadId, userId, follow) {
  db.prepare(
    `INSERT INTO forum_reads (thread_id, user_id, last_read_at, following) VALUES (@t, @u, @now, @f)
     ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = @now${follow ? ', following = 1' : ''}`)
    .run({ t: threadId, u: userId, now: new Date().toISOString(), f: follow ? 1 : 0 });
}

/** Check uploaded photos; on any problem remove them all and return the message. */
function photoProblem(req) {
  let problem = req.photoError || null;
  if (!problem && req.files.some((f) => !uploads.looksLikeImage(f.path))) problem = 'Photos must be JPEG, PNG, WebP or GIF images.';
  return problem;
}
const dropFiles = (req) => req.files.forEach((f) => uploads.remove(f.filename));

function addPost(threadId, userId, body, files, now) {
  const postId = db.prepare('INSERT INTO forum_posts (thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(threadId, userId, body, now).lastInsertRowid;
  const photo = db.prepare('INSERT INTO forum_photos (post_id, path) VALUES (?, ?)');
  for (const f of files) photo.run(postId, f.filename);
  return postId;
}

function removePhotosOf(where, arg) {
  db.prepare(`SELECT ph.path FROM forum_photos ph JOIN forum_posts p ON p.id = ph.post_id WHERE ${where}`).all(arg).forEach((r) => uploads.remove(r.path));
}

// ---- Reading ---------------------------------------------------------------

router.get('/discussions', use, (req, res) => {
  const q = clean(req.query.q, 80);
  let results = null;
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    results = db.prepare(
      `${THREAD_LIST} WHERE t.title LIKE @like ESCAPE '\\' OR EXISTS (SELECT 1 FROM forum_posts p WHERE p.thread_id = t.id AND p.body LIKE @like ESCAPE '\\')
       ORDER BY t.last_post_at DESC LIMIT 50`).all({ me: req.user.id, like });
  }
  res.render('forum', { title: 'Discussions', sections: sections(), threads: results || recent(req.user.id, 15), q, searching: Boolean(q), wide: true });
});

router.get('/discussions/s/:id', use, (req, res) => {
  const section = isId(req.params.id) ? db.prepare('SELECT * FROM forum_sections WHERE id = ?').get(req.params.id) : null;
  if (!section) return notFound(res);
  const total = db.prepare('SELECT COUNT(*) AS n FROM forum_threads WHERE section_id = ?').get(section.id).n;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const threads = db.prepare(`${THREAD_LIST} WHERE t.section_id = @s ORDER BY t.is_pinned DESC, t.last_post_at DESC LIMIT @n OFFSET @o`)
    .all({ me: req.user.id, s: section.id, n: PER_PAGE, o: (page - 1) * PER_PAGE });
  res.render('forum_section', { title: section.name, section, threads, page, pages, wide: true });
});

function newForm(req, res, extra = {}) {
  res.status(extra.errors ? 400 : 200).render('forum_new', {
    title: 'Start a thread', sections: sections(), values: { section_id: isId(req.query.section) ? Number(req.query.section) : null }, errors: [], maxPhotos: MAX_PHOTOS, ...extra,
  });
}

router.get('/discussions/new', use, (req, res) => newForm(req, res));

router.post('/discussions/new', use, uploads.photos('photos', MAX_PHOTOS), verifyCsrf, (req, res) => {
  const values = { section_id: isId(req.body.section_id) ? Number(req.body.section_id) : null, title: clean(req.body.title, 140), body: clean(req.body.body, 6000) };
  const errors = [];
  const section = values.section_id ? db.prepare('SELECT * FROM forum_sections WHERE id = ?').get(values.section_id) : null;
  if (!section) errors.push('Choose a section.');
  if (!values.title) errors.push('Give the thread a title.');
  if (!values.body) errors.push('Write your message.');
  const problem = photoProblem(req);
  if (problem) errors.push(problem);
  if (errors.length) { dropFiles(req); return newForm(req, res, { errors, values }); }

  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const threadId = db.prepare(
      `INSERT INTO forum_threads (section_id, user_id, title, created_at, last_post_at, last_post_user_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(section.id, req.user.id, values.title, now, now, req.user.id).lastInsertRowid;
    addPost(threadId, req.user.id, values.body, req.files, now);
    markRead(threadId, req.user.id, true);
    return threadId;
  })();
  res.redirect(`/discussions/t/${id}`);
});

function threadPage(req, res, t, extra = {}) {
  const posts = db.prepare(
    `SELECT p.*, u.display_name AS author FROM forum_posts p JOIN users u ON u.id = p.user_id WHERE p.thread_id = ? ORDER BY p.id LIMIT 1000`).all(t.id);
  const photos = db.prepare(
    `SELECT ph.id, ph.post_id FROM forum_photos ph JOIN forum_posts p ON p.id = ph.post_id WHERE p.thread_id = ? ORDER BY ph.id`).all(t.id);
  for (const p of posts) p.photos = photos.filter((ph) => ph.post_id === p.id);
  const mine = db.prepare('SELECT last_read_at, following FROM forum_reads WHERE thread_id = ? AND user_id = ?').get(t.id, req.user.id);
  // Replies that arrived since this person last opened the thread get a "New" label.
  const since = mine && mine.last_read_at;
  posts.forEach((p, i) => { p.first = i === 0; p.isNew = Boolean(since) && p.created_at > since && p.user_id !== req.user.id; });
  markRead(t.id, req.user.id, false);
  // Opening the thread clears it from the "new replies" count shown in the menu on this very page.
  if (mine && mine.following && t.last_post_user_id !== req.user.id && (!since || t.last_post_at > since)) res.locals.badges.forum = Math.max(0, res.locals.badges.forum - 1);
  res.status(extra.errors ? 400 : 200).render('forum_thread', {
    title: t.title, t, posts, following: Boolean(mine && mine.following), mod: isMod(req.user), owner: t.user_id === req.user.id,
    sections: isMod(req.user) ? sections() : [], errors: [], values: {}, maxPhotos: MAX_PHOTOS, ...extra,
  });
}

router.get('/discussions/t/:id', use, (req, res) => {
  const t = loadThread(req.params.id);
  if (!t) return notFound(res);
  threadPage(req, res, t);
});

router.get('/discussions/photo/:id', use, (req, res) => {
  const row = isId(req.params.id) ? db.prepare('SELECT path FROM forum_photos WHERE id = ?').get(req.params.id) : null;
  if (!row) return notFound(res);
  res.sendFile(path.basename(row.path), { root: uploads.uploadDir, headers: { 'Cache-Control': 'private, max-age=86400' } },
    (err) => { if (err && !res.headersSent) notFound(res); });
});

// ---- Replying and following ---------------------------------------------------

router.post('/discussions/t/:id/reply', use, uploads.photos('photos', MAX_PHOTOS), verifyCsrf, (req, res) => {
  const t = loadThread(req.params.id);
  if (!t) { dropFiles(req); return notFound(res); }
  const body = clean(req.body.body, 6000);
  const errors = [];
  if (t.is_locked) errors.push('This thread is locked, so it cannot take new replies.');
  else if (!body) errors.push('Write your reply.');
  const problem = photoProblem(req);
  if (problem) errors.push(problem);
  if (errors.length) { dropFiles(req); return threadPage(req, res, t, { errors, values: { body } }); }

  const now = new Date().toISOString();
  const postId = db.transaction(() => {
    const id = addPost(t.id, req.user.id, body, req.files, now);
    db.prepare('UPDATE forum_threads SET reply_count = reply_count + 1, last_post_at = ?, last_post_user_id = ? WHERE id = ?').run(now, req.user.id, t.id);
    markRead(t.id, req.user.id, true);                                  // whoever replies hears about later replies
    return id;
  })();
  res.redirect(`/discussions/t/${t.id}#p${postId}`);
});

router.post('/discussions/t/:id/follow', use, (req, res) => {
  const t = loadThread(req.params.id);
  if (!t) return notFound(res);
  const on = req.body.follow === '1' ? 1 : 0;
  db.prepare(
    `INSERT INTO forum_reads (thread_id, user_id, last_read_at, following) VALUES (@t, @u, @now, @on)
     ON CONFLICT (thread_id, user_id) DO UPDATE SET following = @on`).run({ t: t.id, u: req.user.id, now: new Date().toISOString(), on });
  flash(req, 'ok', on ? 'You will see new replies to this thread on your home page.' : 'You will no longer be told about replies to this thread.');
  res.redirect(`/discussions/t/${t.id}`);
});

// The person who asked, or a moderator, marks a support thread solved (or not solved after all).
router.post('/discussions/t/:id/solved', use, (req, res) => {
  const t = loadThread(req.params.id);
  if (!t) return notFound(res);
  if (t.kind !== 'support' || (t.user_id !== req.user.id && !isMod(req.user))) return res.status(403).render('error', { title: 'Not allowed', message: 'Only the person who asked can mark this solved.' });
  db.prepare('UPDATE forum_threads SET solved_at = ? WHERE id = ?').run(t.solved_at ? null : new Date().toISOString(), t.id);
  res.redirect(`/discussions/t/${t.id}`);
});

// ---- Moderating --------------------------------------------------------------

const moderate = requirePerm('forum.moderate');

router.post('/discussions/t/:id/lock', moderate, (req, res) => {
  const t = loadThread(req.params.id);
  if (!t) return notFound(res);
  db.prepare('UPDATE forum_threads SET is_locked = ? WHERE id = ?').run(t.is_locked ? 0 : 1, t.id);
  activity.log(req.user, t.is_locked ? 'Discussion unlocked' : 'Discussion locked', t.title);
  res.redirect(`/discussions/t/${t.id}`);
});

router.post('/discussions/t/:id/pin', moderate, (req, res) => {
  const t = loadThread(req.params.id);
  if (!t) return notFound(res);
  db.prepare('UPDATE forum_threads SET is_pinned = ? WHERE id = ?').run(t.is_pinned ? 0 : 1, t.id);
  activity.log(req.user, t.is_pinned ? 'Discussion unpinned' : 'Discussion pinned', t.title);
  res.redirect(`/discussions/t/${t.id}`);
});

router.post('/discussions/t/:id/move', moderate, (req, res) => {
  const t = loadThread(req.params.id);
  const to = isId(req.body.section_id) ? db.prepare('SELECT * FROM forum_sections WHERE id = ?').get(req.body.section_id) : null;
  if (!t || !to) return notFound(res);
  if (to.id !== t.section_id) {
    db.prepare('UPDATE forum_threads SET section_id = ?, solved_at = CASE WHEN ? = \'support\' THEN solved_at ELSE NULL END WHERE id = ?').run(to.id, to.kind, t.id);
    activity.log(req.user, 'Discussion moved', `${t.title}: ${t.section} to ${to.name}`);
    flash(req, 'ok', `Moved to ${to.name}.`);
  }
  res.redirect(`/discussions/t/${t.id}`);
});

// A moderator can remove any thread; the person who started one can remove it while nobody has replied.
router.post('/discussions/t/:id/delete', use, (req, res) => {
  const t = loadThread(req.params.id);
  if (!t) return notFound(res);
  const own = t.user_id === req.user.id && t.reply_count === 0;
  if (!own && !isMod(req.user)) return res.status(403).render('error', { title: 'Not allowed', message: 'You cannot remove this thread.' });
  removePhotosOf('p.thread_id = ?', t.id);
  db.prepare('DELETE FROM forum_threads WHERE id = ?').run(t.id);
  activity.log(req.user, 'Discussion removed', `${t.title} (started by ${t.author})`);
  flash(req, 'ok', 'Thread removed.');
  res.redirect(`/discussions/s/${t.section_id}`);
});

// A reply can be removed by whoever wrote it, or by a moderator. The opening post goes with its thread.
router.post('/discussions/p/:id/delete', use, (req, res) => {
  const p = isId(req.params.id) ? db.prepare(
    `SELECT p.*, u.display_name AS author, (SELECT MIN(id) FROM forum_posts x WHERE x.thread_id = p.thread_id) AS first_id
     FROM forum_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`).get(req.params.id) : null;
  if (!p || p.id === p.first_id) return notFound(res);
  if (p.user_id !== req.user.id && !isMod(req.user)) return res.status(403).render('error', { title: 'Not allowed', message: 'You cannot remove this reply.' });
  const t = loadThread(p.thread_id);
  db.transaction(() => {
    removePhotosOf('p.id = ?', p.id);
    db.prepare('DELETE FROM forum_posts WHERE id = ?').run(p.id);
    const last = db.prepare('SELECT user_id, created_at FROM forum_posts WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(t.id);
    db.prepare('UPDATE forum_threads SET reply_count = (SELECT COUNT(*) - 1 FROM forum_posts WHERE thread_id = @t), last_post_at = @at, last_post_user_id = @u WHERE id = @t')
      .run({ t: t.id, at: last.created_at, u: last.user_id });
  })();
  if (p.user_id !== req.user.id) activity.log(req.user, 'Discussion reply removed', `${p.author}'s reply in "${t.title}"`);
  flash(req, 'ok', 'Reply removed.');
  res.redirect(`/discussions/t/${t.id}`);
});

module.exports = router;
module.exports.recent = recent;
module.exports.repliesFor = repliesFor;
