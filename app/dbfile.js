'use strict';
// Opening the database file, encrypted or not.
//
// With DB_KEY set in the hosting settings the file is kept encrypted, in SQLCipher 4 format (AES-256, with a check on
// every page). A copy of it - the file itself, a downloaded backup, an emailed one - cannot be read without that key.
// The first start with a key encrypts the existing database where it stands. DB_KEY_OLD lets the key be changed,
// and DB_DECRYPT=yes (with the key still set) turns encryption off again.
// Without DB_KEY the database is an ordinary SQLite file, as it always was.
//
// The key is never written to the disk, the log or the database. Lose it and nobody can open the data again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3-multiple-ciphers');

/** The database cannot be opened with what is in the settings. The data is untouched; the settings need putting right. */
class KeyProblem extends Error {}
/**
 * The site cannot start for a reason that is not the key: the database file is damaged or missing, or a restore that
 * was asked for could not be done. It shows the same closed page, with `advice` (what to do, in plain words) in place
 * of the usual one about DB_KEY. `safe` says whether "nothing has been lost" can honestly be said.
 */
class Stopped extends KeyProblem {
  constructor(message, advice, safe) { super(message); this.advice = advice; this.safe = Boolean(safe); }
}
/** A key change worked but its safety copy could not be cleared away. The site must not run with that copy lying about: a later start would put it back over newer data. */
class Leftover extends Error {}

const MIN_KEY = 20;
const PLAIN = Buffer.from('SQLite format 3\u0000', 'latin1');
const COPY = '.before-key-change';
// What the site's own backups are called: nightly, "Back up now" (with a time), and the copy made before an update.
const BACKUP = /^portal-\d{4}-\d{2}-\d{2}(-\d{6}(-before-update)?)?\.db$/;
const PART = '.partial';                                  // a backup still being written and checked
const TURN = '.converting';                               // a backup being moved to another key
const SIDE = ['-journal', '-wal', '-shm'];                // what SQLite may keep beside a database file
const SETTINGS = 'open the hosting settings (Render, then the service, then Environment)';
const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const setting = (name) => String(process.env[name] || '').trim();
const yes = (name) => /^(1|yes|true|on)$/i.test(setting(name));
const switchedOff = () => yes('DB_DECRYPT');
// The key the live database was opened with ('' = not encrypted). Held here only: never in what the rest of the site passes round.
let liveKey = '';

/** A connection to `file`, unlocked with `key` ('' = not encrypted). */
function connect(file, key, options) {
  const db = new Database(file, options);
  if (key) { db.pragma("cipher = 'sqlcipher'"); db.pragma('legacy = 4'); db.pragma('key = ' + quote(key)); }
  return db;
}

/** An ordinary, unencrypted SQLite file starts with a fixed line of text. An encrypted one starts with random bytes. */
function isPlain(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(16); return fs.readSync(fd, b, 0, 16, 0) === 16 && b.equals(PLAIN); }
  finally { fs.closeSync(fd); }
}

/** Does `key` open this file? */
function readable(file, key) {
  let db = null;
  try {
    db = connect(file, key, { fileMustExist: true });
    db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    return true;
  } catch (e) {
    if (e.code === 'SQLITE_NOTADB') return false;
    throw e;
  } finally { if (db) { try { db.close(); } catch (e) { /* already closed */ } } }
}

/** How many rows each table holds: compared before and after a key change, to be sure nothing moved. */
function tally(db) {
  const out = {};
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    out[t.name] = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get().n;
  }
  return out;
}

function flush(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/** Make a rename or a removal in this folder stick, even if the power goes a moment later. */
function flushFolder(dir) {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch (e) { /* not every system allows it; the database's own journal still protects the file */ }
}

/** Rewrite the file under another key: '' to a key encrypts it, key to key changes it, key to '' decrypts it. */
function rekey(file, from, to) {
  const db = connect(file, from, { fileMustExist: true });
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    if (!from) { db.pragma("cipher = 'sqlcipher'"); db.pragma('legacy = 4'); }
    db.pragma('rekey = ' + quote(to));
  } finally { db.close(); }
}

/** Remove a working file and whatever SQLite left beside it. */
function clear(file) {
  for (const ext of ['', ...SIDE]) fs.rmSync(file + ext, { force: true });
}

/**
 * Look at a copy of the database without changing it. `fault` is null when the file opens with `key`, holds a site and
 * passes SQLite's check; otherwise it is 'empty', 'locked' (that key does not open it) or 'damaged'. A file of no
 * bytes opens as an empty database, so that is looked for first. `rows` is the row count of each table, when asked for.
 * `full` runs SQLite's longer check; `light` skips the check and only sees that the file opens and holds a site.
 */
