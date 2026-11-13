'use strict';
const express = require('express');
const db = require('../db');
const push = require('../push');
const { requireLogin, flash } = require('../auth');
const { clean } = require('../util');

const router = express.Router();

router.get('/settings/notifications', requireLogin, (req, res) => {
  const kinds = push.kindsFor(req.user).map((k) => ({ ...k, on: push.wants(req.user.id, k.key) }));
  res.render('settings_notifications', {
    title: 'Notification settings', kinds, publicKey: push.vapid().publicKey,
    devices: db.prepare('SELECT id, device, endpoint, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(req.user.id),
  });
});

// Which kinds of alert this person wants. Unticked boxes are stored as "off".
router.post('/settings/notifications', requireLogin, (req, res) => {
  const ticked = new Set([].concat(req.body.kinds || []));
  const put = db.prepare('INSERT INTO push_prefs (user_id, kind, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled');
  db.transaction(() => { for (const k of push.kindsFor(req.user)) put.run(req.user.id, k.key, ticked.has(k.key) ? 1 : 0); })();
  flash(req, 'ok', 'Notification settings saved.');
  res.redirect('/settings/notifications');
});

// A phone or browser that has just been allowed to show alerts registers itself here.
router.post('/push/subscribe', requireLogin, (req, res) => {
  const endpoint = clean(req.body.endpoint, 1000);
  const p256dh = clean(req.body.p256dh, 200);
  const auth = clean(req.body.auth, 100);
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || !/^[A-Za-z0-9_-]{20,}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,}$/.test(auth)) return res.status(400).json({ ok: false });
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`
  ).run(req.user.id, endpoint, p256dh, auth, clean(req.body.device, 60) || 'This device', new Date().toISOString());
  res.json({ ok: true });
});

router.post('/push/unsubscribe', requireLogin, (req, res) => {
  if (req.body.id) db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(req.body.id, req.user.id);
  else db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(clean(req.body.endpoint, 1000), req.user.id);
  if (req.body.id) { flash(req, 'ok', 'Alerts turned off for that device.'); return res.redirect('/settings/notifications'); }
  res.json({ ok: true });
});

router.post('/push/test', requireLogin, async (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id);
  // A test goes out whatever is ticked, so it always proves the device works.
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(req.user.id);
  const sent = subs.length ? await push.notify([req.user.id], 'test', { title: 'Test alert', body: 'Alerts are working on this device.', url: '/settings/notifications' }) : 0;
  flash(req, sent ? 'ok' : 'err', sent ? `Test alert sent to ${row.n} ${row.n === 1 ? 'device' : 'devices'}. It should appear within a few seconds.` : 'No device has alerts turned on yet. Turn them on above first.');
  res.redirect('/settings/notifications');
});

module.exports = router;
