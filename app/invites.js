'use strict';
// Emailing sign-in details. One person when they are added, or many at once from the Send sign-in details page.
//
// Many at once runs in the background, one message at a time with a short gap between them (mail services limit
// how fast one sender may send), so the page that started it answers straight away. A person's temporary password is
// made the moment before their own message goes: if the run is cut short (the site restarting, say), everyone not
// reached yet is exactly as they were and can simply be sent again.
const db = require('./db');
const auth = require('./auth');
const mail = require('./mail');
const config = require('./config');
const activity = require('./activity');

let run = null;   // the latest run: { by, total, sent, failed: [names], startedAt, finishedAt }
const KEEP_MS = 60 * 60 * 1000;   // how long a finished run's result stays on the page

/** The run in progress, or the one that finished within the last hour; otherwise nothing. */
const status = () => (run && (!run.finishedAt || Date.now() - run.finishedAt < KEEP_MS) ? run : null);
const busy = () => Boolean(run && !run.finishedAt);
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Give one person a fresh temporary password and email it to them. True when the message went.
 * Someone who was switched off (on the contact list, never given a sign-in) is switched on once it has gone.
 * Nothing is sent to an account that has been removed, has no email, or has already chosen its own password.
 */
async function sendTo(userId, site, actor) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || u.removed_at || !u.email || !u.must_change_password || !mail.isConfigured()) return false;
  const password = auth.issueTemp(u.id);
  auth.endSessions(u.id);
  const ok = await mail.sendWelcome(u, password, site, actor && actor.display_name);
  if (!ok) return false;
  db.prepare('UPDATE users SET invited_at = ? WHERE id = ?').run(new Date().toISOString(), u.id);
  if (!u.active) {
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(u.id);
    activity.log(actor, 'Account enabled', `${u.display_name}, with their sign-in details`);
  }
  return true;
}

/** Start sending to these people in the background. Returns the run, whose numbers move as it goes. */
function start(people, site, actor) {
  const mine = { by: actor.display_name, total: people.length, sent: 0, failed: [], startedAt: Date.now(), finishedAt: null };
  run = mine;
  (async () => {
    for (let i = 0; i < people.length; i++) {
      if (i && config.inviteGapMs) await wait(config.inviteGapMs);
      let ok = false;
      try { ok = await sendTo(people[i].id, site, actor); } catch (err) { console.error(`[invites] ${err.message}`); }
      if (ok) mine.sent += 1; else mine.failed.push(people[i].display_name);
    }
    mine.finishedAt = Date.now();
    activity.log(actor, 'Sign-in details emailed', `${mine.sent} of ${mine.total} ${mine.total === 1 ? 'person' : 'people'}${mine.failed.length ? '. Not sent: ' + mine.failed.join(', ') : ''}`.slice(0, 300));
  })();
  return mine;
}

module.exports = { status, busy, sendTo, start };
