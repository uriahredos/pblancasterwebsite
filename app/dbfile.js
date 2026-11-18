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
const Database = require('better-sqlite3-multiple-ciphers');

/** The database cannot be opened with what is in the settings. The data is untouched; the settings need putting right. */
class KeyProblem extends Error {}
/** A key change worked but its safety copy could not be cleared away. The site must not run with that copy lying about: a later start would put it back over newer data. */
class Leftover extends Error {}

const MIN_KEY = 20;
const PLAIN = Buffer.from('SQLite format 3\u0000', 'latin1');
const COPY = '.before-key-change';
const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const setting = (name) => String(process.env[name] || '').trim();
const switchedOff = () => /^(1|yes|true|on)$/i.test(setting('DB_DECRYPT'));

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

/**
 * Open the live database the way the settings say, encrypting or re-keying it first if that is what they ask for.
 * Returns { db, status }. Throws KeyProblem when the file is encrypted and the settings do not hold its key.
 */
function open(dataDir) {
  const file = path.join(dataDir, 'portal.db');
  const key = setting('DB_KEY'), old = setting('DB_KEY_OLD');
  const off = switchedOff();
  const usable = key.length >= MIN_KEY && !off;
  const status = { encrypted: false, changed: null, note: null, oldKeySet: Boolean(old), usingOldKey: false };
  if (off) status.note = 'DB_DECRYPT is set, so the database is being kept unencrypted. Remove DB_DECRYPT to encrypt it again.';
  else if (key && !usable) status.note = `DB_KEY is shorter than ${MIN_KEY} characters, so it is not being used.`;

  // A key change that was cut short (the server stopped half-way): go back to the copy made beforehand and start again.
  fs.rmSync(file + COPY + '.tmp', { force: true });
  restore(file);

  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {             // a new site: encrypted from its first page
    status.encrypted = usable;
    return { db: connect(file, usable ? key : ''), status };
  }

  if (isPlain(file)) {
    if (!usable) return { db: connect(file, ''), status };
    try { change(file, '', key); } catch (e) {
      if (e instanceof Leftover) throw e;
      status.note = `Encrypting the database did not work, so it was left exactly as it was (${e.message}).`;
      return { db: connect(file, ''), status };
    }
    status.encrypted = true; status.changed = 'encrypted';
    return { db: connect(file, key), status };
  }

  // The file is encrypted.
  status.encrypted = true;
  if (off) {                                                              // asked to turn encryption off: needs the key one last time
    const has = [key, old].find((k) => k && readable(file, k));
    if (has) {
      try { change(file, has, ''); status.encrypted = false; status.changed = 'decrypted'; return { db: connect(file, ''), status }; } catch (e) {
        if (e instanceof Leftover) throw e;
        status.note = `Decrypting the database did not work, so it is still encrypted (${e.message}).`;
        return { db: connect(file, has), status };
      }
    }
  }
  if (key && readable(file, key)) return { db: connect(file, key), status };
  if (old && readable(file, old)) {
    if (usable) {
      try { change(file, old, key); status.changed = 'rekeyed'; return { db: connect(file, key), status }; } catch (e) {
        if (e instanceof Leftover) throw e;
        status.note = `Changing the database key did not work, so the old key is still in use (${e.message}).`;
      }
    }
    status.usingOldKey = true;
    if (!usable) status.note = `The database is being opened with DB_KEY_OLD. Put the new key in DB_KEY (at least ${MIN_KEY} characters) to change over.`;
    return { db: connect(file, old), status };
  }
  throw new KeyProblem(key || old
    ? 'The database is encrypted with a different key from the one in the hosting settings (DB_KEY).'
    : 'The database is encrypted, and its key (DB_KEY) is missing from the hosting settings.');
}

/**
 * Bring stored copies of the database (the nightly backups) into line with the key in use: ones made before
 * encryption was switched on are encrypted, and after a key change ones under the old key are moved to the new one.
 * When encryption has been switched off they are decrypted. Returns how many were converted each way, and how many
 * are still unencrypted (plain) or locked with a key the settings do not hold (foreign).
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
        rekey(f, has, '');
        if (!isPlain(f)) throw new Error('still encrypted afterwards');
        out.decrypted += 1; out.plain += 1;
      } else if (isPlain(f)) {
        if (!live) { out.plain += 1; continue; }
        rekey(f, '', key);
        if (isPlain(f) || !readable(f, key)) throw new Error('did not open with the key afterwards');
        out.encrypted += 1;
      } else if (live && old) {                                            // a key change is in hand: move old copies across
        if (readable(f, key)) continue;
        if (!readable(f, old)) { out.foreign += 1; continue; }
        rekey(f, old, key);
        out.rekeyed += 1;
      } else if (!status.encrypted) out.foreign += 1;                       // encrypted copies, but the site itself is not
    } catch (e) {
      console.error(`[database key] could not convert ${path.basename(f)}: ${e.message}`);
      if (fs.existsSync(f) && isPlain(f)) out.plain += 1; else out.foreign += 1;
    }
  }
  return out;
}

module.exports = { KeyProblem, MIN_KEY, open, connect, isPlain, readable, rekey, alignCopies };
