'use strict';
// Taking the hidden details out of a JPEG photo: where and when it was taken, which phone took it, comments, the
// editing history, and anything tacked on after the picture. The picture itself is copied byte for byte; it is never
// decoded or compressed again, so it cannot lose quality here.
//
// One hidden detail is kept: which way up the picture goes. Phones store a photo as the sensor saw it and add a note
// saying "turn this a quarter turn"; without that note the picture would show sideways.
//
// The rule throughout is to do nothing when in doubt. If a file is not laid out the way a JPEG is expected to be,
// strip() returns null and the caller keeps the file exactly as it arrived.

const SOI = 0xd8, EOI = 0xd9, SOS = 0xda, DQT = 0xdb, DHT = 0xc4, DAC = 0xcc, DRI = 0xdd, DNL = 0xdc, COM = 0xfe;
const MAX_PIECES = 2000;                                     // a real photo has a few dozen; far more than that is not a photo to tidy
const isApp = (code) => code >= 0xe0 && code <= 0xef;
const isFrame = (code) => code >= 0xc0 && code <= 0xcf && code !== DHT && code !== 0xc8 && code !== DAC;
const startsWith = (body, text) => body.length >= text.length && body.toString('latin1', 0, text.length) === text;

/** The "which way up" value (1 to 8) from a photo's details block; 0 when it has none; null when the block cannot be read. */
function orientationOf(tiff) {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return null;
  const list = u32(4);
  if (list < 8 || list + 2 > tiff.length) return null;
  const count = u16(list);
  if (list + 2 + count * 12 > tiff.length) return null;
  for (let i = 0; i < count; i++) {
    const entry = list + 2 + i * 12;
    if (u16(entry) !== 0x0112) continue;
    const type = u16(entry + 2);
    if (u32(entry + 4) !== 1 || (type !== 3 && type !== 4)) return null;
    const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
    return value >= 1 && value <= 8 ? value : 0;
  }
  return 0;
}

/** A details block that says which way up the picture goes and nothing else. */
function orientationOnly(value) {
  const b = Buffer.alloc(36);
  b[0] = 0xff; b[1] = 0xe1; b.writeUInt16BE(34, 2);
  b.write('Exif\u0000\u0000', 4, 'latin1');
  b.write('MM', 10, 'latin1'); b.writeUInt16BE(42, 12); b.writeUInt32BE(8, 14);        // the block's own header
  b.writeUInt16BE(1, 18);                                                             // one entry:
  b.writeUInt16BE(0x0112, 20); b.writeUInt16BE(3, 22); b.writeUInt32BE(1, 24); b.writeUInt16BE(value, 28);
  return b;                                                                           // (the last four bytes stay zero: nothing follows)
}

/** Where the marker starting at `at` really is (extra FF bytes may come before it). Null when there is no marker here. */
function markerAt(buf, at) {
  if (at >= buf.length || buf[at] !== 0xff) return null;
  let m = at + 1;
  while (m < buf.length && buf[m] === 0xff) m += 1;
  return m < buf.length ? { code: buf[m], codeAt: m } : null;
}

/** The end of the piece whose marker code sits at `codeAt`, or -1 when its stated length does not fit in the file. */
function pieceEnd(buf, codeAt) {
  if (codeAt + 3 > buf.length) return -1;
  const length = buf.readUInt16BE(codeAt + 1);
  return length >= 2 && codeAt + 1 + length <= buf.length ? codeAt + 1 + length : -1;
}

/**
 * The same JPEG without its hidden details. Returns the buffer it was given when there is nothing to take out, a new
 * buffer when there was, and null when the file is not laid out as expected (keep the original).
 */
function strip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) return null;
  const out = Buffer.allocUnsafe(buf.length + 36);             // the result is never longer than this
  let used = 0;
  const keep = (from, to) => { used += buf.copy(out, used, from, to); };
  keep(0, 2);
  let at = 2, pieces = 0, frame = false, turned = false;

  // 1. Everything before the picture data: a run of labelled pieces, each saying how long it is.
  for (;;) {
    const mark = markerAt(buf, at);
    if (!mark || ++pieces > MAX_PIECES) return null;
    if (mark.code === SOS) break;
    const end = pieceEnd(buf, mark.codeAt);
    if (end < 0) return null;
    if (isApp(mark.code) || mark.code === COM) {
      const body = buf.subarray(mark.codeAt + 3, end);
      // Kept: the basic header, the colour profile and the colour note some editors add. Colours depend on them, and they say nothing about a person.
      const needed = (mark.code === 0xe0 && startsWith(body, 'JFIF\u0000')) || (mark.code === 0xe2 && startsWith(body, 'ICC_PROFILE\u0000')) || (mark.code === 0xee && startsWith(body, 'Adobe'));
      if (needed) keep(at, end);
      else if (mark.code === 0xe1 && startsWith(body, 'Exif\u0000\u0000')) {
        const value = orientationOf(body.subarray(6));
        if (value === null) return null;
        if (value > 1 && !turned) { used += orientationOnly(value).copy(out, used); turned = true; }
      }
    } else if (mark.code === DQT || mark.code === DHT || mark.code === DAC || mark.code === DRI || isFrame(mark.code)) {
      if (isFrame(mark.code)) frame = true;
      keep(at, end);
    } else return null;
    at = end;
  }
  if (!frame) return null;

  // 2. The picture data. It is followed to its end marker so that anything after the picture (a second picture, a short
  // video) is left off. If the data cannot be followed with certainty, the whole rest of the file is kept as it is.
  const rest = at, usedBefore = used;
  let from = at, ended = false;
  for (pieces = 0; ++pieces <= MAX_PIECES;) {
    const mark = markerAt(buf, at);
    if (!mark) break;
    if (mark.code === EOI) { keep(from, mark.codeAt + 1); ended = true; break; }
    const end = pieceEnd(buf, mark.codeAt);
    if (end < 0) break;
    if (mark.code === SOS) {
      // Inside the data an FF byte is always followed by 00 or by a restart marker; anything else is the next piece.
      let next = end;
      for (;;) {
        next = buf.indexOf(0xff, next);
        if (next < 0 || next + 1 >= buf.length) { next = -1; break; }
        const follows = buf[next + 1];
        if (follows === 0x00 || (follows >= 0xd0 && follows <= 0xd7)) next += 2;
        else if (follows === 0xff) next += 1;
        else break;
      }
      if (next < 0) break;
      at = next;
    } else if (isApp(mark.code) || mark.code === COM) {
      keep(from, at);
      from = at = end;
    } else if (mark.code === DQT || mark.code === DHT || mark.code === DAC || mark.code === DRI || mark.code === DNL) at = end;
    else break;
  }
  if (!ended) { used = usedBefore; keep(rest, buf.length); }
  const result = out.subarray(0, used);
  return result.equals(buf) ? buf : result;
}

module.exports = { strip, orientationOf };
