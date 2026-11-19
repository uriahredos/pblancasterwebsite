'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const dbfile = require('./dbfile');
const { localDate, localHour } = require('./util');

const backupDir = path.join(config.dataDir, 'backups');
const NAME = dbfile.BACKUP;
// How many of each kind are kept. They are counted apart, so pressing "Back up now" cannot push out the nightly history,
// and the copies made before an update sit outside both.
const KEEP = { nightly: config.backupKeep, manual: 5, update: 2 };
const kindOf = (name) => (/-before-update\.db$/.test(name) ? 'update' : /-\d{6}\.db$/.test(name) ? 'manual' : 'nightly');
const DAY = 86400000;

/** Every backup on the disk, newest first. */
function listBackups() {
  return dbfile.backupsIn(config.dataDir).map((b) => ({ name: b.name, size: b.size, mtime: b.mtime, kind: kindOf(b.name) }));
}

// ---- What was last made, and what last went wrong: kept in the database so a restart does not forget ----
const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const stored = (key) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) || {}).value;
const parsed = (key) => { try { return JSON.parse(stored(key)) || null; } catch (e) { return null; } };
const state = { good: parsed('backup_last_good'), failed: parsed('backup_last_error'), alerted: stored('backup_alert_day') || null };
function remember(what, key, value) {
  state[what] = value;
  // A full disk can refuse this as well. The answer is still held here and written in the log.
  try { put.run(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) { console.error(`[backup] could not record ${key}: ${e.message}`); }
}
/** True while the latest try at a backup failed and none has worked since. */
const failing = () => Boolean(state.failed && (!state.good || state.failed.at > state.good.at));
/** Why a backup failed, in words for a page rather than SQLite's own. */
const plainly = (e) => (e.code === 'SQLITE_FULL' || e.code === 'ENOSPC' ? 'there is not enough room on the disk'
  : e.code === 'SQLITE_CORRUPT' || e.code === 'SQLITE_NOTADB' ? 'part of the database file is damaged' : e.message);

function failed(e, kind) {
  remember('failed', 'backup_last_error', { at: new Date().toISOString(), why: plainly(e), code: e.code || null, kind });
  if (kind !== 'nightly' || state.alerted === localDate()) return;        // one alert a day, however many tries fail
  remember('alerted', 'backup_alert_day', localDate());
  // The people who look after backups hear about it on their phones; their bell and the Security check show it too.
  try {
    const access = require('./permissions');
    const people = db.prepare('SELECT DISTINCT u.* FROM users u JOIN push_subscriptions s ON s.user_id = u.id WHERE u.active = 1').all()
      .map((u) => access.loadAccess(u)).filter((u) => u.allBranches && access.can(u, 'backups')).map((u) => u.id);
    require('./push').notify(people, 'backup_failed', { title: 'Last night\'s backup did not work', body: 'The site keeps trying. Open Backups to see why.', url: '/admin/backups' });
  } catch (err) { console.error('[backup] could not send the alert:', err.message); }
}

// ---- Does a stored copy still open? ----
// Opening an encrypted file takes a moment, so the answer is kept for as long as the file is unchanged.
const looked = new Map();
const idOf = (b) => `${b.size}:${b.mtime}`;
/** '' when this backup opens with the key in use and holds a site; otherwise 'empty', 'locked' (the key does not open it) or 'damaged'. `deep` has SQLite check the whole file as well. */
function standing(b, deep = false) {
  const was = looked.get(b.name);
  if (was && was.id === idOf(b) && (was.deep || !deep || was.fault)) return was.fault;
  const fault = dbfile.inspect(path.join(backupDir, b.name), dbfile.keyInUse(), { light: !deep }).fault || '';
  looked.set(b.name, { id: idOf(b), fault, deep });
  return fault;
}

/** After a good backup: keep the newest of its kind. Only copies that open count towards that number, so an empty or unreadable file can never push out a good one. */
function prune(kind) {
  let good = 0;
  for (const b of listBackups().filter((x) => x.kind === kind)) {
    if (good >= KEEP[kind]) { dbfile.clear(path.join(backupDir, b.name)); looked.delete(b.name); }
    else if (!standing(b)) good += 1;
  }
}

/** Writes a consistent, checked copy of the database, prunes old copies of the same kind, and emails it if configured. */
async function runBackup({ manual = false, now = new Date() } = {}) {
  const kind = manual ? 'manual' : 'nightly';
  const stamp = manual ? `-${now.toISOString().slice(11, 19).replace(/:/g, '')}` : '';
  const name = `portal-${localDate(now)}${stamp}.db`;
  const file = path.join(backupDir, name);
  // A complete, consistent copy. When the database is encrypted the copy is too, under the same key.
  // It only gets its name once it has been opened and checked, so a failed try leaves nothing that looks like a backup.
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const size = dbfile.snapshot(db, file);
    remember('good', 'backup_last_good', { name, at: new Date().toISOString(), size, kind });
  } catch (e) {
    failed(e, kind);
    throw e;
  }
  const made = listBackups().find((b) => b.name === name);
  if (made) looked.set(name, { id: idOf(made), fault: '', deep: true });
  prune(kind);

  if (!manual && config.backupEmailTo.length) {
    const gz = zlib.gzipSync(fs.readFileSync(file));
    if (gz.length <= 15 * 1024 * 1024) {
      await mail.send(config.backupEmailTo, `Portal backup ${localDate(now)}`,
        (db.encryption.encrypted
          ? 'Attached is last night\'s copy of the portal database. It is encrypted: it can only be opened with the database key ' +
            'kept in the hosting settings (DB_KEY), so keep that key somewhere safe as well.\n\n'
          : 'Attached is last night\'s copy of the portal database. It contains everything in the site, ' +
            'including anonymous complaints, and it is not encrypted, so keep it somewhere private.\n\n') +
        'Photos are not included; download them from the Backups page.\n',
        [{ filename: `${name}.gz`, content: gz }]);
    } else {
      await mail.send(config.backupEmailTo, `Portal backup ${localDate(now)} is too large to email`,
        `The backup is on the server. Download it from ${config.baseUrl}/admin/backups\n`);
    }
  }
  return name;
}

