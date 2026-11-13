'use strict';
const nodemailer = require('nodemailer');
const config = require('./config');
const db = require('./db');
const { localDate, localHour } = require('./util');

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

/** Tests (or another mail service) can swap in anything with sendMail(). */
function setTransport(t) { transport = t; }
const isConfigured = () => Boolean(transport);

/** Never throws: a mail problem must not break a form submission. */
async function send(to, subject, text, attachments) {
  if (!to || to.length === 0) return false;
  if (!transport) {
    console.log(`[mail] not configured, skipped: ${subject}`);
    return false;
  }
  try {
    await transport.sendMail({ from: config.mailFrom, to: to.join(', '), subject, text, attachments });
    return true;
  } catch (err) {
    console.error(`[mail] failed: ${subject}: ${err.message}`);
    return false;
  }
}

function notifyPartsRequest({ id, name, items, source, jobNumber, neededBy }) {
  const lines = items.map((i) => `  ${i.quantity} x ${i.part_name}`).join('\n');
  return send(config.notifyTo, `Parts request from ${name}`,
    `${name} requested parts.\n\n${lines}\n\nFor: ${source === 'job' ? 'Job ' + jobNumber : 'Van stock'}\n` +
    `Needed by: ${neededBy}\n\n${config.baseUrl}/admin/parts/${id}\n`);
}

function notifyTraining({ id, name, description, wantsContact, isPrivate }) {
  // Private requests: the text stays out of email.
  const body = isPrivate
    ? 'A private training request was submitted. Sign in to read it.'
    : `${name} submitted a training request.\n\n${description}\n\nWants to be contacted: ${wantsContact ? 'Yes' : 'No'}`;
  return send(config.notifyTo, isPrivate ? 'New private training request' : `Training request from ${name}`,
    `${body}\n\n${config.baseUrl}/admin/training/${id}\n`);
}

/**
 * Complaint notices go out once a day at a fixed hour and carry only a count,
 * so the arrival time of the email says nothing about when (or by whom) a
 * complaint was written.
 */
async function runComplaintDigest(now = new Date()) {
  const today = localDate(now);
  if (localHour(now) < config.complaintDigestHour) return 0;
  const last = db.prepare("SELECT value FROM meta WHERE key = 'complaint_digest_date'").get();
  if (last && last.value === today) return 0;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('complaint_digest_date', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(today);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM complaints WHERE notified = 0').get();
  if (n === 0) return 0;
  db.prepare('UPDATE complaints SET notified = 1 WHERE notified = 0').run();
  await send(config.complaintNotifyTo,
    n === 1 ? 'A new complaint was submitted' : `${n} new complaints were submitted`,
    `${n === 1 ? 'A new anonymous complaint is' : n + ' new anonymous complaints are'} waiting for review.\n\n` +
    `${config.baseUrl}/admin/complaints\n`);
  return n;
}

function startComplaintDigest() {
  const timer = setInterval(() => runComplaintDigest().catch((e) => console.error(e)), 10 * 60 * 1000);
  timer.unref();
}

function notifyLowStock(parts) {
  const lines = parts.map((p) => `  ${p.part_number}  ${p.description || ''}  -  ${p.on_hand} on hand (minimum ${p.min_level})`).join('\n');
  return send(config.notifyTo, parts.length === 1 ? `Low stock: ${parts[0].part_number}` : `Low stock: ${parts.length} parts`,
    `These parts are now at or below their minimum:\n\n${lines}\n\n${config.baseUrl}/admin/stock?low=1\n`);
}

/** Tell the person who sent a parts request or training request that someone acted on it. */
function notifyStatus(user, what, status, note, link) {
  if (!user || !user.email) return Promise.resolve(false);
  return send([user.email], `Your ${what} is now: ${status}`,
    `Hi ${user.display_name},\n\nYour ${what} was updated.\n\nStatus: ${status}\n${note ? 'Reply: ' + note + '\n' : ''}\n${config.baseUrl}${link}\n`);
}

module.exports = { isConfigured, notifyLowStock, notifyStatus, setTransport, send, notifyPartsRequest, notifyTraining, runComplaintDigest, startComplaintDigest };
