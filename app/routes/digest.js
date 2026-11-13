'use strict';
const express = require('express');
const digest = require('../digest');
const mail = require('../mail');
const access = require('../permissions');
const { requirePerm } = require('../auth');

const router = express.Router();

// The same summary the Monday email carries, viewable any time.
router.get('/admin/weekly', requirePerm('parts.view'), (req, res) => {
  res.render('admin_weekly', {
    title: 'Weekly summary', data: digest.build(req.user),
    emailed: access.can(req.user, 'digest.weekly'), hasEmail: Boolean(req.user.email), mailOn: mail.isConfigured(),
  });
});

module.exports = router;