function inspect(file, key, { full = false, count = false, light = false } = {}) {
  const mine = ['-wal', '-shm'].filter((ext) => !fs.existsSync(file + ext));
  let db = null;
  try {
    if (!fs.statSync(file).size) return { fault: 'empty' };
    if (isPlain(file) !== !key) return { fault: 'locked' };
    db = connect(file, key, { readonly: true, fileMustExist: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) return { fault: 'damaged' };
    if (!light && db.pragma(full ? 'integrity_check' : 'quick_check', { simple: true }) !== 'ok') return { fault: 'damaged' };
    return { fault: null, rows: count ? tally(db) : undefined };
  } catch (e) {
    return { fault: e.code === 'SQLITE_NOTADB' ? 'locked' : 'damaged' };
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already closed */ } }
    // Reading a copy made in write-ahead mode leaves two empty files beside it. Clear them, so a backup stays one file.
    for (const ext of mine) { try { if (ext === '-shm' || !fs.statSync(file + ext).size) fs.rmSync(file + ext, { force: true }); } catch (e) { /* not there */ } }
  }
}

/**
 * A checked copy of the open database, written to `target`. The copy is made under a name nothing else looks at. Its
 * sign-in sessions are emptied (a backup has no need of them, and bringing one back should sign everyone out). It is
 * then opened afresh with the key, checked by SQLite and compared table by table with the database it came from, and
 * only then given its real name. Anything short of that leaves no file behind. Returns the size of the copy.
 */
function snapshot(db, target) {
  const part = target + PART;
  clear(part);
  try {
    const want = tally(db);
    db.exec(`VACUUM INTO ${quote(part)}`);
    const copy = connect(part, liveKey, { fileMustExist: true });
    try {
      copy.pragma('journal_mode = DELETE');                // one file, with nothing kept beside it
      copy.pragma('secure_delete = ON');                   // what is removed is wiped, not just struck off
      if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) copy.exec('DELETE FROM sessions');
    } finally { copy.close(); }
    const seen = inspect(part, liveKey, { count: true });
    if (seen.fault) throw new Error(seen.fault === 'locked' ? 'the copy did not open with the key' : `the copy did not pass its check (it is ${seen.fault})`);
    delete want.sessions; delete seen.rows.sessions;
    if (JSON.stringify(seen.rows) !== JSON.stringify(want)) throw new Error('the copy does not hold the same rows as the database');
    flush(part);
    fs.renameSync(part, target);
    flushFolder(path.dirname(target));
  } catch (e) {
    clear(part);
    throw e;
  }
  return fs.statSync(target).size;
}

/**
 * Move a stored copy from one key to another ('' = not encrypted) without touching the original until the result is
 * known to be good: a copy of it is rewritten, opened with the new key and checked, and only then takes its place.
 * A stop half-way leaves the original exactly as it was.
 */
function convert(file, from, to) {
  const tmp = file + TURN;
  clear(tmp);
  try {
    fs.copyFileSync(file, tmp);
    rekey(tmp, from, to);
    if (inspect(tmp, to, { full: true }).fault) throw new Error(to ? 'did not open with the key afterwards' : 'still encrypted afterwards');
    const was = fs.statSync(file);
    fs.utimesSync(tmp, was.atime, was.mtime);              // it is still the copy made that night
    flush(tmp);
    fs.renameSync(tmp, file);
    flushFolder(path.dirname(file));
  } catch (e) {
    clear(tmp);
    throw e;
  }
}

/** Put back the copy made before a key change, if one is there. True when it was. */
function restore(file) {
  const copy = file + COPY;
  if (!fs.existsSync(copy)) return false;
  for (const ext of ['-wal', '-shm', '-journal']) fs.rmSync(file + ext, { force: true });
  fs.copyFileSync(copy, file);
  flush(file);
  fs.rmSync(copy, { force: true });
  return true;
}

/**
 * Change the key of the live database, with a way back. A complete copy is set aside first; the file is rewritten;
 * the result must open with the new key, pass SQLite's own check and hold exactly the rows it held before. Only then
 * is the copy removed. If anything fails, or the server stops half-way, the copy is put back and nothing has changed.
 */
