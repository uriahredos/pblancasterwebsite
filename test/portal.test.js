'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
Object.assign(process.env, {
  DATA_DIR: dataDir, BCRYPT_ROUNDS: '4', LOGIN_RATE_LIMIT: '1000', APP_TIMEZONE: 'America/New_York',
  NOTIFY_TO: 'boss@example.com', COMPLAINT_NOTIFY_TO: 'reviewer@example.com', COMPLAINT_DIGEST_HOUR: '0',
  BASE_URL: 'http://portal.test',
});

// Capture everything the app logs so we can prove complaints leave no trace there.
const logLines = [];
for (const m of ['log', 'warn', 'error']) {
  const orig = console[m];
  console[m] = (...a) => { logLines.push(a.join(' ')); if (process.env.SHOW_LOGS) orig(...a); };
}

const db = require('../app/db');
const auth = require('../app/auth');
const mail = require('../app/mail');
const app = require('../app/app');

const sent = [];
mail.setTransport({ sendMail: async (m) => { sent.push(m); } });

let server, base;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers: this.cookie ? { cookie: this.cookie } : {} });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = res.headers.get('content-type')?.startsWith('image/') ? '' : await res.text();
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  async csrf(page = '/login') {
    const r = await this.get(page);
    const m = /name="_csrf" value="([0-9a-f]+)"/.exec(r.text);
    assert.ok(m, `no csrf token on ${page} (status ${r.status})`);
    return m[1];
  }
  /** fields: object, or array of [name, value] pairs for repeated names. */
  async post(url, fields, { page = '/account/password', multipart = false, csrf = true } = {}) {
    const body = multipart ? new FormData() : new URLSearchParams();
    if (csrf) body.append('_csrf', await this.csrf(page));
    for (const [k, v] of Array.isArray(fields) ? fields : Object.entries(fields)) body.append(k, v);
    return this.req('POST', url, body);
  }
  async login(username, password) {
    const r = await this.post('/login', { username, password }, { page: '/login' });
    assert.equal(r.status, 302, `login failed for ${username}`);
    return r;
  }
}

function makeUser(username, displayName, opts = {}) {
  const id = auth.createUser({ username, displayName, password: 'correct horse battery', ...opts });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  return id;
}
async function loggedIn(username) {
  const c = new Client();
  await c.login(username, 'correct horse battery');
  return c;
}

