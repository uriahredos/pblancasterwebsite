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
  BASE_URL: 'http://portal.test', BACKUP_EMAIL_TO: 'owner@example.com', BACKUP_HOUR: '0',
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

const access = require('../app/permissions');
// Shorthand kept from before profiles existed: { role: 'admin' } and { reviewer: true } pick the matching profile.
function profileFor({ role, reviewer, profile } = {}) {
  if (profile) return profile;
  if (role === 'admin' && reviewer) return 'Admin';
  if (role === 'admin') {
    access.ensureProfile('Admin (no complaints)', 'all', access.ALL.filter((p) => p !== 'complaints.review' && p !== 'backups'));
    return 'Admin (no complaints)';
  }
  if (reviewer) { access.ensureProfile('Complaint reviewer', 'all', [...access.SUBMIT, 'complaints.review']); return 'Complaint reviewer'; }
  return 'Technician';
}
function makeUser(username, displayName, opts = {}) {
  const id = auth.createUser({ username, displayName, password: 'correct horse battery', profile: profileFor(opts), master: opts.master });
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
  makeUser('owner', 'Olive Owner', { role: 'admin', reviewer: true }); // admin AND reviewer
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
  assert.equal((await admin.post(page, { username: 'kyle.o', display_name: 'Kyle O' }, { page })).status, 400); // a profile is required
  const techProfile = access.profileByName('Technician').id;
  assert.equal((await admin.post(page, { username: 'kyle.o', display_name: 'Kyle O', profile_id: techProfile }, { page })).status, 302);
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
  const myProfile = db.prepare('SELECT profile_id FROM users WHERE id = ?').get(me).profile_id;
  await admin.post(`/admin/users/${me}/toggle-active`, {}, { page });
  await admin.post(`/admin/users/${me}/edit`, { username: 'admin', display_name: 'Ada Admin', profile_id: techProfile }, { page: `/admin/users/${me}/edit` });
  const row = db.prepare('SELECT active, profile_id FROM users WHERE id = ?').get(me);
  assert.deepEqual({ ...row }, { active: 1, profile_id: myProfile }); // cannot disable or demote yourself
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

  // It never shows up under "My activity".
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

// ---------------------------------------------------------------------------
// Edit / cancel, usage summary, parts catalog, backups, home-screen app
// ---------------------------------------------------------------------------

const lastParts = () => db.prepare('SELECT * FROM parts_submissions ORDER BY id DESC').get();
const itemsOf = (id) => db.prepare('SELECT part_name, quantity FROM parts_items WHERE submission_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));

test('a person can edit their own parts entry for a while, and the change is recorded', async () => {
  const tech = await loggedIn('tech1');
  await tech.post('/parts', [['action', 'take'], ['part_name', 'EDIT-ME'], ['quantity', '70'], ['source', 'van']], { multipart: true });
  const s = lastParts();
  const page = `/parts/${s.id}/edit`;
  assert.match((await tech.get('/my')).text, new RegExp(`href="${page}"`));
  assert.match((await tech.get(page)).text, /value="EDIT-ME"/);

  const r = await tech.post(page, [['action', 'request'], ['part_name', 'EDIT-ME'], ['quantity', '7'], ['source', 'job'], ['job_number', 'J-1']], { multipart: true, page });
  assert.equal(r.status, 302);
  const after = db.prepare('SELECT * FROM parts_submissions WHERE id = ?').get(s.id);
  assert.equal(after.action, 'take'); // what was done cannot be switched by an edit
  assert.equal(after.job_number, 'J-1');
  assert.ok(after.edited_at);
  assert.deepEqual(itemsOf(s.id), [{ part_name: 'EDIT-ME', quantity: 7 }]);

  const log = db.prepare("SELECT * FROM change_log WHERE kind = 'parts' AND record_id = ?").all(s.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].change, 'edited');
  assert.deepEqual(JSON.parse(log[0].before_json).items, [{ part_name: 'EDIT-ME', quantity: 70 }]);
  const detail = (await (await loggedIn('admin')).get(`/admin/parts/${s.id}`)).text;
  assert.match(detail, /Edited<\/strong> by Terry Tech/);
  assert.match(detail, /Before: 70 × EDIT-ME · Van stock/);

  // An invalid edit changes nothing.
  assert.equal((await tech.post(page, [['part_name', 'EDIT-ME'], ['quantity', '0'], ['source', 'van']], { multipart: true, page })).status, 400);
  assert.deepEqual(itemsOf(s.id), [{ part_name: 'EDIT-ME', quantity: 7 }]);
});

test('edit and cancel limits: other people, the time window, acted-on requests, cancelled entries', async () => {
  const tech = await loggedIn('tech1');
  const other = await loggedIn('tech2');
  const admin = await loggedIn('admin');
  const s = db.prepare("SELECT s.id FROM parts_submissions s JOIN parts_items i ON i.submission_id = s.id WHERE i.part_name = 'EDIT-ME'").get();
  const fields = [['part_name', 'HACKED'], ['quantity', '1'], ['source', 'van']];

  assert.equal((await other.get(`/parts/${s.id}/edit`)).status, 403);
  assert.equal((await other.post(`/parts/${s.id}/edit`, fields, { multipart: true })).status, 403);
  assert.equal((await other.post(`/parts/${s.id}/cancel`, {})).status, 403);
  assert.equal((await new Client().get(`/parts/${s.id}/edit`)).status, 302);

  // 25 hours later the owner is locked out, but an admin can still correct it.
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  db.prepare('UPDATE parts_submissions SET created_at = ? WHERE id = ?').run(old, s.id);
  assert.equal((await tech.get(`/parts/${s.id}/edit`)).status, 403);
  assert.equal((await tech.post(`/parts/${s.id}/cancel`, {})).status, 403);
  assert.doesNotMatch((await tech.get('/my')).text, new RegExp(`/parts/${s.id}/edit`));
  assert.equal((await admin.post(`/parts/${s.id}/edit`, [['part_name', 'EDIT-ME'], ['quantity', '6'], ['source', 'van']], { multipart: true, page: `/parts/${s.id}/edit` })).location, `/admin/parts/${s.id}`);
  assert.deepEqual(itemsOf(s.id), [{ part_name: 'EDIT-ME', quantity: 6 }]);

  // A request someone has already acted on cannot be changed by its sender.
  await tech.post('/parts', [['action', 'request'], ['part_name', 'REQ-LOCK'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2026-12-24']], { multipart: true });
  const req = lastParts();
  assert.equal((await tech.get(`/parts/${req.id}/edit`)).status, 200);
  db.prepare("UPDATE parts_submissions SET status = 'ordered' WHERE id = ?").run(req.id);
  assert.equal((await tech.get(`/parts/${req.id}/edit`)).status, 403);

  // Cancel: kept in the log, marked, and no longer changeable by anyone.
  await tech.post('/parts', [['action', 'take'], ['part_name', 'CANCEL-ME'], ['quantity', '9'], ['source', 'van']], { multipart: true });
  const c = lastParts();
  assert.equal((await tech.post(`/parts/${c.id}/cancel`, {})).status, 302);
  assert.ok(db.prepare('SELECT cancelled_at FROM parts_submissions WHERE id = ?').get(c.id).cancelled_at);
  assert.equal(db.prepare("SELECT change FROM change_log WHERE kind = 'parts' AND record_id = ?").get(c.id).change, 'cancelled');
  assert.match((await tech.get('/my')).text, /Cancelled/);
  assert.equal((await admin.get(`/parts/${c.id}/edit`)).status, 403);
  assert.match((await admin.get('/admin/parts?q=CANCEL-ME')).text, /Cancelled/);
  assert.match((await admin.get('/admin/parts.csv?q=CANCEL-ME')).text, /CANCEL-ME,9,Van stock.*\d{4}, /);
});

test('training requests can be edited and cancelled the same way', async () => {
  const tech = await loggedIn('tech1');
  await tech.post('/training', { description: 'Zone expandors', wants_contact: 'no', is_private: 'no' });
  const t = db.prepare('SELECT * FROM training_requests ORDER BY id DESC').get();
  const page = `/training/${t.id}/edit`;
  assert.equal((await tech.post(page, { description: 'Zone expanders', wants_contact: 'yes', is_private: 'yes' }, { page })).status, 302);
  const after = db.prepare('SELECT * FROM training_requests WHERE id = ?').get(t.id);
  assert.deepEqual([after.description, after.wants_contact, after.is_private], ['Zone expanders', 1, 1]);
  assert.equal(JSON.parse(db.prepare("SELECT before_json FROM change_log WHERE kind = 'training' AND record_id = ?").get(t.id).before_json).description, 'Zone expandors');
  assert.equal((await (await loggedIn('tech2')).post(`/training/${t.id}/cancel`, {})).status, 403);
  db.prepare("UPDATE training_requests SET status = 'scheduled' WHERE id = ?").run(t.id);
  assert.equal((await tech.get(page)).status, 403);
  db.prepare("UPDATE training_requests SET status = 'new' WHERE id = ?").run(t.id);
  assert.equal((await tech.post(`/training/${t.id}/cancel`, {})).status, 302);
  assert.match((await tech.get('/my')).text, /Cancelled/);
});

test('usage summary adds up takes and returns and leaves cancelled entries out', async () => {
  const tech = await loggedIn('tech2');
  const send = (action, qty, extra = []) => tech.post('/parts', [['action', action], ['part_name', action === 'take' ? 'sum-part' : 'SUM-PART '], ['quantity', String(qty)], ...extra], { multipart: true });
  await send('take', 10, [['source', 'job'], ['job_number', 'SUMJOB-1']]);
  await send('take', 5, [['source', 'van']]);
  await send('return', 3, [['source', 'job'], ['job_number', 'SUMJOB-1']]);
  await send('request', 20, [['source', 'van'], ['needed_by', '2026-12-31']]);
  await send('take', 100, [['source', 'van']]);
  await tech.post(`/parts/${lastParts().id}/cancel`, {});

  const admin = await loggedIn('admin');
  const csv = (await admin.get('/admin/parts/summary.csv?q=sum-part')).text.trim().split('\r\n');
  assert.match(csv[0], /Part,Description,Taken,Returned,Net used,Requested,Entries/);
  assert.equal(csv.length, 2); // upper/lower case and stray spaces are one part
  assert.match(csv[1], /^sum-part,,15,3,12,20,4$/i);

  const html = (await admin.get('/admin/parts/summary?q=sum-part')).text;
  assert.match(html, /Uma Tech<\/td><td class="num">15<\/td><td class="num">3<\/td>/);
  assert.match(html, /SUMJOB-1<\/td><td class="num">10<\/td><td class="num">3<\/td>/);
  assert.equal((await admin.get('/admin/parts/summary?from=2000-01-01&to=2000-01-02')).status, 200);
  assert.equal((await tech.get('/admin/parts/summary')).status, 403);
  assert.equal((await tech.get('/admin/parts/summary.csv')).status, 403);
});

test('parts catalog: import ignores prices, re-import updates, suggestions work', async () => {
  const admin = await loggedIn('admin');
  const page = '/admin/catalog';
  const csv = 'Category,Part Code,Description,Manufacturer,Cost/Price\r\nAlarm,SIGA-CT2,"Dual input module, Class B",Edwards,41.17\r\nAlarm,SIGA-UM,Universal module,Edwards,55.25\r\nAlarm,,No part number,,1\r\nBATTERY,BAT-12V7,12V 7Ah SLA battery,Duracell,9.99\r\n';
  const up = (text, name = 'sedona.csv') => admin.post('/admin/catalog/import', [['file', new File([text], name, { type: 'text/csv' })]], { multipart: true, page });
  assert.equal((await up(csv)).status, 302);
  assert.match((await admin.get(page)).text, /3 added, 0 updated, 0 unchanged, 1 rows skipped/);

  const cols = db.prepare("SELECT name FROM pragma_table_info('parts_catalog')").all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['active', 'category', 'count_at', 'count_qty', 'created_at', 'description', 'id', 'manufacturer', 'min_level', 'part_number', 'stocked']);
  assert.ok(!cols.some((c) => /price|cost/i.test(c)));
  const stored = JSON.stringify(db.prepare('SELECT * FROM parts_catalog').all());
  for (const price of ['41.17', '55.25', '9.99']) assert.ok(!stored.includes(price), price);
  assert.equal(db.prepare("SELECT description FROM parts_catalog WHERE part_number = 'siga-ct2'").get().description, 'Dual input module, Class B');
  assert.equal(db.prepare("SELECT category FROM parts_catalog WHERE part_number = 'BAT-12V7'").get().category, 'BATTERY');

  await up('part number\tdescription\nSIGA-UM\tUniversal class A/B module\nNEW-1\tNew thing\n');
  assert.match((await admin.get(page)).text, /1 added, 1 updated/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_catalog').get().n, 4); // nothing removed

  assert.equal((await up('PK\u0003\u0004 pretend excel', 'parts.xlsx')).status, 400);
  assert.equal((await admin.post(page, { part_number: 'siga-ct2', description: 'dup' }, { page })).status, 400);
  assert.equal((await admin.post(page, { part_number: 'HAND-1', description: 'Added by hand' }, { page })).status, 302);

  const tech = await loggedIn('tech1');
  const suggest = async (q) => JSON.parse((await tech.get('/parts/suggest?q=' + encodeURIComponent(q))).text);
  assert.deepEqual((await suggest('siga')).map((r) => r.n), ['SIGA-CT2', 'SIGA-UM']);
  assert.deepEqual(await suggest('battery'), [{ n: 'BAT-12V7', d: '12V 7Ah SLA battery' }]); // matches on description
  assert.ok((await suggest('4W')).some((r) => r.n === '4WB'));  // falls back to names used before
  assert.deepEqual(await suggest('s'), []);
  assert.deepEqual(await suggest('100%'), []);

  const id = db.prepare("SELECT id FROM parts_catalog WHERE part_number = 'SIGA-UM'").get().id;
  await admin.post(`/admin/catalog/${id}/toggle`, {}, { page });
  assert.deepEqual((await suggest('siga-')).map((r) => r.n), ['SIGA-CT2']);

  // The summary picks up the catalog description.
  assert.match((await admin.get('/admin/parts/summary.csv?q=SIGA-CT2')).text, /SIGA-CT2,"Dual input module, Class B",7,/);

  assert.equal((await tech.get(page)).status, 403);
  assert.equal((await tech.post(page, { part_number: 'X' })).status, 403);
  assert.equal((await new Client().get('/parts/suggest?q=siga')).status, 302);
});

test('backups: limited to admins who may read complaints; nightly copy is made once and emailed', async () => {
  assert.equal((await (await loggedIn('admin')).get('/admin/backups')).status, 403);     // admin, not reviewer
  assert.equal((await (await loggedIn('reviewer')).get('/admin/backups')).status, 403);  // reviewer, not admin
  const owner = await loggedIn('owner');
  const page = '/admin/backups';
  assert.equal((await owner.get(page)).status, 200);
  assert.equal((await owner.post(`${page}/run`, {}, { page })).status, 302);
  const name = /href="\/admin\/backups\/(portal-[0-9-]+\.db)"/.exec((await owner.get(page)).text)[1];
  const file = await owner.get(`${page}/${name}`);
  assert.equal(file.status, 200);
  assert.ok(file.text.startsWith('SQLite format 3'));
  assert.equal((await owner.get(`${page}/..%2Fportal.db`)).status, 404);
  assert.equal((await owner.get(`${page}/portal-1999-01-01.db`)).status, 404);
  assert.equal((await (await loggedIn('admin')).get(`${page}/${name}`)).status, 403);

  const backup = require('../app/backup');
  sent.length = 0;
  const made = await backup.nightly();
  assert.match(made, /^portal-\d{4}-\d{2}-\d{2}\.db$/);
  assert.equal(await backup.nightly(), null); // only once a day
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.equal(sent[0].attachments[0].filename, made + '.gz');
  const restored = require('zlib').gunzipSync(sent[0].attachments[0].content);
  assert.equal(restored.subarray(0, 15).toString(), 'SQLite format 3');

  // The copy is a complete, readable database.
  const Database = require('better-sqlite3');
  const copy = new Database(path.join(dataDir, 'backups', made), { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n, db.prepare('SELECT COUNT(*) n FROM users').get().n);
  copy.close();
});

test('the get-the-app bar is on every page, hidden until the phone script shows it', async () => {
  const login = (await new Client().get('/login')).text;
  assert.match(login, /<aside class="install-bar no-print" id="install-bar" hidden/);
  const home = (await (await loggedIn('tech1')).get('/')).text;
  assert.match(home, /id="install-bar" hidden/);
  assert.match(home, /id="install-go" hidden/);
  const js = (await new Client().get('/site.js')).text;
  assert.match(js, /beforeinstallprompt/);
  assert.match(js, /display-mode: /);          // never shown inside the installed app
  assert.match(js, /navigator\.standalone/);
});

test('the QR code sign needs a sign-in and carries a code for the site address', async () => {
  const out = await new Client().get('/poster');
  assert.equal(out.status, 302);
  const page = await (await loggedIn('tech1')).get('/poster');
  assert.equal(page.status, 200);
  assert.match(page.text, /SCAN ME/);
  assert.match(page.text, /<svg[^>]*viewBox/);
  assert.match(page.text, /class="poster-url">https?:\/\/[^<]+</);
  assert.equal((await new Client().get('/poster.js')).status, 200);
});

test('home-screen app files are served, and signed-out pages still work', async () => {
  const c = new Client();
  const manifest = await c.get('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  const m = JSON.parse(manifest.text);
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  for (const icon of m.icons) assert.equal((await c.get(icon.src)).status, 200, icon.src);
  for (const url of ['/sw.js', '/site.js', '/offline.html', '/offline.js', '/icons/apple-touch-icon.png']) assert.equal((await c.get(url)).status, 200, url);
  const sw = (await c.get('/sw.js')).text;
  for (const asset of /var ASSETS = \[(.*)\]/.exec(sw)[1].match(/'[^']+'/g)) assert.equal((await c.get(asset.slice(1, -1))).status, 200, asset);
  const login = (await c.get('/login')).text;
  assert.match(login, /rel="manifest"/);
  // Complaint drafts are never saved on the phone.
  const complaint = (await (await loggedIn('tech1')).get('/complaint')).text;
  assert.doesNotMatch(complaint, /data-draft=/);
  assert.match((await (await loggedIn('tech1')).get('/parts')).text, /data-draft="parts:\d+"/);
});

test('a database from the first release is upgraded in place without losing data', async () => {
  const { execFileSync } = require('child_process');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-old-'));
  const old = new Database(path.join(dir, 'portal.db'));
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, email TEXT,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', can_review_complaints INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE parts_submissions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL, job_number TEXT,
      note TEXT, needed_by TEXT, photo_path TEXT, status TEXT, admin_note TEXT, created_at TEXT NOT NULL, created_local_date TEXT NOT NULL);
    CREATE TABLE training_requests (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, description TEXT NOT NULL, wants_contact INTEGER NOT NULL,
      is_private INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', admin_note TEXT, created_at TEXT NOT NULL, created_local_date TEXT NOT NULL);
    INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('old', 'Old User', 'x', '2026-01-01');
    INSERT INTO users (username, display_name, password_hash, role, can_review_complaints, created_at) VALUES
      ('boss', 'First Admin', 'x', 'admin', 1, '2026-01-02'), ('second', 'Second Admin', 'x', 'admin', 1, '2026-01-03'),
      ('plainadmin', 'Admin No Complaints', 'x', 'admin', 0, '2026-01-04'), ('rev', 'Reviewer Only', 'x', 'user', 1, '2026-01-05');
    INSERT INTO parts_submissions (user_id, action, source, created_at, created_local_date) VALUES (1, 'take', 'van', '2026-01-01T00:00:00Z', '2026-01-01');
  `);
  old.close();
  const out = execFileSync(process.execPath, ['-e', `
    const db = require('./app/db'); require('./app/db');
    const access = require('./app/permissions'); access.migrate(); // running it twice changes nothing
    const who = db.prepare('SELECT u.username, p.name AS profile, u.is_master FROM users u JOIN profiles p ON p.id = u.profile_id ORDER BY u.id').all();
    const perms = (name) => [...access.permsOf(access.profileByName(name).id)].sort();
    const cols = (t) => db.prepare("SELECT name FROM pragma_table_info('" + t + "')").all().map((c) => c.name);
    console.log(JSON.stringify({ parts: cols('parts_submissions'), training: cols('training_requests'),
      rows: db.prepare('SELECT COUNT(*) n FROM parts_submissions').get().n, catalog: cols('parts_catalog').length,
      who, adminPerms: perms('Admin').length, all: access.ALL.length, plain: perms('Admin (no complaints)'), rev: perms('Complaint reviewer'),
      profiles: db.prepare('SELECT name FROM profiles ORDER BY name').all().map((p) => p.name) }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir } });
  const r = JSON.parse(out.toString());
  for (const t of [r.parts, r.training]) { assert.ok(t.includes('edited_at')); assert.ok(t.includes('cancelled_at')); }
  assert.equal(r.rows, 1);
  assert.ok(r.catalog > 0);
  // Everyone keeps exactly the access they had, and the first admin becomes the master account.
  assert.deepEqual(r.who, [
    { username: 'old', profile: 'Technician', is_master: 0 },
    { username: 'boss', profile: 'Admin', is_master: 1 },
    { username: 'second', profile: 'Admin', is_master: 0 },
    { username: 'plainadmin', profile: 'Admin (no complaints)', is_master: 0 },
    { username: 'rev', profile: 'Complaint reviewer', is_master: 0 },
  ]);
  assert.equal(r.adminPerms, r.all);
  assert.ok(!r.plain.includes('complaints.review') && !r.plain.includes('backups') && r.plain.includes('users.manage'));
  assert.ok(r.rev.includes('complaints.review') && !r.rev.includes('parts.view'));
  assert.deepEqual(r.profiles, ['Admin', 'Admin (no complaints)', 'Complaint reviewer', 'Manager', 'Technician', 'Warehouse']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Audit, logo banner and light/dark switch
// ---------------------------------------------------------------------------

test('audit: lists what was taken, returned and requested in a date range, with totals', async () => {
  const tech = await loggedIn('tech2');
  const send = (fields) => tech.post('/parts', fields, { multipart: true });
  await send([['action', 'take'], ['part_name', 'AUD-A'], ['quantity', '4'], ['part_name', 'SIGA-CT2'], ['quantity', '2'], ['source', 'job'], ['job_number', 'AUDJOB']]);
  const takeId = lastParts().id;
  await send([['action', 'return'], ['part_name', 'AUD-A'], ['quantity', '1'], ['source', 'van']]);
  await send([['action', 'request'], ['part_name', 'AUD-B'], ['quantity', '9'], ['source', 'van'], ['needed_by', '2027-01-15']]);
  await send([['action', 'take'], ['part_name', 'AUD-CANCELLED'], ['quantity', '500'], ['source', 'van']]);
  await tech.post(`/parts/${lastParts().id}/cancel`, {});
  // Move these four entries to their own days so the totals are exact.
  const uid = db.prepare("SELECT id FROM users WHERE username = 'tech2'").get().id;
  db.prepare("UPDATE parts_submissions SET created_local_date = '2031-03-10' WHERE id >= ? AND user_id = ?").run(takeId, uid);
  db.prepare("UPDATE parts_submissions SET created_local_date = '2031-03-20' WHERE id = ?").run(takeId + 2);

  const admin = await loggedIn('admin');
  const page = '/admin/parts/audit?from=2031-03-01&to=2031-03-15';
  const html = (await admin.get(page)).text.replace(/\s+/g, ' ');
  assert.match(html, /3\/1\/2031 to 3\/15\/2031/);
  assert.match(html, /Taken<\/span> <span class="stat-num">6<\/span> <span class="stat-sub">units in 1 entry · 0 of 1 checked/);
  assert.match(html, /Returned<\/span> <span class="stat-num">1<\/span>/);
  assert.match(html, /Requested<\/span> <span class="stat-num">0<\/span>/); // the request is on the 20th
  assert.match(html, /1 cancelled, not counted/);
  assert.match(html, /AUD-CANCELLED/);                                     // shown, struck out, not in the totals
  assert.match(html, /<span class="pn">SIGA-CT2<\/span><span class="sub">Dual input module, Class B<\/span><\/td> <td class="num qty">2<\/td>/); // catalog description
  assert.match((await admin.get('/admin/parts/audit?from=2031-03-16&to=2031-03-31')).text.replace(/\s+/g, ' '), /Requested<\/span> <span class="stat-num">9<\/span>/);
  // Dates the wrong way round are swapped; with no dates it shows this month.
  assert.match((await admin.get('/admin/parts/audit?from=2031-03-15&to=2031-03-01')).text, /3\/1\/2031 to 3\/15\/2031/);
  assert.equal((await admin.get('/admin/parts/audit')).status, 200);

  const csv = (await admin.get('/admin/parts/audit.csv?from=2031-03-01&to=2031-03-31')).text.trim().split('\r\n');
  assert.match(csv[0], /^.?Entry,Submitted,Action,Name,Part,Description,Quantity/);
  assert.equal(csv.length, 1 + 5); // five part lines including the cancelled one
  assert.ok(csv.some((l) => /Take parts,Uma Tech,AUD-A,,4,Job,AUDJOB/.test(l)));

  for (const url of ['/admin/parts/audit', '/admin/parts/audit.csv']) assert.equal((await tech.get(url)).status, 403, url);
  assert.equal((await tech.post(`/admin/parts/${takeId}/audit`, {})).status, 403);
  assert.equal((await tech.post('/admin/parts/audit/check-all', {})).status, 403);
});

test('audit: entries can be ticked as checked, one by one or all at once; an edit unticks', async () => {
  const admin = await loggedIn('admin');
  const range = 'from=2031-03-01&to=2031-03-31';
  const page = '/admin/parts/audit?' + range;
  const ids = db.prepare("SELECT id, action, cancelled_at FROM parts_submissions WHERE created_local_date LIKE '2031-03-%' ORDER BY id").all();
  const [take, ret, req, cancelled] = ids.map((r) => r.id);
  const checked = (id) => db.prepare('SELECT audited_at, audited_by FROM parts_submissions WHERE id = ?').get(id);
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

  const r = await admin.post(`/admin/parts/${take}/audit`, { qs: range }, { page });
  assert.equal(r.location, `/admin/parts/audit?${range}#e${take}`);
  assert.equal(checked(take).audited_by, adminId);
  assert.match((await admin.get(page)).text.replace(/\s+/g, ' '), /1 of 1 checked/);
  assert.match((await admin.get(page)).text, /<span class="sub">Ada Admin, \d/);

  await admin.post(`/admin/parts/${take}/audit`, { qs: range }, { page });   // click again to undo
  assert.equal(checked(take).audited_at, null);
  await admin.post(`/admin/parts/${cancelled}/audit`, { qs: range }, { page }); // cancelled entries cannot be ticked
  assert.equal(checked(cancelled).audited_at, null);

  // "Mark all as checked" for one section only touches that section and that date range.
  const before = db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE audited_at IS NOT NULL').get().n;
  await admin.post('/admin/parts/audit/check-all', { qs: range, action: 'take' }, { page });
  assert.ok(checked(take).audited_at);
  assert.equal(checked(ret).audited_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE audited_at IS NOT NULL').get().n, before + 1);
  await admin.post('/admin/parts/audit/check-all', { qs: range }, { page });
  assert.ok(checked(ret).audited_at && checked(req).audited_at);
  assert.equal(checked(cancelled).audited_at, null);
  assert.match((await admin.get(page + '&show=unchecked')).text, /Nothing taken in these dates/);

  // The redirect target is rebuilt from known fields, never taken as-is.
  assert.equal((await admin.post(`/admin/parts/${ret}/audit`, { qs: 'from=//evil.example&to=x' }, { page })).location.startsWith('/admin/parts/audit?from='), true);

  // Changing an entry after it was checked means it needs checking again.
  await admin.post(`/parts/${take}/edit`, [['part_name', 'AUD-A'], ['quantity', '3'], ['source', 'van']], { multipart: true, page: `/parts/${take}/edit` });
  assert.equal(checked(take).audited_at, null);
});

test('logo banner and light/dark switch are on every page', async () => {
  const c = new Client();
  for (const url of ['/logo.png', '/theme.js']) assert.equal((await c.get(url)).status, 200, url);
  const login = (await c.get('/login')).text;
  assert.match(login, /<img src="\/logo\.png" alt="Pye-Barker Fire &amp; Safety"/);
  assert.match(login, /id="theme-toggle"/);                          // available before signing in too
  assert.ok(login.indexOf('/theme.js') < login.indexOf('/styles.css')); // applied before the page is drawn
  assert.match((await (await loggedIn('tech1')).get('/')).text, /id="theme-toggle"/);
  const css = (await c.get('/styles.css')).text;
  for (const color of ['#24b24b', '#235fad', '#09324f']) assert.ok(css.includes(color), color);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/);
});

test('an admin can change a person\'s name, username and email after the account exists', async () => {
  const admin = await loggedIn('admin');
  const id = auth.createUser({ username: 'uriah.redos', displayName: 'uriah.redos', password: 'correct horse battery' });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  const page = `/admin/users/${id}/edit`;
  assert.match((await admin.get('/admin/users')).text, new RegExp(`href="${page}"`));
  assert.match((await admin.get(page)).text, /value="uriah\.redos"/);
  assert.equal((await admin.post(page, { username: 'uriah.redos', display_name: 'Uriah Redos', email: '' }, { page })).status, 302);
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get(id).display_name, 'Uriah Redos');
  const user = await loggedIn('uriah.redos'); // sign-in is unaffected
  assert.match((await user.get('/')).text, /Hi, Uriah Redos/);

  assert.equal((await admin.post(page, { username: 'tech1', display_name: 'Uriah Redos' }, { page })).status, 400); // taken
  assert.equal((await admin.post(page, { username: 'uriah.redos', display_name: '' }, { page })).status, 400);
  assert.equal((await admin.post(page, { username: 'uriah.redos', display_name: 'U', email: 'nope' }, { page })).status, 400);
  assert.equal((await admin.post(page, { username: 'uredos', display_name: 'Uriah Redos', email: 'u@example.com' }, { page })).status, 302);
  await loggedIn('uredos');
  assert.equal((await user.get(page)).status, 403);
  assert.equal((await user.post(page, { username: 'x', display_name: 'Hacked' })).status, 403);
});

// ---------------------------------------------------------------------------
// Profiles, permission tick-boxes, managers and the master account
// ---------------------------------------------------------------------------

const userId = (username) => db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
const profileId = (name) => access.profileByName(name).id;
const navLinks = (html) => [...(/<nav class="nav"[\s\S]*?<\/nav>/.exec(html) || [''])[0].matchAll(/<a href="(\/admin\/[a-z/]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);

test('starting profiles: Technician, Warehouse, Manager and Admin each see only what they should', async () => {
  makeUser('wh1', 'Wanda Warehouse', { profile: 'Warehouse' });
  const tech = await loggedIn('tech1');
  const wh = await loggedIn('wh1');
  const owner = await loggedIn('owner');

  assert.deepEqual(navLinks((await tech.get('/')).text), []); // a technician has no admin menu at all
  assert.deepEqual(navLinks((await wh.get('/')).text), ['/admin/parts', '/admin/requests', '/admin/parts/audit', '/admin/stock', '/admin/parts/summary', '/admin/catalog', '/admin/inspections', '/admin/inspections/checklist']);
  assert.deepEqual(navLinks((await owner.get('/')).text),
    ['/admin/parts', '/admin/requests', '/admin/parts/audit', '/admin/stock', '/admin/parts/summary', '/admin/catalog', '/admin/inspections', '/admin/inspections/checklist',
      '/admin/training', '/admin/training/sessions', '/admin/certs', '/admin/users', '/admin/profiles', '/admin/tasks', '/admin/announcements', '/admin/newsletters', '/admin/complaints', '/admin/activity', '/admin/backups', '/admin/import']);

  for (const url of ['/admin/parts', '/admin/parts/audit', '/admin/parts/summary', '/admin/catalog']) assert.equal((await wh.get(url)).status, 200, url);
  for (const url of ['/admin/training', '/admin/users', '/admin/profiles', '/admin/complaints', '/admin/backups']) assert.equal((await wh.get(url)).status, 403, url);
  assert.equal((await wh.get('/admin')).location, '/admin/parts');
  assert.equal((await tech.get('/admin')).status, 403);
  // Warehouse sees everyone's parts, and can act on a request.
  const req = db.prepare("SELECT id FROM parts_submissions WHERE action = 'request' AND cancelled_at IS NULL ORDER BY id DESC").get();
  assert.equal((await wh.post(`/admin/parts/${req.id}/status`, { status: 'fulfilled', admin_note: 'On the shelf' }, { page: `/admin/parts/${req.id}` })).status, 302);
  assert.equal(db.prepare('SELECT status FROM parts_submissions WHERE id = ?').get(req.id).status, 'fulfilled');
});

test('a manager sees and manages only the people assigned to them', async () => {
  makeUser('mgr1', 'Mona Manager', { profile: 'Manager' });
  const owner = await loggedIn('owner');
  const mgr = await loggedIn('mgr1');
  const t1 = await loggedIn('tech1');
  const t2 = await loggedIn('tech2');
  await t1.post('/parts', [['action', 'take'], ['part_name', 'TEAM-ONE'], ['quantity', '3'], ['source', 'van']], { multipart: true });
  const mine = lastParts().id;
  await t2.post('/parts', [['action', 'take'], ['part_name', 'TEAM-TWO'], ['quantity', '8'], ['source', 'van']], { multipart: true });
  const theirs = lastParts().id;
  await t1.post('/training', { description: 'Team one training', wants_contact: 'no', is_private: 'no' });
  const myTraining = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  await t2.post('/training', { description: 'Team two training', wants_contact: 'no', is_private: 'no' });
  const theirTraining = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;

  // With nobody assigned a manager sees only their own (empty) entries.
  assert.doesNotMatch((await mgr.get('/admin/parts')).text, /TEAM-ONE|TEAM-TWO/);

  // An admin assigns tech1 to the manager on the manager's edit page.
  const page = `/admin/users/${userId('mgr1')}/edit`;
  assert.match((await owner.get(page)).text, /People Mona Manager manages/);
  await owner.post(page, [['username', 'mgr1'], ['display_name', 'Mona Manager'], ['profile_id', String(profileId('Manager'))], ['team_form', '1'], ['team', String(userId('tech1'))]], { page });
  assert.deepEqual(db.prepare('SELECT user_id FROM user_managers WHERE manager_id = ?').all(userId('mgr1')).map((r) => r.user_id), [userId('tech1')]);
  assert.match((await owner.get('/admin/users')).text.replace(/\s+/g, ' '), /Terry Tech.*?<td>Mona Manager<\/td>/);

  // Parts log, exports, summary and audit are limited to that person.
  for (const url of ['/admin/parts', '/admin/parts.csv', '/admin/parts/summary', '/admin/parts/summary.csv', '/admin/parts/audit', '/admin/parts/audit.csv']) {
    const text = (await mgr.get(url)).text;
    assert.match(text, /TEAM-ONE/, url);
    assert.doesNotMatch(text, /TEAM-TWO|Uma Tech/, url);
  }
  assert.doesNotMatch((await mgr.get(`/admin/parts?user=${userId('tech2')}`)).text, /TEAM-TWO/); // asking for someone else gets nothing
  assert.equal((await mgr.get(`/admin/parts/${mine}`)).status, 200);
  assert.equal((await mgr.get(`/admin/parts/${theirs}`)).status, 403);
  assert.equal((await mgr.get(`/parts/${theirs}/edit`)).status, 403);
  assert.equal((await mgr.post(`/parts/${theirs}/cancel`, {})).status, 403);
  assert.equal((await mgr.post(`/admin/parts/${theirs}/audit`, {})).status, 403);
  assert.equal((await mgr.post(`/admin/parts/${theirs}/status`, { status: 'declined' })).status, 403);
  assert.equal((await mgr.get(`/parts/${mine}/edit`)).status, 200);
  assert.equal((await mgr.post(`/admin/parts/${mine}/audit`, {})).status, 302);
  // "Mark all as checked" cannot reach outside the team either.
  await mgr.post('/admin/parts/audit/check-all', { qs: 'from=2020-01-01&to=2099-01-01' }, { page: '/admin/parts/audit' });
  assert.equal(db.prepare('SELECT audited_at FROM parts_submissions WHERE id = ?').get(theirs).audited_at, null);
  assert.ok(db.prepare('SELECT audited_at FROM parts_submissions WHERE id = ?').get(mine).audited_at);

  // Training the same way.
  const training = (await mgr.get('/admin/training')).text;
  assert.match(training, /Team one training/); assert.doesNotMatch(training, /Team two training/);
  assert.doesNotMatch((await mgr.get('/admin/training.csv')).text, /Team two training/);
  assert.equal((await mgr.get(`/admin/training/${theirTraining}`)).status, 403);
  assert.equal((await mgr.post(`/admin/training/${theirTraining}/status`, { status: 'declined' })).status, 403);
  assert.equal((await mgr.post(`/admin/training/${myTraining}/status`, { status: 'reviewed', admin_note: '' }, { page: `/admin/training/${myTraining}` })).status, 302);

  // The manager profile has no people-management, profiles, catalog or complaints.
  for (const url of ['/admin/users', '/admin/profiles', '/admin/catalog', '/admin/complaints', '/admin/backups']) assert.equal((await mgr.get(url)).status, 403, url);
});

test('a manager profile given "manage people" can only touch their own people, and cannot add accounts or change profiles', async () => {
  access.setPermissions(profileId('Manager'), [...access.permsOf(profileId('Manager')), 'users.manage']);
  const mgr = await loggedIn('mgr1');
  const list = (await mgr.get('/admin/users')).text;
  assert.match(list, /Your people/); assert.match(list, /Terry Tech/);
  assert.doesNotMatch(list, /Uma Tech|Olive Owner|Add a person/);
  assert.equal((await mgr.post('/admin/users', { username: 'sneaky', display_name: 'Sneaky', profile_id: profileId('Technician') })).status, 403);
  const t1 = `/admin/users/${userId('tech1')}`;
  const edit = (await mgr.get(`${t1}/edit`)).text;
  assert.doesNotMatch(edit, /name="profile_id"/);
  await mgr.post(`${t1}/edit`, { username: 'tech1', display_name: 'Terry Tech', profile_id: profileId('Manager') }, { page: `${t1}/edit` });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(userId('tech1')).profile_id, profileId('Technician')); // ignored
  assert.equal((await mgr.post(`${t1}/reset-password`, {}, { page: '/admin/users' })).status, 302);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(auth.hashPassword('correct horse battery'), userId('tech1'));
  for (const other of ['tech2', 'owner', 'admin']) {
    assert.equal((await mgr.get(`/admin/users/${userId(other)}/edit`)).status, 403, other);
    assert.equal((await mgr.post(`/admin/users/${userId(other)}/reset-password`, {})).status, 403, other);
    assert.equal((await mgr.post(`/admin/users/${userId(other)}/toggle-active`, {})).status, 403, other);
  }
  access.setPermissions(profileId('Manager'), [...access.permsOf(profileId('Manager'))].filter((p) => p !== 'users.manage'));
});

test('the master account can do everything and cannot be edited, disabled or reset by anyone else', async () => {
  makeUser('master', 'Max Master', { profile: 'Technician', master: true }); // master overrides whatever the profile says
  const master = await loggedIn('master');
  const owner = await loggedIn('owner'); // a full Admin
  const mid = userId('master');

  for (const url of ['/admin/parts', '/admin/parts/audit', '/admin/training', '/admin/catalog', '/admin/users', '/admin/profiles', '/admin/complaints', '/admin/backups']) {
    assert.equal((await master.get(url)).status, 200, url);
  }
  const list = (await owner.get('/admin/users')).text.replace(/\s+/g, ' ');
  assert.match(list, /Max Master.*?class="tag master">Master<.*?Protected/);
  assert.equal((await owner.get(`/admin/users/${mid}/edit`)).status, 403);
  assert.equal((await owner.post(`/admin/users/${mid}/edit`, { username: 'master', display_name: 'Hacked', profile_id: profileId('Technician') })).status, 403);
  assert.equal((await owner.post(`/admin/users/${mid}/reset-password`, {})).status, 403);
  assert.equal((await owner.post(`/admin/users/${mid}/toggle-active`, {})).status, 403);
  const row = db.prepare('SELECT display_name, active, is_master FROM users WHERE id = ?').get(mid);
  assert.deepEqual({ ...row }, { display_name: 'Max Master', active: 1, is_master: 1 });
  await new Client().login('master', 'correct horse battery'); // password untouched

  // The master can edit their own name, and manage any admin.
  const page = `/admin/users/${mid}/edit`;
  assert.match((await master.get(page)).text, /This is the master account/);
  await master.post(page, { username: 'master', display_name: 'Maxine Master', profile_id: profileId('Technician') }, { page });
  assert.equal(db.prepare('SELECT display_name, is_master FROM users WHERE id = ?').get(mid).display_name, 'Maxine Master');
  assert.equal((await master.post(`/admin/users/${mid}/toggle-active`, {}, { page: '/admin/users' })).status, 302);
  assert.equal(db.prepare('SELECT active FROM users WHERE id = ?').get(mid).active, 1); // cannot disable itself either
  assert.equal((await master.get(`/admin/users/${userId('owner')}/edit`)).status, 200);
  // No profile can be called Master.
  assert.equal((await master.post('/admin/profiles', { name: 'master' }, { page: '/admin/profiles' })).status, 400);
});

test('profiles: add a new one, tick permissions, and it takes effect straight away', async () => {
  const owner = await loggedIn('owner');
  const r = await owner.post('/admin/profiles', { name: 'Dispatcher' }, { page: '/admin/profiles' });
  const pid = profileId('Dispatcher');
  assert.equal(r.location, `/admin/profiles/${pid}`);
  assert.deepEqual([...access.permsOf(pid)].sort(), [...access.SUBMIT].sort()); // starts with the three "send a form" boxes
  assert.equal((await owner.post('/admin/profiles', { name: 'dispatcher' }, { page: '/admin/profiles' })).status, 400);

  const form = (await owner.get(`/admin/profiles/${pid}`)).text;
  for (const key of access.ALL) assert.match(form, new RegExp(`name="perms" value="${key.replace('.', '\\.')}"`));

  makeUser('disp1', 'Dina Dispatcher', { profile: 'Dispatcher' });
  const disp = await loggedIn('disp1');
  assert.equal((await disp.get('/admin/training')).status, 403);
  await owner.post(`/admin/profiles/${pid}`, [['name', 'Dispatcher'], ['scope', 'all'], ['perms', 'parts.submit'], ['perms', 'training.view'], ['perms', 'made.up']], { page: `/admin/profiles/${pid}` });
  assert.deepEqual([...access.permsOf(pid)].sort(), ['parts.submit', 'training.view']);
  assert.equal((await disp.get('/admin/training')).status, 200);     // gained on the very next request
  assert.equal((await disp.get('/training')).status, 403);            // and lost the unticked ones
  assert.equal((await disp.get('/complaint')).status, 403);
  assert.equal((await disp.post('/admin/training/1/status', { status: 'declined' })).status, 403); // view is not manage
  const home = (await disp.get('/')).text;
  assert.match(home, /Take parts/); assert.doesNotMatch(home, /Training request|Anonymous complaint/);

  // A profile in use cannot be deleted; an empty one can.
  await owner.post(`/admin/profiles/${pid}/delete`, {}, { page: '/admin/profiles' });
  assert.ok(access.profileByName('Dispatcher'));
  await owner.post('/admin/profiles', { name: 'Temp' }, { page: '/admin/profiles' });
  await owner.post(`/admin/profiles/${profileId('Temp')}/delete`, {}, { page: '/admin/profiles' });
  assert.equal(access.profileByName('Temp'), undefined);

  for (const who of ['tech1', 'wh1', 'mgr1']) {
    const c = await loggedIn(who);
    assert.equal((await c.get('/admin/profiles')).status, 403, who);
    assert.equal((await c.post(`/admin/profiles/${pid}`, { name: 'Dispatcher', perms: 'profiles.manage' })).status, 403, who);
  }
});

test('nobody can hand out more access than they have themselves', async () => {
  const limited = await loggedIn('admin'); // "Admin (no complaints)": everything except complaints and backups
  const techProfile = profileId('Technician');

  // Editing a profile: boxes they do not hold are locked and stay exactly as they were.
  await limited.post(`/admin/profiles/${techProfile}`, [['name', 'Technician'], ['scope', 'all'], ...access.ALL.map((p) => ['perms', p])], { page: `/admin/profiles/${techProfile}` });
  const tech = access.permsOf(techProfile);
  assert.ok(tech.has('users.manage') && !tech.has('complaints.review') && !tech.has('backups'));
  const adminProfile = profileId('Admin');
  await limited.post(`/admin/profiles/${adminProfile}`, [['name', 'Admin'], ['scope', 'all'], ['perms', 'parts.submit']], { page: `/admin/profiles/${adminProfile}` });
  const full = access.permsOf(adminProfile);
  assert.ok(full.has('complaints.review') && full.has('backups')); // could not strip what they lack
  access.setPermissions(adminProfile, access.ALL);
  access.setPermissions(techProfile, access.SUBMIT);

  // Assigning a profile: only ones no stronger than their own are offered or accepted.
  const t2 = `/admin/users/${userId('tech2')}/edit`;
  assert.doesNotMatch((await limited.get(t2)).text, new RegExp(`<option value="${adminProfile}"`));
  assert.equal((await limited.post(t2, { username: 'tech2', display_name: 'Uma Tech', profile_id: adminProfile }, { page: t2 })).status, 400);
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(userId('tech2')).profile_id, techProfile);
  assert.equal((await limited.post('/admin/users', { username: 'newadmin', display_name: 'New Admin', profile_id: adminProfile }, { page: '/admin/users' })).status, 400);

  // And they cannot edit, reset or disable someone whose profile can do more than theirs.
  const oid = userId('owner');
  assert.match((await limited.get('/admin/users')).text, /Has more access than you/);
  assert.equal((await limited.get(`/admin/users/${oid}/edit`)).status, 403);
  assert.equal((await limited.post(`/admin/users/${oid}/reset-password`, {})).status, 403);
  assert.equal((await limited.post(`/admin/users/${oid}/toggle-active`, {})).status, 403);

  // Unticking "manage profiles" on your own profile is ignored, so you cannot lock yourself out.
  const own = profileId('Admin (no complaints)');
  await limited.post(`/admin/profiles/${own}`, [['name', 'Admin (no complaints)'], ['scope', 'all'], ['perms', 'parts.view'], ['perms', 'users.manage']], { page: `/admin/profiles/${own}` });
  assert.ok(access.permsOf(own).has('profiles.manage'));
  access.setPermissions(own, access.ALL.filter((p) => p !== 'complaints.review' && p !== 'backups'));
});

// ---------------------------------------------------------------------------
// Stock, requests queue, notifications, password reset, activity log, trucks,
// favorites, barcode scanning, training topics and sessions, weekly summary
// ---------------------------------------------------------------------------

const stockLib = require('../app/stock');
const onHand = (pn) => stockLib.list().find((r) => r.part_number === pn).on_hand;
const takeParts = (client, items, extra = []) => client.post('/parts', [['action', 'take'], ...items.flatMap(([n, q]) => [['part_name', n], ['quantity', String(q)]]), ['source', 'van'], ...extra], { multipart: true });

test('stock: on hand follows the count, takes, returns, cancellations, deliveries and recounts', async () => {
  const wh = await loggedIn('wh1');
  const tech = await loggedIn('tech1');
  const page = '/admin/stock';
  assert.equal((await wh.post(page, { part_number: 'STK-1', count: 'ten' }, { page })).status, 400);
  assert.equal((await wh.post(page, { part_number: 'STK-1', count: '20', min_level: '5' }, { page })).status, 302); // not in the catalog: added
  assert.equal(onHand('STK-1'), 20);
  await new Promise((r) => setTimeout(r, 5)); // entries made after the count

  await takeParts(tech, [['stk-1', 6]]);                 // case does not matter
  assert.equal(onHand('STK-1'), 14);
  await tech.post('/parts', [['action', 'return'], ['part_name', 'STK-1'], ['quantity', '2'], ['source', 'van']], { multipart: true });
  assert.equal(onHand('STK-1'), 16);
  await tech.post('/parts', [['action', 'request'], ['part_name', 'STK-1'], ['quantity', '50'], ['source', 'van'], ['needed_by', '2027-02-01']], { multipart: true });
  assert.equal(onHand('STK-1'), 16);                      // a request does not move stock
  await takeParts(tech, [['STK-1', 9]]);
  assert.equal(onHand('STK-1'), 7);
  await tech.post(`/parts/${lastParts().id}/cancel`, {}); // cancelling puts them back
  assert.equal(onHand('STK-1'), 16);

  const id = db.prepare("SELECT id FROM parts_catalog WHERE part_number = 'STK-1'").get().id;
  const part = `/admin/stock/${id}`;
  await wh.post(`${part}/adjust`, { quantity: '30', reason: 'PO 1234' }, { page: part });
  await wh.post(`${part}/adjust`, { quantity: '-1', reason: 'damaged' }, { page: part });
  assert.equal(onHand('STK-1'), 45);
  assert.equal((await wh.post(`${part}/adjust`, { quantity: 'lots' }, { page: part })).status, 302);
  assert.equal(onHand('STK-1'), 45);
  const detail = (await wh.get(part)).text;
  assert.match(detail, /PO 1234/); assert.match(detail, /Take parts/);

  await wh.post(`${part}/count`, { count: '40' }, { page: part }); // a recount is the new starting point
  assert.equal(onHand('STK-1'), 40);
  await wh.post(`${part}/min`, { min_level: '' }, { page: part });
  assert.equal(db.prepare('SELECT min_level FROM parts_catalog WHERE id = ?').get(id).min_level, null);

  // Bulk count from a file.
  const csv = 'Part Number,On hand,Minimum,Cost\nSIGA-CT2,12,4,41.17\nSTK-2,3,,9\n,5,,\nBAD,x,,\n';
  assert.equal((await wh.post('/admin/stock/import', [['file', new File([csv], 'count.csv', { type: 'text/csv' })]], { multipart: true, page })).status, 302);
  assert.match((await wh.get(page)).text, /Counts set for 2 parts, 1 of them new to the catalog\. 2 rows skipped/);
  assert.equal(onHand('SIGA-CT2'), 12);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM parts_catalog WHERE stocked = 1').all()).includes('41.17'));

  // Who may do what.
  const mgr = await loggedIn('mgr1');                      // sees the parts log but does not manage stock
  assert.equal((await mgr.get(page)).status, 200);
  assert.doesNotMatch((await mgr.get(page)).text, /Start tracking a part/);
  assert.equal((await mgr.post(`${part}/adjust`, { quantity: '5' })).status, 403);
  assert.equal((await mgr.post(page, { part_number: 'X', count: '1' })).status, 403);
  assert.equal((await tech.get(page)).status, 403);
  await wh.post(`${part}/stop`, {}, { page: part });
  assert.ok(!stockLib.list().some((r) => r.part_number === 'STK-1'));
});

test('stock: low level is flagged, and an email goes out once when a take crosses the minimum', async () => {
  const wh = await loggedIn('wh1');
  const tech = await loggedIn('tech1');
  await wh.post('/admin/stock', { part_number: 'LOW-1', count: '10', min_level: '4' }, { page: '/admin/stock' });
  await wh.get('/admin/stock'); // shows the "now tracked" message once
  await new Promise((r) => setTimeout(r, 5));
  sent.length = 0;
  await takeParts(tech, [['LOW-1', 3]]);                   // 7 left: fine
  assert.equal(sent.length, 0);
  assert.doesNotMatch((await wh.get('/admin/stock?low=1')).text, /LOW-1/);
  await takeParts(tech, [['LOW-1', 3]]);                   // 4 left: at the minimum
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'boss@example.com');
  assert.match(sent[0].subject, /Low stock: LOW-1/);
  assert.match(sent[0].text, /4 on hand \(minimum 4\)/);
  await takeParts(tech, [['LOW-1', 1]]);                   // already low: no second email
  assert.equal(sent.length, 1);
  const low = (await wh.get('/admin/stock?low=1')).text;
  assert.match(low, /LOW-1/); assert.match(low, /1 at or below minimum/);
  await takeParts(tech, [['LOW-1', 3]]);
  assert.match((await wh.get('/admin/stock?q=LOW-1')).text, />Out</);
});

test('requests queue: open requests by due date, one-tap status, and the sender is told', async () => {
  const tech = await loggedIn('tech1');
  const wh = await loggedIn('wh1');
  db.prepare("UPDATE parts_submissions SET status = 'fulfilled' WHERE action = 'request'").run(); // clear earlier tests' requests
  db.prepare("UPDATE users SET email = 'terry@example.com' WHERE username = 'tech1'").run();
  const ask = (part, due) => tech.post('/parts', [['action', 'request'], ['part_name', part], ['quantity', '1'], ['source', 'van'], ['needed_by', due]], { multipart: true });
  await ask('Q-LATER', '2031-06-01'); const later = lastParts().id;
  await ask('Q-OVERDUE', '2020-01-01'); const overdue = lastParts().id;

  const queue = (await wh.get('/admin/requests')).text;
  assert.match(queue, /2 open, <strong>1 overdue<\/strong>/);
  assert.ok(queue.indexOf('Q-OVERDUE') < queue.indexOf('Q-LATER')); // soonest first
  assert.match((await wh.get('/')).text, /Parts requests <span class="badge">2<\/span>/);

  // A note written on the detail page survives a one-tap status change from the queue.
  await wh.post(`/admin/parts/${overdue}/status`, { status: 'new', admin_note: 'Checking with the supplier' }, { page: `/admin/parts/${overdue}` });
  sent.length = 0;
  const r = await wh.post(`/admin/parts/${overdue}/status`, { status: 'ordered', back: 'requests' }, { page: '/admin/requests' });
  assert.equal(r.location, '/admin/requests');
  const row = db.prepare('SELECT status, admin_note, unseen FROM parts_submissions WHERE id = ?').get(overdue);
  assert.deepEqual({ ...row }, { status: 'ordered', admin_note: 'Checking with the supplier', unseen: 1 });

  // The technician is emailed and sees a badge until they look.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'terry@example.com');
  assert.match(sent[0].subject, /Your parts request is now: Ordered/);
  assert.match(sent[0].text, /Checking with the supplier/);
  assert.match((await tech.get('/')).text, /My activity <span class="badge"[^>]*>2<\/span>/); // the note, then the status
  const mine = (await tech.get('/my')).text;
  assert.match(mine, /class="tag new">Updated</);
  assert.doesNotMatch((await tech.get('/my')).text, /class="tag new">Updated</); // seen now
  assert.doesNotMatch((await tech.get('/')).text, /My activity <span class="badge"/);

  await wh.post(`/admin/parts/${overdue}/status`, { status: 'fulfilled', back: 'requests' }, { page: '/admin/requests' });
  const after = (await wh.get('/admin/requests')).text;
  assert.doesNotMatch(after, /Q-OVERDUE/); assert.match(after, /Q-LATER/);

  // A manager's queue holds only their own people; a technician has no queue.
  await (await loggedIn('tech2')).post('/parts', [['action', 'request'], ['part_name', 'Q-OTHER-TEAM'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-06-02']], { multipart: true });
  const mq = (await (await loggedIn('mgr1')).get('/admin/requests')).text;
  assert.match(mq, /Q-LATER/); assert.doesNotMatch(mq, /Q-OTHER-TEAM/);
  assert.equal((await tech.get('/admin/requests')).status, 403);
  // Changing your own request's status does not notify yourself.
  const owner = await loggedIn('owner');
  await owner.post('/parts', [['action', 'request'], ['part_name', 'Q-SELF'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-06-03']], { multipart: true });
  await owner.post(`/admin/parts/${lastParts().id}/status`, { status: 'ordered', back: 'requests' }, { page: '/admin/requests' });
  assert.equal(db.prepare('SELECT unseen FROM parts_submissions WHERE id = ?').get(lastParts().id).unseen, 0);
  void later;
});

test('forgot password: emailed link works once, expires, and gives nothing away', async () => {
  const c = new Client();
  sent.length = 0;
  const ask = (who) => c.post('/forgot', { who }, { page: '/forgot' });
  const same = /If that account exists and has an email address on it/;
  assert.match((await ask('nobody-here')).text, same);
  assert.match((await ask('tech2')).text, same);           // real account, no email on it
  assert.equal(sent.length, 0);
  assert.match((await ask('TERRY@example.com')).text, same); // by email, any case
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'terry@example.com');
  const token = /\/reset\/([0-9a-f]{64})/.exec(sent[0].text)[1];
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM password_resets').all()).includes(token)); // only a hash is stored

  const page = `/reset/${token}`;
  assert.equal((await c.get(page)).status, 200);
  assert.equal((await c.post(page, { password: 'short', confirm: 'short' }, { page })).status, 400);
  assert.equal((await c.post(page, { password: 'a brand new password', confirm: 'different password!' }, { page })).status, 400);
  assert.equal((await c.post(page, { password: 'a brand new password', confirm: 'a brand new password' }, { page })).location, '/login');
  assert.equal((await c.get(page)).status, 404);           // used
  assert.equal((await new Client().post('/login', { username: 'tech1', password: 'correct horse battery' }, { page: '/login' })).status, 401);
  await new Client().login('tech1', 'a brand new password');

  await ask('tech1');                                       // a fresh link, then let it expire
  const t2 = /\/reset\/([0-9a-f]{64})/.exec(sent[1].text)[1];
  db.prepare('UPDATE password_resets SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await c.get(`/reset/${t2}`)).status, 404);
  assert.equal((await c.post(`/reset/${t2}`, { password: 'another new password', confirm: 'another new password' }, { page: '/forgot' })).status, 404);
  assert.equal((await c.get('/reset/not-a-token')).status, 404);
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(auth.hashPassword('correct horse battery'), 'tech1');

  // People set their own email on the change-password page.
  const t = await loggedIn('tech2');
  await t.post('/account/email', { email: 'not-an-email' });
  assert.equal(db.prepare("SELECT email FROM users WHERE username = 'tech2'").get().email, null);
  await t.post('/account/email', { email: 'uma@example.com' });
  assert.equal(db.prepare("SELECT email FROM users WHERE username = 'tech2'").get().email, 'uma@example.com');
  assert.match((await new Client().get('/login')).text, /href="\/forgot"/);
});

test('activity log records admin-side changes and never anything about complaints', async () => {
  const owner = await loggedIn('owner');
  db.prepare('DELETE FROM activity_log').run();
  await owner.post('/admin/users', { username: 'logme', display_name: 'Log Me', profile_id: profileId('Technician') }, { page: '/admin/users' });
  const id = userId('logme');
  await owner.post(`/admin/users/${id}/edit`, { username: 'logme', display_name: 'Logan Me', profile_id: profileId('Warehouse') }, { page: `/admin/users/${id}/edit` });
  await owner.post(`/admin/users/${id}/reset-password`, {}, { page: '/admin/users' });
  await owner.post(`/admin/users/${id}/toggle-active`, {}, { page: '/admin/users' });
  const dp = profileId('Dispatcher');
  await owner.post(`/admin/profiles/${dp}`, [['name', 'Dispatcher'], ['scope', 'team'], ['perms', 'parts.submit'], ['perms', 'parts.view']], { page: `/admin/profiles/${dp}` });
  await owner.post('/admin/stock', { part_number: 'ACT-1', count: '5' }, { page: '/admin/stock' });
  // Complaint activity must leave no trace here.
  await (await loggedIn('wh1')).post('/complaint', { category: 'other', description: 'activity log secrecy check' }, { page: '/complaint' });
  const cid = db.prepare("SELECT id FROM complaints WHERE description = 'activity log secrecy check'").get().id;
  await owner.post(`/admin/complaints/${cid}`, { status: 'resolved', reviewer_reply: 'noted' }, { page: `/admin/complaints/${cid}` });

  const log = db.prepare('SELECT a.action, a.detail, u.username FROM activity_log a JOIN users u ON u.id = a.user_id ORDER BY a.id').all();
  assert.deepEqual(log.map((r) => r.action), ['Person added', 'Person edited', 'Password reset', 'Account disabled', 'Profile changed', 'Stock count']);
  assert.ok(log.every((r) => r.username === 'owner'));
  assert.match(log[1].detail, /name Log Me → Logan Me, profile → Warehouse/);
  assert.match(log[4].detail, /now sees only their own people; added: parts\.view; removed: training\.view/);
  assert.ok(!/complaint|secrecy/i.test(JSON.stringify(log)));
  assert.ok(!JSON.stringify(log).includes('correct horse')); // never a password

  const page = (await owner.get('/admin/activity')).text;
  assert.match(page, /Logan Me: name Log Me/);
  assert.doesNotMatch((await owner.get('/admin/activity?q=stock')).text, /Logan Me/);
  for (const who of ['tech1', 'wh1', 'mgr1']) assert.equal((await (await loggedIn(who)).get('/admin/activity')).status, 403, who);
});

test('trucks: remembered per person, shown in the logs, exports and summary', async () => {
  const tech = await loggedIn('tech2');
  assert.match((await tech.get('/parts')).text, /name="truck" value=""/);
  await takeParts(tech, [['TRK-PART', 2]], [['truck', '309']]);
  const id = lastParts().id;
  assert.equal(lastParts().truck, '309');
  assert.equal(db.prepare("SELECT default_truck FROM users WHERE username = 'tech2'").get().default_truck, '309');
  assert.match((await tech.get('/parts')).text, /name="truck" value="309"/); // filled in next time
  await takeParts(tech, [['TRK-PART', 1]]);                                  // left blank: stored blank, default kept
  assert.equal(lastParts().truck, null);
  assert.match((await tech.get('/my')).text, /Truck 309/);

  const owner = await loggedIn('owner');
  assert.match((await owner.get('/admin/parts?q=TRK-PART')).text, /Truck 309/);
  assert.match((await owner.get('/admin/parts.csv?q=TRK-PART')).text, /TRK-PART,2,Van stock,,309,/);
  const summary = (await owner.get('/admin/parts/summary?q=TRK-PART')).text.replace(/\s+/g, ' ');
  assert.match(summary, /By truck.*<td>309<\/td><td class="num">2<\/td>/);
  await tech.post(`/parts/${id}/edit`, [['part_name', 'TRK-PART'], ['quantity', '2'], ['source', 'van'], ['truck', '310']], { multipart: true, page: `/parts/${id}/edit` });
  assert.equal(db.prepare('SELECT truck FROM parts_submissions WHERE id = ?').get(id).truck, '310');
});

test('the parts form offers the person\'s most-used parts and a barcode scanner', async () => {
  makeUser('fav1', 'Fay Favorite');
  const c = await loggedIn('fav1');
  assert.doesNotMatch((await c.get('/parts')).text, /class="chip"/); // nothing used yet
  await takeParts(c, [['FAV-B', 1]]);
  await takeParts(c, [['FAV-A', 1], ['fav-a', 2]]);
  await takeParts(c, [['FAV-A', 1]]);
  await takeParts(c, [['FAV-GONE', 1]]);
  await c.post(`/parts/${lastParts().id}/cancel`, {});
  const html = (await c.get('/parts')).text;
  assert.deepEqual([...html.matchAll(/class="chip" data-part="([^"]+)"/g)].map((m) => m[1]), ['FAV-A', 'FAV-B']); // most used first, cancelled left out
  assert.match(html, /id="scan-btn"/);
  assert.match(html, /src="\/scan\.js\?v=[a-z0-9]+"/);
  const lib = await new Client().get('/vendor/html5-qrcode.min.js');
  assert.equal(lib.status, 200);
  assert.ok(lib.text.includes('Html5Qrcode'));
  assert.equal((await new Client().get('/scan.js')).status, 200);
});

test('training topics: others can add their name; private requests stay hidden', async () => {
  const t1 = await loggedIn('tech1');
  const t2 = await loggedIn('tech2');
  await t1.post('/training', { description: 'TOPIC ground fault tracing', wants_contact: 'no', is_private: 'no' });
  const open = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  await t1.post('/training', { description: 'TOPIC private thing', wants_contact: 'no', is_private: 'yes' });
  const priv = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;

  const page = (await t2.get('/training/topics')).text;
  assert.match(page, /TOPIC ground fault tracing/); assert.doesNotMatch(page, /TOPIC private thing/);
  const votes = () => db.prepare('SELECT COUNT(*) n FROM training_votes WHERE request_id = ?').get(open).n;
  await t2.post(`/training/topics/${open}/vote`, {}, { page: '/training/topics' });
  assert.equal(votes(), 1);
  assert.match((await t2.get('/training/topics')).text, /Take my name off/);
  await t1.post(`/training/topics/${open}/vote`, {}, { page: '/training/topics' });   // your own request: no effect
  await t2.post(`/training/topics/${priv}/vote`, {}, { page: '/training/topics' });   // private: no effect
  assert.equal(votes(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_votes WHERE request_id = ?').get(priv).n, 0);

  const owner = await loggedIn('owner');
  assert.match((await owner.get(`/admin/training/${open}`)).text, /1 more want this:<\/strong> Uma Tech/);
  await t2.post(`/training/topics/${open}/vote`, {}, { page: '/training/topics' });   // tap again to undo
  assert.equal(votes(), 0);
  await t2.post(`/training/topics/${open}/vote`, {}, { page: '/training/topics' });
  assert.equal((await (await loggedIn('disp1')).get('/training/topics')).status, 403);  // profile without "send training requests"
});

test('training sessions: scheduled from a request, attendance recorded, history kept', async () => {
  const owner = await loggedIn('owner');
  const t1 = await loggedIn('tech1');
  const req = db.prepare("SELECT id FROM training_requests WHERE description = 'TOPIC ground fault tracing'").get().id;
  const list = '/admin/training/sessions';
  assert.match((await owner.get(`${list}?request=${req}`)).text, /value="TOPIC ground fault tracing"/); // prefilled
  assert.equal((await owner.post(list, { title: '', session_date: 'soon' }, { page: list })).status, 400);
  const r = await owner.post(list, { title: 'Ground fault tracing', session_date: '2031-07-04', session_time: '07:30', location: 'Shop', request_id: String(req) }, { page: list });
  const sid = db.prepare('SELECT MAX(id) id FROM training_sessions').get().id;
  assert.equal(r.location, `${list}/${sid}`);
  // The requester and the person who added their name are expected; the request shows as Scheduled and the requester is told.
  const expected = () => db.prepare('SELECT user_id FROM training_attendance WHERE session_id = ? ORDER BY user_id').all(sid).map((x) => x.user_id);
  assert.deepEqual(expected(), [userId('tech1'), userId('tech2')].sort((a, b) => a - b));
  assert.deepEqual({ ...db.prepare('SELECT status, unseen FROM training_requests WHERE id = ?').get(req) }, { status: 'scheduled', unseen: 1 });
  assert.match((await t1.get('/training/topics')).text.replace(/\s+/g, ' '), /Coming up.*Ground fault tracing.*7\/4\/2031 at 07:30/);
  assert.doesNotMatch((await t1.get('/my')).text, /Training attended/); // not held yet

  // On the day: tick who came and mark it held.
  const page = `${list}/${sid}`;
  await owner.post(page, [['people', String(userId('tech1'))], ['people', String(userId('wh1'))], ['held', '1']], { page });
  assert.deepEqual(expected(), [userId('tech1'), userId('wh1')].sort((a, b) => a - b));
  assert.ok(db.prepare('SELECT completed_at FROM training_sessions WHERE id = ?').get(sid).completed_at);
  assert.equal(db.prepare('SELECT status FROM training_requests WHERE id = ?').get(req).status, 'completed');
  assert.match((await t1.get('/my')).text.replace(/\s+/g, ' '), /Training attended.*Ground fault tracing.*7\/4\/2031/);
  assert.doesNotMatch((await (await loggedIn('tech2')).get('/my')).text, /Training attended/);

  // History per person, and the export.
  assert.match((await owner.get(`${list}?user=${userId('wh1')}`)).text, /Ground fault tracing/);
  assert.doesNotMatch((await owner.get(`${list}?user=${userId('tech2')}`)).text, /Ground fault tracing/);
  const csv = (await owner.get(`${list}.csv`)).text;
  assert.match(csv, /Ground fault tracing,2031-07-04,Shop,Yes,Terry Tech,tech1/);

  // A manager can tick only their own people and leaves everyone else's ticks alone.
  const mgr = await loggedIn('mgr1');
  const seen = (await mgr.get(page)).text;
  assert.match(seen, /Terry Tech/); assert.doesNotMatch(seen, /Wanda Warehouse/); assert.match(seen, /1 more outside your team/);
  await mgr.post(page, [['people', String(userId('tech2'))], ['held', '']], { page }); // unticks tech1; tech2 is not theirs
  assert.deepEqual(expected(), [userId('wh1')]);
  assert.doesNotMatch((await mgr.get(`${list}.csv`)).text, /Wanda Warehouse/);
  assert.equal((await mgr.post(`${page}/delete`, {})).status, 403);
  for (const url of [list, page, `${list}.csv`]) assert.equal((await t1.get(url)).status, 403, url);
  assert.equal((await (await loggedIn('wh1')).post(list, { title: 'x', session_date: '2031-01-01' })).status, 403);
  await owner.post(`${page}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_sessions WHERE id = ?').get(sid).n, 0);
});

test('weekly summary: right numbers, right people, once, on Monday morning', async () => {
  const digest = require('../app/digest');
  const monday = new Date('2032-03-08T14:00:00Z');  // Monday 9am Eastern
  const mgrRow = () => access.loadAccess(db.prepare("SELECT * FROM users WHERE username = 'mgr1'").get());
  // Last week's entries: tech1 (the manager's person) and tech2 (not theirs).
  const put = (who, action, part, qty, day) => {
    const info = db.prepare(`INSERT INTO parts_submissions (user_id, action, source, status, created_at, created_local_date)
                             VALUES (?, ?, 'van', ?, ?, ?)`).run(userId(who), action, action === 'request' ? 'new' : null, day + 'T15:00:00Z', day);
    db.prepare('INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, ?, ?)').run(info.lastInsertRowid, part, qty);
  };
  put('tech1', 'take', 'WK-A', 5, '2032-03-02'); put('tech1', 'take', 'WK-B', 2, '2032-03-05'); put('tech1', 'return', 'WK-A', 1, '2032-03-07');
  put('tech1', 'request', 'WK-C', 4, '2032-03-01'); put('tech2', 'take', 'WK-A', 100, '2032-03-03');
  put('tech1', 'take', 'WK-A', 50, '2032-02-29');   // the day before the week starts
  put('tech1', 'take', 'WK-A', 50, '2032-03-08');   // today is not part of last week

  const d = digest.build(mgrRow(), monday);
  assert.deepEqual(d.range, { from: '2032-03-01', to: '2032-03-07' });
  assert.deepEqual(d.totals, { taken: 7, returned: 1, requested: 4, entries: 4 });
  assert.deepEqual(d.byPerson.map((r) => [r.name, r.taken]), [['Terry Tech', 7]]);
  assert.deepEqual(d.topParts.map((r) => [r.part, r.taken]), [['WK-A', 5], ['WK-B', 2]]);
  assert.equal(d.unchecked, 4);
  const all = digest.build(access.loadAccess(db.prepare("SELECT * FROM users WHERE username = 'owner'").get()), monday);
  assert.equal(all.totals.taken, 107);

  // Who gets it: the profile must have the tick-box, and the account an email address.
  db.prepare("UPDATE users SET email = 'mona@example.com' WHERE username = 'mgr1'").run();
  db.prepare("UPDATE users SET email = 'olive@example.com' WHERE username = 'owner'").run();
  access.setPermissions(profileId('Admin'), access.ALL.filter((p) => p !== 'digest.weekly'));
  assert.ok(access.permsOf(profileId('Manager')).has('digest.weekly'));
  sent.length = 0;
  assert.equal(await digest.runWeekly(new Date('2032-03-07T14:00:00Z')), 0); // Sunday
  assert.equal(await digest.runWeekly(new Date('2032-03-08T09:00:00Z')), 0); // Monday, before 7am local
  assert.equal(await digest.runWeekly(monday), 1);
  assert.equal(await digest.runWeekly(monday), 0);                           // only once
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'mona@example.com');
  assert.match(sent[0].text, /Taken:\s+7 units/);
  assert.match(sent[0].text, /Terry Tech: 7 \/ 1 \/ 4/);
  assert.doesNotMatch(sent[0].text, /Uma Tech|100/);
  access.setPermissions(profileId('Admin'), access.ALL);

  const page = await (await loggedIn('mgr1')).get('/admin/weekly');
  assert.equal(page.status, 200);
  assert.match(page.text, /your people only/);
  assert.equal((await (await loggedIn('tech1')).get('/admin/weekly')).status, 403);
});

test('permissions added in an update are given once to the profiles that held the closest one', async () => {
  const id = access.createProfile('Legacy Stores', 'all', ['parts.view', 'catalog.manage']);
  const teamLead = access.createProfile('Legacy Lead', 'team', ['parts.view']);
  db.prepare("DELETE FROM meta WHERE key LIKE 'perm_granted:%'").run(); // as if the update had not run yet
  access.migrate();
  assert.ok(access.permsOf(id).has('stock.manage'));
  assert.ok(!access.permsOf(id).has('activity.view'));
  assert.ok(access.permsOf(teamLead).has('digest.weekly'));
  access.setPermissions(id, ['parts.view', 'catalog.manage']);            // an admin later unticks it
  access.migrate();
  assert.ok(!access.permsOf(id).has('stock.manage'));                      // and it stays unticked
});

// ---------------------------------------------------------------------------
// Deleting records, certifications, truck inspections, announcements
// ---------------------------------------------------------------------------

const ymdFromNow = (days) => { const d = new Date(require('../app/util').localDate() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

test('deleting: parts entries, training requests and complaints can be removed for good by those allowed', async () => {
  const owner = await loggedIn('owner');     // Admin: everything
  const limited = await loggedIn('admin');   // has "delete records" but no complaint access
  const wh = await loggedIn('wh1');
  const tech = await loggedIn('tech1');
  db.prepare('DELETE FROM activity_log').run();

  // A parts entry with a photo, tracked in stock.
  await wh.post('/admin/stock', { part_number: 'DEL-1', count: '10' }, { page: '/admin/stock' });
  await new Promise((r) => setTimeout(r, 5));
  await tech.post('/parts', [['action', 'return'], ['part_name', 'DEL-1'], ['quantity', '4'], ['source', 'van'], ['photo', new File([PNG], 'p.png', { type: 'image/png' })]], { multipart: true });
  const entry = lastParts();
  await tech.post(`/parts/${entry.id}/edit`, [['part_name', 'DEL-1'], ['quantity', '5'], ['source', 'van']], { multipart: true, page: `/parts/${entry.id}/edit` });
  assert.equal(onHand('DEL-1'), 15);
  const file = path.join(dataDir, 'uploads', entry.photo_path);
  assert.ok(fs.existsSync(file));

  for (const c of [wh, tech, await loggedIn('mgr1')]) assert.equal((await c.post(`/admin/parts/${entry.id}/delete`, {})).status, 403);
  assert.doesNotMatch((await wh.get(`/admin/parts/${entry.id}`)).text, /Delete this entry permanently/);
  assert.match((await limited.get(`/admin/parts/${entry.id}`)).text, /Delete this entry permanently/);
  assert.equal((await limited.post(`/admin/parts/${entry.id}/delete`, {}, { page: `/admin/parts/${entry.id}` })).location, '/admin/parts');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE id = ?').get(entry.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_items WHERE submission_id = ?').get(entry.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM change_log WHERE kind = 'parts' AND record_id = ?").get(entry.id).n, 0);
  assert.equal(onHand('DEL-1'), 10);          // stock is as if it never happened
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(file));            // the photo is gone too
  assert.equal((await limited.get(`/admin/parts/${entry.id}`)).status, 404);
  assert.doesNotMatch((await tech.get('/my')).text, /DEL-1/);

  // A training request that has a session: the session and its attendance are kept.
  await tech.post('/training', { description: 'DELETE-ME secret topic', wants_contact: 'no', is_private: 'yes' });
  const tid = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  await owner.post('/admin/training/sessions', { title: 'Kept session', session_date: '2031-08-01', request_id: String(tid) }, { page: '/admin/training/sessions' });
  const sid = db.prepare('SELECT MAX(id) id FROM training_sessions').get().id;
  assert.equal((await wh.post(`/admin/training/${tid}/delete`, {})).status, 403);
  assert.equal((await owner.post(`/admin/training/${tid}/delete`, {}, { page: `/admin/training/${tid}` })).location, '/admin/training');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_requests WHERE id = ?').get(tid).n, 0);
  assert.deepEqual({ ...db.prepare('SELECT title, request_id FROM training_sessions WHERE id = ?').get(sid) }, { title: 'Kept session', request_id: null });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_attendance WHERE session_id = ?').get(sid).n, 1);

  // A complaint: needs both "delete records" and complaint access.
  const sender = await loggedIn('fav1');
  const r = await sender.post('/complaint', { category: 'other', description: 'DELETE-ME complaint text' }, { page: '/complaint' });
  const code = /id="code">([A-Z0-9-]{14})</.exec(r.text)[1];
  const cid = db.prepare("SELECT id FROM complaints WHERE description = 'DELETE-ME complaint text'").get().id;
  assert.equal((await limited.post(`/admin/complaints/${cid}/delete`, {})).status, 403);                    // no complaint access
  assert.equal((await (await loggedIn('reviewer')).post(`/admin/complaints/${cid}/delete`, {})).status, 403); // can read, cannot delete
  assert.doesNotMatch((await (await loggedIn('reviewer')).get(`/admin/complaints/${cid}`)).text, /Delete this complaint/);
  assert.equal((await owner.post(`/admin/complaints/${cid}/delete`, {}, { page: `/admin/complaints/${cid}` })).location, '/admin/complaints');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM complaints WHERE id = ?').get(cid).n, 0);
  assert.equal((await sender.post('/complaint/status', { code }, { page: '/complaint/status' })).status, 404); // the code no longer finds anything

  // The log says who deleted what, without a private request's wording or any complaint content.
  const log = db.prepare("SELECT a.action, a.detail, u.username FROM activity_log a JOIN users u ON u.id = a.user_id WHERE a.action LIKE '%deleted' ORDER BY a.id").all();
  assert.deepEqual(log.map((l) => [l.action, l.username]), [['Parts entry deleted', 'admin'], ['Training request deleted', 'owner'], ['Complaint deleted', 'owner']]);
  assert.match(log[0].detail, /Return parts by Terry Tech, .*: 5 × DEL-1/);
  assert.match(log[1].detail, /by Terry Tech, .*\(private\)$/);
  assert.equal(log[2].detail, null);
  assert.ok(!JSON.stringify(log).includes('DELETE-ME'));

  // A manager given the delete tick-box still cannot reach outside their own people.
  access.setPermissions(profileId('Manager'), [...access.permsOf(profileId('Manager')), 'records.delete']);
  const other = db.prepare('SELECT id FROM parts_submissions WHERE user_id = ? ORDER BY id DESC').get(userId('tech2')).id;
  assert.equal((await (await loggedIn('mgr1')).post(`/admin/parts/${other}/delete`, {})).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE id = ?').get(other).n, 1);
  access.setPermissions(profileId('Manager'), [...access.permsOf(profileId('Manager'))].filter((p) => p !== 'records.delete'));
});

test('certifications: recorded per person, flagged when expiring, and the person is reminded', async () => {
  const owner = await loggedIn('owner');
  const page = '/admin/certs';
  const add = (fields) => owner.post(page, fields, { page });
  assert.equal((await add({ name: 'NICET II' })).status, 400);                                  // no person
  assert.equal((await add({ user_id: userId('tech1'), name: '' })).status, 400);
  assert.equal((await add({ user_id: userId('tech1'), name: 'X', issued_on: '2030-01-01', expires_on: '2029-01-01' })).status, 400);
  await add({ user_id: userId('tech1'), name: 'NICET Fire Alarm Level II', issuer: 'NICET', number: '123456', issued_on: '2024-01-01', expires_on: ymdFromNow(400) });
  await add({ user_id: userId('tech1'), name: 'Driver\'s license', expires_on: ymdFromNow(20) });
  await add({ user_id: userId('tech1'), name: 'OSHA 10' });                                       // never expires
  await add({ user_id: userId('tech2'), name: 'DOT medical card', expires_on: ymdFromNow(-3) });
  await add({ user_id: userId('tech2'), name: 'First aid / CPR', expires_on: ymdFromNow(45) });

  const list = (await owner.get(page)).text.replace(/\s+/g, ' ');
  assert.match(list, /1 expired\.<\/strong> <strong>2 expiring within 60 days/);
  assert.match(list, /DOT medical card.*?Expired 3 days ago/);
  assert.match(list, /Driver&#39;s license.*?20 days left/);
  assert.match(list, /NICET Fire Alarm Level II.*?Current/);
  assert.match(list, /OSHA 10.*?No expiry/);
  const attention = (await owner.get(page + '?show=attention')).text;
  assert.match(attention, /DOT medical card/); assert.doesNotMatch(attention, /<strong>OSHA 10<\/strong>|<strong>NICET Fire Alarm Level II<\/strong>/);
  assert.match((await owner.get('/')).text, /Certifications <span class="badge">2<\/span>/); // expired or within 30 days
  assert.match((await owner.get(page + '.csv')).text, /Terry Tech,tech1,NICET Fire Alarm Level II,NICET,123456,2024-01-01,\d{4}-\d{2}-\d{2},Current/);

  // The person sees their own, and is warned on the home page inside 30 days.
  const t1 = await loggedIn('tech1');
  const mine = (await t1.get('/my')).text;
  assert.match(mine, /My licenses and certifications/); assert.match(mine, /Expires in 20 days/);
  assert.doesNotMatch(mine, /DOT medical card/);
  assert.match((await t1.get('/')).text, /<strong>Driver&#39;s license<\/strong> expires in 20 days/);
  assert.match((await (await loggedIn('tech2')).get('/')).text, /<strong>DOT medical card<\/strong> expired on/);
  assert.equal((await t1.get(page)).status, 403);

  // Reminder emails: once inside 30 days, once inside 7, and again after a renewal.
  const certs = require('../app/certs');
  sent.length = 0;
  assert.equal(await certs.runReminders(), 1);              // tech1's licence at 20 days (tech2's 45-day one is not due; the expired one is past)
  assert.equal(sent[0].to, 'terry@example.com');
  assert.match(sent[0].subject, /Driver's license expires in 20 days/);
  assert.equal(await certs.runReminders(), 0);              // not again
  const later = new Date(Date.now() + 15 * 86400000);       // 5 days to go
  assert.equal(await certs.runReminders(later), 2);         // tech1's second reminder, and tech2's card has now reached 30 days
  assert.deepEqual(sent.slice(1).map((m) => [m.to, m.subject]).sort(), [
    ['terry@example.com', "Driver's license expires in 5 days"], ['uma@example.com', 'First aid / CPR expires in 30 days']]);
  assert.equal(await certs.runReminders(later), 0);
  const id = db.prepare("SELECT id FROM certifications WHERE name = 'Driver''s license'").get().id;
  await owner.post(`${page}/${id}`, { name: 'Driver\'s license', expires_on: ymdFromNow(25) }, { page: `${page}/${id}` }); // renewed
  assert.equal(await certs.runReminders(), 1);

  // A manager keeps records for their own people only.
  const mgr = await loggedIn('mgr1');
  const mlist = (await mgr.get(page)).text;
  assert.match(mlist, /<strong>NICET Fire Alarm Level II<\/strong>/); assert.doesNotMatch(mlist, /<strong>DOT medical card<\/strong>|Uma Tech/);
  const theirs = db.prepare("SELECT id FROM certifications WHERE name = 'DOT medical card'").get().id;
  assert.equal((await mgr.get(`${page}/${theirs}`)).status, 403);
  assert.equal((await mgr.post(`${page}/${theirs}/delete`, {})).status, 403);
  assert.equal((await mgr.post(page, { user_id: userId('tech2'), name: 'Sneaky' }, { page })).status, 400);
  await owner.post(`${page}/${theirs}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM certifications WHERE id = ?').get(theirs).n, 0);
});

test('truck inspections: checklist with OK/Problem, photos, problems followed up', async () => {
  const tech = await loggedIn('tech1');
  const items = db.prepare('SELECT id, label FROM inspection_items WHERE active = 1 ORDER BY sort').all();
  const answers = (problemAt, note) => items.flatMap((it, i) => (i === problemAt ? [[`item_${it.id}`, 'problem'], ...(note ? [[`note_${it.id}`, note]] : [])] : [[`item_${it.id}`, 'ok']]));
  const send = (fields) => tech.post('/inspection', fields, { multipart: true, page: '/inspection' });
  const count = () => db.prepare('SELECT COUNT(*) n FROM inspections').get().n;
  const files = () => fs.readdirSync(path.join(dataDir, 'uploads')).length;
  const before = files();

  const form = (await tech.get('/inspection')).text;
  for (const it of items) assert.ok(form.includes(it.label.replace('&', '&amp;')), it.label);
  assert.equal((await send([['truck', ''], ...answers(-1)])).status, 400);                         // no truck
  assert.equal((await send([['truck', '309'], ...answers(-1).slice(1)])).status, 400);             // one item unanswered
  assert.equal((await send([['truck', '309'], ...answers(2)])).status, 400);                       // problem without saying what
  const five = Array.from({ length: 5 }, (_, i) => ['photos', new File([PNG], `p${i}.png`, { type: 'image/png' })]);
  assert.equal((await send([['truck', '309'], ...answers(-1), ...five])).status, 400);             // too many photos
  assert.equal((await send([['truck', '309'], ...answers(-1), ['photos', new File(['not an image'], 'x.png', { type: 'image/png' })]])).status, 400);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(count(), 0); assert.equal(files(), before);                                          // nothing kept from failed tries

  sent.length = 0;
  assert.equal((await send([['truck', '309'], ['odometer', '84210'], ...answers(-1)])).location, '/my?sent=inspection');
  assert.equal(sent.length, 0);                                                                     // all OK: no email
  const photo = (n) => ['photos', new File([PNG], `p${n}.png`, { type: 'image/png' })];
  await send([['truck', '309'], ...answers(2, 'Pulls left under braking'), photo(1), photo(2), ['notes', 'Needs the shop']]);
  const insp = db.prepare('SELECT * FROM inspections ORDER BY id DESC').get();
  assert.deepEqual([insp.truck, insp.problems, insp.resolved_at], ['309', 1, null]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inspection_photos WHERE inspection_id = ?').get(insp.id).n, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Truck 309: 1 problem reported/);
  assert.match(sent[0].text, new RegExp(`${items[2].label}: Pulls left under braking`));
  assert.equal(db.prepare("SELECT default_truck FROM users WHERE username = 'tech1'").get().default_truck, '309');

  // Following up.
  const wh = await loggedIn('wh1');
  assert.match((await wh.get('/')).text, /Inspection log <span class="badge">1<\/span>/);
  const list = (await wh.get('/admin/inspections')).text.replace(/\s+/g, ' ');
  assert.match(list, /1 with problems not yet fixed/);
  assert.match(list, /Who is due.*Terry Tech<\/td><td>309<\/td>.*Today/);
  assert.doesNotMatch((await wh.get('/admin/inspections?show=open')).text, /All OK/);
  const detail = (await wh.get(`/admin/inspections/${insp.id}`)).text;
  assert.match(detail, /Pulls left under braking/); assert.match(detail, /Needs the shop/);
  const pid = db.prepare('SELECT id FROM inspection_photos WHERE inspection_id = ?').get(insp.id).id;
  assert.equal((await wh.get(`/inspection/photo/${pid}`)).status, 200);
  assert.equal((await tech.get(`/inspection/photo/${pid}`)).status, 200);
  assert.equal((await (await loggedIn('tech2')).get(`/inspection/photo/${pid}`)).status, 403);
  await wh.post(`/admin/inspections/${insp.id}/resolve`, { resolved_note: 'Front pads replaced' }, { page: `/admin/inspections/${insp.id}` });
  assert.ok(db.prepare('SELECT resolved_at FROM inspections WHERE id = ?').get(insp.id).resolved_at);
  assert.doesNotMatch((await wh.get('/')).text, /Inspections <span class="badge"/);
  assert.match((await tech.get('/my')).text.replace(/\s+/g, ' '), /Truck inspections.*Fixed.*Front pads replaced/);
  assert.match((await wh.get('/admin/inspections.csv?show=problems')).text, new RegExp(`Terry Tech,309,,${items[2].label},Problem,Pulls left under braking,`));

  // Changing the checklist changes the form, not inspections already sent.
  const cl = '/admin/inspections/checklist';
  await wh.post(cl, { label: 'Registration card in the cab' }, { page: cl });
  await wh.post(`${cl}/${items[0].id}/toggle`, {}, { page: cl });
  await wh.post(`${cl}/${items[1].id}/rename`, { label: 'All lights working' }, { page: cl });
  const form2 = (await tech.get('/inspection')).text;
  assert.match(form2, /Registration card in the cab/); assert.match(form2, /All lights working/);
  assert.ok(!form2.includes(items[0].label));
  assert.match((await wh.get(`/admin/inspections/${insp.id}`)).text, new RegExp(items[0].label));  // old wording kept on the old inspection
  await wh.post(`${cl}/${items[0].id}/toggle`, {}, { page: cl });

  // Who can do what.
  for (const url of ['/admin/inspections', `/admin/inspections/${insp.id}`, cl, '/admin/inspections.csv']) assert.equal((await tech.get(url)).status, 403, url);
  const mgr = await loggedIn('mgr1');
  assert.equal((await mgr.get(`/admin/inspections/${insp.id}`)).status, 200);                      // tech1 is theirs
  await (await loggedIn('tech2')).post('/inspection', [['truck', '310'], ...db.prepare('SELECT id FROM inspection_items WHERE active = 1').all().map((it) => [`item_${it.id}`, 'ok'])], { multipart: true, page: '/inspection' });
  const other = db.prepare('SELECT MAX(id) id FROM inspections').get().id;
  assert.equal((await mgr.get(`/admin/inspections/${other}`)).status, 403);
  assert.doesNotMatch((await mgr.get('/admin/inspections')).text, /Uma Tech/);
  assert.equal((await wh.post(`/admin/inspections/${insp.id}/delete`, {})).status, 403);           // deleting needs its own permission
  const stored = db.prepare('SELECT path FROM inspection_photos WHERE inspection_id = ?').all(insp.id).map((p) => path.join(dataDir, 'uploads', p.path));
  await (await loggedIn('owner')).post(`/admin/inspections/${insp.id}/delete`, {}, { page: `/admin/inspections/${insp.id}` });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inspection_results WHERE inspection_id = ?').get(insp.id).n, 0);
  assert.ok(stored.every((f) => !fs.existsSync(f)));
});

test('announcements: shown on the home page until read, with a record of who has read them', async () => {
  const owner = await loggedIn('owner');
  const page = '/admin/announcements';
  assert.equal((await owner.post(page, { title: '', body: 'x' }, { page })).status, 400);
  await owner.post(page, { title: 'Shop closed Friday', body: 'The shop is closed Friday for inventory.\nPick up parts Thursday.' }, { page });
  const aid = db.prepare('SELECT MAX(id) id FROM announcements').get().id;

  const t1 = await loggedIn('tech1');
  const home = (await t1.get('/')).text;
  assert.match(home, /<span class="tag new">New<\/span>/); assert.match(home, /Shop closed Friday/); assert.match(home, /Pick up parts Thursday/);
  assert.match(home, /Announcements <span class="badge"[^>]*>1<\/span>/);
  assert.doesNotMatch((await owner.get('/')).text, /<span class="tag new">New<\/span>/);            // the poster has already read it
  const active = db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n;
  assert.match((await owner.get(page)).text, new RegExp(`<strong>1 of ${active}</strong>`));

  assert.equal((await t1.post(`/notices/${aid}/read`, { back: 'home' }, { page: '/' })).location, '/');
  const after = (await t1.get('/')).text;
  assert.doesNotMatch(after, /<span class="tag new">New<\/span>/); assert.doesNotMatch(after, /Announcements <span class="badge"/);
  assert.match((await t1.get('/notices')).text, /You read this/);            // still there to look back at
  const who = (await owner.get(`${page}/${aid}`)).text.replace(/\s+/g, ' ');
  assert.match(who, /Read<\/span><span class="stat-num">2</);
  assert.match(who, /Not read yet<\/h2> <p>[^<]*Uma Tech/);
  assert.match(who, /<td>Terry Tech<\/td>/);

  // A manager's announcement goes to their own people only.
  const mgr = await loggedIn('mgr1');
  await mgr.post(page, { title: 'Team meeting Monday', body: '7am at the shop.' }, { page });
  const mid = db.prepare('SELECT MAX(id) id FROM announcements').get().id;
  assert.equal(db.prepare('SELECT audience FROM announcements WHERE id = ?').get(mid).audience, 'team');
  assert.match((await t1.get('/')).text, /Team meeting Monday/);
  const t2 = await loggedIn('tech2');
  assert.doesNotMatch((await t2.get('/')).text, /Team meeting Monday/);
  assert.doesNotMatch((await t2.get('/notices')).text, /Team meeting Monday/);
  await t2.post(`/notices/${mid}/read`, {}, { page: '/notices' });            // not addressed to them: nothing recorded
  assert.equal(db.prepare('SELECT COUNT(*) n FROM announcement_reads WHERE announcement_id = ? AND user_id = ?').get(mid, userId('tech2')).n, 0);
  const mlist = (await mgr.get(page)).text;
  assert.match(mlist, /Team meeting Monday/); assert.doesNotMatch(mlist, /Shop closed Friday/); // sees only their own to manage
  assert.match(mlist, /<strong>1 of 2<\/strong>/);                            // the manager and tech1
  assert.equal((await mgr.get(`${page}/${aid}`)).status, 403);
  assert.equal((await mgr.post(`${page}/${aid}/delete`, {})).status, 403);
  assert.equal((await owner.get(`${page}/${mid}`)).status, 200);              // someone who sees everyone can manage any

  // Past its "show until" date it disappears for people who have not read it.
  await owner.post(page, { title: 'Old news', body: 'Expired yesterday.', expires_on: ymdFromNow(-1) }, { page });
  assert.doesNotMatch((await t2.get('/')).text, /Old news/);
  assert.match((await owner.get(page)).text, /\(ended\)/);

  for (const who2 of ['tech1', 'wh1']) {
    const c = await loggedIn(who2);
    assert.equal((await c.get(page)).status, 403, who2);
    assert.equal((await c.post(page, { title: 'x', body: 'y' })).status, 403, who2);
  }
  await owner.post(`${page}/${aid}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM announcement_reads WHERE announcement_id = ?').get(aid).n, 0);
});

test('menu: everyday links in the bar, the rest in drop-downs that only hold what the profile allows', async () => {
  const groupsOf = (html) => [...html.matchAll(/<details class="menu">\s*<summary[^>]*>([A-Za-z]+)/g)].map((m) => m[1]);
  const barLinks = (html) => { const nav = /<nav class="nav"[\s\S]*?<\/nav>/.exec(html)[0].replace(/<details[\s\S]*?<\/details>/g, '').replace(/<div class="nav-account">[\s\S]*?<\/div>/, ''); return [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]); };

  const owner = (await (await loggedIn('owner')).get('/admin/users')).text;
  assert.deepEqual(groupsOf(owner), ['Parts', 'Trucks', 'Training', 'Team', 'Setup']);
  assert.deepEqual(barLinks(owner), ['/', '/notices', '/discussions', '/tasks', '/my']);
  // What used to be one long Admin list is two: Team (people and what goes out to them) and Setup (the site itself).
  const team = /<summary[^>]*>Team[\s\S]*?<\/details>/.exec(owner)[0];
  const setup = /<summary[^>]*>Setup[\s\S]*?<\/details>/.exec(owner)[0];
  const hrefs = (html) => [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs(team), ['/complaint', '/admin/users', '/admin/profiles', '/admin/tasks', '/admin/announcements', '/admin/newsletters', '/admin/complaints']);
  assert.deepEqual(hrefs(setup), ['/poster', '/admin/activity', '/admin/backups', '/admin/import']);
  assert.match(team, /<summary aria-current="true">Team/);                 // the group you are in is marked
  assert.match(team, /href="\/admin\/users" aria-current="page"/);
  assert.doesNotMatch(setup, /<summary aria-current/);
  // One name for each thing, wherever it appears.
  const ownerNav = /<nav class="nav"[\s\S]*?<\/nav>/.exec(owner)[0];
  for (const name of ['Announcements', 'My activity', 'Anonymous complaint', 'Parts requests', 'Truck inspection', 'Manage tasks', 'Post announcements', 'Certifications']) assert.match(ownerNav, new RegExp(`>${name}(<| <span)`), name);
  for (const old of ['Notices', 'My submissions', 'Assign tasks', '>Complaint<', '>Requests<', 'New inspection']) assert.ok(!ownerNav.includes(old), old);
  assert.doesNotMatch(owner, /id="menu-toggle"/);                          // the old phone Menu button is gone
  assert.match(owner, /class="nav-account">[\s\S]*Change password[\s\S]*Sign out/); // account links are in the menu for phones

  // A technician: no Team or Setup; Trucks has one thing, so it is a plain "Truck inspection" link.
  const tech = (await (await loggedIn('tech1')).get('/')).text;
  assert.deepEqual(groupsOf(tech), ['Parts', 'Training']);
  assert.deepEqual(barLinks(tech), ['/', '/notices', '/discussions', '/tasks', '/my', '/inspection', '/complaint']); // one-item groups show as plain links
  assert.doesNotMatch(tech, /href="\/admin\//);
  assert.match(tech, /<a href="\/inspection"[^>]*>Truck inspection<\/a>/);
  assert.doesNotMatch(/<summary[^>]*>Parts[\s\S]*?<\/details>/.exec(tech)[0], /<hr>/); // no stray divider

  // A manager's Team group holds only what their profile allows, and they have no Setup group.
  const mgr = (await (await loggedIn('mgr1')).get('/')).text;
  assert.deepEqual(groupsOf(mgr), ['Parts', 'Trucks', 'Training', 'Team']);           // Manage tasks and Post announcements
  assert.deepEqual(barLinks(mgr), ['/', '/notices', '/discussions', '/tasks', '/my']);
  assert.doesNotMatch(mgr, /admin\/(users|profiles|complaints|backups|activity)"/);

  // Styles and scripts carry a version so a new release is not shown with old files.
  assert.match(owner, /href="\/styles\.css\?v=[a-z0-9]+"/);
  assert.equal((await new Client().get('/styles.css?v=anything')).status, 200);
});

test('importing old Microsoft Forms data: history lands under the right people with its original dates', async () => {
  const owner = await loggedIn('owner');
  const page = '/admin/import';
  const file = {
    format: 'pb-portal-import-1',
    people: [
      { key: 'terry tech', name: 'Terry Tech', email: 'someone.else@example.com', username: 'ttech' },      // matches an existing account by name
      { key: 'uma', name: 'Uma From Forms', email: 'UMA@example.com', username: 'uma.forms' },              // matches by email, whatever the case
      { key: 'old hand', name: 'Olga Oldhand', email: 'olga@example.com', username: 'olga.oldhand' },       // no account yet
      { key: 'clash', name: 'Clara Clash', email: 'clara@example.com', username: 'tech1' },                 // wanted username is taken
    ],
    parts: [
      { ref: 'forms-parts-1', person: 'old hand', action: 'take', created_at: '2026-03-20T11:33:23.000Z', local_date: '2026-03-20',
        items: [{ part_name: 'IMP-A', quantity: 7 }, { part_name: 'IMP-B', quantity: 2 }], source: 'job', job_number: '46926422', truck: null, needed_by: null, note: 'Imported from Microsoft Forms (response 1).' },
      { ref: 'forms-parts-2', person: 'terry tech', action: 'return', created_at: '2026-04-02T13:00:00.000Z', local_date: '2026-04-02',
        items: [{ part_name: 'IMP-A', quantity: 1 }], source: 'van', job_number: null, truck: '309', needed_by: null, note: 'Imported from Microsoft Forms (response 2). As typed: IMP-A 1' },
      { ref: 'forms-parts-3', person: 'uma', action: 'request', created_at: '2026-04-09T16:29:44.000Z', local_date: '2026-04-09',
        items: [{ part_name: 'IMP-C', quantity: 4 }], source: 'van', job_number: null, truck: null, needed_by: '2026-04-15', note: null },
      { ref: 'forms-parts-4', person: 'nobody', action: 'take', created_at: '2026-04-09T16:29:44.000Z', local_date: '2026-04-09', items: [{ part_name: 'X', quantity: 1 }], source: 'van' },       // unknown person
      { ref: 'forms-parts-5', person: 'clash', action: 'steal', created_at: '2026-04-09T16:29:44.000Z', local_date: '2026-04-09', items: [{ part_name: 'X', quantity: 1 }], source: 'van' },        // bad action
      { ref: 'forms-parts-6', person: 'clash', action: 'take', created_at: 'yesterday', local_date: '2026-04-09', items: [{ part_name: 'X', quantity: 1 }], source: 'van' },                        // bad date
      { ref: 'forms-parts-7', person: 'clash', action: 'take', created_at: '2026-04-09T16:29:44.000Z', local_date: '2026-04-09', items: [{ part_name: 'X', quantity: 0 }], source: 'van' },        // no usable parts
    ],
    training: [
      { ref: 'forms-training-1', person: 'old hand', created_at: '2026-10-21T12:17:30.000Z', local_date: '2026-10-21', description: 'IMPORTED zone expanders\nSecond line', wants_contact: false, is_private: true },
    ],
  };
  const send = (obj, extra = {}) => owner.post(page, [['file', new File([typeof obj === 'string' ? obj : JSON.stringify(obj)], 'import.json', { type: 'application/json' })], ...Object.entries(extra)], { multipart: true, page });
  const usersBefore = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const stockBefore = JSON.stringify(stockLib.list().map((r) => [r.part_number, r.on_hand]));

  // Files that are not an import file change nothing.
  for (const bad of ['not json', { format: 'something-else', people: [], parts: [], training: [] }, { format: 'pb-portal-import-1' }]) {
    assert.equal((await send(bad)).status, 302);
    assert.match((await owner.get(page)).text, /could not be read|not an import file/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, usersBefore);

  assert.equal((await send(file, { close_requests: '1' })).status, 302);
  const report = (await owner.get(page)).text.replace(/\s+/g, ' ');
  assert.match(report, /Imported <strong>3<\/strong> parts entries and <strong>1<\/strong> training request\./);
  assert.match(report, /4 could not be read and were skipped/);
  assert.match(report, /Added to existing accounts:<\/strong> Terry Tech, Uma From Forms/);
  assert.match(report, /New accounts created, disabled:<\/strong> Olga Oldhand, Clara Clash/);

  // New people get a switched-off account nobody can sign in to, on the Technician profile.
  const olga = db.prepare("SELECT * FROM users WHERE username = 'olga.oldhand'").get();
  assert.deepEqual([olga.display_name, olga.email, olga.active, olga.profile_id, olga.is_master], ['Olga Oldhand', 'olga@example.com', 0, profileId('Technician'), 0]);
  assert.equal(db.prepare("SELECT username FROM users WHERE display_name = 'Clara Clash'").get().username, 'tech3');  // "tech1" and "tech2" were taken, so the next free name
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, usersBefore + 2);
  assert.equal((await new Client().post('/login', { username: 'olga.oldhand', password: '' }, { page: '/login' })).status, 401);

  // Entries keep their original date, person, parts and details.
  const take = db.prepare("SELECT * FROM parts_submissions WHERE import_ref = 'forms-parts-1'").get();
  assert.deepEqual([take.user_id, take.action, take.source, take.job_number, take.created_at, take.created_local_date, take.status, take.unseen],
    [olga.id, 'take', 'job', '46926422', '2026-03-20T11:33:23.000Z', '2026-03-20', null, 0]);
  assert.deepEqual(itemsOf(take.id), [{ part_name: 'IMP-A', quantity: 7 }, { part_name: 'IMP-B', quantity: 2 }]);
  const ret = db.prepare("SELECT * FROM parts_submissions WHERE import_ref = 'forms-parts-2'").get();
  assert.deepEqual([ret.user_id, ret.truck], [userId('tech1'), '309']);
  const reqRow = db.prepare("SELECT * FROM parts_submissions WHERE import_ref = 'forms-parts-3'").get();
  assert.deepEqual([reqRow.user_id, reqRow.status, reqRow.needed_by], [userId('tech2'), 'fulfilled', '2026-04-15']);  // matched by email; closed as asked
  assert.match(reqRow.admin_note, /did not record whether this was filled/);
  const tr = db.prepare("SELECT * FROM training_requests WHERE import_ref = 'forms-training-1'").get();
  assert.deepEqual([tr.user_id, tr.description, tr.is_private, tr.status, tr.created_local_date], [olga.id, 'IMPORTED zone expanders\nSecond line', 1, 'new', '2026-10-21']);

  // They show up in the logs, audit and summary for their own dates, and do not move stock or the requests queue.
  assert.match((await owner.get('/admin/parts?from=2026-03-20&to=2026-03-20')).text, /7 × IMP-A/);
  assert.match((await owner.get('/admin/parts/audit?from=2026-03-01&to=2026-04-30')).text, /Olga Oldhand/);
  assert.match((await owner.get('/admin/parts/summary.csv?q=IMP-A')).text, /IMP-A,,7,1,6,0,2/);
  assert.match((await owner.get('/admin/training?q=IMPORTED')).text, /Olga Oldhand/);
  assert.doesNotMatch((await owner.get('/admin/requests')).text, /IMP-C/);
  assert.equal(JSON.stringify(stockLib.list().map((r) => [r.part_number, r.on_hand])), stockBefore);
  assert.match((await (await loggedIn('tech1')).get('/my')).text, /1 × IMP-A/);                       // and under the person's own history
  assert.doesNotMatch((await (await loggedIn('tech1')).get('/my')).text, new RegExp(`/parts/${ret.id}/edit`)); // too old to edit

  // Importing the same file again adds nothing.
  await send(file, { close_requests: '1' });
  assert.match((await owner.get(page)).text.replace(/\s+/g, ' '), /Imported <strong>0<\/strong> parts entries and <strong>0<\/strong> training requests\. 4 were already here/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE import_ref IS NOT NULL').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, usersBefore + 2);

  // Who may use it.
  for (const who of ['tech1', 'wh1', 'mgr1']) {
    const c = await loggedIn(who);
    assert.equal((await c.get(page)).status, 403, who);
    assert.equal((await c.post(page, [['file', new File([JSON.stringify(file)], 'i.json')]], { multipart: true })).status, 403, who);
    assert.equal((await c.post(`${page}/undo`, {})).status, 403, who);
  }

  // Undo takes out what was imported and nothing else; accounts stay. A fresh import can leave requests open.
  const mine = db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE import_ref IS NULL').get().n;
  await owner.post(`${page}/undo`, {}, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE import_ref IS NOT NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_requests WHERE import_ref IS NOT NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE import_ref IS NULL').get().n, mine);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, usersBefore + 2);
  await send(file);                                                                                    // box unticked this time
  assert.equal(db.prepare("SELECT status FROM parts_submissions WHERE import_ref = 'forms-parts-3'").get().status, 'new');
  assert.match((await owner.get('/admin/requests')).text, /IMP-C/);
  assert.match((await owner.get(page)).text.replace(/\s+/g, ' '), /Added to existing accounts:<\/strong> Terry Tech, Uma From Forms, Olga Oldhand, Clara Clash/); // no second set of accounts
  await owner.post(`${page}/undo`, {}, { page });
  const log = db.prepare("SELECT action FROM activity_log WHERE action IN ('Old data imported', 'Imported data removed')").all().map((r) => r.action);
  assert.ok(log.includes('Old data imported') && log.includes('Imported data removed'));
});

test('sorting: the audit and the logs can be ordered by date or by name A to Z', async () => {
  const owner = await loggedIn('owner');
  const order = (html, names) => names.map((n) => html.indexOf(n)).every((pos, i, a) => pos >= 0 && (i === 0 || pos > a[i - 1]));
  const put = (who, part, when) => {
    const info = db.prepare(`INSERT INTO parts_submissions (user_id, action, source, note, created_at, created_local_date) VALUES (?, 'take', 'van', ?, ?, ?)`)
      .run(userId(who), part === 'SORT-B' ? 'Imported from Microsoft Forms (response 363). As typed: 2. SORT-B' : 'Imported from Microsoft Forms (response 364).', when, when.slice(0, 10));
    db.prepare('INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, ?, 1)').run(info.lastInsertRowid, part);
  };
  // Added out of date order on purpose, the way imported history is.
  put('wh1', 'SORT-C', '2033-05-03T15:00:00.000Z');   // Wanda Warehouse
  put('tech1', 'SORT-A', '2033-05-01T15:00:00.000Z'); // Terry Tech
  put('owner', 'SORT-B', '2033-05-02T15:00:00.000Z'); // Olive Owner
  const range = 'from=2033-05-01&to=2033-05-31';

  const audit = async (extra) => (await owner.get(`/admin/parts/audit?${range}${extra}`)).text;
  assert.ok(order(await audit(''), ['SORT-A', 'SORT-B', 'SORT-C']));                 // oldest first, by date not by when it was added
  assert.ok(order(await audit('&sort=newest'), ['SORT-C', 'SORT-B', 'SORT-A']));
  assert.ok(order(await audit('&sort=name'), ['Olive Owner', 'Terry Tech', 'Wanda Warehouse']));
  assert.match(await audit('&sort=name'), /<option value="name" selected>/);
  assert.match(await audit('&sort=name'), /from=2033-05-01&amp;to=2033-05-01[^"]*&sort=name|sort=name/); // quick ranges keep the sort
  // Ticking an entry comes back to the same sorted view.
  const id = db.prepare("SELECT s.id FROM parts_submissions s JOIN parts_items i ON i.submission_id = s.id WHERE i.part_name = 'SORT-A'").get().id;
  assert.match((await owner.post(`/admin/parts/${id}/audit`, { qs: `${range}&sort=name` }, { page: '/admin/parts/audit' })).location, /sort=name#e\d+$/);

  const log = async (extra) => (await owner.get(`/admin/parts?${range}${extra}`)).text;
  assert.ok(order(await log(''), ['SORT-C', 'SORT-B', 'SORT-A']));                    // newest first
  assert.ok(order(await log('&sort=oldest'), ['SORT-A', 'SORT-B', 'SORT-C']));
  assert.ok(order(await log('&sort=name'), ['Olive Owner', 'Terry Tech', 'Wanda Warehouse']));
  const csv = (await owner.get(`/admin/parts.csv?${range}&sort=name`)).text;
  assert.ok(order(csv, ['Olive Owner', 'Terry Tech', 'Wanda Warehouse']));
  assert.match((await owner.get('/admin/training?sort=name')).text, /<option value="name" selected>/);
  assert.equal((await owner.get('/admin/training?sort=bogus')).status, 200);

  // The fixed "Imported from Microsoft Forms" sentence is shown as a small tag; what the person wrote stays.
  const html = await audit('');
  assert.doesNotMatch(html, /Imported from Microsoft Forms/);
  assert.match(html, /class="pill"[^>]*response 363[^>]*>Imported</);
  assert.match(html, /<span class="sub note">As typed: 2\. SORT-B<\/span>/);
  assert.equal((html.match(/class="sub note"/g) || []).length, 1);                     // nothing printed where there was only the fixed sentence
  db.prepare("DELETE FROM parts_submissions WHERE created_local_date LIKE '2033-05-%'").run();
});

test('someone who manages training can tidy the wording of a request from the topics page', async () => {
  const t1 = await loggedIn('tech1');
  await t1.post('/training', { description: 'need traning on dualcoms asap!!', wants_contact: 'no', is_private: 'no' });
  const id = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  const owner = await loggedIn('owner');
  const page = `/training/${id}/edit?back=topics`;
  assert.match((await owner.get('/training/topics')).text, new RegExp(`href="/training/${id}/edit\\?back=topics">Edit wording`));
  assert.doesNotMatch((await (await loggedIn('tech2')).get('/training/topics')).text, /Edit wording/);  // not for people who cannot manage training
  assert.match((await owner.get(page)).text, /Asked by <strong>Terry Tech<\/strong>/);
  const r = await owner.post(`/training/${id}/edit`, { description: 'DualCom installation: full capture testing', wants_contact: 'no', is_private: 'no', back: 'topics' }, { page });
  assert.equal(r.location, `/training/topics#t${id}`);
  const topics = (await owner.get('/training/topics')).text;
  assert.match(topics, /DualCom installation: full capture testing/); assert.doesNotMatch(topics, /traning on dualcoms/);
  assert.match(topics, /Asked by Terry Tech/);                                   // still under the person who asked
  assert.match((await owner.get(`/admin/training/${id}`)).text, /Edited<\/strong> by Olive Owner[\s\S]*Before: need traning on dualcoms asap!!/); // original kept
  assert.match((await t1.get('/my')).text, /DualCom installation: full capture testing/);
  assert.equal((await (await loggedIn('tech2')).post(`/training/${id}/edit`, { description: 'x', wants_contact: 'no', is_private: 'no', back: 'topics' })).status, 403);
  // A manager can reword their own people's requests only.
  const mgr = await loggedIn('mgr1');
  assert.equal((await mgr.get(`/training/${id}/edit?back=topics`)).status, 200);
  await (await loggedIn('tech2')).post('/training', { description: 'other team topic', wants_contact: 'no', is_private: 'no' });
  assert.equal((await mgr.get(`/training/${db.prepare('SELECT MAX(id) id FROM training_requests').get().id}/edit`)).status, 403);
});

// ----------------------------------------------------------------------------
// The home dashboard: newsletters, announcements, what is coming up
// ----------------------------------------------------------------------------

/** A one-page PDF, small but well formed. */
function tinyPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    '<< /Length 35 >>\nstream\n0.9 0.5 0.1 rg 50 50 512 692 re f\n\nendstream',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const uploadedFiles = () => fs.readdirSync(path.join(dataDir, 'uploads')).filter((f) => f.startsWith('nl-'));

test('newsletters: uploaded by people allowed to, shown on the home page, readable by everyone signed in', async () => {
  const owner = await loggedIn('owner');
  const t1 = await loggedIn('tech1');
  const page = '/admin/newsletters';
  assert.equal((await t1.get(page)).status, 403);
  assert.equal((await t1.post(page, { issue_month: '2026-10', pdf: new Blob([tinyPdf()], { type: 'application/pdf' }) }, { multipart: true })).status, 403);
  assert.match((await t1.get('/')).text, /No newsletter has been posted yet/);
  assert.doesNotMatch((await t1.get('/')).text, /Upload the first one/);
  assert.match((await owner.get('/')).text, /Upload the first one/);

  // Something that is not a PDF is refused and nothing is kept.
  const bad = await owner.post(page, { issue_month: '2026-10', pdf: new Blob([PNG], { type: 'application/pdf' }) }, { page, multipart: true });
  assert.equal(bad.status, 400); assert.match(bad.text, /not a PDF/);
  assert.equal((await owner.post(page, { issue_month: 'October', pdf: new Blob([tinyPdf()], { type: 'application/pdf' }) }, { page, multipart: true })).status, 400);
  assert.equal((await owner.post(page, { issue_month: '2026-10' }, { page, multipart: true })).status, 400);
  // A form without the page's token is refused too.
  assert.equal((await owner.post(page, { issue_month: '2026-10', pdf: new Blob([tinyPdf()], { type: 'application/pdf' }) }, { multipart: true, csrf: false })).status, 403);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(uploadedFiles(), []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM newsletters').get().n, 0);

  const ok = await owner.post(page, { issue_month: '2026-09', highlights: 'Welcome new hires\n- Truck 309 is back' , pdf: new Blob([tinyPdf()], { type: 'application/pdf' }) }, { page, multipart: true });
  assert.equal(ok.location, page);
  await owner.post(page, { issue_month: '2026-10', title: 'October Edition', pdf: new Blob([tinyPdf()], { type: 'application/pdf' }) }, { page, multipart: true });
  const [oct, sep] = db.prepare('SELECT * FROM newsletters ORDER BY issue_month DESC').all();
  assert.equal(oct.title, 'October Edition'); assert.equal(sep.title, 'September 2026 newsletter');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'Newsletter uploaded'").get().n, 2);

  // The newest issue leads the home page; the earlier one sits under "Past issues".
  const home = (await t1.get('/')).text;
  assert.match(home, /Latest issue[\s\S]*October Edition[\s\S]*Read this issue[\s\S]*Past issues[\s\S]*September 2026/);
  assert.match(home, new RegExp(`href="/newsletters/${oct.id}"`));
  assert.match((await t1.get(`/newsletters/${sep.id}`)).status === 200 ? (await t1.get(`/newsletters/${sep.id}`)).text : 'Older issue Newer issue', /Newer issue|Older issue/);
  const list = (await t1.get('/newsletters')).text;
  assert.match(list, /October 2026[\s\S]*September 2026/); assert.doesNotMatch(list, /Upload or manage/);

  const pdf = await t1.get(`/newsletters/${oct.id}/pdf`);
  assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/); assert.match(pdf.text, /^%PDF-/);
  // Where page pictures could be made they are served; where not, the reader falls back to the PDF.
  const pages = JSON.parse(oct.page_files);
  const reader = await t1.get(`/newsletters/${oct.id}`);
  if (pages.length) {
    assert.equal(reader.status, 200); assert.match(reader.text, /Open the PDF/);
    assert.equal((await t1.get(`/newsletters/${oct.id}/page/1`)).status, 200);
    assert.match(home, new RegExp(`src="/newsletters/${oct.id}/page/1"`));
  } else assert.equal(reader.location, `/newsletters/${oct.id}/pdf`);
  assert.equal((await t1.get(`/newsletters/${oct.id}/page/99`)).status, 404);
  assert.equal((await t1.get('/newsletters/999')).status, 404);
  // Highlights are listed beside the cover, without the dashes people type.
  await owner.post(`/admin/newsletters/${oct.id}/delete`, {}, { page });
  assert.match((await t1.get('/')).text, /<li>Welcome new hires<\/li><li>Truck 309 is back<\/li>/);

  // Nothing is readable signed out.
  for (const url of ['/newsletters', `/newsletters/${sep.id}`, `/newsletters/${sep.id}/pdf`, `/newsletters/${sep.id}/page/1`]) {
    assert.match((await new Client().get(url)).location, /^\/login/, url);
  }
  // Removing an issue removes its files.
  assert.equal((await t1.post(`/admin/newsletters/${sep.id}/delete`, {})).status, 403);
  await owner.post(`/admin/newsletters/${sep.id}/delete`, {}, { page });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(uploadedFiles(), []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM newsletters').get().n, 0);
});

test('newsletter permission is given once to profiles that manage people, and is its own tick-box', async () => {
  const pid = access.createProfile('Office', 'all', [...access.SUBMIT, 'users.manage']);
  db.prepare("DELETE FROM meta WHERE key = 'perm_granted:newsletters.manage'").run();
  access.migrate();
  assert.ok(access.permsOf(pid).has('newsletters.manage'));
  assert.ok(!access.permsOf(access.profileByName('Technician').id).has('newsletters.manage'));
  access.setPermissions(pid, access.SUBMIT);
  access.migrate();                                                    // not handed back after someone unticks it
  assert.ok(!access.permsOf(pid).has('newsletters.manage'));
  db.prepare('DELETE FROM profiles WHERE id = ?').run(pid);
});

test('home dashboard: announcements with labels and pins, coming up, and my status', async () => {
  const owner = await loggedIn('owner');
  const t2 = await loggedIn('tech2');
  const page = '/admin/announcements';
  await owner.post(page, { title: 'Ladder recall', body: 'Tag out any Model 6 ladder.', category: 'safety', pinned: '1' }, { page });
  const pinId = db.prepare('SELECT MAX(id) id FROM announcements').get().id;
  await owner.post(page, { title: 'Parking lot repaving', body: 'Park on the street Tuesday.', category: 'nonsense' }, { page });
  const plainId = db.prepare('SELECT MAX(id) id FROM announcements').get().id;
  assert.deepEqual(db.prepare('SELECT category, pinned FROM announcements WHERE id = ?').get(pinId), { category: 'safety', pinned: 1 });
  assert.deepEqual(db.prepare('SELECT category, pinned FROM announcements WHERE id = ?').get(plainId), { category: 'general', pinned: 0 });

  // Unread: at the top with its label. Read: in the list below, the pinned one first even though it is older.
  let home = (await t2.get('/')).text;
  assert.match(home, /<span class="tag new">New<\/span><span class="tag cat-safety">Safety<\/span><strong>Ladder recall/);
  await t2.post(`/notices/${pinId}/read`, { back: 'home' }, { page: '/' });
  await t2.post(`/notices/${plainId}/read`, { back: 'home' }, { page: '/' });
  home = (await t2.get('/')).text;
  assert.doesNotMatch(home, /<span class="tag new">New<\/span>/);
  const board = /<ul class="board">[\s\S]*?<\/ul>/.exec(home)[0];
  assert.match(board, /Pinned[\s\S]*Ladder recall[\s\S]*Parking lot repaving/);
  assert.match(board, new RegExp(`href="/notices#n${pinId}"`));
  assert.match((await t2.get('/notices')).text, new RegExp(`id="n${pinId}"`));
  // The poster can unpin it; then newest comes first.
  assert.match((await owner.get(`${page}/${pinId}`)).text, /Unpin from the top of the list/);
  await owner.post(`${page}/${pinId}/pin`, {}, { page: `${page}/${pinId}` });
  assert.match(/<ul class="board">[\s\S]*?<\/ul>/.exec((await t2.get('/')).text)[0], /Parking lot repaving[\s\S]*Ladder recall/);
  assert.equal((await t2.post(`${page}/${plainId}/pin`, {})).status, 403);

  // Coming up: sessions on the calendar, but not one scheduled from a private request.
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const priv = db.prepare("INSERT INTO training_requests (user_id, description, wants_contact, is_private, created_at, created_local_date) VALUES (?, 'private thing', 0, 1, ?, '2026-01-01')").run(userId('tech1'), now).lastInsertRowid;
  const add = db.prepare('INSERT INTO training_sessions (title, request_id, session_date, session_time, location, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ids = [add.run('NICET study group', null, soon, '16:00', 'Training room', userId('owner'), now).lastInsertRowid,
    add.run('One to one coaching', priv, soon, '09:00', null, userId('owner'), now).lastInsertRowid,
    add.run('Last year fire pump class', null, '2020-01-01', null, null, userId('owner'), now).lastInsertRowid];
  home = (await t2.get('/')).text;
  assert.match(home, /Coming up[\s\S]*NICET study group[\s\S]*at 4:00 PM · Training room/);
  assert.doesNotMatch(home, /One to one coaching|Last year fire pump class/);

  // My status counts this person's own open requests.
  const open = () => db.prepare("SELECT COUNT(*) n FROM parts_submissions WHERE user_id = ? AND action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered')").get(userId('tech2')).n;
  const before = open();
  assert.match(home, new RegExp(`Parts requests</span><span class="mini-num">${before}<`));
  await t2.post('/parts', [['action', 'request'], ['part_name', 'SIGA-PS'], ['quantity', '2'], ['source', 'van'], ['needed_by', '2027-03-01']], { page: '/parts', multipart: true });
  assert.equal(open(), before + 1);
  assert.match((await t2.get('/')).text, new RegExp(`Parts requests</span><span class="mini-num">${before + 1}</span><span class="mini-sub">open request`));

  db.prepare(`DELETE FROM training_sessions WHERE id IN (${ids.join(',')})`).run();
  db.prepare('DELETE FROM training_requests WHERE id = ?').run(priv);
  db.prepare('DELETE FROM announcements WHERE id IN (?, ?)').run(pinId, plainId);
});

test('a critical announcement stays at the top of the home page, read or not, until it ends or is switched off', async () => {
  const owner = await loggedIn('owner');
  const t2 = await loggedIn('tech2');
  const page = '/admin/announcements';
  await owner.post(page, { title: 'Open enrollment', body: 'Update your selections by Friday.', category: 'hr', critical: '1' }, { page });
  const id = db.prepare('SELECT MAX(id) id FROM announcements').get().id;
  assert.equal(db.prepare('SELECT critical FROM announcements WHERE id = ?').get(id).critical, 1);
  await owner.post(page, { title: 'Ordinary news', body: 'Nothing urgent.' }, { page });
  const plain = db.prepare('SELECT MAX(id) id FROM announcements').get().id;
  assert.equal(db.prepare('SELECT critical FROM announcements WHERE id = ?').get(plain).critical, 0);

  // First on the page, above the newer ordinary notice, and shown once only.
  let home = (await t2.get('/')).text;
  assert.match(home, /class="critical"[\s\S]*Critical<\/span><span class="tag new">New<[\s\S]*Open enrollment[\s\S]*id="board-h"[\s\S]*Ordinary news/);
  assert.equal(home.match(/Open enrollment/g).length, 1);
  // Still there after it is read, without the button, and not repeated in the list of announcements.
  await t2.post(`/notices/${id}/read`, { back: 'home' }, { page: '/' });
  home = (await t2.get('/')).text;
  const top = /<section class="critical"[\s\S]*?<\/section>/.exec(home)[0];
  assert.match(top, /Open enrollment[\s\S]*Update your selections by Friday\.[\s\S]*You read this on/);
  assert.doesNotMatch(top, /I have read this|<span class="tag new">/);
  assert.doesNotMatch(/<ul class="board">[\s\S]*?<\/ul>/.exec(home)[0], /Open enrollment/);
  assert.match((await t2.get('/notices')).text, /is-critical[\s\S]*?Critical<\/span>[\s\S]*?Open enrollment/);
  assert.match((await owner.get(page)).text, /Open enrollment<\/strong><\/a> <span class="tag cat-hr">HR<\/span> <span class="tag crit">Critical/);

  // Past its "show until" date it is gone.
  db.prepare("UPDATE announcements SET expires_on = '2020-01-01' WHERE id = ?").run(id);
  assert.doesNotMatch((await t2.get('/')).text, /Open enrollment/);
  db.prepare('UPDATE announcements SET expires_on = NULL WHERE id = ?').run(id);

  // Switched off, it drops back in with the other announcements; an existing announcement can be switched on the same way.
  assert.equal((await t2.post(`${page}/${id}/critical`, {})).status, 403);
  assert.match((await owner.get(`${page}/${id}`)).text, /Stop showing as critical/);
  await owner.post(`${page}/${id}/critical`, {}, { page: `${page}/${id}` });
  home = (await t2.get('/')).text;
  assert.doesNotMatch(home, /class="critical"/);
  assert.match(/<ul class="board">[\s\S]*?<\/ul>/.exec(home)[0], /Open enrollment/);
  await owner.post(`${page}/${plain}/critical`, {}, { page: `${page}/${plain}` });
  assert.match((await t2.get('/')).text, /<section class="critical"[\s\S]*Ordinary news[\s\S]*<\/section>/);
  db.prepare('DELETE FROM announcements WHERE id IN (?, ?)').run(id, plain);
});

// ----------------------------------------------------------------------------
// Discussions
// ----------------------------------------------------------------------------

test('discussions: threads, replies with photos, following, new-reply notices, solved, and moderation', async () => {
  const techProfile = access.profileByName('Technician').id;
  access.setPermissions(techProfile, [...access.SUBMIT, 'forum.use']);
  const owner = await loggedIn('owner');
  const t1 = await loggedIn('tech1');
  const t2 = await loggedIn('tech2');
  const support = db.prepare("SELECT id FROM forum_sections WHERE kind = 'support'").get().id;
  const general = db.prepare("SELECT id FROM forum_sections WHERE name = 'General'").get().id;
  const forumFiles = () => db.prepare('SELECT path FROM forum_photos').all().map((r) => r.path).filter((f) => fs.existsSync(path.join(dataDir, 'uploads', f)));

  // The three starting sections are listed, and a signed-out visitor sees nothing.
  const index = (await t1.get('/discussions')).text;
  assert.match(index, /Tech support[\s\S]*General[\s\S]*Introductions/); assert.match(index, /Nothing posted yet/);
  assert.match((await new Client().get('/discussions')).location, /^\/login/);

  // Starting a thread needs a section, a title and a message; a file that is not an image is refused.
  const page = '/discussions/new';
  const bad = await t1.post(page, { section_id: '', title: '', body: '' }, { page, multipart: true });
  assert.equal(bad.status, 400); assert.match(bad.text, /Choose a section[\s\S]*Give the thread a title[\s\S]*Write your message/);
  const notImage = await t1.post(page, { section_id: String(support), title: 'x', body: 'y', photos: new Blob([Buffer.from('not an image')], { type: 'image/png' }) }, { page, multipart: true });
  assert.equal(notImage.status, 400);
  assert.equal((await t1.post(page, { section_id: String(support), title: 'x', body: 'y' }, { multipart: true, csrf: false })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM forum_threads').get().n, 0);

  const made = await t1.post(page, { section_id: String(support), title: 'XR550 will not take a new zone', body: 'Zone 612 shows <b>missing</b> after programming.', photos: new Blob([PNG], { type: 'image/png' }) }, { page, multipart: true });
  const id = Number(/\/discussions\/t\/(\d+)$/.exec(made.location)[1]);
  const tp = `/discussions/t/${id}`;
  let thread = (await t1.get(tp)).text;
  assert.match(thread, /XR550 will not take a new zone/);
  assert.match(thread, /Zone 612 shows &lt;b&gt;missing&lt;\/b&gt; after programming\./);            // shown as typed, never as markup
  assert.match(thread, /Following · stop/); assert.match(thread, /Mark as solved/); assert.match(thread, /Remove thread/);
  const photoId = db.prepare('SELECT id FROM forum_photos').get().id;
  assert.match(thread, new RegExp(`src="/discussions/photo/${photoId}"`));
  assert.equal((await t2.get(`/discussions/photo/${photoId}`)).status, 200);
  assert.match((await new Client().get(`/discussions/photo/${photoId}`)).location, /^\/login/);

  // Someone else sees it as new, cannot mark it solved or remove it, and is not following until they reply.
  assert.match((await t2.get('/discussions')).text, /<li class="unread">[\s\S]*?XR550 will not take a new zone/);
  thread = (await t2.get(tp)).text;
  assert.match(thread, /Follow this thread/); assert.doesNotMatch(thread, /Mark as solved|Remove thread|Moderator tools/);
  assert.equal((await t2.post(`${tp}/solved`, {}, { page: tp })).status, 403);
  assert.equal((await t2.post(`${tp}/delete`, {}, { page: tp })).status, 403);
  assert.equal((await t2.post(`${tp}/lock`, {}, { page: tp })).status, 403);
  assert.doesNotMatch((await t2.get('/discussions')).text, /<li class="unread">/);                    // read now

  // A reply tells the person who asked: a badge on the menu and a line at the top of their home page.
  assert.equal((await t2.post(`${tp}/reply`, { body: '' }, { page: tp, multipart: true })).status, 400);
  const replied = await t2.post(`${tp}/reply`, { body: 'Check the LX bus address, 612 is on the 600 bus.' }, { page: tp, multipart: true });
  const replyId = Number(/#p(\d+)$/.exec(replied.location)[1]);
  assert.equal(db.prepare('SELECT reply_count FROM forum_threads WHERE id = ?').get(id).reply_count, 1);
  let home = (await t1.get('/')).text;
  assert.match(home, /href="\/discussions"[^>]*>Discussions <span class="badge"[^>]*>1<\/span>/);
  assert.match(home, /New replies<\/span>[\s\S]*<strong>Uma Tech<\/strong> replied in <strong>XR550 will not take a new zone<\/strong>/);
  assert.doesNotMatch((await t2.get('/')).text, /New replies/);                                       // not for the person who wrote it
  assert.doesNotMatch((await owner.get('/')).text, /New replies/);                                    // nor for people not following
  // Opening the thread shows which reply is new and clears the notice.
  thread = (await t1.get(tp)).text;
  assert.match(thread, new RegExp(`id="p${replyId}"[\\s\\S]*?<span class="tag new">New</span>`));
  assert.doesNotMatch(thread, /Discussions <span class="badge"/);
  home = (await t1.get('/')).text;
  assert.doesNotMatch(home, /New replies/); assert.doesNotMatch(home, /Discussions <span class="badge"/);
  assert.match(home, /id="talk-h">Discussions[\s\S]*XR550 will not take a new zone[\s\S]*Tech support · 1 reply/);
  // The replier follows too, so the asker's answer reaches them; unfollowing stops that.
  await t1.post(`${tp}/reply`, { body: 'That was it, thanks.' }, { page: tp, multipart: true });
  assert.match((await t2.get('/')).text, /<strong>Terry Tech<\/strong> replied in/);
  await t2.post(`${tp}/follow`, { follow: '0' }, { page: tp });
  assert.doesNotMatch((await t2.get('/')).text, /New replies/);

  // The asker marks it solved; with replies they can no longer remove the thread, but can remove their own reply.
  await t1.post(`${tp}/solved`, {}, { page: tp });
  assert.match((await t2.get(`/discussions/s/${support}`)).text, /<span class="tag solved">Solved<\/span>/);
  assert.equal((await t1.post(`${tp}/delete`, {}, { page: tp })).status, 403);
  assert.equal((await t1.post(`/discussions/p/${replyId}/delete`, {}, { page: tp })).status, 403);   // someone else's reply
  const firstPost = db.prepare('SELECT MIN(id) id FROM forum_posts WHERE thread_id = ?').get(id).id;
  assert.equal((await owner.post(`/discussions/p/${firstPost}/delete`, {}, { page: tp })).status, 404); // the opening post goes with its thread
  const mine = db.prepare('SELECT MAX(id) id FROM forum_posts WHERE thread_id = ?').get(id).id;
  await t1.post(`/discussions/p/${mine}/delete`, {}, { page: tp });
  const row = db.prepare('SELECT reply_count, last_post_user_id FROM forum_threads WHERE id = ?').get(id);
  assert.deepEqual(row, { reply_count: 1, last_post_user_id: userId('tech2') });

  // Search finds words in titles and in replies.
  assert.match((await t1.get('/discussions?q=LX+bus')).text, /Results for "LX bus"[\s\S]*XR550 will not take a new zone/);
  assert.match((await t1.get('/discussions?q=nothing%25here')).text, /Nothing found/);

  // A moderator can pin, lock, move and remove. A locked thread takes no replies.
  thread = (await owner.get(tp)).text;
  assert.match(thread, /Moderator tools/);
  await owner.post(`${tp}/pin`, {}, { page: tp });
  await owner.post(`${tp}/lock`, {}, { page: tp });
  assert.match((await t2.get(tp)).text, /This thread is locked/);
  assert.equal((await t2.post(`${tp}/reply`, { body: 'one more thing' }, { page: tp, multipart: true })).status, 400);
  await owner.post(`${tp}/move`, { section_id: String(general) }, { page: tp });
  assert.deepEqual(db.prepare('SELECT section_id, solved_at, is_pinned, is_locked FROM forum_threads WHERE id = ?').get(id), { section_id: general, solved_at: null, is_pinned: 1, is_locked: 1 });
  await owner.post(`/discussions/p/${replyId}/delete`, {}, { page: tp });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'Discussion reply removed'").get().n, 1);
  assert.equal(forumFiles().length, 1);
  const photoFile = path.join(dataDir, 'uploads', forumFiles()[0]);
  await owner.post(`${tp}/delete`, {}, { page: tp });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await t1.get(tp)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM forum_posts').get().n + db.prepare('SELECT COUNT(*) n FROM forum_photos').get().n + db.prepare('SELECT COUNT(*) n FROM forum_reads').get().n, 0);
  assert.equal(fs.existsSync(photoFile), false);                                                    // its photo went with it

  // Someone who started a thread nobody has answered can remove it themselves.
  const own = await t2.post(page, { section_id: String(general), title: 'Posted in the wrong place', body: 'Ignore this.' }, { page, multipart: true });
  assert.equal((await t2.post(`${own.location}/delete`, {}, { page: own.location })).location, `/discussions/s/${general}`);

  // Without the permission there is no link and no way in.
  access.setPermissions(techProfile, access.SUBMIT);
  assert.doesNotMatch((await t1.get('/')).text, /\/discussions/);
  assert.equal((await t1.get('/discussions')).status, 403);
  access.setPermissions(techProfile, [...access.SUBMIT, 'forum.use']);
});

test('discussions: a double tap on Post makes one thread and one reply, not two', async () => {
  access.setPermissions(access.profileByName('Technician').id, [...access.SUBMIT, 'forum.use']);
  const t1 = await loggedIn('tech1');
  const intro = db.prepare("SELECT id FROM forum_sections WHERE name = 'Introductions'").get().id;
  const page = '/discussions/new';
  const fields = { section_id: String(intro), title: 'Terry T.', body: 'Hello from the install side.' };
  const [a, b] = await Promise.all([t1.post(page, fields, { page, multipart: true }), t1.post(page, fields, { page, multipart: true })]);
  assert.equal(a.location, b.location);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM forum_threads WHERE title = 'Terry T.'").get().n, 1);
  assert.match((await t1.get(page)).text, /<form[^>]*data-once/);
  // A different message under the same title is a new thread.
  const other = await t1.post(page, { ...fields, body: 'A second, different hello.' }, { page, multipart: true });
  assert.notEqual(other.location, a.location);
  // The same reply twice in a row is kept once; saying something else afterwards is not held back.
  const tp = a.location;
  const r1 = await t1.post(`${tp}/reply`, { body: 'Forgot to say: 12 years in.' }, { page: tp, multipart: true });
  const r2 = await t1.post(`${tp}/reply`, { body: 'Forgot to say: 12 years in.' }, { page: tp, multipart: true });
  assert.equal(r1.location, r2.location);
  await t1.post(`${tp}/reply`, { body: 'And one more thing.' }, { page: tp, multipart: true });
  assert.equal(db.prepare('SELECT reply_count FROM forum_threads WHERE id = ?').get(Number(tp.split('/').pop())).reply_count, 2);
  db.prepare("DELETE FROM forum_threads WHERE title = 'Terry T.'").run();
});

test('notification bell at the top right gathers what is waiting; light/dark moved into the menu', async () => {
  const bellOf = (html) => { const m = /<details class="bell"[\s\S]*?<\/details>/.exec(html); return m ? m[0].replace(/\s+/g, ' ') : null; };
  const banner = (html) => /<div class="banner">[\s\S]*?<div class="stripe"/.exec(html)[0];
  const nav = (html) => /<nav class="nav"[\s\S]*?<\/nav>/.exec(html)[0];

  // Signed out there is no bell, and the light/dark button stays in the banner because there is no menu.
  const login = (await new Client().get('/login')).text;
  assert.equal(bellOf(login), null);
  assert.match(banner(login), /id="theme-toggle"/);

  // Signed in: the bell is in the banner, the light/dark switch is in the menu, and there is exactly one of each.
  makeUser('bell1', 'Bella Bell');
  const c = await loggedIn('bell1');
  const home = (await c.get('/')).text;
  assert.ok(bellOf(home));
  assert.match(banner(home), /class="bell"/);
  assert.doesNotMatch(banner(home), /id="theme-toggle"/);
  assert.match(nav(home), /id="theme-toggle"[\s\S]*Dark mode[\s\S]*Light mode/);
  assert.equal((home.match(/id="theme-toggle"/g) || []).length, 1);
  assert.equal((home.match(/class="bell"/g) || []).length, 1);

  // Count what is waiting for this person right now, then add one of each kind and watch the bell follow.
  const total = (html) => { const m = /class="bell-count">(\d+)/.exec(html); return m ? Number(m[1]) : 0; };
  const before = total(home);
  const owner = await loggedIn('owner');
  await owner.post('/admin/announcements', { title: 'Bell test notice', body: 'Read me.' }, { page: '/admin/announcements' });
  await c.post('/parts', [['action', 'request'], ['part_name', 'BELL-PART'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-09-01']], { multipart: true });
  const reqId = lastParts().id;
  await owner.post(`/admin/parts/${reqId}/status`, { status: 'ordered', back: 'requests' }, { page: '/admin/requests' });

  const after = (await c.get('/')).text;
  assert.equal(total(after), before + 2);
  const bell = bellOf(after);
  assert.match(bell, /aria-label="Notifications, \d+ waiting"/);
  assert.match(bell, /href="\/notices"><span class="bell-n">\d+<\/span><span>unread announcements?<\/span>/);
  assert.match(bell, /href="\/my"><span class="bell-n">1<\/span><span>update on your requests<\/span>/);
  assert.doesNotMatch(bell, /admin\//);                                   // a technician is not shown management items

  // Looking at them clears them from the bell.
  await c.get('/my');
  assert.doesNotMatch(bellOf((await c.get('/')).text), /update on your requests/);
  const aid = db.prepare("SELECT id FROM announcements WHERE title = 'Bell test notice'").get().id;
  await c.post(`/notices/${aid}/read`, {}, { page: '/notices' });
  assert.equal(total((await c.get('/')).text), before);

  // Someone who manages parts also sees the work waiting on them.
  const ob = bellOf((await owner.get('/')).text);
  assert.match(ob, /href="\/admin\/requests"><span class="bell-n">\d+<\/span><span>open parts requests?<\/span>/);
  await owner.post(`/admin/parts/${reqId}/status`, { status: 'fulfilled', back: 'requests' }, { page: '/admin/requests' });

  // Nothing waiting says so plainly.
  makeUser('bell2', 'Quiet Person');
  db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) SELECT id, ?, ? FROM announcements').run(userId('bell2'), new Date().toISOString());
  const quiet = bellOf((await (await loggedIn('bell2')).get('/')).text);
  assert.match(quiet, /aria-label="Notifications, none"/);
  assert.match(quiet, /Nothing waiting/);
  assert.doesNotMatch(quiet, /bell-count/);
});

test('tasks: assigned with a due date, shown in the bell with when they are due, and ticked off', async () => {
  const owner = await loggedIn('owner');
  const page = '/admin/tasks';
  const bellOf = (html) => /<details class="bell"[\s\S]*?<\/details>/.exec(html)[0].replace(/\s+/g, ' ');
  const total = (html) => { const m = /class="bell-count">(\d+)/.exec(html); return m ? Number(m[1]) : 0; };
  makeUser('task1', 'Tess Tasker'); makeUser('task2', 'Toby Tasker');
  db.prepare("UPDATE users SET email = 'tess@example.com' WHERE username = 'task1'").run();
  const tess = await loggedIn('task1');
  const before = total((await tess.get('/')).text);

  assert.equal((await owner.post(page, { title: '', to: String(userId('task1')) }, { page })).status, 400);     // no title
  assert.equal((await owner.post(page, { title: 'Nobody picked' }, { page })).status, 400);                     // nobody chosen
  assert.equal((await owner.post(page, { title: 'Bad date', to: String(userId('task1')), due_on: 'soon' }, { page })).status, 400);
  sent.length = 0;
  // One task for two people makes a copy each; then tasks due at different times for Tess.
  await owner.post(page, [['title', 'Restock truck 309 batteries'], ['details', 'Ten 12V 7Ah.'], ['due_on', ymdFromNow(1)], ['to', String(userId('task1'))], ['to', String(userId('task2'))]], { page });
  await owner.post(page, { title: 'Send in last week\'s timesheet', due_on: ymdFromNow(-3), to: String(userId('task1')) }, { page });
  await owner.post(page, { title: 'Read the new ladder policy', to: String(userId('task1')) }, { page });
  await owner.post(page, { title: 'Annual fit test', due_on: ymdFromNow(20), to: String(userId('task1')) }, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE assigned_to = ?').get(userId('task1')).n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE assigned_to = ?').get(userId('task2')).n, 1);
  assert.deepEqual(sent.map((m) => m.to), Array(4).fill('tess@example.com'));                                  // Toby has no email; the bell still tells him
  assert.match(sent[0].subject, /New task: Restock truck 309 batteries/);
  assert.match(sent[0].text, /Olive Owner gave you a task/);

  // The bell: every open task by name, overdue first, each with when it is due; all counted in the number.
  const home = (await tess.get('/')).text;
  assert.equal(total(home), before + 4);
  const bell = bellOf(home);
  const order = ['Send in last week&#39;s timesheet', 'Restock truck 309 batteries', 'Annual fit test', 'Read the new ladder policy'].map((t) => bell.indexOf(t));
  assert.ok(order.every((pos, i) => pos > 0 && (i === 0 || pos > order[i - 1])), order.join(','));
  assert.match(bell, /class="bell-task overdue">.*?timesheet<\/strong><span class="bell-due">Overdue by 3 days \(was due \d+\/\d+\/\d{4}\)/);
  assert.match(bell, /Restock truck 309 batteries<\/strong><span class="bell-due">Due tomorrow</);
  assert.match(bell, /Annual fit test<\/strong><span class="bell-due">Due \d+\/\d+\/\d{4}</);
  assert.match(bell, /Read the new ladder policy<\/strong><span class="bell-due">No due date</);
  assert.match(home, /href="\/tasks"[^>]*>Tasks <span class="badge"[^>]*>4<\/span>/);
  assert.equal(total((await (await loggedIn('task2')).get('/')).text) >= 1, true);
  assert.doesNotMatch(bellOf((await (await loggedIn('task2')).get('/')).text), /timesheet/);                    // only your own

  // Tasks page, and ticking one off with a note.
  const mine = (await tess.get('/tasks')).text;
  assert.match(mine, /Ten 12V 7Ah\./); assert.match(mine, /From Olive Owner/); assert.match(mine, /class="tag overdue">Overdue</);
  const tid = db.prepare("SELECT id FROM tasks WHERE title LIKE 'Send in%'").get().id;
  await tess.post(`/tasks/${tid}/done`, { done_note: 'Emailed it Monday' }, { page: '/tasks' });
  const after = (await tess.get('/')).text;
  assert.equal(total(after), before + 3);
  assert.doesNotMatch(bellOf(after), /timesheet/);
  assert.match((await owner.get(page + '?show=done')).text.replace(/\s+/g, ' '), /timesheet.*Note: Emailed it Monday.*Done/);
  await tess.post(`/tasks/${tid}/done`, {}, { page: '/tasks' });                                                // changed her mind
  assert.equal(db.prepare('SELECT done_at FROM tasks WHERE id = ?').get(tid).done_at, null);
  // Nobody can tick off someone else's task from their own page.
  assert.equal((await (await loggedIn('task2')).post(`/tasks/${tid}/done`, {})).status, 403);

  // More than six: the bell lists six and says how many more.
  for (let i = 0; i < 4; i++) await owner.post(page, { title: `Extra task ${i}`, to: String(userId('task1')) }, { page });
  const many = bellOf((await tess.get('/')).text);
  assert.equal((many.match(/class="bell-task/g) || []).length, 6);
  assert.match(many, /and 2 more tasks/);

  // Following up: overdue filter, edit, reassign, mark done for them, remove.
  const list = (await owner.get(page + '?show=overdue')).text;
  assert.match(list, /timesheet/); assert.doesNotMatch(list, /Annual fit test/);
  assert.match((await owner.get(page)).text.replace(/\s+/g, ' '), /<strong>\d+<\/strong> open, <strong>1 overdue<\/strong>/);
  await owner.post(`${page}/${tid}`, { title: 'Send in the timesheet', due_on: ymdFromNow(2), assigned_to: String(userId('task2')) }, { page: `${page}/${tid}` });
  assert.deepEqual({ ...db.prepare('SELECT title, assigned_to FROM tasks WHERE id = ?').get(tid) }, { title: 'Send in the timesheet', assigned_to: userId('task2') });
  await owner.post(`${page}/${tid}/done`, {}, { page });
  assert.match(db.prepare('SELECT done_note FROM tasks WHERE id = ?').get(tid).done_note, /Marked done by Olive Owner/);
  await owner.post(`${page}/${tid}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE id = ?').get(tid).n, 0);

  // Who may assign: not technicians; a manager only to their own people, and only sees those tasks plus ones they gave.
  for (const who of ['task1', 'tech1', 'wh1']) {
    const c = await loggedIn(who);
    assert.equal((await c.get(page)).status, 403, who);
    assert.equal((await c.post(page, { title: 'x', to: String(userId('task2')) })).status, 403, who);
  }
  const mgr = await loggedIn('mgr1');
  const form = (await mgr.get(page)).text;
  assert.match(form, /Terry Tech/); assert.doesNotMatch(form, /Tess Tasker|Uma Tech|Annual fit test/);
  assert.equal((await mgr.post(page, { title: 'Outside my team', to: String(userId('task1')) }, { page })).status, 400);
  assert.equal((await mgr.post(page, { title: 'Clean out the van', due_on: ymdFromNow(0), to: String(userId('tech1')) }, { page })).status, 302);
  assert.match(bellOf((await (await loggedIn('tech1')).get('/')).text), /Clean out the van<\/strong><span class="bell-due">Due today</);
  const fit = db.prepare("SELECT id FROM tasks WHERE title = 'Annual fit test'").get().id;
  assert.equal((await mgr.get(`${page}/${fit}`)).status, 403);
  assert.equal((await mgr.post(`${page}/${fit}/delete`, {})).status, 403);
  assert.match((await owner.get('/admin/activity?q=Task')).text, /Task assigned/);
  db.prepare('DELETE FROM tasks').run();
});

test('push alerts: sent for the chosen events, to the right people, and each person can switch kinds off', async () => {
  const push = require('../app/push');
  const pushed = [];
  let fail = null;
  push.setSender(async (sub, payload) => { if (fail && sub.endpoint.includes(fail)) { const e = new Error('gone'); e.statusCode = 410; throw e; } pushed.push({ to: sub.user_id, endpoint: sub.endpoint, ...JSON.parse(payload) }); });
  const flush = () => new Promise((r) => setTimeout(r, 30));
  const take = async () => { await flush(); return pushed.splice(0); };
  const who = (list) => list.map((p) => db.prepare('SELECT username FROM users WHERE id = ?').get(p.to).username).sort();

  makeUser('push1', 'Petra Push'); makeUser('push2', 'Paul Push');
  const petra = await loggedIn('push1');
  const page = '/settings/notifications';
  const sub = (client, name) => client.post('/push/subscribe', { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg', device: 'Test phone' }, { page });

  // The settings page offers each person only the kinds that apply to them.
  const mine = (await petra.get(page)).text;
  for (const k of ['task_assigned', 'critical_notice', 'request_status', 'forum_reply']) assert.match(mine, new RegExp(`name="kinds" value="${k}" checked`));
  assert.doesNotMatch(mine, /value="(parts_request|truck_problem|low_stock|task_done)"/);
  const ownerPage = (await (await loggedIn('owner')).get(page)).text;
  for (const k of ['parts_request', 'truck_problem', 'low_stock', 'task_done']) assert.match(ownerPage, new RegExp(`value="${k}" checked`));
  assert.match(mine, /data-key="[A-Za-z0-9_-]{80,}"/);                       // the site's public key, made automatically
  assert.match((await petra.get('/')).text, /href="\/settings\/notifications"/); // reachable from the bell and the menu

  // Registering a device; nonsense is refused.
  assert.equal((await petra.post('/push/subscribe', { endpoint: 'not-a-url', p256dh: 'x', auth: 'y' }, { page })).status, 400);
  assert.equal((await sub(petra, 'petra-phone')).status, 200);
  await sub(petra, 'petra-phone');                                            // registering twice keeps one row
  await sub(petra, 'petra-laptop');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?').get(userId('push1')).n, 2);
  const owner = await loggedIn('owner'); await sub(owner, 'owner-phone');
  const wh = await loggedIn('wh1'); await sub(wh, 'wh-phone');
  const mgr = await loggedIn('mgr1'); await sub(mgr, 'mgr-phone');
  const paul = await loggedIn('push2');                                       // no device registered: never pushed to
  assert.equal((await new Client().get(page)).status, 302);

  // 1. A task is assigned: both of the person's devices; the assigner hears when it is done.
  await owner.post('/admin/tasks', [['title', 'Push task'], ['due_on', ymdFromNow(1)], ['to', String(userId('push1'))], ['to', String(userId('push2'))]], { page: '/admin/tasks' });
  let got = await take();
  assert.deepEqual(got.map((p) => p.endpoint).sort(), ['https://fcm.googleapis.com/fcm/send/petra-laptop', 'https://fcm.googleapis.com/fcm/send/petra-phone']);
  assert.deepEqual([got[0].title, got[0].url, got[0].tag], ['New task: Push task', '/tasks', 'task_assigned']);
  assert.match(got[0].body, /From Olive Owner\. Due \d+\/\d+\/\d{4}\./);
  const tid = db.prepare("SELECT id FROM tasks WHERE title = 'Push task' AND assigned_to = ?").get(userId('push1')).id;
  await petra.post(`/tasks/${tid}/done`, { done_note: 'All set' }, { page: '/tasks' });
  got = await take();
  assert.deepEqual(who(got), ['owner']);
  assert.deepEqual([got[0].title, got[0].tag], ['Done: Push task', 'task_done']);
  assert.match(got[0].body, /Petra Push marked it done\. "All set"/);

  // 2. Critical announcements go to everyone they are for (not the poster); ordinary ones do not push.
  await owner.post('/admin/announcements', { title: 'Ordinary note', body: 'Nothing urgent.' }, { page: '/admin/announcements' });
  assert.deepEqual(await take(), []);
  await owner.post('/admin/announcements', { title: 'Gas leak at the shop', body: 'Do not come in until told.', critical: '1' }, { page: '/admin/announcements' });
  got = await take();
  assert.deepEqual(who(got), ['mgr1', 'push1', 'push1', 'wh1']);
  assert.equal(got[0].title, 'Critical: Gas leak at the shop');

  // 3. A parts request: people who manage parts (and may see the requester); then the requester hears about the status.
  await petra.post('/parts', [['action', 'request'], ['part_name', 'PUSH-PART'], ['quantity', '2'], ['source', 'van'], ['needed_by', '2031-10-01']], { multipart: true });
  got = await take();
  assert.deepEqual(who(got), ['owner', 'wh1']);                              // the manager does not manage Petra
  assert.match(got[0].title, /Parts request from Petra Push/); assert.match(got[0].body, /2 × PUSH-PART\. Needed by 2031-10-01\./);
  await wh.post(`/admin/parts/${lastParts().id}/status`, { status: 'ordered', back: 'requests' }, { page: '/admin/requests' });
  got = await take();
  assert.deepEqual(who(got), ['push1', 'push1']);
  assert.deepEqual([got[0].title, got[0].tag, got[0].url], ['Parts request: Ordered', 'request_status', '/my']);

  // 4. A truck problem: people who can see inspections for that person.
  const items = db.prepare('SELECT id FROM inspection_items WHERE active = 1 ORDER BY sort').all();
  await petra.post('/inspection', [['truck', '311'], ...items.map((it, i) => (i === 0 ? [`item_${it.id}`, 'problem'] : [`item_${it.id}`, 'ok'])), [`note_${items[0].id}`, 'Flat tire']], { multipart: true, page: '/inspection' });
  got = await take();
  assert.deepEqual(who(got), ['owner', 'wh1']);
  assert.match(got[0].title, /Truck 311: 1 problem reported/); assert.match(got[0].body, /Petra Push: .*Flat tire/);

  // 5. Low stock: people who manage stock, once, when a take crosses the minimum.
  await wh.post('/admin/stock', { part_number: 'PUSH-LOW', count: '5', min_level: '3' }, { page: '/admin/stock' });
  await new Promise((r) => setTimeout(r, 5));
  await takeParts(petra, [['PUSH-LOW', 2]]);
  got = await take();
  assert.deepEqual(who(got), ['owner', 'wh1']);
  assert.deepEqual([got[0].title, got[0].tag], ['Low stock: PUSH-LOW', 'low_stock']);
  await takeParts(petra, [['PUSH-LOW', 1]]);
  assert.deepEqual(await take(), []);

  // 6. A reply in a discussion: the people following it, not the person who wrote.
  const section = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  await petra.post('/discussions/new', [['section_id', String(section)], ['title', 'Push thread'], ['body', 'First post']], { multipart: true, page: '/discussions/new' });
  const thread = db.prepare("SELECT id FROM forum_threads WHERE title = 'Push thread'").get().id;
  await take();
  await paul.post(`/discussions/t/${thread}/reply`, [['body', 'A reply\nfrom Paul']], { multipart: true, page: `/discussions/t/${thread}` });
  got = await take();
  assert.deepEqual(who(got), ['push1', 'push1']);
  assert.deepEqual([got[0].title, got[0].body, got[0].tag], ['New reply: Push thread', 'Paul Push: A reply from Paul', 'forum_reply']);
  assert.match(got[0].url, new RegExp(`^/discussions/t/${thread}#p\\d+$`));

  // Switching a kind off stops those alerts for that person only; the rest keep coming.
  await petra.post(page, [['kinds', 'critical_notice'], ['kinds', 'request_status']], { page });
  assert.doesNotMatch((await petra.get(page)).text, /value="task_assigned" checked/);
  await owner.post('/admin/tasks', { title: 'Quiet task', to: String(userId('push1')) }, { page: '/admin/tasks' });
  await paul.post(`/discussions/t/${thread}/reply`, [['body', 'Another reply']], { multipart: true, page: `/discussions/t/${thread}` });
  assert.deepEqual(await take(), []);
  assert.match((await petra.get('/')).text, /Quiet task/);                    // still in the bell
  await owner.post('/admin/announcements', { title: 'Still critical', body: 'x', critical: '1' }, { page: '/admin/announcements' });
  assert.ok(who(await take()).includes('push1'));

  // A device the phone has dropped is forgotten the first time sending to it fails.
  fail = 'petra-laptop';
  await owner.post('/admin/announcements', { title: 'Critical again', body: 'x', critical: '1' }, { page: '/admin/announcements' });
  await take();
  fail = null;
  assert.deepEqual(db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(userId('push1')).map((r) => r.endpoint), ['https://fcm.googleapis.com/fcm/send/petra-phone']);

  // Test alert, and turning a device off (only your own).
  await petra.post('/push/test', {}, { page });
  got = await take();
  assert.deepEqual([got.length, got[0].title], [1, 'Test alert']);
  const dev = db.prepare('SELECT id FROM push_subscriptions WHERE user_id = ?').get(userId('push1')).id;
  await paul.post('/push/unsubscribe', { id: String(dev) }, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE id = ?').get(dev).n, 1);
  await petra.post('/push/unsubscribe', { id: String(dev) }, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?').get(userId('push1')).n, 0);
  await petra.post('/push/test', {}, { page });
  assert.match((await petra.get(page)).text, /No device has alerts turned on yet/);

  // The real sending path: the stored keys can sign and encrypt a message for a genuine browser subscription.
  const webpush = require('web-push');
  const crypto = require('crypto');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const real = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: ecdh.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const k = push.vapid();
  assert.deepEqual(push.vapid(), k);                                          // made once, then reused
  const details = webpush.generateRequestDetails(real, JSON.stringify({ title: 'x' }), { vapidDetails: { subject: 'https://portal.test', publicKey: k.publicKey, privateKey: k.privateKey } });
  assert.equal(details.method, 'POST');
  assert.match(details.headers.Authorization, /^vapid t=.+, k=/);
  assert.ok(details.body.length > 50);

  // The background script handles the alert and the tap.
  const sw = (await new Client().get('/sw.js')).text;
  assert.match(sw, /addEventListener\('push'/); assert.match(sw, /addEventListener\('notificationclick'/);
  db.prepare('DELETE FROM push_subscriptions').run(); db.prepare('DELETE FROM tasks').run();
  push.setSender(async () => {});
});

test('tasks can be given to a whole profile, to everyone, or to people picked one by one', async () => {
  const owner = await loggedIn('owner');
  const page = '/admin/tasks';
  db.prepare('DELETE FROM tasks').run();
  const got = (title) => db.prepare('SELECT u.username FROM tasks t JOIN users u ON u.id = t.assigned_to WHERE t.title = ? ORDER BY u.username').all(title).map((r) => r.username);
  const onProfile = (name) => db.prepare('SELECT u.username FROM users u JOIN profiles p ON p.id = u.profile_id WHERE p.name = ? AND u.active = 1 ORDER BY u.username').all(name).map((r) => r.username);

  // The form offers each profile with how many people are on it, and Everyone.
  const form = (await owner.get(page)).text;
  assert.match(form, new RegExp(`name="group" value="${profileId('Warehouse')}"[^>]*><span>Warehouse \\(${onProfile('Warehouse').length}\\)`));
  assert.match(form, /name="group" value="all"[^>]*><span>Everyone \(\d+\)/);
  assert.match(form, /id="person-search"/);

  // A whole profile: every active person on it gets their own copy, and disabled accounts are left out.
  await owner.post(page, [['title', 'Group task'], ['group', String(profileId('Warehouse'))]], { page });
  assert.deepEqual(got('Group task'), onProfile('Warehouse'));
  assert.ok(got('Group task').length >= 1);

  // A profile plus one extra person; someone in both is not given it twice.
  await owner.post(page, [['title', 'Mixed task'], ['group', String(profileId('Warehouse'))], ['to', String(userId('tech1'))], ['to', String(userId('wh1'))]], { page });
  assert.deepEqual(got('Mixed task'), [...new Set([...onProfile('Warehouse'), 'tech1'])].sort());

  // Everyone.
  await owner.post(page, [['title', 'All hands'], ['group', 'all']], { page });
  assert.equal(got('All hands').length, db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n);
  assert.match(db.prepare("SELECT detail FROM activity_log WHERE action = 'Task assigned' ORDER BY id DESC").get().detail, /"All hands" to \d+ people/);

  // Nothing chosen is still an error, and a made-up group gives nobody.
  assert.equal((await owner.post(page, [['title', 'Nobody'], ['group', '99999']], { page })).status, 400);

  // A manager's groups are their own people only: "Everyone" means everyone they manage.
  const mgr = await loggedIn('mgr1');
  const mform = (await mgr.get(page)).text;
  assert.match(mform, /<span>Everyone \(2\)/);                                 // the manager and Terry Tech
  assert.doesNotMatch(mform, /<span>Warehouse \(/);
  await mgr.post(page, [['title', 'Team only'], ['group', 'all']], { page });
  assert.deepEqual(got('Team only'), ['mgr1', 'tech1']);
  await mgr.post(page, [['title', 'Sneaky group'], ['group', String(profileId('Warehouse'))]], { page });
  assert.deepEqual(got('Sneaky group'), []);
  db.prepare('DELETE FROM tasks').run();
});

test('photos open in the page viewer: no link sends the app to a bare image in a new window', async () => {
  const fs2 = require('fs'); const path2 = require('path');
  const dir = path2.join(__dirname, '..', 'app', 'views');
  const all = fs2.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.ejs')).map((f) => fs2.readFileSync(path2.join(dir, String(f)), 'utf8')).join('\n');
  const photoLinks = all.match(/<a [^>]*href="[^"]*\/photo\/[^>]*>/g) || [];
  assert.ok(photoLinks.length >= 4);
  for (const link of photoLinks) assert.doesNotMatch(link, /target=/, link);
  const js = (await new Client().get('/site.js')).text;
  assert.match(js, /photo-viewer/); assert.match(js, /popstate/);        // the viewer, and Back closing it
});

test('phone bottom bar: Home, Parts, Tasks, Alerts and More, with the bell list as a page of its own', async () => {
  const barOf = (html) => { const m = /<nav class="tabbar[\s\S]*?<\/nav>/.exec(html); return m ? m[0] : null; };
  const tabs = (html) => [...barOf(html).matchAll(/<a href="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)<span>([^<]+)<\/span>/g)].map((m) => `${m[2]} ${m[1]}`);

  // Signed out there is no bar.
  assert.equal(barOf((await new Client().get('/login')).text), null);

  makeUser('bar1', 'Barry Bar');
  const c = await loggedIn('bar1');
  let home = (await c.get('/')).text;
  assert.deepEqual(tabs(home), ['Home /', 'Parts /parts', 'Tasks /tasks', 'Alerts /alerts', 'More #navbar']);
  assert.match(barOf(home), /<a href="\/" aria-current="page"/);                       // the tab you are on is marked
  assert.match(barOf((await c.get('/parts')).text), /<a href="\/parts" aria-current="page"/);
  assert.match(home, /<body class="has-tabbar">/);
  assert.match(home, /viewport-fit=cover/);

  // Tasks and everything else are counted separately on the bar.
  const count = (html, label) => { const m = new RegExp(`<span>${label}</span><b class="tab-count">(\\d+)`).exec(barOf(html)); return m ? Number(m[1]) : 0; };
  const alertsBefore = count(home, 'Alerts');
  assert.equal(count(home, 'Tasks'), 0);
  const owner = await loggedIn('owner');
  await owner.post('/admin/tasks', [['title', 'Bar task'], ['due_on', ymdFromNow(-1)], ['to', String(userId('bar1'))]], { page: '/admin/tasks' });
  await owner.post('/admin/announcements', { title: 'Bar announcement', body: 'Read me.' }, { page: '/admin/announcements' });
  home = (await c.get('/')).text;
  assert.equal(count(home, 'Tasks'), 1);
  assert.equal(count(home, 'Alerts'), alertsBefore + 1);

  // The Alerts page holds the same list as the bell.
  const alerts = (await c.get('/alerts')).text;
  assert.match(alerts, /<h1>Alerts<\/h1>/);
  assert.match(alerts, /class="card alert-items alert-page">[\s\S]*Your tasks[\s\S]*Bar task[\s\S]*Overdue by 1 day[\s\S]*unread announcements?[\s\S]*Notification settings/);
  assert.match(barOf(alerts), /<a href="\/alerts" aria-current="page"/);
  assert.equal((await new Client().get('/alerts')).status, 302);                      // signed in only

  // Someone who cannot send parts entries but can read the log gets the log; with neither, no Parts tab.
  const pid = db.prepare("INSERT INTO profiles (name, scope, created_at) VALUES ('Bar reader', 'all', ?)").run(new Date().toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO profile_permissions (profile_id, permission) VALUES (?, 'parts.view')").run(pid);
  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(pid, userId('bar1'));
  assert.deepEqual(tabs((await c.get('/')).text).slice(0, 2), ['Home /', 'Parts /admin/parts']);
  db.prepare('DELETE FROM profile_permissions WHERE profile_id = ?').run(pid);
  assert.deepEqual(tabs((await c.get('/')).text), ['Home /', 'Tasks /tasks', 'Alerts /alerts', 'More #navbar']);

  // The sheet behind More, and Back closing it, are in the script.
  const js = (await new Client().get('/site.js')).text;
  assert.match(js, /more-toggle/); assert.match(js, /menuSheet/);
  db.prepare('DELETE FROM tasks').run();
});

test('home page: tasks first, then the form buttons, then announcements; branch numbers only for people who run things', async () => {
  const flat = async (c) => (await c.get('/')).text.replace(/\s+/g, ' ');
  const order = (html, ...marks) => marks.map((m) => html.indexOf(m));
  const rising = (list) => list.every((n, i) => n >= 0 && (i === 0 || n > list[i - 1]));

  // A technician: their tasks, the buttons, then announcements, in that order on a phone.
  const owner = await loggedIn('owner');
  await owner.post('/admin/tasks', [['title', 'Home task late'], ['due_on', ymdFromNow(-2)], ['to', String(userId('tech2'))]], { page: '/admin/tasks' });
  await owner.post('/admin/tasks', [['title', 'Home task later'], ['due_on', ymdFromNow(20)], ['to', String(userId('tech2'))]], { page: '/admin/tasks' });
  await owner.post('/admin/announcements', { title: 'Home order news', body: 'Read me.' }, { page: '/admin/announcements' });
  const t2 = await loggedIn('tech2');
  const home = await flat(t2);
  const tasksPanel = /<section class="panel p-tasks"[\s\S]*?<\/section>/.exec(home)[0];
  assert.match(tasksPanel, /<li class="overdue"><a href="\/tasks#t\d+"><strong>Home task late<\/strong><span class="todo-when">Overdue by 2 days[^<]* · from /);
  assert.ok(tasksPanel.indexOf('Home task late') < tasksPanel.indexOf('Home task later'));   // overdue first
  assert.match(/<section class="panel p-board"[\s\S]*?<\/section>/.exec(home)[0], /<span class="tag new">New<\/span><strong>Home order news[\s\S]*I have read this/);
  assert.match(/<section class="panel p-status"[\s\S]*?<\/section>/.exec(home)[0], /<a href="\/tasks" class="warn"><span class="mini-label">Tasks<\/span><span class="mini-num">2<\/span><span class="mini-sub">1 overdue/);
  const css = (await new Client().get('/styles.css')).text;
  assert.match(css, /\.dash \.p-tasks \{ order: 1; \} \.dash \.p-actions \{ order: 2; \} \.dash \.p-board \{ order: 3; \}/);
  assert.doesNotMatch(home, /class="panel branch-panel"/);                                   // nothing about the branch for a technician
  assert.doesNotMatch(home, /href="\/admin\//);

  // Nothing to do: no empty tasks box in the way of the buttons.
  makeUser('home1', 'Holly Home');
  assert.doesNotMatch(await flat(await loggedIn('home1')), /p-tasks/);

  // The owner: branch numbers on top, each a link to the list behind it.
  await t2.post('/parts', [['action', 'request'], ['part_name', 'HOME-PART'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-09-01']], { multipart: true });
  const reqId = lastParts().id;
  db.prepare('UPDATE parts_submissions SET needed_by = ? WHERE id = ?').run(ymdFromNow(-3), reqId);
  const oh = await flat(owner);
  const branch = /<section class="panel branch-panel"[\s\S]*?<\/section>/.exec(oh)[0];
  assert.match(branch, /Branch at a glance/);
  assert.ok(rising(order(oh, 'class="dash-hello"', 'class="panel branch-panel"', 'class="dash"')));
  const tile = (html, label) => { const m = new RegExp(`<a href="([^"]+)" class="([a-z]*)"><span class="mini-num">(\\d+)</span><span class="mini-label">${label}</span><span class="mini-sub">([^<]*)`).exec(html); return m ? { url: m[1], level: m[2], n: Number(m[3]), sub: m[4] } : null; };
  for (const label of ['Parts requests', 'Truck problems', 'Low stock', 'Overdue tasks', 'Certifications', 'Audit']) assert.ok(tile(branch, label), label);
  const reqs = tile(branch, 'Parts requests');
  assert.equal(reqs.url, '/admin/requests'); assert.equal(reqs.level, 'bad'); assert.ok(reqs.n >= 1); assert.match(reqs.sub, /\d+ past the needed-by date/);
  const late = tile(branch, 'Overdue tasks');
  assert.equal(late.url, '/admin/tasks?show=overdue'); assert.equal(late.n, 1); assert.equal(late.sub, '2 open in all');
  const audit = tile(branch, 'Audit');
  assert.match(audit.url, /^\/admin\/parts\/audit\?from=\d{4}-\d\d-\d\d&amp;to=\d{4}-\d\d-\d\d&amp;show=unchecked$/);
  assert.ok(audit.n >= 1);
  // The number on the tile is the number of entries the page behind it lists.
  const auditPage = (await owner.get(audit.url.replace(/&amp;/g, '&'))).text;
  assert.match(auditPage, /HOME-PART/);
  assert.equal(tile(branch, 'Truck problems').url, '/admin/inspections?show=open');
  assert.equal(tile(branch, 'Low stock').url, '/admin/stock?low=1');
  assert.equal(tile(branch, 'Low stock').n, stockLib.lowCount());

  // A manager sees their own people only: Terry Tech's request counts, Uma Tech's does not.
  const mh = await flat(await loggedIn('mgr1'));
  const team = /<section class="panel branch-panel"[\s\S]*?<\/section>/.exec(mh)[0];
  assert.match(team, /Your team at a glance/);
  const before = tile(team, 'Parts requests').n;
  const t1 = await loggedIn('tech1');
  await t1.post('/parts', [['action', 'request'], ['part_name', 'HOME-TEAM'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-09-01']], { multipart: true });
  const teamReq = lastParts().id;
  const after = /<section class="panel branch-panel"[\s\S]*?<\/section>/.exec(await flat(await loggedIn('mgr1')))[0];
  assert.equal(tile(after, 'Parts requests').n, before + 1);
  assert.equal(tile(after, 'Overdue tasks').n, 0);                                     // the owner's task for Uma is not theirs to chase
  // Only what the profile allows: the Warehouse profile has no tasks or certifications to manage.
  const wh = /<section class="panel branch-panel"[\s\S]*?<\/section>/.exec(await flat(await loggedIn('wh1')))[0];
  assert.ok(tile(wh, 'Parts requests')); assert.ok(tile(wh, 'Low stock'));
  assert.equal(tile(wh, 'Overdue tasks'), null); assert.equal(tile(wh, 'Certifications'), null);

  db.prepare('DELETE FROM parts_submissions WHERE id IN (?, ?)').run(reqId, teamReq);
  db.prepare('DELETE FROM tasks').run();
});

test('security: a changed password signs other devices out, guesses are limited per username, and alerts only go to real alert services', async () => {
  const authRoutes = require('../app/routes/auth');

  // Two devices signed in as the same person. Changing the password on one signs the other out.
  makeUser('sec1', 'Sally Secure');
  const phone = await loggedIn('sec1'); const laptop = await loggedIn('sec1');
  assert.equal((await laptop.get('/')).status, 200);
  assert.equal((await phone.post('/account/password', { current: 'correct horse battery', password: 'a brand new password', confirm: 'a brand new password' })).status, 302);
  assert.equal((await phone.get('/')).status, 200);                                    // the device that made the change stays in
  assert.equal((await laptop.get('/')).status, 302);                                   // the other is back at the sign-in page

  // An admin resetting the password, or disabling the account, signs the person out everywhere.
  const owner = await loggedIn('owner');
  await owner.post(`/admin/users/${userId('sec1')}/reset-password`, {}, { page: '/admin/users' });
  assert.equal((await phone.get('/')).status, 302);
  assert.equal((await owner.get('/')).status, 200);                                    // not the admin who did it
  makeUser('sec2', 'Dana Disabled');
  const dana = await loggedIn('sec2');
  await owner.post(`/admin/users/${userId('sec2')}/toggle-active`, {}, { page: '/admin/users' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE json_extract(data, '$.userId') = ?").get(userId('sec2')).n, 0);
  assert.equal((await dana.get('/')).status, 302);

  // Wrong passwords for one username are counted wherever they come from; after the limit even the right one waits.
  makeUser('sec3', 'Greta Guessed');
  authRoutes.clearLoginFailures();
  const perName = 10;
  let last;
  for (let i = 0; i < perName; i++) last = await new Client().post('/login', { username: 'SEC3 ', password: `wrong guess ${i}` }, { page: '/login' });
  assert.equal(last.status, 401);
  const blocked = await new Client().post('/login', { username: 'sec3', password: 'correct horse battery' }, { page: '/login' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Too many wrong passwords for this username/);
  assert.equal((await new Client().post('/login', { username: 'tech1', password: 'correct horse battery' }, { page: '/login' })).status, 302); // others are not affected
  authRoutes.clearLoginFailures();
  assert.equal((await new Client().post('/login', { username: 'sec3', password: 'correct horse battery' }, { page: '/login' })).status, 302);

  // A device can only register an address at Google's, Apple's, Mozilla's or Microsoft's alert service.
  const t1 = await loggedIn('tech1');
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  const page = '/settings/notifications';
  for (const bad of ['https://evil.example/hook', 'https://localhost/x', 'https://169.254.169.254/latest', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x']) {
    assert.equal((await t1.post('/push/subscribe', { endpoint: bad, ...keys }, { page })).status, 400, bad);
  }
  for (const good of ['https://fcm.googleapis.com/fcm/send/sec-a', 'https://web.push.apple.com/sec-b', 'https://updates.push.services.mozilla.com/wpush/v2/sec-c', 'https://wns2-by3p.notify.windows.com/w/?token=sec-d']) {
    assert.equal((await t1.post('/push/subscribe', { endpoint: good, ...keys }, { page })).status, 200, good);
  }
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE '%sec-_'").run();

  // A password-reset link never reaches the server log.
  const lines = []; const log = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { await new Client().get('/reset/' + 'ab'.repeat(32)); await new Promise((r) => setTimeout(r, 30)); } finally { console.log = log; }
  assert.ok(lines.some((l) => l.includes('/reset/…')));
  assert.ok(!lines.some((l) => l.includes('abab')));
});
