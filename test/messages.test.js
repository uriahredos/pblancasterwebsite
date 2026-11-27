'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dm-'));
Object.assign(process.env, { DATA_DIR: dataDir, BCRYPT_ROUNDS: '4', LOGIN_RATE_LIMIT: '1000', APP_TIMEZONE: 'America/New_York', BASE_URL: 'http://portal.test', BACKUP_HOUR: '0', COMPLAINT_DIGEST_HOUR: '0' });
for (const m of ['log', 'warn', 'error']) console[m] = () => {};

const db = require('../app/db');
const auth = require('../app/auth');
const access = require('../app/permissions');
const push = require('../app/push');
const app = require('../app/app');

let server, base;
const alerts = [];
push.notify = (ids, kind, payload) => { alerts.push({ ids: [].concat(ids), kind, ...payload }); };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers } });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, text, json, location: res.headers.get('location') };
  }
  get(url, headers) { return this.req('GET', url, undefined, headers); }
  async csrf(page) { return /name="_csrf" value="([0-9a-f]+)"/.exec((await this.req('GET', page)).text)[1]; }
  async post(url, fields = {}, page = '/account/password', headers) { return this.req('POST', url, new URLSearchParams({ _csrf: await this.csrf(page), ...fields }), headers); }
  async login(u) { await this.post('/login', { username: u, password: 'correct horse battery' }, '/login'); return this; }
  async stream(topics) {
    const ctl = new AbortController();
    const res = await fetch(`${base}/live/stream?topics=${encodeURIComponent(topics)}`, { headers: { cookie: this.cookie }, signal: ctl.signal, redirect: 'manual' });
    const got = [];
    if (res.status === 200) (async () => { const dec = new TextDecoder(); try { for await (const ch of res.body) got.push(dec.decode(ch)); } catch (e) { /* closed */ } })(); else await res.arrayBuffer();
    return { status: res.status, text: () => got.join(''), close: () => ctl.abort() };
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return fn(); }
const idOf = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;

before(async () => {
  for (const [u, n] of [['ann', 'Ann Tech'], ['bob', 'Bob Tech'], ['cat', 'Cat Tech'], ['nomsg', 'Nora NoMessages']]) {
    const id = auth.createUser({ username: u, displayName: n, password: 'correct horse battery', profile: 'Technician' });
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  }
  // A reviewer: may read reported conversations, and sees every office.
  access.ensureProfile('Reviewer', 'all', [...access.SUBMIT, 'forum.use', 'messages.use', 'messages.review', 'branches.all', 'market.all']);
  const rid = auth.createUser({ username: 'rev', displayName: 'Rae Reviewer', password: 'correct horse battery', profile: 'Reviewer' });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(rid);
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT, 'forum.use', 'messages.use']);
  access.ensureProfile('No messages', 'all', [...access.SUBMIT, 'forum.use']);
  db.prepare('UPDATE users SET profile_id = ? WHERE username = ?').run(access.profileByName('No messages').id, 'nomsg');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

let convo;   // the conversation between ann and bob

test('messages: a person without the permission has no Messages page or link; signed-out visitors are sent to sign in', async () => {
  const n = await new Client().login('nomsg');
  assert.notEqual((await n.get('/messages')).status, 200);
  assert.doesNotMatch((await n.get('/')).text, /href="\/messages"/);
  assert.match((await new Client().get('/messages')).location, /^\/login/);
  const a = await new Client().login('ann');
  assert.match((await a.get('/')).text, /<a href="\/messages"[^>]*>Messages/);
  const bobPage = (await a.get(`/people/${idOf('bob')}`)).text;
  assert.match(bobPage, new RegExp(`href="/messages/with/${idOf('bob')}">[^]*?Message</a>`));
  assert.match(bobPage, new RegExp(`data-call-person="${idOf('bob')}" data-mode="audio"`)); assert.match(bobPage, /data-mode="video"/);
  assert.doesNotMatch((await a.get(`/people/${idOf('nomsg')}`)).text, /data-call-person/, 'no buttons for someone who cannot be reached');
});

