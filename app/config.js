'use strict';
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const production = env.NODE_ENV === 'production';

if (production && !env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production.');
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

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
  mailFrom: env.MAIL_FROM || 'Pye-Barker Lancaster Branch Portal <portal@localhost>',
  notifyTo: list(env.NOTIFY_TO),
  complaintNotifyTo: list(env.COMPLAINT_NOTIFY_TO),
  complaintDigestHour: env.COMPLAINT_DIGEST_HOUR === undefined ? 17 : Number(env.COMPLAINT_DIGEST_HOUR),
  complaintDailyLimit: 5,
  maxPhotoBytes: 10 * 1024 * 1024,
  minPasswordLength: 10,
};
