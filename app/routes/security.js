'use strict';
// A page for the people who run the whole site: the settings and accounts that decide how safe it is,
// each marked as fine or needing attention, with what to do about it.
const fs = require('fs');
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
const stored = (key) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) || {}).value;
const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);
const ago = (days) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);

/** Room on the disk that holds the database, its backups and the photos. Null where the system cannot say: the line is then left out. */
function room() {
  try {
    const s = fs.statfsSync(config.dataDir);
    const out = { free: s.bavail * s.bsize, total: s.blocks * s.bsize, database: 0 };
    for (const ext of ['', '-wal']) { try { out.database += fs.statSync(path.join(config.dataDir, 'portal.db' + ext)).size; } catch (e) { /* not there */ } }
    return out.total > 0 ? out : null;
  } catch (e) { return null; }
}
/** A backup needs as much free room as the database itself, so the line asks for three times that, and never less than 15% of the disk. */
const roomy = (r) => r.free >= 3 * r.database && r.free >= 0.15 * r.total;

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

  // The newest backup is opened with the key in use and checked: a file with the right name and date is not enough.
  const backups = backup.listBackups(); const held = backup.report();
  const newestGood = held.good ? `${held.good.name}, ${ago(held.age)}` : '';
  add(held.good && !held.fault && !held.failed && held.age <= 2, 'A recent backup exists and opens',
    held.failed ? `The last backup did not work (${util.fmtDateTime(held.failed.at)}): ${held.failed.why}. The site tries again every half hour.${newestGood ? ` The newest good backup is ${newestGood}.` : ' There is no good backup.'}`
      : !held.count ? 'No backup has been made yet.'
        : held.fault ? `The newest backup, ${held.newest.name}, ${held.fault === 'locked' ? 'does not open with the key in use' : held.fault === 'plain' ? 'is not encrypted' : 'is damaged'}.${newestGood ? ` The newest that opens is ${newestGood}.` : ' None of the backups opens.'}`
          : `Newest: ${newestGood}. It opens with the key in use and passes its check.`,
    'Open Backups and press "Back up now". Backups are made nightly; if they have stopped, or pressing the button does not work either, tell whoever maintains the site.');
  add(config.backupEmailTo.length > 0 && mail.isConfigured(), 'Backups are kept somewhere else too',
    config.backupEmailTo.length && mail.isConfigured() ? `Each night's copy is emailed to ${config.backupEmailTo.join(', ')}.` : 'Backups only sit on the same disk as the site.',
    'Until email is set up with BACKUP_EMAIL_TO, download a backup from the Backups page every week and keep it somewhere safe.');

  const space = room();
  if (space) {
    add(roomy(space), 'The disk has room to spare', `${size(space.free)} free of ${size(space.total)}. The database is ${size(space.database)}.`,
      'In Render, open the service, then Disk, and make the disk larger. The database, its backups and every photo share this disk, and a backup needs as much free room as the database itself, so backups are the first thing to stop when it fills.');
  }

  // A restore that has been done, or a deliberate empty start, leaves a setting behind that should not stay.
  const restored = (db.encryption || {}).restored;
  if (restored && process.env.RESTORE_BACKUP) {
    add(false, 'The restore setting has been removed', `The database was restored from ${restored.backup} on ${util.fmtDateTime(restored.at).split(', ')[0]}.${restored.aside ? ` The database from before is still on the disk, as ${restored.aside}.` : ''}`,
      'In Render, open the service, then Environment, and delete RESTORE_BACKUP. It has done its work and is ignored while it stays.');
  }
  if (/^(1|yes|true|on)$/i.test(String(process.env.NEW_SITE || '').trim())) {
    add(false, 'The new-site setting has been removed', 'NEW_SITE is still in the hosting settings.',
      'In Render, open the service, then Environment, and delete NEW_SITE. It was only for the first start of an empty site. While it stays, a lost database would be replaced by an empty site without a word.');
  }

  // Is the database encrypted, and are all the copies of it?
  {
    const e = db.encryption || { encrypted: false };
    const shut = backups.filter((b) => backup.standing(b)).length;      // backups that do not open with the key in use
    const since = stored('db_encrypted_at');
    const SAFE = 'Keep a second copy of the key somewhere safe that is not Render: a password manager, or printed and locked away. Without the key nobody can open the database or its backups again, and nobody can recover it for you.';
    const RECORD = 'Keep the old key on record, with the dates it was in use, for as long as you keep any backup or photo archive downloaded in that time: those open only with it.';
    if (!e.encrypted) {
      // Encryption switched off: the photos and documents are opened a few at a time, and need the key until the last one is done.
      const up = require('../uploads').census(); const still = up.sealed + up.earlier + up.unknown;
      const no = e.note || 'No. Anyone who got hold of the database file or a backup could read everything in it.';
      if (still) {
        list.push({ ok: false, title: 'The database is encrypted',
          detail: `${no} ${still} ${still === 1 ? 'photo or document is' : 'photos and documents are'} still encrypted${up.unknown ? `, ${up.unknown} of them with a key that is not in the settings` : ''}.`,
          fix: (up.unknown ? 'In Render, open the service, then Environment, put the key they were encrypted with back in DB_KEY, with DB_DECRYPT set to yes, and save. Then leave both'
            : 'Leave DB_KEY and DB_DECRYPT in the hosting settings') +
            ` until this page says no photos or documents are still encrypted. They are opened a few at a time and cannot be opened without the key. ${RECORD}` });
      } else {
        list.push({ ok: false, title: 'The database is encrypted', detail: no,
          fix: `Copy the key below. In Render, open the service, then Environment, add a variable named DB_KEY, paste the key as its value and save. The site restarts, and within a minute the database and every backup are encrypted. ${SAFE}`,
          code: crypto.randomBytes(32).toString('base64url'),
          after: 'This key was made just now for you to use, and is not stored anywhere by the site. If Render offers to generate a value for you, that works just as well.' });
      }
    } else {
      // Photos and documents are sealed with the same key, a few at a time in the background.
      const up = require('../uploads').census();
      const trouble = e.note || (e.usingOldKey ? 'The database is still opened with the old key.' : '')
        || (up.unknown ? `${up.unknown} ${up.unknown === 1 ? 'photo or document is' : 'photos or documents are'} locked with a key that is not in the settings.` : '');
      const moving = up.earlier > 0;                                    // a key change is still working through the files
      const ok = !trouble && !shut && !e.oldKeySet;
      const detail = [`Yes${since ? `, since ${util.fmtDateTime(since).split(', ')[0]}` : ''}. The database, its backups, and the photos and documents people upload can only be opened with the key kept in the hosting settings (DB_KEY).`,
        backups.length ? `${backups.length - shut} of ${backups.length} backups are encrypted.${shut ? ` ${shut} ${shut === 1 ? 'does' : 'do'} not open with the key in use.` : ''}` : '',
        up.files ? `${up.sealed} of ${up.files} photos and documents are encrypted${up.plain ? '; the rest follow within a few minutes of being added' : ''}.` : '',
        moving ? `${up.earlier} ${up.earlier === 1 ? 'file is' : 'files are'} still being moved to the new key.` : '', trouble].filter(Boolean).join(' ');
      const fix = trouble ? 'In Render, open the service, then Environment, and check DB_KEY and DB_KEY_OLD. If the key was changed, the previous one has to be in DB_KEY_OLD until everything has moved across. To change the key: put the new one in DB_KEY and the current one in DB_KEY_OLD, then save.'
        : shut ? 'Restart the service once so the older backups are brought into line. If the key was changed and backups from before it still do not open, put the previous key in DB_KEY_OLD and save. Any left after that drop off the list as newer backups replace them.'
          : moving ? 'Leave DB_KEY_OLD where it is for now. Photos and documents are still being moved to the new key; this page will say when it can be deleted.'
            : `The key change is finished. In Render, open the service, then Environment, and delete DB_KEY_OLD. ${RECORD}`;
      list.push({ ok, title: 'The database is encrypted', detail, fix: ok ? '' : fix, after: SAFE });

      // Has anyone proved that the copy of the key kept outside Render is the right one? Only the day of the last match is kept.
      const checked = stored('key_copy_checked'); const days = checked ? Math.round((Date.parse(util.localDate()) - Date.parse(checked)) / DAY) : null;
      list.push({ ok: days !== null && days <= 183, title: 'The saved copy of the key has been checked', keyBox: true,
        detail: checked ? `Last checked on ${util.fmtDate(checked)}.` : 'Never checked.',
        fix: days !== null && days <= 183 ? '' : 'Find the copy of the key that is kept outside Render and paste it into the box below. If the answer is no, or the copy cannot be found, copy DB_KEY out of Render into safe keeping now, while the site still has it.' });
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

  const noOffice = people.filter((u) => !u.branch_id && !u.is_master);
  add(!noOffice.length, 'Every account belongs to an office', noOffice.length ? `${noOffice.length} without one: ${noOffice.slice(0, 6).map((u) => u.display_name).join(', ')}.` : 'Yes.', 'Open each of them under Users and choose their office. Until then they see no office records.');

  const corp = people.filter((u) => u.is_master || (u.profile_id && access.permsOf(u.profile_id).has('branches.all')));
  add(corp.length <= 5, 'Few people can see every office', `${corp.length}: ${corp.slice(0, 8).map((u) => u.display_name).join(', ')}.`, 'Each of these accounts can read and change every office. Keep the list as short as the job needs (Corporate, then Offices and admins).');

  return list;
}

router.get('/admin/security', guard, (req, res) => {
  const list = checks(req);
  const sessions = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT json_extract(data, '$.userId')) AS people FROM sessions WHERE json_extract(data, '$.userId') IS NOT NULL AND expires > ?").get(Date.now());
  res.render('admin_security', { title: 'Security check', list, attention: list.filter((c) => !c.ok).length, sessions, locked: require('./auth').lockedNames(), isMaster: Boolean(req.user.is_master), proved: require('./auth').provedRecently(req) });
});

