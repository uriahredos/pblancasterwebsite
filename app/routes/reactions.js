'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const reactions = require('../reactions');
const { requireLogin, forbidden } = require('../auth');

const router = express.Router();

// React to a discussion message or an announcement. Only things this person can already see.
router.post('/react', requireLogin, (req, res) => {
  const kind = String(req.body.kind || ''); const id = /^\d+$/.test(String(req.body.id || '')) ? Number(req.body.id) : 0;
  let back = '/';
  if (kind === 'post') {
    if (!access.can(req.user, 'forum.use')) return forbidden(res);
    const p = db.prepare('SELECT id, thread_id FROM forum_posts WHERE id = ?').get(id);
    if (!p) return res.redirect('/discussions');
    back = `/discussions/t/${p.thread_id}#p${p.id}`;
  } else if (kind === 'notice') {
    if (!require('./announcements').forUser(req.user.id).some((n) => n.id === id)) return forbidden(res);
    back = req.body.back === 'home' ? '/' : `/notices#n${id}`;
  } else if (kind === 'social') {
    if (!db.prepare('SELECT 1 FROM social_posts WHERE id = ?').get(id)) return res.redirect('/social');
    back = req.body.back === 'post' ? `/social/p/${id}` : `/social#s${id}`;
  } else return forbidden(res);
  reactions.toggle(kind, id, req.user.id, String(req.body.emoji || ''));
  res.redirect(back);
});

module.exports = router;
