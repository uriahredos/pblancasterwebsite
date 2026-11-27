'use strict';
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const production = env.NODE_ENV === 'production';

if (production && !env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production.');
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
// A number of minutes from a setting. Anything that is not a plain number of zero or more falls back, so a typing mistake
// in the hosting settings cannot switch a timer off by accident; only a deliberate 0 does that.
const minutes = (v, fallback) => { const n = Number(v); return v === undefined || String(v).trim() === '' || !Number.isFinite(n) || n < 0 ? fallback : n; };

module.exports = {
  production,
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  baseUrl: (env.BASE_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  timezone: env.APP_TIMEZONE || 'America/New_York',
  bcryptRounds: Number(env.BCRYPT_ROUNDS) || 12,
  loginRateLimit: Number(env.LOGIN_RATE_LIMIT) || 10,
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  },
  mailFrom: env.MAIL_FROM || 'Pye-Barker Employee Portal <portal@localhost>',
  notifyTo: list(env.NOTIFY_TO),
  complaintNotifyTo: list(env.COMPLAINT_NOTIFY_TO),
  complaintDigestHour: env.COMPLAINT_DIGEST_HOUR === undefined ? 7 : Number(env.COMPLAINT_DIGEST_HOUR),
  complaintDailyLimit: 5,
  // How long someone may edit or cancel their own submission.
  editWindowHours: env.EDIT_WINDOW_HOURS === undefined ? 24 : Number(env.EDIT_WINDOW_HOURS),
  backupHour: env.BACKUP_HOUR === undefined ? 2 : Number(env.BACKUP_HOUR),
  backupKeep: Number(env.BACKUP_KEEP) || 14,
  backupEmailTo: list(env.BACKUP_EMAIL_TO),
  // The site locks (Face ID, fingerprint or password to get back in) after this long without use: sooner on a phone
  // or tablet than on a desk computer. Closing the site locks it at once. 0 switches that timer off.
  // LOCK_AFTER_MINUTES is the older single setting: where it is set, it stands in for whichever of the two is not.
  lockAfterMs: {
    phone: minutes(env.LOCK_AFTER_MINUTES_PHONE, minutes(env.LOCK_AFTER_MINUTES, 10)) * 60 * 1000,
    desktop: minutes(env.LOCK_AFTER_MINUTES_DESKTOP, minutes(env.LOCK_AFTER_MINUTES, 20)) * 60 * 1000,
  },
  maxPhotoBytes: 10 * 1024 * 1024,
  minPasswordLength: 10,
  // A temporary password handed out by an admin stops working after this many days.
  tempPasswordDays: Math.max(1, Number(env.TEMP_PASSWORD_DAYS) || 14),
  // Sign-in details emailed to many people go one at a time, this far apart: mail services limit how fast one sender may send.
  inviteGapMs: env.INVITE_GAP_MS === undefined || env.INVITE_GAP_MS === '' ? 2500 : Math.max(0, Number(env.INVITE_GAP_MS) || 0),
};
