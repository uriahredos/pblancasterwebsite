'use strict';
const webpush = require('web-push');
const db = require('./db');
const config = require('./config');
const access = require('./permissions');

db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
-- A row only exists once someone changes a setting; no row means "on".
CREATE TABLE IF NOT EXISTS push_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
`);

/** Every kind of alert: who it is offered to (a permission, or null for everyone) and how it reads on the settings page. */
const KINDS = [
  { key: 'task_assigned', perm: null, group: 'For you', label: 'A task is given to me' },
  { key: 'critical_notice', perm: null, group: 'For you', label: 'A critical announcement is posted' },
  { key: 'request_status', perm: null, group: 'For you', label: 'My parts or training request is updated' },
  { key: 'forum_reply', perm: 'forum.use', group: 'For you', label: 'Someone replies in a discussion I follow' },
  { key: 'task_done', perm: 'tasks.assign', group: 'For what you manage', label: 'A task I assigned is marked done' },
  { key: 'parts_request', perm: 'parts.manage', group: 'For what you manage', label: 'Someone requests parts' },
  { key: 'truck_problem', perm: 'inspections.view', group: 'For what you manage', label: 'A truck problem is reported' },
  { key: 'low_stock', perm: 'stock.manage', group: 'For what you manage', label: 'A part drops to or below its minimum' },
];
const kindsFor = (user) => KINDS.filter((k) => !k.perm || access.can(user, k.perm));

/** The signing keys are made once and kept in the database, so there is nothing to configure. */
let keys = null;
function vapid() {
  if (keys) return keys;
  const get = (k) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) || {}).value;
  let publicKey = get('vapid_public'), privateKey = get('vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    put.run('vapid_public', publicKey); put.run('vapid_private', privateKey);
  }
  keys = { publicKey, privateKey };
  return keys;
}

// Tests swap this for a recorder.
let sender = (sub, payload) => {
  const k = vapid();
  const contact = /^https:\/\//.test(config.baseUrl) ? config.baseUrl : 'mailto:portal@localhost.invalid';
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload,
    { vapidDetails: { subject: contact, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 24 * 60 * 60 });
};
function setSender(fn) { sender = fn; }

const wants = (userId, kind) => {
  const row = db.prepare('SELECT enabled FROM push_prefs WHERE user_id = ? AND kind = ?').get(userId, kind);
  return !row || row.enabled === 1;
};

/**
 * Send an alert of this kind to these people, on every device they switched on,
 * unless they turned that kind off. Never throws and never holds up the page.
 */
function notify(userIds, kind, { title, body, url }) {
  const ids = [...new Set([].concat(userIds || []).filter(Boolean))];
  const payload = JSON.stringify({ title: String(title).slice(0, 120), body: String(body || '').slice(0, 300), url: url || '/', tag: kind });
  const jobs = [];
  for (const id of ids) {
    if (!wants(id, kind)) continue;
    for (const sub of db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(id)) {
      jobs.push(Promise.resolve().then(() => sender(sub, payload)).catch((err) => {
        // The phone or browser has dropped this subscription: forget it.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        else console.error('[push] could not send:', err && (err.statusCode || err.message));
      }));
    }
  }
  return Promise.all(jobs).then(() => jobs.length);
}

/** Active people who hold a permission and are allowed to see this person's records (and have alerts on). */
function peopleWith(perm, ownerId, exceptId) {
  return db.prepare('SELECT DISTINCT u.* FROM users u JOIN push_subscriptions s ON s.user_id = u.id WHERE u.active = 1').all()
    .map((u) => access.loadAccess(u))
    .filter((u) => u.id !== exceptId && access.can(u, perm) && (ownerId === undefined || access.canSee(u, ownerId)))
    .map((u) => u.id);
}

module.exports = { KINDS, kindsFor, vapid, notify, peopleWith, wants, setSender };
