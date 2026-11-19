'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');
const sealed = require('./sealed');
const jpeg = require('./jpeg');

const uploadDir = path.join(config.dataDir, 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// ---- Receiving files -------------------------------------------------------------------------------------
// Every form that stores a file takes it in through receive(). That one place:
//   - refuses the file, with one plain sentence, when the data disk is nearly full, so that signing in and ordinary
//     saves keep the room that is left;
//   - takes the hidden details (where, when, which phone) out of a JPEG photo the moment it has arrived;
//   - removes the request's files again when the form is refused: an expired form, a mistake in it, any error;
//   - seals the files once the form has been accepted, when encryption is on (see further down).
// From the moment a file is given its name until its request has been answered it is "in flight": it belongs to that
// request alone, and the background pass over the folder leaves it be however long the upload takes.

const MB = 1024 * 1024;
const NO_ROOM = 'The site is almost out of storage space, so photos and files cannot be added right now; please tell your admin.';
const realDisk = (dir) => fs.statfsSync(dir);
let disk = realDisk;
/** Tests stand in for the disk; null goes back to the real one. */
function useDisk(fake) { disk = fake || realDisk; }
let saidFullAt = 0;
/** Is there room for another file? Nearly full means less free than 5% of the disk (never asking for more than 500 MB) or less than 50 MB. */
function hasRoom() {
  try {
    const s = disk(config.dataDir);
    const free = Number(s.bavail) * Number(s.bsize), size = Number(s.blocks) * Number(s.bsize);
    if (!(free >= 0) || !(size > 0)) return true;
    if (free >= Math.max(50 * MB, Math.min(size * 0.05, 500 * MB))) return true;
    if (Date.now() - saidFullAt > 60 * 60 * 1000) { saidFullAt = Date.now(); console.warn(`[files] The data disk is nearly full (${Math.round(free / MB)} MB free). New photos and files are being refused until there is more room.`); }
    return false;
  } catch (e) { return true; }                                 // if the disk cannot be asked, assume there is room: never refuse over the check itself
}

const records = new WeakMap();                                 // request -> the files it has stored so far
const inFlight = new Set();                                    // names that belong to a request not yet answered
const leaving = new Set();                                     // names in the middle of being deleted
// A newsletter's page pictures (nl-...-3.jpg) are drawn while its PDF is still in flight, and belong to the same request.
const busy = (name) => inFlight.has(name) || leaving.has(name) || inFlight.has(name.replace(/-\d+\.jpg$/, '.pdf'));

/** What this request has stored. The first time it is asked for, the request is watched until it is answered. */
function recordOf(req) {
  let rec = records.get(req);
  if (rec) return rec;
  rec = { names: [], settled: false };
  records.set(req, rec);
  // The moment the route answers is the moment it is known whether the form was accepted.
  const res = req.res, end = res.end;
  res.end = function (...args) {
    try { settle(rec, res.statusCode); } catch (e) { console.error(`[files] ${e.message}`); }   // whatever happens here, the answer still goes out
    return end.apply(this, args);
  };
  // A request that is never answered at all: after a while let go of its names, deleting nothing.
  res.once('close', () => { if (!rec.settled) setTimeout(() => { if (!rec.settled) { rec.settled = true; rec.names.forEach((n) => inFlight.delete(n)); listed = null; } }, 10 * 60 * 1000).unref(); });
  return rec;
}

// Where the database keeps the names of stored files.
const KEPT_IN = [['wall_photos', 'path'], ['forum_photos', 'path'], ['inspection_photos', 'path'], ['parts_submissions', 'photo_path'],
  ['users', 'photo_path'], ['branches', 'photo_path'], ['sales_files', 'path'], ['newsletters', 'pdf_path']];
/** Does the database already point at this file? When that cannot be told, the answer is yes, so the file is kept. */
function inDatabase(name) {
  try {
    const db = require('./db');
    return KEPT_IN.some(([table, column]) => db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(name)) ||
      Boolean(db.prepare('SELECT 1 FROM newsletters WHERE page_files LIKE ? LIMIT 1').get(`%"${name}"%`));
  } catch (e) { return true; }
}

/** The request has been answered. Refused (an expired form, a mistake, an error): its files go. Accepted: they are sealed. */
function settle(rec, status) {
  if (rec.settled) return;
  rec.settled = true;
  const { current } = keys();
  for (const name of rec.names) {
    inFlight.delete(name);
    if (leaving.has(name)) continue;                            // the route has already dropped it
    // An error after the form was saved must not take away a photo the database now points at: that one is kept, and sealed like any other.
    if (status >= 400 && (status < 500 || !inDatabase(name))) { remove(name); continue; }
    if (!current) continue;
    try { sealed.seal(path.join(uploadDir, name), current); seen.set(name, 'sealed'); } catch (e) {
      if (e.code === 'ENOENT') continue;                        // not kept by the route after all
      console.error(`[files] could not seal ${name}: ${e.message}`);
      seen.set(name, 'plain'); todo.push(name);                 // the background pass tries again
    }
  }
}

/** Files made from an upload while its request is still open (a newsletter's page pictures) are treated like the upload itself. */
function adopt(req, names) {
  const rec = records.get(req);
  if (!rec || rec.settled) return;
  for (const name of names) { rec.names.push(name); inFlight.add(name); }
}

/** A JPEG photo loses its hidden details as soon as it has arrived. Anything unexpected and the file stays exactly as it came. */
function lighten(file) {
  let tmp = null;
  try {
    const fd = fs.openSync(file.path, 'r');
    const head = Buffer.alloc(3);
    try { fs.readSync(fd, head, 0, 3, 0); } finally { fs.closeSync(fd); }
    if (head.toString('hex') !== 'ffd8ff') return;
    const original = fs.readFileSync(file.path);
    const lean = jpeg.strip(original);
    if (!lean || lean === original) return;
    tmp = file.path + '.sealing';
    fs.writeFileSync(tmp, lean);
    fs.renameSync(tmp, file.path);
    file.size = lean.length;
  } catch (e) {
    console.error(`[files] could not tidy ${path.basename(String(file && file.path))}: ${e.message}`);
    if (tmp) fs.rm(tmp, { force: true }, () => {});
  }
}

/**
 * Takes in the files of a form. options are multer's own (limits, fileFilter), plus name(file) for what to call the
 * stored file and `problem`, the place on the request where a refusal is left for the route (req.photoError by default).
 * Returns { single, array, any }, used as multer's are.
 */
function receive({ name, problem = 'photoError', fileFilter, ...rest }) {
  const upload = multer({
    ...rest,
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => { const stored = name(file); recordOf(req).names.push(stored); inFlight.add(stored); cb(null, stored); },
    }),
    fileFilter: (req, file, cb) => {
      if (!hasRoom()) { req[problem] = NO_ROOM; return cb(null, false); }
      return fileFilter ? fileFilter(req, file, cb) : cb(null, true);
    },
  });
  const then = (run) => (req, res, cb) => run(req, res, (err) => {
    if (!err) [].concat(req.file || [], Array.isArray(req.files) ? req.files : []).forEach(lighten);
    cb(err);
  });
  return { single: (field) => then(upload.single(field)), array: (field, max) => then(upload.array(field, max)), any: () => then(upload.any()) };
}

