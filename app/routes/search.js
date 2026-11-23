'use strict';
// Search: one box that finds pages, how-to guides, people, offices and parts.
const express = require('express');
const search = require('../search');
const { requireLogin } = require('../auth');
const { clean } = require('../util');

const router = express.Router();

router.get('/search', requireLogin, (req, res) => {
  const q = clean(req.query.q, 60);
  res.render('search', { title: 'Search', q, groups: search.find(req.user, q) });
});
// The same answer as data, for the list that fills in as someone types.
router.get('/search/suggest', requireLogin, (req, res) => res.json({ groups: search.find(req.user, clean(req.query.q, 60)) }));

module.exports = router;