before(async () => {
  makeUser('admin', 'Ada Admin', { role: 'admin' });               // admin, NOT a complaint reviewer
  makeUser('reviewer', 'Rita Reviewer', { reviewer: true });       // reviewer, NOT an admin
  makeUser('tech1', 'Terry Tech');
  makeUser('tech2', 'Uma Tech');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('signed-out visitors are sent to login and returned to the form link', async () => {
  const c = new Client();
  const r = await c.get('/parts?action=take');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login?next=%2Fparts%3Faction%3Dtake');
  const login = await c.post('/login', { username: 'tech1', password: 'correct horse battery', next: '/parts?action=take' }, { page: '/login' });
  assert.equal(login.location, '/parts?action=take');
});

test('wrong password, disabled account and open redirects are refused', async () => {
  const c = new Client();
  assert.equal((await c.post('/login', { username: 'tech1', password: 'nope' }, { page: '/login' })).status, 401);
  assert.equal((await c.post('/login', { username: 'nobody', password: 'nope' }, { page: '/login' })).status, 401);
  const r = await c.post('/login', { username: 'TECH1', password: 'correct horse battery', next: '//evil.example' }, { page: '/login' });
  assert.equal(r.location, '/'); // username is case-insensitive, redirect stays on-site
  makeUser('gone', 'Gone Person');
  db.prepare("UPDATE users SET active = 0 WHERE username = 'gone'").run();
  assert.equal((await new Client().post('/login', { username: 'gone', password: 'correct horse battery' }, { page: '/login' })).status, 401);
});

test('a temporary password must be changed before anything else works', async () => {
  auth.createUser({ username: 'newbie', displayName: 'New Person', password: 'temp-pass-1234' });
  const c = new Client();
  assert.equal((await c.login('newbie', 'temp-pass-1234')).location, '/account/password');
  assert.equal((await c.get('/parts')).location, '/account/password');
  const short = await c.post('/account/password', { current: 'temp-pass-1234', password: 'short', confirm: 'short' });
  assert.equal(short.status, 400);
  const ok = await c.post('/account/password', { current: 'temp-pass-1234', password: 'my new password 1', confirm: 'my new password 1' });
  assert.equal(ok.status, 302);
  assert.equal((await c.get('/parts')).status, 200);
  await new Client().login('newbie', 'my new password 1');
});

test('forms without a valid CSRF token are rejected', async () => {
  const c = await loggedIn('tech1');
  const r = await c.post('/training', { description: 'x', wants_contact: 'no', is_private: 'no' }, { csrf: false });
  assert.equal(r.status, 403);
  const m = await c.post('/parts', { action: 'take', part_name: 'X', quantity: '1', source: 'van' }, { csrf: false, multipart: true });
  assert.equal(m.status, 403);
});

test('take parts: several line items for a job', async () => {
  const c = await loggedIn('tech1');
  const r = await c.post('/parts', [
    ['action', 'take'], ['part_name', 'SIGA-CT2'], ['quantity', '7'], ['part_name', 'SIGA-UM'], ['quantity', '4'],
    ['part_name', ''], ['quantity', ''], ['source', 'job'], ['job_number', '49020597'],
  ], { multipart: true });
  assert.equal(r.status, 302);
  const s = db.prepare("SELECT * FROM parts_submissions WHERE job_number = '49020597'").get();
  assert.equal(s.action, 'take');
  assert.equal(s.status, null);
  assert.deepEqual(db.prepare('SELECT part_name, quantity FROM parts_items WHERE submission_id = ? ORDER BY id').all(s.id),
    [{ part_name: 'SIGA-CT2', quantity: 7 }, { part_name: 'SIGA-UM', quantity: 4 }]);
  assert.match((await c.get('/my')).text, /7 × SIGA-CT2/);
});

test('parts validation: missing parts, bad quantity, job without number, request without date', async () => {
  const c = await loggedIn('tech1');
  const before = db.prepare('SELECT COUNT(*) n FROM parts_submissions').get().n;
  const cases = [
    [['action', 'take'], ['source', 'van']],
    [['action', 'take'], ['part_name', 'BB-1GS'], ['quantity', '0'], ['source', 'van']],
    [['action', 'take'], ['part_name', 'BB-1GS'], ['quantity', 'two'], ['source', 'van']],
    [['action', 'take'], ['part_name', 'BB-1GS'], ['quantity', '1'], ['source', 'job']],
    [['action', 'request'], ['part_name', 'BB-1GS'], ['quantity', '1'], ['source', 'van']],
    [['action', 'steal'], ['part_name', 'BB-1GS'], ['quantity', '1'], ['source', 'van']],
  ];
  for (const fields of cases) {
    const r = await c.post('/parts', fields, { multipart: true });
    assert.equal(r.status, 400, JSON.stringify(fields));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions').get().n, before);
});

test('return parts with a photo; only the owner and admins can see the photo', async () => {
  const c = await loggedIn('tech1');
  const r = await c.post('/parts', [
    ['action', 'return'], ['part_name', 'SPSRLED'], ['quantity', '3'], ['source', 'van'],
    ['photo', new File([PNG], 'IMG_0001.png', { type: 'image/png' })],
  ], { multipart: true });
  assert.equal(r.status, 302);
  const s = db.prepare("SELECT * FROM parts_submissions WHERE action = 'return' ORDER BY id DESC").get();
  assert.match(s.photo_path, /^[0-9a-f]{32}\.png$/);
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads', s.photo_path)));
  assert.equal((await c.get(`/parts/photo/${s.id}`)).status, 200);
  assert.equal((await (await loggedIn('tech2')).get(`/parts/photo/${s.id}`)).status, 403);
  assert.equal((await (await loggedIn('admin')).get(`/parts/photo/${s.id}`)).status, 200);
  assert.equal((await new Client().get(`/parts/photo/${s.id}`)).status, 302);
});

test('a file that is not really an image is refused and not kept', async () => {
  const c = await loggedIn('tech1');
  const count = () => fs.readdirSync(path.join(dataDir, 'uploads')).length;
  const n = count();
  for (const file of [new File(['<script>alert(1)</script>'], 'x.png', { type: 'image/png' }), new File(['hello'], 'x.html', { type: 'text/html' })]) {
    const r = await c.post('/parts', [['action', 'return'], ['part_name', 'A'], ['quantity', '1'], ['source', 'van'], ['photo', file]], { multipart: true });
    assert.equal(r.status, 400);
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(count(), n);
});

test('request parts starts as New, emails the admins, and the admin can update it', async () => {
  sent.length = 0;
  const c = await loggedIn('tech2');
  const r = await c.post('/parts', [['action', 'request'], ['part_name', '4WB'], ['quantity', '2'], ['source', 'van'], ['needed_by', '2026-12-01']], { multipart: true });
  assert.equal(r.status, 302);
  const s = db.prepare("SELECT * FROM parts_submissions WHERE action = 'request' ORDER BY id DESC").get();
  assert.equal(s.status, 'new');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'boss@example.com');
  assert.match(sent[0].subject, /Parts request from Uma Tech/);
  assert.match(sent[0].text, /2 x 4WB/);

  const admin = await loggedIn('admin');
  const page = `/admin/parts/${s.id}`;
  assert.equal((await admin.post(`${page}/status`, { status: 'ordered', admin_note: 'On the Friday truck' }, { page })).status, 302);
  const mine = (await c.get('/my')).text;
  assert.match(mine, /Ordered/);
  assert.match(mine, /On the Friday truck/);
});

test('training request: private ones keep their text out of email', async () => {
  sent.length = 0;
  const c = await loggedIn('tech1');
  await c.post('/training', { description: 'DSC 832/1832 and DSC Qolsys', wants_contact: 'yes', is_private: 'no' });
  await c.post('/training', { description: 'Secret topic about ground faults', wants_contact: 'no', is_private: 'yes' });
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /DSC 832\/1832/);
  assert.match(sent[0].subject, /Terry Tech/);
  assert.doesNotMatch(sent[1].subject + sent[1].text, /Secret topic|Terry/);
  assert.equal((await c.post('/training', { description: '', wants_contact: 'yes', is_private: 'no' })).status, 400);

  const admin = await loggedIn('admin');
  const t = db.prepare("SELECT id FROM training_requests WHERE description LIKE 'DSC%'").get();
  await admin.post(`/admin/training/${t.id}/status`, { status: 'scheduled', admin_note: '' }, { page: `/admin/training/${t.id}` });
  assert.match((await c.get('/my')).text, /Scheduled/);
});

test('regular users cannot open admin pages; users only see their own submissions', async () => {
  const tech2 = await loggedIn('tech2');
  for (const url of ['/admin/parts', '/admin/parts.csv', '/admin/training', '/admin/training.csv', '/admin/users', '/admin/parts/1', '/admin/complaints']) {
    assert.equal((await tech2.get(url)).status, 403, url);
  }
  assert.equal((await tech2.post('/admin/users', { username: 'hacker', display_name: 'H' })).status, 403);
  assert.equal((await tech2.post('/admin/users/1/toggle-admin', {})).status, 403);
  const mine = (await tech2.get('/my')).text;
  assert.doesNotMatch(mine, /SIGA-CT2|DSC 832/);
  assert.match(mine, /4WB/);
});

test('admin filters and CSV export', async () => {
  const admin = await loggedIn('admin');
  const all = (await admin.get('/admin/parts')).text;
  assert.match(all, /SIGA-CT2/); assert.match(all, /4WB/);
  const filtered = (await admin.get('/admin/parts?action=request')).text;
  assert.match(filtered, /4WB/); assert.doesNotMatch(filtered, /SIGA-CT2/);
  const searched = (await admin.get('/admin/parts?q=49020597')).text;
  assert.match(searched, /SIGA-CT2/); assert.doesNotMatch(searched, /4WB/);

  // A part name that a spreadsheet would run as a formula must be neutralised.
  const tech = await loggedIn('tech1');
  await tech.post('/parts', [['action', 'take'], ['part_name', '=HYPERLINK("http://x","y")'], ['quantity', '1'], ['source', 'van'], ['note', 'line1\nline2, with comma']], { multipart: true });

  const csv = await admin.get('/admin/parts.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="parts-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = csv.text.split('\r\n');
  assert.match(lines[0], /Id,Submitted,Name,Username,Action,Part,Quantity/);
  assert.ok(lines.some((l) => /Terry Tech,tech1,Take parts,SIGA-CT2,7,Job,49020597/.test(l)));
  assert.ok(lines.some((l) => /Terry Tech,tech1,Take parts,SIGA-UM,4,Job,49020597/.test(l)));
  assert.match(csv.text, /"'=HYPERLINK\(""http:\/\/x"",""y""\)"/);
  assert.match(csv.text, /"line1\nline2, with comma"/);
  const onlyReq = (await admin.get('/admin/parts.csv?action=request')).text;
  assert.match(onlyReq, /4WB/); assert.doesNotMatch(onlyReq, /SIGA-CT2/);

  const tcsv = (await admin.get('/admin/training.csv')).text;
  assert.match(tcsv, /Terry Tech,tech1,DSC 832\/1832 and DSC Qolsys,Yes,No,Scheduled/);
});

test('admin user management: create with one-time temp password, reset, disable, no self-lockout', async () => {
  const admin = await loggedIn('admin');
  const page = '/admin/users';
  assert.equal((await admin.post(page, { username: 'tech1', display_name: 'Dup' }, { page })).status, 400);
  assert.equal((await admin.post(page, { username: 'kyle.o', display_name: 'Kyle O', role: 'user' }, { page })).status, 302);
  const shown = (await admin.get(page)).text;
  const temp = /<p class="code">([a-z0-9-]+)<\/p>/.exec(shown)[1];
  assert.doesNotMatch((await admin.get(page)).text, new RegExp(temp)); // shown once only
  const kyle = new Client();
  assert.equal((await kyle.login('kyle.o', temp)).location, '/account/password');

  const id = db.prepare("SELECT id FROM users WHERE username = 'kyle.o'").get().id;
  await admin.post(`/admin/users/${id}/toggle-active`, {}, { page });
  assert.equal((await kyle.get('/account/password')).status, 302); // kicked out straight away
  assert.equal((await new Client().post('/login', { username: 'kyle.o', password: temp }, { page: '/login' })).status, 401);

  const me = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  await admin.post(`/admin/users/${me}/toggle-active`, {}, { page });
  await admin.post(`/admin/users/${me}/toggle-admin`, {}, { page });
  const row = db.prepare('SELECT active, role FROM users WHERE id = ?').get(me);
  assert.deepEqual(row, { active: 1, role: 'admin' });
});

test('anonymous complaint: nothing identifying is stored, logged or emailed', async () => {
  sent.length = 0;
  logLines.length = 0;
  const tech = await loggedIn('tech1');
  const techId = db.prepare("SELECT id FROM users WHERE username = 'tech1'").get().id;
  const r = await tech.post('/complaint', { category: 'safety', description: 'Ladder on truck 309 is cracked', occurred_text: 'Monday at the shop' }, { page: '/complaint' });
  assert.equal(r.status, 200);
  const code = /<p class="code" id="code">([A-Z0-9-]{14})<\/p>/.exec(r.text)[1];

  // The table has no column that could hold an identity or a time.
  const cols = db.prepare("SELECT name FROM pragma_table_info('complaints')").all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['category', 'created_date', 'description', 'id', 'notified', 'occurred_text', 'reviewer_reply', 'status', 'tracking_code_hash']);
  const row = db.prepare('SELECT * FROM complaints').get();
  assert.match(row.created_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(row.id, /^[0-9a-f]{16}$/);

  // Nothing in the complaint row, the session table or the log gives the author away.
  const everything = JSON.stringify(row);
  assert.doesNotMatch(everything, /tech1|Terry/i);
  assert.ok(!everything.includes(code) && !everything.includes(code.replace(/-/g, '')));
  const sessions = db.prepare('SELECT data FROM sessions').all().map((s) => s.data).join('\n');
  assert.ok(!sessions.includes(code) && !sessions.includes(row.id) && !/Ladder/.test(sessions));
  assert.ok(!logLines.some((l) => /complaint|Ladder/i.test(l)), logLines.join('\n'));
  assert.equal(sent.length, 0); // no email at the moment of submission
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE note LIKE ?').get('%Ladder%').n, 0);
  void techId;

  // It never shows up under "My submissions".
  assert.doesNotMatch((await tech.get('/my')).text, /Ladder/);

  // The daily notice carries a count and a link only.
  assert.equal(await mail.runComplaintDigest(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'reviewer@example.com');
  assert.equal(sent[0].subject, 'A new complaint was submitted');
  assert.doesNotMatch(sent[0].text, /Ladder|Terry|tech1|safety/i);
  assert.equal(await mail.runComplaintDigest(), 0); // once a day

  // Reviewer answers; anyone holding the code (even on another account) can read the reply.
  const reviewer = await loggedIn('reviewer');
  const list = (await reviewer.get('/admin/complaints')).text;
  assert.match(list, /Ladder on truck 309/);
  assert.doesNotMatch(list, /Terry|tech1/);
  const page = `/admin/complaints/${row.id}`;
  assert.doesNotMatch((await reviewer.get(page)).text, /Terry|tech1/);
  await reviewer.post(page, { status: 'under_review', reviewer_reply: 'Ladder pulled from service today.' }, { page });

  const other = await loggedIn('tech2');
  const st = await other.post('/complaint/status', { code: code.toLowerCase().replace(/-/g, ' ') }, { page: '/complaint/status' });
  assert.equal(st.status, 200);
  assert.match(st.text, /Under review/);
  assert.match(st.text, /Ladder pulled from service today\./);
  assert.doesNotMatch(st.text, /Ladder on truck 309/); // the status page does not echo the complaint text

  const wrong = await other.post('/complaint/status', { code: 'AAAA-BBBB-CCCC' }, { page: '/complaint/status' });
  assert.equal(wrong.status, 404);
  assert.doesNotMatch(wrong.text, /Under review|pulled from service/);
});

test('complaints: only reviewers can read them, login is required, and there is a daily cap', async () => {
  const id = db.prepare('SELECT id FROM complaints').get().id;
  const admin = await loggedIn('admin'); // an admin without the reviewer permission
  assert.equal((await admin.get('/admin/complaints')).status, 403);
  assert.equal((await admin.get(`/admin/complaints/${id}`)).status, 403);
  assert.equal((await admin.post(`/admin/complaints/${id}`, { status: 'closed' })).status, 403);
  assert.doesNotMatch((await admin.get('/admin/parts')).text, /href="\/admin\/complaints"/);
  const reviewer = await loggedIn('reviewer'); // a reviewer who is not an admin
  assert.equal((await reviewer.get('/admin/complaints')).status, 200);
  assert.equal((await reviewer.get('/admin/parts')).status, 403);

  const anon = new Client();
  assert.equal((await anon.get('/complaint')).status, 302);
  assert.equal((await anon.get('/complaint/status')).status, 302);

  const tech = await loggedIn('tech2');
  assert.equal((await tech.post('/complaint', { category: 'nope', description: 'x' }, { page: '/complaint' })).status, 400);
  let last;
  for (let i = 0; i < 6; i++) last = await tech.post('/complaint', { category: 'other', description: `flood ${i}` }, { page: '/complaint' });
  assert.equal(last.status, 400);
  assert.match(last.text, /daily limit/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM complaints WHERE description LIKE 'flood%'").get().n, 5);
});

test('user-typed text is escaped on every page that shows it', async () => {
  const tech = await loggedIn('tech1');
  const xss = '<img src=x onerror=alert(1)>';
  await tech.post('/parts', [['action', 'take'], ['part_name', xss], ['quantity', '1'], ['source', 'job'], ['job_number', xss], ['note', xss]], { multipart: true });
  await tech.post('/training', { description: xss, wants_contact: 'no', is_private: 'no' });
  await tech.post('/complaint', { category: 'other', description: xss, occurred_text: xss }, { page: '/complaint' });
  const admin = await loggedIn('admin');
  const reviewer = await loggedIn('reviewer');
  const pid = db.prepare('SELECT MAX(id) id FROM parts_submissions').get().id;
  const tid = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  const cid = db.prepare('SELECT id FROM complaints WHERE description = ?').get(xss).id;
  const pages = [
    [tech, '/my'], [admin, '/admin/parts'], [admin, `/admin/parts/${pid}`], [admin, '/admin/training'],
    [admin, `/admin/training/${tid}`], [reviewer, '/admin/complaints'], [reviewer, `/admin/complaints/${cid}`],
  ];
  for (const [client, url] of pages) {
    const { text, status } = await client.get(url);
    assert.equal(status, 200, url);
    assert.ok(!text.includes('<img src=x'), url);
    assert.ok(text.includes('&lt;img src=x'), url);
  }
});
