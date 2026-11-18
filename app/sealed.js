'use strict';
// Encrypting a single file where it lies: the photos and documents people upload.
//
// A sealed file is: 8 bytes that say so, 4 bytes naming the key that sealed it, a 12-byte nonce, the encrypted
// contents (AES-256-GCM) and a 16-byte check. The file's own name is part of what the check covers, so one sealed
// file cannot be passed off as another, and any change to the bytes is noticed when it is opened.
//
// The key is worked out from the database key (DB_KEY) and is never stored anywhere.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('PBSEAL1\u0000', 'latin1');
const HEAD = MAGIC.length + 4 + 12;                       // marker, key id, nonce
const TAG = 16;

/** The 32-byte file key that goes with a database key. Same key in, same key out, so nothing extra has to be kept safe. */
function keyFrom(dbKey) {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(dbKey), 'utf8'), Buffer.from('pb-portal uploads', 'utf8'), Buffer.from('file encryption v1', 'utf8'), 32));
  return { key, id: crypto.createHash('sha256').update(key).digest().subarray(0, 4) };
}

function isSealed(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(MAGIC.length); return fs.readSync(fd, b, 0, MAGIC.length, 0) === MAGIC.length && b.equals(MAGIC); }
  finally { fs.closeSync(fd); }
}

/** Which key sealed this file (4 bytes), or null for an ordinary file. */
function keyIdOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(MAGIC.length + 4);
    if (fs.readSync(fd, b, 0, b.length, 0) !== b.length || !b.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    return b.subarray(MAGIC.length);
  } finally { fs.closeSync(fd); }
}

const about = (file) => Buffer.from(path.basename(file), 'utf8');

function encrypt(plain, k, file) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k.key, nonce);
  c.setAAD(Buffer.concat([MAGIC, k.id, about(file)]));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, k.id, nonce, body, c.getAuthTag()]);
}

function decrypt(blob, keys, file) {
  if (blob.length < HEAD + TAG || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a sealed file');
  const id = blob.subarray(MAGIC.length, MAGIC.length + 4);
  const k = keys.find((x) => x && x.id.equals(id));
  if (!k) throw new Error('sealed with a key that is not in the settings');
  const d = crypto.createDecipheriv('aes-256-gcm', k.key, blob.subarray(MAGIC.length + 4, HEAD));
  d.setAAD(Buffer.concat([MAGIC, id, about(file)]));
  d.setAuthTag(blob.subarray(blob.length - TAG));
  return Buffer.concat([d.update(blob.subarray(HEAD, blob.length - TAG)), d.final()]);   // throws if a single byte was changed
}

/** The contents of a file as they were uploaded, whether it is sealed or not. */
function read(file, keys) {
  const blob = fs.readFileSync(file);
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC) ? decrypt(blob, keys, file) : blob;
}

/** Swap a file's contents for new ones without ever leaving a half-written file under its name. */
function replace(file, contents) {
  const tmp = file + '.sealing';
  fs.writeFileSync(tmp, contents);
  const fd = fs.openSync(tmp, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** Seal an ordinary file with this key. The result is opened again and compared before it replaces the original. */
function seal(file, k) {
  const plain = fs.readFileSync(file);
  if (plain.length >= MAGIC.length && plain.subarray(0, MAGIC.length).equals(MAGIC)) return false;
  const blob = encrypt(plain, k, file);
  if (!decrypt(blob, [k], file).equals(plain)) throw new Error('the sealed copy did not open again');
  replace(file, blob);
  return true;
}

/** Move a sealed file to another key (after the database key was changed). */
function reseal(file, keys, to) {
  const blob = fs.readFileSync(file);
  const plain = decrypt(blob, keys, file);
  const next = encrypt(plain, to, file);
  if (!decrypt(next, [to], file).equals(plain)) throw new Error('the re-sealed copy did not open again');
  replace(file, next);
}

/** Turn a sealed file back into an ordinary one (when encryption is switched off, or to open it somewhere else). */
function unseal(file, keys, into) {
  const plain = decrypt(fs.readFileSync(file), keys, file);
  if (into) fs.writeFileSync(into, plain); else replace(file, plain);
}

module.exports = { keyFrom, isSealed, keyIdOf, read, seal, reseal, unseal, encrypt, decrypt };
