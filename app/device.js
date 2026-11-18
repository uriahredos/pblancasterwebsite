'use strict';
// Which kind of device a request comes from, for how long the site may sit unused before it locks.
// A phone or tablet is carried around and put down in trucks and on counters, so it locks sooner than a computer on a desk.
const config = require('./config');

const MOBILE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|Silk|Kindle|Tablet/i;
const DESK = /Windows NT|Macintosh|X11|Linux x86_64|CrOS/;
// Set by the page itself (theme.js) on a touch screen with no mouse. An iPad says it is a Mac; this is how it is told apart.
const TOUCH = /(?:^|;\s*)portal\.touch=1(?:;|$)/;

/** 'phone' (phones and tablets) or 'desktop'. Anything that is not plainly a desk computer counts as a phone: when unsure, lock sooner. */
function kind(req) {
  const h = (req && req.headers) || {};
  const ua = String(h['user-agent'] || '');
  if (h['sec-ch-ua-mobile'] === '?1' || MOBILE.test(ua) || TOUCH.test(String(h.cookie || ''))) return 'phone';
  return DESK.test(ua) ? 'desktop' : 'phone';
}

/** How long this device may sit unused before the site locks, in milliseconds. 0 = that timer is off. */
const lockAfterMs = (req) => config.lockAfterMs[kind(req)];

module.exports = { kind, lockAfterMs };
