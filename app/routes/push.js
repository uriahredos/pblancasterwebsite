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
    devices: push.liveDevices(req.user.id),      // the devices that get alerts now: switched on, and still signed in
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

// Alerts are only ever sent to the phone makers' own alert services (Google, Apple, Mozilla,
// Microsoft), so nobody can register some other address and have this server call it.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
function pushHost(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && !u.username && !u.port && PUSH_HOSTS.test(u.hostname); } catch (e) { return false; }
}

// A phone or browser that has just been allowed to show alerts registers itself here.
router.post('/push/subscribe', requireLogin, (req, res) => {
  const endpoint = clean(req.body.endpoint, 1000);
  const p256dh = clean(req.body.p256dh, 200);
  const auth = clean(req.body.auth, 100);
  if (!pushHost(endpoint) || !/^[A-Za-z0-9_-]{20,}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,}$/.test(auth)) return res.status(400).json({ ok: false });
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at, sid) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, sid = excluded.sid`
  ).run(req.user.id, endpoint, p256dh, auth, clean(req.body.device, 60) || 'This device', new Date().toISOString(), req.sessionID);
  res.json({ ok: true });
});

// Every signed-in page on a device that already allows alerts calls this by itself (see site.js). If that device's
// registration is this person's own, it now belongs to the sign-in they are using, so their alerts carry on after signing
// in again with nothing to press. Somebody else's registration is left as it is: the next person at a shared computer
// does not inherit the last person's alerts. Turning alerts on is the only way to take a device over.
router.post('/push/attach', requireLogin, (req, res) => {
  const mine = db.prepare('UPDATE push_subscriptions SET sid = ? WHERE endpoint = ? AND user_id = ?').run(req.sessionID, clean(req.body.endpoint, 1000), req.user.id).changes > 0;
  res.json({ ok: mine });
});

router.post('/push/unsubscribe', requireLogin, (req, res) => {
  if (req.body.id) db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(req.body.id, req.user.id);
  else db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(clean(req.body.endpoint, 1000), req.user.id);
  if (req.body.id) { flash(req, 'ok', 'Alerts turned off for that device.'); return res.redirect('/settings/notifications'); }
  res.json({ ok: true });
});

router.post('/push/test', requireLogin, async (req, res) => {
  // A test goes out whatever is ticked, so it always proves the device works.
  const sent = await push.notify([req.user.id], 'test', { title: 'Test alert', body: 'Alerts are working on this device.', url: '/settings/notifications' });
  flash(req, sent ? 'ok' : 'err', sent ? `Test alert sent to ${sent} ${sent === 1 ? 'device' : 'devices'}. It should appear within a few seconds.` : 'No device has alerts turned on yet. Turn them on above first.');
  res.redirect('/settings/notifications');
});

module.exports = router;
