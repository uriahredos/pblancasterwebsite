'use strict';
// Social: a feed for the whole company. Anyone can post a few words, photos or both; anyone can react and comment.
// A post's photos are kept where the photo wall kept its pictures (wall_photos), each tied to its post.
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const uploads = require('../uploads');
const activity = require('../activity');
const push = require('../push');
const reactions = require('../reactions');
const { requireLogin, requirePerm, verifyCsrf, forbidden, flash } = require('../auth');
const { clean } = require('../util');

const router = express.Router();
const isId = (v) => /^\d+$/.test(String(v || ''));
const notFound = (res) => res.status(404).render('error', { title: 'Page not found', message: 'That post is no longer here.' });

db.exec(`
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS social_comments_post ON social_comments(post_id);
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('wall_photos') WHERE name = 'post_id'").get()) db.exec('ALTER TABLE wall_photos ADD COLUMN post_id INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS wall_photos_post ON wall_photos(post_id)');
if (!db.prepare("SELECT 1 FROM pragma_table_info('social_posts') WHERE name = 'edited_at'").get()) db.exec('ALTER TABLE social_posts ADD COLUMN edited_at TEXT');

// Once: every picture on the old photo wall becomes a post here. Pictures put up together (same person, same caption,
// same moment) become one post, and the likes they had are carried over.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'social_from_wall_1'").get()) {
  db.transaction(() => {
    const posts = new Map();
    for (const p of db.prepare('SELECT * FROM wall_photos WHERE post_id IS NULL ORDER BY id').all()) {
      const key = `${p.user_id}|${p.caption || ''}|${String(p.created_at).slice(0, 19)}`;
      if (!posts.has(key)) posts.set(key, db.prepare('INSERT INTO social_posts (user_id, body, created_at) VALUES (?, ?, ?)').run(p.user_id, p.caption || null, p.created_at).lastInsertRowid);
      const post = posts.get(key);
      db.prepare('UPDATE wall_photos SET post_id = ? WHERE id = ?').run(post, p.id);
      for (const l of db.prepare('SELECT user_id FROM wall_likes WHERE photo_id = ?').all(p.id)) {
        db.prepare("INSERT OR IGNORE INTO reactions (kind, target_id, user_id, emoji, created_at) VALUES ('social', ?, ?, 'like', ?)").run(post, l.user_id, p.created_at);
      }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('social_from_wall_1', ?)").run(new Date().toISOString());
  })();
}

const PER_PAGE = 20;
const POSTS = `SELECT p.*, u.display_name, u.photo_path, b.name AS branch,
    (SELECT COUNT(*) FROM social_comments c JOIN users x ON x.id = c.user_id WHERE c.post_id = p.id) AS comment_count
  FROM social_posts p JOIN users u ON u.id = p.user_id LEFT JOIN branches b ON b.id = u.branch_id`;

/** Each post with its photos, its reactions and its comments (the newest few, or all of them). */
function dress(posts, user, everyComment) {
  for (const p of posts) {
    p.photos = db.prepare('SELECT id FROM wall_photos WHERE post_id = ? ORDER BY id').all(p.id);
    const all = db.prepare(
      `SELECT c.*, u.display_name, u.photo_path FROM social_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id`).all(p.id);
    p.comments = everyComment ? all : all.slice(-3);
    p.hidden = all.length - p.comments.length;
    p.mine = p.user_id === user.id; p.mayRemove = p.mine || access.moderates(user, 'forum.moderate', p.user_id);
    for (const c of p.comments) c.mayRemove = c.user_id === user.id || p.mine || access.moderates(user, 'forum.moderate', c.user_id);
  }
  // Which day each post belongs under, in the site's own time: Today, Yesterday, or the date.
  const { localDate, fmtDate } = require('../util'); const today = localDate();
  const before = new Date(`${today}T12:00:00Z`); before.setUTCDate(before.getUTCDate() - 1); const yesterday = before.toISOString().slice(0, 10);
  for (const p of posts) { const d = localDate(new Date(p.created_at)); p.day = d === today ? 'Today' : d === yesterday ? 'Yesterday' : fmtDate(d); }
  return reactions.attach('social', posts, user.id);
}

function feedPage(req, res, extra = {}) {
  const page = Math.min(100000, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  const rows = db.prepare(`${POSTS} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(PER_PAGE + 1, (page - 1) * PER_PAGE);
  res.status(extra.errors ? 400 : 200).render('social', {
    title: 'Social', posts: dress(rows.slice(0, PER_PAGE), req.user), page, more: rows.length > PER_PAGE, one: false,
    canPost: access.can(req.user, 'forum.use'), errors: [], values: {}, ...extra,
  });
}
router.get('/social', requireLogin, (req, res) => feedPage(req, res));
router.get('/photos', requireLogin, (req, res) => res.redirect('/social'));     // where the photo wall used to be

// One post by itself, with every comment.
router.get('/social/p/:id', requireLogin, (req, res) => {
  const p = isId(req.params.id) ? db.prepare(`${POSTS} WHERE p.id = ?`).get(req.params.id) : null;
  if (!p) return notFound(res);
  res.render('social', { title: 'Social', posts: dress([p], req.user, true), page: 1, more: false, one: true, canPost: access.can(req.user, 'forum.use'), errors: [], values: {} });
});

