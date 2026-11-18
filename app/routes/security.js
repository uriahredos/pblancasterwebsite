'use strict';
// A page for the people who run the whole site: the settings and accounts that decide how safe it is,
// each marked as fine or needing attention, with what to do about it.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const util = require('../util');
const config = require('../config');
const access = require('../permissions');
const activity = require('../activity');
const mail = require('../mail');
const backup = require('../backup');
const { clientIp } = require('../clientip');
const { requireEveryBranch, flash } = require('../auth');

const router = express.Router();
const guard = requireEveryBranch('users.manage');
const DAY = 86400000;

function checks(req) {
  const list = [];
  const add = (ok, title, detail, fix) => list.push({ ok: Boolean(ok), title, detail, fix: ok ? '' : fix });
  const people = db.prepare('SELECT u.id, u.display_name, u.username, u.is_master, u.profile_id, u.branch_id, u.must_change_password, u.temp_set_at, u.created_at FROM users u WHERE u.active = 1 AND u.removed_at IS NULL').all();

  // How sign-in attempts are told apart.
  const seen = clientIp(req); const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const viaCf = Boolean(req.headers['cf-connecting-ip']);
  const privateIp = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/i.test(seen);
  add(!privateIp && (!process.env.RENDER || viaCf), 'Sign-in attempts are counted per visitor',
    `The site sees your connection as ${seen}.${chain.length ? ` Passed along by ${chain.length} ${chain.length === 1 ? 'step' : 'steps'}.` : ''}${viaCf ? ' The address comes from Cloudflare.' : ''}`,
    'The address above should be your own internet address, not one that starts with 10. or 172. If it is not, tell whoever maintains the site: wrong sign-in attempts are being counted against the wrong address.');

  add(Boolean(process.env.BASE_URL) && /^https:\/\//.test(config.baseUrl), 'The site knows its own address',
    process.env.BASE_URL ? `Set to ${config.baseUrl}.` : 'Not set.',
    'In Render, open the service, then Environment, and set BASE_URL to the full address of the site starting with https://. Links in emails use it.');

  add(!process.env.BOOTSTRAP_ADMIN_PASSWORD, 'The first-account password has been removed',
    process.env.BOOTSTRAP_ADMIN_PASSWORD ? 'It is still stored in the hosting settings.' : 'Not stored.',
    'In Render, open the service, then Environment, and delete BOOTSTRAP_ADMIN_PASSWORD (and BOOTSTRAP_ADMIN_USERNAME). It was only for the very first sign-in. Left there, it would become the master password again if the database were ever lost.');

  add(mail.isConfigured(), 'Email is set up', mail.isConfigured() ? 'Password-reset links and summaries can be sent.' : 'Not set up, so nobody can reset a forgotten password by email and backups cannot be sent out.',
    'Add the mail server details in Render (SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM).');

  const backups = backup.listBackups(); const newest = backups[0];
  const age = newest ? Math.floor((Date.now() - new Date(newest.mtime).getTime()) / DAY) : null;
  add(newest && age <= 2, 'A recent backup exists', newest ? `Newest: ${newest.name}, ${age === 0 ? 'today' : age === 1 ? 'yesterday' : age + ' days ago'}.` : 'No backup has been made yet.', 'Open Backups and press "Back up now". Backups are made nightly; if they have stopped, tell whoever maintains the site.');
  add(config.backupEmailTo.length > 0 && mail.isConfigured(), 'Backups are kept somewhere else too',
    config.backupEmailTo.length && mail.isConfigured() ? `Each night's copy is emailed to ${config.backupEmailTo.join(', ')}.` : 'Backups only sit on the same disk as the site.',
    'Until email is set up with BACKUP_EMAIL_TO, download a backup from the Backups page every week and keep it somewhere safe.');

  // Is the database encrypted, and are all the copies of it?
  {
    const dbfile = require('../dbfile'); const e = db.encryption || { encrypted: false };
    const files = backups.map((b) => path.join(backup.backupDir, b.name));
    const plain = files.filter((f) => { try { return dbfile.isPlain(f); } catch (err) { return false; } }).length;
    const since = (db.prepare("SELECT value FROM meta WHERE key = 'db_encrypted_at'").get() || {}).value;
    const SAFE = 'Keep a second copy of the key somewhere safe that is not Render: a password manager, or printed and locked away. Without the key nobody can open the database or its backups again, and nobody can recover it for you.';
    if (!e.encrypted) {
      list.push({ ok: false, title: 'The database is encrypted',
        detail: e.note || 'No. Anyone who got hold of the database file or a backup could read everything in it.',
        fix: `Copy the key below. In Render, open the service, then Environment, add a variable named DB_KEY, paste the key as its value and save. The site restarts, and within a minute the database and every backup are encrypted. ${SAFE}`,
        code: crypto.randomBytes(32).toString('base64url'),
        after: 'This key was made just now for you to use, and is not stored anywhere by the site. If Render offers to generate a value for you, that works just as well.' });
    } else {
      const trouble = e.note || (e.usingOldKey ? 'The database is still opened with the old key.' : '');
      const ok = !trouble && !plain && !e.oldKeySet;
      const detail = [`Yes${since ? `, since ${util.fmtDateTime(since).split(', ')[0]}` : ''}. The database file and its backups can only be opened with the key kept in the hosting settings (DB_KEY).`,
        files.length ? `${files.length - plain} of ${files.length} backups are encrypted.` : '',
        'Photos and uploaded documents are separate files and are not encrypted by the site.', trouble].filter(Boolean).join(' ');
      const fix = trouble ? 'In Render, open the service, then Environment, and check DB_KEY and DB_KEY_OLD. To change the key: put the new one in DB_KEY and the current one in DB_KEY_OLD, then save.'
        : plain ? 'Restart the service once so the older backups are encrypted. Any that stay unencrypted after that can be deleted on the Backups page.'
          : 'The key change is finished. In Render, open the service, then Environment, and delete DB_KEY_OLD.';
      list.push({ ok, title: 'The database is encrypted', detail, fix: ok ? '' : fix, after: SAFE });
    }
  }

  // Accounts.
  const withKey = new Set(db.prepare('SELECT DISTINCT user_id FROM passkeys').all().map((r) => r.user_id));
  const powerful = people.filter((u) => u.is_master || (u.profile_id && access.permsOf(u.profile_id).has('users.manage')));
  const signedIn = powerful.filter((u) => !u.must_change_password); const noKey = signedIn.filter((u) => !withKey.has(u.id));
  add(!noKey.length, 'Admins sign in with Face ID or a fingerprint', noKey.length ? `${noKey.length} of the ${signedIn.length} admin accounts in use rely on a password alone: ${noKey.slice(0, 8).map((u) => u.display_name).join(', ')}${noKey.length > 8 ? ' and more' : ''}.` : `All ${signedIn.length} admin accounts in use have it set up.`,
    'Ask each of them to open Password and Face ID and press "Set up on this device". A device sign-in cannot be guessed or tricked out of someone the way a password can.');

  const auth = require('../auth');
  const waiting = people.filter((u) => u.must_change_password); const dead = waiting.filter((u) => auth.tempExpired(u)).length;
  add(true, 'Old temporary passwords stop working', waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'account has' : 'accounts have'} not signed in yet. A temporary password lasts ${config.tempPasswordDays} days: ${dead} ${dead === 1 ? 'has' : 'have'} expired and can no longer be used, ${waiting.length - dead} ${waiting.length - dead === 1 ? 'is' : 'are'} still good.` : 'Everyone has signed in and chosen their own password.', '');

  // How long the site may sit unused before it locks, and which kind of device this one counts as.
  const lockP = Math.round(config.lockAfterMs.phone / 60000), lockD = Math.round(config.lockAfterMs.desktop / 60000);
  const here = require('../device').kind(req) === 'phone' ? 'a phone or tablet' : 'a computer';
  const span = (n) => (n ? `after ${n} ${n === 1 ? 'minute' : 'minutes'}` : 'never by the clock');
  add(lockP > 0 && lockD > 0, 'The site locks when it is left unused', `On a phone or tablet: ${span(lockP)}. On a computer: ${span(lockD)}. Closing the site always locks it. The device you are on now counts as ${here}.`,
    'A timer set to 0 is switched off, so an unattended device stays open until the site is closed. In Render, open the service, then Environment, and set LOCK_AFTER_MINUTES_PHONE and LOCK_AFTER_MINUTES_DESKTOP (or delete them to get 10 and 20).');

  const noOffice = people.filter((u) => !u.branch_id && !u.is_master);
  add(!noOffice.length, 'Every account belongs to an office', noOffice.length ? `${noOffice.length} without one: ${noOffice.slice(0, 6).map((u) => u.display_name).join(', ')}.` : 'Yes.', 'Open each of them under Users and choose their office. Until then they see no office records.');

  const corp = people.filter((u) => u.is_master || (u.profile_id && access.permsOf(u.profile_id).has('branches.all')));
  add(corp.length <= 5, 'Few people can see every office', `${corp.length}: ${corp.slice(0, 8).map((u) => u.display_name).join(', ')}.`, 'Each of these accounts can read and change every office. Keep the list as short as the job needs (Corporate, then Offices and admins).');

  return list;
}

router.get('/admin/security', guard, (req, res) => {
  const list = checks(req);
  const sessions = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT json_extract(data, '$.userId')) AS people FROM sessions WHERE json_extract(data, '$.userId') IS NOT NULL AND expires > ?").get(Date.now());
  res.render('admin_security', { title: 'Security check', list, attention: list.filter((c) => !c.ok).length, sessions, locked: require('./auth').lockedNames(), isMaster: Boolean(req.user.is_master) });
});

// After a scare (a lost phone nobody reported, a password that got out): everyone has to sign in again.
router.post('/admin/security/sign-out-everyone', guard, (req, res) => {
  const n = db.prepare('DELETE FROM sessions WHERE sid <> ?').run(req.sessionID).changes;
  activity.log(req.user, 'Everyone signed out', `${n} sign-ins ended`);
  flash(req, 'ok', `Everyone else has been signed out (${n} sign-ins ended). They sign in again with their password or Face ID.`);
  res.redirect('/admin/security');
});

module.exports = router;
module.exports.checks = checks;
