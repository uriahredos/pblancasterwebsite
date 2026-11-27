'use strict';
const express = require('express');
const access = require('../permissions');
const live = require('../live');

const router = express.Router();

// The stream for pages that stay current by themselves. It never answers with a redirect (a page cannot follow one):
// anyone who is signed out or locked simply gets 401, and the page falls back to asking now and then.
router.get('/live/stream', (req, res) => {
  if (!req.user || res.locals.locked || req.user.must_change_password) return res.status(401).end();
  const topics = live.parseTopics(req.query.topics);
  if (!topics) return res.status(400).end();
  if (!access.can(req.user, 'forum.use')) return res.status(403).end();
  // Listening is not the person doing something: it writes nothing to their session, so it cannot hold off the lock.
  Object.defineProperty(req.session, 'leaveAlone', { value: true });
  live.attach(req, res, topics);
});

module.exports = router;
