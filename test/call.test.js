'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-call-'));
Object.assign(process.env, { DATA_DIR: dataDir, BCRYPT_ROUNDS: '4', LOGIN_RATE_LIMIT: '1000', APP_TIMEZONE: 'America/New_York', BASE_URL: 'http://portal.test', BACKUP_HOUR: '0', COMPLAINT_DIGEST_HOUR: '0', TURN_KEY_ID: 'key-123', TURN_KEY_API_TOKEN: 'secret-token-abc' });
for (const m of ['log', 'warn', 'error']) console[m] = () => {};

const db = require('../app/db');
const auth = require('../app/auth');
const access = require('../app/permissions');
const calls = require('../app/calls');
const app = require('../app/app');

let server, base;
const cloudflare = [];                                   // what the site asked Cloudflare for
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://rtc.live.cloudflare.com/')) {
    cloudflare.push({ url: String(url), headers: opts.headers, body: opts.body });
    return new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u1', credential: 'c1' }] }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const res = await realFetch(base + url, { method, body, redirect: 'manual', headers: this.cookie ? { cookie: this.cookie } : {} });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, text, json, location: res.headers.get('location') };
  }
  async csrf(page) { return /name="_csrf" value="([0-9a-f]+)"/.exec((await this.req('GET', page)).text)[1]; }
  async post(url, fields = {}, page = '/account/password') { return this.req('POST', url, new URLSearchParams({ _csrf: await this.csrf(page), ...fields })); }
  async login(u) { await this.post('/login', { username: u, password: 'correct horse battery' }, '/login'); return this; }
  async stream(topics) {
    const ctl = new AbortController();
    const res = await realFetch(`${base}/live/stream?topics=${encodeURIComponent(topics)}`, { headers: { cookie: this.cookie }, signal: ctl.signal });
    const got = [];
    (async () => { const dec = new TextDecoder(); try { for await (const ch of res.body) got.push(dec.decode(ch)); } catch (e) { /* closed */ } })();
    return { status: res.status, text: () => got.join(''), close: () => ctl.abort() };
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return fn(); }

let support, general, T, G;
before(async () => {
  for (const [u, n] of [['tech1', 'Terry Tech'], ['tech2', 'Uma Tech'], ['tech3', 'Tom Tech']]) {
    const id = auth.createUser({ username: u, displayName: n, password: 'correct horse battery', profile: 'Technician' });
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  }
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT, 'forum.use']);
  support = db.prepare("SELECT id FROM forum_sections WHERE kind = 'support'").get().id;
  general = db.prepare("SELECT id FROM forum_sections WHERE name = 'General'").get().id;
  const now = new Date().toISOString();
  const mk = (sec, title) => { const id = db.prepare('INSERT INTO forum_threads (section_id, user_id, title, created_at, last_post_at, last_post_user_id) VALUES (?, 1, ?, ?, ?, 1)').run(sec, title, now, now).lastInsertRowid; db.prepare('INSERT INTO forum_posts (thread_id, user_id, body, created_at) VALUES (?, 1, ?, ?)').run(id, 'hi', now); return id; };
  T = mk(support, 'Panel will not arm'); G = mk(general, 'Hello');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('call servers: fresh relay credentials come from Cloudflare, the token stays on the server, port 53 is dropped', async () => {
  const c = await new Client().login('tech1');
  const r = await c.post(`/call/t/${T}/ice`);
  assert.equal(r.status, 200); assert.equal(r.json.relay, true);
  assert.equal(r.json.servers.length, 2);
  assert.ok(r.json.servers[1].urls.every((u) => !/:53(\?|$)/.test(u)) && r.json.servers[1].urls.length === 2);
  assert.equal(r.json.servers[1].username, 'u1');
  assert.ok(!r.text.includes('secret-token-abc') && !r.text.includes('key-123'));
  assert.equal(cloudflare.at(-1).url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers');
  assert.equal(cloudflare.at(-1).headers.Authorization, 'Bearer secret-token-abc');
  assert.deepEqual(JSON.parse(cloudflare.at(-1).body), { ttl: 7200 });
  // The page itself never carries the keys.
  const page = (await c.req('GET', `/discussions/t/${T}`)).text;
  assert.ok(!page.includes('secret-token-abc') && !page.includes('key-123'));
});

test('call servers: if Cloudflare cannot be reached the call still gets free STUN', async () => {
  const before = global.fetch;
  global.fetch = async (url, opts) => (String(url).startsWith('https://rtc.live.cloudflare.com/') ? new Response('nope', { status: 500 }) : realFetch(url, opts));
  try {
    const r = await (await new Client().login('tech1')).post(`/call/t/${T}/ice`);
    assert.equal(r.json.relay, false); assert.deepEqual(r.json.servers, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  } finally { global.fetch = before; }
});

test('calls belong to tech-support threads only, and to people who may use discussions', async () => {
  const c = await new Client().login('tech1');
  for (const act of ['ice', 'start', 'join', 'signal', 'beat', 'leave']) assert.equal((await c.post(`/call/t/${G}/${act}`)).status, 404, act);
  assert.equal((await c.post('/call/t/999/start')).status, 404);
  const anon = new Client();
  assert.equal((await anon.req('POST', `/call/t/${T}/start`, new URLSearchParams({}))).status, 403);   // no form token
  const nobody = await new Client().login('tech3');
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT]);
  assert.notEqual((await nobody.post(`/call/t/${T}/start`)).status, 200);
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT, 'forum.use']);
});

