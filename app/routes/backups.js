'use strict';
const fs = require('fs');
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
// ...and it holds every branch, so it is only for people who can see every branch.
const requireBackupAccess = require('../auth').requireEveryBranch('backups');

// A backup is the whole database. Taking a copy needs the password typed in the last few minutes, not just an open session.
const provedRecently = (req) => require('./auth').provedRecently(req);
const needPassword = (req, res, next) => (provedRecently(req) ? next() : (flash(req, 'err', 'Type your password to download.'), res.redirect('/admin/backups#confirm')));

router.get('/admin/backups', requireBackupAccess, (req, res) => {
  res.render('admin_backups', {
    proved: provedRecently(req), encrypted: Boolean(require('../db').encryption && require('../db').encryption.encrypted),
    title: 'Backups', backups: backup.listBackups().map((b) => ({ ...b, fault: backup.standing(b) })), keep: config.backupKeep, keepManual: backup.KEEP.manual,
    emailTo: config.backupEmailTo, hour: config.backupHour, failed: backup.report().failed,
    keyChanged: (require('../db').prepare("SELECT value FROM meta WHERE key = 'db_key_changed_at'").get() || {}).value || null,
  });
});

router.post('/admin/backups/run', requireBackupAccess, async (req, res) => {
  try {
    const name = await backup.runBackup({ manual: true });
    activity.log(req.user, 'Backup made', name);
    flash(req, 'ok', `Backup ${name} created.`);
    res.redirect('/admin/backups');
  } catch (e) {
    // The page itself says what went wrong (see "failed" above); an error page would say less.
    console.error('[backup] failed:', e.message);
    flash(req, 'err', 'The backup did not work.');
    res.redirect('/admin/backups');
  }
});

router.get('/admin/backups/photos.tar.gz', requireBackupAccess, needPassword, (req, res) => {
  let files = 0;
  try { files = fs.readdirSync(path.join(config.dataDir, 'uploads')).length; } catch (e) { /* nothing uploaded yet */ }
  activity.log(req.user, 'Photo archive downloaded', `${files} ${files === 1 ? 'file' : 'files'}`);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="portal-photos-${localDate()}.tar.gz"`);
  // tar is given nothing of the site's settings: it needs to be found, and that is all.
  const tar = spawn('tar', ['-czf', '-', '-C', config.dataDir, 'uploads'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'] });
  tar.stdout.pipe(res, { end: false });
  tar.on('error', () => res.destroy());
  // The download only ends cleanly when tar did. 1 means a file changed while it was read (photos are sealed in the
  // background), which still gives a whole archive; anything worse breaks the download off, so it cannot pass for a complete one.
  tar.on('close', (code) => {
    if (code === 0 || code === 1) return res.end();
    console.error(`[backup] the photo archive was cut short: tar ended with ${code === null ? 'a signal' : 'code ' + code}`);
    res.destroy();
  });
  res.on('close', () => { if (tar.exitCode === null) tar.kill(); });
});

router.get('/admin/backups/:name', requireBackupAccess, needPassword, (req, res) => {
  if (!backup.NAME.test(req.params.name)) return res.status(404).render('error', { title: 'Page not found', message: 'No such backup.' });
  activity.log(req.user, 'Backup downloaded', req.params.name);
  res.download(path.join(backup.backupDir, req.params.name), req.params.name, (err) => {
    if (err && !res.headersSent) res.status(404).render('error', { title: 'Page not found', message: 'No such backup.' });
  });
});

module.exports = router;
