'use strict';
// Help: short how-to guides, each shown only to people who can do the job it describes.
const express = require('express');
const help = require('../help');
const { requireLogin } = require('../auth');

const router = express.Router();

router.get('/help', requireLogin, (req, res) => {
  const mine = help.forUser(req.user);
  const groups = help.GROUPS.map((name) => ({ name, guides: mine.filter((g) => g.group === name) })).filter((g) => g.guides.length);
  res.render('help', { title: 'Help', groups, words: help.words });
});

router.get('/help/:slug', requireLogin, (req, res) => {
  const g = help.get(req.user, req.params.slug);
  if (!g) return res.status(404).render('error', { title: 'Page not found', message: 'That guide is not here. Look through Help for the one you need.' });
  const related = (g.related || []).map((s) => help.get(req.user, s)).filter(Boolean);
  // "Back" goes to where the person came from when that was a page of this site; otherwise to the list of guides.
  const from = String(req.query.from || '');
  const back = /^\/(?!\/)[\w\-./]*$/.test(from) && !from.startsWith('/help') ? from : '';
  res.render('help_guide', { title: g.title, guide: g, related, rich: help.rich, back });
});

module.exports = router;
