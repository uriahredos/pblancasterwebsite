'use strict';
// The company's office list, read from office_list.txt (one office per line, as exported:
// number, "City, ST - Street [- Division]", the town it is in, and its region).
const fs = require('fs');
const path = require('path');

const REGION = { 'Mid-West': 'Midwest' };
// What each office does, where it is and how to reach it, from the company's branch finder (office_details.json,
// keyed by office number). Only what every employee may see: nothing about accounting systems or acquisitions.
const DETAILS = JSON.parse(fs.readFileSync(path.join(__dirname, 'office_details.json'), 'utf8'));
// The company's service names and the short codes used for them on this site.
const SERVICES = [['FA', 'Fire Alarms & Detection'], ['FS', 'Fire Sprinklers'], ['FE', 'Fire Extinguishers'], ['SUP', 'Fire Suppression Systems'],
  ['SEC', 'Security'], ['PVM', 'Proactive Video Monitoring'], ['LSE', 'Life Safety Equipment'], ['MN', 'Mass Notification']];
const CODE = new Map(SERVICES.map(([code, name]) => [name, code]));

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
  const d = DETAILS[number] || {};
  return { number, labelCity, labelState, street, division, city, state, region: REGION[region] || region,
    services: (d.services || []).map((name) => CODE.get(name)).filter(Boolean),
    marketing: d.marketing || '', market: d.market || '', products: (d.products || []).join(', '), address: d.address || '', phone: d.phone || '' };
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

module.exports = { all, parseLine, SERVICES };
