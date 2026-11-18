'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');
const sealed = require('./sealed');

const uploadDir = path.join(config.dataDir, 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Middleware that accepts up to `max` photos in `field`. Problems are left in req.photoError rather than thrown. */
function photos(field, max) {
  const any = field === null;
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
    }),
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

const remove = (name) => { if (name) fs.rm(path.join(uploadDir, path.basename(name)), { force: true }, () => {}); };

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
function useKeys(next) { state = next; known.clear(); }

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

// Sealing happens a little after a file arrives, not in the upload itself: for its first two minutes a new file is
// still being checked, and a newsletter is still having its pages drawn from it.
const SEAL_AFTER_MS = 2 * 60 * 1000;
const known = new Set();                                       // names already under the key in use: nothing more to do with them
/**
 * One pass over the folder: seal ordinary files, move files sealed under an earlier key to the one in use, or (when
 * encryption has been switched off) open them again. Works through at most `limit` files so the site is never held up.
 * Returns { sealed, moved, opened, left, stuck }: left = still to do; stuck = sealed with a key the settings do not hold.
 */
function tend({ minAgeMs = SEAL_AFTER_MS, limit = 20 } = {}) {
  const { current, all, off } = keys();
  const out = { sealed: 0, moved: 0, opened: 0, left: 0, stuck: 0 };
  let names;
  try { names = fs.readdirSync(uploadDir); } catch (e) { return out; }
  const now = Date.now();
  let done = 0;
  for (const name of names) {
    if (known.has(name)) continue;
    const file = path.join(uploadDir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (name.endsWith('.sealing')) { if (now - st.mtimeMs > 10 * 60 * 1000) fs.rmSync(file, { force: true }); continue; }   // left by a stop half-way
      const id = sealed.keyIdOf(file);
      const have = id && all.some((k) => k.id.equals(id));
      if (!id) {                                                // an ordinary file
        if (!current) continue;
        if (now - st.mtimeMs < minAgeMs || done >= limit) { out.left += 1; continue; }
        sealed.seal(file, current); known.add(name); out.sealed += 1; done += 1;
      } else if (current && id.equals(current.id)) known.add(name);
      else if (!have) out.stuck += 1;
      else if (current) {                                       // sealed under the key from before a change
        if (done >= limit) { out.left += 1; continue; }
        sealed.reseal(file, all, current); known.add(name); out.moved += 1; done += 1;
      } else if (off) {                                         // encryption switched off: back to an ordinary file
        if (done >= limit) { out.left += 1; continue; }
        sealed.unseal(file, all); out.opened += 1; done += 1;
      }
    } catch (e) {
      out.stuck += 1;
      console.error(`[files] could not convert ${name}: ${e.message}`);
    }
  }
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
      const file = path.join(uploadDir, name);
      if (!fs.statSync(file).isFile()) continue;
      out.files += 1;
      if (known.has(name)) { out.sealed += 1; continue; }
      const id = sealed.keyIdOf(file);
      if (!id) out.plain += 1;
      else if (current && id.equals(current.id)) out.sealed += 1;
      else if (all.some((k) => k.id.equals(id))) out.earlier += 1;
      else out.unknown += 1;
    } catch (e) { /* removed while we looked */ }
  }
  return out;
}

/** Keep the folder in line with the key: a pass a minute, and every couple of seconds while there is a backlog. */
function startTending() {
  const pass = () => {
    let again = 60 * 1000;
    try { const r = tend(); if (r.left && (r.sealed || r.moved || r.opened)) again = 2000; } catch (e) { console.error(`[files] ${e.message}`); }
    setTimeout(pass, again).unref();
  };
  setTimeout(pass, 15 * 1000).unref();
}

module.exports = { uploadDir, photos, looksLikeImage, remove, send, tend, census, startTending, keys, useKeys };