/** Middleware that accepts up to `max` photos in `field`. Problems are left in req.photoError rather than thrown. */
function photos(field, max) {
  const any = field === null;
  const upload = receive({
    name: (file) => crypto.randomBytes(16).toString('hex') + EXT[file.mimetype],
    limits: { fileSize: config.maxPhotoBytes, files: max, fields: 300 },
    fileFilter: (req, file, cb) => {
      if (EXT[file.mimetype]) return cb(null, true);
      req.photoError = 'Photos must be JPEG, PNG, WebP or GIF images.';
      cb(null, false);
    },
  });
  const run = any ? upload.any() : upload.array(field, max);
  return (req, res, next) => run(req, res, (err) => {
    if (err) {
      req.photoError = err.code === 'LIMIT_FILE_SIZE' ? 'A photo is larger than 10 MB.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `No more than ${max} photos.` : 'The photos could not be uploaded.';
    }
    req.body = req.body || {};
    // When the upload is refused part-way, multer has already removed what it saved.
    req.files = err ? [] : req.files || [];
    next();
  });
}

/** Check the file really is the image type it claims to be. */
function looksLikeImage(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  const hex = b.toString('hex');
  return hex.startsWith('ffd8ff') || hex.startsWith('89504e47') || b.toString('latin1', 0, 4) === 'GIF8' ||
    (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
}

/** Delete a stored file. While it is on its way out nothing else touches it. */
function remove(name) {
  if (!name) return;
  const base = path.basename(name);
  leaving.add(base); seen.delete(base); locked.delete(base);
  fs.rm(path.join(uploadDir, base), { force: true }, () => leaving.delete(base));
}

// ---- Encryption of what is stored here ------------------------------------------------------------------
// The files follow the database. When the database is encrypted (DB_KEY in the hosting settings), photos and
// documents are sealed too, under a key worked out from the same one, and opened again only as they are sent to
// someone allowed to see them. A copy of the folder, or the "Download all photos" archive, is unreadable without the key.

let state = null;
/** current: the key new files are sealed with (null when encryption is not on). all: every key the settings hold. off: asked to decrypt. */
function keys() {
  if (state) return state;
  const e = require('./db').encryption || {};
  const set = (name) => String(process.env[name] || '').trim();
  const off = /^(1|yes|true|on)$/i.test(set('DB_DECRYPT'));
  const all = [set('DB_KEY'), set('DB_KEY_OLD')].filter(Boolean).map(sealed.keyFrom);
  const on = Boolean(e.encrypted && !e.usingOldKey && set('DB_KEY') && !off);
  state = { current: on ? all[0] : null, all, off: off && !e.encrypted };
  return state;
}
/** Tests set the keys directly; null goes back to what the settings say. */
function useKeys(next) { state = next; forgetAll(); }

/** Send a stored file to the browser, opening it first if it is sealed. `missing` runs when it is not there or cannot be opened. */
function send(res, name, headers, missing) {
  const gone = () => (missing ? missing() : res.status(404).end());
  const file = path.join(uploadDir, path.basename(String(name || '')));
  let isSealed;
  try { isSealed = sealed.isSealed(file); } catch (e) { return gone(); }
  if (!isSealed) return res.sendFile(path.basename(file), { root: uploadDir, headers: headers || {} }, (err) => { if (err && !res.headersSent) gone(); });
  let body;
  try { body = sealed.read(file, keys().all); } catch (e) {
    console.error(`[files] could not open ${path.basename(file)}: ${e.message}`);
    return gone();
  }
  res.set(headers || {});
  if (!res.get('Content-Type')) res.type(path.extname(file) || 'application/octet-stream');
  res.send(body);
}

// ---- The background pass ------------------------------------------------------------------------------------
// New files are sealed as their form is accepted (see settle above). The pass below is for everything else: the files
// that were already here when a key was first set, the move to a new key after a change, and opening them again when
// encryption is switched off. It never touches a file that is in flight, and it waits two minutes before sealing a
// file it did not see arrive.
//
// It remembers what it has already looked at, so a file is opened once and not again. That memory lasts until the
// site restarts. A pass with nothing to do asks the folder one question (has anything been added or removed?) and stops.
const SEAL_AFTER_MS = 2 * 60 * 1000;
const RELIST_MS = 60 * 60 * 1000;                             // list the folder again this often even if it says nothing changed
const seen = new Map();                                        // name -> what the file was when last looked at: 'sealed' (with the key in use), 'earlier' (another key the settings hold), 'unknown' (a key nobody has), 'plain', or 'other' (not a file)
const locked = new Set();                                      // the 'unknown' ones
let fresh = [];                                                // names from the last listing still to be looked at
let todo = [];                                                 // names waiting to be converted, in the order they were found
let next = 0;                                                  // how far through `todo` the passes have got
let listed = null;                                             // the folder's own "last changed" time at the last listing; null = list it again
let listedOn = 0;
function forgetAll() { seen.clear(); locked.clear(); fresh = []; todo = []; next = 0; listed = null; }

function kindOf(file, current, all) {
  const id = sealed.keyIdOf(file);
  if (!id) return 'plain';
  if (current && id.equals(current.id)) return 'sealed';
  return all.some((k) => k.id.equals(id)) ? 'earlier' : 'unknown';
}

/**
 * One pass over the folder: seal ordinary files, move files sealed under an earlier key to the one in use, or (when
 * encryption has been switched off) open them again. Looks at no more than `look` new names and works through at most
 * `limit` files, so the site is never held up. A file that fails uses up one of those turns and waits for a later pass.
 * Returns { sealed, moved, opened, left, stuck }: left = still to do; stuck = failed, or sealed with a key the settings do not hold.
 */
function tend({ minAgeMs = SEAL_AFTER_MS, limit = 20, look = 2000 } = {}) {
  const { current, all, off } = keys();
  const out = { sealed: 0, moved: 0, opened: 0, left: 0, stuck: 0 };
  const now = Date.now();
  // The folder is asked only when there is nothing left to work through (or it has been a long while): a backlog is
  // worked off from the list already made, however many passes that takes.
  if (!fresh.length && (next >= todo.length || now - listedOn > RELIST_MS)) {
    let changed, names;
    try { changed = fs.statSync(uploadDir).mtimeMs; } catch (e) { return out; }
    if (changed !== listed || now - listedOn > RELIST_MS) {
      try { names = fs.readdirSync(uploadDir); } catch (e) { return out; }
      const there = new Set(names);
      for (const name of seen.keys()) if (!there.has(name)) { seen.delete(name); locked.delete(name); }
      fresh = names.filter((name) => !seen.has(name));
      // A folder changed only a moment ago can change again without its time moving on: do not trust that time yet.
      listed = now - changed > 5000 ? changed : null;
      listedOn = now;
    }
  }
  const needsWork = (kind) => (kind === 'plain' ? Boolean(current) : kind === 'earlier' ? Boolean(current || off) : false);
  for (let looked = 0; fresh.length && looked < look;) {
    const name = fresh.pop();
    if (seen.has(name) || busy(name)) continue;
    looked += 1;
    const file = path.join(uploadDir, name);
    try {
      const st = fs.statSync(file);
      if (name.endsWith('.sealing')) { if (st.isFile() && now - st.mtimeMs > 10 * 60 * 1000) fs.rmSync(file, { force: true }); continue; }   // left by a stop half-way
      const kind = st.isFile() ? kindOf(file, current, all) : 'other';
      seen.set(name, kind);
      if (kind === 'unknown') locked.add(name);
      if (needsWork(kind)) todo.push(name);
    } catch (e) {
      if (e.code === 'ENOENT') continue;                        // removed while we looked
      out.stuck += 1;
      console.error(`[files] could not read ${name}: ${e.message}`);
    }
  }
  const later = [];
  for (let turns = 0; next < todo.length && turns < limit;) {
    const name = todo[next++];
    const kind = seen.get(name);
    if (!needsWork(kind) || busy(name)) continue;               // deleted, or dealt with, since it was found
    const file = path.join(uploadDir, name);
    turns += 1;
    try {
      if (kind === 'plain') {
        if (now - fs.statSync(file).mtimeMs < minAgeMs) { later.push(name); continue; }
        sealed.seal(file, current); seen.set(name, 'sealed'); out.sealed += 1;
      } else if (current) {                                     // sealed under the key from before a change
        sealed.reseal(file, all, current); seen.set(name, 'sealed'); out.moved += 1;
      } else {                                                  // encryption switched off: back to an ordinary file
        sealed.unseal(file, all); seen.set(name, 'plain'); out.opened += 1;
      }
    } catch (e) {
      if (e.code === 'ENOENT') { seen.delete(name); continue; }
      out.stuck += 1; later.push(name);
      console.error(`[files] could not convert ${name}: ${e.message}`);
    }
  }
  if (next > 1000 || next >= todo.length) { todo = todo.slice(next); next = 0; }
  for (const name of later) todo.push(name);
  out.left = todo.length - next + fresh.length;
  out.stuck += locked.size;
  return out;
}

/** How the folder stands, for the Security check: files in all, how many are sealed with the key in use, with an earlier key, with a key nobody has. */
function census() {
  const { current, all } = keys();
  const out = { files: 0, sealed: 0, earlier: 0, unknown: 0, plain: 0 };
  let names;
  try { names = fs.readdirSync(uploadDir); } catch (e) { return out; }
  for (const name of names) {
    if (name.endsWith('.sealing')) continue;
    try {
      let kind = seen.get(name);
      if (!kind) {                                              // not looked at yet by the background pass
        const file = path.join(uploadDir, name);
        if (!fs.statSync(file).isFile()) continue;
        kind = kindOf(file, current, all);
      }
      if (kind === 'other') continue;
      out.files += 1; out[kind] += 1;
    } catch (e) { /* removed while we looked */ }
  }
  return out;
}

/** Keep the folder in line with the key: a pass a minute, and every couple of seconds while there is a backlog. */
function startTending() {
  const pass = () => {
    let again = 60 * 1000;
    try { const r = tend(); if (r.left && (r.sealed || r.moved || r.opened || fresh.length)) again = 2000; } catch (e) { console.error(`[files] ${e.message}`); }
    setTimeout(pass, again).unref();
  };
  setTimeout(pass, 15 * 1000).unref();
}

module.exports = { uploadDir, photos, receive, adopt, looksLikeImage, remove, send, tend, census, startTending, keys, useKeys, useDisk, hasRoom, NO_ROOM };