test('messages: the first message makes the conversation; you cannot message yourself or someone who is no longer here', async () => {
  const a = await new Client().login('ann'), bobId = idOf('bob');
  assert.match((await a.get(`/messages/with/${bobId}`)).text, /Message Bob Tech/);
  assert.equal((await a.get(`/messages/with/${idOf('ann')}`)).status, 404);
  assert.equal((await a.post(`/messages/with/${bobId}`, { body: '' }, `/messages/with/${bobId}`)).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dm_threads').get().n, 0, 'nothing is made by an empty first message');
  const r = await a.post(`/messages/with/${bobId}`, { body: 'Can you look at the **panel** at the school?' }, `/messages/with/${bobId}`);
  assert.equal(r.status, 302); convo = Number(/\/messages\/c\/(\d+)$/.exec(r.location)[1]);
  assert.match((await a.get(r.location)).text, /Can you look at the <strong>panel<\/strong> at the school\?/);
  assert.match((await a.get(`/messages/with/${bobId}`)).location, new RegExp(`/messages/c/${convo}$`), 'the same one is found again');
  // The other person is alerted, with no words of the message on a locked screen.
  assert.equal(alerts.at(-1).kind, 'message'); assert.deepEqual(alerts.at(-1).ids, [bobId]);
  assert.ok(!JSON.stringify(alerts.at(-1)).includes('panel'));
  const gone = auth.createUser({ username: 'gone', displayName: 'Gus Gone', password: 'correct horse battery', profile: 'Technician' });
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone);
  assert.equal((await a.get(`/messages/with/${gone}`)).status, 404);
});

test('messages: only the two people can read a conversation, or watch it live; everyone else is told nothing', async () => {
  const c = await new Client().login('cat'), rev = await new Client().login('rev');
  for (const who of [c, rev]) {
    assert.equal((await who.get(`/messages/c/${convo}`)).status, 404);
    assert.equal((await who.post(`/messages/c/${convo}/send`, { body: 'hello' }, '/messages')).status, 404);
    assert.equal((await who.stream(`dm:${convo}`)).status, 403);
    assert.equal((await who.stream(`inbox:${idOf('ann')}`)).status, 403);
    assert.doesNotMatch((await who.get('/messages')).text, /Ann Tech|Bob Tech/);
  }
  assert.equal((await c.stream(`inbox:${idOf('cat')}`)).status, 200);
  const nm = await new Client().login('nomsg');
  assert.equal((await nm.stream(`inbox:${idOf('nomsg')}`)).status, 403, 'without the permission there is no stream either');
  assert.equal((await new Client().stream('dm:abc')).status, 401);
});

test('messages: unread counts, reading clears them, and a new message reaches the other person live', async () => {
  const a = await new Client().login('ann'), b = await new Client().login('bob');
  assert.match((await b.get('/')).text, /Messages <span class="badge"[^>]*>1<\/span>/);
  assert.match((await b.get('/messages')).text, /<li class="unread">[\s\S]*Ann Tech/);
  const sB = await b.stream(`dm:${convo}`), iB = await b.stream(`inbox:${idOf('bob')}`);
  assert.equal(sB.status, 200); await wait(100);
  const page = await b.get(`/messages/c/${convo}`);
  assert.match(page.text, /is-new/);
  assert.doesNotMatch((await b.get('/')).text, /Messages <span class="badge"/, 'read now');
  assert.equal((await b.post(`/messages/c/${convo}/send`, { body: 'On my way' }, `/messages/c/${convo}`, { 'x-requested-with': 'fetch' })).json.ok, true);
  const sA = await a.stream(`dm:${convo}`); await wait(100);
  assert.ok(await until(() => /event: update/.test(sB.text())), 'the sender\'s own screens hear too');
  await a.post(`/messages/c/${convo}/send`, { body: 'Great, thanks' }, '/messages');
  assert.ok(await until(() => /event: update/.test(sA.text()) && /event: update/.test(iB.text())), 'the other person hears in the conversation and in the inbox');
  assert.match((await a.get(`/messages/c/${convo}`)).text, /On my way[\s\S]*Great, thanks/);
  [sA, sB, iB].forEach((s) => s.close());
});

test('messages: a double tap is kept once; too many at once is slowed; a message that is not yours cannot be removed', async () => {
  const a = await new Client().login('ann');
  const before = db.prepare('SELECT COUNT(*) n FROM dm_messages').get().n;
  await a.post(`/messages/c/${convo}/send`, { body: 'twice' }, '/messages'); await a.post(`/messages/c/${convo}/send`, { body: 'twice' }, '/messages');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dm_messages').get().n, before + 1);
  const theirs = db.prepare('SELECT id FROM dm_messages WHERE user_id = ? LIMIT 1').get(idOf('bob')).id;
  assert.equal((await a.post(`/messages/m/${theirs}/delete`, {}, '/messages')).status, 404);
  const mine = db.prepare('SELECT id FROM dm_messages WHERE user_id = ? ORDER BY id LIMIT 1').get(idOf('ann')).id;
  assert.equal((await a.post(`/messages/m/${mine}/delete`, {}, '/messages')).status, 302);
  const text = (await a.get(`/messages/c/${convo}`)).text;
  assert.match(text, /Removed by the sender/); assert.doesNotMatch(text, /Can you look at the/);
  const fast = await new Client().login('cat'); let limited = 0;
  await fast.post(`/messages/with/${idOf('ann')}`, { body: 'hi' }, `/messages/with/${idOf('ann')}`);
  const cid = db.prepare('SELECT id FROM dm_threads WHERE user_a = ? OR user_b = ?').all(idOf('cat'), idOf('cat'))[0].id;
  for (let i = 0; i < 65; i++) if ((await fast.post(`/messages/c/${cid}/send`, { body: `m${i}` }, '/messages', { 'x-requested-with': 'fetch' })).status === 429) limited += 1;
  assert.ok(limited >= 4, `rate limited ${limited}`);
});

