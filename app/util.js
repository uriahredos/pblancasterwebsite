'use strict';
const config = require('./config');

const dtFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
});
const hourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone, hour: 'numeric', hourCycle: 'h23',
});

/** "11/12/2026, 3:04 PM" in the app timezone. */
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dtFmt.format(d);
}

/** "2026-11-12" -> "11/12/2026" */
function fmtDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : '';
}

/** YYYY-MM-DD in the app timezone. */
function localDate(d = new Date()) {
  return dateFmt.format(d);
}

function localHour(d = new Date()) {
  return Number(hourFmt.format(d));
}

function isYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Entries brought in from the old form start their note with a fixed sentence. Show that as a tag, not as text. */
function splitNote(note) {
  const m = /^Imported from Microsoft Forms \(response (\d+)\)\.?\s*/.exec(note || '');
  return m ? { imported: m[1], text: note.slice(m[0].length).trim() } : { imported: null, text: (note || '').trim() };
}

const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

const labels = {
  action: { take: 'Take parts', return: 'Return parts', request: 'Request parts' },
  source: { van: 'Van stock', job: 'Job' },
  partsStatus: { new: 'New', ordered: 'Ordered', fulfilled: 'Fulfilled', declined: 'Declined' },
  trainingStatus: { new: 'New', reviewed: 'Reviewed', scheduled: 'Scheduled', completed: 'Completed', declined: 'Declined' },
  complaintStatus: { new: 'New', under_review: 'Under review', resolved: 'Resolved', closed: 'Closed' },
  complaintCategory: {
    safety: 'Safety', conduct: 'Conduct / harassment', management: 'Management',
    equipment: 'Equipment / vehicle', other: 'Other',
  },
};

/** 4500 -> "4,500"; 4500.5 -> "4,500.50". Cents show only when there are any. */
const money = (n) => { const v = Math.round(Number(n || 0) * 100) / 100; return v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); };

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
/** Other words an office can be found by when someone types in a search box: its town, its state spelled out, its region. */
const officeWords = (b) => [b.city, STATES[String(b.state || '').toUpperCase()], b.region, b.marketing_name].filter(Boolean).join(' ');

module.exports = { officeWords, money, splitNote, fmtDateTime, fmtDate, localDate, localHour, isYmd, clean, labels };
