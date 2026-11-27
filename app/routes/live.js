'use strict';
const express = require('express');
const access = require('../permissions');
const live = require('../live');
const dm = require('../messages');

const router = express.Router();

// The stream for pages that stay current by themselves. It never answers with a redirect (a page cannot follow one):
// anyone who is signed out or locked simply gets 401, and the page falls back to asking now and then.
router.get('/live/stream', (req, res) => {
  if (!req.user || res.locals.locked || req.user.must_change_password) return res.status(401).end();
  const topics = live.parseTopics(req.query.topics);
  if (!topics) return res.status(400).end();
  // Each topic has its own rule: discussions need the discussions permission; a conversation, being one of its two people;
  // an inbox, being its owner.
  for (const t of topics) {
    const [kind, id] = t.split(':');
    const ok = kind === 'dm' ? access.can(req.user, 'messages.use') && Boolean(dm.forUser(id, req.user.id))
      : kind === 'inbox' ? access.can(req.user, 'messages.use') && Number(id) === req.user.id
      : access.can(req.user, 'forum.use');
    if (!ok) return res.status(403).end();
  }
  // Listening is not the person doing something: it writes nothing to their session, so it cannot hold off the lock.
  Object.defineProperty(req.session, 'leaveAlone', { value: true });
  live.attach(req, res, topics);
});

module.exports = router;