test('reports: the only way anyone else sees a conversation, only the one reported, and opening it is recorded', async () => {
  const a = await new Client().login('ann'), b = await new Client().login('bob'), rev = await new Client().login('rev');
  const fromAnn = db.prepare('SELECT id FROM dm_messages WHERE user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 1').get(idOf('ann')).id;
  assert.equal((await b.post(`/messages/m/${db.prepare('SELECT id FROM dm_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(idOf('bob')).id}/report`, {}, '/messages')).status, 404, 'you cannot report yourself');
  assert.equal((await rev.get('/admin/message-reports')).text.includes('Ann Tech'), false, 'nothing reported yet');
  assert.equal((await new Client().login('ann').then((c) => c.get('/admin/message-reports'))).status, 403);
  assert.equal((await b.post(`/messages/m/${fromAnn}/report`, { note: 'Rude' }, '/messages')).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dm_reports').get().n, 1);
  await b.post(`/messages/m/${fromAnn}/report`, { note: 'again' }, '/messages');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dm_reports').get().n, 1, 'one open report per message');
  assert.match((await rev.get('/')).text, /reported message to look at/, 'the reviewer is told one is waiting');

  const list = (await rev.get('/admin/message-reports')).text;
  assert.match(list, /Bob Tech[\s\S]*Ann Tech and Bob Tech|Ann Tech and Bob Tech/); assert.match(list, /Rude/);
  const rid = db.prepare('SELECT id FROM dm_reports').get().id;
  const view = (await rev.get(`/admin/message-reports/${rid}`)).text;
  assert.match(view, /On my way/); assert.match(view, /reported message/);
  assert.doesNotMatch(view, /m\d+" data-rev/);
  const rep = db.prepare('SELECT * FROM dm_reports WHERE id = ?').get(rid);
  assert.equal(rep.opened_by, idOf('rev')); assert.ok(rep.opened_at);
  const logged = db.prepare("SELECT user_id, detail FROM activity_log WHERE action = 'Opened a reported private conversation'").get();
  assert.equal(logged.user_id, idOf('rev')); assert.match(logged.detail, /Report \d+: Ann Tech and Bob Tech/);
  // The conversation itself is still not theirs: it is only reachable through the report.
  assert.equal((await rev.get(`/messages/c/${convo}`)).status, 404);
  // Written after the report: not the reviewer's to read. Removed after the report: still there for the reviewer, gone for the two people.
  const a2 = await new Client().login('ann');
  await a2.post(`/messages/c/${convo}/send`, { body: 'Said after the report' }, '/messages');
  await a2.post(`/messages/m/${fromAnn}/delete`, {}, '/messages');
  const fromAnnText = db.prepare('SELECT body FROM dm_messages WHERE id = ?').get(fromAnn).body;
  const again = (await rev.get(`/admin/message-reports/${rid}`)).text;
  assert.doesNotMatch(again, /Said after the report/); assert.ok(again.includes(fromAnnText)); assert.match(again, /The sender removed this message/);
  const bobSees = (await b.get(`/messages/c/${convo}`)).text;
  assert.ok(!bobSees.includes(`<p>${fromAnnText}`) && /Removed by the sender/.test(bobSees));
  assert.match(bobSees, new RegExp(`/messages/m/${fromAnn}/report`), 'a removed message can still be reported');
  assert.equal((await rev.post(`/admin/message-reports/${rid}/close`, { outcome: 'Spoke to Ann' }, `/admin/message-reports/${rid}`)).status, 302);
  assert.equal(db.prepare('SELECT outcome FROM dm_reports WHERE id = ?').get(rid).outcome, 'Spoke to Ann');
  const closed = (await rev.get(`/admin/message-reports/${rid}`)).text;
  assert.match(closed, /can no longer be read here/); assert.doesNotMatch(closed, /On my way/, 'a closed report no longer opens the conversation');
});

test('reports: someone who reviews reports only for their own people cannot open another office\'s', async () => {
  const office2 = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Elsewhere', ?)").run(new Date().toISOString()).lastInsertRowid;
  access.ensureProfile('Office reviewer', 'all', [...access.SUBMIT, 'forum.use', 'messages.use', 'messages.review']);
  const oid = auth.createUser({ username: 'orev', displayName: 'Olga Office', password: 'correct horse battery', profile: 'Office reviewer' });
  db.prepare('UPDATE users SET must_change_password = 0, branch_id = ? WHERE id = ?').run(office2, oid);
  const rid = db.prepare('SELECT id FROM dm_reports').get().id;
  const o = await new Client().login('orev');
  assert.equal((await o.get(`/admin/message-reports/${rid}`)).status, 404);
  assert.doesNotMatch((await o.get('/admin/message-reports')).text, /Ann Tech/);
});

test('messages: someone who has left cannot get new messages, and the page says so', async () => {
  const a = await new Client().login('ann');
  db.prepare('UPDATE users SET active = 0 WHERE username = ?').run('bob');
  const page = (await a.get(`/messages/c/${convo}`)).text;
  assert.match(page, /cannot get messages any more/); assert.doesNotMatch(page, /data-dm-send/);
  assert.equal((await a.post(`/messages/c/${convo}/send`, { body: 'hi' }, '/messages', { 'x-requested-with': 'fetch' })).status, 409);
  db.prepare('UPDATE users SET active = 1 WHERE username = ?').run('bob');
});

test('reports: nobody reviews a report about their own conversation', async () => {
  const r = await new Client().login('rev'); const c = await new Client().login('cat');
  await c.post(`/messages/with/${idOf('rev')}`, { body: 'Reviewer, a word' }, `/messages/with/${idOf('rev')}`);
  await r.post(`/messages/with/${idOf('cat')}`, { body: 'Something unkind' }, '/messages');
  const bad = db.prepare('SELECT id FROM dm_messages WHERE body = ?').get('Something unkind').id;
  assert.equal((await c.post(`/messages/m/${bad}/report`, {}, '/messages')).status, 302);
  const rid = db.prepare('SELECT id FROM dm_reports WHERE message_id = ?').get(bad).id;
  assert.equal((await r.get(`/admin/message-reports/${rid}`)).status, 404);
  assert.doesNotMatch((await r.get('/admin/message-reports')).text, /Cat Tech and Rae Reviewer|Rae Reviewer and Cat Tech/);
});

test('people: someone without private messages cannot be written to, and two accounts folded into one keep their conversations', async () => {
  const a = await new Client().login('ann');
  assert.doesNotMatch((await a.get('/messages?q=Nora')).text, /messages\/with\//);
  assert.equal((await a.get(`/messages/with/${idOf('nomsg')}`)).status, 409);
  assert.equal((await a.post(`/messages/with/${idOf('nomsg')}`, { body: 'hello?' }, '/messages')).status, 409);
  const extra = auth.createUser({ username: 'ann2', displayName: 'Ann Tech', password: 'correct horse battery', profile: 'Technician' });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(extra);
  const e = await new Client().login('ann2');
  await e.post(`/messages/with/${idOf('bob')}`, { body: 'From my second account' }, '/messages');
  assert.equal(require('../app/duplicates').merge(idOf('ann'), extra), true);
  assert.match((await a.get(`/messages/c/${convo}`)).text, /From my second account/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dm_threads WHERE user_a = ? OR user_b = ?').get(extra, extra).n, 0);
});

test('calls to a person: it rings them, they answer or say not now, and only the two of them are ever in it', async () => {
  const calls = require('../app/calls');
  db.prepare("UPDATE users SET active = 1 WHERE username = 'bob'").run();
  const a = await new Client().login('ann'), b = await new Client().login('bob'), c = await new Client().login('cat');
  const fetchJson = { 'x-requested-with': 'fetch' };
  alerts.length = 0;
  const bobInbox = await b.stream(`inbox:${idOf('bob')}`); const annDm = await a.stream(`dm:${convo}`); await wait(100);
  assert.equal((await c.post(`/call/dm/${convo}/start`, { mode: 'audio' }, '/messages', fetchJson)).status, 404, 'not your conversation');
  const started = await a.post(`/call/dm/${convo}/start`, { mode: 'audio' }, '/messages', fetchJson);
  assert.equal(started.json.mode, 'audio');
  assert.ok(await until(() => /event: ring/.test(bobInbox.text())), 'the other person\'s screens ring');
  assert.match(bobInbox.text(), /"from":"Ann Tech"/);
  assert.ok(alerts.some((x) => x.kind === 'call' && x.ids.includes(idOf('bob')) && /Ann Tech is calling you/.test(x.title)), 'and their phone is alerted');
  assert.equal((await b.get('/call/ringing')).json.calls[0].id, convo);
  assert.match((await b.get(`/messages/c/${convo}`)).text, /Ann Tech<\/strong> is calling you \(voice\)[^]*data-call-join data-mode="audio"[^]*Ann Tech called you/);
  // Not now: the call is over and the caller is told.
  assert.equal((await b.post(`/call/dm/${convo}/decline`, {}, '/messages', fetchJson)).status, 200);
  assert.ok(await until(() => /"type":"declined"/.test(annDm.text())));
  assert.equal(calls.get(`dm:${convo}`), null);
  assert.deepEqual((await b.get('/call/ringing')).json.calls, []);
  // Again, answered this time: the ringing stops everywhere and the caller is told to connect.
  await a.post(`/call/dm/${convo}/start`, { mode: 'video' }, '/messages', fetchJson);
  const joined = await b.post(`/call/dm/${convo}/join`, {}, '/messages', fetchJson);
  assert.equal(joined.json.mode, 'video');
  assert.ok(await until(() => /event: ringend/.test(bobInbox.text()) && /"type":"joined"/.test(annDm.text())));
  assert.equal((await c.post(`/call/dm/${convo}/join`, {}, '/messages', fetchJson)).status, 404);
  await a.post(`/call/dm/${convo}/leave`, {}, '/messages', fetchJson);
  assert.equal(calls.get(`dm:${convo}`), null);
  // Nobody answers: it stops by itself.
  await a.post(`/call/dm/${convo}/start`, { mode: 'audio' }, '/messages', fetchJson);
  calls._calls.get(`dm:${convo}`).ring.until = Date.now() - 1;
  assert.equal(calls.get(`dm:${convo}`), null);
  assert.ok(await until(() => /"type":"noanswer"/.test(annDm.text())));
  // Someone who cannot get messages cannot be rung.
  assert.equal((await a.post(`/messages/open/${idOf('nomsg')}`, {}, '/messages', fetchJson)).status, 404);
  [bobInbox, annDm].forEach((s) => s.close());
});

test('quick list and person card: favorites, recents, search, and the ways to reach someone', async () => {
  const a = await new Client().login('ann'); const n = await new Client().login('nomsg');
  const list = (await a.get('/messages/dock')).text;
  assert.doesNotMatch(list, /<html/); assert.match(list, /Recent/); assert.match(list, new RegExp(`href="/messages/c/${convo}"`)); assert.doesNotMatch(list, /Favorites/);
  assert.equal((await a.post(`/messages/favorite/${idOf('cat')}`, {}, '/messages')).json.on, true);
  assert.match((await a.get('/messages/dock')).text, /Favorites[^]*Cat Tech/);
  const found = (await a.get('/messages/dock?q=bob')).text;
  assert.match(found, new RegExp(`href="/messages/with/${idOf('bob')}"`)); assert.match(found, new RegExp(`data-call-person="${idOf('bob')}"`));
  assert.doesNotMatch((await a.get('/messages/dock?q=Nora')).text, /messages\/with/);
  const card = (await a.get(`/people/${idOf('cat')}/card`)).text;
  assert.doesNotMatch(card, /<html/); assert.match(card, /Cat Tech/); assert.match(card, /aria-pressed="true"/); assert.match(card, /Open profile/);
  assert.match(card, new RegExp(`data-call-person="${idOf('cat')}" data-mode="video"`));
  assert.equal((await a.post(`/messages/favorite/${idOf('cat')}`, {}, '/messages')).json.on, false);
  assert.match((await a.get(`/people/${idOf('ann')}/card`)).text, /My profile/);
  const plain = (await n.get(`/people/${idOf('cat')}/card`)).text;            // no messages: the card is just who they are
  assert.match(plain, /Cat Tech/); assert.doesNotMatch(plain, /data-call-person|messages\/with/);
  assert.notEqual((await n.get('/messages/dock')).status, 200);
  assert.doesNotMatch((await n.get('/')).text, /id="dock"/); assert.match((await a.get('/')).text, /id="dock"/);
  assert.equal((await new Client().get(`/people/${idOf('cat')}/card`)).status, 302);
});
