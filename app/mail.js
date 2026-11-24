'use strict';
const nodemailer = require('nodemailer');
const config = require('./config');
const db = require('./db');
const access = require('./permissions');
const { localDate, localHour } = require('./util');

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    // On the other ports the connection starts in the clear and is then encrypted. Insist on that: mail is never sent, and the
    // password never given, over a connection the relay would not encrypt.
    requireTLS: config.smtp.port !== 465,
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
 *
 * The count is by date: each notice covers the whole days since the last one, up to and including yesterday. Nothing is
 * marked on a complaint when its notice goes, so the database never shows whether one arrived before or after that hour.
 *
 * Every office is counted. An office's notice goes to the people there who may read its complaints and have an email
 * address on their account, and to those who read complaints for every office. The COMPLAINT_NOTIFY_TO mailbox is the
 * first office's. Each address gets one email with its own total. Returns how many complaints were counted.
 */
async function runComplaintDigest(now = new Date()) {
  const today = localDate(now);
  if (localHour(now) < config.complaintDigestHour) return 0;
  const last = db.prepare("SELECT value FROM meta WHERE key = 'complaint_digest_date'").get();
  if (last && last.value === today) return 0;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('complaint_digest_date', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(today);
  const offices = new Map(db.prepare('SELECT branch_id, COUNT(*) AS n FROM complaints WHERE created_date >= ? AND created_date < ? GROUP BY branch_id')
    .all(last ? last.value : '', today).map((r) => [r.branch_id, r.n]));
  if (offices.size === 0) return 0;
  const total = [...offices.values()].reduce((a, b) => a + b, 0);
  const home = db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
  // Which offices each address hears about ('all' for someone who reads every office's complaints).
  const reach = new Map();
  const add = (address, office) => {
    const key = String(address).trim().toLowerCase();
    if (!key) return;
    const r = reach.get(key) || { address: String(address).trim(), offices: new Set() };
    r.offices.add(office); reach.set(key, r);
  };
  for (const address of config.complaintNotifyTo) add(address, home);
  // With no mail server there is nobody to work out: the people are only looked up when a notice can actually go.
  const people = transport ? db.prepare("SELECT * FROM users WHERE active = 1 AND email IS NOT NULL AND email <> ''").all() : [];
  for (const u of people) {
    const reviewer = access.loadAccess(u);
    if (access.can(reviewer, 'complaints.review')) add(u.email, reviewer.allBranches ? 'all' : u.branch_id);
  }
  for (const r of reach.values()) {
    const n = r.offices.has('all') ? total : [...r.offices].reduce((sum, office) => sum + (offices.get(office) || 0), 0);
    if (n === 0) continue;
    await send([r.address],
      n === 1 ? 'A new complaint was submitted' : `${n} new complaints were submitted`,
      `${n === 1 ? 'A new anonymous complaint is' : n + ' new anonymous complaints are'} waiting for review.\n\n` +
      `${config.baseUrl}/admin/complaints\n`);
  }
  return total;
}

function startComplaintDigest() {
  const timer = setInterval(() => runComplaintDigest().catch((e) => console.error(e)), 10 * 60 * 1000);
  timer.unref();
}

function notifyLowStock(parts) {
  const lines = parts.map((p) => `  ${p.part_number}  ${p.description || ''}  -  ${p.on_hand} on hand${p.assigned > 0 ? `, ${p.assigned} of them assigned to jobs` : ''}${p.min_level === null || p.min_level === undefined ? '' : ` (minimum ${p.min_level})`}`).join('\n');
  return send(config.notifyTo, parts.length === 1 ? `Low stock: ${parts[0].part_number}` : `Low stock: ${parts.length} parts`,
    `These parts are now low or out:\n\n${lines}\n\n${config.baseUrl}/admin/stock?low=1\n`);
}

/** Tell the person who sent a parts request or training request that someone acted on it. */
function notifyStatus(user, what, status, note, link) {
  if (!user || !user.email) return Promise.resolve(false);
  return send([user.email], `Your ${what} is now: ${status}`,
    `Hi ${user.display_name},\n\nYour ${what} was updated.\n\nStatus: ${status}\n${note ? 'Reply: ' + note + '\n' : ''}\n${config.baseUrl}${link}\n`);
}

module.exports = { isConfigured, notifyLowStock, notifyStatus, setTransport, send, notifyPartsRequest, notifyTraining, runComplaintDigest, startComplaintDigest };
