'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-live-'));
Object.assign(process.env, { DATA_DIR: dataDir, BCRYPT_ROUNDS: '4', LOGIN_RATE_LIMIT: '1000', APP_TIMEZONE: 'America/New_York', BASE_URL: 'http://portal.test', BACKUP_HOUR: '0', COMPLAINT_DIGEST_HOUR: '0' });
for (const m of ['log', 'warn', 'error']) console[m] = () => {};

const db = require('../app/db');
const auth = require('../app/auth');
const access = require('../app/permissions');
const live = require('../app/live');
const app = require('../app/app');

let server, base;
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, extra = {}) {
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...extra } });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async csrf(page) { return /name="_csrf" value="([0-9a-f]+)"/.exec((await this.req('GET', page)).text)[1]; }
  async post(url, fields, page) {
    const body = new URLSearchParams({ _csrf: await this.csrf(page), ...fields });
    return this.req('POST', url, body);
  }
  async login(u) { assert.equal((await this.post('/login', { username: u, password: 'correct horse battery' }, '/login')).status, 302); return this; }
  /** Open the live stream; returns { status, events(), close() } where events() are the "event:" names received so far. */
  async stream(topics) {
    const ctl = new AbortController();
    const res = await fetch(`${base}/live/stream?topics=${encodeURIComponent(topics)}`, { headers: { cookie: this.cookie }, signal: ctl.signal, redirect: 'manual' });
    const seen = [];
    if (res.status === 200) {
      (async () => {
        const dec = new TextDecoder();
        try { for await (const chunk of res.body) for (const m of dec.decode(chunk).matchAll(/^event: (\w+)/gm)) seen.push(m[1]); } catch (e) { /* closed */ }
      })();
    } else await res.arrayBuffer();
    return { status: res.status, ctype: res.headers.get('content-type'), events: () => seen.slice(), close: () => ctl.abort() };
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return fn(); }

before(async () => {
  for (const [u, n] of [['tech1', 'Terry Tech'], ['tech2', 'Uma Tech']]) {
    const id = auth.createUser({ username: u, displayName: n, password: 'correct horse battery', profile: 'Technician' });
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  }
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT, 'forum.use']);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('live stream: signed-out, bad topics and people without the discussions permission are turned away without a redirect', async () => {
  assert.equal((await new Client().stream('forum')).status, 401);
  const t1 = await new Client().login('tech1');
  assert.equal((await t1.stream('')).status, 400);
  assert.equal((await t1.stream('thread:abc')).status, 400);
  assert.equal((await t1.stream('forum,forum,forum,forum,forum')).status, 400);
  assert.equal((await t1.stream('../../etc')).status, 400);
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT]);
  assert.equal((await t1.stream('forum')).status, 403);
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT, 'forum.use']);
});

test('live stream: a reply reaches the people watching that thread, and only them; a refused reply says nothing', async () => {
  const t1 = await new Client().login('tech1'), t2 = await new Client().login('tech2');
  const support = db.prepare("SELECT id FROM forum_sections WHERE kind = 'support'").get().id;
  const made = await t1.post('/discussions/new', { section_id: String(support), title: 'Zone will not learn', body: 'Help' }, '/discussions/new');
  const id = Number(/\/discussions\/t\/(\d+)$/.exec(made.location)[1]);
  const other = Number(/\/discussions\/t\/(\d+)$/.exec((await t1.post('/discussions/new', { section_id: String(support), title: 'Another one', body: 'Hi' }, '/discussions/new')).location)[1]);

  const onThread = await t2.stream(`thread:${id}`), onOther = await t2.stream(`thread:${other}`), onList = await t2.stream('forum');
  assert.equal(onThread.status, 200); assert.match(onThread.ctype, /^text\/event-stream/);
  await wait(100);

  assert.equal((await t1.post(`/discussions/t/${id}/reply`, { body: '' }, `/discussions/t/${id}`)).status, 400);   // refused: nothing is sent
  await wait(150);
  assert.deepEqual(onThread.events(), []);

  assert.equal((await t1.post(`/discussions/t/${id}/reply`, { body: 'Try a fresh zone number' }, `/discussions/t/${id}`)).status, 302);
  assert.ok(await until(() => onThread.events().includes('update')), 'the thread page is told');
  assert.ok(await until(() => onList.events().includes('update')), 'the list is told');
  await wait(150);
  assert.deepEqual(onOther.events(), []);                                                                         // a different thread hears nothing

  // The stream carries no content, only that something changed.
  onThread.close(); onOther.close(); onList.close();
});

test('live stream: it never holds off the idle lock, and ends when the session locks or the account is switched off', async () => {
  const c = await new Client().login('tech2');
  await c.req('GET', '/discussions');                                    // an ordinary page: counts as activity
  const rows = () => db.prepare("SELECT data FROM sessions WHERE json_extract(data, '$.userId') = (SELECT id FROM users WHERE username = 'tech2')").all().map((r) => JSON.parse(r.data));
  const before = rows().map((d) => d.seenAt);
  await wait(30);
  const s = await c.stream('forum');
  await c.req('GET', '/discussions', undefined, { 'x-live': '1' });       // the page asking for its own fresh copy
  await wait(100);
  assert.deepEqual(rows().map((d) => d.seenAt), before, 'listening and refreshing are not the person doing something');

  // The site locks: the next beat tells the page and closes the stream.
  db.prepare("UPDATE sessions SET data = json_set(data, '$.locked', json('true')) WHERE json_extract(data, '$.userId') = (SELECT id FROM users WHERE username = 'tech2')").run();
  live._beat();
  assert.ok(await until(() => s.events().includes('bye')), 'told to leave');
  s.close();
  assert.equal((await c.stream('forum')).status, 302, 'a locked session cannot open one either: it is sent to the lock screen');

  // A switched-off account is dropped too.
  const c2 = await new Client().login('tech1');
  const s2 = await c2.stream('forum');
  db.prepare("UPDATE users SET active = 0 WHERE username = 'tech1'").run();
  live._beat();
  assert.ok(await until(() => s2.events().includes('bye')));
  s2.close();
});

test('live stream: one person can listen on six screens at once, the seventh is turned away', async () => {
  db.prepare("UPDATE users SET active = 1 WHERE username = 'tech1'").run();
  const c = await new Client().login('tech1');
  const open = [];
  for (let i = 0; i < 6; i++) { const s = await c.stream('forum'); assert.equal(s.status, 200); open.push(s); }
  assert.equal((await c.stream('forum')).status, 429);
  open.forEach((s) => s.close());
  assert.ok(await until(() => live.count() === 0), 'closed streams are forgotten');
});
