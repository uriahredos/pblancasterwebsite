'use strict';
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const config = require('../config');
const backup = require('../backup');
const { requirePerm, flash } = require('../auth');
const { localDate } = require('../util');
const activity = require('../activity');

const router = express.Router();

// A backup holds the whole database, complaints included, so it has its own permission.
const requireBackupAccess = requirePerm('backups');

router.get('/admin/backups', requireBackupAccess, (req, res) => {
  res.render('admin_backups', {
    title: 'Backups', backups: backup.listBackups(), keep: config.backupKeep,
    emailTo: config.backupEmailTo, hour: config.backupHour,
  });
});

router.post('/admin/backups/run', requireBackupAccess, async (req, res, next) => {
  try {
    const name = await backup.runBackup({ manual: true });
    activity.log(req.user, 'Backup made', name);
    flash(req, 'ok', `Backup ${name} created.`);
    res.redirect('/admin/backups');
  } catch (e) { next(e); }
});

router.get('/admin/backups/photos.tar.gz', requireBackupAccess, (req, res) => {
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="portal-photos-${localDate()}.tar.gz"`);
  const tar = spawn('tar', ['-czf', '-', '-C', config.dataDir, 'uploads']);
  tar.stdout.pipe(res);
  tar.on('error', () => res.destroy());
});

router.get('/admin/backups/:name', requireBackupAccess, (req, res) => {
  if (!backup.NAME.test(req.params.name)) return res.status(404).render('error', { title: 'Page not found', message: 'No such backup.' });
  activity.log(req.user, 'Backup downloaded', req.params.name);
  res.download(path.join(backup.backupDir, req.params.name), req.params.name, (err) => {
    if (err && !res.headersSent) res.status(404).render('error', { title: 'Page not found', message: 'No such backup.' });
  });
});

module.exports = router;
