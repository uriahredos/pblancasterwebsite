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

function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(header, rows));
}

module.exports = { toCsv, sendCsv };