// A new post: words, up to six photos, or both. (The old photo wall's address still works for it.)
function create(req, res) {
  const files = req.files || [];
  const drop = () => files.forEach((f) => uploads.remove(f.filename));
  const body = clean(req.body.body !== undefined ? req.body.body : req.body.caption, 2000);
  const errors = [];
  if (req.photoError) errors.push(req.photoError);
  else if (files.some((f) => !uploads.looksLikeImage(f.path))) errors.push('Photos must be JPEG, PNG, WebP or GIF images.');
  else if (!body && !files.length) errors.push('Write something, add a photo, or both.');
  if (errors.length) { drop(); return feedPage(req, res, { errors, values: { body } }); }
  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const post = db.prepare('INSERT INTO social_posts (user_id, body, created_at) VALUES (?, ?, ?)').run(req.user.id, body || null, now).lastInsertRowid;
    const add = db.prepare('INSERT INTO wall_photos (user_id, path, caption, created_at, post_id) VALUES (?, ?, ?, ?, ?)');
    for (const f of files) add.run(req.user.id, f.filename, body ? body.slice(0, 200) : null, now, post);
    return post;
  })();
  flash(req, 'ok', 'Posted.');
  res.redirect(`/social#s${id}`);
}
const mayPost = requirePerm('forum.use');
router.post('/social', mayPost, uploads.photos('photos', 6), verifyCsrf, create);
router.post('/photos', mayPost, uploads.photos('photos', 6), verifyCsrf, create);

router.post('/social/:id/comment', mayPost, (req, res) => {
  const p = isId(req.params.id) ? db.prepare('SELECT p.*, u.display_name FROM social_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(req.params.id) : null;
  if (!p) return notFound(res);
  const body = clean(req.body.body, 1000);
  const back = req.body.back === 'post' ? `/social/p/${p.id}` : `/social${isId(req.body.page) && Number(req.body.page) > 1 ? '?page=' + Number(req.body.page) : ''}`;
  if (!body) { flash(req, 'err', 'Write a comment first.'); return res.redirect(`${back}#s${p.id}`); }
  db.prepare('INSERT INTO social_comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(p.id, req.user.id, body, new Date().toISOString());
  if (p.user_id !== req.user.id) push.notify([p.user_id], 'social_comment', { title: `${req.user.display_name} commented on your post`, body: body.slice(0, 140), url: `/social/p/${p.id}` });
  res.redirect(`${back}#s${p.id}`);
});

// Changing a post: only the person who wrote it. (A moderator can remove someone's post, but never reword it.)
const ownPost = (req) => {
  const p = isId(req.params.id) ? db.prepare('SELECT * FROM social_posts WHERE id = ?').get(req.params.id) : null;
  if (p) p.photos = db.prepare('SELECT id, path FROM wall_photos WHERE post_id = ? ORDER BY id').all(p.id);
  return p;
};
const editPage = (res, p, extra = {}) => res.status(extra.errors ? 400 : 200).render('social_edit', { title: 'Edit post', post: p, errors: [], values: { body: p.body || '' }, ...extra });
router.get('/social/p/:id/edit', mayPost, (req, res) => {
  const p = ownPost(req);
  if (!p) return notFound(res);
  if (p.user_id !== req.user.id) return forbidden(res);
  editPage(res, p);
});
router.post('/social/:id/edit', mayPost, (req, res) => {
  const p = ownPost(req);
  if (!p) return notFound(res);
  if (p.user_id !== req.user.id) return forbidden(res);
  const body = clean(req.body.body, 2000);
  const drop = new Set([].concat(req.body.drop || []).map(String));
  const going = p.photos.filter((ph) => drop.has(String(ph.id)));
  if (!body && going.length === p.photos.length) return editPage(res, p, { errors: ['A post needs some words or a photo. To take it down altogether, use Delete.'], values: { body } });
  db.transaction(() => {
    for (const ph of going) db.prepare('DELETE FROM wall_photos WHERE id = ? AND post_id = ?').run(ph.id, p.id);
    db.prepare('UPDATE social_posts SET body = ?, edited_at = ? WHERE id = ?').run(body || null, new Date().toISOString(), p.id);
  })();
  going.forEach((ph) => uploads.remove(ph.path));
  flash(req, 'ok', 'Post updated.');
  res.redirect(`/social/p/${p.id}`);
});

// Removing: your own post or comment; a comment under your own post; or, for a moderator, their own people's.
router.post('/social/:id/delete', requireLogin, (req, res) => {
  const p = isId(req.params.id) ? db.prepare('SELECT p.*, u.display_name FROM social_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(req.params.id) : null;
  if (!p) return res.redirect('/social');
  if (p.user_id !== req.user.id && !access.moderates(req.user, 'forum.moderate', p.user_id)) return forbidden(res);
  const photos = db.prepare('SELECT path FROM wall_photos WHERE post_id = ?').all(p.id);
  db.transaction(() => {
    db.prepare('DELETE FROM wall_photos WHERE post_id = ?').run(p.id);
    reactions.clear('social', p.id);
    db.prepare('DELETE FROM social_posts WHERE id = ?').run(p.id);            // its comments go with it
  })();
  photos.forEach((f) => uploads.remove(f.path));
  if (p.user_id !== req.user.id) activity.log(req.user, 'Social post removed', `one posted by ${p.display_name}`);
  flash(req, 'ok', 'Post removed.');
  res.redirect('/social');
});
router.post('/social/comment/:id/delete', requireLogin, (req, res) => {
  const c = isId(req.params.id) ? db.prepare(
    'SELECT c.*, p.user_id AS post_owner, u.display_name FROM social_comments c JOIN social_posts p ON p.id = c.post_id JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(req.params.id) : null;
  if (!c) return res.redirect('/social');
  if (c.user_id !== req.user.id && c.post_owner !== req.user.id && !access.moderates(req.user, 'forum.moderate', c.user_id)) return forbidden(res);
  db.prepare('DELETE FROM social_comments WHERE id = ?').run(c.id);
  if (c.user_id !== req.user.id && c.post_owner !== req.user.id) activity.log(req.user, 'Social comment removed', `one written by ${c.display_name}`);
  res.redirect(`/social/p/${c.post_id}`);
});

module.exports = router;