/** Tonight's backup, unless a good one is already there. A night that failed is tried again at the next tick. */
async function nightly(now = new Date()) {
  if (localHour(now) < config.backupHour) return null;
  const today = listBackups().find((b) => b.name === `portal-${localDate(now)}.db`);
  if (today && !standing(today)) return null;
  return runBackup({ now });
}

/** Backups made before the database was encrypted (or under a key since changed) are brought into line with the key in use. */
function alignWithKey() {
  const done = dbfile.alignCopies(listBackups().map((b) => path.join(backupDir, b.name)), db.encryption);
  looked.clear();
  return done;
}

/**
 * Where the backups stand, for the Security check and the Backups page: the newest copy, whether it opens with the
 * key in use and passes its check, the newest that does, and the last failure if nothing has worked since.
 */
function report(now = new Date()) {
  const all = listBackups();
  const daysOld = (b) => Math.max(0, Math.round((Date.parse(localDate(now)) - Date.parse(b.name.slice(7, 17))) / DAY));
  const newest = all[0] || null;
  const fault = newest ? standing(newest, true) : '';
  const good = newest && !fault ? newest : all.slice(1).find((b) => !standing(b)) || null;
  return { count: all.length, newest, fault, good, age: good ? daysOld(good) : null, failed: failing() ? state.failed : null };
}

/** At start-up: clear away copies that were never finished (a stop part-way, a full disk) and empty files left under a backup's name. */
function tidy() {
  let names;
  try { names = fs.readdirSync(backupDir); } catch (e) { return; }
  const unfinished = /^portal-[0-9a-z-]+\.db\.(partial|converting)(-journal|-wal|-shm)?$/;
  for (const n of names) {
    try {
      if (unfinished.test(n) || (NAME.test(n) && fs.statSync(path.join(backupDir, n)).size === 0)) fs.rmSync(path.join(backupDir, n), { force: true });
    } catch (e) { /* gone already */ }
  }
}
tidy();

function startNightlyBackups() {
  const tick = () => nightly().catch((e) => console.error('[backup] failed:', e.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 30 * 60 * 1000).unref();
  // Look at the stored copies one at a time in the background, so the pages that list them do not have to wait for it.
  const glance = (i) => {
    const b = listBackups()[i];
    if (!b) return;
    try { standing(b, i === 0); } catch (e) { /* it is looked at again when a page asks */ }
    setTimeout(glance, 2000, i + 1).unref();
  };
  setTimeout(glance, 20 * 1000, 0).unref();
}

module.exports = { backupDir, NAME, KEEP, kindOf, listBackups, runBackup, nightly, startNightlyBackups, alignWithKey, standing, failing, report };