test('a call: start, join, setup messages go only to the other person, then leave', async () => {
  const host = await new Client().login('tech1'), guest = await new Client().login('tech2'), other = await new Client().login('tech3');
  const hs = await host.stream(`thread:${T}`), gs = await guest.stream(`thread:${T}`), os_ = await other.stream(`thread:${T}`);
  await wait(100);

  assert.match((await host.req('GET', `/discussions/t/${T}`)).text, /Start a video call/);
  assert.equal((await guest.post(`/call/t/${T}/join`)).status, 404, 'nothing to join yet');
  assert.equal((await host.post(`/call/t/${T}/start`)).json.role, 'host');
  assert.ok(await until(() => /event: update/.test(os_.text())), 'everyone watching hears there is a call');
  assert.match((await other.req('GET', `/discussions/t/${T}`)).text, /Terry Tech<\/strong> is on a live video call[\s\S]*data-call-join/);
  assert.equal((await other.post(`/call/t/${T}/signal`, { kind: 'offer', data: '{"type":"offer","sdp":"x"}' })).status, 403, 'not in the call');
  assert.equal((await host.post(`/call/t/${T}/signal`, { kind: 'offer', data: '{"type":"offer","sdp":"x"}' })).status, 409, 'nobody there yet');

  assert.equal((await guest.post(`/call/t/${T}/join`)).json.host, 'Terry Tech');
  assert.ok(await until(() => /"type":"joined"/.test(hs.text())), 'the host is told to make the offer');
  assert.doesNotMatch(os_.text(), /joined/);
  assert.equal((await other.post(`/call/t/${T}/join`)).status, 409, 'a call has two people');
  assert.match((await other.req('GET', `/discussions/t/${T}`)).text, /It is full/);

  assert.equal((await host.post(`/call/t/${T}/signal`, { kind: 'offer', data: JSON.stringify({ type: 'offer', sdp: 'v=0 secret-sdp' }) })).status, 200);
  assert.ok(await until(() => /secret-sdp/.test(gs.text())), 'the offer reaches the guest');
  await wait(100);
  assert.doesNotMatch(os_.text(), /secret-sdp/); assert.doesNotMatch(hs.text(), /secret-sdp/);   // nobody else, not even the sender
  assert.equal((await guest.post(`/call/t/${T}/signal`, { kind: 'candidate', data: '{"candidate":"candidate:1 1 udp 1 10.0.0.1 5000 typ host"}' })).status, 200);
  assert.ok(await until(() => /candidate:1 1 udp/.test(hs.text())));

  // Bad messages: wrong kind, too long, not JSON, an offer without a description.
  for (const bad of [{ kind: 'bye', data: '{}' }, { kind: 'offer', data: 'x'.repeat(20001) }, { kind: 'offer', data: 'nope' }, { kind: 'offer', data: '{"type":"offer"}' }, { kind: 'candidate', data: '' }]) {
    assert.equal((await host.post(`/call/t/${T}/signal`, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepEqual((await guest.post(`/call/t/${T}/beat`)).json, { active: true, peer: true });
  assert.deepEqual((await other.post(`/call/t/${T}/beat`)).json, { active: false, peer: false });

  // The guest leaves: the host is told and the place is free. Then the host ends it.
  await guest.post(`/call/t/${T}/leave`);
  assert.ok(await until(() => /"type":"bye"/.test(hs.text())));
  assert.equal((await other.post(`/call/t/${T}/join`)).status, 200, 'the place is free again');
  await other.post(`/call/t/${T}/leave`);
  await host.post(`/call/t/${T}/leave`);
  assert.equal(calls.get(T), null);
  assert.match((await host.req('GET', `/discussions/t/${T}`)).text, /Start a video call/);
  hs.close(); gs.close(); os_.close();
});

test('a call that goes quiet ends by itself, and someone else cannot take over a live one', async () => {
  const host = await new Client().login('tech1'), other = await new Client().login('tech3');
  await host.post(`/call/t/${T}/start`);
  assert.equal((await other.post(`/call/t/${T}/start`)).status, 409);
  calls._calls.get(T).host.seen = Date.now() - calls._STALE_MS - 1000;
  assert.equal(calls.get(T), null, 'the host has gone quiet');
  assert.equal((await other.post(`/call/t/${T}/start`)).status, 200);
  await other.post(`/call/t/${T}/leave`);
});