// "Is the copy of the key I keep elsewhere still the right one?" The person pastes it and the site answers yes or no.
// What was pasted is compared and forgotten: it is never logged, stored or shown back. Only the day of the last match is kept.
const KEY_TRIES = new Map();                                              // person -> when they last tried
const KEY_LIMIT = 5, KEY_WINDOW = 15 * 60 * 1000;
const digest = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
router.post('/admin/security/check-key', guard, (req, res) => {
  const back = () => res.redirect('/admin/security#key-copy');
  const inUse = require('../dbfile').keyInUse();
  if (!require('./auth').provedRecently(req)) { flash(req, 'err', 'Type your password first.'); return back(); }
  if (!inUse) { flash(req, 'err', 'The database is not encrypted, so there is no key to check.'); return back(); }
  const now = Date.now(); const tries = (KEY_TRIES.get(req.user.id) || []).filter((t) => now - t < KEY_WINDOW);
  if (tries.length >= KEY_LIMIT) { flash(req, 'err', 'Too many tries. Wait 15 minutes and try again.'); return back(); }
  tries.push(now); KEY_TRIES.set(req.user.id, tries);
  // Both sides are hashed first, so the comparison takes the same time whatever was pasted.
  const same = crypto.timingSafeEqual(digest(String(req.body.key || '').trim()), digest(inUse));
  if (same) db.prepare("INSERT INTO meta (key, value) VALUES ('key_copy_checked', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(util.localDate());
  activity.log(req.user, 'Saved key checked', same ? 'It matched the key in use' : 'It did not match the key in use');
  flash(req, same ? 'ok' : 'err', same ? 'Yes. That is the key the site is using.' : 'No. That is not the key the site is using.');
  back();
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
module.exports.roomy = roomy;
