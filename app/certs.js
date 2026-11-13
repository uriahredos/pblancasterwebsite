'use strict';
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const { localDate, fmtDate } = require('./util');

const SOON_DAYS = 60;

/** Whole days from today until a YYYY-MM-DD date (negative when past). */
function daysUntil(ymd, today = localDate()) {
  return Math.round((new Date(ymd + 'T12:00:00Z') - new Date(today + 'T12:00:00Z')) / 86400000);
}

/** 'none' (no expiry date), 'expired', 'soon' (within 60 days) or 'ok'. */
function status(cert, today = localDate()) {
  if (!cert.expires_on) return 'none';
  const d = daysUntil(cert.expires_on, today);
  return d < 0 ? 'expired' : d <= SOON_DAYS ? 'soon' : 'ok';
}

function decorate(cert, today = localDate()) {
  cert.status = status(cert, today);
  cert.days = cert.expires_on ? daysUntil(cert.expires_on, today) : null;
  return cert;
}

/** Email each person once at 30 days and once at 7 days before one of their certifications expires. */
async function runReminders(now = new Date()) {
  const today = localDate(now);
  const rows = db.prepare(
    `SELECT c.*, u.display_name, u.email FROM certifications c JOIN users u ON u.id = c.user_id
     WHERE u.active = 1 AND c.expires_on IS NOT NULL AND (c.reminded_30 = 0 OR c.reminded_7 = 0)`).all();
  let sent = 0;
  for (const c of rows) {
    const d = daysUntil(c.expires_on, today);
    if (d < 0 || d > 30) continue;
    const stage = d <= 7 ? 'reminded_7' : 'reminded_30';
    if (c[stage]) continue;
    // Mark first so a mail problem cannot cause the same reminder every few hours.
    db.prepare(`UPDATE certifications SET ${stage} = 1${stage === 'reminded_7' ? ', reminded_30 = 1' : ''} WHERE id = ?`).run(c.id);
    if (c.email && await mail.send([c.email], `${c.name} expires ${d === 0 ? 'today' : 'in ' + d + (d === 1 ? ' day' : ' days')}`,
      `Hi ${c.display_name},\n\nYour ${c.name} expires on ${fmtDate(c.expires_on)}.\n\nOnce it is renewed, give the new date to your manager so the record can be updated.\n\n${config.baseUrl}/my\n`)) sent++;
  }
  return sent;
}

function start() {
  const tick = () => runReminders().catch((e) => console.error('[certs] reminders failed:', e.message));
  setTimeout(tick, 2 * 60 * 1000).unref();
  setInterval(tick, 6 * 60 * 60 * 1000).unref();
}

module.exports = { SOON_DAYS, daysUntil, status, decorate, runReminders, start };
