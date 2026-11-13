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
  assert.deepEqual(cols, ['active', 'category', 'created_at', 'description', 'id', 'manufacturer', 'part_number']);
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
  assert.match(html, /SIGA-CT2<\/td> <td>Dual input module, Class B<\/td> <td class="num">2<\/td>/); // catalog description
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
  assert.match((await admin.get(page)).text, /Ada Admin<br>/);

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
const navLinks = (html) => [...html.matchAll(/<a href="(\/admin\/[a-z/]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);

test('starting profiles: Technician, Warehouse, Manager and Admin each see only what they should', async () => {
  makeUser('wh1', 'Wanda Warehouse', { profile: 'Warehouse' });
  const tech = await loggedIn('tech1');
  const wh = await loggedIn('wh1');
  const owner = await loggedIn('owner');

  assert.deepEqual(navLinks((await tech.get('/')).text), []); // a technician has no admin menu at all
  assert.deepEqual(navLinks((await wh.get('/')).text), ['/admin/parts', '/admin/parts/audit', '/admin/catalog']);
  assert.deepEqual(navLinks((await owner.get('/')).text),
    ['/admin/parts', '/admin/parts/audit', '/admin/training', '/admin/catalog', '/admin/users', '/admin/profiles', '/admin/complaints']);

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