function change(file, from, to) {
  const copy = file + COPY;
  let before;
  const first = connect(file, from, { fileMustExist: true });
  try { first.pragma('wal_checkpoint(TRUNCATE)'); before = JSON.stringify(tally(first)); } finally { first.close(); }
  // The copy only gets its real name once it is complete, so a half-written one can never be mistaken for it.
  fs.copyFileSync(file, copy + '.tmp');
  flush(copy + '.tmp');
  fs.renameSync(copy + '.tmp', copy);
  flushFolder(path.dirname(file));
  try {
    rekey(file, from, to);
    if (to ? isPlain(file) || !readable(file, to) : !isPlain(file)) throw new Error('the database did not open with the new key');
    const db = connect(file, to, { fileMustExist: true });
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('the database did not pass its check afterwards');
      if (JSON.stringify(tally(db)) !== before) throw new Error('the number of rows changed');
    } finally { db.close(); }
  } catch (e) {
    restore(file);
    throw e;
  }
  try { fs.rmSync(copy); flushFolder(path.dirname(file)); } catch (e) {
    throw new Leftover(`The database key was changed, but the copy set aside beforehand could not be removed (${copy}): ${e.message}`);
  }
}

// ---- The backups kept beside the database, as far as opening it is concerned ----

/** The site's own backups in the data folder, newest first: by the day in the name, then by when the file was written. */
function backupsIn(dataDir) {
  const dir = path.join(dataDir, 'backups');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names.filter((n) => BACKUP.test(n))) {
    try { const st = fs.statSync(path.join(dir, name)); out.push({ name, file: path.join(dir, name), size: st.size, mtime: st.mtime.toISOString(), at: st.mtimeMs }); } catch (e) { /* removed while we looked */ }
  }
  return out.sort((a, b) => b.name.slice(7, 17).localeCompare(a.name.slice(7, 17)) || b.at - a.at || b.name.localeCompare(a.name));
}

/** Which of these keys opens a backup and passes its check ({ key }), or what is wrong with it ({ why }: empty, locked or damaged). */
function opensWith(file, keys) {
  let seen = { fault: 'locked' };
  try {
    if (!fs.statSync(file).size) return { why: 'empty' };
    for (const k of (isPlain(file) ? [''] : keys.filter(Boolean))) {
      seen = inspect(file, k, { full: true });
      if (!seen.fault) return { key: k };
      if (seen.fault !== 'locked') break;                  // it opened with this key, so trying another would prove nothing
    }
  } catch (e) { return { why: 'damaged' }; }
  return { why: seen.fault };
}

/**
 * What the backups say when the database itself will not open: how many there are, the newest one that opens with a
 * key from the settings and passes its check (`good`), and whether the very newest one opens at all (`opens`), which
 * shows the settings hold the right key. `plain` is true when that newest backup is not encrypted.
 */
function backupsSay(dataDir, keys) {
  const all = backupsIn(dataDir).filter((b) => b.size > 0);
  const out = { count: all.length, good: null, opens: false, plain: false };
  all.slice(0, 5).some((b, i) => {
    const u = opensWith(b.file, keys);
    if (i === 0) { out.opens = u.why !== 'locked'; try { out.plain = isPlain(b.file); } catch (e) { /* gone */ } }
    if (!u.why) out.good = b.name;
    return !u.why;
  });
  return out;
}

const RESTORE_HOW = (name) => `To go back to it, ${SETTINGS}, add a setting named RESTORE_BACKUP with the value ${name} and save. ` +
  'Anything entered after that backup was made will not be in it. The file there now is set aside on the disk, not deleted.';

/** The database file is there but cannot be read, although the key is not the problem. Says which backup to go back to. */
function damaged(seen) {
  return new Stopped('The database file is damaged. The key is not the problem.',
    seen.good ? `The newest backup that opens is ${seen.good}. ${RESTORE_HOW(seen.good)}`
      : 'No backup on the disk passes its check either. Tell whoever maintains the site before changing anything: the files are still there.', false);
}

/** A start that failed because SQLite found the file damaged gets the closed page too, not a crash only the server log explains. */
function damage(e, dataDir) {
  if (!e || (e.code !== 'SQLITE_CORRUPT' && e.code !== 'SQLITE_NOTADB')) return null;
  return damaged(backupsSay(dataDir, [setting('DB_KEY'), setting('DB_KEY_OLD')]));
}

// ---- Bringing a backup back (RESTORE_BACKUP in the hosting settings) ----

