'use strict';

function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Stop spreadsheet programs from treating user-typed text as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** rows: array of arrays. Returns CSV text with a BOM so Excel reads it as UTF-8. */
function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * rows: an array of arrays, or anything that hands the rows out one at a time (see rowsFrom). The file is put
 * together a piece at a time, so a very large export is never held in memory several times over.
 */
function sendCsv(res, filename, header, rows) {
  const line = (r) => r.map(cell).join(',') + '\r\n';
  const pieces = []; let text = '\ufeff' + line(header); let count = 0;
  for (const r of rows) {
    text += line(r); count += 1;
    if (text.length > 512 * 1024) { pieces.push(Buffer.from(text, 'utf8')); text = ''; }
  }
  pieces.push(Buffer.from(text, 'utf8'));
  // A spreadsheet is a lot of records leaving the site at once, so every one is written down: who, which and how much.
  const who = res.req && res.req.user;
  if (who) require('./activity').log(who, 'Spreadsheet exported', `${filename}, ${count} ${count === 1 ? 'row' : 'rows'}`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // An ordinary export goes out in one go, as it always has. A very large one is handed over piece by piece, so a
  // second full copy of it is never made.
  if (pieces.length === 1) return res.send(pieces[0]);
  res.setHeader('Content-Length', pieces.reduce((n, b) => n + b.length, 0));
  for (const b of pieces) res.write(b);
  res.end();
}

/** Rows for sendCsv read straight from the database, one at a time: `toRow` turns each record into its list of cells. */
function* rowsFrom(records, toRow) {
  for (const r of records) yield toRow(r);
}

module.exports = { toCsv, sendCsv, rowsFrom };
