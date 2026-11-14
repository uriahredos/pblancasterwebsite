'use strict';
// The company's office list, read from office_list.txt (one office per line, as exported:
// number, "City, ST - Street [- Division]", the town it is in, and its region).
const fs = require('fs');
const path = require('path');

const REGION = { 'Mid-West': 'Midwest' };
// What the end of an office's label tells us about what it does. Only the unambiguous ones.
const HINTS = [[/security|\bsec\b/i, 'SEC'], [/sprinkler/i, 'SP'], [/fire alarm|\balarm\b/i, 'FA']];

function parseLine(line) {
  const m = /^(\d{4})(.+?) · (.+)$/.exec(line.trim());
  if (!m) return null;                                   // internal projects have no town or region: not offices
  const [, number, body, region] = m;
  const lead = /^([^,]+), ([A-Z]{2}) - /.exec(body);
  if (!lead) return null;
  const labelCity = lead[1], labelState = lead[2];
  // The line ends with the town the office is actually in, run straight on from the street.
  let label = body, city = labelCity, state = labelState;
  const tail = `${labelCity}, ${labelState}`;
  if (body.endsWith(tail) && body.length > tail.length) label = body.slice(0, -tail.length);
  else {
    const t = /^(.*(?:[a-z0-9)]|\b[A-Z]{1,4}))((?:[A-Z][A-Za-z.']*)(?: [A-Za-z.']+)*), ([A-Z]{2})$/.exec(body);
    // A different town (the office is named for one place and sits in the next one over) is kept;
    // a near-match is a typing slip in the list, so the office's own name wins.
    if (t) { label = t[1]; if (t[2].slice(0, 4).toLowerCase() !== labelCity.slice(0, 4).toLowerCase()) { city = t[2]; state = t[3]; } }
  }
  const parts = label.slice(lead[0].length).split(' - ').map((s) => s.trim()).filter(Boolean);
  const street = parts[0] || '';
  const division = parts.length > 1 ? parts[parts.length - 1] : '';
  return { number, labelCity, labelState, street, division, city, state, region: REGION[region] || region,
    services: HINTS.filter(([re]) => re.test(division)).map(([, code]) => code) };
}

/** Every office on the list, each with a short name that is unique. */
function all() {
  const rows = fs.readFileSync(path.join(__dirname, 'office_list.txt'), 'utf8').split('\n').map(parseLine).filter(Boolean);
  const byCity = new Map();
  for (const r of rows) { const k = r.labelCity; byCity.set(k, (byCity.get(k) || []).concat(r)); }
  const used = new Set();
  for (const r of rows) {
    const same = byCity.get(r.labelCity);
    let name = r.labelCity;
    if (same.length > 1) {
      const inState = same.filter((x) => x.labelState === r.labelState);
      name = inState.length === 1 ? `${r.labelCity}, ${r.labelState}` : `${r.labelCity} (${r.division || r.street})`;
    }
    if (used.has(name.toLowerCase())) name = `${name.replace(/\)$/, '')}${name.endsWith(')') ? ', ' : ' ('}${r.number})`;
    used.add(name.toLowerCase());
    r.name = name;
  }
  return rows;
}

module.exports = { all, parseLine };
