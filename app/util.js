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

module.exports = { fmtDateTime, fmtDate, localDate, localHour, isYmd, clean, labels };