const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
/** Write a small file so that it is either all there or not there at all. */
function writeWhole(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  flush(file + '.tmp');
  fs.renameSync(file + '.tmp', file);
  flushFolder(path.dirname(file));
}
function sha(file) {
  const hash = crypto.createHash('sha256'); const buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/**
 * RESTORE_BACKUP=<backup file name> in the hosting settings puts that backup in place of the database, before anything
 * opens it. The name must be one of the site's own backups; the backup must open with DB_KEY (or DB_KEY_OLD) and pass
 * SQLite's check. Then, in this order:
 *   1. the backup is copied in beside the database under a temporary name, and the copy compared with the original;
 *   2. a short note of what is being done is written, so a stop from here on is picked up and finished at the next start;
 *   3. the database in use and the files SQLite keeps beside it are renamed to portal-before-restore-<date and time>.db
 *      (and -wal, -shm): set aside whole, never deleted, and no longer where they could be replayed onto the backup;
 *   4. the copy takes the database's name;
 *   5. a marker records which backup was restored, so the same setting does nothing on later starts. The marker is
 *      only forgotten when the site itself starts without the setting (see settled): setting it again then counts afresh.
 * If anything is wrong before step 2, everything is left exactly as it was and the site says why on its closed page.
 * Returns null when no restore is asked for, or { backup, at, aside, again } (again = done on an earlier start).
 */
function bringBack(dataDir, file, keys) {
  const plan = file + '.restore-plan', temp = file + '.restoring', done = file + '.restored';
  const want = setting('RESTORE_BACKUP');
  const refuse = (why) => new Stopped(`The site was asked to bring back a backup (RESTORE_BACKUP in the hosting settings) and could not: ${why} Nothing has been changed.`,
    `${SETTINGS[0].toUpperCase()}${SETTINGS.slice(1)}, correct RESTORE_BACKUP or delete it, and save.`, true);
  const free = (p) => { let name = p; while (fs.existsSync(name)) name += '.more'; return name; };

  // Every step from here can be repeated safely, so a stop part-way is simply carried on from.
  const carryOut = (step) => {
    const aside = path.join(dataDir, `portal-before-restore-${step.stamp}.db`);
    try {
      if (fs.existsSync(temp)) {
        for (const ext of ['', ...SIDE]) if (fs.existsSync(file + ext)) fs.renameSync(file + ext, free(aside + ext));
        flushFolder(dataDir);
        fs.renameSync(temp, file);
        flushFolder(dataDir);
      }
      const result = { backup: step.backup, at: step.at, aside: fs.existsSync(aside) ? path.basename(aside) : null };
      writeWhole(done, JSON.stringify(result));
      fs.rmSync(plan, { force: true });
      flushFolder(dataDir);
      return { ...result, again: false };
    } catch (e) {
      throw new Stopped(`Bringing back ${step.backup} was started and could not be finished (${e.message}).`,
        'Nothing has been deleted: the database from before is on the disk. Tell whoever maintains the site. The next start tries again.', true);
    }
  };

  let finished = null;
  const step = fs.existsSync(plan) ? readJson(plan) : null;
  if (step && step.backup && step.stamp) finished = carryOut(step);       // a restore that was cut short is finished first
  else { fs.rmSync(plan, { force: true }); fs.rmSync(plan + '.tmp', { force: true }); fs.rmSync(temp, { force: true }); }   // a copy that was never completed

  if (!want) return finished;
  const last = readJson(done);
  if (last && last.backup === want) return finished || { ...last, again: true };

  if (!BACKUP.test(want)) throw refuse(`"${want.slice(0, 60)}" is not the name of one of the site's backups.`);
  const source = path.join(dataDir, 'backups', want);
  if (!fs.existsSync(source)) throw refuse(`there is no backup named ${want} on the disk.`);
  const u = opensWith(source, keys);
  if (u.why) {
    throw refuse(u.why === 'empty' ? `${want} is empty.`
      : u.why === 'locked' ? `${want} does not open with the key in the hosting settings (DB_KEY).`
        : `${want} is damaged (it did not pass its check). An older backup may be sound.`);
  }
  const next = { backup: want, stamp: stamp(), at: new Date().toISOString() };
  for (let i = 2; fs.existsSync(path.join(dataDir, `portal-before-restore-${next.stamp}.db`)); i++) next.stamp = `${stamp()}-${i}`;   // a second restore in the same second
  try {
    fs.copyFileSync(source, temp);
    flush(temp);
    if (sha(temp) !== sha(source)) throw new Error('the copy did not match the backup');
    writeWhole(plan, JSON.stringify(next));
  } catch (e) {
    for (const f of [plan, plan + '.tmp', temp]) fs.rmSync(f, { force: true });
    throw refuse(`${want} could not be copied into place (${e.message}).`);
  }
  return carryOut(next);
}

/**
 * The site has started without RESTORE_BACKUP: the note of the last restore is no longer needed. Only the site's own
 * start does this. A script or a shell that opens the database without the setting must not be able to cause the
 * same backup to be brought back a second time at the next restart.
 */
function settled(dataDir) {
  if (!setting('RESTORE_BACKUP')) fs.rmSync(path.join(dataDir, 'portal.db.restored'), { force: true });
}

/**
 * Open the live database the way the settings say, encrypting or re-keying it first if that is what they ask for.
 * Returns { db, status }. Throws KeyProblem when the file is encrypted and the settings do not hold its key, and
 * Stopped when the file is damaged or missing, or a restore that was asked for could not be done.
 */
function open(dataDir) {
  const file = path.join(dataDir, 'portal.db');
  const key = setting('DB_KEY'), old = setting('DB_KEY_OLD');
  const off = switchedOff();
  const usable = key.length >= MIN_KEY && !off;
  const status = { encrypted: false, changed: null, note: null, oldKeySet: Boolean(old), usingOldKey: false, restored: null };
  const live = (k) => { liveKey = k; return connect(file, k); };
  if (off) status.note = 'DB_DECRYPT is set, so the database is being kept unencrypted. Remove DB_DECRYPT to encrypt it again.';
  else if (key && !usable) status.note = `DB_KEY is shorter than ${MIN_KEY} characters, so it is not being used.`;

  // A key change that was cut short (the server stopped half-way): go back to the copy made beforehand and start again.
  fs.rmSync(file + COPY + '.tmp', { force: true });
  restore(file);

  // A backup to bring back, if the settings ask for one. After it, the file is opened like any other.
  status.restored = bringBack(dataDir, file, [key, old]);

  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {             // a new site: encrypted from its first page
    // ...unless backups show a site was here. Starting empty would look healthy while everything was missing.
    const seen = yes('NEW_SITE') ? { count: 0 } : backupsSay(dataDir, [key, old]);
    if (seen.count) {
      throw new Stopped(`The database file is ${fs.existsSync(file) ? 'empty' : 'missing'}, but ${seen.count === 1 ? 'a backup of this site is' : 'backups of this site are'} on the disk.`,
        (seen.good ? `The newest backup that opens is ${seen.good}. To bring it back, ${SETTINGS}, add a setting named RESTORE_BACKUP with the value ${seen.good} and save.`
          : `None of the newest backups opens with the key in the hosting settings, so first ${SETTINGS} and put the right key in DB_KEY.`) +
        ' If this is meant to be a new, empty site instead, add a setting named NEW_SITE with the value yes.', false);
    }
    status.encrypted = usable;
    return { db: live(usable ? key : ''), status };
  }

  if (isPlain(file)) {
    if (!usable) return { db: live(''), status };
    try { change(file, '', key); } catch (e) {
      if (e instanceof Leftover) throw e;
      status.note = `Encrypting the database did not work, so it was left exactly as it was (${e.message}).`;
      return { db: live(''), status };
    }
    status.encrypted = true; status.changed = 'encrypted';
    return { db: live(key), status };
  }

  // The file is encrypted.
  status.encrypted = true;
  if (off) {                                                              // asked to turn encryption off: needs the key one last time
    const has = [key, old].find((k) => k && readable(file, k));
    if (has) {
      try { change(file, has, ''); status.encrypted = false; status.changed = 'decrypted'; return { db: live(''), status }; } catch (e) {
        if (e instanceof Leftover) throw e;
        status.note = `Decrypting the database did not work, so it is still encrypted (${e.message}).`;
        return { db: live(has), status };
      }
    }
  }
  if (key && readable(file, key)) return { db: live(key), status };
  if (old && readable(file, old)) {
    if (usable) {
      try { change(file, old, key); status.changed = 'rekeyed'; return { db: live(key), status }; } catch (e) {
        if (e instanceof Leftover) throw e;
        status.note = `Changing the database key did not work, so the old key is still in use (${e.message}).`;
      }
    }
    status.usingOldKey = true;
    if (!usable) status.note = `The database is being opened with DB_KEY_OLD. Put the new key in DB_KEY (at least ${MIN_KEY} characters) to change over.`;
    return { db: live(old), status };
  }
  // Nothing in the settings opens the file. If the same settings do open the newest backup, the key is right and it
  // is the file that is damaged: say that, rather than send someone hunting for a key they already have.
  const seen = backupsSay(dataDir, [key, old]);
  if (seen.opens && (!seen.plain || !usable)) throw damaged(seen);
  throw new KeyProblem(key || old
    ? 'The database is encrypted with a different key from the one in the hosting settings (DB_KEY).'
    : 'The database is encrypted, and its key (DB_KEY) is missing from the hosting settings.');
}

/**
 * A new version of the code is about to make its changes to the database. Before it does, keep a checked copy of the
 * database as the last version left it, in the backups folder under its own kind of name. The version is the commit
 * the host says it is running (RENDER_GIT_COMMIT); without one this does nothing. Returns the name of the copy made,
 * or null. A copy that cannot be made is reported, not allowed to stop the site from starting.
 */
function beforeUpdate(db, dataDir, version, day) {
  const now = String(version || '').trim();
  if (!now) return null;
  const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const put = (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  if (has('meta') && (db.prepare("SELECT value FROM meta WHERE key = 'code_version'").get() || {}).value === now) return null;
  let made = null; let failed = null;
  if (has('users') && db.prepare('SELECT 1 FROM users').get()) {          // a site with nobody in it has nothing to keep
    const name = `portal-${/^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : stamp().slice(0, 10)}-${stamp().slice(11)}-before-update.db`;
    try {
      fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
      const size = snapshot(db, path.join(dataDir, 'backups', name));
      made = { name, at: new Date().toISOString(), size, kind: 'update' };
    } catch (e) {
      failed = e;
      console.error(`[backup] The copy before this update could not be made: ${e.message}`);
    }
  }
  // Remembered straight away, so a start that fails further on does not make a second "before" copy of a half-changed database.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  put('code_version', now);
  if (failed) { try { put('backup_last_error', JSON.stringify({ at: new Date().toISOString(), why: failed.message, code: failed.code || null, kind: 'update' })); } catch (e) { /* the log has it */ } }
  if (made) {
    put('backup_last_good', JSON.stringify(made));
    const mine = backupsIn(dataDir).filter((b) => /-before-update\.db$/.test(b.name));
    for (const b of mine.slice(2)) fs.rmSync(b.file, { force: true });    // the newest two are kept
  }
  return made && made.name;
}

/**
 * Bring stored copies of the database (the nightly backups) into line with the key in use: ones made before
 * encryption was switched on are encrypted, and after a key change ones under the old key are moved to the new one.
 * When encryption has been switched off they are decrypted. Each one is converted as a copy that replaces the original
 * only once it has been checked, so a start that is cut short cannot leave a damaged backup. Returns how many were
 * converted each way, and how many are still unencrypted (plain) or locked with a key the settings do not hold (foreign).
 */
function alignCopies(files, status) {
  const key = setting('DB_KEY'), old = setting('DB_KEY_OLD');
  const out = { encrypted: 0, rekeyed: 0, decrypted: 0, plain: 0, foreign: 0 };
  const off = switchedOff();
  const live = status.encrypted && !status.usingOldKey && key.length >= MIN_KEY && !off;
  for (const f of files) {
    try {
      if (off && !status.encrypted && !isPlain(f)) {                        // encryption was switched off: the copies follow
        const has = [key, old].find((k) => k && readable(f, k));
        if (!has) { out.foreign += 1; continue; }
        convert(f, has, '');
        out.decrypted += 1; out.plain += 1;
      } else if (isPlain(f)) {
        if (!live) { out.plain += 1; continue; }
        convert(f, '', key);
        out.encrypted += 1;
      } else if (live && old) {                                            // a key change is in hand: move old copies across
        if (readable(f, key)) continue;
        if (!readable(f, old)) { out.foreign += 1; continue; }
        convert(f, old, key);
        out.rekeyed += 1;
      } else if (!status.encrypted) out.foreign += 1;                       // encrypted copies, but the site itself is not
    } catch (e) {
      console.error(`[database key] could not convert ${path.basename(f)}: ${e.message}`);
      if (fs.existsSync(f) && isPlain(f)) out.plain += 1; else out.foreign += 1;
    }
  }
  return out;
}

/** The key the live database is open with ('' when it is not encrypted). For checking copies of it; never to be shown, logged or stored. */
const keyInUse = () => liveKey;

module.exports = {
  KeyProblem, Stopped, MIN_KEY, BACKUP, PART, TURN, open, connect, isPlain, readable, rekey, alignCopies,
  inspect, snapshot, clear, backupsIn, damage, beforeUpdate, keyInUse, settled,
};
