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
  /** ua: the browser this client says it is. extra: a cookie the page itself would have set (see theme.js). */
  constructor(ua, extra) { this.cookie = ''; this.ua = ua || ''; this.extra = extra || ''; this.headers = {}; }
  async req(method, url, body) {
    const headers = { ...this.headers };
    const cookie = [this.cookie, this.extra].filter(Boolean).join('; ');
    if (cookie) headers.cookie = cookie;
    if (this.ua) headers['user-agent'] = this.ua;
    const res = await fetch(base + url, { method, body, redirect: 'manual', headers });
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
  // In these checks the Admin profile is the kind that runs the whole site, so it can see every branch.
  db.prepare("INSERT OR IGNORE INTO profile_permissions (profile_id, permission) SELECT id, 'branches.all' FROM profiles WHERE name = 'Admin'").run();
  // ...and so it holds backups, which only a profile that sees every office keeps.
  db.prepare("INSERT OR IGNORE INTO profile_permissions (profile_id, permission) SELECT id, 'backups' FROM profiles WHERE name = 'Admin'").run();
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
  // The hardest case for leaving no trace: a link to the form opened while signed out, then signing in to get to it.
  const tech = new Client();
  assert.equal((await tech.get('/complaint')).location, '/login?next=%2Fcomplaint');
  const signIn = await tech.post('/login', { username: 'tech1', password: 'correct horse battery', next: '/complaint' }, { page: '/login?next=%2Fcomplaint' });
  assert.equal(signIn.location, '/#complaint-form');                        // the home page, like any sign-in; the page itself moves on to the form
  assert.equal((await tech.get('/')).status, 200);
  assert.match((await new Client().get('/site.js')).text, /'#complaint-form': '\/complaint', '#complaint-status': '\/complaint\/status'/);
  const techId = db.prepare("SELECT id FROM users WHERE username = 'tech1'").get().id;
  // This person's session row, to the byte and the millisecond, before they go near a complaint page.
  const techSid = decodeURIComponent(/portal\.sid=([^;]+)/.exec(tech.cookie)[1]).slice(2).split('.')[0];
  const sessionRow = () => ({ ...db.prepare('SELECT sid, expires, data FROM sessions WHERE sid = ?').get(techSid) });
  const rowBefore = sessionRow();
  assert.equal(JSON.parse(rowBefore.data).userId, techId);
  await new Promise((r) => setTimeout(r, 15));                              // long enough for a rewritten time to show
  const r = await tech.post('/complaint', { category: 'safety', description: 'Ladder on truck 309 is cracked', occurred_text: 'Monday at the shop' }, { page: '/complaint' });
  assert.equal(r.status, 200);
  const code = /<p class="code" id="code">([A-Z0-9-]{14})<\/p>/.exec(r.text)[1];
  // Opening the form, sending it and checking on it with the code: the session row is exactly as it was. No last-seen
  // time, no new expiry, no page name. So neither the row nor any backup of it can show the visit, or when it was.
  assert.equal((await tech.post('/complaint/status', { code }, { page: '/complaint/status' })).status, 200);
  assert.deepEqual(sessionRow(), rowBefore);

  // The table has no column that could hold an identity or a time.
  const cols = db.prepare("SELECT name FROM pragma_table_info('complaints')").all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['branch_id', 'category', 'created_date', 'description', 'id', 'notified', 'occurred_text', 'reviewer_reply', 'status', 'tracking_code_hash']);
  const row = db.prepare('SELECT * FROM complaints').get();
  assert.match(row.created_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(row.id, /^[0-9a-f]{16}$/);
  assert.equal(row.notified, 1);                                            // the same on every complaint from the start: it never changes, so it says nothing

  // Nothing in the complaint row, the session table or the log gives the author away.
  const everything = JSON.stringify(row);
  assert.doesNotMatch(everything, /tech1|Terry/i);
  assert.ok(!everything.includes(code) && !everything.includes(code.replace(/-/g, '')));
  const sessions = db.prepare('SELECT data FROM sessions').all().map((s) => s.data).join('\n');
  assert.ok(!sessions.includes(code) && !sessions.includes(row.id) && !/Ladder/.test(sessions));
  assert.doesNotMatch(sessions, /complaint/i);                              // not even the page asked for before signing in
  assert.ok(!logLines.some((l) => /complaint|Ladder/i.test(l)), logLines.join('\n'));
  // What the page does in the background is left out of the log as well, so a request that is missing from the log is
  // nothing special. Ordinary pages are still there.
  assert.equal((await tech.get('/pulse')).status, 200); assert.equal((await tech.req('HEAD', '/alive')).status, 204);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!logLines.some((l) => /\/pulse|\/alive/.test(l)), logLines.join('\n'));
  assert.ok(['GET /login 200', 'POST /login 302', 'GET / 200'].every((l) => logLines.includes(l)), logLines.join('\n'));
  assert.equal(sent.length, 0); // no email at the moment of submission
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_submissions WHERE note LIKE ?').get('%Ladder%').n, 0);
  void techId;

  // It never shows up under "My activity".
  assert.doesNotMatch((await tech.get('/my')).text, /Ladder/);

  // The daily notice carries a count and a link only. It counts whole days, so a complaint is announced the day after it
  // was written: nothing is marked on the complaint, and the notice cannot show whether it came before or after that hour.
  assert.equal(await mail.runComplaintDigest(), 0);
  assert.equal(sent.length, 0);
  const nextDay = new Date(ymdFromNow(1) + 'T18:00:00Z');
  assert.equal(await mail.runComplaintDigest(nextDay), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'reviewer@example.com');
  assert.equal(sent[0].subject, 'A new complaint was submitted');
  assert.doesNotMatch(sent[0].text, /Ladder|Terry|tech1|safety/i);
  assert.equal(await mail.runComplaintDigest(nextDay), 0); // once a day
  assert.deepEqual({ ...db.prepare('SELECT * FROM complaints').get() }, { ...row });   // sending the notice changed nothing on the complaint

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
  assert.match((await tech.get('/my')).text, /Canceled/);
  assert.equal((await admin.get(`/parts/${c.id}/edit`)).status, 403);
  assert.match((await admin.get('/admin/parts?q=CANCEL-ME')).text, /Canceled/);
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
  assert.match((await tech.get('/my')).text, /Canceled/);
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

test('parts catalog: import keeps the cost and ignores a selling price, re-import updates, suggestions work', async () => {
  const admin = await loggedIn('admin');
  const page = '/admin/catalog';
  const csv = 'Category,Part Code,Description,Manufacturer,Cost/Price\r\nAlarm,SIGA-CT2,"Dual input module, Class B",Edwards,41.17\r\nAlarm,SIGA-UM,Universal module,Edwards,55.25\r\nAlarm,,No part number,,1\r\nBATTERY,BAT-12V7,12V 7Ah SLA battery,Duracell,9.99\r\n';
  const up = (text, name = 'sedona.csv') => admin.post('/admin/catalog/import', [['file', new File([text], name, { type: 'text/csv' })]], { multipart: true, page });
  assert.equal((await up(csv)).status, 302);
  assert.match((await admin.get(page)).text, /3 added, 0 updated, 0 unchanged, 1 rows skipped/);

  const cols = db.prepare("SELECT name FROM pragma_table_info('parts_catalog')").all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['active', 'category', 'cost_cents', 'count_at', 'count_qty', 'created_at', 'description', 'id', 'manufacturer', 'min_level', 'part_number', 'stocked']);
  assert.ok(!cols.some((c) => /price/i.test(c)));
  // The cost is kept, in cents. Only people who manage the catalog see it.
  const costOf = (pn) => db.prepare('SELECT cost_cents FROM parts_catalog WHERE part_number = ?').get(pn).cost_cents;
  assert.deepEqual([costOf('SIGA-CT2'), costOf('SIGA-UM')], [4117, 5525]);
  assert.match((await admin.get(page)).text, /<td class="num">\$41\.17<\/td>/);
  assert.equal(db.prepare("SELECT description FROM parts_catalog WHERE part_number = 'siga-ct2'").get().description, 'Dual input module, Class B');
  assert.equal(db.prepare("SELECT category FROM parts_catalog WHERE part_number = 'BAT-12V7'").get().category, 'BATTERY');

  await up('part number\tdescription\nSIGA-UM\tUniversal class A/B module\nNEW-1\tNew thing\n');
  assert.match((await admin.get(page)).text, /1 added, 1 updated/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM parts_catalog').get().n, 4); // nothing removed
  assert.equal(costOf('SIGA-UM'), 5525);                                    // a file with no cost column leaves the cost as it was
  // A selling price is not a cost and is not kept; a cost that is not money changes nothing; "$1,204.50" is read.
  await up('Part Number,Description,Sell Price,Unit Cost\nSIGA-UM,Universal class A/B module,99.99,n/a\nNEW-1,New thing,12.00,"$1,204.50"\n');
  assert.deepEqual([costOf('SIGA-UM'), costOf('NEW-1')], [5525, 120450]);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM parts_catalog').all()).includes('9999'));
  assert.equal((await admin.post(page, { part_number: 'COST-BAD', cost: 'twelve' }, { page })).status, 400);
  assert.equal((await admin.post(page, { part_number: 'COST-1', cost: '7.5' }, { page })).status, 302);
  assert.equal(costOf('COST-1'), 750);
  db.prepare("DELETE FROM parts_catalog WHERE part_number = 'COST-1'").run();

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
  const Database = require('better-sqlite3-multiple-ciphers');
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
  const Database = require('better-sqlite3-multiple-ciphers');
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
  assert.equal(r.adminPerms, r.all - 3);                          // everything except seeing every branch (the master's), a whole market, and backups (which hold every branch)
  assert.ok(!r.plain.includes('complaints.review') && !r.plain.includes('backups') && r.plain.includes('users.manage'));
  assert.ok(r.rev.includes('complaints.review') && !r.rev.includes('parts.view'));
  assert.deepEqual(r.profiles, ['Admin', 'Admin (no complaints)', 'Branch manager', 'Complaint reviewer', 'Corporate admin', 'Corporate manager', 'Manager', 'Market manager', 'Sales', 'Sales manager', 'Technician', 'Warehouse']);
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
  for (const color of ['#00b10b', '#005bb9', '#00314f']) assert.ok(css.includes(color), color);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/);
});

test('an admin can change a person\'s name, username and email after the account exists', async () => {
  const admin = await loggedIn('admin');
  const id = auth.createUser({ username: 'jamie.rivers', displayName: 'jamie.rivers', password: 'correct horse battery' });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
  const page = `/admin/users/${id}/edit`;
  assert.match((await admin.get('/admin/users')).text, new RegExp(`href="${page}"`));
  assert.match((await admin.get(page)).text, /value="jamie\.rivers"/);
  assert.equal((await admin.post(page, { username: 'jamie.rivers', display_name: 'Jamie Rivers', email: '' }, { page })).status, 302);
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get(id).display_name, 'Jamie Rivers');
  const user = await loggedIn('jamie.rivers'); // sign-in is unaffected
  assert.match((await user.get('/')).text, /Hi, Jamie<\/h1>[\s\S]*|Jamie Rivers<\/a>[\s\S]*Hi, Jamie<\/h1>/);

  assert.equal((await admin.post(page, { username: 'tech1', display_name: 'Jamie Rivers' }, { page })).status, 400); // taken
  assert.equal((await admin.post(page, { username: 'jamie.rivers', display_name: '' }, { page })).status, 400);
  assert.equal((await admin.post(page, { username: 'jamie.rivers', display_name: 'U', email: 'nope' }, { page })).status, 400);
  assert.equal((await admin.post(page, { username: 'jrivers', display_name: 'Jamie Rivers', email: 'u@example.com' }, { page })).status, 302);
  await loggedIn('jrivers');
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
  assert.deepEqual(navLinks((await wh.get('/')).text), ['/admin/requests', '/admin/inventory', '/admin/parts', '/admin/catalog', '/admin/inspections', '/admin/inspections/checklist']);
  assert.deepEqual(navLinks((await owner.get('/')).text),
    ['/admin/requests', '/admin/inventory', '/admin/parts', '/admin/catalog', '/admin/inspections', '/admin/inspections/checklist',
      '/admin/training', '/admin/training/sessions', '/admin/certs', '/admin/users', '/admin/tasks', '/admin/announcements', '/admin/newsletters', '/admin/complaints', '/admin/activity', '/admin/import', '/admin/branches', '/admin/markets', '/admin/profiles', '/admin/backups', '/admin/security']);

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
  // Every permission is a box, except the two that make up the level, which is one choice at the top.
  for (const key of access.ALL.filter((k) => !access.LEVEL_PERMS.includes(k))) assert.match(form, new RegExp(`name="perms" value="${key.replace('.', '\\.')}"`));
  for (const key of access.LEVEL_PERMS) assert.doesNotMatch(form, new RegExp(`name="perms" value="${key.replace('.', '\\.')}"`));
  assert.deepEqual([...form.matchAll(/<input type="radio" name="level" value="(\w+)" (checked)?/g)].map((x) => [x[1], Boolean(x[2])]), [['team', false], ['office', true], ['market', false], ['company', false]]);

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
const onHand = (pn) => stockLib.list(1).find((r) => r.part_number === pn).on_hand;
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
  // Taking the levels off a part does not take it off the shelf: it stays listed while the warehouse holds any, with no minimum.
  await wh.post(`${part}/stop`, {}, { page: part });
  const kept = stockLib.list(1).find((r) => r.part_number === 'STK-1');
  assert.ok(kept && kept.on_hand > 0); assert.deepEqual([kept.tracked, kept.min_level, kept.low], [0, null, false]);
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
  const lowTable = async () => (/<tbody>[\s\S]*?<\/tbody>/.exec((await wh.get('/admin/stock?low=1')).text) || [''])[0];   // the list itself, not the figures above it
  assert.doesNotMatch(await lowTable(), /LOW-1/);
  await takeParts(tech, [['LOW-1', 3]]);                   // 4 left: at the minimum
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'boss@example.com');
  assert.match(sent[0].subject, /Low stock: LOW-1/);
  assert.match(sent[0].text, /4 on hand \(minimum 4\)/);
  await takeParts(tech, [['LOW-1', 1]]);                   // already low: no second email
  assert.equal(sent.length, 1);
  const low = (await wh.get('/admin/stock?low=1')).text;
  assert.match(await lowTable(), /LOW-1/); assert.match(low, /at or below minimum/);
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
  await t.post('/account/email', { email: 'not-an-email', current: 'correct horse battery' });
  assert.equal(db.prepare("SELECT email FROM users WHERE username = 'tech2'").get().email, null);
  // The reset address cannot be changed from an open session alone: it takes the password.
  await t.post('/account/email', { email: 'thief@example.com' });
  await t.post('/account/email', { email: 'thief@example.com', current: 'not the password' });
  assert.equal(db.prepare("SELECT email FROM users WHERE username = 'tech2'").get().email, null);
  require('../app/routes/auth').clearLoginFailures();
  await t.post('/account/email', { email: 'uma@example.com', current: 'correct horse battery' });
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

  // (Sign-ins have their own entries, read only by people who look after every office: see the sign-in history test.)
  const log = db.prepare("SELECT a.action, a.detail, u.username FROM activity_log a JOIN users u ON u.id = a.user_id WHERE a.action <> 'Signed in' ORDER BY a.id").all();
  assert.deepEqual(log.map((r) => r.action), ['Person added', 'Person edited', 'Password reset', 'Account disabled', 'Profile changed', 'Stock count']);
  assert.ok(log.every((r) => r.username === 'owner'));
  assert.match(log[1].detail, /name Log Me → Logan Me, profile → Warehouse/);
  assert.match(log[4].detail, /now runs their own team \(was their office\); added: parts\.view; removed: training\.view/);
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
  assert.equal((await send([['truck', '309'], ['odometer', '84210'], ...answers(-1).slice(1)])).status, 400);             // one item unanswered
  assert.equal((await send([['truck', '309'], ['odometer', '84210'], ...answers(2)])).status, 400);                       // problem without saying what
  const five = Array.from({ length: 5 }, (_, i) => ['photos', new File([PNG], `p${i}.png`, { type: 'image/png' })]);
  assert.equal((await send([['truck', '309'], ['odometer', '84210'], ...answers(-1), ...five])).status, 400);             // too many photos
  assert.equal((await send([['truck', '309'], ['odometer', '84210'], ...answers(-1), ['photos', new File(['not an image'], 'x.png', { type: 'image/png' })]])).status, 400);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(count(), 0); assert.equal(files(), before);                                          // nothing kept from failed tries

  sent.length = 0;
  assert.equal((await send([['truck', '309'], ['odometer', '84210'], ...answers(-1)])).location, '/my?sent=inspection');
  assert.equal(sent.length, 0);                                                                     // all OK: no email
  const photo = (n) => ['photos', new File([PNG], `p${n}.png`, { type: 'image/png' })];
  await send([['truck', '309'], ['odometer', '84300'], ...answers(2, 'Pulls left under braking'), photo(1), photo(2), ['notes', 'Needs the shop']]);
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
  assert.match((await wh.get('/admin/inspections.csv?show=problems')).text, new RegExp(`Terry Tech,309,84300,${items[2].label},Problem,Pulls left under braking,`));

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
  await (await loggedIn('tech2')).post('/inspection', [['truck', '310'], ['odometer', '500'], ...db.prepare('SELECT id FROM inspection_items WHERE active = 1').all().map((it) => [`item_${it.id}`, 'ok'])], { multipart: true, page: '/inspection' });
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
  assert.deepEqual(groupsOf(owner), ['Community', 'Parts', 'Fleet', 'Training', 'Team', 'Setup', 'Corporate']);
  assert.deepEqual(barLinks(owner), ['/', '/tasks', '/social', '/oncall', '/sales']);   // the master account also sees the sales side
  // What used to be one long Admin list is two: Team (people and what goes out to them) and Setup (the site itself).
  const team = /<summary[^>]*>Team[\s\S]*?<\/details>/.exec(owner)[0];
  const setup = /<summary[^>]*>Setup[\s\S]*?<\/details>/.exec(owner)[0];
  const hrefs = (html) => [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs(team), ['/complaint', '/admin/users', '/admin/tasks', '/admin/announcements', '/admin/newsletters', '/admin/complaints']);
  assert.deepEqual(hrefs(setup), ['/poster', '/admin/activity', '/admin/import']);
  // The company level has its own group, only for people who can see every office.
  assert.deepEqual(hrefs(/<summary[^>]*>Corporate[\s\S]*?<\/details>/.exec(owner)[0]), ['/admin/branches', '/admin/markets', '/admin/profiles', '/admin/backups', '/admin/security']);
  assert.match(team, /<summary aria-current="true">Team/);                 // the group you are in is marked
  assert.match(team, /href="\/admin\/users" aria-current="page"/);
  assert.doesNotMatch(setup, /<summary aria-current/);
  // One name for each thing, wherever it appears.
  const ownerNav = /<nav class="nav"[\s\S]*?<\/nav>/.exec(owner)[0];
  for (const name of ['Announcements', 'My activity', 'Anonymous complaint', 'Parts requests', 'Truck inspection', 'Manage tasks', 'Post announcements', 'Certifications']) assert.match(ownerNav, new RegExp(`>${name}(<| <span)`), name);
  for (const old of ['Notices', 'My submissions', 'Assign tasks', '>Complaint<', '>Requests<', 'New inspection']) assert.ok(!ownerNav.includes(old), old);
  assert.doesNotMatch(owner, /id="menu-toggle"/);                          // the old phone Menu button is gone
  assert.match(owner, /class="nav-account">[\s\S]*Password and Face ID[\s\S]*Sign out/); // account links are in the menu for phones

  // A technician: no Team or Setup. Fleet holds the fleet list, the equipment sign-out and the truck inspection.
  const tech = (await (await loggedIn('tech1')).get('/')).text;
  assert.deepEqual(groupsOf(tech), ['Community', 'Fleet', 'Training']);
  assert.deepEqual([...(/<summary[^>]*>Fleet[\s\S]*?<\/details>/.exec(tech)[0]).matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ['/fleet', '/fleet/signout', '/inspection']);
  assert.match(tech, /<a href="\/parts" >Parts<\/a>/);                    // for a technician Parts is one plain link: the form
  assert.deepEqual(barLinks(tech), ['/', '/tasks', '/social', '/parts', '/oncall', '/complaint']); // one-item groups show as plain links
  assert.doesNotMatch(tech, /href="\/admin\//);
  assert.match(tech, /<a href="\/inspection"[^>]*>Truck inspection<\/a>/);
  assert.doesNotMatch(/<summary[^>]*>Community[\s\S]*?<\/details>/.exec(tech)[0], /<hr>\s*<hr>|<div class="menu-list">\s*<hr>|<hr>\s*<\/div>/); // no stray divider

  // A manager's Team group holds only what their profile allows, and they have no Setup group.
  const mgr = (await (await loggedIn('mgr1')).get('/')).text;
  assert.deepEqual(groupsOf(mgr), ['Community', 'Parts', 'Fleet', 'Training', 'Team']);           // Manage tasks and Post announcements
  assert.deepEqual(barLinks(mgr), ['/', '/tasks', '/social', '/oncall']);
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
  const stockBefore = JSON.stringify(stockLib.list(1).map((r) => [r.part_number, r.on_hand]));

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
  assert.equal(JSON.stringify(stockLib.list(1).map((r) => [r.part_number, r.on_hand])), stockBefore);
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
  // With no issue yet the home page says nothing about it, except to someone who can upload one.
  assert.doesNotMatch((await t1.get('/')).text, /Monthly Barker/);
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

  // A new issue gets its cover on the home page. Once it is a few weeks old it shrinks to one line with a Read button.
  const home = (await t1.get('/')).text;
  assert.match(home, /New issue[\s\S]*October Edition[\s\S]*Read this issue/); assert.doesNotMatch(home, /Past issues/);
  const postedAt = oct.created_at;
  db.prepare("UPDATE newsletters SET created_at = '2026-01-05T12:00:00.000Z' WHERE id = ?").run(oct.id);
  const later = (await t1.get('/')).text.replace(/\s+/g, ' ');
  assert.match(later, new RegExp(`<section class="panel slim p-news"[^>]*> <div class="one-line"><p><strong>The Monthly Barker</strong> <span class="meta">· October 2026 · <a href="/newsletters">all issues</a></span></p><a class="btn small" href="/newsletters/${oct.id}">Read</a>`));
  assert.doesNotMatch(later, /Read this issue|issue-cover/);
  db.prepare('UPDATE newsletters SET created_at = ? WHERE id = ?').run(postedAt, oct.id);
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
  const add = db.prepare('INSERT INTO training_sessions (title, request_id, session_date, session_time, location, created_by, created_at, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
  const ids = [add.run('NICET study group', null, soon, '16:00', 'Training room', userId('owner'), now).lastInsertRowid,
    add.run('One to one coaching', priv, soon, '09:00', null, userId('owner'), now).lastInsertRowid,
    add.run('Last year fire pump class', null, '2020-01-01', null, null, userId('owner'), now).lastInsertRowid];
  home = (await t2.get('/')).text;
  assert.match(home, /Coming up[\s\S]*NICET study group[\s\S]*at 4:00 PM · Training room/);
  assert.doesNotMatch(home, /One to one coaching|Last year fire pump class/);

  // My status counts this person's own open requests.
  const open = () => db.prepare("SELECT COUNT(*) n FROM parts_submissions WHERE user_id = ? AND action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered')").get(userId('tech2')).n;
  const before = open();
  assert.match(home, before ? new RegExp(`<span class="mini-num">${before}</span><span class="mini-label">My parts requests<`) : /Office at a glance/);
  await t2.post('/parts', [['action', 'request'], ['part_name', 'SIGA-PS'], ['quantity', '2'], ['source', 'van'], ['needed_by', '2027-03-01']], { page: '/parts', multipart: true });
  assert.equal(open(), before + 1);
  assert.match((await t2.get('/')).text, new RegExp(`<span class="mini-num">${before + 1}</span><span class="mini-label">My parts requests</span><span class="mini-sub">open request`));

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
  // The activity feed leads with the thing itself and puts who did what under it.
  assert.match(home, /id="around-h">Activity feed[\s\S]*<p class="feed-title"><a href="\/discussions\/t\/\d+"><strong>XR550 will not take a new zone<\/strong><\/a><\/p>\s*<p class="feed-text">[^<]* started a discussion<\/p>[\s\S]*1 reply/);
  assert.doesNotMatch(home, /Around the company/);
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
  assert.match(bell, /class="bell-task overdue is-new">.*?timesheet<\/strong> <span class="tag new">New<\/span><span class="bell-due">Overdue by 3 days \(was due \d+\/\d+\/\d{4}\)/);
  assert.match(bell, /Restock truck 309 batteries<\/strong> <span class="tag new">New<\/span><span class="bell-due">Due tomorrow</);
  assert.match(bell, /Annual fit test<\/strong> <span class="tag new">New<\/span><span class="bell-due">Due \d+\/\d+\/\d{4}</);
  assert.match(bell, /Read the new ladder policy<\/strong> <span class="tag new">New<\/span><span class="bell-due">No due date</);
  assert.match(home, /href="\/tasks"[^>]*>Tasks <span class="badge"[^>]*>4<\/span>/);
  assert.equal(total((await (await loggedIn('task2')).get('/')).text) >= 1, true);
  assert.doesNotMatch(bellOf((await (await loggedIn('task2')).get('/')).text), /timesheet/);                    // only your own

  // Tasks page, and ticking one off with a note.
  const mine = (await tess.get('/tasks')).text;
  assert.match(mine, /Ten 12V 7Ah\./); assert.match(mine, /From Olive Owner/); assert.match(mine, /class="tag overdue">Overdue</);
  const tid = db.prepare("SELECT id FROM tasks WHERE title LIKE 'Send in%'").get().id;
  await tess.post(`/tasks/${tid}/done`, { done_note: 'Emailed it Monday' }, { page: '/tasks' });
  // A task counts as new on the bell until that one task is opened. Looking at the Tasks page is not enough:
  // new tasks are folded shut there. Opening one tells the site, and only that one stops counting.
  assert.match(mine, /<details class="task-fold" data-task="\d+" >[\s\S]*?<span class="tag new">New<\/span>\s*<span class="tag st-new">Not started[\s\S]*?Tap to open this task\./);
  assert.equal(total(mine), before + 4);                                         // looking at the page opened none of them
  const restock = db.prepare("SELECT id FROM tasks WHERE title = 'Restock truck 309 batteries' AND assigned_to = ?").get(userId('task1')).id;
  const opened = await tess.post(`/tasks/${restock}/seen`, {}, { page: '/tasks' });
  assert.equal(opened.status, 200); assert.equal(total(opened.text), before + 2);   // the answer carries the fresh counts
  assert.equal((await (await loggedIn('task2')).post(`/tasks/${restock}/seen`, {}, { page: '/tasks' })).status, 403);
  const after = (await tess.get('/')).text;
  assert.equal(total(after), before + 2);
  assert.match(bellOf(after), /class="bell-task\s+seen">.*?Restock truck 309 batteries<\/strong><span class="bell-due">/);
  assert.match(bellOf(after), /Annual fit test<\/strong> <span class="tag new">New<\/span>/);
  assert.match(after, /href="\/tasks"[^>]*>Tasks <span class="badge"[^>]*>3<\/span>/);
  const again = (await tess.get('/tasks')).text;
  assert.match(again, new RegExp(`<details class="task-fold" data-task="${restock}" >`));   // every task starts folded shut, so the list is easy to scan
  assert.doesNotMatch(again, /<details class="task-fold"[^>]* open>/);
  for (const row of db.prepare('SELECT id FROM tasks WHERE assigned_to = ? AND done_at IS NULL').all(userId('task1'))) await tess.post(`/tasks/${row.id}/seen`, {}, { page: '/tasks' });
  assert.equal(total((await tess.get('/')).text), before);
  assert.doesNotMatch(bellOf(after), /timesheet/);
  assert.match((await owner.get(page + '?show=done')).text.replace(/\s+/g, ' '), /timesheet.*Note: Emailed it Monday.*Finished/);
  await tess.post(`/tasks/${tid}/done`, {}, { page: '/tasks' });                                                // changed her mind
  assert.equal(db.prepare('SELECT done_at FROM tasks WHERE id = ?').get(tid).done_at, null);
  // A note from the manager makes a seen task new again, so it counts on the bell once more.
  const fitNow = db.prepare("SELECT id FROM tasks WHERE title = 'Annual fit test' AND assigned_to = ?").get(userId('task1')).id;
  for (const row of db.prepare('SELECT id FROM tasks WHERE assigned_to = ? AND done_at IS NULL').all(userId('task1'))) await tess.post(`/tasks/${row.id}/seen`, {}, { page: '/tasks' });
  const quiet = total((await tess.get('/')).text);
  await owner.post(`/admin/tasks/${fitNow}/note`, { note: 'Bring your own mask' }, { page: `/admin/tasks/${fitNow}` });
  assert.equal(total((await tess.get('/')).text), quiet + 1);
  await tess.post(`/tasks/${fitNow}/seen`, {}, { page: '/tasks' });
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
  assert.match(bellOf((await (await loggedIn('tech1')).get('/')).text), /Clean out the van<\/strong> <span class="tag new">New<\/span><span class="bell-due">Due today</);
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
  await petra.post('/inspection', [['truck', '311'], ['odometer', '900'], ...items.map((it, i) => (i === 0 ? [`item_${it.id}`, 'problem'] : [`item_${it.id}`, 'ok'])), [`note_${items[0].id}`, 'Flat tire']], { multipart: true, page: '/inspection' });
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

test('phone bottom bar: Home, Social, Parts, Tasks and More; alerts are the bell at the top, with its list as a page of its own', async () => {
  const barOf = (html) => { const m = /<nav class="tabbar[\s\S]*?<\/nav>/.exec(html); return m ? m[0] : null; };
  const tabs = (html) => [...barOf(html).matchAll(/<a href="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)<span>([^<]+)<\/span>/g)].map((m) => `${m[2]} ${m[1]}`);

  // Signed out there is no bar.
  assert.equal(barOf((await new Client().get('/login')).text), null);

  makeUser('bar1', 'Barry Bar');
  const c = await loggedIn('bar1');
  let home = (await c.get('/')).text;
  assert.deepEqual(tabs(home), ['Home /', 'Social /social', 'Parts /parts', 'Tasks /tasks', 'More #navbar']);
  assert.match(barOf(home), /<a href="\/" aria-current="page"/);                       // the tab you are on is marked
  assert.match(barOf((await c.get('/parts')).text), /<a href="\/parts" aria-current="page"/);
  assert.match(home, /<body class="has-tabbar">/);
  assert.match(home, /viewport-fit=cover/);

  // Tasks and everything else are counted separately on the bar.
  const count = (html, label) => { const m = new RegExp(`<span>${label}</span><b class="tab-count">(\\d+)`).exec(barOf(html)); return m ? Number(m[1]) : 0; };
  // Alerts are the bell in the top right corner, on a phone as on a computer: its red number counts what is waiting.
  const bellCount = (html) => { const m = /<details class="bell"[\s\S]*?<span class="bell-count"[^>]*>(\d+)/.exec(html); return m ? Number(m[1]) : 0; };
  const alertsBefore = bellCount(home);
  assert.match(home, /<details class="bell" id="bell">/); assert.doesNotMatch(barOf(home), /\/alerts/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8'), /\.has-tabbar \.bell \{ display: none/);   // no longer hidden on a phone
  assert.equal(count(home, 'Tasks'), 0);
  const owner = await loggedIn('owner');
  await owner.post('/admin/tasks', [['title', 'Bar task'], ['due_on', ymdFromNow(-1)], ['to', String(userId('bar1'))]], { page: '/admin/tasks' });
  await owner.post('/admin/announcements', { title: 'Bar announcement', body: 'Read me.' }, { page: '/admin/announcements' });
  home = (await c.get('/')).text;
  assert.equal(count(home, 'Tasks'), 1);
  assert.ok(bellCount(home) > alertsBefore);

  // The Alerts page holds the same list as the bell.
  const alerts = (await c.get('/alerts')).text;
  assert.match(alerts, /<h1>Alerts<\/h1>/);
  assert.match(alerts, /class="card alert-items alert-page">[\s\S]*Your tasks[\s\S]*Bar task[\s\S]*Overdue by 1 day[\s\S]*unread announcements?[\s\S]*Notification settings/);
  assert.equal((await new Client().get('/alerts')).status, 302);                      // signed in only

  // Someone who cannot send parts entries but can read the log gets the log; with neither, no Parts tab.
  const pid = db.prepare("INSERT INTO profiles (name, scope, created_at) VALUES ('Bar reader', 'all', ?)").run(new Date().toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO profile_permissions (profile_id, permission) VALUES (?, 'parts.view')").run(pid);
  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(pid, userId('bar1'));
  assert.deepEqual(tabs((await c.get('/')).text).slice(0, 3), ['Home /', 'Social /social', 'Parts /admin/parts']);
  db.prepare('DELETE FROM profile_permissions WHERE profile_id = ?').run(pid);
  assert.deepEqual(tabs((await c.get('/')).text), ['Home /', 'Social /social', 'Tasks /tasks', 'More #navbar']);

  // The sheet behind More, and Back closing it, are in the script.
  const js = (await new Client().get('/site.js')).text;
  assert.match(js, /more-toggle/); assert.match(js, /menuSheet/);
  db.prepare('DELETE FROM tasks').run();
});

test('home page: announcements, newsletter and shout-outs first; office at a glance fits the person looking', async () => {
  const flat = async (c) => (await c.get('/')).text.replace(/\s+/g, ' ');
  const order = (html, ...marks) => marks.map((m) => html.indexOf(m));
  const rising = (list) => list.every((n, i) => n >= 0 && (i === 0 || n > list[i - 1]));

  // A technician: announcements, the newsletter and shout-outs lead, then the office at a glance, their tasks and the buttons.
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
  assert.doesNotMatch(home, /p-status|My status/);   // a person's own numbers now sit inside Office at a glance
  const css = (await new Client().get('/styles.css')).text;
  assert.match(css, /\.dash \.p-board \{ order: 1; \} \.dash \.p-news \{ order: 2; \} \.dash \.p-shouts \{ order: 3; \} \.dash \.p-around \{ order: 4; \} \.dash \.p-up \{ order: 5; \} \.dash \.p-tasks \{ order: 6; \}/);
  assert.deepEqual(order(home, 'class="dash-hello', 'class="panel p-board"', 'p-shouts"', 'class="panel p-around"', 'class="panel p-tasks"', 'class="panel branch-panel', 'id="act-h"').map((n, i, l) => n >= 0 && (i === 0 || n > l[i - 1])), [true, true, true, true, true, true, true]);
  // Office at a glance for someone who runs nothing: facts about the office, and none of the parts, stock or truck numbers.
  const tGlance = /<section class="panel branch-panel[\s\S]*?<\/section>/.exec(home)[0];
  assert.match(tGlance, /<span class="mini-num">\d+<\/span><span class="mini-label">People<\/span><span class="mini-sub">in the Lancaster office/);
  assert.match(tGlance, /class="warn"><span class="mini-num">\d+<\/span><span class="mini-label">Announcements<\/span><span class="mini-sub">for you to read/);
  assert.match(tGlance, /This week<\/span>/); assert.match(tGlance, /Coming up<\/span>/); assert.match(tGlance, /href="\/branches\/1">Office page/);
  assert.doesNotMatch(tGlance, /Parts requests|Low stock|Truck problems|Overdue tasks|Certifications|Audit/);
  assert.doesNotMatch(home, /href="\/admin\//);

  // Nothing to do: no empty tasks box in the way of the buttons.
  makeUser('home1', 'Holly Home');
  assert.doesNotMatch(await flat(await loggedIn('home1')), /p-tasks/);

  // The owner: the same facts, plus whatever is waiting on them, each a link to the list behind it. Numbers that are zero are left out.
  await t2.post('/parts', [['action', 'request'], ['part_name', 'HOME-PART'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-09-01']], { multipart: true });
  const reqId = lastParts().id;
  db.prepare('UPDATE parts_submissions SET needed_by = ? WHERE id = ?').run(ymdFromNow(-3), reqId);
  const oh = await flat(owner);
  const branch = /<section class="panel branch-panel[\s\S]*?<\/section>/.exec(oh)[0];
  assert.match(branch, /Office at a glance/);
  assert.match(branch, /People<\/span>/);
  const tile = (html, label) => { const m = new RegExp(`<a href="([^"]+)" class="([a-z]*)"><span class="mini-num">(\\d+)</span><span class="mini-label">${label}</span><span class="mini-sub">([^<]*)`).exec(html); return m ? { url: m[1], level: m[2], n: Number(m[3]), sub: m[4] } : null; };
  for (const label of ['Parts requests', 'Overdue tasks', 'Audit']) assert.ok(tile(branch, label), label);
  for (const label of ['Truck problems', 'Low stock', 'Certifications']) { const t = tile(branch, label); assert.ok(t === null || t.n > 0, label); }   // shown only when there is something waiting
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
  assert.equal((tile(branch, 'Low stock') || { n: 0 }).n, stockLib.lowCount(1));
  // A profile that can manage parts but has nothing waiting sees no parts boxes at all (the case that looked wrong).
  const quietProfile = access.ensureProfile('Quiet parts', 'team', ['training.submit', 'forum.use', 'parts.view', 'parts.manage', 'stock.manage']);
  makeUser('home2', 'Zed Zeroparts'); db.prepare('UPDATE users SET profile_id = ? WHERE username = ?').run(quietProfile, 'home2');
  const quiet = /<section class="panel branch-panel[\s\S]*?<\/section>/.exec(await flat(await loggedIn('home2')))[0];
  assert.doesNotMatch(quiet, /Parts requests/); assert.equal(/Low stock/.test(quiet), stockLib.lowCount(1) > 0); assert.match(quiet, /People<\/span>/);   // nothing open for their people: no box

  // A manager sees their own people only: Terry Tech's request counts, Uma Tech's does not.
  const mh = await flat(await loggedIn('mgr1'));
  const team = /<section class="panel branch-panel[\s\S]*?<\/section>/.exec(mh)[0];
  assert.match(team, /Office at a glance/);
  const before = (tile(team, 'Parts requests') || { n: 0 }).n;
  const t1 = await loggedIn('tech1');
  await t1.post('/parts', [['action', 'request'], ['part_name', 'HOME-TEAM'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-09-01']], { multipart: true });
  const teamReq = lastParts().id;
  const after = /<section class="panel branch-panel[\s\S]*?<\/section>/.exec(await flat(await loggedIn('mgr1')))[0];
  assert.equal(tile(after, 'Parts requests').n, before + 1);
  assert.equal(tile(after, 'Overdue tasks'), null);                                   // the owner's task for Uma is not theirs to chase
  // Only what the profile allows: the Warehouse profile has no tasks or certifications to manage.
  const wh = /<section class="panel branch-panel[\s\S]*?<\/section>/.exec(await flat(await loggedIn('wh1')))[0];
  assert.ok(tile(wh, 'Parts requests')); assert.equal(Boolean(tile(wh, 'Low stock')), stockLib.lowCount(1) > 0);
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

// ---- The lock, and Face ID / fingerprint sign-in --------------------------------
// A software stand-in for a phone's fingerprint sensor: it makes a key pair for the site and
// signs the site's challenge, exactly as a real device does.
const nodeCrypto = require('crypto');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function cbor(v) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
class FakeDevice {
  constructor(origin) {
    this.origin = origin; this.rpHash = nodeCrypto.createHash('sha256').update(new URL(origin).hostname).digest();
    this.keys = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); this.id = nodeCrypto.randomBytes(20); this.counter = 0;
  }
  client(type, challenge, origin = this.origin) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })); }
  create(options) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([this.rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.id, cose]);
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(this.client('webauthn.create', options.challenge)), attestationObject: b64u(attestationObject), transports: ['internal'] } };
  }
  get(options, { origin, verified = true } = {}) {
    const count = Buffer.alloc(4); count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([this.rpHash, Buffer.from([verified ? 0x05 : 0x01]), count]);
    const clientData = this.client('webauthn.get', options.challenge, origin);
    const signature = nodeCrypto.sign('sha256', Buffer.concat([authData, nodeCrypto.createHash('sha256').update(clientData).digest()]), this.keys.privateKey);
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) } };
  }
}
async function sendJson(client, url, data = {}, page = '/account/password') {
  const _csrf = await client.csrf(page);
  const res = await fetch(base + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: client.cookie }, body: JSON.stringify({ _csrf, ...data }) });
  const set = res.headers.getSetCookie();
  if (set.length) client.cookie = set.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('the lock: closing the site or leaving it idle asks for Face ID, fingerprint or the password again', async () => {
  makeUser('lock1', 'Lena Lock');
  const c = await loggedIn('lock1');
  const sid = () => db.prepare("SELECT sid FROM sessions WHERE json_extract(data, '$.userId') = ? ORDER BY expires DESC").get(userId('lock1')).sid;
  const home = (await c.get('/')).text;
  assert.match(home, /<html lang="en" data-in data-lock-after="600000" data-fresh>/);    // just signed in: the page marks this tab as open (10 minutes: not plainly a desk computer)
  assert.doesNotMatch((await c.get('/')).text, /data-fresh/);                             // once only

  // The page reports that the site was closed and reopened. Everything is shut until they unlock.
  assert.equal((await c.post('/lock', {}, { page: '/' })).status, 204);
  for (const url of ['/', '/my', '/parts', '/tasks', '/alerts', '/account/password', '/settings/notifications']) {
    const r = await c.get(url);
    assert.equal(r.status, 302, url); assert.equal(r.location, '/unlock?next=' + encodeURIComponent(url), url);
  }
  const screen = (await c.get('/unlock?next=%2Fmy')).text;
  assert.match(screen, /Welcome back, Lena/); assert.match(screen, /name="next" value="\/my"/);
  assert.doesNotMatch(screen, /class="tabbar|<nav class="nav"|class="bell"|data-in/);     // no menu, no counts, nothing of the site
  assert.doesNotMatch(screen, /passkey-unlock/);                                           // no Face ID button until it is set up
  // Sending a form while locked does nothing but bring up the lock screen.
  const before = db.prepare('SELECT COUNT(*) n FROM training_requests').get().n;
  const blocked = await c.post('/training', { description: 'Sneaked in while locked', wants_contact: 'no', is_private: 'no' }, { page: '/unlock' });
  assert.equal(blocked.location, '/unlock');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_requests').get().n, before);
  assert.equal((await sendJson(c, '/passkey/register/options', {}, '/unlock')).status, 302);   // cannot add a device from a locked session

  // A wrong password keeps it shut; the right one opens it where they were going. Off-site addresses are ignored.
  const wrong = await c.post('/unlock', { password: 'not it', next: '/my' }, { page: '/unlock' });
  assert.equal(wrong.status, 401); assert.match(wrong.text, /That password is not right/);
  assert.equal((await c.post('/unlock', { password: 'correct horse battery', next: '//evil.example' }, { page: '/unlock' })).location, '/');
  assert.equal((await c.get('/my')).status, 200);
  assert.equal((await c.get('/unlock?next=%2Ftasks')).location, '/tasks');               // not locked: straight through

  // Left unused for longer than the limit: locked by the server, whatever the page does.
  db.prepare("UPDATE sessions SET data = json_set(data, '$.seenAt', ?) WHERE sid = ?").run(Date.now() - 11 * 60 * 1000, sid());
  assert.equal((await c.get('/my')).location, '/unlock?next=%2Fmy');
  assert.doesNotMatch((await c.get('/unlock')).text, /\d+ minutes/);                                // the lock screen does not announce the time
  await c.post('/unlock', { password: 'correct horse battery' }, { page: '/unlock' });
  db.prepare("UPDATE sessions SET data = json_set(data, '$.seenAt', ?) WHERE sid = ?").run(Date.now() - 9 * 60 * 1000, sid());
  assert.equal((await c.get('/my')).status, 200);                                         // within the limit: still open

  // Signing out works from the lock screen, and wrong unlock passwords count toward the username's limit.
  await c.post('/lock', {}, { page: '/' });
  require('../app/routes/auth').clearLoginFailures();
  for (let i = 0; i < 10; i++) await c.post('/unlock', { password: `guess ${i}` }, { page: '/unlock' });
  assert.equal((await c.post('/unlock', { password: 'correct horse battery' }, { page: '/unlock' })).status, 429);
  require('../app/routes/auth').clearLoginFailures();
  assert.equal((await c.post('/logout', {}, { page: '/unlock' })).location, '/login');
  assert.equal((await new Client().get('/unlock')).location, '/login');
  const js = (await new Client().get('/site.js')).text; const early = (await new Client().get('/theme.js')).text;
  assert.match(early, /sessionStorage/); assert.match(js, /portal-open/); assert.match(js, /\/lock/);
});

test('Face ID / fingerprint: set up on a device, used to unlock and to sign in, and only by its owner', async () => {
  makeUser('face1', 'Fiona Face'); makeUser('face2', 'Otto Other');
  const c = await loggedIn('face1');
  const phone = new FakeDevice(base);
  const count = (u) => db.prepare('SELECT COUNT(*) n FROM passkeys WHERE user_id = ?').get(userId(u)).n;

  // Setting up: the site hands out a one-time challenge and stores only the device's public key.
  // A new person is first offered it in the welcome checklist; once that is put away, the home page keeps offering it.
  assert.match((await c.get('/')).text, /data-step="passkey"><span class="tick"[^>]*>✓<\/span><a href="\/account\/password#face-id">/);
  await c.post('/welcome/done', {}, { page: '/' });
  assert.match((await c.get('/')).text, /id="passkey-tip"/);                              // offered on the home page until it is set up
  const page = (await c.get('/account/password')).text;
  assert.match(page, /Face ID or fingerprint/); assert.match(page, /id="passkey-add"/);
  let opts = (await sendJson(c, '/passkey/register/options')).body.options;
  assert.equal(opts.authenticatorSelection.userVerification, 'required'); assert.equal(opts.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(opts.rp.id, '127.0.0.1');
  const made = phone.create(opts);
  const saved = await sendJson(c, '/passkey/register/verify', { response: made, device: 'Fiona iPhone (Safari)' });
  assert.deepEqual(saved, { status: 200, body: { ok: true } });
  assert.equal(count('face1'), 1);
  assert.equal((await sendJson(c, '/passkey/register/verify', { response: made, device: 'again' })).status, 400);   // a challenge works once
  assert.match((await c.get('/account/password')).text, /<strong>Fiona iPhone \(Safari\)<\/strong><span class="meta">Set up [^<]* · not used yet/);
  assert.doesNotMatch((await c.get('/')).text, /id="passkey-tip"/);
  assert.match(db.prepare("SELECT detail FROM activity_log WHERE action LIKE 'Face ID%set up' ORDER BY id DESC").get().detail, /Fiona iPhone/);

  // Unlocking with it.
  await c.post('/lock', {}, { page: '/' });
  assert.match((await c.get('/unlock')).text, /id="passkey-unlock"[^>]*data-user="\d+"/);
  opts = (await sendJson(c, '/passkey/auth/options', {}, '/unlock')).body.options;
  assert.equal(opts.allowCredentials.length, 1); assert.equal(opts.userVerification, 'required');
  // Things that must not open it: a page on another address, a device that did not check the face, a made-up signature, a reused answer.
  assert.equal((await sendJson(c, '/passkey/auth/verify', { response: phone.get(opts, { origin: 'https://evil.example' }) }, '/unlock')).status, 401);
  opts = (await sendJson(c, '/passkey/auth/options', {}, '/unlock')).body.options;
  assert.equal((await sendJson(c, '/passkey/auth/verify', { response: phone.get(opts, { verified: false }) }, '/unlock')).status, 401);
  opts = (await sendJson(c, '/passkey/auth/options', {}, '/unlock')).body.options;
  const forged = phone.get(opts); forged.response.signature = b64u(nodeCrypto.randomBytes(70));
  assert.equal((await sendJson(c, '/passkey/auth/verify', { response: forged }, '/unlock')).status, 401);
  assert.equal((await c.get('/my')).location, '/unlock?next=%2Fmy');                      // still locked after all that
  opts = (await sendJson(c, '/passkey/auth/options', {}, '/unlock')).body.options;
  const answer = phone.get(opts);
  assert.deepEqual(await sendJson(c, '/passkey/auth/verify', { response: answer, next: '/my' }, '/unlock'), { status: 200, body: { ok: true, next: '/my' } });
  assert.equal((await c.get('/my')).status, 200);
  await c.post('/lock', {}, { page: '/' });
  assert.equal((await sendJson(c, '/passkey/auth/verify', { response: answer }, '/unlock')).status, 400);          // the same answer again: no
  assert.equal((await c.get('/my')).status, 302);

  // Someone else's locked session cannot be opened with Fiona's phone.
  const otto = await loggedIn('face2');
  await otto.post('/lock', {}, { page: '/' });
  assert.equal((await sendJson(otto, '/passkey/auth/options', {}, '/unlock')).status, 400);                         // Otto has none set up
  await otto.post('/logout', {}, { page: '/unlock' });

  // Signing in from scratch with the device alone, on the sign-in page.
  const fresh = new Client();
  assert.match((await fresh.get('/login')).text, /id="passkey-login"/);
  opts = (await sendJson(fresh, '/passkey/auth/options', {}, '/login')).body.options;
  assert.equal((opts.allowCredentials || []).length, 0);                                  // the device says who it is; no usernames are given away
  assert.deepEqual((await sendJson(fresh, '/passkey/auth/verify', { response: phone.get(opts), next: '/tasks' }, '/login')).body, { ok: true, next: '/tasks' });
  assert.match((await fresh.get('/')).text, /Hi, Fiona<\/h1>/);
  assert.ok(db.prepare('SELECT last_used_at FROM passkeys WHERE user_id = ?').get(userId('face1')).last_used_at);

  // A disabled account cannot use it; an unknown device is refused.
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId('face1'));
  const off = new Client(); opts = (await sendJson(off, '/passkey/auth/options', {}, '/login')).body.options;
  assert.equal((await sendJson(off, '/passkey/auth/verify', { response: phone.get(opts) }, '/login')).status, 401);
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(userId('face1'));
  const stranger = new FakeDevice(base); opts = (await sendJson(off, '/passkey/auth/options', {}, '/login')).body.options;
  assert.equal((await sendJson(off, '/passkey/auth/verify', { response: stranger.get(opts) }, '/login')).status, 401);
  assert.equal((await off.get('/')).status, 302);

  // Only the owner can remove a device; an admin resetting the password removes them all (the lost-phone case).
  const pid = db.prepare('SELECT id FROM passkeys WHERE user_id = ?').get(userId('face1')).id;
  const o2 = await loggedIn('face2');
  await o2.post(`/passkey/${pid}/delete`, {}, { page: '/account/password' });
  assert.equal(count('face1'), 1);
  const owner = await loggedIn('owner');
  await owner.post(`/admin/users/${userId('face1')}/reset-password`, {}, { page: '/admin/users' });
  assert.equal(count('face1'), 0);
  assert.equal((await fresh.get('/')).status, 302);                                       // and Fiona is signed out everywhere
});

// ---- Community: profiles, welcoming new people, the daily question ---------------

test('profiles: people fill in their own, others find them by name, job or skill, and contact details show only if chosen', async () => {
  makeUser('prof1', 'Penny Profile'); makeUser('prof2', 'Quinn Quiet');
  db.prepare("UPDATE users SET email = 'penny@example.com' WHERE username = 'prof1'").run();
  const penny = await loggedIn('prof1'); const quinn = await loggedIn('prof2');
  const pid = userId('prof1');

  // An empty profile is nudged on the home page and says so plainly on its own page.
  await penny.post('/welcome/done', {}, { page: '/' });                                     // the welcome checklist comes first for a new person
  assert.match((await penny.get('/')).text, /id="profile-tip"/);
  assert.match((await penny.get(`/people/${pid}`)).text, /Your profile is empty/);
  assert.match((await quinn.get(`/people/${pid}`)).text, /Penny has not filled in a profile yet/);

  const save = (fields, file) => penny.post('/profile', [...Object.entries(fields), ...(file ? [['photo', file]] : [])], { multipart: true, page: '/profile' });
  // Bad input is refused with the reason.
  assert.match((await save({ started_on: '2999-01-01' })).text, /start date does not look right/);
  assert.match((await save({ phone: 'call me maybe' })).text, /phone number does not look right/);
  assert.match((await save({}, new File(['not an image'], 'me.png', { type: 'image/png' }))).text, /must be a JPEG, PNG, WebP or GIF/);
  assert.equal((await new Client().get('/profile')).status, 302);

  const ok = await save({ job_title: 'Sprinkler Fitter', started_on: '2020-02-03', about: 'From Lititz.\n<b>Likes</b> fishing.', skills: 'Viking, backflow , Viking\nfire pumps', phone: '(717) 555-0100' }, new File([PNG], 'me.png', { type: 'image/png' }));
  assert.equal(ok.location, `/people/${pid}`);
  assert.equal(db.prepare('SELECT job_title FROM users WHERE id = ?').get(pid).job_title, null);   // a job title is given by a manager, not typed by the person
  db.prepare("UPDATE users SET job_title = 'Sprinkler Fitter' WHERE id = ?").run(pid);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(pid);
  assert.equal(row.skills, 'Viking, backflow, fire pumps');                              // tidied, repeats dropped
  assert.match(row.photo_path, /^[0-9a-f]{32}\.png$/);
  const page = (await quinn.get(`/people/${pid}`)).text;
  assert.match(page, /Sprinkler Fitter · <a href="\/branches\/\d+">Lancaster office<\/a>/); assert.match(page, /\d+ years with us · started 2\/3\/2020/);
  assert.match(page, /From Lititz\.\n&lt;b&gt;Likes&lt;\/b&gt; fishing\./);                 // typed text is shown as text, never run as code
  assert.match(page, /<a class="skill" href="\/people\?q=backflow">backflow<\/a>/);
  assert.match(page, new RegExp(`src="/people/photo/${pid}\\?v=`));
  assert.doesNotMatch(page, /555-0100|penny@example\.com/);                               // contact details are off until ticked
  assert.equal((await quinn.get(`/people/photo/${pid}`)).headers.get('content-type'), 'image/png');
  assert.equal((await new Client().get(`/people/photo/${pid}`)).status, 302);            // signed in only
  assert.doesNotMatch((await penny.get('/')).text, /id="profile-tip"/);

  await save({ job_title: 'Sprinkler Fitter', skills: row.skills, phone: '(717) 555-0100', show_phone: '1', show_email: '1' });
  const shown = (await quinn.get(`/people/${pid}`)).text;
  assert.match(shown, /href="tel:7175550100">\(717\) 555-0100/); assert.match(shown, /href="mailto:penny@example\.com"/);
  assert.equal(db.prepare('SELECT photo_path FROM users WHERE id = ?').get(pid).photo_path, row.photo_path);   // saving without a new photo keeps the old one

  // Certifications on file show by name only.
  db.prepare("INSERT INTO certifications (user_id, name, expires_on, created_at) VALUES (?, 'NICET Water-Based II', '2020-01-01', ?)").run(pid, new Date().toISOString());
  const withCert = (await quinn.get(`/people/${pid}`)).text;
  assert.match(withCert, /<li>NICET Water-Based II<\/li>/); assert.doesNotMatch(withCert, /1\/1\/2020|expired/i);

  // The directory: everyone active, searchable by name, job and skill.
  const all = (await quinn.get('/people')).text;
  assert.match(all, /Penny Profile/); assert.match(all, /Quinn Quiet/); assert.match(all, /<span class="skill">Viking<\/span>/);
  const hits = async (q) => [...(await quinn.get('/people?q=' + encodeURIComponent(q))).text.matchAll(/<strong>([^<]+)<\/strong>\s*<span class="meta">/g)].map((m) => m[1]);
  assert.deepEqual(await hits('fire pump'), ['Penny Profile']);
  assert.deepEqual(await hits('sprinkler fit'), ['Penny Profile']);
  assert.deepEqual(await hits('quinn'), ['Quinn Quiet']);
  assert.deepEqual(await hits("' OR 1=1 --"), []);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId('prof2'));
  assert.doesNotMatch((await penny.get('/people')).text, /Quinn Quiet/);                   // disabled accounts drop out
  assert.equal((await penny.get(`/people/${userId('prof2')}`)).status, 404);
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(userId('prof2'));

  // Removing the photo takes the file away too.
  await save({ remove_photo: '1' });
  assert.equal(db.prepare('SELECT photo_path FROM users WHERE id = ?').get(pid).photo_path, null);
  assert.equal((await quinn.get(`/people/photo/${pid}`)).status, 404);
  assert.match((await quinn.get(`/people/${pid}`)).text, /class="avatar xl hue\d"[^>]*>PP</);   // initials instead
  db.prepare('DELETE FROM certifications WHERE user_id = ?').run(pid);
});

test('new hires: announced on everyone\'s home page for two weeks, and people say welcome', async () => {
  makeUser('hire1', 'Nora Newhire');
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const nora = await loggedIn('hire1');
  const nid = userId('hire1');
  assert.doesNotMatch((await t1.get('/')).text, /id="welcome"/);

  // Only someone who manages people can announce.
  assert.equal((await t1.post(`/admin/users/${nid}/welcome`, { intro: 'x' }, { page: '/' })).status, 403);
  assert.match((await owner.get(`/admin/users/${nid}/edit`)).text, /Announce as a new hire/);
  await owner.post(`/admin/users/${nid}/welcome`, { job_title: 'Apprentice', started_on: '2026-11-09', intro: 'Nora is joining the alarm team.' }, { page: `/admin/users/${nid}/edit` });
  const wid = db.prepare('SELECT id FROM welcomes WHERE user_id = ?').get(nid).id;
  assert.deepEqual(db.prepare('SELECT job_title, started_on FROM users WHERE id = ?').get(nid), { job_title: 'Apprentice', started_on: '2026-11-09' });

  const home = (await t1.get('/')).text.replace(/\s+/g, ' ');
  const panel = /<section class="panel p-around"[\s\S]*?<\/section>/.exec(home)[0];
  assert.match(panel, /<li class="feed-hire in-banner" id="welcome">[\s\S]*Nora Newhire joined the Lancaster office<\/strong>/); assert.match(panel, /Nora is joining the alarm team\./);
  assert.match(panel, /Be the first to say welcome/); assert.match(panel, /Say welcome<\/button>/);

  // A wave from the home page, then a message from her profile. One note per person: the message updates it.
  assert.equal((await t1.post(`/welcome/${wid}/wave`, { back: 'home' }, { page: '/' })).location, '/#welcome');
  await t1.post(`/welcome/${wid}/wave`, { message: 'Welcome <i>aboard</i>!' }, { page: `/people/${nid}` });
  await owner.post(`/welcome/${wid}/wave`, {}, { page: '/' });
  await nora.post(`/welcome/${wid}/wave`, { message: 'hi me' }, { page: '/' });            // you cannot welcome yourself
  assert.equal(db.prepare('SELECT COUNT(*) n FROM welcome_notes WHERE welcome_id = ?').get(wid).n, 2);
  assert.match((await t1.get('/')).text, /2 welcomes[\s\S]*You said welcome/);
  const hers = (await nora.get('/')).text;
  assert.match(hers, /See your messages/);
  const profile = (await nora.get(`/people/${nid}`)).text.replace(/\s+/g, ' ');
  assert.match(profile, /Terry Tech<\/strong><\/a> Welcome &lt;i&gt;aboard&lt;\/i&gt;!/); assert.match(profile, /Olive Owner<\/strong><\/a> said welcome/);
  assert.doesNotMatch(profile, /action="\/welcome\/\d+\/wave"/);                            // no button to welcome yourself

  // After two weeks it leaves the home page but the messages stay on her profile. It can also be taken down.
  db.prepare('UPDATE welcomes SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 15 * 86400000).toISOString(), wid);
  assert.doesNotMatch((await t1.get('/')).text, /id="welcome"/);
  assert.match((await t1.get(`/people/${nid}`)).text, /Welcome messages/);
  await owner.post(`/admin/users/${nid}/welcome`, { remove: '1' }, { page: `/admin/users/${nid}/edit` });
  assert.ok(db.prepare('SELECT COUNT(*) n FROM welcome_notes').get().n > 0);   // taking a welcome down keeps the notes people wrote
});

test('daily question: one a day for everyone, results after you answer, suggestions approved before they run', async () => {
  const dailyLib = require('../app/daily');
  // Weekends keep Friday's question.
  assert.equal(dailyLib.questionDay(new Date('2026-11-14T17:00:00Z')), '2026-11-13');     // a Saturday
  assert.equal(dailyLib.questionDay(new Date('2026-11-15T17:00:00Z')), '2026-11-13');     // a Sunday
  assert.equal(dailyLib.questionDay(new Date('2026-11-16T17:00:00Z')), '2026-11-16');     // Monday
  assert.ok(db.prepare("SELECT COUNT(*) n FROM daily_questions WHERE source = 'builtin'").get().n >= 100);

  const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2'); const owner = await loggedIn('owner');
  const card = (html) => /<section class="panel p-daily[\s\S]*?<\/section>/.exec(html.replace(/\s+/g, ' '))[0];
  const first = card((await t1.get('/')).text);
  const q = dailyLib.forDay();
  assert.equal(dailyLib.forDay().id, q.id);                                               // the same one all day, for everyone
  assert.ok(card((await t2.get('/')).text).includes(`name="question_id" value="${q.id}"`));
  assert.match(first, /name="choice" value="0"/); assert.match(first, /name="choice" value="1"/);
  assert.doesNotMatch(first, /daily-results/);                                            // no peeking before you answer

  assert.equal((await t1.post('/daily/answer', { question_id: q.id, choice: '0', back: 'home' }, { page: '/' })).location, '/#daily');
  await t2.post('/daily/answer', { question_id: q.id, choice: '1' }, { page: '/daily' });
  await owner.post('/daily/answer', { question_id: q.id, choice: '1' }, { page: '/daily' });
  for (const bad of [{ question_id: q.id, choice: '7' }, { question_id: q.id, choice: '-1' }, { question_id: '999999', choice: '0' }, { question_id: q.id, choice: 'x' }]) await owner.post('/daily/answer', bad, { page: '/daily' });
  const mine = card((await t1.get('/')).text);
  assert.match(mine, /<li class="mine"> <div class="daily-line"><strong>[^<]+<\/strong><span>33%<\/span>/);
  assert.match(mine, />You<\/a>/); assert.match(mine, /67%[\s\S]*Uma Tech<\/a>, <a href="\/people\/\d+">Olive Owner/);
  // Changing your mind moves your answer; it does not add one.
  await t1.post('/daily/answer', { question_id: q.id, choice: '1' }, { page: '/daily' });
  assert.deepEqual(db.prepare('SELECT choice, COUNT(*) n FROM daily_answers WHERE question_id = ? GROUP BY choice').all(q.id), [{ choice: 1, n: 3 }]);

  // Anyone can suggest; it waits for approval and only people who run the daily question can approve.
  assert.match((await t2.post('/daily/suggest', { prompt: 'Only one choice?', a: 'Yes' }, { page: '/daily' })).text, /at least two choices/);
  await t2.post('/daily/suggest', { prompt: 'Best lunch spot?', a: 'The diner', b: 'The <b>deli</b>', d: 'Gas station' }, { page: '/daily' });
  const sid = db.prepare("SELECT id FROM daily_questions WHERE prompt = 'Best lunch spot?'").get().id;
  assert.deepEqual(db.prepare('SELECT status, source, c, d FROM daily_questions WHERE id = ?').get(sid), { status: 'pending', source: 'suggested', c: 'Gas station', d: null });
  assert.match((await t2.get('/daily')).text, /Waiting for approval<\/span><strong>Best lunch spot\?/);
  assert.doesNotMatch((await t2.get('/daily')).text, /Run the daily question/);
  assert.equal((await t2.post(`/admin/daily/${sid}/approve`, {}, { page: '/daily' })).status, 403);
  assert.equal((await t2.post('/admin/daily', { prompt: 'x', a: 'y', b: 'z' }, { page: '/daily' })).status, 403);
  const manage = (await owner.get('/daily')).text;
  assert.match(manage, /Suggestions to approve[\s\S]*Best lunch spot\?[\s\S]*Uma Tech[\s\S]*The &lt;b&gt;deli&lt;\/b&gt;/);
  await owner.post(`/admin/daily/${sid}/approve`, {}, { page: '/daily' });
  assert.match((await t2.get('/daily')).text, /Approved, coming up<\/span><strong>Best lunch spot\?/);

  // Tomorrow: an approved suggestion goes ahead of the built-in list, unless a question is set for that very day.
  const day = (n) => { const d = new Date(`${q.used_on}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  assert.equal(dailyLib.forDay(day(1)).id, sid);
  assert.match((await owner.post('/admin/daily', { prompt: 'Past?', a: 'a', b: 'b', scheduled_on: '2020-01-01' }, { page: '/daily' })).text, /today or a later day/);
  await owner.post('/admin/daily', { prompt: 'Holiday special?', a: 'Turkey', b: 'Ham', c: 'Both' }, { page: '/daily' });
  await owner.post('/admin/daily', { prompt: 'Set for a day?', a: 'Yes', b: 'No', scheduled_on: day(400) }, { page: '/daily' });
  assert.match((await owner.post('/admin/daily', { prompt: 'Same day?', a: 'Yes', b: 'No', scheduled_on: day(400) }, { page: '/daily' })).text, /already has a question/);
  assert.equal(dailyLib.forDay(day(400)).prompt, 'Set for a day?');
  assert.equal(dailyLib.forDay(day(2)).prompt, 'Holiday special?');
  assert.equal(dailyLib.optionsOf(dailyLib.forDay(day(2))).length, 3);

  // Earlier questions stay on the Daily question page with who picked what; a declined suggestion never runs.
  db.prepare('UPDATE daily_questions SET used_on = ? WHERE id = ?').run(day(-3), q.id);
  const page = (await t1.get('/daily')).text;
  assert.match(page, /Earlier questions[\s\S]*Terry Tech|Earlier questions[\s\S]*>You</);
  await t1.post('/daily/suggest', { prompt: 'Decline me?', a: 'a', b: 'b' }, { page: '/daily' });
  const no = db.prepare("SELECT id FROM daily_questions WHERE prompt = 'Decline me?'").get().id;
  await owner.post(`/admin/daily/${no}/reject`, {}, { page: '/daily' });
  assert.match((await t1.get('/daily')).text, /Not used<\/span><strong>Decline me\?/);
  for (let i = 5; i < 12; i++) assert.notEqual(dailyLib.forDay(day(i)).id, no);
  assert.equal((await new Client().get('/daily')).status, 302);
  db.prepare("DELETE FROM daily_questions WHERE source <> 'builtin'").run();
  db.prepare("UPDATE daily_questions SET used_on = NULL").run(); db.prepare('DELETE FROM daily_answers').run();
});

test('contact list: a CSV fills in existing accounts, adds everyone else with sign-in off, and puts them all on the People page', async () => {
  makeUser('daniel.rivers', 'Danny Rivers'); makeUser('contact2', 'Mia Old-Email');
  db.prepare("UPDATE users SET email = 'mia@oldcompany.example' WHERE username = 'contact2'").run();
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  const csv = ['NAME,TITLE,EMAIL,PHONE', 'MANAGEMENT,,,', 'PAT O\'BRIEN-MCKAY,GENERAL MANAGER,PAT.OBRIEN@EXAMPLE.COM,(717)555-0101',
    'SERVICE,,,', 'DAN RIVERS,SERVICE TECH,DANIEL.RIVERS@EXAMPLE.COM,(717)555-0102', 'MIA OLD-EMAIL,CED AGENT,MIA.NEW@EXAMPLE.COM,(TEAMS)',
    'TERRY TECH,"LEAD TECH, NIGHTS",,717-555-0103', ',,,', 'NO CONTACT DETAILS,,,'].join('\r\n');
  const send = (client, text, name = 'list.csv') => client.post('/admin/people/import', [['file', new File([text], name, { type: 'text/csv' })]], { multipart: true, page: '/admin/import' });
  const before = db.prepare('SELECT COUNT(*) n FROM users').get().n;

  assert.equal((await send(t1, csv)).status, 403);                                        // people who manage accounts only
  assert.equal((await send(owner, 'PK\u0003\u0004 not a csv')).location, '/admin/import#contacts');
  assert.match((await owner.get('/admin/import')).text, /That is an Excel workbook/);
  await send(owner, 'TITLE,PHONE\nBoss,1'); assert.match((await owner.get('/admin/import')).text, /needs a &#34;Name&#34; column/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, before);

  await send(owner, csv);
  const page = (await owner.get('/admin/import')).text;
  assert.match(page, /<strong>3<\/strong> existing accounts filled in and <strong>1<\/strong> person added/);
  assert.match(page, /Matched to existing accounts:<\/strong> Danny Rivers, Mia Old-Email, Terry Tech/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, before + 1);            // the heading and the empty row are not people
  const who = (name) => db.prepare('SELECT username, display_name, job_title, department, email, phone, show_phone, show_email, active, in_directory, must_change_password FROM users WHERE display_name = ?').get(name);
  // Matched by the first.last in the email; keeps the name it has here, takes the title, department and work contact details.
  // He already uses the site, so whether his phone and email are shown stays as he has it.
  assert.deepEqual(who('Danny Rivers'), { username: 'daniel.rivers', display_name: 'Danny Rivers', job_title: 'Service Tech', department: 'Service', email: 'daniel.rivers@example.com', phone: '(717) 555-0102', show_phone: 0, show_email: 0, active: 1, in_directory: 1, must_change_password: 0 });
  assert.deepEqual([who('Mia Old-Email').email, who('Mia Old-Email').job_title, who('Mia Old-Email').phone, who('Mia Old-Email').show_phone], ['mia.new@example.com', 'CED Agent', null, 0]);   // "(TEAMS)" is not a phone number
  assert.deepEqual([who('Terry Tech').job_title, who('Terry Tech').phone, who('Terry Tech').department], ['Lead Tech, Nights', '717-555-0103', 'Service']);
  // New to the site: listed, tidied, and unable to sign in until an admin enables the account.
  const pat = who("Pat O'Brien-McKay");
  assert.deepEqual([pat.username, pat.job_title, pat.department, pat.active, pat.in_directory, pat.must_change_password], ['pat.obrien', 'General Manager', 'Management', 0, 1, 1]);
  assert.equal((await new Client().post('/login', { username: 'pat.obrien', password: '' }, { page: '/login' })).status, 401);

  const people = (await t1.get('/people')).text;
  assert.match(people, /Pat O&#39;Brien-McKay<\/strong>\s*<span class="meta">General Manager · Management/);
  assert.match(people, /<option value="Service"/);
  const service = (await t1.get('/people?dept=Service')).text;
  assert.match(service, /Danny Rivers/); assert.doesNotMatch(service, /Pat O&#39;Brien/);
  const patPage = (await t1.get(`/people/${userId('pat.obrien')}`)).text;
  assert.match(patPage, /href="tel:7175550101"/); assert.match(patPage, /mailto:pat\.obrien@example\.com/); assert.match(patPage, /Pat is not using this site yet/);

  // Importing again changes nothing but what the list changed; disabling someone by hand takes them off the page.
  await send(owner, csv.replace('GENERAL MANAGER', 'REGIONAL MANAGER'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, before + 1);
  assert.equal(who("Pat O'Brien-McKay").job_title, 'Regional Manager');
  await owner.post(`/admin/users/${userId('daniel.rivers')}/toggle-active`, {}, { page: '/admin/users' });
  assert.doesNotMatch((await t1.get('/people')).text, /Danny Rivers/);
  db.prepare("UPDATE users SET job_title = NULL, department = NULL, phone = NULL, show_phone = 0, show_email = 0, in_directory = 0 WHERE username IN ('tech1')").run();
});

// ---- Branches: shared community, private operations -------------------------------
test('branches: each branch sees only its own parts, stock, trucks, tasks, training, announcements and complaints', async () => {
  const lanc = db.prepare('SELECT MIN(id) id FROM branches').get().id;
  const owner = await loggedIn('owner');                                     // can see every branch
  const tech1 = await loggedIn('tech1');

  // Only someone who can see every branch can add one. It gets its own copy of the truck checklist.
  assert.equal((await tech1.get('/admin/branches')).status, 403);
  assert.equal((await tech1.post('/admin/branches', { name: 'Sneaky' }, { page: '/' })).status, 403);
  await owner.post('/admin/branches', { name: 'Harrisburg Branch' }, { page: '/admin/branches' });
  const hbg = db.prepare("SELECT id FROM branches WHERE name = 'Harrisburg'").get().id;
  assert.match((await owner.post('/admin/branches', { name: 'harrisburg' }, { page: '/admin/branches' })).text, /already an office with that name/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inspection_items WHERE branch_id = ? AND active = 1').get(hbg).n, db.prepare('SELECT COUNT(*) n FROM inspection_items WHERE branch_id = ? AND active = 1').get(lanc).n);

  // The branch box: looking at Harrisburg, a new person joins Harrisburg.
  assert.match((await owner.get('/')).text, /<datalist id="office-list"><option value="Corporate" data-id="all"[\s\S]*<input name="office" list="office-list"[^>]*data-office-pick/);
  assert.doesNotMatch((await tech1.get('/')).text, /data-office-pick|office-list/);
  assert.equal((await tech1.post('/branch/view', { branch: String(hbg) }, { page: '/' })).status, 403);
  await owner.post('/branch/view', { branch: String(hbg), back: '/admin/users' }, { page: '/' });
  const adminProfile = profileId('Admin (no complaints)') || profileId('Admin');
  await owner.post('/admin/users', { username: 'hbg.admin', display_name: 'Hank Harrisburg', profile_id: String(access.ensureProfile('Branch admin', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all'))) }, { page: '/admin/users' });
  await owner.post('/admin/users', { username: 'hbg.tech', display_name: 'Holly Harrisburg', profile_id: String(profileId('Technician')) }, { page: '/admin/users' });
  assert.deepEqual(db.prepare("SELECT branch_id FROM users WHERE username IN ('hbg.admin', 'hbg.tech')").all(), [{ branch_id: hbg }, { branch_id: hbg }]);
  assert.ok(adminProfile);
  for (const u of ['hbg.admin', 'hbg.tech']) db.prepare("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE username = 'tech1'), must_change_password = 0 WHERE username = ?").run(u);
  const usersPage = (await owner.get('/admin/users')).text;
  assert.match(usersPage, /Hank Harrisburg/); assert.doesNotMatch(usersPage, /Terry Tech/);      // looking at Harrisburg shows Harrisburg
  await owner.post('/branch/view', { branch: String(lanc) }, { page: '/' });

  const hadmin = await loggedIn('hbg.admin'); const htech = await loggedIn('hbg.tech');
  assert.match((await htech.get('/')).text, /<span class="branch">Harrisburg Office<\/span>/);
  assert.match((await tech1.get('/')).text, /<span class="branch">Lancaster Office<\/span>/);

  // --- Lancaster does some work ---
  await tech1.post('/parts', [['action', 'request'], ['part_name', 'LANC-ONLY-PART'], ['quantity', '2'], ['source', 'van'], ['needed_by', '2031-01-01']], { multipart: true });
  const lancPart = lastParts().id;
  await tech1.post('/training', { description: 'LANC-ONLY training wish', wants_contact: 'no', is_private: 'no' }, { page: '/training' });
  const lancTraining = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  await owner.post('/admin/stock', { part_number: 'BR-STOCK', count: '10', min_level: '4' }, { page: '/admin/stock' });
  await owner.post('/admin/announcements', { title: 'LANC-ONLY announcement', body: 'For Lancaster.' }, { page: '/admin/announcements' });
  await owner.post('/admin/announcements', { title: 'COMPANY-WIDE announcement', body: 'For everyone.', reach: 'everyone' }, { page: '/admin/announcements' });
  await owner.post('/admin/tasks', [['title', 'LANC-ONLY task'], ['to', String(userId('tech1'))]], { page: '/admin/tasks' });
  await owner.post('/admin/training/sessions', { title: 'LANC-ONLY session', session_date: ymdFromNow(5) }, { page: '/admin/training/sessions' });
  const lancSession = db.prepare('SELECT MAX(id) id FROM training_sessions').get().id;
  await tech1.post('/complaint', { category: 'safety', description: 'LANC-ONLY complaint' }, { page: '/complaint' });
  const lancComplaint = db.prepare("SELECT id FROM complaints WHERE description = 'LANC-ONLY complaint'").get().id;
  db.prepare("INSERT INTO certifications (user_id, name, expires_on, created_at) VALUES (?, 'LANC-ONLY cert', ?, ?)").run(userId('tech1'), ymdFromNow(5), new Date().toISOString());
  const lancCert = db.prepare('SELECT MAX(id) id FROM certifications').get().id;

  // --- A Harrisburg admin, with every permission except seeing other branches, finds none of it ---
  for (const url of ['/', '/admin/parts', '/admin/parts.csv', '/admin/requests', '/admin/parts/audit', '/admin/parts/summary', '/admin/weekly', '/admin/stock', '/admin/training', '/admin/training.csv',
    '/admin/training/sessions', '/admin/training/sessions.csv', '/training/topics', '/admin/inspections', '/admin/certs', '/admin/certs.csv', '/admin/tasks?show=all', '/admin/users', '/admin/announcements',
    '/notices', '/admin/complaints', '/admin/activity', '/alerts']) {
    const r = await hadmin.get(url);
    assert.equal(r.status, 200, url);
    assert.doesNotMatch(r.text, url === '/' ? /LANC-ONLY|BR-STOCK/ : /LANC-ONLY|BR-STOCK|Terry Tech|Uma Tech/, url);
  }
  // ...and cannot reach it by address either.
  for (const url of [`/admin/parts/${lancPart}`, `/admin/training/${lancTraining}`, `/admin/training/sessions/${lancSession}`, `/admin/complaints/${lancComplaint}`, `/admin/certs/${lancCert}`,
    `/admin/users/${userId('tech1')}/edit`, `/parts/${lancPart}/edit`, '/admin/profiles', '/admin/backups', '/admin/branches']) {
    assert.ok([403, 404, 302].includes((await hadmin.get(url)).status), url);
    assert.doesNotMatch((await hadmin.get(url)).text, /LANC-ONLY/, url);
  }
  for (const [url, body] of [[`/admin/parts/${lancPart}/status`, { status: 'fulfilled' }], [`/admin/parts/${lancPart}/delete`, {}], [`/admin/training/${lancTraining}/status`, { status: 'reviewed' }],
    [`/admin/users/${userId('tech1')}/reset-password`, {}], [`/admin/complaints/${lancComplaint}`, { status: 'closed', reviewer_reply: 'hijacked' }], [`/admin/complaints/${lancComplaint}/delete`, {}],
    [`/admin/training/sessions/${lancSession}/delete`, {}], [`/training/topics/${lancTraining}/vote`, {}], ['/admin/tasks', [['title', 'Cross-branch task'], ['to', String(userId('tech1'))]]]]) {
    await hadmin.post(url, body, { page: '/' });
  }
  assert.equal(db.prepare('SELECT status FROM parts_submissions WHERE id = ?').get(lancPart).status, 'new');
  assert.equal(db.prepare('SELECT status FROM training_requests WHERE id = ?').get(lancTraining).status, 'new');
  assert.equal(db.prepare('SELECT status FROM complaints WHERE id = ?').get(lancComplaint).status, 'new');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_sessions WHERE id = ?').get(lancSession).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_votes WHERE request_id = ?').get(lancTraining).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE title = 'Cross-branch task'").get().n, 0);
  assert.equal(db.prepare("SELECT must_change_password m FROM users WHERE username = 'tech1'").get().m, 0);

  // The one announcement for every branch does reach Harrisburg; the Lancaster one does not.
  const hNotices = (await htech.get('/notices')).text;
  assert.match(hNotices, /COMPANY-WIDE announcement/); assert.doesNotMatch(hNotices, /LANC-ONLY/);
  assert.match((await tech1.get('/notices')).text, /LANC-ONLY announcement[\s\S]*|COMPANY-WIDE/);
  assert.equal((await hadmin.post('/admin/announcements', { title: 'HBG tries everyone', body: 'x', reach: 'everyone' }, { page: '/admin/announcements' })).status, 302);
  assert.equal(db.prepare("SELECT branch_id FROM announcements WHERE title = 'HBG tries everyone'").get().branch_id, hbg);   // stays in their branch
  assert.doesNotMatch((await tech1.get('/notices')).text, /HBG tries everyone/);

  // Stock is separate: the same part number has its own count in each branch, and a take only moves the taker's branch.
  await hadmin.post('/admin/stock', { part_number: 'BR-STOCK', count: '3' }, { page: '/admin/stock' });
  const on = (b) => stockLib.list(b).find((r) => r.part_number === 'BR-STOCK').on_hand;
  assert.deepEqual([on(lanc), on(hbg)], [10, 3]);
  await htech.post('/parts', [['action', 'take'], ['part_name', 'BR-STOCK'], ['quantity', '2'], ['source', 'van']], { multipart: true });
  assert.deepEqual([on(lanc), on(hbg)], [10, 1]);
  assert.match((await hadmin.get('/admin/stock')).text, /BR-STOCK/);
  assert.match((await hadmin.get('/')).text.replace(/\s+/g, ' '), /Office at a glance/);

  // The checklist is each branch's own.
  await hadmin.post('/admin/inspections/checklist', { label: 'HBG-ONLY check' }, { page: '/admin/inspections/checklist' });
  assert.match((await htech.get('/inspection')).text, /HBG-ONLY check/);
  assert.doesNotMatch((await tech1.get('/inspection')).text, /HBG-ONLY check/);
  const lancItem = db.prepare('SELECT id FROM inspection_items WHERE branch_id = ? ORDER BY id LIMIT 1').get(lanc).id;
  await hadmin.post(`/admin/inspections/checklist/${lancItem}/toggle`, {}, { page: '/admin/inspections/checklist' });
  assert.equal(db.prepare('SELECT active FROM inspection_items WHERE id = ?').get(lancItem).active, 1);

  // Harrisburg's own work shows up for Harrisburg, and its complaint goes to its own reviewer.
  await htech.post('/complaint', { category: 'other', description: 'HBG-ONLY complaint' }, { page: '/complaint' });
  assert.match((await hadmin.get('/admin/complaints')).text, /HBG-ONLY complaint/);
  assert.match((await hadmin.get('/admin/parts')).text, /BR-STOCK/);
  // Lancaster's admin view (the owner, looking at Lancaster) has none of Harrisburg's.
  for (const url of ['/admin/parts', '/admin/complaints', '/admin/users', '/admin/inspections/checklist']) assert.doesNotMatch((await owner.get(url)).text, /HBG-ONLY|Holly Harrisburg|Hank Harrisburg/, url);
  // "All branches" shows both.
  await owner.post('/branch/view', { branch: 'all' }, { page: '/' });
  const both = (await owner.get('/admin/complaints')).text;
  assert.match(both, /HBG-ONLY complaint/); assert.match(both, /LANC-ONLY complaint/);
  assert.match((await owner.get('/')).text, /Office at a glance/);
  assert.match((await owner.get('/admin/users')).text, /Holly Harrisburg\s*<\/td>\s*<td>Harrisburg<\/td>/);
  await owner.post('/branch/view', { branch: String(lanc) }, { page: '/' });

  // The community side is shared: both branches are in the directory, and the daily question is one for all.
  const people = (await htech.get('/people')).text;
  assert.match(people, /Terry Tech/); assert.match(people, /Holly Harrisburg/); assert.match(people, /<option value="\d+" >Harrisburg<\/option>|Harrisburg<\/option>/);
  assert.doesNotMatch((await htech.get(`/people?branch=${hbg}`)).text, /Terry Tech/);
  assert.equal((await htech.get('/daily')).status, 200); assert.equal((await htech.get('/discussions')).status, 200);

  // A branch admin can add people (to their own branch only), but not move them or manage profiles.
  await hadmin.post('/admin/users', { username: 'hbg.new', display_name: 'Nell Newbranch', profile_id: String(profileId('Technician')) }, { page: '/admin/users' });
  assert.equal(db.prepare("SELECT branch_id FROM users WHERE username = 'hbg.new'").get().branch_id, hbg);
  await hadmin.post(`/admin/users/${userId('hbg.new')}/edit`, { username: 'hbg.new', display_name: 'Nell Newbranch', branch_id: String(lanc) }, { page: '/admin/users' });
  assert.equal(db.prepare("SELECT branch_id FROM users WHERE username = 'hbg.new'").get().branch_id, hbg);
  await owner.post('/branch/view', { branch: String(hbg) }, { page: '/' });
  await owner.post(`/admin/users/${userId('hbg.new')}/edit`, { username: 'hbg.new', display_name: 'Nell Newbranch', branch_id: String(lanc) }, { page: '/admin/users' });
  assert.equal(db.prepare("SELECT branch_id FROM users WHERE username = 'hbg.new'").get().branch_id, lanc);
  await owner.post('/branch/view', { branch: String(lanc) }, { page: '/' });

  // Tidy up so later checks see the single branch they expect.
  db.prepare("DELETE FROM parts_submissions WHERE id IN (SELECT s.id FROM parts_submissions s JOIN users u ON u.id = s.user_id WHERE u.branch_id = ?) OR id = ?").run(hbg, lancPart);
  db.prepare('DELETE FROM tasks').run(); db.prepare("DELETE FROM announcements WHERE title LIKE '%announcement' OR title LIKE 'HBG%'").run();
  db.prepare('DELETE FROM complaints WHERE description LIKE ?').run('%-ONLY complaint'); db.prepare('DELETE FROM certifications WHERE id = ?').run(lancCert);
  db.prepare('DELETE FROM training_sessions WHERE id = ?').run(lancSession); db.prepare('DELETE FROM training_requests WHERE id = ?').run(lancTraining);
  db.prepare("DELETE FROM branch_stock WHERE catalog_id = (SELECT id FROM parts_catalog WHERE part_number = 'BR-STOCK')").run();
  db.prepare("UPDATE users SET active = 0, in_directory = 0 WHERE branch_id = ? OR username = 'hbg.new'").run(hbg);
});

// ---- Community, part two ----------------------------------------------------------
test('shout-outs: thank someone by name; it shows on the home page and stays on their profile', async () => {
  const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2'); const owner = await loggedIn('owner');
  const [id1, id2] = [userId('tech1'), userId('tech2')];
  assert.match((await t1.get('/shoutouts')).text, /No shout-outs yet/);
  assert.match((await t1.post('/shoutouts', { to_user: String(id1), message: 'Me!' }, { page: '/shoutouts' })).text, /for someone else/);
  assert.match((await t1.post('/shoutouts', { to_user: String(id2), message: '' }, { page: '/shoutouts' })).text, /Say what they did/);
  assert.match((await t1.post('/shoutouts', { to_user: '999999', message: 'x' }, { page: '/shoutouts' })).text, /Choose who/);
  assert.equal((await t1.post('/shoutouts', { to_user: String(id2), message: 'Fixed the <b>panel</b> at the school.' }, { page: '/shoutouts' })).location, '/shoutouts');
  const sid = db.prepare('SELECT MAX(id) id FROM shoutouts').get().id;
  const home = (await owner.get('/')).text.replace(/\s+/g, ' ');
  assert.match(/<section class="panel p-shouts"[\s\S]*?<\/section>/.exec(home)[0], /Uma Tech<\/strong><\/a> <span class="meta">from <a href="\/people\/\d+">Terry Tech<\/a>[\s\S]*Fixed the &lt;b&gt;panel&lt;\/b&gt; at the school\./);
  assert.match((await owner.get(`/people/${id2}`)).text, /id="shoutouts"[\s\S]*Fixed the/);
  assert.match((await owner.get(`/people/${id1}`)).text, new RegExp(`href="/shoutouts\\?to=${id1}#give"`));
  assert.match((await owner.get(`/shoutouts?to=${id1}`)).text, new RegExp(`<option value="${id1}" selected>`));
  // Applause toggles, one per person.
  await owner.post(`/shoutouts/${sid}/cheer`, { back: 'home' }, { page: '/' }); await t2.post(`/shoutouts/${sid}/cheer`, {}, { page: '/shoutouts' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shoutout_cheers WHERE shoutout_id = ?').get(sid).n, 2);
  await owner.post(`/shoutouts/${sid}/cheer`, {}, { page: '/shoutouts' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shoutout_cheers WHERE shoutout_id = ?').get(sid).n, 1);
  // Only the writer or a moderator removes one.
  assert.equal((await t2.post(`/shoutouts/${sid}/delete`, {}, { page: '/shoutouts' })).status, 403);
  await t1.post(`/shoutouts/${sid}/delete`, {}, { page: '/shoutouts' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shoutouts').get().n, 0);
  assert.equal((await new Client().get('/shoutouts')).status, 302);
});

test('birthdays and anniversaries: this week on the home page for the branch, with one wish each', async () => {
  const social = require('../app/routes/social');
  makeUser('bday1', 'Bea Birthday'); makeUser('anniv1', 'Andy Anniversary'); makeUser('far1', 'Fran Faraway');
  const today = '2026-11-13';
  db.prepare("UPDATE users SET birthday = '11-13' WHERE username = 'bday1'").run();
  db.prepare("UPDATE users SET started_on = '2021-11-16' WHERE username = 'anniv1'").run();     // five years on Monday
  db.prepare("UPDATE users SET birthday = '12-25', started_on = '2026-11-14' WHERE username = 'far1'").run();   // outside the week; started this year
  const viewer = { id: userId('tech1'), branch_id: 1 };
  const week = social.thisWeek(viewer, today).filter((o) => ['Bea Birthday', 'Andy Anniversary', 'Fran Faraway'].includes(o.display_name));
  assert.deepEqual(week.map((o) => [o.display_name, o.kind, o.when, o.text]), [['Bea Birthday', 'birthday', 'Today', 'Birthday'], ['Andy Anniversary', 'anniversary', 'Mon, Nov 16', '5 years with us']]);
  // Another office of the same market sees them too, and is shown which office each person is in. An office outside the market does not.
  const bNow = new Date().toISOString();
  const bMarket = db.prepare("INSERT INTO markets (name, created_at) VALUES ('Birthday Valley', ?)").run(bNow).lastInsertRowid;
  const bNear = db.prepare("INSERT INTO branches (name, created_at, market_id) VALUES ('Birthday Nearby', ?, ?)").run(bNow, bMarket).lastInsertRowid;
  const bFar = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Birthday Faraway', ?)").run(bNow).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id = 1').run(bMarket);
  assert.ok(social.thisWeek({ id: 0, branch_id: bNear }, today).some((o) => o.display_name === 'Bea Birthday' && o.branch === 'Lancaster'));
  assert.deepEqual(social.thisWeek({ id: 0, branch_id: bFar }, today), []);
  // The Corporate view, every office at once, has them all.
  assert.ok(social.thisWeek({ id: 0, branch_id: bFar, allBranches: true, viewBranch: null }, today).some((o) => o.display_name === 'Bea Birthday'));
  db.prepare('UPDATE branches SET market_id = NULL WHERE id = 1').run(); db.prepare('DELETE FROM branches WHERE id IN (?, ?)').run(bNear, bFar); db.prepare('DELETE FROM markets WHERE id = ?').run(bMarket);

  // The profile form: a month and a day, never a year; both or neither.
  const bea = await loggedIn('bday1');
  const save = (f) => bea.post('/profile', Object.entries(f), { multipart: true, page: '/profile' });
  assert.match((await save({ birth_month: '2', birth_day: '30' })).text, /both a month and a day/);
  assert.match((await save({ birth_month: '3' })).text, /both a month and a day/);
  const now = new Date(Date.now() - 5 * 3600 * 1000);
  await save({ birth_month: String(now.getUTCMonth() + 1), birth_day: String(now.getUTCDate()) });
  assert.match(db.prepare("SELECT birthday FROM users WHERE username = 'bday1'").get().birthday, /^\d\d-\d\d$/);
  assert.match((await bea.get(`/people/${userId('bday1')}`)).text, /🎂 [A-Z][a-z]+ \d+/);

  // A wish from the home page: once per person, not for yourself.
  const t1 = await loggedIn('tech1');
  const live = require('../app/routes/social').thisWeek({ id: userId('tech1'), branch_id: 1 }).find((o) => o.display_name === 'Bea Birthday');
  if (live) {                                                         // true unless the test runs across midnight in another timezone
    assert.match((await t1.get('/')).text.replace(/\s+/g, ' '), /id="thisweek"[\s\S]*Bea Birthday[\s\S]*Happy birthday<\/button>/);
    await t1.post('/celebrate', { user_id: String(userId('bday1')), kind: 'birthday' }, { page: '/' });
    await t1.post('/celebrate', { user_id: String(userId('bday1')), kind: 'birthday' }, { page: '/' });
    await bea.post('/celebrate', { user_id: String(userId('bday1')), kind: 'birthday' }, { page: '/' });
    await t1.post('/celebrate', { user_id: String(userId('far1')), kind: 'birthday' }, { page: '/' });   // not this week: ignored
    assert.equal(db.prepare('SELECT COUNT(*) n FROM celebrations').get().n, 1);
    assert.match((await t1.get('/')).text.replace(/\s+/g, ' '), /Bea Birthday[\s\S]*1 wish[\s\S]*Sent ✓/);
  }
  await save({});                                                      // clearing it takes them off the list
  assert.equal(db.prepare("SELECT birthday FROM users WHERE username = 'bday1'").get().birthday, null);
  db.prepare("UPDATE users SET birthday = NULL, started_on = NULL WHERE username IN ('anniv1', 'far1')").run(); db.prepare('DELETE FROM celebrations').run();
});

test('events: posted by those allowed, everyone signs up, potlucks collect what people bring', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  assert.equal((await t1.post('/events', { title: 'Sneaky', event_date: ymdFromNow(3) }, { page: '/events' })).status, 403);
  assert.doesNotMatch((await t1.get('/events')).text, /Add an event/);
  assert.match((await owner.post('/events', { title: 'Old news', event_date: '2020-01-01' }, { page: '/events' })).text, /today or later/);
  await owner.post('/events', { title: 'Chili <cook-off>', event_date: ymdFromNow(6), event_time: '12:30', location: 'The shop', details: 'Bring a pot.', potluck: '1' }, { page: '/events' });
  await owner.post('/events', { title: 'Toy drive', event_date: ymdFromNow(20) }, { page: '/events' });
  const eid = db.prepare("SELECT id FROM events WHERE title LIKE 'Chili%'").get().id;
  const page = (await t1.get('/events')).text;
  assert.match(page, /Chili &lt;cook-off&gt;[\s\S]*at 12:30 PM · The shop[\s\S]*Toy drive/); assert.match(page, /name="bringing"/);

  await t1.post(`/events/${eid}/signup`, { bringing: 'Cornbread' }, { page: '/events' });
  await t2.post(`/events/${eid}/signup`, {}, { page: '/events' });
  await t1.post(`/events/${eid}/signup`, { bringing: 'Cornbread and butter' }, { page: '/events' });      // changing it does not sign up twice
  assert.deepEqual(db.prepare('SELECT bringing FROM event_signups WHERE event_id = ? ORDER BY created_at').all(eid).map((r) => r.bringing), ['Cornbread and butter', null]);
  const after = (await owner.get('/events')).text.replace(/\s+/g, ' ');
  assert.match(after, /<strong>2<\/strong> people are in:[\s\S]*Terry Tech<\/a> <span class="meta">· bringing Cornbread and butter/);
  // The home page lists it under Coming up with whether you are in.
  assert.match((await t1.get('/')).text.replace(/\s+/g, ' '), /Coming up[\s\S]*<a href="\/events#e\d+">Chili &lt;cook-off&gt;<\/a>[\s\S]*You&#39;re in/);
  await t2.post(`/events/${eid}/signup`, { out: '1' }, { page: '/events' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_signups WHERE event_id = ?').get(eid).n, 1);

  // Another office sees the company's events, not this office's.
  const other = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Eventville', ?)").run(new Date().toISOString()).lastInsertRowid;
  makeUser('ev1', 'Eve Elsewhere'); db.prepare('UPDATE users SET branch_id = ? WHERE username = ?').run(other, 'ev1');
  await owner.post('/events', { title: 'Company picnic', event_date: ymdFromNow(30), reach: 'everyone' }, { page: '/events' });
  const eve = await loggedIn('ev1');
  const hers = (await eve.get('/events')).text;
  assert.match(hers, /Company picnic[\s\S]*Whole company/); assert.doesNotMatch(hers, /Chili|Toy drive/);
  assert.doesNotMatch((await eve.get('/')).text, /Chili/);                                                       // nor on her home page
  assert.equal((await eve.post(`/events/${eid}/signup`, {}, { page: '/events' })).status, 404);                 // and it is not hers to join
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_signups WHERE event_id = ? AND user_id = ?').get(eid, userId('ev1')).n, 0);
  // An event for the market reaches every office in it, and only those.
  const evMarket = db.prepare("INSERT INTO markets (name, created_at) VALUES ('Event Valley', ?)").run(new Date().toISOString()).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id IN (1, ?)').run(evMarket, other);
  assert.match((await owner.get('/events')).text, /<select name="reach"><option value="office" >Lancaster office only<\/option><option value="market" >The Event Valley market<\/option><option value="company" >The whole company<\/option>/);
  await owner.post('/events', { title: 'Market mixer', event_date: ymdFromNow(12), reach: 'market' }, { page: '/events' });
  const mixer = db.prepare("SELECT * FROM events WHERE title = 'Market mixer'").get();
  assert.equal(mixer.market_id, evMarket); assert.equal(mixer.branch_id, 1);
  assert.match((await eve.get('/events')).text, /Market mixer[\s\S]*Event Valley market/);
  assert.equal((await eve.post(`/events/${mixer.id}/signup`, {}, { page: '/events' })).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_signups WHERE event_id = ? AND user_id = ?').get(mixer.id, userId('ev1')).n, 1);
  assert.equal((await eve.post(`/events/${mixer.id}/delete`, {}, { page: '/events' })).status, 403);            // but cannot remove one she did not post
  const outsider = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Event Outside', ?)").run(new Date().toISOString()).lastInsertRowid;
  db.prepare('UPDATE users SET branch_id = ? WHERE username = ?').run(outsider, 'ev1');
  assert.doesNotMatch((await eve.get('/events')).text, /Market mixer/);
  db.prepare('UPDATE users SET branch_id = ? WHERE username = ?').run(other, 'ev1');
  // Someone without the market or the company to post for is not asked; their event is for their own office.
  assert.doesNotMatch((await t1.get('/events')).text, /name="reach"/);
  await owner.post(`/events/${mixer.id}/delete`, {}, { page: '/events' });
  db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(evMarket); db.prepare('DELETE FROM markets WHERE id = ?').run(evMarket); db.prepare('DELETE FROM branches WHERE id = ?').run(outsider);

  // Only the organiser (or someone who posts events for that branch) removes one.
  assert.equal((await t1.post(`/events/${eid}/delete`, {}, { page: '/events' })).status, 403);
  await owner.post(`/events/${eid}/delete`, {}, { page: '/events' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_signups').get().n, 0);
  db.prepare('DELETE FROM events').run(); db.prepare("UPDATE users SET active = 0 WHERE username = 'ev1'").run(); db.prepare('DELETE FROM branches WHERE id = ?').run(other);
  db.prepare("UPDATE users SET branch_id = 1 WHERE username = 'ev1'").run();
});

test('photo wall and branch pages: photos posted and liked, a branch page with its people and news', async () => {
  const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2'); const owner = await loggedIn('owner');
  const png = () => new File([PNG], 'site.png', { type: 'image/png' });
  assert.match((await t1.post('/social', [['body', '']], { multipart: true, page: '/social' })).text, /Write something, add a photo, or both/);
  assert.match((await t1.post('/social', [['photos', new File(['nope'], 'x.png', { type: 'image/png' })]], { multipart: true, page: '/social' })).text, /must be JPEG, PNG, WebP or GIF/);
  await t1.post('/social', [['photos', png()], ['photos', png()], ['body', 'New <panel> at the school']], { multipart: true, page: '/social' });
  const ids = db.prepare('SELECT id FROM wall_photos ORDER BY id').all().map((r) => r.id);
  assert.equal(ids.length, 2);
  const post = db.prepare('SELECT id FROM social_posts ORDER BY id DESC').get().id;
  assert.deepEqual(db.prepare('SELECT post_id FROM wall_photos ORDER BY id').all().map((r) => r.post_id), [post, post]);   // one post, both pictures
  assert.equal((await t2.get('/photos')).location, '/social');                           // where the photo wall used to be
  const wall = (await t2.get('/social')).text;
  assert.match(wall, new RegExp(`<a href="/wall/photo/${ids[1]}"><img src="/wall/photo/${ids[1]}"`)); assert.match(wall, /New &lt;panel&gt; at the school/);
  assert.doesNotMatch(wall, /target=/);
  assert.equal((await t2.get(`/wall/photo/${ids[0]}`)).headers.get('content-type'), 'image/png');
  assert.equal((await new Client().get(`/wall/photo/${ids[0]}`)).status, 302);
  // Reactions: given once each, and taken back by giving the same one again.
  const react = (c, emoji) => c.post('/react', { kind: 'social', id: String(post), emoji }, { page: '/social' });
  await react(t2, 'like'); await react(owner, 'love'); await react(t2, 'like'); await react(t2, 'party');
  assert.deepEqual(db.prepare("SELECT emoji FROM reactions WHERE kind = 'social' AND target_id = ? ORDER BY emoji").all(post).map((r) => r.emoji), ['love', 'party']);
  // Comments: anyone who can post can comment; the newest three show under the post and the rest are a tap away.
  for (const [c, text] of [[t2, 'Nice work'], [owner, 'Looks <b>great</b>'], [t2, 'Third'], [t1, 'Thanks all']]) await c.post(`/social/${post}/comment`, { body: text }, { page: '/social' });
  await t2.post(`/social/${post}/comment`, { body: '   ' }, { page: '/social' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM social_comments WHERE post_id = ?').get(post).n, 4);
  const feed = (await t1.get('/social')).text;
  assert.match(feed, new RegExp(`<a href="/social/p/${post}">See all 4 comments</a>`)); assert.doesNotMatch(feed, /Nice work/); assert.match(feed, /Looks &lt;b&gt;great&lt;\/b&gt;/);
  assert.match((await t1.get(`/social/p/${post}`)).text, /Nice work[\s\S]*Thanks all/);
  // Removing: a comment by whoever wrote it or whoever owns the post; the post by its owner only (or a moderator).
  const cid = (text) => db.prepare('SELECT id FROM social_comments WHERE body = ?').get(text).id;
  assert.equal((await t2.post(`/social/comment/${cid('Thanks all')}/delete`, {}, { page: '/social' })).status, 403);
  assert.equal((await t1.post(`/social/comment/${cid('Third')}/delete`, {}, { page: '/social' })).status, 302);     // under their own post
  assert.equal((await t2.post(`/social/comment/${cid('Nice work')}/delete`, {}, { page: '/social' })).status, 302); // their own
  assert.equal(db.prepare('SELECT COUNT(*) n FROM social_comments WHERE post_id = ?').get(post).n, 2);
  assert.match((await t2.get('/')).text, /added a photo[\s\S]*\/wall\/photo\//);
  assert.equal((await t2.post(`/social/${post}/delete`, {}, { page: '/social' })).status, 403);
  // Words alone make a post too.
  await t2.post('/social', [['body', 'No picture, just good news']], { multipart: true, page: '/social' });
  assert.match((await t1.get('/social')).text, /No picture, just good news/);

  // The branch page: who's who by department, its shout-outs and photos; only people who manage the branch edit it.
  db.prepare("UPDATE users SET department = 'Service', job_title = 'Lead Tech' WHERE username = 'tech1'").run();
  await t2.post('/shoutouts', { to_user: String(userId('tech1')), message: 'Branch page shout-out' }, { page: '/shoutouts' });
  const list = await t1.get('/branches');                                               // one branch goes straight to it; several are listed
  assert.ok(list.location === '/branches/1' || /href="\/branches\/1"/.test(list.text));
  let page = (await t1.get('/branches/1')).text.replace(/\s+/g, ' ');
  assert.match(page, /Lancaster office<\/h1>/); assert.match(page, /Terry Tech<\/strong><span class="meta">Lead Tech/);
  assert.match(page, /Branch page shout-out/); assert.match(page, /\/wall\/photo\//); assert.doesNotMatch(page, /Edit this page/);
  assert.equal((await t1.post('/branches/1', [['about', 'hacked']], { multipart: true, page: '/branches/1' })).status, 403);
  assert.match((await owner.post('/branches/1', [['phone', 'nope']], { multipart: true, page: '/branches/1?edit=1' })).text, /phone number does not look right/);
  await owner.post('/branches/1', [['address', '1 Main St, Lancaster'], ['phone', '(717) 555-0199'], ['about', 'Serving the <county>.'], ['photo', png()]], { multipart: true, page: '/branches/1?edit=1' });
  page = (await t1.get('/branches/1')).text;
  assert.match(page, /1 Main St, Lancaster/); assert.match(page, /href="tel:7175550199"/); assert.match(page, /Serving the &lt;county&gt;\./); assert.match(page, /class="branch-hero" src="\/branches\/photo\/1\?v=/);
  assert.equal((await t1.get('/branches/photo/1')).headers.get('content-type'), 'image/png');
  assert.match((await t1.get(`/people/${userId('tech1')}`)).text, /<a href="\/branches\/1">Lancaster office<\/a>/);
  assert.equal((await t1.get('/branches/999')).status, 404);

  // The owner removes someone else's post (moderator). Its pictures' files go too.
  const fs3 = require('fs'); const p3 = require('path');
  const file = p3.join(dataDir, 'uploads', db.prepare('SELECT path FROM wall_photos WHERE id = ?').get(ids[0]).path);
  assert.ok(fs3.existsSync(file));
  await owner.post(`/social/${post}/delete`, {}, { page: '/social' });           // the post goes, and both its pictures with it
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reactions WHERE kind = 'social' AND target_id = ?").get(post).n + db.prepare('SELECT COUNT(*) n FROM social_comments WHERE post_id = ?').get(post).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wall_photos').get().n, 0);
  await new Promise((r) => setTimeout(r, 50)); assert.ok(!fs3.existsSync(file));
  db.prepare('DELETE FROM shoutouts').run(); db.prepare("UPDATE users SET department = NULL, job_title = NULL WHERE username = 'tech1'").run();
  db.prepare('UPDATE branches SET address = NULL, phone = NULL, about = NULL, photo_path = NULL WHERE id = 1').run();
});

test('corporate: corporate admins appoint an admin for each office; office admins stay inside their own office', async () => {
  const owner = await loggedIn('owner');                                      // sees every office
  const tech1 = await loggedIn('tech1');
  assert.equal((await tech1.get('/admin/branches')).status, 403);
  assert.ok(profileId('Corporate admin'));
  assert.ok(access.permsOf(profileId('Corporate admin')).has('branches.all'));

  await owner.post('/admin/branches', { name: 'Ephrata office' }, { page: '/admin/branches' });
  const eph = db.prepare("SELECT id FROM branches WHERE name = 'Ephrata'").get().id;      // "office" is not doubled up
  let page = (await owner.get(`/admin/branches?office=${eph}`)).text.replace(/\s+/g, ' ');   // a new, empty office is opened from the list of other offices
  assert.match((await owner.get('/admin/branches')).text, new RegExp(`href="/admin/branches\\?office=${eph}#o${eph}"`));
  assert.match(page, /<h1>Corporate<\/h1>/); assert.match(page, /Ephrata office<\/strong>[\s\S]*This office has no admin of its own yet/);

  // An office's admin is always someone already on the site in that office: here Ed, listed in Ephrata with his sign-in off.
  // (In these checks the profile called Admin can see every office, so an office's admin gets a profile that cannot.)
  const adminProfile = access.ensureProfile('Office admin', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all'));
  const noNew = await owner.post(`/admin/branches/${eph}/admins`, { profile_id: String(adminProfile), display_name: 'Nell New', username: 'nell.new' }, { page: '/admin/branches' });
  assert.match(noNew.text, /Choose someone from that office/); assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username = 'nell.new'").get().n, 0);   // no account is made here any more
  assert.match(noNew.text.replace(/\s+/g, ' '), /Nobody is listed in the Ephrata office yet\. Add its people first/);
  const edId = auth.createUser({ username: 'ed.ephrata', displayName: 'Ed Ephrata', email: 'ed@example.com', password: 'not used until appointed', profile: profileId('Technician'), branchId: eph });
  db.prepare('UPDATE users SET active = 0, in_directory = 1 WHERE id = ?').run(edId);
  const pick = (await owner.get(`/admin/branches?office=${eph}`)).text.replace(/\s+/g, ' ');
  assert.match(pick, new RegExp(`<input name="person" list="office-people-${eph}"[^>]*data-picks-person>`)); assert.match(pick, new RegExp(`<option value="Ed Ephrata" data-id="${edId}"></option>`));
  assert.doesNotMatch(pick, /name="username"|or someone new/);
  assert.match((await owner.post(`/admin/branches/${eph}/admins`, { profile_id: String(profileId('Corporate admin')), user_id: String(edId) }, { page: '/admin/branches' })).text, /Choose which profile they get/);   // not a way to make corporate admins
  await owner.post(`/admin/branches/${eph}/admins`, { profile_id: String(adminProfile), person: 'ed ephrata', user_id: '' }, { page: '/admin/branches' });   // typed in full, as the page sends it without scripts
  const ed = db.prepare("SELECT * FROM users WHERE username = 'ed.ephrata'").get();
  assert.deepEqual([ed.branch_id, ed.profile_id, ed.must_change_password, ed.active], [eph, adminProfile, 1, 1]);   // his sign-in is switched on with a temporary password
  page = (await owner.get('/admin/branches')).text.replace(/\s+/g, ' ');
  const temp = /<strong>Ed Ephrata<\/strong> is now an admin for the Ephrata office[\s\S]*?<p class="code">([a-z0-9-]+)<\/p>/.exec(page)[1];
  assert.doesNotMatch((await owner.get('/admin/branches')).text, new RegExp(temp));                // once only
  assert.match(page, /Ed Ephrata<\/strong><span class="meta">Office admin · has not signed in yet/);

  // Ed signs in, chooses a password, and runs Ephrata: adds his own people, sees nothing of Lancaster, has no Corporate menu.
  const edc = new Client();
  await edc.login('ed.ephrata', temp);
  await edc.post('/account/password', { current: temp, password: 'orchard admin password', confirm: 'orchard admin password' });
  const home = (await edc.get('/')).text;
  assert.match(home, /<span class="branch">Ephrata Office<\/span>/); assert.doesNotMatch(home, /Corporate<|\/admin\/branches|\/admin\/profiles|data-office-pick/);
  await edc.post('/admin/users', { username: 'eph.tech', display_name: 'Tess Ephrata', profile_id: String(profileId('Technician')) }, { page: '/admin/users' });
  assert.equal(db.prepare("SELECT branch_id FROM users WHERE username = 'eph.tech'").get().branch_id, eph);
  const edUsers = (await edc.get('/admin/users')).text;
  assert.match(edUsers, /Tess Ephrata/); assert.doesNotMatch(edUsers, /Terry Tech|Olive Owner/);
  for (const url of ['/admin/branches', '/admin/profiles', '/admin/backups']) assert.equal((await edc.get(url)).status, 403, url);
  for (const [url, body] of [[`/admin/branches/${eph}/admins`, { profile_id: String(adminProfile), user_id: String(userId('eph.tech')) }], ['/admin/corporate/admins', { user_id: String(ed.id), profile_id: String(profileId('Corporate admin')) }], ['/admin/branches', { name: 'Rogue' }]]) {
    assert.equal((await edc.post(url, body, { page: '/' })).status, 403, url);
  }

  // Someone already in the office can be appointed, and stood down again.
  await owner.post(`/admin/branches/${eph}/admins`, { profile_id: String(adminProfile), user_id: String(userId('eph.tech')) }, { page: '/admin/branches' });
  assert.equal(db.prepare("SELECT profile_id FROM users WHERE username = 'eph.tech'").get().profile_id, adminProfile);
  assert.match((await owner.post(`/admin/branches/${eph}/admins`, { profile_id: String(adminProfile), user_id: String(userId('tech1')) }, { page: '/admin/branches' })).text, /Choose someone from that office/);   // Lancaster's Terry cannot be Ephrata's admin
  await owner.post(`/admin/branches/${eph}/admins/${userId('eph.tech')}/remove`, {}, { page: '/admin/branches' });
  assert.equal(db.prepare("SELECT profile_id FROM users WHERE username = 'eph.tech'").get().profile_id, profileId('Technician'));

  // Corporate admins: appointed from existing people; they then see every office. Standing down ends it at once.
  await owner.post('/admin/corporate/admins', { user_id: String(ed.id), profile_id: String(profileId('Corporate admin')) }, { page: '/admin/branches' });
  page = (await owner.get('/admin/branches')).text.replace(/\s+/g, ' ');
  assert.match(page, /Corporate admins and managers<\/h2>[\s\S]*Ed Ephrata<\/strong><span class="meta">Corporate admin · Ephrata office/);
  assert.equal((await edc.get('/admin/branches')).status, 200);
  assert.match((await edc.get('/')).text, /data-office-pick/);
  await edc.post('/branch/view', { branch: 'all' }, { page: '/' });
  assert.match((await edc.get('/admin/users')).text, /Terry Tech/);
  await edc.post(`/admin/corporate/admins/${ed.id}/remove`, {}, { page: '/admin/branches' });      // nobody stands themselves down
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(ed.id).profile_id, profileId('Corporate admin'));
  await owner.post(`/admin/corporate/admins/${ed.id}/remove`, {}, { page: '/admin/branches' });
  assert.notEqual(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(ed.id).profile_id, profileId('Corporate admin'));
  assert.equal((await edc.get('/admin/branches')).status, 302);                                    // signed out, and an office admin again when he returns
  assert.match(db.prepare("SELECT GROUP_CONCAT(action, '|') a FROM activity_log WHERE action LIKE '%admin%'").get().a, /Office admin appointed[\s\S]*Corporate admin appointed[\s\S]*Corporate admin stood down/);

  db.prepare('UPDATE users SET active = 0, in_directory = 0 WHERE branch_id = ?').run(eph);
});

test('company: the office list loads once, offices say what they do, and anyone can find an office by service, state or region', async () => {
  const officeList = require('../app/offices');
  const list = officeList.all();
  assert.equal(list.length, 233);                                             // the internal "Project" lines are not offices
  assert.equal(new Set(list.map((o) => o.name.toLowerCase())).size, 233);    // every office gets a name of its own
  const one = (n) => list.find((o) => o.number === n);
  assert.deepEqual([one('2054').name, one('2054').city, one('2054').state, one('2054').street, one('2054').region], ['Ephrata', 'Ephrata', 'PA', 'Oregon Pike', 'Northeast']);
  assert.deepEqual([one('2104').name, one('2104').services], ['Boise (Alarm)', ['FA', 'SEC']]);          // what the company lists it as doing
  assert.deepEqual([one('2054').marketing, one('2054').market, one('2054').address, one('2054').phone], ['Lancaster', 'NJ/PA/DE', '4139 Oregon Pike, Ste 301, Ephrata, PA 17522', '717-399-3900']);
  assert.ok(!JSON.stringify(list).match(/Sedona|ERP|Rebrand|Reserved|TM1/));                               // accounting and acquisition notes are not carried over
  assert.deepEqual([one('2014').name, one('2014').city], ['Lafayette', 'Broussard']);                    // named for one town, sitting in the next
  assert.deepEqual([one('1293').state, one('1234').city, one('1290').region], ['SD', 'Cranford', 'Midwest']);   // slips in the list do not carry over
  assert.deepEqual([one('2088').name, one('1220').name, one('1295').name], ['Wilmington, DE', 'Wilmington, NC', 'Coral Springs (NW 120th Ave, 1295)']);

  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  // Before anything is loaded the page says so rather than showing an empty company.
  assert.match((await t1.get('/company')).text, /office list has not been loaded yet/);
  assert.equal((await t1.post('/admin/company/offices', {}, { page: '/' })).status, 403);
  const before = db.prepare('SELECT COUNT(*) n FROM branches').get().n;
  const corp = (await owner.get('/admin/branches')).text;
  assert.match(corp, /233 of the company's 233 offices are not on the site yet/); assert.match(corp, /"Lancaster" is already here\. Which office on the company list is it\?/);
  assert.match(corp, /<option value="2054" selected>2054 · Ephrata, PA · Oregon Pike \(known as Lancaster\)/);   // offered as the office that goes by its name
  // Lancaster is the office the list calls Ephrata: it is matched, not added again, and keeps its name and people.
  await owner.post('/admin/company/offices', { is_1: '2054' }, { page: '/admin/branches' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches').get().n, before + 232);
  assert.deepEqual(db.prepare('SELECT name, number, city, state, region FROM branches WHERE id = 1').get(), { name: 'Lancaster', number: '2054', city: 'Ephrata', state: 'PA', region: 'Northeast' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branches WHERE name = 'Ephrata' AND number = '2054'").get().n, 0);
  await owner.post('/admin/company/offices', {}, { page: '/admin/branches' });                              // loading again adds nothing
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches').get().n, before + 232);
  assert.match((await owner.get('/admin/branches')).text, /All 233 offices on the company list are on the site/);
  const boise = db.prepare("SELECT id FROM branches WHERE number = '2104'").get().id;
  assert.deepEqual(db.prepare('SELECT s.code FROM branch_services bs JOIN services s ON s.id = bs.service_id WHERE bs.branch_id = ? ORDER BY s.sort').all(boise), [{ code: 'FA' }, { code: 'SEC' }]);
  assert.deepEqual(db.prepare('SELECT address, phone, market, marketing_name FROM branches WHERE id = 1').get(), { address: '4139 Oregon Pike, Ste 301, Ephrata, PA 17522', phone: '717-399-3900', market: 'NJ/PA/DE', marketing_name: 'Lancaster' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_services WHERE branch_id = 1').get().n, 6);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM inspection_items WHERE branch_id = ?').get(boise).n > 0);   // each new office has its own truck checklist
  // The pages that list offices stay usable: the chooser and the Corporate page show offices in use, not all 233.
  assert.ok(((await owner.get('/')).text.match(/<option value="\d+"/g) || []).length < 45);
  assert.ok(((await owner.get('/admin/branches')).text.match(/class="card stack" id="o\d+"/g) || []).length < 12);
  assert.match((await owner.get('/admin/branches?oq=boise')).text, new RegExp(`href="/admin/branches\\?office=${boise}#o${boise}"`));

  // An office's own admin ticks what it does; nobody else in the office can.
  const svc = (code) => db.prepare('SELECT id FROM services WHERE code = ?').get(code).id;
  assert.equal((await t1.post('/branches/1', [['services_form', '1'], ['services', String(svc('MN'))]], { multipart: true, page: '/branches/1' })).status, 403);
  await owner.post('/branches/1', [['services_form', '1'], ['services', String(svc('FA'))], ['services', String(svc('FE'))], ['services', '999999'], ['address', '1 Oregon Pike'], ['phone', '717-399-3900']], { multipart: true, page: '/branches/1?edit=1' });
  const office = (await t1.get('/branches/1')).text.replace(/\s+/g, ' ');
  assert.match(office, /What this office does<\/strong>[\s\S]*Fire Alarms &amp; Detection <span class="meta">FA<\/span>[\s\S]*Fire Extinguishers/); assert.match(office, /<span class="office-no">2054<\/span>/); assert.match(office, /<dt>Office<\/dt><dd><span class="office-no">2054<\/span> Ephrata, Pennsylvania<\/dd>/); assert.match(office, /<dt>Market<\/dt><dd>NJ\/PA\/DE<\/dd> <dt>Region<\/dt><dd>Northeast<\/dd>/); assert.match(office, /class="btn primary" href="tel:\d+">Call<\/a>/); assert.match(office, />Map<\/a>/);
  assert.match(office, /<dt>Address<\/dt><dd>1 Oregon Pike<\/dd> <dt>Phone<\/dt><dd><a href="tel:7173993900">717-399-3900<\/a><\/dd>/); assert.match(office, /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=1%20Oregon%20Pike"[^>]*>Map<\/a>/);
  await owner.post('/branches/1', [['address', '1 Oregon Pike'], ['phone', '717-399-3900']], { multipart: true, page: '/branches/1?edit=1' });   // saving without the service boxes leaves them alone
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_services WHERE branch_id = 1').get().n, 2);

  // The finder: by service, state, region, and by town or number. Anyone signed in can use it.
  const names = async (qs) => [...(await t1.get('/branches' + qs)).text.matchAll(/<span class="person-text">\s*<strong>([^<]+?)(?: <span class="aka">[^<]*<\/span>)?<\/strong>/g)].map((m) => m[1]);
  assert.ok((await names('')).length >= 233);
  assert.ok((await names(`?service=${svc('FE')}`)).length > 100); assert.deepEqual(await names(`?service=${svc('PVM')}`), ['Rifle', 'Choctaw']);
  assert.ok((await names(`?service=${svc('FA')}`)).includes('Boise (Alarm)'));
  assert.deepEqual(await names('?state=PA'), ['Allentown', 'King of Prussia', 'Lancaster', 'North Wales (Industrial Dr)', 'North Wales (PRPV)']);
  assert.deepEqual(await names(`?state=PA&service=${svc('FS')}`), ['North Wales (Industrial Dr)']);            // Lancaster's own admin unticked sprinklers above
  assert.deepEqual(await names('?q=naples'), ['Bonita Springs']); assert.ok((await names('?q=genetec')).includes('West Monroe'));   // by the name an office goes by, or a product line
  assert.doesNotMatch((await t1.get('/branches?q=naples')).text, /Naples|also known as/);                  // the other name finds the office but is not printed
  assert.deepEqual(await names('?q=2054'), ['Lancaster']); assert.deepEqual(await names('?q=broussard'), ['Lafayette']);
  assert.ok((await names('?region=Southwest')).length >= 20); assert.deepEqual(await names("?q=%27%20OR%201%3D1"), []);
  assert.equal((await new Client().get('/branches')).status, 302);

  // Corporate keeps the list of services, and can load office details from a spreadsheet.
  assert.equal((await t1.post('/admin/company/services', { code: 'X', name: 'Nope' }, { page: '/' })).status, 403);
  await owner.post('/admin/company/services', { code: 'gen', name: 'Generators' }, { page: '/admin/branches' });
  assert.ok(svc('GEN'));
  assert.match((await t1.get(`/branches?service=${svc('GEN')}`)).text, /No office has listed Generators yet/);
  const csv = 'Branch,Services,Phone,About\r\n2102,"FE; Generators",(610) 555-0100,Serves the Lehigh Valley\r\n2085,Unicorns,,\r\n9999,FA,,\r\n';
  await owner.post('/admin/company/details', [['file', new File([csv], 'offices.csv', { type: 'text/csv' })]], { multipart: true, page: '/admin/branches' });
  const note = (await owner.get('/admin/branches')).text;
  assert.match(note, /2 offices updated\. Not recognised as services[^<]*Unicorns[^<]*No office with number: 9999/);
  assert.deepEqual(await names(`?service=${svc('GEN')}`), ['Allentown']);
  assert.deepEqual(db.prepare("SELECT phone, about FROM branches WHERE number = '2102'").get(), { phone: '(610) 555-0100', about: 'Serves the Lehigh Valley' });
  await owner.post(`/admin/company/services/${svc('GEN')}`, { remove: '1' }, { page: '/admin/branches' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM services WHERE code = 'GEN'").get().n, 0);

  // Who to contact: loaded from the prepared file by corporate, read and searched by everyone.
  const file = { format: 'pb-company-contacts-1', contacts: [
    { section: 'HR', group: '', topic: 'General HR inbox', name: '', email: 'askhr@example.com' },
    { section: 'Health & Safety / Fleet', group: 'Fleet', topic: 'Escalations', name: 'Marv <Fleet>', email: 'marv@example.com', note: 'Director of Fleet' },
    { section: 'Regional Layout', group: 'Northeast', topic: 'Regional Vice President', name: 'Robin Vale', email: 'dana@example.com' },
    { section: 'Regional Layout', group: 'Northeast', topic: 'Regional Director', name: 'Sam Carter', email: 'dave@example.com', note: 'NJ | PA | DE' },
    { section: '', name: 'No section' }, { section: 'HR', topic: 'nobody' }] };
  const sendContacts = (c, obj) => c.post('/admin/company/contacts', [['file', new File([JSON.stringify(obj)], 'c.json', { type: 'application/json' })]], { multipart: true, page: '/admin/branches' });
  assert.equal((await sendContacts(t1, file)).status, 403);
  await sendContacts(owner, { format: 'other' }); assert.match((await owner.get('/admin/branches')).text, /not a company contacts file/);
  await sendContacts(owner, file);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_contacts').get().n, 4);
  const contacts = (await t1.get('/contacts')).text;
  assert.match(contacts, /id="hr"[\s\S]*mailto:askhr@example\.com[\s\S]*Fleet<\/h3>[\s\S]*Marv &lt;Fleet&gt;[\s\S]*Director of Fleet/);
  assert.match((await t1.get('/contacts?q=fleet')).text, /Marv/); assert.doesNotMatch((await t1.get('/contacts?q=fleet')).text, /askhr@example/);
  // The main page pulls it together: numbers, services with how many offices, regions with their leaders.
  const main = (await t1.get('/company')).text.replace(/\s+/g, ' ');
  assert.match(main, /<span class="mini-num">\d{3}<\/span><span class="mini-label">Offices<\/span><span class="mini-sub">in 46 states/);
  assert.match(main, /My office<\/span><span class="mini-sub">Lancaster · Northeast/);
  assert.match(main, new RegExp(`href="/branches\\?service=${svc('FE')}"><span class="office-no">FE</span><span class="svc-name">Fire Extinguishers</span><span class="meta">\\d+ offices`));
  assert.match(main, /Northeast<\/strong><time>\d+ offices<\/time>[\s\S]*?Regional Vice President<\/span><br><strong>Robin Vale<\/strong>[\s\S]*?1 regional director[\s\S]*?Sam Carter<\/strong> <span class="meta">NJ \| PA \| DE/);
  assert.match(main, /href="\/contacts#health-safety-fleet"/);

  // Put things back for anything that runs after.
  db.prepare('DELETE FROM company_contacts').run(); db.prepare('DELETE FROM branch_services').run();
  db.prepare("DELETE FROM inspection_items WHERE branch_id IN (SELECT id FROM branches WHERE id <> 1 AND number IS NOT NULL)").run();
  db.prepare('DELETE FROM branches WHERE id <> 1 AND number IS NOT NULL').run();
  db.prepare('UPDATE branches SET number = NULL, city = NULL, state = NULL, street = NULL, region = NULL, address = NULL, phone = NULL, market = NULL, marketing_name = NULL, product_lines = NULL WHERE id = 1').run();
  db.prepare("DELETE FROM services WHERE code = 'GEN'").run();
});

test('your office name sits beside the logo on every page once you are signed in', async () => {
  const t1 = await loggedIn('tech1');
  const label = async (url) => { const m = /<span class="branch">([^<]*)<\/span>/.exec((await t1.get(url)).text); return m ? m[1] : null; };
  for (const url of ['/', '/parts', '/tasks', '/my', '/notices', '/training', '/inspection', '/alerts']) assert.equal(await label(url), 'Lancaster Office', url);
  for (const url of ['/company', '/branches', '/branches/1', '/contacts', '/people', `/people/${userId('tech1')}`, '/profile', '/shoutouts', '/events', '/social', '/discussions', '/daily', '/newsletters']) assert.equal(await label(url), 'Lancaster Office', url);
  assert.match((await t1.get('/company')).text, /<title>Company · Pye-Barker Lancaster Office<\/title>/);
  assert.match((await t1.get('/parts')).text, /<title>Parts · Pye-Barker Lancaster Office<\/title>/);
  const owner = await loggedIn('owner');
  assert.match((await owner.get('/admin/branches')).text, /<span class="branch">Lancaster Office<\/span>/);
  assert.match((await owner.get('/admin/users')).text, /<span class="branch">Lancaster Office<\/span>/);
  assert.match((await new Client().get('/login')).text, /<span class="branch">Employee Portal<\/span>/);
});

test('positions: each person gets a job title from the company list, picked by people who manage users', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  assert.equal((await t1.get('/admin/users/positions')).status, 403);
  assert.equal((await t1.post('/admin/users/positions', { [`job_${userId('tech2')}`]: 'General Manager' }, { page: '/' })).status, 403);
  assert.equal((await t1.post('/admin/users/titles', { new_name: 'Boss' }, { page: '/' })).status, 403);
  // The list starts with the usual management titles; a corporate admin adds to it.
  const titlesNow = () => db.prepare('SELECT name FROM job_titles').all().map((r) => r.name);
  for (const name of ['General Manager', 'Operations Manager', 'Office Manager', 'Installation Manager', 'Service Manager']) assert.ok(titlesNow().includes(name), name);
  const sm = db.prepare("SELECT id FROM job_titles WHERE name = 'Service Manager'").get().id;
  await owner.post('/admin/users/titles', { new_name: 'Lead Service Tech', new_dept: 'Service', new_parent: String(sm) }, { page: '/admin/users/positions' });
  assert.deepEqual(db.prepare("SELECT department, parent_id FROM job_titles WHERE name = 'Lead Service Tech'").get(), { department: 'Service', parent_id: sm });
  const page = (await owner.get('/admin/users/positions')).text;
  const a = userId('tech1'); const b = userId('tech2');
  assert.match(page, new RegExp(`<select name="job_${a}"[^>]*><option value="">None yet</option>[\\s\\S]*?<option value="Lead Service Tech"`));
  assert.doesNotMatch(page, /name="dept_\d+"|name="leads_\d+"/);                              // nothing to type: the title carries the department
  const before = db.prepare('SELECT job_title, department FROM users WHERE id = ?').get(b);
  const r = await owner.post('/admin/users/positions', { [`job_${a}`]: 'Lead Service Tech', [`job_${b}`]: before.job_title || '' }, { page: '/admin/users/positions' });
  assert.equal(r.location, '/admin/users/positions');
  assert.deepEqual(db.prepare('SELECT job_title, department FROM users WHERE id = ?').get(a), { job_title: 'Lead Service Tech', department: 'Service' });
  assert.deepEqual(db.prepare('SELECT job_title, department FROM users WHERE id = ?').get(b), before);   // untouched rows stay as they were
  assert.match((await owner.get('/admin/users/positions')).text, /1 change saved\./);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'Position changed' AND detail LIKE '%Lead Service Tech · Service'").get().n, 1);
  // A title that is not on the list is not accepted.
  await owner.post('/admin/users/positions', { [`job_${a}`]: 'Supreme Leader' }, { page: '/admin/users/positions' });
  assert.equal(db.prepare('SELECT job_title FROM users WHERE id = ?').get(a).job_title, 'Lead Service Tech');
  // A title in use cannot be removed; renaming it carries to the people who hold it; a loop is refused.
  const lst = db.prepare("SELECT id FROM job_titles WHERE name = 'Lead Service Tech'").get().id;
  await owner.post('/admin/users/titles', { [`tname_${lst}`]: 'Lead Service Tech', [`tdept_${lst}`]: 'Service', [`tparent_${lst}`]: String(sm), [`tdel_${lst}`]: '1' }, { page: '/admin/users/positions' });
  assert.match((await owner.get('/admin/users/positions')).text, /Lead Service Tech is still someone&#39;s job title, so it was kept/);
  await owner.post('/admin/users/titles', { [`tname_${sm}`]: 'Service Manager', [`tdept_${sm}`]: 'Management', [`tparent_${sm}`]: String(lst) }, { page: '/admin/users/positions' });
  assert.notEqual(db.prepare('SELECT parent_id FROM job_titles WHERE id = ?').get(sm).parent_id, lst);
  await owner.post('/admin/users/titles', { [`tname_${lst}`]: 'Senior Service Tech', [`tdept_${lst}`]: 'Service', [`tparent_${lst}`]: String(sm) }, { page: '/admin/users/positions' });
  assert.equal(db.prepare('SELECT job_title FROM users WHERE id = ?').get(a).job_title, 'Senior Service Tech');
  // The person's page shows it, with a shortcut for people who can edit and none for those who cannot. Nobody types their own.
  assert.match((await owner.get(`/people/${a}`)).text, new RegExp(`Senior Service Tech · Service[\\s\\S]*href="/admin/users/positions\\?who=${a}">Edit job title and department`));
  assert.doesNotMatch((await t1.get(`/people/${b}`)).text, /admin\/users\/positions/);
  const mine = (await t1.get('/profile')).text;
  assert.match(mine, /Job title<\/span> <strong>Senior Service Tech<\/strong>/); assert.doesNotMatch(mine, /name="job_title"/);
  // Someone who manages users in another office cannot change people here.
  const other = db.prepare('SELECT id FROM branches WHERE id <> 1 ORDER BY id LIMIT 1').get();
  if (other) {
    const hid = db.prepare("SELECT u.id, u.username FROM users u JOIN profiles p ON p.id = u.profile_id WHERE u.branch_id = ? AND u.active = 1 AND p.name = 'Admin' LIMIT 1").get(other.id);
    if (hid) {
      const pid = profileId('Admin'); const had = db.prepare("SELECT 1 FROM profile_permissions WHERE profile_id = ? AND permission = 'branches.all'").get(pid);
      if (!had) {
        const h = await loggedIn(hid.username);
        await h.post('/admin/users/positions', { [`job_${a}`]: 'General Manager' }, { page: '/admin/users/positions' });
        assert.equal(db.prepare('SELECT job_title FROM users WHERE id = ?').get(a).job_title, 'Senior Service Tech');
        assert.equal((await h.post('/admin/users/titles', { new_name: 'Sneaky Title' }, { page: '/admin/users/positions' })).status, 403);   // the list is corporate's
      }
    }
  }
});

test('Teams: a chat button for people whose work email is shown on their profile, and nobody else', async () => {
  const t1 = await loggedIn('tech1'); const a = userId('tech2');
  const was = db.prepare('SELECT email, show_email FROM users WHERE id = ?').get(a);
  db.prepare("UPDATE users SET email = 'tech.two@example.com', show_email = 1 WHERE id = ?").run(a);
  const link = /href="https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=tech\.two%40example\.com" target="_blank" rel="noopener noreferrer"/;
  assert.match((await t1.get(`/people/${a}`)).text, new RegExp(link.source + '>Chat in Teams'));
  assert.match((await t1.get('/people')).text, new RegExp('class="teams-mini" ' + link.source));
  assert.doesNotMatch((await (await loggedIn('tech2')).get(`/people/${a}`)).text, /Chat in Teams/);   // not on your own page
  db.prepare('UPDATE users SET show_email = 0 WHERE id = ?').run(a);
  assert.doesNotMatch((await t1.get(`/people/${a}`)).text, /teams\.microsoft|tech\.two/);
  assert.doesNotMatch((await t1.get('/people')).text, /tech\.two/);
  db.prepare('UPDATE users SET email = ?, show_email = ? WHERE id = ?').run(was.email, was.show_email, a);
});

test('tasks: the person doing one sets where it stands and leaves notes without closing it; the manager sees them and can answer', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  await owner.post('/admin/tasks', [['title', 'STATUS-TEST order strobes'], ['to', String(userId('tech1'))]], { page: '/admin/tasks' });
  const tid = db.prepare("SELECT id FROM tasks WHERE title = 'STATUS-TEST order strobes'").get().id;
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(tid).status, 'new');
  assert.match((await t1.get('/tasks')).text, /<span class="tag st-new">Not started<\/span>/);
  // Someone else cannot update it.
  assert.equal((await t2.post(`/tasks/${tid}/update`, { status: 'progress', note: 'mine now' }, { page: '/tasks' })).status, 403);
  // An update: status and a note. The task stays open.
  assert.equal((await t1.post(`/tasks/${tid}/update`, { status: 'waiting', note: 'Vendor says <b>Thursday</b>' }, { page: '/tasks' })).location, `/tasks#t${tid}`);
  assert.deepEqual(db.prepare('SELECT status, done_at FROM tasks WHERE id = ?').get(tid), { status: 'waiting', done_at: null });
  const mine = (await t1.get('/tasks')).text.replace(/\s+/g, ' ');
  assert.match(mine, /<span class="tag st-waiting">Waiting<\/span>/);
  assert.match(mine, /set to <strong>Waiting<\/strong><\/span><span class="note-body">Vendor says &lt;b&gt;Thursday&lt;\/b&gt;<\/span>/);
  // A note alone, and an unknown status is ignored.
  await t1.post(`/tasks/${tid}/update`, { status: 'bogus', note: 'Still waiting' }, { page: '/tasks' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(tid).status, 'waiting');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_notes WHERE task_id = ?').get(tid).n, 2);
  // The same note sent again straight away (a double tap on a slow connection) is not saved twice.
  await t1.post(`/tasks/${tid}/update`, { status: 'waiting', note: 'Still waiting' }, { page: '/tasks' });
  await t1.post(`/tasks/${tid}/update`, { status: 'waiting', note: 'Still waiting' }, { page: '/tasks' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_notes WHERE task_id = ?').get(tid).n, 2);
  // The manager sees the status and the latest note in the list, the whole thread on the task, and can answer.
  const list = (await owner.get('/admin/tasks')).text.replace(/\s+/g, ' ');
  assert.match(list, /STATUS-TEST order strobes<\/strong><br><span class="hint">Latest note: Still waiting \(Terry Tech,/);
  assert.match(list, /<span class="tag st-waiting">Waiting<\/span>/);
  await owner.post(`/admin/tasks/${tid}/note`, { note: 'Use the other supplier' }, { page: `/admin/tasks/${tid}` });
  assert.match((await owner.get(`/admin/tasks/${tid}`)).text, /Vendor says[\s\S]*Still waiting[\s\S]*Use the other supplier/);
  assert.match((await t1.get('/tasks')).text, /Olive Owner ·[\s\S]*Use the other supplier/);
  assert.equal((await t2.post(`/admin/tasks/${tid}/note`, { note: 'x' }, { page: '/' })).status, 403);
  // Choosing Finished closes it, with the note kept.
  assert.equal((await t1.post(`/tasks/${tid}/update`, { status: 'done', note: 'Arrived and installed' }, { page: '/tasks' })).location, '/tasks');
  const row = db.prepare('SELECT done_at, done_note FROM tasks WHERE id = ?').get(tid);
  assert.ok(row.done_at); assert.equal(row.done_note, 'Arrived and installed');
  assert.match((await t1.get('/tasks')).text.replace(/\s+/g, ' '), /<span class="tag return">Finished<\/span><strong>STATUS-TEST order strobes/);
  // Removing the task removes its notes.
  await owner.post(`/admin/tasks/${tid}/delete`, {}, { page: `/admin/tasks/${tid}` });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_notes WHERE task_id = ?').get(tid).n, 0);
});

test('idle lock: counts from the last thing the person did, so typing for a while does not lock the site on Save', async () => {
  const t1 = await loggedIn('tech1');
  const sess = () => { const rows = db.prepare('SELECT sid, data FROM sessions').all().map((r) => ({ sid: r.sid, d: JSON.parse(r.data) })); return rows.filter((r) => r.d.userId === userId('tech1')).pop(); };
  const age = (ms) => { const r = sess(); r.d.seenAt = Date.now() - ms; db.prepare('UPDATE sessions SET data = ? WHERE sid = ?').run(JSON.stringify(r.d), r.sid); };
  // Four minutes into writing: the page's "still here" call resets the clock.
  age(4 * 60000);
  assert.equal((await t1.get('/alive')).status, 204);
  assert.ok(Date.now() - sess().d.seenAt < 5000);
  assert.equal((await t1.get('/profile')).status, 200);
  // The page's background check for new alerts returns the header with its counts, and does not count as activity.
  age(3 * 60000);
  const pulse = await t1.get('/pulse');
  assert.equal(pulse.status, 200); assert.match(pulse.text, /id="bell"/); assert.match(pulse.text, /id="tabbar"/);
  assert.ok(Date.now() - sess().d.seenAt > 2.9 * 60000);
  assert.equal((await new Client().get('/pulse')).status, 401);
  // Truly idle past the limit: locked, and the call says so without unlocking anything.
  age(11 * 60000);
  assert.equal((await t1.get('/alive')).status, 302);
  assert.equal((await t1.get('/pulse')).status, 302);            // locked: the background check gets nothing either
  assert.equal((await t1.get('/profile')).location, '/unlock?next=%2Fprofile');
  assert.equal((await new Client().get('/alive')).status, 401);
});

test('reactions: on discussion messages and announcements, one of each per person, taken back with a second press', async () => {
  const owner = await loggedIn('owner'); const t2 = await loggedIn('tech2');
  const react = (c, kind, id, emoji, page) => c.post('/react', { kind, id: String(id), emoji }, { page });
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY sort_order LIMIT 1').get().id;
  await owner.post('/discussions/new', { section_id: String(sec), title: 'REACT-TEST thread', body: 'Anyone seen this fault?' }, { page: '/discussions/new', multipart: true });
  const thread = db.prepare("SELECT id FROM forum_threads WHERE title = 'REACT-TEST thread'").get().id;
  const post = db.prepare('SELECT id FROM forum_posts WHERE thread_id = ?').get(thread).id;
  const tp = `/discussions/t/${thread}`;
  assert.equal((await react(t2, 'post', post, 'like', tp)).location, `${tp}#p${post}`);
  await react(owner, 'post', post, 'like', tp); await react(owner, 'post', post, 'thanks', tp);
  await react(t2, 'post', post, 'nonsense', tp); await react(t2, 'post', 999999, 'like', tp);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reactions WHERE kind = 'post' AND target_id = ?").get(post).n, 3);
  const page = (await t2.get(tp)).text.replace(/\s+/g, ' ');
  assert.match(page, /<button class="react on" type="submit" name="emoji" value="like" aria-pressed="true" title="Like: Uma Tech, Olive Owner" data-who="👍 Like: Olive Owner, Uma Tech"><span aria-hidden="true">👍<\/span><span>2<\/span>/);
  assert.match(page, /<button class="react " type="submit" name="emoji" value="thanks" aria-pressed="false" title="Thanks: Olive Owner" data-who="🙏 Thanks: Olive Owner">/);
  // Reactions nobody has given are not laid out under the message: they sit behind one "React" button.
  const shown = /<form method="post" action="\/react" class="reactions">[\s\S]*?<details class="react-more">/.exec(page)[0];
  assert.doesNotMatch(shown, /value="laugh"|value="love"|value="party"/);
  assert.match(page, /<summary class="react add" title="Add a reaction">[\s\S]*?<span>React<\/span><\/summary> <div class="react-pick"[\s\S]*?<button class="react pick " type="submit" name="emoji" value="laugh"/);
  await react(t2, 'post', post, 'like', tp);                                   // a second press takes it back
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reactions WHERE kind = 'post' AND target_id = ? AND emoji = 'like'").get(post).n, 1);
  // Announcements: only ones this person can see.
  await owner.post('/admin/announcements', { title: 'REACT-TEST notice', body: 'Cookout Friday', audience: 'all', category: 'general' }, { page: '/admin/announcements' });
  const nid = db.prepare("SELECT id FROM announcements WHERE title = 'REACT-TEST notice'").get().id;
  assert.equal((await react(t2, 'notice', nid, 'party', '/notices')).location, `/notices#n${nid}`);
  assert.match((await t2.get('/notices')).text, /value="party" aria-pressed="true" title="Congratulations: Uma Tech"/);
  const other = db.prepare("SELECT u.username FROM users u WHERE u.branch_id IS NOT NULL AND u.branch_id <> 1 AND u.active = 1 LIMIT 1").get();
  db.prepare('UPDATE announcements SET branch_id = 1 WHERE id = ?').run(nid);
  if (other) assert.equal((await react(await loggedIn(other.username), 'notice', nid, 'like', '/notices')).status, 403);
  assert.equal((await react(t2, 'thing', 1, 'like', '/')).status, 403);
  assert.equal((await new Client().post('/react', { kind: 'post', id: String(post), emoji: 'like' }, { csrf: false })).status, 403);
  // Removing the thing removes its reactions.
  await owner.post(`/admin/announcements/${nid}/delete`, {}, { page: '/admin/announcements' });
  await owner.post(`${tp}/delete`, {}, { page: tp });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reactions WHERE (kind = 'notice' AND target_id = ?) OR (kind = 'post' AND target_id = ?)").get(nid, post).n, 0);
});

test('vehicle inspection as a task: assigned by a manager, finished only by sending the inspection with all six photos', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  // No title needed; it goes to people who can send inspections.
  await owner.post('/admin/tasks', [['kind', 'inspection'], ['to', String(userId('tech1'))]], { page: '/admin/tasks' });
  const task = db.prepare("SELECT * FROM tasks WHERE kind = 'inspection' AND assigned_to = ? ORDER BY id DESC").get(userId('tech1'));
  assert.equal(task.title, 'Vehicle inspection');
  const tid = task.id;
  const mine = (await t1.get('/tasks')).text;
  assert.match(mine, new RegExp(`href="/inspection\\?task=${tid}">Do the vehicle inspection`));
  // It cannot be ticked off by hand.
  await t1.post(`/tasks/${tid}/update`, { status: 'done', note: 'done it honest' }, { page: '/tasks' });
  await t1.post(`/tasks/${tid}/done`, {}, { page: '/tasks' });
  assert.equal(db.prepare('SELECT done_at FROM tasks WHERE id = ?').get(tid).done_at, null);
  // A note and a status are still fine.
  await t1.post(`/tasks/${tid}/update`, { status: 'progress', note: 'Truck is out until 2' }, { page: '/tasks' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(tid).status, 'progress');
  // The form asks for the six photos, and only for the person the task belongs to.
  const page = `/inspection?task=${tid}`;
  const form = (await t1.get(page)).text;
  for (const k of ['front', 'rear', 'driver', 'passenger', 'cab', 'back']) assert.match(form, new RegExp(`name="shot_${k}"[^>]* required`));
  assert.doesNotMatch((await t2.get(page)).text, /name="shot_front"/);
  const items = db.prepare('SELECT id FROM inspection_items WHERE active = 1 AND branch_id = 1').all();
  const base = () => { const f = { task: String(tid), truck: '309', odometer: '84400' }; for (const it of items) f[`item_${it.id}`] = 'ok'; return f; };
  const img = () => new Blob([PNG], { type: 'image/png' });
  const before = db.prepare('SELECT COUNT(*) n FROM inspections').get().n;
  // Five of six: refused, nothing saved, task still open.
  const five = base(); for (const k of ['front', 'rear', 'driver', 'passenger', 'cab']) five[`shot_${k}`] = img();
  const bad = await t1.post('/inspection', five, { page, multipart: true });
  assert.equal(bad.status, 400); assert.match(bad.text, /Add the photo: Rear interior\./);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inspections').get().n, before);
  assert.equal(db.prepare('SELECT done_at FROM tasks WHERE id = ?').get(tid).done_at, null);
  // All six: saved with their labels, and the task is finished and linked to the inspection.
  const six = base(); for (const k of ['front', 'rear', 'driver', 'passenger', 'cab', 'back']) six[`shot_${k}`] = img();
  const ok = await t1.post('/inspection', six, { page, multipart: true });
  assert.equal(ok.location, '/tasks');
  const done = db.prepare('SELECT done_at, inspection_id FROM tasks WHERE id = ?').get(tid);
  assert.ok(done.done_at); assert.ok(done.inspection_id);
  assert.deepEqual(db.prepare('SELECT label FROM inspection_photos WHERE inspection_id = ? ORDER BY id').all(done.inspection_id).map((r) => r.label),
    ['Front of the vehicle', 'Rear of the vehicle', 'Driver side', 'Passenger side', 'Front interior', 'Rear interior']);
  const list = (await owner.get('/admin/tasks?show=done')).text;
  assert.match(list, new RegExp(`</strong> <a href="/admin/inspections/${done.inspection_id}">See the inspection`));
  assert.match((await owner.get(`/admin/inspections/${done.inspection_id}`)).text, /<span>Front interior<\/span>/);
  // An ordinary inspection still needs no photos.
  const plain = base(); delete plain.task;
  assert.equal((await t1.post('/inspection', plain, { page: '/inspection', multipart: true })).location, '/my?sent=inspection');
  // It cannot be given to someone whose profile cannot send inspections.
  const noInspect = db.prepare(`SELECT u.id, u.display_name FROM users u WHERE u.active = 1 AND u.branch_id = 1 AND u.is_master = 0 AND NOT EXISTS
    (SELECT 1 FROM profile_permissions pp WHERE pp.profile_id = u.profile_id AND pp.permission = 'inspections.submit') LIMIT 1`).get();
  if (noInspect) {
    const r = await owner.post('/admin/tasks', [['kind', 'inspection'], ['to', String(noInspect.id)]], { page: '/admin/tasks' });
    assert.equal(r.status, 400); assert.match(r.text, /cannot send vehicle inspections with their profile/);
  }
});

test('bell: a discussion with new replies is listed by name and opens at the newest reply', async () => {
  const owner = await loggedIn('owner'); const t2 = await loggedIn('tech2');
  const total = (html) => { const m = /class="bell-count">(\d+)</.exec(html); return m ? Number(m[1]) : 0; };
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY sort_order LIMIT 1').get().id;
  const before = total((await owner.get('/')).text);
  await owner.post('/discussions/new', { section_id: String(sec), title: 'BELL-LINK thread', body: 'Question' }, { page: '/discussions/new', multipart: true });
  const thread = db.prepare("SELECT id FROM forum_threads WHERE title = 'BELL-LINK thread'").get().id;
  await t2.post(`/discussions/t/${thread}/reply`, { body: 'An answer' }, { page: `/discussions/t/${thread}`, multipart: true });
  const last = db.prepare('SELECT MAX(id) id FROM forum_posts WHERE thread_id = ?').get(thread).id;
  const home = (await owner.get('/')).text;
  assert.equal(total(home), before + 1);
  assert.match(home, new RegExp(`<p class="bell-title">New replies</p>\\s*<a href="/discussions/t/${thread}#p${last}" class="bell-task is-new">[\\s\\S]*?<strong>BELL-LINK thread</strong><span class="bell-due">Uma Tech replied</span>`));
  assert.doesNotMatch(home, /discussions? with new replies/);                       // no bare count pointing at the front page
  // Opening it clears it, on that page too.
  const opened = (await owner.get(`/discussions/t/${thread}`)).text;
  assert.equal(total(opened), before); assert.doesNotMatch(/id="bell"[\s\S]*?<\/details>/.exec(opened)[0], /BELL-LINK thread/);
  assert.equal(total((await owner.get('/')).text), before);
  await owner.post(`/discussions/t/${thread}/delete`, {}, { page: `/discussions/t/${thread}` });
});

test('sales: leads seen only by sales, owned by one person, guarded against doubling up, and followed up', async () => {
  const mk = (username, name, profile, branch) => { const id = makeUser(username, name); db.prepare('UPDATE users SET profile_id = ?, branch_id = ? WHERE id = ?').run(profileId(profile), branch, id); return id; };
  const other = db.prepare('SELECT id, name FROM branches WHERE id <> 1 ORDER BY id LIMIT 1').get() || { id: db.prepare("INSERT INTO branches (name, created_at) VALUES ('Sales Test Office', ?)").run(new Date().toISOString()).lastInsertRowid, name: 'Sales Test Office' };
  const sam = mk('sales1', 'Sam Seller', 'Sales', 1); mk('sales2', 'Sally Seller', 'Sales', 1); mk('salesmgr', 'Mona Salesmanager', 'Sales manager', 1); mk('sales3', 'Otto Otheroffice', 'Sales', other.id);
  const s1 = await loggedIn('sales1'); const s2 = await loggedIn('sales2'); const mgr = await loggedIn('salesmgr'); const s3 = await loggedIn('sales3');
  const t1 = await loggedIn('tech1');
  // Nobody outside sales sees any of it: no menu entry, no pages. That includes an office admin's starting profile.
  assert.doesNotMatch((await t1.get('/')).text, /href="\/sales"/);
  for (const url of ['/sales', '/sales/1', '/sales/check?company=acme', '/sales.csv']) assert.equal((await t1.get(url)).status, 403, url);
  assert.equal((await t1.post('/sales', { company: 'Sneaky' }, { page: '/' })).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM profile_permissions pp JOIN profiles p ON p.id = pp.profile_id WHERE pp.permission LIKE 'sales.%' AND p.name IN ('Technician', 'Warehouse', 'Manager')").get().n, 0);
  assert.match((await s1.get('/')).text, /<a href="\/sales"[^>]*>Sales/);

  // Adding a lead: it belongs to the person who added it.
  assert.equal((await s1.post('/sales', { company: '' }, { page: '/sales' })).status, 400);
  const add = await s1.post('/sales', { company: 'Acme Bakery, Inc.', contact_name: 'Pat Baker', phone: '(717) 555-0100', email: 'pat@acme.example', address: '12 Main St, Lititz', interest: 'Kitchen hood', source: 'Referral', value: '4,500', next_on: ymdFromNow(-1), note: 'Met at the chamber lunch' }, { page: '/sales' });
  const lead = db.prepare("SELECT * FROM leads WHERE company = 'Acme Bakery, Inc.'").get();
  assert.equal(add.location, `/sales/${lead.id}`);
  assert.deepEqual([lead.owner_id, lead.branch_id, lead.value, lead.stage], [sam, 1, 4500, 'new']);
  // A colleague about to add the same customer is told who has it, by name, phone or email, and must tick a box to go on.
  const check = JSON.parse((await s2.get('/sales/check?company=acme%20bakery')).text).matches;
  assert.equal(check.length, 1); assert.deepEqual([check[0].owner, check[0].why, check[0].url], ['Sam Seller', 'same name', `/sales/${lead.id}`]);
  assert.equal(JSON.parse((await s2.get('/sales/check?company=Zed&phone=717-555-0100')).text).matches[0].why, 'same phone number');
  const dup = await s2.post('/sales', { company: 'ACME Bakery' }, { page: '/sales' });
  assert.equal(dup.status, 400); assert.match(dup.text, /already working/); assert.match(dup.text, /Sam Seller · Lancaster · New/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads').get().n, 1);
  // Another office sees that the customer is taken, and by whom, but cannot open the lead.
  const far = JSON.parse((await s3.get('/sales/check?company=Acme%20Bakery')).text).matches;
  assert.deepEqual([far[0].owner, far[0].office, far[0].url], ['Sam Seller', 'Lancaster', null]);
  assert.equal((await s3.get(`/sales/${lead.id}`)).status, 403);
  assert.doesNotMatch((await s3.get('/sales?show=all')).text, /Acme Bakery/);

  // The follow-up date has passed: it counts on the owner's bell and shows on their board.
  assert.match((await s1.get('/')).text, /href="\/sales\?show=due"><span class="bell-n">1<\/span><span>lead to follow up/);
  assert.match((await s1.get('/sales?show=due')).text, /Acme Bakery, Inc\.[\s\S]*Follow-up overdue/);
  assert.doesNotMatch((await s2.get('/')).text, /lead to follow up/);
  // A colleague can read it and leave a note, but not change it; the owner and the manager can.
  const page = `/sales/${lead.id}`;
  assert.match((await s2.get(page)).text, /This is Sam Seller's lead/);
  assert.equal((await s2.post(`${page}/stage`, { stage: 'won' }, { page })).status, 403);
  assert.equal((await s2.post(page, { company: 'Mine now' }, { page })).status, 403);
  await s2.post(`${page}/note`, { note: 'I know the owner, happy to introduce you' }, { page });
  await s1.post(`${page}/stage`, { stage: 'quoted', next_on: ymdFromNow(7) }, { page });
  assert.deepEqual(db.prepare('SELECT stage, next_on FROM leads WHERE id = ?').get(lead.id), { stage: 'quoted', next_on: ymdFromNow(7) });
  assert.doesNotMatch((await s1.get('/')).text, /lead to follow up/);
  const detail = (await s1.get(page)).text;
  assert.match(detail, /Met at the chamber lunch[\s\S]*happy to introduce you[\s\S]*Moved to Quote sent/);
  // Handing over, then winning it.
  await s1.post(`${page}/owner`, { owner: String(userId('sales2')) }, { page });
  assert.equal(db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(lead.id).owner_id, userId('sales2'));
  assert.equal((await s1.post(`${page}/stage`, { stage: 'lost' }, { page })).status, 403);            // no longer Sam's
  await mgr.post(`${page}/stage`, { stage: 'won' }, { page });                                          // the manager can
  const won = db.prepare('SELECT stage, closed_at, next_on FROM leads WHERE id = ?').get(lead.id);
  assert.equal(won.stage, 'won'); assert.ok(won.closed_at); assert.equal(won.next_on, null);
  assert.match((await mgr.get('/sales')).text.replace(/\s+/g, ' '), /<span class="mini-num">1<\/span><span class="mini-label">Won this month<\/span><span class="mini-sub">\$4,500 estimated/);

  // Passing a lead to another office: it leaves this office's list and arrives there with nobody on it.
  await s1.post('/sales', { company: 'Sprinkler Job LLC', anyway: '1' }, { page: '/sales' });
  const sj = db.prepare("SELECT id FROM leads WHERE company = 'Sprinkler Job LLC'").get().id;
  await s1.post(`/sales/${sj}/refer`, { office: String(other.id), why: 'They need sprinkler work' }, { page: `/sales/${sj}` });
  assert.deepEqual(db.prepare('SELECT branch_id, owner_id FROM leads WHERE id = ?').get(sj), { branch_id: other.id, owner_id: null });
  assert.equal((await s1.get(`/sales/${sj}`)).status, 403);
  assert.match((await s3.get(`/sales/${sj}`)).text, /Nobody is on this lead yet[\s\S]*Passed from the Lancaster office/);
  await s3.post(`/sales/${sj}/owner`, { owner: 'me' }, { page: `/sales/${sj}` });
  assert.equal(db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(sj).owner_id, userId('sales3'));

  await s1.post('/sales', { company: 'Corner Deli', address: '9 Main St, Lititz' }, { page: '/sales' });
  const deli = db.prepare("SELECT id FROM leads WHERE company = 'Corner Deli'").get().id;

  // Amounts can carry cents; they are stored and shown as typed, with cents only when there are any.
  await s1.post('/sales', { company: 'Cents Customer', value: '1,250.5' }, { page: '/sales' });
  const cents = db.prepare("SELECT id, value FROM leads WHERE company = 'Cents Customer'").get();
  assert.equal(cents.value, 1250.5);
  assert.match((await s1.get(`/sales/${cents.id}`)).text, /\$1,250\.50 estimated/);
  assert.match((await s1.get(`/sales/${lead.id}`)).text, /\$4,500 estimated/);
  assert.equal((await s1.post('/sales', { company: 'Bad Amount', value: '12.345' }, { page: '/sales' })).status, 400);
  db.prepare('DELETE FROM leads WHERE id = ?').run(cents.id);

  assert.equal((await s1.get('/sales/territories')).status, 404);          // territories were taken out

  // --- Quotes, and the day they went out.
  const dp = `/sales/${deli}`;
  await s1.post(`${dp}/stage`, { stage: 'quoted', quote_amount: '3,200', next_on: ymdFromNow(30) }, { page: dp });
  const quoted = db.prepare('SELECT quote_amount, quoted_on, stage FROM leads WHERE id = ?').get(deli);
  assert.deepEqual([quoted.quote_amount, quoted.stage, quoted.quoted_on], [3200, 'quoted', ymdFromNow(0)]);
  // --- My day: a quote that has waited a week, a lead gone quiet, and one nobody is on.
  db.prepare('UPDATE leads SET quoted_on = ? WHERE id = ?').run(ymdFromNow(-9), deli);
  await s1.post('/sales', { company: 'Quiet Customer' }, { page: '/sales' });
  const quiet = db.prepare("SELECT id FROM leads WHERE company = 'Quiet Customer'").get().id;
  db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 16 * 86400000).toISOString(), quiet);
  let day = (await s1.get('/sales')).text.replace(/\s+/g, ' ');
  assert.match(day, /id="day-h">My day<[\s\S]*Quotes waiting on an answer[\s\S]*Corner Deli[\s\S]*Quoted \d+\/\d+\/\d{4}, \$3,200[\s\S]*Gone quiet[\s\S]*Quiet Customer[\s\S]*Quiet for 1[56] days/);
  // After 30 quiet days a colleague may take it, and the old owner is not locked in for good.
  assert.equal((await s2.post(`/sales/${quiet}/owner`, { owner: 'me' }, { page: `/sales/${quiet}` })).status, 403);
  db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86400000).toISOString(), quiet);
  assert.match((await s2.get(`/sales/${quiet}`)).text, /no activity for 3[01] days[\s\S]*Take this lead/);
  await s2.post(`/sales/${quiet}/owner`, { owner: 'me' }, { page: `/sales/${quiet}` });
  assert.equal(db.prepare('SELECT owner_id FROM leads WHERE id = ?').get(quiet).owner_id, userId('sales2'));
  assert.match((await s2.get(`/sales/${quiet}`)).text, /Took this lead from Sam Seller after 3[01] quiet days/);

  // --- Repeat work: won with a date it comes round again; near that date it is on the owner's day and bell, and one press starts the new lead.
  await s1.post(`${dp}/stage`, { stage: 'won', renew_on: ymdFromNow(20) }, { page: dp });
  assert.match((await s1.get('/')).text, /href="\/sales\?show=due"><span class="bell-n">1<\/span><span>lead to follow up/);
  assert.match((await s1.get('/sales')).text.replace(/\s+/g, ' '), /Repeat work coming round[\s\S]*Corner Deli[\s\S]*Due again/);
  const renewed = await s1.post(`${dp}/renew`, {}, { page: dp });
  const fresh = db.prepare("SELECT * FROM leads WHERE company = 'Corner Deli' AND id <> ?").get(deli);
  assert.equal(renewed.location, `/sales/${fresh.id}`);
  assert.deepEqual([fresh.stage, fresh.owner_id, fresh.source, fresh.next_on, fresh.address], ['new', sam, 'Existing customer', ymdFromNow(20), '9 Main St, Lititz']);
  assert.equal(db.prepare('SELECT renewed_as FROM leads WHERE id = ?').get(deli).renewed_as, fresh.id);
  await s1.post(`${dp}/renew`, {}, { page: dp });                                                           // pressing again makes no second copy
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE company = 'Corner Deli'").get().n, 2);

  // --- Referral credit: the lead passed to the other office is won there, and the person who passed it is named.
  await s3.post(`/sales/${sj}/stage`, { stage: 'won' }, { page: `/sales/${sj}` });
  const credit = (await s3.get(`/sales/${sj}`)).text;
  assert.match(credit, /<dt>Passed on by<\/dt><dd>Sam Seller · Lancaster office<\/dd>/); assert.match(credit, /Thank you to Sam Seller in the Lancaster office for passing it on/);

  // --- The manager's summary.
  assert.equal((await s1.get('/sales/summary')).status, 403);
  const sum = (await mgr.get('/sales/summary')).text.replace(/\s+/g, ' ');
  assert.match(sum, /Win rate[\s\S]*By salesperson[\s\S]*Sam Seller/); assert.match(sum, /Where leads came from/); assert.match(sum, /Why we lost/);

  // --- The shared library: managers add, everyone on sales downloads, nobody else gets near it.
  const lib = '/sales/library';
  assert.equal((await s1.post(lib, { title: 'Sneaky', link: 'https://example.com/x' }, { page: lib, multipart: true })).status, 403);
  assert.equal((await mgr.post(lib, { title: 'No file' }, { page: lib, multipart: true })).status, 400);
  assert.equal((await mgr.post(lib, { title: 'Bad link', link: 'javascript:alert(1)' }, { page: lib, multipart: true })).status, 400);
  assert.equal((await mgr.post(lib, { title: 'A script', file: new File(['<script>'], 'x.html', { type: 'text/html' }) }, { page: lib, multipart: true })).status, 400);
  await mgr.post(lib, { title: 'Hood service sheet', note: 'Leave with the customer', file: new File([tinyPdf()], 'sheet.pdf', { type: 'application/pdf' }) }, { page: lib, multipart: true });
  await mgr.post(lib, { title: 'Company site', link: 'https://example.com/services' }, { page: lib, multipart: true });
  const fileRow = db.prepare("SELECT id FROM sales_files WHERE title = 'Hood service sheet'").get();
  const libPage = (await s3.get(lib)).text;                                                                 // another office's sales team sees it too
  assert.match(libPage, new RegExp(`Hood service sheet[\\s\\S]*href="/sales/library/${fileRow.id}"[^>]*>Download`)); assert.match(libPage, /href="https:\/\/example\.com\/services" target="_blank"/);
  assert.doesNotMatch(libPage, /Add to the library/);
  const dl = await s1.get(`/sales/library/${fileRow.id}`);
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /attachment; filename="Hood service sheet\.pdf"/); assert.match(dl.text, /^%PDF-/);
  for (const url of [lib, `/sales/library/${fileRow.id}`, '/sales/summary']) assert.equal((await t1.get(url)).status, 403, url);
  await mgr.post(`/sales/library/${fileRow.id}/delete`, {}, { page: lib });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sales_files').get().n, 1);
  db.prepare('DELETE FROM sales_files').run();

  // Export and removal are for the sales manager.
  assert.equal((await s1.get('/sales.csv')).status, 403);
  const csv = await mgr.get('/sales.csv');
  assert.equal(csv.status, 200); assert.match(csv.text, /Acme Bakery/); assert.doesNotMatch(csv.text, /Sprinkler Job/);
  assert.equal((await s1.post(`${page}/delete`, {}, { page })).status, 403);
  await mgr.post(`${page}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE id = ?').get(lead.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_notes WHERE lead_id = ?').get(lead.id).n, 0);
  db.prepare('DELETE FROM lead_notes'); db.prepare('DELETE FROM leads').run();
});

test('on call: the rota is loaded from the spreadsheet, everyone sees who is on call now, and several people can share a shift', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  const oncall = require('../app/oncall');
  const today = ymdFromNow(0);
  // The sheet as the office keeps it: a year, a heading line, then a line per stretch. Dates roll over year ends by themselves.
  const sheet = ['2027,,,,11/13/2026', ',,,,', '2027,,Technician,Manager,Holiday', ',,,,',
    'December,28-Jan. 04,D. Marlow 717-555-0121,T. Weller 717-555-0122,New Years Eve',
    'January,04-11,J. Zane 717-555-0123,D. Archer 717-555-0124,',
    'January,25-Feb 01,P. Castell 717-555-0125,,',
    'February,22-MAR 01,M. Stone 717-555-0126,J. Nolan 717-555-0127,',
    'May,17-24,M. Wynn,J. Nolan 717-555-0127,',
    'June ,28- July 06,P. Calder 717-555-0128,J. Nolan 717-555-0127,Independence Day',
    'October,18-25,"M. Mcdowell 717-555-0129\n",T. Weller 717-555-0122,',
    'December,27-JAN 03,C. McCall 717-555-0130,S. Avery 717-555-0131,New Years Eve',
    'January,03-10,M. Stone 717-555-0126,J. Mercer 717-555-0132,'].join('\n');
  const read = oncall.parseSheet(require('../app/routes/catalog').parseCsv(sheet));
  assert.deepEqual(read.problems, []);
  assert.deepEqual([...new Set(read.shifts.map((x) => `${x.start_on}>${x.end_on}`))], ['2026-12-28>2027-01-04', '2027-01-04>2027-01-11', '2027-01-25>2027-02-01', '2027-02-22>2027-03-01',
    '2027-05-17>2027-05-24', '2027-06-28>2027-07-06', '2027-10-18>2027-10-25', '2027-12-27>2028-01-03', '2028-01-03>2028-01-10']);
  assert.deepEqual(read.shifts.find((x) => x.name === 'M. Wynn'), { start_on: '2027-05-17', end_on: '2027-05-24', role: 'tech', name: 'M. Wynn', phone: null, note: null });
  assert.deepEqual(read.shifts.filter((x) => x.start_on === '2026-12-28').map((x) => [x.role, x.name, x.phone, x.note]),
    [['tech', 'D. Marlow', '717-555-0121', 'New Years Eve'], ['backup', 'T. Weller', '717-555-0122', 'New Years Eve']]);
  assert.equal(read.shifts.find((x) => /Mcdowell/.test(x.name)).phone, '717-555-0129');           // a line break inside the cell is fine
  assert.match(oncall.parseSheet([['no year here']]).problems[0], /needs the year/);

  // Only people who keep the rota can change it.
  const page = '/oncall';
  assert.equal((await t1.post('/admin/oncall', { start_on: today, end_on: ymdFromNow(7), name: 'Sneaky' }, { page })).status, 403);
  assert.equal((await t1.post('/admin/oncall/import', { file: new File([sheet], 'rota.csv', { type: 'text/csv' }) }, { page, multipart: true })).status, 403);
  assert.match((await t1.get(page)).text, /Nobody is listed as on call today/); assert.doesNotMatch((await t1.get(page)).text, /Load the year from the spreadsheet/);
  // Loading the sheet, then a stretch that covers today with three on call and two backups.
  const up = await owner.post('/admin/oncall/import', { file: new File([sheet], 'rota.csv', { type: 'text/csv' }) }, { page, multipart: true });
  assert.equal(up.location, '/oncall#schedule');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM oncall_shifts WHERE branch_id = 1').get().n, read.shifts.length);
  await owner.post('/admin/oncall/import', { file: new File([sheet], 'rota.csv', { type: 'text/csv' }) }, { page, multipart: true });     // loading it again does not double it
  assert.equal(db.prepare('SELECT COUNT(*) n FROM oncall_shifts WHERE branch_id = 1').get().n, read.shifts.length);
  assert.equal((await owner.post('/admin/oncall', { start_on: today, end_on: today, name: 'Zero Days' }, { page })).status, 400);
  for (const [name, phone, role] of [['Ann Alpha', '717-555-0001', 'tech'], ['Bo Bravo', '717-555-0002', 'tech'], ['Cy Charlie', '', 'tech'], ['Di Delta', '717-555-0004', 'backup'], ['Ed Echo', '717-555-0005', 'backup']]) {
    await owner.post('/admin/oncall', { start_on: ymdFromNow(-2), end_on: ymdFromNow(5), name, phone, role, note: 'Test week' }, { page });
  }
  const seen = (await t1.get(page)).text.replace(/\s+/g, ' ');
  assert.match(seen, /id="now-h">On call now<[\s\S]*Ann Alpha<\/strong><span class="meta">717-555-0001<\/span><\/span> <a class="btn primary" href="tel:7175550001"[^>]*>Call<\/a>[\s\S]*Bo Bravo[\s\S]*Cy Charlie<\/strong><\/span> <span class="hint">No number listed[\s\S]*<span class="tag ">Backup<\/span><strong>Di Delta[\s\S]*Ed Echo/);
  assert.match(seen, /Coming up[\s\S]*2027[\s\S]*Jan 4 to Jan 11[\s\S]*J\. Zane[\s\S]*D\. Archer/);
  assert.doesNotMatch(seen, /Remove from this shift/);
  // The home page shows who is on call now, with a call button.
  assert.match((await t1.get('/')).text.replace(/\s+/g, ' '), /id="oncall-h">On call now<[\s\S]*Ann Alpha<\/strong><\/span><a class="btn small primary" href="tel:7175550001"/);
  // The hand-over day belongs to the next person.
  assert.deepEqual(oncall.covering([1], '2027-01-04').map((x) => x.name), ['J. Zane', 'D. Archer']);
  assert.deepEqual(oncall.covering([1], '2027-01-03').map((x) => x.name), ['D. Marlow', 'T. Weller']);
  // Swapping one person for another, and taking someone off.
  const cy = db.prepare("SELECT id FROM oncall_shifts WHERE name = 'Cy Charlie'").get().id;
  await owner.post(`/admin/oncall/${cy}`, { name: 'Fay Foxtrot', phone: '717-555-0006' }, { page });
  assert.deepEqual(db.prepare('SELECT name, phone FROM oncall_shifts WHERE id = ?').get(cy), { name: 'Fay Foxtrot', phone: '717-555-0006' });
  assert.equal((await t1.post(`/admin/oncall/${cy}/delete`, {}, { page })).status, 403);
  await owner.post(`/admin/oncall/${cy}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM oncall_shifts WHERE id = ?').get(cy).n, 0);
  // Another office in a different market does not see this rota.
  const other = db.prepare("SELECT u.username FROM users u JOIN branches b ON b.id = u.branch_id WHERE u.branch_id <> 1 AND u.active = 1 AND COALESCE(b.market, '') <> COALESCE((SELECT market FROM branches WHERE id = 1), '') LIMIT 1").get();
  if (other) assert.doesNotMatch((await (await loggedIn(other.username)).get(page)).text, /Ann Alpha/);
  db.prepare('DELETE FROM oncall_shifts').run();
});

test('community first: the company in numbers, one list of what people across the offices are doing, and comments on announcements', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  // The strip under the greeting: how big the company is, each number a link.
  const home = (await t1.get('/')).text.replace(/\s+/g, ' ');
  const strip = /<section class="company-strip"[\s\S]*?<\/section>/.exec(home)[0];
  const offices = db.prepare('SELECT COUNT(*) n FROM branches').get().n;
  assert.match(strip, new RegExp(`<a href="/branches"><strong>${offices.toLocaleString('en-US')}</strong><span>Offices</span></a>`));
  assert.match(strip, /<a href="\/people"><strong>[\d,]+<\/strong><span>People Here<\/span>/); assert.match(strip, /Shout-Outs? This Month/);
  // The activity feed sits straight after shout-outs in the main column, and each item names the office it came from.
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY sort_order LIMIT 1').get().id;
  await t2.post('/discussions/new', { section_id: String(sec), title: 'FEED-TEST best ladder rack?', body: 'Asking for the van.' }, { page: '/discussions/new', multipart: true });
  const feed = /<section class="panel p-around"[\s\S]*?<\/section>/.exec((await t1.get('/')).text.replace(/\s+/g, ' '))[0];
  assert.match(feed, /<li class="feed-talk"[\s\S]*?FEED-TEST best ladder rack\?<\/strong>[\s\S]*?Uma Tech started a discussion[\s\S]*?<span class="pill ">Lancaster office<\/span> <span>just now<\/span> · <span>Be the first to reply/);
  const other = db.prepare("SELECT u.username FROM users u WHERE u.branch_id IS NOT NULL AND u.branch_id <> 1 AND u.active = 1 LIMIT 1").get();
  if (other) assert.match((await (await loggedIn(other.username)).get('/')).text.replace(/\s+/g, ' '), /FEED-TEST best ladder rack\?[\s\S]*?<span class="pill away">Lancaster office<\/span>/);   // from another office: marked as such

  // Announcements are a conversation: anyone it is for can comment, the poster is not the only voice.
  await owner.post('/admin/announcements', { title: 'COMMENT-TEST new vans', body: 'Two vans arrive Friday.', audience: 'all', category: 'general' }, { page: '/admin/announcements' });
  const nid = db.prepare("SELECT id FROM announcements WHERE title = 'COMMENT-TEST new vans'").get().id;
  assert.match((await t1.get('/notices')).text, /Ask a question or comment/);
  assert.equal((await t1.post(`/notices/${nid}/comment`, { body: 'Which trucks do they <b>replace</b>?' }, { page: '/notices' })).location, `/notices#n${nid}`);
  await t1.post(`/notices/${nid}/comment`, { body: 'Which trucks do they <b>replace</b>?' }, { page: '/notices' });          // a double tap posts once
  await owner.post(`/notices/${nid}/comment`, { body: '309 and 311.' }, { page: '/notices' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM announcement_comments WHERE announcement_id = ?').get(nid).n, 2);
  const page = (await t2.get('/notices')).text.replace(/\s+/g, ' ');
  assert.match(page, /<summary>2 comments<\/summary>[\s\S]*Terry Tech<\/strong> · Lancaster ·[\s\S]*Which trucks do they &lt;b&gt;replace&lt;\/b&gt;\?[\s\S]*Olive Owner<\/strong>[\s\S]*309 and 311\./);
  // Someone the announcement is not for cannot comment on it.
  db.prepare('UPDATE announcements SET branch_id = 1 WHERE id = ?').run(nid);
  if (other) assert.equal((await (await loggedIn(other.username)).post(`/notices/${nid}/comment`, { body: 'hello' }, { page: '/notices' })).status, 403);
  // People remove their own comments; someone who posts announcements can remove any.
  const [c1, c2] = db.prepare('SELECT id FROM announcement_comments WHERE announcement_id = ? ORDER BY id').all(nid).map((r) => r.id);
  assert.equal((await t2.post(`/notices/comment/${c1}/delete`, {}, { page: '/notices' })).status, 403);
  await t1.post(`/notices/comment/${c1}/delete`, {}, { page: '/notices' });
  await owner.post(`/notices/comment/${c2}/delete`, {}, { page: '/notices' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM announcement_comments WHERE announcement_id = ?').get(nid).n, 0);
  await owner.post(`/admin/announcements/${nid}/delete`, {}, { page: '/admin/announcements' });
  const thread = db.prepare("SELECT id FROM forum_threads WHERE title LIKE 'FEED-TEST%'").get().id;
  await owner.post(`/discussions/t/${thread}/delete`, {}, { page: `/discussions/t/${thread}` });
});

test('sign-in details: a manager picks a few people who have not signed in and gets a ready message with a new temporary password for each', async () => {
  const owner = await loggedIn('owner');
  const a = makeUser('invitee1', 'Ivy Invitee'); const b = makeUser('invitee2', 'Ned Noemail'); const c = makeUser('invitee3', 'Sid Signedin');
  db.prepare('UPDATE users SET must_change_password = 1, email = ? WHERE id = ?').run('ivy@example.com', a);
  db.prepare('UPDATE users SET must_change_password = 1, email = NULL WHERE id = ?').run(b);
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(c);
  const page = '/admin/users/invite';
  assert.match((await owner.get('/admin/users')).text, /href="\/admin\/users\/invite">Send sign-in details/);
  const list = (await owner.get(page)).text;
  assert.match(list, /Ivy Invitee/); assert.match(list, /Ned Noemail/); assert.doesNotMatch(list, /Sid Signedin/);     // only people still on a temporary password
  assert.equal((await owner.post(page, {}, { page })).status, 302);
  assert.match((await owner.get(page)).text, /Tick at least one person first/);
  const before = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(c).password_hash;
  assert.equal((await owner.post(page, [['who', String(a)], ['who', String(b)], ['who', String(c)]], { page })).status, 302);
  const out = (await owner.get(page)).text;
  const pw = /Username: invitee1\nTemporary password: (\S+)/.exec(out);
  assert.ok(pw, 'the message carries the username and a temporary password');
  assert.match(out, /Hi Ivy, you&#39;re invited to try out the new PB Portal\./);
  assert.doesNotMatch(out, /Site: http:\/\/localhost:3000/);                                                       // the address the page was opened on, not a placeholder
  assert.match(out, /href="https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=ivy%40example\.com&amp;message=Hi%20Ivy%2C%20you&#39;re%20invited/);
  assert.match(out, /Ned Noemail<\/strong><span class="pill">No email on file/);
  assert.doesNotMatch(out, /Sid Signedin/);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(c).password_hash, before);               // someone who has signed in is never touched
  assert.doesNotMatch((await owner.get(page)).text, /Temporary password: /);                                         // shown once
  const ivy = new Client(); const lp = await ivy.get('/login');
  const signed = await ivy.post('/login', { username: 'invitee1', password: pw[1] }, { page: '/login' });
  assert.equal(signed.location, '/account/password');                                                                // the password works, and must be changed
  assert.doesNotMatch(db.prepare("SELECT group_concat(detail, ' ') d FROM activity_log WHERE action = 'Sign-in details made'").get().d, new RegExp(pw[1]));
  const t1 = await loggedIn('tech1');
  assert.equal((await t1.get(page)).status, 403); assert.equal((await t1.post(page, [['who', String(b)]], { page: '/' })).status, 403);
});

test('reports to: set on the Positions page, it draws the office team chart, fills Managed by, and lets a manager see everyone under them', async () => {
  const owner = await loggedIn('owner');
  const office = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Chartville', ?)").run(new Date().toISOString()).lastInsertRowid;
  const mk = (username, name, profile, job) => { const id = makeUser(username, name); db.prepare('UPDATE users SET profile_id = ?, branch_id = ?, job_title = ? WHERE id = ?').run(profileId(profile), office, job, id); return id; };
  const gm = mk('chart.gm', 'Gina General', 'Admin', 'General Manager'); const sm = mk('chart.sm', 'Sam Service', 'Manager', 'Service Manager');
  const t1 = mk('chart.t1', 'Tia Tech', 'Technician', 'Service Tech'); const t2 = mk('chart.t2', 'Tom Tech', 'Technician', 'Service Tech'); const loner = mk('chart.x', 'Lou Loner', 'Technician', 'Estimator');
  const elsewhere = userId('tech1');
  await owner.post('/branch/view', { branch: String(office), back: '/admin/users/positions' }, { page: '/admin/users/positions' });
  const page = '/admin/users/positions';
  const form = (await owner.get(page)).text;
  assert.match(form, /<th>Reports to<\/th>/);
  assert.match(form, new RegExp(`<select name="job_${t1}"[\\s\\S]*?<td data-label="Reports to" class="reports-to">Nobody`));
  assert.doesNotMatch(form.slice(form.indexOf(`name="mgr_${t1}"`), form.indexOf(`name="mgr_${t1}"`) + 2000).split('</select>')[0], new RegExp(`value="${t1}"`));   // nobody is offered themselves
  assert.equal((await owner.post(page, { [`mgr_${sm}`]: String(gm), [`mgr_${t1}`]: String(sm), [`mgr_${t2}`]: String(sm) }, { page })).status, 302);
  assert.match((await owner.get(page)).text, /3 changes saved/);
  // A loop, yourself, or someone from another office is refused and nothing changes.
  await owner.post(page, { [`mgr_${gm}`]: String(t1) }, { page });
  assert.match((await owner.get(page)).text, /Gina General could not be set to report to Tia Tech: that person already reports to them\./);
  await owner.post(page, { [`mgr_${loner}`]: String(elsewhere) }, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_managers WHERE user_id IN (?, ?)').get(gm, loner).n, 0);
  // The office page shows the chart: the general manager, the service manager under them, the techs under the service manager.
  const officePage = (await owner.get(`/branches/${office}`)).text;
  assert.match(officePage, /<div class="org"><ul>[\s\S]*class="org-box lvl1"[^>]*><strong>General Manager<\/strong><span>Gina General[\s\S]*class="org-box lvl2"[^>]*><strong>Service Manager<\/strong><span>Sam Service[\s\S]*class="org-box crew">[\s\S]*Tia Tech[\s\S]*Tom Tech/);
  assert.match(officePage, /<ul class="chart org-phone">[\s\S]*Gina General[\s\S]*<ul class="chart-kids">[\s\S]*Sam Service/);              // phones get the indented list
  // Positions and the chart live under Users now; the old address still lands in the right place.
  assert.equal((await owner.get('/admin/positions?who=5')).location, '/admin/users/positions?who=5');
  const tabs = (await owner.get('/admin/users')).text;
  assert.match(tabs, /href="\/admin\/users\/positions"[^>]*>Positions and reporting<\/a>\s*<a href="\/admin\/users\/chart"[^>]*>Organization chart/);
  assert.match((await owner.get('/admin/users/chart')).text, /Chartville office<\/h2>[\s\S]*class="org-box lvl1"[^>]*><strong>General Manager/);
  assert.match(officePage, /Everyone else<\/h3>[\s\S]*Lou Loner/);
  assert.match((await owner.get(`/people/${t1}`)).text, /Reports to<\/span> <a href="\/people\/\d+"><strong>Sam Service/);
  assert.match((await owner.get(`/people/${sm}`)).text, /2 people report to Sam/);
  assert.match((await owner.get('/admin/users')).text, /Tia Tech\s*<\/td>\s*<td>Chartville<\/td>[\s\S]*?<td>Sam Service<\/td>/);
  // A manager-profile account sees its own people, and a manager of managers sees everyone underneath.
  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId('Manager'), gm);
  const asGm = (await (await loggedIn('chart.gm')).get('/admin/parts')).text;
  for (const name of ['Sam Service', 'Tia Tech', 'Tom Tech']) assert.match(asGm, new RegExp(name));
  assert.doesNotMatch(asGm, /Lou Loner/);
  const asSm = (await (await loggedIn('chart.sm')).get('/admin/parts')).text;
  assert.match(asSm, />Tia Tech<\/option>/); assert.doesNotMatch(asSm, />Gina General<\/option>|Lou Loner/);
  // Clearing it takes the person off the chart.
  await owner.post(page, { [`mgr_${t2}`]: '' }, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_managers WHERE user_id = ?').get(t2).n, 0);
  // Automatic: a person's job title decides who they report to. Nothing else is typed.
  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId('Admin'), gm);
  const inst = mk('chart.im', 'Ines Install', 'Technician', null); const it = mk('chart.it', 'Ivan Installer', 'Technician', null); const ops = mk('chart.om', 'Opal Ops', 'Technician', null);
  const tid = (name) => db.prepare('SELECT id FROM job_titles WHERE name = ?').get(name).id;
  await owner.post('/admin/users/titles', { new_name: 'Chart Install Tech', new_dept: 'Installation', new_parent: String(tid('Installation Manager')) }, { page });
  await owner.post('/admin/users/titles', { new_name: 'Chart Service Tech', new_dept: 'Service', new_parent: String(tid('Service Manager')) }, { page });
  const mgrOf = (id) => (db.prepare('SELECT manager_id FROM user_managers WHERE user_id = ?').get(id) || {}).manager_id || null;
  const all = [gm, sm, t1, t2, loner, inst, it, ops];
  const autoAll = Object.fromEntries(all.map((id) => [`mgr_${id}`, 'auto']));
  await owner.post(page, { ...autoAll, [`job_${gm}`]: 'General Manager', [`job_${sm}`]: 'Service Manager', [`job_${inst}`]: 'Installation Manager',
    [`job_${t1}`]: 'Chart Service Tech', [`job_${t2}`]: 'Chart Service Tech', [`job_${loner}`]: 'Chart Service Tech', [`job_${it}`]: 'Chart Install Tech', [`job_${ops}`]: '' }, { page });
  // With no operations manager in the office, the managers go straight to the general manager.
  assert.deepEqual([gm, sm, inst, t1, t2, loner, it, ops].map(mgrOf), [null, gm, gm, sm, sm, sm, inst, null]);
  assert.equal(db.prepare('SELECT department FROM users WHERE id = ?').get(it).department, 'Installation');           // the title brings its department
  assert.match((await owner.get(page)).text, new RegExp(`name="job_${it}"[\\s\\S]*?class="reports-to">Ines Install <span class="meta">Installation Manager`));
  assert.doesNotMatch((await owner.get(page)).text, /name="mgr_\d+"/);                             // nobody is assigned to a person by hand
  assert.match((await owner.get(page)).text, /class="org-box lvl1"><strong>General Manager<\/strong><span>1 person/);   // the roles drawn as a chart
  // Give someone the operations manager title and the managers move under them.
  await owner.post(page, { [`job_${ops}`]: 'Operations Manager' }, { page });
  assert.deepEqual([ops, sm, inst, t1].map(mgrOf), [gm, ops, ops, sm]);
  // Change a tech's title and they move with it; a choice made by hand is left alone until it is set back to automatic.
  await owner.post(page, { [`job_${t2}`]: 'Chart Install Tech', [`mgr_${loner}`]: String(gm) }, { page });
  assert.equal(mgrOf(t2), inst); assert.equal(mgrOf(loner), gm);
  await owner.post(page, { [`job_${loner}`]: 'Chart Install Tech' }, { page });
  assert.equal(mgrOf(loner), gm);
  await owner.post(page, { [`mgr_${loner}`]: 'auto' }, { page });
  assert.equal(mgrOf(loner), inst);
  // Changing what a title reports to on the company list moves everyone who holds it.
  const cit = tid('Chart Install Tech');
  await owner.post('/admin/users/titles', { [`tname_${cit}`]: 'Chart Install Tech', [`tdept_${cit}`]: 'Installation', [`tparent_${cit}`]: String(tid('Service Manager')) }, { page });
  assert.equal(mgrOf(it), sm);
  await owner.post('/branch/view', { branch: '1', back: '/' }, { page: '/' });
});

test('roles: a role can give a profile, be chosen when adding a person, and be merged into another', async () => {
  const owner = await loggedIn('owner'); const page = '/admin/users/positions';
  const tid = (name) => (db.prepare('SELECT id FROM job_titles WHERE name = ?').get(name) || {}).id;
  const tech = profileId('Technician'), mgr = profileId('Manager');
  await owner.post('/admin/users/titles', { new_name: 'Kitchen Tech', new_dept: 'Kitchen', new_parent: String(tid('Service Manager')), new_profile: String(tech) }, { page });
  await owner.post('/admin/users/titles', { new_name: 'Kitchen Technician', new_dept: 'Kitchen', new_parent: String(tid('Service Manager')) }, { page });
  assert.equal(db.prepare('SELECT profile_id FROM job_titles WHERE name = ?').get('Kitchen Tech').profile_id, tech);
  // Adding a person with a role and no profile chosen uses the role's profile, and files them under the role.
  const users = (await owner.get('/admin/users')).text;
  assert.match(users, new RegExp(`<select name="job_title" id="add-role">[\\s\\S]*?<option value="Kitchen Tech" data-profile="${tech}"`));
  const add = await owner.post('/admin/users', { username: 'kit.one', display_name: 'Kit One', job_title: 'Kitchen Tech', profile_id: '' }, { page: '/admin/users' });
  assert.equal(add.location, '/admin/users');
  const k1 = db.prepare('SELECT id, job_title, department, profile_id FROM users WHERE username = ?').get('kit.one');
  assert.deepEqual([k1.job_title, k1.department, k1.profile_id], ['Kitchen Tech', 'Kitchen', tech]);
  assert.equal((await owner.post('/admin/users', { username: 'kit.none', display_name: 'Kit None', job_title: 'Kitchen Technician', profile_id: '' }, { page: '/admin/users' })).status, 400);   // that role gives no profile, so one must be chosen
  // Putting someone into a role that gives a profile changes their profile; a role without one leaves it alone. Never your own.
  const k2 = makeUser('kit.two', 'Kit Two'); db.prepare('UPDATE users SET profile_id = ?, branch_id = (SELECT branch_id FROM users WHERE id = ?) WHERE id = ?').run(mgr, k1.id, k2);
  await owner.post('/branch/view', { branch: 'all', back: page }, { page });
  await owner.post(page, { [`job_${k2}`]: 'Kitchen Technician' }, { page });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(k2).profile_id, mgr);
  await owner.post(page, { [`job_${k2}`]: 'Kitchen Tech' }, { page });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(k2).profile_id, tech);
  const me = userId('owner'); const mine = db.prepare('SELECT profile_id FROM users WHERE id = ?').get(me).profile_id;
  await owner.post(page, { [`job_${me}`]: 'Kitchen Tech' }, { page });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(me).profile_id, mine);
  await owner.post(page, { [`job_${me}`]: '' }, { page });
  // Merging: everyone in the duplicate moves to the role that is kept, and the duplicate is gone.
  await owner.post(page, { [`job_${k2}`]: 'Kitchen Technician' }, { page });
  const dup = tid('Kitchen Technician'), keep = tid('Kitchen Tech');
  assert.match((await owner.get(page)).text, new RegExp(`<select name="tact_${dup}"[^>]*><option value="">Keep</option><optgroup label="Merge into">[\\s\\S]*?<option value="merge:${keep}">Kitchen Tech</option>`));
  await owner.post('/admin/users/titles', { [`tname_${dup}`]: 'Kitchen Technician', [`tact_${dup}`]: `merge:${keep}` }, { page });
  assert.equal(tid('Kitchen Technician'), undefined);
  assert.equal(db.prepare('SELECT job_title FROM users WHERE id = ?').get(k2).job_title, 'Kitchen Tech');
  assert.match(db.prepare("SELECT detail FROM activity_log WHERE action = 'Roles merged' ORDER BY id DESC LIMIT 1").get().detail, /Kitchen Technician into Kitchen Tech \(1 person\)/);
  await owner.post('/branch/view', { branch: '1', back: '/' }, { page: '/' });
});

test('duplicates: the same person twice in one office is found, and the disabled or roleless extra is folded into the account kept', async () => {
  const owner = await loggedIn('owner');
  const office = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Dupeton', ?)").run(new Date().toISOString()).lastInsertRowid;
  const mk = (username, name, o) => { const id = makeUser(username, name); db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(o, id); return id; };
  const real = mk('dana.dupe', 'Dana Dupe', office); const ghost = mk('ddupe', 'dana  dupe', office);              // same name, spaced and cased differently
  db.prepare("UPDATE users SET active = 0, in_directory = 1, job_title = 'Service Tech', department = 'Service', email = 'dana@example.com', phone = '717-555-0111' WHERE id = ?").run(ghost);
  const a = mk('pat.one', 'Pat Working', office), b = mk('pat.two', 'Pat Working', office);                            // both working accounts with roles: not offered
  db.prepare("UPDATE users SET job_title = 'Service Tech' WHERE id IN (?, ?)").run(a, b);
  const far = mk('dana.far', 'Dana Dupe', 1);                                                                          // same name in another office is a different person
  const byMail = mk('rob.mail', 'Robert Mailer', office), byMail2 = mk('bob.mail', 'Bob Mailer', office);              // different names, same address
  db.prepare("UPDATE users SET email = 'rob@example.com' WHERE id IN (?, ?)").run(byMail, byMail2);
  db.prepare("UPDATE users SET job_title = 'Service Tech' WHERE id = ?").run(byMail);
  // Things recorded under the extra account, including one the kept account has its own of.
  db.prepare("INSERT INTO tasks (title, assigned_to, assigned_by, created_at) VALUES ('Ghost task', ?, ?, ?)").run(ghost, userId('owner'), new Date().toISOString());
  await owner.post('/branch/view', { branch: String(office), back: '/admin/users' }, { page: '/admin/users' });
  const page = (await owner.get('/admin/users')).text;
  assert.match(page, /2 duplicate accounts found/);
  assert.match(page, /Keep <strong>dana\.dupe<\/strong> \(active, no role\) · remove <strong>ddupe<\/strong> \(disabled, Service Tech\)/);
  assert.match(page, /Keep <strong>rob\.mail<\/strong>[^<]*<\/span>|Keep <strong>rob\.mail<\/strong>/); assert.match(page, /remove <strong>bob\.mail<\/strong> \(active, no role\)/);
  assert.doesNotMatch(page, /remove <strong>pat\.(one|two)<\/strong>/);
  // A technician cannot do this, and a made-up pair is ignored.
  assert.equal((await (await loggedIn('tech1')).post('/admin/users/duplicates', { all: '1' }, { page: '/' })).status, 403);
  await owner.post('/admin/users/duplicates', { keep: String(a), extra: String(b) }, { page: '/admin/users' });
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(b));
  // Remove one pair: the task moves across and the details the kept account lacked are filled in.
  await owner.post('/admin/users/duplicates', { keep: String(real), extra: String(ghost) }, { page: '/admin/users' });
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(ghost), undefined);
  assert.equal(db.prepare("SELECT assigned_to FROM tasks WHERE title = 'Ghost task'").get().assigned_to, real);
  assert.deepEqual(db.prepare('SELECT job_title, department, email, phone, active FROM users WHERE id = ?').get(real), { job_title: 'Service Tech', department: 'Service', email: 'dana@example.com', phone: '717-555-0111', active: 1 });
  assert.match((await owner.get('/admin/users')).text, /1 duplicate account removed/);
  // Remove all that are left.
  await owner.post('/admin/users/duplicates', { all: '1' }, { page: '/admin/users' });
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(byMail2), undefined);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(far)); assert.ok(db.prepare('SELECT 1 FROM users WHERE id IN (?, ?)').get(a, b));
  assert.doesNotMatch((await owner.get('/admin/users')).text, /duplicate accounts? found/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'Duplicate account removed'").get().n, 2);
  await owner.post('/branch/view', { branch: '1', back: '/' }, { page: '/' });
});

test('removing people: one at a time or every disabled account; sign-in and details go, office records keep the name', async () => {
  const owner = await loggedIn('owner');
  const office = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Removia', ?)").run(new Date().toISOString()).lastInsertRowid;
  const mk = (username, name) => { const id = makeUser(username, name); db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(office, id); return id; };
  const clean = mk('rem.clean', 'Cleo Clean'); const busy = mk('rem.busy', 'Bea Busy'); const off1 = mk('rem.off1', 'Otto Off'); const off2 = mk('rem.off2', 'Olga Off'); const stays = mk('rem.stay', 'Stan Stays');
  db.prepare("UPDATE users SET email = 'bea@example.com', phone = '717-555-0199', job_title = 'Service Tech', in_directory = 1 WHERE id = ?").run(busy);
  db.prepare('UPDATE users SET active = 0, in_directory = 1 WHERE id IN (?, ?)').run(off1, off2);
  const sub = db.prepare("INSERT INTO parts_submissions (user_id, action, source, created_at, created_local_date) VALUES (?, 'take', 'van', ?, ?)").run(busy, new Date().toISOString(), new Date().toISOString().slice(0, 10)).lastInsertRowid;
  db.prepare("INSERT INTO tasks (title, assigned_to, assigned_by, created_at) VALUES ('Unstarted', ?, ?, ?)").run(busy, userId('owner'), new Date().toISOString());
  await owner.post('/branch/view', { branch: String(office), back: '/admin/users' }, { page: '/admin/users' });
  const page = (await owner.get('/admin/users')).text;
  assert.match(page, new RegExp(`action="/admin/users/${clean}/remove"[^>]*data-confirm="Remove Cleo Clean for good\\?`));
  assert.match(page, /2 disabled accounts<\/strong>/); assert.match(page, /2 of these are people<\/strong>|<strong>2 of these are people from the office contact list/);
  // Who may: not a technician, never yourself, never the master account.
  assert.equal((await (await loggedIn('tech1')).post(`/admin/users/${clean}/remove`, {}, { page: '/' })).status, 403);
  await owner.post(`/admin/users/${userId('owner')}/remove`, {}, { page: '/admin/users' });
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ? AND removed_at IS NULL AND active = 1').get(userId('owner')));
  // Someone with nothing on record is gone entirely.
  await owner.post(`/admin/users/${clean}/remove`, {}, { page: '/admin/users' });
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(clean), undefined);
  // Someone with records: sign-in and details erased, hidden from every list, the parts entry still carries the name.
  await owner.post(`/admin/users/${busy}/remove`, {}, { page: '/admin/users' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(busy);
  assert.deepEqual([row.active, row.in_directory, row.email, row.phone, row.job_title, row.profile_id, row.username, row.display_name], [0, 0, null, null, null, null, `removed-${busy}`, 'Bea Busy']);
  assert.ok(row.removed_at);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE title = 'Unstarted'").get().n, 0);
  assert.equal(db.prepare('SELECT user_id FROM parts_submissions WHERE id = ?').get(sub).user_id, busy);
  const after = (await owner.get('/admin/users')).text;
  assert.doesNotMatch(after, /Bea Busy\s*<\/td>|Cleo Clean/); assert.match(after, /Bea Busy was removed\. What they recorded for the office is kept/);
  assert.doesNotMatch((await owner.get('/people')).text, /Bea Busy/);
  assert.match((await owner.get('/admin/parts')).text, /Bea Busy/);                                                  // the log still says who took the parts
  const login = await new Client().post('/login', { username: 'rem.busy', password: 'whatever it was 123' }, { page: '/login' });
  assert.notEqual(login.location, '/');
  makeUser('rem.busy', 'New Bea');                                                                                   // the username is free again
  // Every disabled account at once.
  await owner.post('/admin/users/remove-disabled', {}, { page: '/admin/users' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id IN (?, ?)').get(off1, off2).n, 0);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(stays));
  assert.match((await owner.get('/admin/users')).text, /2 disabled accounts were removed/);
  assert.doesNotMatch((await owner.get('/admin/users')).text, /disabled accounts?<\/strong>/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action IN ('Person removed', 'Disabled accounts removed')").get().n, 3);
  await owner.post('/branch/view', { branch: '1', back: '/' }, { page: '/' });
});

test('organization chart: people who manage users can download an office chart as a PDF', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  const office = db.prepare("SELECT id FROM branches WHERE name = 'Chartville'").get().id;
  const pdf = await owner.get(`/branches/${office}/chart.pdf`);
  assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.match(pdf.headers.get('content-disposition'), /attachment; filename="Chartville-organization-chart-\d{4}-\d\d-\d\d\.pdf"/);
  assert.ok(pdf.text.startsWith('%PDF-')); assert.ok(pdf.text.length > 2000);
  assert.equal((await owner.get('/branches/999999/chart.pdf')).status, 404);
  assert.equal((await new Client().get(`/branches/${office}/chart.pdf`)).status, 302);
  // A technician sees the chart on the office page but gets no download.
  assert.equal((await t1.get(`/branches/${office}/chart.pdf`)).status, 403);
  assert.doesNotMatch((await t1.get(`/branches/${office}`)).text, /chart\.pdf/);
  await owner.post('/branch/view', { branch: String(office), back: '/admin/users/chart' }, { page: '/admin/users/chart' });
  assert.match((await owner.get('/admin/users/chart')).text, new RegExp(`href="/branches/${office}/chart.pdf"[^>]*>Download as PDF`));
  assert.match((await owner.get(`/branches/${office}`)).text, /Download the chart as PDF/);
  const empty = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Emptyton', ?)").run(new Date().toISOString()).lastInsertRowid;
  assert.ok((await owner.get(`/branches/${empty}/chart.pdf`)).text.startsWith('%PDF-'));                                // an office with nobody still gives a page
  await owner.post('/branch/view', { branch: '1', back: '/' }, { page: '/' });
});

test('new-hire welcome: an admin takes it down from the person\'s page; the daily question sits above the office numbers', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  const id = makeUser('oops.hire', 'Oops Hire'); db.prepare('UPDATE users SET branch_id = 1 WHERE id = ?').run(id);
  await owner.post(`/admin/users/${id}/welcome`, { intro: 'Announced by accident' }, { page: `/admin/users/${id}/edit` });
  const home = (await owner.get('/')).text;
  assert.match(home, /Oops Hire joined/); assert.doesNotMatch(home, /hire-tools/);
  if (home.includes('id="daily"')) assert.ok(home.indexOf('id="daily"') < home.indexOf('p-glance'));
  const page = `/people/${id}`;
  assert.match((await owner.get(page)).text, new RegExp(`action="/admin/users/${id}/welcome"[\\s\\S]*?Take down the new-hire welcome`));
  assert.doesNotMatch((await t1.get(page)).text, /Take down the new-hire welcome/);
  assert.equal((await t1.post(`/admin/users/${id}/welcome`, { remove: '1', back: 'person' }, { page })).status, 403);
  // A team manager can manage their own people but cannot take a welcome down.
  const m = makeUser('oops.mgr', 'Mona Teamlead'); db.prepare('UPDATE users SET branch_id = 1, profile_id = ? WHERE id = ?').run(profileId('Manager'), m);
  db.prepare('INSERT OR IGNORE INTO user_managers (manager_id, user_id) VALUES (?, ?)').run(m, id);
  const mgr = await loggedIn('oops.mgr');
  assert.doesNotMatch((await mgr.get(page)).text, /Take down the new-hire welcome/);
  assert.equal((await mgr.post(`/admin/users/${id}/welcome`, { remove: '1', back: 'person' }, { page })).status, 403);
  assert.ok(db.prepare('SELECT 1 FROM welcomes WHERE user_id = ?').get(id));
  const r = await owner.post(`/admin/users/${id}/welcome`, { remove: '1', back: 'person' }, { page });
  assert.equal(r.location, page);
  const after = (await owner.get(page)).text;
  assert.match(after, /The welcome for Oops Hire was taken down/); assert.doesNotMatch(after, /Take down the new-hire welcome/);
  assert.doesNotMatch((await owner.get('/')).text, /Oops Hire joined/);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(id));                                   // the account itself is untouched
  db.prepare('DELETE FROM user_managers WHERE manager_id = ?').run(m);
});

test('welcome notes stay on the person\'s page for good: after 14 days, and after the welcome is taken down early', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  const mk = (u, n) => { const id = makeUser(u, n); db.prepare('UPDATE users SET branch_id = 1 WHERE id = ?').run(id); return id; };
  const a = mk('note.old', 'Nora Oldhire'), b = mk('note.down', 'Dale Takendown');
  for (const id of [a, b]) {
    await owner.post(`/admin/users/${id}/welcome`, { intro: 'Hello' }, { page: `/admin/users/${id}/edit` });
    const w = db.prepare('SELECT id FROM welcomes WHERE user_id = ?').get(id).id;
    await t1.post(`/welcome/${w}/wave`, { message: 'Glad you are here' }, { page: `/people/${id}` });
  }
  // Fifteen days on: off the home page, the note still on the profile, and no take-down button left to press.
  db.prepare('UPDATE welcomes SET created_at = ? WHERE user_id = ?').run(new Date(Date.now() - 15 * 86400000).toISOString(), a);
  assert.doesNotMatch((await owner.get('/')).text, /Nora Oldhire joined/);
  const old = (await owner.get(`/people/${a}`)).text;
  assert.match(old, /Welcome messages[\s\S]*Glad you are here/); assert.doesNotMatch(old, /Take down the new-hire welcome/);
  // Taken down early: gone from the home page, the note kept.
  await owner.post(`/admin/users/${b}/welcome`, { remove: '1', back: 'person' }, { page: `/people/${b}` });
  assert.doesNotMatch((await owner.get('/')).text, /Dale Takendown joined/);
  assert.match((await t1.get(`/people/${b}`)).text, /Welcome messages[\s\S]*Glad you are here/);
});

test('messages: people edit their own in threads, comments and welcome notes; admins remove other people\'s; nobody edits someone else\'s', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  // A discussion: tech1 starts it, tech2 replies.
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  const made = await t1.post('/discussions/new', [['section_id', String(sec)], ['title', 'Edit me thread'], ['body', 'Opening wrods']], { multipart: true, page: '/discussions/new' });
  const tid = Number(/\/discussions\/t\/(\d+)/.exec(made.location)[1]); const page = `/discussions/t/${tid}`;
  await t2.post(`${page}/reply`, [['body', 'A reply with a tpyo']], { multipart: true, page });
  const [first, reply] = db.prepare('SELECT id FROM forum_posts WHERE thread_id = ? ORDER BY id').all(tid).map((r) => r.id);
  assert.match((await t1.get(page)).text, new RegExp(`action="/discussions/p/${first}/edit"`));                        // your own opening post
  assert.doesNotMatch((await t1.get(page)).text, new RegExp(`action="/discussions/p/${reply}/edit"`));                 // not someone else's
  assert.equal((await t1.post(`/discussions/p/${first}/edit`, { body: 'Opening words' }, { page })).location, `${page}#p${first}`);
  await t2.post(`/discussions/p/${reply}/edit`, { body: 'A reply with a typo fixed' }, { page });
  const shown = (await t1.get(page)).text;
  assert.match(shown, /Opening words/); assert.match(shown, /A reply with a typo fixed/); assert.match(shown, /class="meta edited">Edited /);
  assert.equal((await t1.post(`/discussions/p/${reply}/edit`, { body: 'Hijacked' }, { page })).status, 403);
  assert.equal((await owner.post(`/discussions/p/${reply}/edit`, { body: 'Admin rewrite' }, { page })).status, 403);   // an admin removes, never rewrites
  await t2.post(`/discussions/p/${reply}/edit`, { body: '   ' }, { page });
  assert.equal(db.prepare('SELECT body FROM forum_posts WHERE id = ?').get(reply).body, 'A reply with a typo fixed');
  assert.match((await owner.get(page)).text, new RegExp(`action="/discussions/p/${reply}/delete"[^>]*data-confirm="Remove this reply from [^"]+\\?"[\\s\\S]*?Remove \\(admin\\)`));
  await owner.post(`/discussions/p/${reply}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT 1 FROM forum_posts WHERE id = ?').get(reply), undefined);
  // A comment on an announcement.
  await owner.post('/admin/announcements', { title: 'Comment edit notice', body: 'Read me', audience: 'all' }, { page: '/admin/announcements' });
  const nid = db.prepare("SELECT id FROM announcements WHERE title = 'Comment edit notice'").get().id;
  await t1.post(`/notices/${nid}/comment`, { body: 'Frist comment' }, { page: '/notices' });
  const cid = db.prepare('SELECT id FROM announcement_comments WHERE announcement_id = ?').get(nid).id;
  await t1.post(`/notices/comment/${cid}/edit`, { body: 'First comment' }, { page: '/notices' });
  assert.match((await t1.get('/notices')).text, /First comment <span class="meta edited">\(edited\)/);
  assert.equal((await t2.post(`/notices/comment/${cid}/edit`, { body: 'Not mine' }, { page: '/notices' })).status, 403);
  // Welcome notes on a profile.
  const hire = makeUser('msg.hire', 'Hana Hire'); db.prepare('UPDATE users SET branch_id = 1 WHERE id = ?').run(hire);
  await owner.post(`/admin/users/${hire}/welcome`, { intro: 'Hi' }, { page: `/admin/users/${hire}/edit` });
  const w = db.prepare('SELECT id FROM welcomes WHERE user_id = ?').get(hire).id; const prof = `/people/${hire}`;
  await t1.post(`/welcome/${w}/wave`, { message: 'Welcom aboard' }, { page: prof }); await t2.post(`/welcome/${w}/wave`, { message: 'Something rude' }, { page: prof });
  const a = userId('tech1'), b = userId('tech2');
  await t1.post(`/welcome/${w}/note/${a}/edit`, { message: 'Welcome aboard' }, { page: prof });
  assert.match((await t1.get(prof)).text, /Welcome aboard/);
  assert.equal((await t1.post(`/welcome/${w}/note/${b}/edit`, { message: 'x' }, { page: prof })).status, 403);
  assert.equal((await t1.post(`/welcome/${w}/note/${b}/delete`, {}, { page: prof })).status, 403);                    // a technician cannot remove someone else's
  assert.doesNotMatch((await t1.get(prof)).text, new RegExp(`note/${b}/delete`));
  assert.match((await owner.get(prof)).text, new RegExp(`note/${b}/delete"[\\s\\S]*?Remove \\(admin\\)`));
  await owner.post(`/welcome/${w}/note/${b}/delete`, {}, { page: prof });
  assert.doesNotMatch((await t1.get(prof)).text, /Something rude/);
  await t1.post(`/welcome/${w}/note/${a}/delete`, {}, { page: prof });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM welcome_notes WHERE welcome_id = ?').get(w).n, 0);
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'Welcome message removed'").get());
});

test('messages: people can remove their own, including a thread they started while nobody has replied', async () => {
  const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  const made = await t1.post('/discussions/new', [['section_id', String(sec)], ['title', 'Remove my own'], ['body', 'Posted by mistake']], { multipart: true, page: '/discussions/new' });
  const tid = Number(/\/discussions\/t\/(\d+)/.exec(made.location)[1]); const page = `/discussions/t/${tid}`;
  const mineOnly = (await t1.get(page)).text;
  assert.match(mineOnly, new RegExp(`action="/discussions/t/${tid}/delete" data-confirm="Remove this message\\? Nobody has replied`));
  await t2.post(`${page}/reply`, [['body', 'A reply']], { multipart: true, page });
  const reply = db.prepare('SELECT id FROM forum_posts WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(tid).id;
  assert.doesNotMatch((await t1.get(page)).text, /Nobody has replied, so the thread goes with it/);                   // once someone has replied, the opening post stays
  // With replies, the starter can blank their opening message: the words go, the thread and the reply stay.
  const first = db.prepare('SELECT id FROM forum_posts WHERE thread_id = ? ORDER BY id LIMIT 1').get(tid).id;
  assert.match((await t1.get(page)).text, new RegExp(`action="/discussions/p/${first}/delete" data-confirm="Remove your message\\?`));
  assert.equal((await t2.post(`/discussions/p/${first}/delete`, {}, { page })).status, 404);                           // not someone else's
  await t1.post(`/discussions/p/${first}/delete`, {}, { page });
  const blanked = (await t2.get(page)).text;
  assert.match(blanked, /Removed by the author\./); assert.doesNotMatch(blanked, /Posted by mistake/); assert.match(blanked, /A reply/);
  assert.equal((await t1.post(`/discussions/p/${first}/edit`, { body: 'Back again' }, { page })).status, 403);
  assert.match((await t2.get(page)).text, new RegExp(`action="/discussions/p/${reply}/delete" data-confirm="Remove this reply\\?"`));
  await t2.post(`/discussions/p/${reply}/delete`, {}, { page });
  assert.equal(db.prepare('SELECT 1 FROM forum_posts WHERE id = ?').get(reply), undefined);
  assert.ok(db.prepare('SELECT 1 FROM forum_threads WHERE id = ?').get(tid));
});

test('discussions: formatting is shown safely, threads can be renamed, a locked thread cannot be edited, long messages keep their length', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  const body = '**Bold** and *slanted*\n\n- first\n- second\n\n> a quote\n\nSee https://example.com/x and [the docs](https://example.com/docs) <script>alert(1)</script> [bad](javascript:alert(1))';
  const made = await t1.post('/discussions/new', [['section_id', String(sec)], ['title', 'Formatting thread'], ['body', body]], { multipart: true, page: '/discussions/new' });
  const tid = Number(/\/discussions\/t\/(\d+)/.exec(made.location)[1]); const page = `/discussions/t/${tid}`;
  const html = (await t2.get(page)).text;
  assert.match(html, /<strong>Bold<\/strong> and <em>slanted<\/em>/); assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/); assert.match(html, /<blockquote><p>a quote<\/p><\/blockquote>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer nofollow">/); assert.match(html, /<a href="https:\/\/example\.com\/docs"[^>]*>the docs<\/a>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/); assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /data-fmt="bold"/); assert.match(html, /Quote in a reply/); assert.match(html, new RegExp(`href="/people/${userId('tech1')}"><strong>`));
  // Rename: the starter and a moderator, nobody else.
  assert.equal((await t2.post(`${page}/rename`, { title: 'Hijacked' }, { page })).status, 403);
  await t1.post(`${page}/rename`, { title: 'Formatting thread, renamed' }, { page });
  assert.equal(db.prepare('SELECT title FROM forum_threads WHERE id = ?').get(tid).title, 'Formatting thread, renamed');
  await t1.post(`${page}/rename`, { title: '   ' }, { page });
  assert.equal(db.prepare('SELECT title FROM forum_threads WHERE id = ?').get(tid).title, 'Formatting thread, renamed');
  // A long message is not cut short by an edit.
  const first = db.prepare('SELECT id FROM forum_posts WHERE thread_id = ? ORDER BY id LIMIT 1').get(tid).id;
  const long = 'word '.repeat(1100).trim();
  await t1.post(`/discussions/p/${first}/edit`, { body: long }, { page });
  assert.equal(db.prepare('SELECT length(body) n FROM forum_posts WHERE id = ?').get(first).n, long.length);
  // Locked: no replies, no edits by the writer, no quote button.
  await owner.post(`${page}/lock`, {}, { page });
  assert.equal((await t1.post(`/discussions/p/${first}/edit`, { body: 'Changed after lock' }, { page })).status, 403);
  const locked = (await t1.get(page)).text;
  assert.doesNotMatch(locked, new RegExp(`action="/discussions/p/${first}/edit"`)); assert.doesNotMatch(locked, /Quote in a reply/);
  assert.equal((await t2.post(`${page}/reply`, [['body', 'Late reply']], { multipart: true, page })).status, 400);
});

test('discussions: a moderator can move a thread to another section, and pin it', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  const [a, b] = db.prepare('SELECT id, name FROM forum_sections ORDER BY id LIMIT 2').all();
  const made = await t1.post('/discussions/new', [['section_id', String(a.id)], ['title', 'Move me'], ['body', 'Wrong section']], { multipart: true, page: '/discussions/new' });
  const tid = Number(/\/discussions\/t\/(\d+)/.exec(made.location)[1]); const page = `/discussions/t/${tid}`;
  assert.equal((await t1.post(`${page}/move`, { section_id: String(b.id) }, { page })).status, 403);
  await owner.post(`${page}/move`, { section_id: String(b.id) }, { page });
  assert.equal(db.prepare('SELECT section_id FROM forum_threads WHERE id = ?').get(tid).section_id, b.id);
  assert.match((await owner.get(page)).text, new RegExp(`Moved to ${b.name}`));
  assert.match((await t1.get(`/discussions/s/${b.id}`)).text, /Move me/); assert.doesNotMatch((await t1.get(`/discussions/s/${a.id}`)).text, /Move me/);
  await owner.post(`${page}/pin`, {}, { page });
  assert.match((await t1.get(page)).text, /class="tag pin">Pinned/);
});

test('tasks: whoever assigned a task, or manages the person, can delete it from the list; the person it was given to cannot', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  await owner.post('/admin/tasks', { title: 'Delete me task', assign_to: String(userId('tech1')) }, { page: '/admin/tasks' });
  let row = db.prepare("SELECT id FROM tasks WHERE title = 'Delete me task'").get();
  if (!row) { db.prepare("INSERT INTO tasks (title, assigned_to, assigned_by, created_at) VALUES ('Delete me task', ?, ?, ?)").run(userId('tech1'), userId('owner'), new Date().toISOString()); row = db.prepare("SELECT id FROM tasks WHERE title = 'Delete me task'").get(); }
  db.prepare('INSERT INTO task_notes (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(row.id, userId('tech1'), 'Working on it', new Date().toISOString());
  assert.match((await owner.get('/admin/tasks')).text, new RegExp(`action="/admin/tasks/${row.id}/delete"[^>]*data-confirm="Delete the task`));
  assert.doesNotMatch((await t1.get('/tasks')).text, /Delete this task/);
  assert.equal((await t1.post(`/admin/tasks/${row.id}/delete`, {}, { page: '/tasks' })).status, 403);
  const r = await owner.post(`/admin/tasks/${row.id}/delete`, { show: 'open' }, { page: '/admin/tasks' });
  assert.equal(r.location, '/admin/tasks?show=open');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE id = ?').get(row.id).n + db.prepare('SELECT COUNT(*) n FROM task_notes WHERE task_id = ?').get(row.id).n, 0);
  assert.match((await owner.get('/admin/tasks')).text, /Task &#34;Delete me task&#34; deleted/);
  // A task you gave yourself can be deleted from My tasks.
  db.prepare("INSERT INTO tasks (title, assigned_to, assigned_by, created_at) VALUES ('Self task', ?, ?, ?)").run(userId('owner'), userId('owner'), new Date().toISOString());
  const self = db.prepare("SELECT id FROM tasks WHERE title = 'Self task'").get().id;
  assert.match((await owner.get('/tasks')).text, new RegExp(`action="/admin/tasks/${self}/delete" class="task-del"`));
  assert.equal((await owner.post(`/admin/tasks/${self}/delete`, { back: 'mine' }, { page: '/tasks' })).location, '/tasks');
});

test('security: guessable passwords are refused and replaced; sensitive actions ask for the password again', async () => {
  const authRoutes = require('../app/routes/auth'); authRoutes.clearLoginFailures();
  const age = (username) => db.prepare("UPDATE sessions SET data = json_set(data, '$.pwAt', 1) WHERE json_extract(data, '$.userId') = ?").run(userId(username));   // "the password was typed long ago"
  makeUser('sec.one', 'Sandy Secure');
  const c = await loggedIn('sec.one');
  // Choosing a password: common words, patterns and your own name are turned away.
  for (const weak of ['Testing123', 'Password2026!', 'Welcome123!!', '1234567890', '717-555-0100!', 'aaaaaaaaaaaa', 'qwertyuiop', 'sandy secure 99', 'PyeBarker2026!']) {
    const r = await c.post('/account/password', { current: 'correct horse battery', password: weak, confirm: weak });
    assert.equal(r.status, 400, weak); assert.match(r.text, /too easy to guess|at least 10 characters/, weak);
  }
  assert.equal((await c.post('/account/password', { current: 'correct horse battery', password: 'purple otter climbs 42', confirm: 'purple otter climbs 42' })).status, 302);
  // Someone whose existing password is guessable has to replace it the next time they sign in.
  const wid = makeUser('sec.weak', 'Wendy Weak'); db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword('Testing123'), wid);
  const w = new Client(); const first = await w.post('/login', { username: 'sec.weak', password: 'Testing123' }, { page: '/login' });
  assert.equal(first.location, '/account/password');
  assert.equal(db.prepare('SELECT must_change_password m FROM users WHERE id = ?').get(wid).m, 1);
  assert.match((await w.get('/account/password')).text, /too easy to guess, so it needs replacing/);
  assert.equal((await w.get('/')).location, '/account/password');
  await w.post('/account/password', { current: 'Testing123', password: 'four unrelated words here', confirm: 'four unrelated words here' });
  assert.equal((await w.get('/')).status, 200);
  // Guessing the current password on the change form is counted, and stops after ten.
  const g = await loggedIn('tech1');
  for (let i = 0; i < 10; i++) assert.match((await g.post('/account/password', { current: `guess ${i}`, password: 'another fine password 7', confirm: 'another fine password 7' })).text, /Current password is not right/);
  assert.match((await g.post('/account/password', { current: 'correct horse battery', password: 'another fine password 7', confirm: 'another fine password 7' })).text, /Too many wrong passwords/);
  authRoutes.clearLoginFailures();

  // Adding a Face ID device: fine straight after signing in, but an old session must type the password first.
  const t = await loggedIn('tech2');
  assert.equal((await sendJson(t, '/passkey/register/options')).status, 200);
  age('tech2');
  const refused = await sendJson(t, '/passkey/register/options');
  assert.equal(refused.status, 401); assert.equal(refused.body.needPassword, true);
  assert.equal((await sendJson(t, '/account/confirm', { password: 'wrong' })).status, 401);
  assert.equal((await sendJson(t, '/account/confirm', { password: 'correct horse battery' })).status, 200);
  assert.equal((await sendJson(t, '/passkey/register/options')).status, 200);

  // Downloading a backup: the same.
  const owner = await loggedIn('owner');
  await owner.post('/admin/backups/run', {}, { page: '/admin/backups' });
  const name = require('../app/backup').listBackups()[0].name;
  assert.equal((await owner.get(`/admin/backups/${name}`)).status, 200);
  age('owner');
  assert.equal((await owner.get(`/admin/backups/${name}`)).location, '/admin/backups#confirm');
  assert.equal((await owner.get('/admin/backups/photos.tar.gz')).location, '/admin/backups#confirm');
  assert.match((await owner.get('/admin/backups')).text, /action="\/account\/confirm"[\s\S]*Type your password to download/);
  assert.equal((await owner.post('/account/confirm', { password: 'correct horse battery', next: '/admin/backups' }, { page: '/admin/backups' })).location, '/admin/backups');
  assert.equal((await owner.get(`/admin/backups/${name}`)).status, 200);
  assert.doesNotMatch((await owner.get('/admin/backups')).text, /Type your password to download/);
  // The confirm step cannot be used to bounce someone to another site.
  assert.equal((await owner.post('/account/confirm', { password: 'correct horse battery', next: '//evil.example' }, { page: '/admin/backups' })).location, '/');
});

test('security: hostile input cannot crash a page, and the security check page is for corporate admins', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1');
  // A wall of quote marks (or anything else) in a message is shown, not choked on.
  const fmt = require('../app/format');
  for (const nasty of ['>'.repeat(6000) + ' deep', '> '.repeat(3000) + 'deep', '*a '.repeat(2000), '['.repeat(6000), '`'.repeat(6000), ('- x\n').repeat(3000), '**'.repeat(3000)]) assert.equal(typeof fmt.render(nasty), 'string');
  assert.match(fmt.render('> one\n> > two\n> > > three\n> > > > four\n> > > > > five'), /<blockquote>[\s\S]*<blockquote>[\s\S]*<blockquote>[\s\S]*<blockquote>[\s\S]*&gt; five/);
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  const made = await t1.post('/discussions/new', [['section_id', String(sec)], ['title', 'Deep quote'], ['body', '>'.repeat(5500) + ' hello']], { multipart: true, page: '/discussions/new' });
  assert.equal((await t1.get(made.location)).status, 200);
  // Far too much in one go, or something unreadable, gets a plain refusal, not an error page that itself fails.
  const big = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=' + 'a'.repeat(400000) });
  assert.equal(big.status, 413);
  const broken = await fetch(base + '/passkey/auth/options', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal((await t1.get('/social?page=99999999999999999999')).status, 200);
  // Every response says which device features the site may use.
  assert.match((await t1.get('/')).headers.get('permissions-policy'), /camera=\(self\), microphone=\(\)/);
  // An account with no office sees no office's records (never everyone's).
  const lost = makeUser('sec.lost', 'Lee Lostoffice'); db.prepare('UPDATE users SET branch_id = NULL, profile_id = ? WHERE id = ?').run(profileId('Admin (no complaints)') || profileId('Admin'), lost);
  db.prepare("DELETE FROM profile_permissions WHERE permission = 'branches.all' AND profile_id = (SELECT profile_id FROM users WHERE id = ?)").run(lost);
  const l = await loggedIn('sec.lost');
  const seen = (await l.get('/admin/users')).text;
  assert.doesNotMatch(seen, /Terry Tech|Olive Owner/);
  db.prepare("INSERT OR IGNORE INTO profile_permissions (profile_id, permission) SELECT id, 'branches.all' FROM profiles WHERE name = 'Admin'").run();
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(lost);
  // The security check page.
  assert.equal((await t1.get('/admin/security')).status, 403);
  const page = (await owner.get('/admin/security')).text;
  assert.match(page, /Security check<\/h1>/); assert.match(page, /The site knows its own address/); assert.match(page, /Admins sign in with Face ID or a fingerprint/);
  // Sign everyone else out: other sessions end, this one stays.
  assert.equal((await t1.post('/admin/security/sign-out-everyone', {}, { page: '/' })).status, 403);
  await owner.post('/admin/security/sign-out-everyone', {}, { page: '/admin/security' });
  assert.equal((await t1.get('/')).location, '/login?next=%2F');
  assert.equal((await owner.get('/admin/security')).status, 200);
  // Sign-in throttling counts by the visitor's own address: Cloudflare's header on Render, the proxy chain elsewhere.
  const { clientIp } = require('../app/clientip');
  assert.equal(clientIp({ ip: '10.0.0.5', headers: { 'cf-connecting-ip': '203.0.113.7' } }), '10.0.0.5');
  process.env.RENDER = 'true';
  assert.equal(clientIp({ ip: '10.0.0.5', headers: { 'cf-connecting-ip': '203.0.113.7' } }), '203.0.113.7');
  assert.equal(clientIp({ ip: '10.0.0.5', headers: { 'cf-connecting-ip': 'not an address' } }), '10.0.0.5');
  delete process.env.RENDER;
});

test('on call across a market: your own office first, each person tagged with their office, and offices with nobody listed are named', async () => {
  const t1 = await loggedIn('tech1');
  const mk = (name) => db.prepare("INSERT INTO branches (name, market, created_at) VALUES (?, 'Test Market', ?)").run(name, new Date().toISOString()).lastInsertRowid;
  db.prepare("UPDATE branches SET market = 'Test Market' WHERE id = 1").run();
  const near = mk('Nearby Office'), quiet = mk('Quiet Office');
  const shift = (office, name, role) => db.prepare("INSERT INTO oncall_shifts (branch_id, start_on, end_on, role, name, phone, created_at) VALUES (?, date('now', '-1 day'), date('now', '+6 day'), ?, ?, '717-555-0142', ?)").run(office, role, name, new Date().toISOString());
  db.prepare('DELETE FROM oncall_shifts').run();
  shift(near, 'Nell Nearby', 'tech'); shift(1, 'Owen Ownoffice', 'tech'); shift(1, 'Bea Backup', 'backup');
  const page = (await t1.get('/oncall')).text;
  assert.match(page, /in the Test Market market/);
  assert.ok(page.indexOf('Owen Ownoffice') < page.indexOf('Nell Nearby'), 'own office comes first');
  assert.match(page, /Nobody is listed today for 1 of the 3 offices in this market:<\/strong>\s*<a href="\/branches\/\d+">Quiet Office<\/a>/);
  const home = /<section class="panel p-oncall"[\s\S]*?<\/section>/.exec((await t1.get('/')).text)[0];
  // The home page shows only the office being looked at; the rest of the market is on the On call page.
  assert.match(home, /Owen Ownoffice/); assert.doesNotMatch(home, /Nell Nearby/);
  // Someone in an office outside the market sees none of it.
  const far = db.prepare("SELECT u.username FROM users u JOIN branches b ON b.id = u.branch_id WHERE u.active = 1 AND u.must_change_password = 0 AND (b.market IS NULL OR b.market <> 'Test Market') LIMIT 1").get();
  if (far) { const c = new Client(); const r = await c.post('/login', { username: far.username, password: 'correct horse battery' }, { page: '/login' }); if (r.status === 302) assert.doesNotMatch((await c.get('/oncall')).text, /Nell Nearby|Owen Ownoffice/); }
  db.prepare('DELETE FROM oncall_shifts').run(); db.prepare('UPDATE branches SET market = NULL WHERE id = 1').run();
});

test('moderation stays inside the office: an office admin removes only what their own people wrote; a corporate admin removes anything', async () => {
  const owner = await loggedIn('owner');                                                   // corporate: sees every office
  const office = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Modville', ?)").run(new Date().toISOString()).lastInsertRowid;
  access.ensureProfile('Office moderator', 'all', [...access.SUBMIT, 'forum.use', 'forum.moderate', 'announcements.post', 'users.manage']);
  const mk = (username, name, profile, branch) => { const id = makeUser(username, name); db.prepare('UPDATE users SET profile_id = ?, branch_id = ? WHERE id = ?').run(profileId(profile), branch, id); return id; };
  mk('mod.admin', 'Mona Modville', 'Office moderator', office); const local = mk('mod.local', 'Lars Local', 'Technician', office);
  const mod = await loggedIn('mod.admin'); const lars = await loggedIn('mod.local'); const t1 = await loggedIn('tech1');   // tech1 is in another office
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  const start = async (c, title) => Number(/\/discussions\/t\/(\d+)/.exec((await c.post('/discussions/new', [['section_id', String(sec)], ['title', title], ['body', 'Hello']], { multipart: true, page: '/discussions/new' })).location)[1]);
  const far = await start(t1, 'Thread from another office'); const near = await start(lars, 'Thread from Modville');
  await lars.post(`/discussions/t/${far}/reply`, [['body', 'Modville reply']], { multipart: true, page: `/discussions/t/${far}` });
  await t1.post(`/discussions/t/${near}/reply`, [['body', 'Other office reply']], { multipart: true, page: `/discussions/t/${near}` });
  const post = (thread, uid) => db.prepare('SELECT id FROM forum_posts WHERE thread_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(thread, uid).id;
  const farReplyByLars = post(far, local), nearReplyByTech = post(near, userId('tech1'));
  // Another office's thread: no moderator tools, and the actions are refused.
  const farPage = (await mod.get(`/discussions/t/${far}`)).text;
  assert.doesNotMatch(farPage, /Moderator tools|Remove thread/);
  assert.match(farPage, new RegExp(`action="/discussions/p/${farReplyByLars}/delete"`));                              // but her own office's reply in it is hers to remove
  for (const op of ['lock', 'pin', 'delete']) assert.equal((await mod.post(`/discussions/t/${far}/${op}`, {}, { page: `/discussions/t/${far}` })).status, 403, op);
  assert.equal((await mod.post(`/discussions/t/${far}/move`, { section_id: String(sec) }, { page: `/discussions/t/${far}` })).status, 403);
  assert.equal((await mod.post(`/discussions/t/${far}/rename`, { title: 'Hijacked' }, { page: `/discussions/t/${far}` })).status, 403);
  // Her own office's thread: tools are there, but a reply written by another office is not hers to remove.
  const nearPage = (await mod.get(`/discussions/t/${near}`)).text;
  assert.match(nearPage, /Moderator tools/);
  assert.doesNotMatch(nearPage, new RegExp(`action="/discussions/p/${nearReplyByTech}/delete"`));
  assert.equal((await mod.post(`/discussions/p/${nearReplyByTech}/delete`, {}, { page: `/discussions/t/${near}` })).status, 403);
  assert.equal((await mod.post(`/discussions/p/${farReplyByLars}/delete`, {}, { page: `/discussions/t/${far}` })).status, 302);
  assert.equal(db.prepare('SELECT 1 FROM forum_posts WHERE id = ?').get(farReplyByLars), undefined);
  assert.equal((await mod.post(`/discussions/t/${near}/pin`, {}, { page: `/discussions/t/${near}` })).status, 302);
  // Shout-outs and photos follow the same rule.
  await t1.post('/shoutouts', { to_user: String(userId('tech2')), message: 'From another office' }, { page: '/shoutouts' });
  await lars.post('/shoutouts', { to_user: String(userId('mod.admin')), message: 'From Modville' }, { page: '/shoutouts' });
  const farShout = db.prepare("SELECT id FROM shoutouts WHERE message = 'From another office'").get().id, nearShout = db.prepare("SELECT id FROM shoutouts WHERE message = 'From Modville'").get().id;
  const shouts = (await mod.get('/shoutouts')).text;
  assert.match(shouts, new RegExp(`action="/shoutouts/${nearShout}/delete"`)); assert.doesNotMatch(shouts, new RegExp(`action="/shoutouts/${farShout}/delete"`));
  assert.equal((await mod.post(`/shoutouts/${farShout}/delete`, {}, { page: '/shoutouts' })).status, 403);
  assert.equal((await mod.post(`/shoutouts/${nearShout}/delete`, {}, { page: '/shoutouts' })).status, 302);
  await t1.post('/photos', [['caption', 'Far photo'], ['photos', new File([PNG], 'a.png', { type: 'image/png' })]], { multipart: true, page: '/social' });
  const farPhoto = db.prepare("SELECT post_id FROM wall_photos WHERE caption = 'Far photo'").get().post_id;
  assert.doesNotMatch((await mod.get('/social')).text, new RegExp(`action="/social/${farPhoto}/delete"`));
  assert.equal((await mod.post(`/social/${farPhoto}/delete`, {}, { page: '/social' })).status, 403);
  // Comments under a company-wide announcement: only her own people's.
  await owner.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
  await owner.post('/admin/announcements', { title: 'Company-wide moderation notice', body: 'For everyone', audience: 'all' }, { page: '/admin/announcements' });
  const nid = db.prepare("SELECT id FROM announcements WHERE title = 'Company-wide moderation notice'").get().id;
  db.prepare('UPDATE announcements SET branch_id = NULL WHERE id = ?').run(nid);
  await t1.post(`/notices/${nid}/comment`, { body: 'Comment from another office' }, { page: '/notices' }); await lars.post(`/notices/${nid}/comment`, { body: 'Comment from Modville' }, { page: '/notices' });
  const farC = db.prepare("SELECT id FROM announcement_comments WHERE body = 'Comment from another office'").get().id, nearC = db.prepare("SELECT id FROM announcement_comments WHERE body = 'Comment from Modville'").get().id;
  assert.equal((await mod.post(`/notices/comment/${farC}/delete`, {}, { page: '/notices' })).status, 403);
  assert.equal((await mod.post(`/notices/comment/${nearC}/delete`, {}, { page: '/notices' })).status, 302);
  // The corporate admin can remove anything, anywhere; whoever posted the announcement can clear comments under it.
  assert.equal((await owner.post(`/notices/comment/${farC}/delete`, {}, { page: '/notices' })).status, 302);
  assert.equal((await owner.post(`/social/${farPhoto}/delete`, {}, { page: '/social' })).status, 302);
  assert.equal((await owner.post(`/shoutouts/${farShout}/delete`, {}, { page: '/shoutouts' })).status, 302);
  assert.equal((await owner.post(`/discussions/p/${nearReplyByTech}/delete`, {}, { page: `/discussions/t/${near}` })).status, 302);
  assert.equal((await owner.post(`/discussions/t/${far}/delete`, {}, { page: `/discussions/t/${far}` })).status, 302);
  await owner.post('/branch/view', { branch: '1', back: '/' }, { page: '/' });
});

test('temporary passwords expire after 14 days; fresh sign-in details restart the clock; a password the person chose never expires', async () => {
  const owner = await loggedIn('owner'); const authRoutes = require('../app/routes/auth'); authRoutes.clearLoginFailures();
  await owner.post('/admin/users', { username: 'temp.tina', display_name: 'Tina Temp', profile_id: String(profileId('Technician')) }, { page: '/admin/users' });
  const tid = userId('temp.tina');
  const shown = /<p class="code">([^<]+)<\/p>/.exec((await owner.get('/admin/users')).text); assert.ok(shown, 'the temporary password is shown once');
  const temp = shown[1];
  assert.ok(db.prepare('SELECT temp_set_at FROM users WHERE id = ?').get(tid).temp_set_at);
  // Inside the window it works (and must be changed).
  assert.equal((await new Client().post('/login', { username: 'temp.tina', password: temp }, { page: '/login' })).location, '/account/password');
  // Fifteen days on, the same temporary password is refused, with the reason, and no session is made.
  db.prepare('UPDATE users SET temp_set_at = ? WHERE id = ?').run(new Date(Date.now() - 15 * 86400000).toISOString(), tid);
  const late = new Client(); const r = await late.post('/login', { username: 'temp.tina', password: temp }, { page: '/login' });
  assert.equal(r.status, 401); assert.match(r.text, /temporary password has expired\. They last 14 days/);
  assert.equal((await late.get('/')).location, '/login?next=%2F');
  assert.match((await late.post('/login', { username: 'temp.tina', password: 'wrong guess' }, { page: '/login' })).text, /Wrong username or password/);   // a wrong guess learns nothing about expiry
  const list = (await owner.get('/admin/users')).text;
  assert.match(list, /Tina Temp[\s\S]*?<td data-state>Temporary password expired<\/td>/);
  assert.match((await owner.get('/admin/users/invite')).text, /Tina Temp<\/strong>[\s\S]*?temporary password expired/);
  // Fresh sign-in details work again.
  await owner.post('/admin/users/invite', [['who', String(tid)]], { page: '/admin/users/invite' });
  const fresh = /Temporary password: (\S+)/.exec((await owner.get('/admin/users/invite')).text)[1];
  const tina = new Client();
  assert.equal((await tina.post('/login', { username: 'temp.tina', password: fresh }, { page: '/login' })).location, '/account/password');
  await tina.post('/account/password', { current: fresh, password: 'lantern river maple 8', confirm: 'lantern river maple 8' });
  assert.deepEqual(db.prepare('SELECT must_change_password m, temp_set_at t FROM users WHERE id = ?').get(tid), { m: 0, t: null });
  // A password the person chose does not expire, even when they are asked to replace it for being guessable.
  const wid = makeUser('temp.weak', 'Wes Weakpass'); db.prepare('UPDATE users SET password_hash = ?, temp_set_at = ? WHERE id = ?').run(auth.hashPassword('Welcome123!!'), new Date(Date.now() - 400 * 86400000).toISOString(), wid);
  const w = new Client();
  assert.equal((await w.post('/login', { username: 'temp.weak', password: 'Welcome123!!' }, { page: '/login' })).location, '/account/password');
  assert.equal(db.prepare('SELECT temp_set_at t FROM users WHERE id = ?').get(wid).t, null);
  assert.equal((await new Client().post('/login', { username: 'temp.weak', password: 'Welcome123!!' }, { page: '/login' })).location, '/account/password');
  // Someone asked to replace a guessable password before this rule arrived was given a clock by mistake: typing their own password clears it.
  db.prepare('UPDATE users SET must_change_password = 1, temp_set_at = ? WHERE id = ?').run(new Date(Date.now() - 400 * 86400000).toISOString(), wid);
  assert.equal((await new Client().post('/login', { username: 'temp.weak', password: 'Welcome123!!' }, { page: '/login' })).location, '/account/password');
  assert.equal(db.prepare('SELECT temp_set_at t FROM users WHERE id = ?').get(wid).t, null);
  // An admin's reset starts a new 14 days.
  await owner.post(`/admin/users/${wid}/reset-password`, {}, { page: '/admin/users' });
  assert.ok(Date.now() - new Date(db.prepare('SELECT temp_set_at t FROM users WHERE id = ?').get(wid).t).getTime() < 60000);
  // A sign-in started with a temporary password and never finished ends when the password expires: it cannot be completed weeks later.
  const wesTemp = /<p class="code">([^<]+)<\/p>/.exec((await owner.get('/admin/users')).text)[1];
  const half = new Client();
  assert.equal((await half.post('/login', { username: 'temp.weak', password: wesTemp }, { page: '/login' })).location, '/account/password');
  const token = await half.csrf('/account/password');                                    // the form is open in front of them
  db.prepare('UPDATE users SET temp_set_at = ? WHERE id = ?').run(new Date(Date.now() - 15 * 86400000).toISOString(), wid);
  const tried = await half.post('/account/password', { _csrf: token, current: wesTemp, password: 'harbor walnut ticket 52', confirm: 'harbor walnut ticket 52' }, { csrf: false });
  assert.notEqual(tried.status, 200); assert.notEqual(tried.location, '/');
  assert.match((await half.get('/account/password')).location, /^\/login/);
  assert.equal(db.prepare('SELECT must_change_password m FROM users WHERE id = ?').get(wid).m, 1);
  assert.equal(auth.checkLogin('temp.weak', 'harbor walnut ticket 52'), null);
  // The master account is never shut out this way: nobody else could hand it a new one.
  assert.equal(auth.tempExpired({ is_master: 1, must_change_password: 1, temp_set_at: new Date(Date.now() - 90 * 86400000).toISOString() }), false);
  assert.equal(auth.tempExpired({ must_change_password: 1, temp_set_at: new Date(Date.now() - 15 * 86400000).toISOString() }), true);
  assert.equal(auth.tempExpired({ must_change_password: 1, temp_set_at: new Date(Date.now() - 13 * 86400000).toISOString() }), false);
  assert.equal(auth.tempExpired({ must_change_password: 0, temp_set_at: new Date(Date.now() - 15 * 86400000).toISOString() }), false);
});

test('the idle lock depends on the device: 10 minutes on a phone or tablet, 20 on a computer', async () => {
  const device = require('../app/device'); const config = require('../app/config');
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const ANDROID_DESKTOP_MODE = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  assert.deepEqual(config.lockAfterMs, { phone: 10 * 60000, desktop: 20 * 60000 });
  const kind = (ua, extra = {}) => device.kind({ headers: { 'user-agent': ua, ...extra } });
  assert.equal(kind(WIN), 'desktop'); assert.equal(kind(MAC), 'desktop'); assert.equal(kind(ANDROID_DESKTOP_MODE), 'desktop');
  assert.equal(kind(IPHONE), 'phone'); assert.equal(kind(ANDROID_TABLET), 'phone');
  assert.equal(kind(MAC, { cookie: 'portal.sid=abc; portal.touch=1' }), 'phone');                // an iPad says it is a Mac; the page reports the touch screen
  assert.equal(kind(ANDROID_DESKTOP_MODE, { cookie: 'portal.touch=1' }), 'phone');               // a phone asked for the desktop site
  assert.equal(kind(MAC, { cookie: 'portal.touch=0; portal.sid=abc' }), 'desktop');
  assert.equal(kind(MAC, { cookie: 'xportal.touch=1' }), 'desktop');                             // only the exact note counts
  assert.equal(kind(WIN, { 'sec-ch-ua-mobile': '?1' }), 'phone');
  assert.equal(kind(''), 'phone'); assert.equal(kind('curl/8.5.0'), 'phone'); assert.equal(device.kind({}), 'phone');   // not plainly a desk computer: lock sooner
  // The page sets that note before anything is drawn, on every page including the sign-in page.
  const theme = (await new Client().get('/theme.js')).text;
  assert.match(theme, /pointer: coarse/); assert.match(theme, /portal\.touch=/);

  makeUser('lock.desk', 'Dora Desk');
  const sidOf = (c) => /portal\.sid=([^;]+)/.exec(c.cookie)[1];
  const sess = (c) => { const sid = decodeURIComponent(sidOf(c)).slice(2).split('.')[0]; return { sid, d: JSON.parse(db.prepare('SELECT data FROM sessions WHERE sid = ?').get(sid).data) }; };
  const age = (c, min) => { const r = sess(c); r.d.seenAt = Date.now() - min * 60000; db.prepare('UPDATE sessions SET data = ? WHERE sid = ?').run(JSON.stringify(r.d), r.sid); };
  const signIn = async (c) => { await c.login('lock.desk', 'correct horse battery'); return c; };

  // A computer: 20 minutes.
  const desk = await signIn(new Client(WIN));
  assert.match((await desk.get('/')).text, /data-lock-after="1200000"/);
  age(desk, 19); assert.equal((await desk.get('/my')).status, 200);
  age(desk, 11); assert.equal((await desk.get('/alive')).status, 204);                         // past a phone's limit, well inside a computer's
  age(desk, 21); assert.equal((await desk.get('/my')).location, '/unlock?next=%2Fmy');
  await desk.post('/unlock', { password: 'correct horse battery' }, { page: '/unlock' });

  // A phone: 10 minutes.
  const phone = await signIn(new Client(IPHONE));
  assert.match((await phone.get('/')).text, /data-lock-after="600000"/);
  age(phone, 9); assert.equal((await phone.get('/my')).status, 200);
  age(phone, 11); assert.equal((await phone.get('/my')).location, '/unlock?next=%2Fmy');

  // An iPad (says it is a Mac, has a touch screen and no mouse): a tablet, so 10 minutes.
  const ipad = await signIn(new Client(MAC, 'portal.touch=1'));
  assert.match((await ipad.get('/')).text, /data-lock-after="600000"/);
  age(ipad, 11); assert.equal((await ipad.get('/my')).location, '/unlock?next=%2Fmy');
  // The same session opened on a computer and on a phone is judged by the device each request comes from.
  await ipad.post('/unlock', { password: 'correct horse battery' }, { page: '/unlock' });
  age(ipad, 15); ipad.extra = ''; assert.equal((await ipad.get('/my')).status, 200);            // no touch note: a Mac at a desk
  age(ipad, 15); ipad.extra = 'portal.touch=1'; assert.equal((await ipad.get('/my')).location, '/unlock?next=%2Fmy');

  // Settings: each kind has its own, the older single setting still stands in for both, and 0 switches a timer off.
  const fresh = (env) => { const keep = { ...process.env }; Object.assign(process.env, env); delete require.cache[require.resolve('../app/config')]; const c = require('../app/config').lockAfterMs; delete require.cache[require.resolve('../app/config')]; for (const k of Object.keys(env)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } require.cache[require.resolve('../app/config')] = cached; return c; };
  const cached = require.cache[require.resolve('../app/config')];
  assert.deepEqual(fresh({ LOCK_AFTER_MINUTES_PHONE: '3', LOCK_AFTER_MINUTES_DESKTOP: '45' }), { phone: 3 * 60000, desktop: 45 * 60000 });
  assert.deepEqual(fresh({ LOCK_AFTER_MINUTES: '5' }), { phone: 5 * 60000, desktop: 5 * 60000 });
  assert.deepEqual(fresh({ LOCK_AFTER_MINUTES: '5', LOCK_AFTER_MINUTES_DESKTOP: '30' }), { phone: 5 * 60000, desktop: 30 * 60000 });
  assert.deepEqual(fresh({ LOCK_AFTER_MINUTES_PHONE: '0' }), { phone: 0, desktop: 20 * 60000 });
  assert.deepEqual(fresh({ LOCK_AFTER_MINUTES_PHONE: 'nonsense', LOCK_AFTER_MINUTES_DESKTOP: '-4' }), { phone: 10 * 60000, desktop: 20 * 60000 });   // a typing mistake does not switch a timer off
  assert.deepEqual(fresh({ LOCK_AFTER_MINUTES: '0' }), { phone: 0, desktop: 0 });
  assert.equal(require('../app/config'), cached.exports);
});

// ---- Database encryption. Each step runs a fresh copy of the app, the way a restart of the service does. ----
function encryptionLab() {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-enc-'));
  const root = path.join(__dirname, '..');
  const env = (extra) => ({ PATH: process.env.PATH, DATA_DIR: dir, BCRYPT_ROUNDS: '4', APP_TIMEZONE: 'America/New_York', ...extra });
  /** Start the app's database with these settings, run a little code against it, and hand back what it printed (or how it failed). */
  const run = (code, extra = {}) => {
    try { return { ok: true, out: execFileSync(process.execPath, ['-e', code], { cwd: root, env: env(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
  };
  const STATE = `const db = require('./app/db'); const b = require('./app/backup'); const aligned = b.alignWithKey();
    console.log(JSON.stringify({ e: db.encryption, aligned, users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      marker: (db.prepare("SELECT value v FROM meta WHERE key = 'marker'").get() || {}).v, since: (db.prepare("SELECT value v FROM meta WHERE key = 'db_encrypted_at'").get() || {}).v || null,
      integrity: db.pragma('integrity_check', { simple: true }), sign: Boolean(require('./app/auth').checkLogin('enc.one', 'correct horse battery')) }));`;
  const state = (extra) => { const r = run(STATE, extra); return r.ok ? JSON.parse(r.out.trim().split('\n').pop()) : r; };
  const SEED = `const db = require('./app/db'); const auth = require('./app/auth');
    auth.createUser({ username: 'enc.one', displayName: 'Enid Onesworth', password: 'correct horse battery', profile: 'Technician' });
    db.prepare("INSERT INTO meta (key, value) VALUES ('marker', 'kept')").run();
    require('./app/backup').runBackup({ manual: true }).then((n) => console.log(n));`;
  const file = path.join(dir, 'portal.db');
  const raw = () => ['', '-wal'].map((x) => (fs.existsSync(file + x) ? fs.readFileSync(file + x).toString('latin1') : '')).join('');
  const backups = () => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db')).sort().map((f) => path.join(dir, 'backups', f)) : []);
  const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  return { dir, root, env, run, state, SEED, file, raw, backups, sha };
}

test('database encryption: DB_KEY encrypts the database and its backups where they stand; a wrong or missing key harms nothing; the key can be changed', async () => {
  const dbfile = require('../app/dbfile');
  const L = encryptionLab();
  const KEY = 'first-key-0123456789-abcdefghij', KEY2 = "second key, with a ' quote and spaces 0123456789";
  const COPY = L.file + '.before-key-change';

  // An ordinary site with no key: an ordinary SQLite file anyone could read.
  assert.ok(L.run(L.SEED).ok);
  let s = L.state();
  assert.deepEqual([s.e.encrypted, s.e.changed, s.users, s.marker, s.since], [false, null, 1, 'kept', null]);
  assert.ok(dbfile.isPlain(L.file)); assert.match(L.raw(), /Enid Onesworth/);
  assert.equal(L.backups().length, 1); assert.ok(dbfile.isPlain(L.backups()[0]));
  assert.deepEqual(s.aligned, { encrypted: 0, rekeyed: 0, decrypted: 0, plain: 1, foreign: 0 });

  // A key that is too short is not used: nothing changes, and the reason is given.
  s = L.state({ DB_KEY: 'too-short' });
  assert.equal(s.e.encrypted, false); assert.match(s.e.note, /shorter than 20 characters/); assert.ok(dbfile.isPlain(L.file));

  // The first start with a key: the database is encrypted where it stands, everything still there, the backup too.
  s = L.state({ DB_KEY: KEY });
  assert.deepEqual([s.e.encrypted, s.e.changed, s.e.note, s.users, s.marker, s.integrity, s.sign], [true, 'encrypted', null, 1, 'kept', 'ok', true]);
  assert.ok(s.since);
  assert.deepEqual(s.aligned, { encrypted: 1, rekeyed: 0, decrypted: 0, plain: 0, foreign: 0 });
  assert.equal(dbfile.isPlain(L.file), false); assert.doesNotMatch(L.raw(), /Enid Onesworth|enc\.one|SQLite format 3/);
  assert.equal(dbfile.isPlain(L.backups()[0]), false); assert.doesNotMatch(fs.readFileSync(L.backups()[0]).toString('latin1'), /Enid Onesworth|SQLite format 3/);
  assert.ok(dbfile.readable(L.backups()[0], KEY)); assert.equal(dbfile.readable(L.backups()[0], 'not-the-key-not-the-key-0000'), false);
  assert.equal(fs.existsSync(COPY), false);                                                   // the copy set aside for the change is gone
  assert.doesNotMatch(fs.readdirSync(L.dir).join(' '), /before-key-change/);

  // Later starts with the same key just open it. A backup made now is encrypted from the start.
  s = L.state({ DB_KEY: KEY });
  assert.deepEqual([s.e.encrypted, s.e.changed, s.users], [true, null, 1]);
  assert.ok(L.run(`require('./app/backup').runBackup({ manual: true, now: new Date(Date.now() + 5000) }).then((n) => console.log(n));`, { DB_KEY: KEY }).ok);
  assert.equal(L.backups().length, 2);
  for (const b of L.backups()) { assert.equal(dbfile.isPlain(b), false); assert.ok(dbfile.readable(b, KEY)); }

  // A wrong key, no key, or a mistyped one: the site refuses to open the database and leaves every byte alone.
  const before = L.sha(L.file);
  for (const [settings, says] of [[{ DB_KEY: 'a-wrong-key-a-wrong-key-12345' }, /different key from the one in the hosting settings/], [{}, /its key \(DB_KEY\) is missing/], [{ DB_KEY: KEY + 'x' }, /different key/], [{ DB_KEY: 'short' }, /different key/]]) {
    const r = L.run(L.SEED, settings);
    assert.equal(r.ok, false); assert.match(r.err, says); assert.match(r.err, /KeyProblem/);
    assert.doesNotMatch(r.err + r.out, new RegExp(KEY));                                      // the key itself is never printed
  }
  assert.equal(L.sha(L.file), before);
  assert.equal((s = L.state({ DB_KEY: `  ${KEY}\n` })).e.encrypted, true);                    // stray spaces round a pasted key are ignored

  // Changing the key: the new one in DB_KEY, the current one in DB_KEY_OLD.
  s = L.state({ DB_KEY: KEY2, DB_KEY_OLD: KEY });
  assert.deepEqual([s.e.encrypted, s.e.changed, s.e.usingOldKey, s.users, s.marker, s.integrity], [true, 'rekeyed', false, 1, 'kept', 'ok']);
  assert.deepEqual(s.aligned, { encrypted: 0, rekeyed: 2, decrypted: 0, plain: 0, foreign: 0 });
  assert.ok(dbfile.readable(L.file, KEY2)); assert.equal(dbfile.readable(L.file, KEY), false);
  for (const b of L.backups()) { assert.ok(dbfile.readable(b, KEY2)); assert.equal(dbfile.readable(b, KEY), false); }
  s = L.state({ DB_KEY: KEY2, DB_KEY_OLD: KEY });                                             // DB_KEY_OLD left behind: harmless, and reported so it can be removed
  assert.deepEqual([s.e.changed, s.e.oldKeySet, s.e.usingOldKey], [null, true, false]);
  assert.deepEqual(s.aligned, { encrypted: 0, rekeyed: 0, decrypted: 0, plain: 0, foreign: 0 });
  s = L.state({ DB_KEY_OLD: KEY2 });                                                          // only the old name set: still opens, and says what to do
  assert.equal(s.e.usingOldKey, true); assert.match(s.e.note, /Put the new key in DB_KEY/);
  assert.ok(dbfile.readable(L.file, KEY2));

  // The server stopped half-way through a key change last time: the copy set aside beforehand is put back and the change starts again.
  fs.copyFileSync(L.file, COPY);
  fs.writeFileSync(L.file, Buffer.concat([require('crypto').randomBytes(4096), fs.readFileSync(L.file).subarray(4096, 9000)]));   // a half-rewritten file
  fs.writeFileSync(COPY + '.tmp', 'a copy that was never finished');
  s = L.state({ DB_KEY: KEY2 });
  assert.deepEqual([s.e.encrypted, s.users, s.marker, s.integrity, s.sign], [true, 1, 'kept', 'ok', true]);
  assert.doesNotMatch(fs.readdirSync(L.dir).join(' '), /before-key-change/);

  // Turning encryption off again: the key stays in place and DB_DECRYPT asks for it. The database and its backups become ordinary files.
  s = L.state({ DB_KEY: KEY2, DB_DECRYPT: 'yes' });
  assert.deepEqual([s.e.encrypted, s.e.changed, s.users, s.marker, s.integrity, s.sign, s.since], [false, 'decrypted', 1, 'kept', 'ok', true, null]);
  assert.equal(s.aligned.decrypted, 2); assert.ok(dbfile.isPlain(L.file)); for (const b of L.backups()) assert.ok(dbfile.isPlain(b));
  s = L.state({ DB_KEY: KEY2, DB_DECRYPT: 'yes' });                                           // still asked to stay off: stays off, and says why
  assert.deepEqual([s.e.encrypted, s.e.changed], [false, null]); assert.match(s.e.note, /DB_DECRYPT is set/); assert.ok(dbfile.isPlain(L.file));
  assert.equal(L.state({ DB_KEY: 'a-wrong-key-a-wrong-key-12345', DB_DECRYPT: 'yes' }).users, 1);          // unencrypted now, so which key is set is beside the point
  s = L.state({ DB_KEY: KEY2 });                                                              // DB_DECRYPT removed, key still there: encrypted again
  assert.deepEqual([s.e.encrypted, s.e.changed, s.marker], [true, 'encrypted', 'kept']); assert.equal(dbfile.isPlain(L.file), false);
  for (const b of L.backups()) assert.ok(dbfile.readable(b, KEY2));
  assert.match(L.run(L.SEED, { DB_KEY: 'a-wrong-key-a-wrong-key-12345', DB_DECRYPT: 'yes' }).err, /KeyProblem/);   // the off switch does nothing without the real key
  assert.equal(dbfile.isPlain(L.file), false);

  // A brand-new site with a key is encrypted from its first page.
  const N = encryptionLab();
  assert.ok(N.run(N.SEED, { DB_KEY: KEY }).ok);
  assert.equal(dbfile.isPlain(N.file), false); assert.doesNotMatch(N.raw(), /Enid Onesworth|SQLite format 3/);
  s = N.state({ DB_KEY: KEY });
  assert.deepEqual([s.e.encrypted, s.e.changed, s.users, s.sign], [true, null, 1, true]);
  assert.deepEqual(s.aligned, { encrypted: 0, rekeyed: 0, decrypted: 0, plain: 0, foreign: 0 });

  // Opening a backup somewhere else: the helper writes an unencrypted copy, only with the right key, and leaves the backup alone.
  const { execFileSync } = require('child_process');
  const b = L.backups()[0]; const out = path.join(L.dir, 'opened.db'); const kept = L.sha(b);
  const tool = (key, ...args) => { try { return { ok: true, out: execFileSync(process.execPath, ['scripts/decrypt-backup.js', ...args], { cwd: L.root, env: { PATH: process.env.PATH, DB_KEY: key }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, err: String(e.stderr) }; } };
  assert.match(tool(KEY, b, out).err, /That key does not open this backup/); assert.equal(fs.existsSync(out), false);
  assert.match(tool('', b, out).err, /Set DB_KEY/);
  assert.ok(tool(KEY2, b, out).ok); assert.ok(dbfile.isPlain(out)); assert.equal(L.sha(b), kept);
  const opened = dbfile.connect(out, '', { readonly: true });
  assert.equal(opened.prepare("SELECT display_name d FROM users WHERE username = 'enc.one'").get().d, 'Enid Onesworth'); opened.close();
  assert.match(tool(KEY2, out).err, /is not encrypted/);
});

test('database encryption: a wrong key shows a plain "closed" page instead of a broken site, and the Security check says where things stand', async () => {
  const { spawn } = require('child_process'); const net = require('net');
  const dbfile = require('../app/dbfile');
  const L = encryptionLab(); const KEY = 'page-test-key-0123456789-abcdef';
  assert.ok(L.run(L.SEED, { DB_KEY: KEY }).ok);
  const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const serve = async (settings) => {
    const port = await freePort(); let log = '';
    const child = spawn(process.execPath, ['app/server.js'], { cwd: L.root, env: L.env({ PORT: String(port), SESSION_SECRET: 'x'.repeat(40), ...settings }), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const get = (url) => fetch(`http://localhost:${port}${url}`, { redirect: 'manual' }).then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
    for (let i = 0; i < 100; i++) { try { await get('/healthz'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
    return { get, log: () => log, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
  };

  // The key is wrong: every page explains, in the browser, what to put right. Nothing about the data is given away, and nothing is harmed.
  const before = L.sha(L.file);
  let site = await serve({ DB_KEY: 'not-the-right-key-not-at-all-99' });
  let page = await site.get('/');
  assert.equal(page.status, 503); assert.match(page.text, /PB Portal is closed for the moment/); assert.match(page.text, /Nothing has been lost/);
  assert.match(page.text, /different key from the one in the hosting settings/); assert.match(page.text, /DB_KEY/);
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  for (const url of ['/login', '/admin/backups', '/admin/backups/portal-2026-01-01.db', '/styles.css']) assert.equal((await site.get(url)).status, 503, url);
  assert.equal((await site.get('/healthz')).status, 200);                                     // the host keeps the page reachable
  assert.match(site.log(), /showing a "closed" page/); assert.doesNotMatch(site.log() + page.text, /not-the-right-key|page-test-key/);
  await site.stop();
  site = await serve({});                                                                     // the key is missing altogether
  assert.match((await site.get('/')).text, /its key \(DB_KEY\) is missing from the hosting settings/);
  await site.stop();
  assert.equal(L.sha(L.file), before);

  // The right key: the site runs as usual, says in its log that it is encrypted, and never prints the key.
  site = await serve({ DB_KEY: KEY });
  assert.equal((await site.get('/login')).status, 200); assert.equal((await site.get('/')).status, 302);
  assert.doesNotMatch(site.log(), /page-test-key|not encrypted/);
  await site.stop();

  // The Security check. Encrypted: in order, with the reminder about keeping the key. DB_KEY_OLD left behind: asks for it to be removed.
  const CHECK = `const item = require('./app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }).find((c) => c.title === 'The database is encrypted'); console.log(JSON.stringify(item));`;
  let item = JSON.parse(L.run(CHECK, { DB_KEY: KEY }).out.trim().split('\n').pop());
  assert.equal(item.ok, true); assert.match(item.detail, /^Yes, since \d+\/\d+\/\d{4}\. The database, its backups, and the photos and documents people upload can only be opened with the key kept in the hosting settings \(DB_KEY\)\. 1 of 1 backups are encrypted\./);
  assert.match(item.after, /Without the key nobody can open the database/);
  assert.equal(item.code, undefined);
  item = JSON.parse(L.run(CHECK, { DB_KEY: KEY, DB_KEY_OLD: 'an-older-key-an-older-key-000' }).out.trim().split('\n').pop());
  assert.equal(item.ok, false); assert.match(item.fix, /delete DB_KEY_OLD/);

  // Not encrypted (this test site has no key): flagged, with a fresh key to copy each time and the steps to switch it on.
  const owner = await loggedIn('owner');
  await owner.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
  access.ensureProfile('Corporate admin', 'all', access.ALL);
  const cid = makeUser('enc.corp', 'Cora Keyholder'); db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId('Corporate admin'), cid);
  const corp = await loggedIn('enc.corp');
  const key = (html) => /<p class="code sec-key">([A-Za-z0-9_-]{43})<\/p>/.exec(html);
  const one = (await corp.get('/admin/security')).text, two = (await corp.get('/admin/security')).text;
  assert.match(one, /The database is encrypted<\/strong>/); assert.match(one, /Anyone who got hold of the database file or a backup could read everything in it/);
  assert.match(one, /add a variable named DB_KEY/); assert.match(one, /Without the key nobody can open the database or its backups again/);
  assert.ok(key(one) && key(two) && key(one)[1] !== key(two)[1]);                             // made fresh each time, stored nowhere
  assert.ok(key(one)[1].length >= dbfile.MIN_KEY);
  assert.match((await corp.get('/admin/backups')).text, /it is <strong>not encrypted<\/strong>/);
  assert.equal(db.encryption.encrypted, false);
});

test('sign-in history: sign-ins, wrong passwords and pauses are recorded for corporate admins only; exports are recorded; sign-out clears the device', async () => {
  const authRoutes = require('../app/routes/auth'); authRoutes.clearLoginFailures();
  const office = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Auditville', ?)").run(new Date().toISOString()).lastInsertRowid;
  access.ensureProfile('Corporate admin', 'all', access.ALL);
  access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all'));   // everything an office admin has, and one office only
  const mk = (username, name, profile) => { const id = makeUser(username, name); db.prepare('UPDATE users SET profile_id = ?, branch_id = ? WHERE id = ?').run(profileId(profile), office, id); return id; };
  const tid = mk('aud.tech', 'Tessa Trail', 'Technician'); mk('aud.admin', 'Adam Auditville', 'Office admin (one office)'); mk('aud.corp', 'Cora Auditville', 'Corporate admin');
  db.prepare('DELETE FROM activity_log').run();
  const mine = () => db.prepare('SELECT action, detail FROM activity_log WHERE user_id = ? ORDER BY id').all(tid);
  const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

  // A wrong password against a real account: recorded with where it came from, never with what was typed.
  const guess = new Client(PHONE);
  assert.equal((await guess.post('/login', { username: 'aud.tech', password: 'not-her-password-123' }, { page: '/login' })).status, 401);
  assert.deepEqual(mine().map((r) => r.action), ['Sign-in failed']);
  assert.match(mine()[0].detail, /^Wrong password, from [0-9a-f.:]+$/); assert.doesNotMatch(JSON.stringify(mine()), /not-her-password/);
  // A username that does not exist leaves no entry: what was typed there may well be a password.
  const before = db.prepare('SELECT COUNT(*) n FROM activity_log').get().n;
  await guess.post('/login', { username: 'correct horse battery', password: 'x' }, { page: '/login' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_log').get().n, before);
  // Signing in: who, how and on what kind of device.
  const tessa = new Client(PHONE); await tessa.login('aud.tech', 'correct horse battery');
  assert.equal(mine().pop().action, 'Signed in'); assert.match(mine().pop().detail, /^With a password, on a phone or tablet, from [0-9a-f.:]+$/);
  // Wrong passwords at the lock screen, and the pause after ten.
  await tessa.post('/lock', {}, { page: '/' });
  for (let i = 0; i < 10; i++) await tessa.post('/unlock', { password: 'wrong ' + i }, { page: '/unlock' });   // signing in wiped the earlier miss: ten more reach the limit
  assert.equal(mine().filter((r) => r.action === 'Wrong password at the lock screen').length, 10);
  assert.deepEqual(mine().pop(), { action: 'Sign-in paused', detail: '10 wrong passwords in 15 minutes, so the password is refused for the next 15' });
  await tessa.post('/unlock', { password: 'wrong again' }, { page: '/unlock' });                   // refused outright while paused: nothing more is written
  assert.equal(mine().filter((r) => r.action === 'Sign-in paused').length, 1); assert.equal(mine().filter((r) => /Wrong password|failed/.test(r.action)).length, 11);
  authRoutes.clearLoginFailures();
  await tessa.post('/unlock', { password: 'correct horse battery' }, { page: '/unlock' });
  assert.equal(mine().filter((r) => r.action === 'Signed in').length, 1);                           // unlocking is not a sign-in
  // Changing the password and the reset address are recorded, without either value.
  await tessa.post('/account/email', { email: 'tessa@example.com', current: 'correct horse battery' });
  await tessa.post('/account/password', { current: 'correct horse battery', password: 'meadow lantern copper 9', confirm: 'meadow lantern copper 9' });
  assert.deepEqual(mine().slice(-2).map((r) => r.action), ['Email address changed', 'Password changed']);
  assert.doesNotMatch(JSON.stringify(mine()), /meadow lantern|correct horse|tessa@example/);

  // Who can read it. The office admin sees the office's log without any sign-in entries; a corporate admin can ask for them.
  const admin = await loggedIn('aud.admin'); const corp = await loggedIn('aud.corp');
  await corp.post('/branch/view', { branch: String(office), back: '/' }, { page: '/' });
  const officeView = (await admin.get('/admin/activity')).text;
  assert.doesNotMatch(officeView, /Password changed|Email address changed/);                        // nor when someone changed a password or reset address
  assert.doesNotMatch(officeView, /Signed in|Sign-in failed|Sign-in paused|Wrong password at the lock screen|show=signins/);
  assert.doesNotMatch((await admin.get('/admin/activity?show=signins')).text, /Signed in|Sign-in failed|Sign-in paused/);
  assert.doesNotMatch((await admin.get('/admin/activity?q=Tessa')).text, /Signed in|Sign-in failed|Sign-in paused|Wrong password at the lock screen/);
  const corpView = (await corp.get('/admin/activity')).text;
  assert.match(corpView, /show=signins/); assert.match(corpView, /Sign-in paused/); assert.doesNotMatch(corpView, /<td class="nowrap">Signed in<\/td>/);
  const signIns = (await corp.get('/admin/activity?show=signins')).text;
  assert.match(signIns, /Tessa Trail<\/td><td class="nowrap">Signed in<\/td><td>With a password, on a phone or tablet/); assert.match(signIns, /Sign-in failed/);
  assert.doesNotMatch(signIns, /Password changed/);

  // Spreadsheets: every export is written down with who took it and how much.
  await admin.get('/admin/certs.csv');
  const exported = db.prepare("SELECT a.detail, u.username FROM activity_log a JOIN users u ON u.id = a.user_id WHERE a.action = 'Spreadsheet exported' ORDER BY a.id DESC").get();
  assert.equal(exported.username, 'aud.admin'); assert.match(exported.detail, /^certifications-\d{4}-\d{2}-\d{2}\.csv, \d+ rows?$/);
  // The customer list takes the password typed in the last few minutes, like a backup.
  const sid = (c) => decodeURIComponent(/portal\.sid=([^;]+)/.exec(c.cookie)[1]).slice(2).split('.')[0];
  const longAgo = (c) => db.prepare("UPDATE sessions SET data = json_set(data, '$.pwAt', 1) WHERE sid = ?").run(sid(c));
  assert.equal((await admin.get('/sales.csv')).status, 200);                                        // signed in a moment ago
  longAgo(admin);
  assert.equal((await admin.get('/sales.csv')).location, '/sales/export');
  const ask = (await admin.get('/sales/export')).text;
  assert.match(ask, /Type your password to export/); assert.doesNotMatch(ask, /href="\/sales\.csv"/);
  await admin.post('/account/confirm', { password: 'wrong password here', next: '/sales/export' }, { page: '/sales/export' });
  assert.equal((await admin.get('/sales.csv')).location, '/sales/export');
  assert.equal(db.prepare('SELECT action FROM activity_log WHERE user_id = ? ORDER BY id DESC').get(userId('aud.admin')).action, 'Wrong password when asked to confirm');
  assert.doesNotMatch((await admin.get('/admin/activity')).text, /Wrong password when asked to confirm/);     // and that, too, is for corporate eyes only
  assert.equal((await admin.post('/account/confirm', { password: 'correct horse battery', next: '/sales/export' }, { page: '/sales/export' })).location, '/sales/export');
  assert.match((await admin.get('/sales/export')).text, /href="\/sales\.csv"/);
  const csv = await admin.get('/sales.csv');
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /sales-leads-/);
  assert.match(db.prepare("SELECT detail FROM activity_log WHERE action = 'Spreadsheet exported' ORDER BY id DESC").get().detail, /^sales-leads-/);
  assert.equal((await tessa.get('/sales/export')).status, 403);

  // Signing out: the browser is told to drop the photos and files it kept from the site, and the page clears saved drafts.
  const out = await tessa.post('/logout', {}, { page: '/' });
  assert.equal(out.location, '/login'); assert.equal(out.headers.get('clear-site-data'), '"cache"');
  const js = (await new Client().get('/site.js')).text;
  assert.match(js, /getAttribute\('action'\) !== '\/logout'/); assert.match(js, /clearPrefix\('draft:'\)/);
  // A page left open goes to the lock screen once the site has locked (checked in a browser too): the pieces are in place.
  assert.match(js, /if \(path === '\/unlock'\) \{ leave\('\/unlock'\); return null; \}/); assert.match(js, /setTimeout\(pulse, after \+ 1500\)/);
  await corp.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
});

test('uploaded photos and documents are encrypted where they are stored, and opened only as they are sent', async () => {
  const sealed = require('../app/sealed'); const uploads = require('../app/uploads'); const crypto = require('crypto');
  const k1 = sealed.keyFrom('first-key-0123456789-abcdefghij'), k2 = sealed.keyFrom('second-key-0123456789-abcdefghij');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-seal-'));
  const head = (f) => fs.readFileSync(f).subarray(0, 7).toString('latin1');

  // One file: sealed, opened again, and every kind of meddling noticed.
  const f = path.join(dir, 'a1b2c3.jpg'); const original = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(' a photo of a customer site: 12 Main Street '), crypto.randomBytes(5000)]);
  fs.writeFileSync(f, original);
  assert.equal(sealed.isSealed(f), false); assert.equal(sealed.keyIdOf(f), null); assert.ok(sealed.read(f, []).equals(original));
  assert.equal(sealed.seal(f, k1), true); assert.equal(sealed.seal(f, k1), false);                  // sealing twice does nothing
  assert.equal(head(f), 'PBSEAL1'); assert.ok(sealed.isSealed(f)); assert.ok(sealed.keyIdOf(f).equals(k1.id));
  assert.equal(fs.statSync(f).size, original.length + 40); assert.doesNotMatch(fs.readFileSync(f).toString('latin1'), /customer site|Main Street/);
  assert.ok(sealed.read(f, [k1]).equals(original)); assert.ok(sealed.read(f, [k2, k1]).equals(original));
  assert.throws(() => sealed.read(f, [k2]), /key that is not in the settings/); assert.throws(() => sealed.read(f, []), /not in the settings/);
  const twin = path.join(dir, 'twin.jpg'); fs.writeFileSync(twin, original); sealed.seal(twin, k1);
  assert.notDeepEqual(fs.readFileSync(twin), fs.readFileSync(f));                                 // the same photo never seals to the same bytes
  const swapped = path.join(dir, 'other-name.jpg'); fs.copyFileSync(f, swapped);
  assert.throws(() => sealed.read(swapped, [k1]));                                                // one sealed file cannot stand in for another
  const bent = Buffer.from(fs.readFileSync(f)); bent[bent.length - 300] ^= 1; const bentFile = path.join(dir, 'bent', 'a1b2c3.jpg'); fs.mkdirSync(path.dirname(bentFile)); fs.writeFileSync(bentFile, bent);
  assert.throws(() => sealed.read(bentFile, [k1]));                                               // one changed bit and it will not open
  sealed.reseal(f, [k1], k2); assert.ok(sealed.keyIdOf(f).equals(k2.id)); assert.ok(sealed.read(f, [k2]).equals(original)); assert.throws(() => sealed.read(f, [k1]));
  sealed.unseal(f, [k2]); assert.ok(fs.readFileSync(f).equals(original));
  assert.ok(sealed.keyFrom('first-key-0123456789-abcdefghij').key.equals(k1.key)); assert.equal(k1.key.length, 32); assert.ok(!k1.key.equals(k2.key));
  assert.doesNotMatch(fs.readdirSync(dir).join(' '), /\.sealing/);

  // On the site: a photo is stored as it arrives, sealed a little later, and looks no different to the people allowed to see it.
  makeUser('seal.one', 'Sela Sealed'); const c = await loggedIn('seal.one'); const uid = userId('seal.one');
  const raw = async (cl, url) => { const r = await fetch(base + url, { headers: { cookie: cl.cookie }, redirect: 'manual' }); return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()) }; };
  await c.post('/profile', [['about', 'Sealed'], ['photo', new File([PNG], 'me.png', { type: 'image/png' })]], { multipart: true, page: '/profile' });
  const stored = path.join(uploads.uploadDir, db.prepare('SELECT photo_path p FROM users WHERE id = ?').get(uid).p);
  assert.ok(fs.readFileSync(stored).equals(PNG));
  let seen = await raw(c, `/people/photo/${uid}`);
  assert.deepEqual([seen.status, seen.type, seen.cache], [200, 'image/png', 'private, max-age=86400']); assert.ok(seen.body.equals(PNG));
  try {
    uploads.useKeys({ current: k1, all: [k1], off: false });
    assert.equal(uploads.tend().sealed, 0); assert.ok(fs.readFileSync(stored).equals(PNG));       // just uploaded: left alone for its first two minutes
    const pass = uploads.tend({ minAgeMs: 0, limit: 10000 });
    assert.ok(pass.sealed >= 1); assert.equal(pass.stuck, 0); assert.equal(head(stored), 'PBSEAL1');
    assert.equal(uploads.census().plain, 0); assert.equal(uploads.census().sealed, uploads.census().files);
    assert.deepEqual(uploads.tend({ minAgeMs: 0 }), { sealed: 0, moved: 0, opened: 0, left: 0, stuck: 0 });   // nothing left to do
    seen = await raw(c, `/people/photo/${uid}`);
    assert.deepEqual([seen.status, seen.type, seen.cache], [200, 'image/png', 'private, max-age=86400']); assert.ok(seen.body.equals(PNG));
    assert.equal((await raw(new Client(), `/people/photo/${uid}`)).status, 302);                    // still only for people who are signed in
    // The key was changed: files open with either while they are moved across, a few at a time.
    uploads.useKeys({ current: k2, all: [k2, k1], off: false });
    assert.ok((await raw(c, `/people/photo/${uid}`)).body.equals(PNG));
    assert.equal(uploads.census().earlier, uploads.census().files);
    const some = uploads.tend({ limit: 1 }); assert.equal(some.moved, 1); assert.ok(some.left >= 0);
    const rest = uploads.tend({ limit: 10000 }); assert.equal(rest.left, 0); assert.equal(uploads.census().earlier, 0);
    assert.ok(sealed.keyIdOf(stored).equals(k2.id)); assert.ok((await raw(c, `/people/photo/${uid}`)).body.equals(PNG));
    // The old key taken away too soon, or a file from somewhere else: not opened, reported, and nothing is overwritten.
    uploads.useKeys({ current: k1, all: [k1], off: false });
    assert.equal((await raw(c, `/people/photo/${uid}`)).status, 404);
    assert.equal(uploads.census().unknown, uploads.census().files); assert.equal(uploads.tend({ minAgeMs: 0 }).stuck, uploads.census().files);
    assert.ok(sealed.keyIdOf(stored).equals(k2.id));
    // Meddled with on the disk: refused rather than shown.
    uploads.useKeys({ current: k2, all: [k2], off: false });
    const good = fs.readFileSync(stored); const bad = Buffer.from(good); bad[bad.length - 20] ^= 4; fs.writeFileSync(stored, bad);
    assert.equal((await raw(c, `/people/photo/${uid}`)).status, 404);
    fs.writeFileSync(stored, good); assert.ok((await raw(c, `/people/photo/${uid}`)).body.equals(PNG));
  } finally {
    // Encryption switched off again: everything goes back to ordinary files (and the other tests get the folder as they expect it).
    uploads.useKeys({ current: null, all: [k2, k1], off: true });
    const back = uploads.tend({ limit: 100000 });
    assert.ok(back.opened >= 1); assert.equal(back.stuck, 0); assert.ok(fs.readFileSync(stored).equals(PNG)); assert.equal(uploads.census().sealed + uploads.census().earlier, 0);
    uploads.useKeys(null);
  }
  assert.equal(uploads.keys().current, null);                                                      // this test site has no key: nothing is sealed
  assert.ok((await raw(c, `/people/photo/${uid}`)).body.equals(PNG));

  // With the real settings: the files follow the database key, through a change of key and back out again, and the photo archive can be opened elsewhere.
  const L = encryptionLab(); const KEY = 'files-key-0123456789-abcdefghij', KEY2 = 'files-key-two-0123456789-abcdef';
  const up = path.join(L.dir, 'uploads'); fs.mkdirSync(up, { recursive: true });
  const docs = { 'p1.jpg': original, 'nl-1.pdf': Buffer.from('%PDF-1.7 a newsletter with a customer name in it'), 'lib.docx': crypto.randomBytes(3000) };
  for (const [n, b] of Object.entries(docs)) fs.writeFileSync(path.join(up, n), b);
  const TEND = `const u = require('./app/uploads'); const first = u.tend({ minAgeMs: 0, limit: 1000 }); console.log(JSON.stringify({ first, census: u.census(), on: Boolean(u.keys().current) }));`;
  const tend = (settings) => JSON.parse(L.run(TEND, settings).out.trim().split('\n').pop());
  assert.ok(L.run(L.SEED).ok);
  let r = tend({});                                                                                // no key: nothing is touched
  assert.deepEqual([r.on, r.first.sealed, r.census.plain], [false, 0, 3]);
  r = tend({ DB_KEY: KEY });
  assert.deepEqual([r.on, r.first.sealed, r.census.sealed, r.census.plain], [true, 3, 3, 0]);
  for (const n of Object.keys(docs)) { assert.equal(head(path.join(up, n)), 'PBSEAL1'); assert.doesNotMatch(fs.readFileSync(path.join(up, n)).toString('latin1'), /customer|%PDF/); assert.ok(sealed.read(path.join(up, n), [sealed.keyFrom(KEY)]).equals(docs[n])); }
  r = tend({ DB_KEY: KEY2, DB_KEY_OLD: KEY });
  assert.deepEqual([r.first.moved, r.census.sealed, r.census.earlier], [3, 3, 0]);
  for (const n of Object.keys(docs)) assert.ok(sealed.read(path.join(up, n), [sealed.keyFrom(KEY2)]).equals(docs[n]));
  L.state({ DB_KEY: KEY2, DB_KEY_OLD: KEY });                                                      // a full start also brings the backups into line
  // The Security check counts them, and holds off saying DB_KEY_OLD can go until every file has moved.
  const CHECK = `require('./app/app'); const item = require('./app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }).find((c) => c.title === 'The database is encrypted'); console.log(JSON.stringify(item)); process.exit(0);`;
  let item = JSON.parse(L.run(CHECK, { DB_KEY: KEY2 }).out.trim().split('\n').pop());
  assert.equal(item.ok, true); assert.match(item.detail, /3 of 3 photos and documents are encrypted\./);
  sealed.reseal(path.join(up, 'p1.jpg'), [sealed.keyFrom(KEY2)], sealed.keyFrom(KEY));             // one file still under the earlier key
  item = JSON.parse(L.run(CHECK, { DB_KEY: KEY2, DB_KEY_OLD: KEY }).out.trim().split('\n').pop());
  assert.equal(item.ok, false); assert.match(item.detail, /1 file is still being moved to the new key/); assert.match(item.fix, /Leave DB_KEY_OLD where it is/);
  item = JSON.parse(L.run(CHECK, { DB_KEY: KEY2 }).out.trim().split('\n').pop());                  // ...and DB_KEY_OLD was removed too soon
  assert.equal(item.ok, false); assert.match(item.detail, /1 photo or document is locked with a key that is not in the settings/); assert.match(item.fix, /previous one has to be in DB_KEY_OLD/);
  assert.equal(tend({ DB_KEY: KEY2, DB_KEY_OLD: KEY }).first.moved, 1);                             // put back: it moves across, nothing lost
  // Opening the archive somewhere else.
  const { execFileSync } = require('child_process'); const out = path.join(L.dir, 'opened');
  const tool = (key, ...args) => { try { return { ok: true, out: execFileSync(process.execPath, ['scripts/decrypt-photos.js', ...args], { cwd: L.root, env: { PATH: process.env.PATH, DB_KEY: key }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, err: String(e.stderr) + String(e.stdout) }; } };
  assert.match(tool('', up, out).err, /Set DB_KEY/);
  assert.match(tool(KEY, up, out + '-wrong').err, /3 could not be opened/);
  assert.match(tool(KEY2, up, out).out, /^3 opened, 0 were not encrypted/);
  for (const n of Object.keys(docs)) { assert.ok(fs.readFileSync(path.join(out, n)).equals(docs[n])); assert.equal(head(path.join(up, n)), 'PBSEAL1'); }
  // Encryption switched off: the files become ordinary again.
  r = tend({ DB_KEY: KEY2, DB_DECRYPT: 'yes' });
  assert.deepEqual([r.on, r.first.opened, r.census.plain, r.census.sealed], [false, 3, 3, 0]);
  for (const n of Object.keys(docs)) assert.ok(fs.readFileSync(path.join(up, n)).equals(docs[n]));
});

test('browser rules: styles, fonts and connections from this site only, no framing; outgoing mail insists on an encrypted connection', async () => {
  const r = await new Client().get('/login');
  const csp = r.headers.get('content-security-policy');
  for (const part of ["default-src 'self'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self'", "font-src 'self'", "connect-src 'self'", "img-src 'self' data: blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(csp.split(';').map((s) => s.trim()).includes(part), `${part} missing from: ${csp}`);
  }
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  // Nothing in the pages styles itself in place, which that policy would block.
  const views = path.join(__dirname, '..', 'app', 'views');
  const walk = (d) => fs.readdirSync(d).flatMap((f) => (fs.statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
  for (const f of walk(views)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\sstyle="|<style[\s>]/, `${path.basename(f)} has an inline style`);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public')).filter((n) => n.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'), /setAttribute\('style'|cssText|style="/, `${f} sets an inline style`);

  // Mail: on the usual port the connection must be upgraded to an encrypted one before anything is sent.
  const { execFileSync } = require('child_process');
  const SPY = `const nm = require('nodemailer'); const real = nm.createTransport; nm.createTransport = (o) => { console.log(JSON.stringify({ secure: o.secure, requireTLS: o.requireTLS, port: o.port })); return real(o); }; require('./app/mail');`;
  const made = (port) => JSON.parse(execFileSync(process.execPath, ['-e', SPY], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'portal-mail-')), SMTP_HOST: 'mail.example.com', SMTP_PORT: String(port) }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(made(587), { secure: false, requireTLS: true, port: 587 });
  assert.deepEqual(made(465), { secure: true, requireTLS: false, port: 465 });
});

test('on call: a phone shows the next four weeks and keeps the rest of the year behind a button', async () => {
  const office = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Callville', ?)").run(new Date().toISOString()).lastInsertRowid;
  const id = makeUser('call.one', 'Cal Callville'); db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(office, id);
  const day = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };
  const add = db.prepare("INSERT INTO oncall_shifts (branch_id, start_on, end_on, role, name, phone, created_at) VALUES (?, ?, ?, 'tech', ?, '717-555-0100', ?)");
  for (let w = 0; w < 20; w++) add.run(office, day(w * 7 - 1), day(w * 7 + 6), `Tech Week${w}`, new Date().toISOString());
  const c = await loggedIn('call.one');
  const page = (await c.get('/oncall')).text;
  const rows = [...page.matchAll(/<tr( class="later")?>\s*<td class="nowrap" data-label="Days">/g)];
  assert.equal(rows.length, 19);                                                       // 19 weeks to come after this one
  const shown = rows.filter((r) => !r[1]).length, later = rows.filter((r) => r[1]).length;
  assert.ok(shown >= 4 && shown <= 5, `shown ${shown}`); assert.equal(shown + later, 19);
  assert.match(page, new RegExp(`data-oncall-all>Show the rest \\(${later} more\\)</button>`));
  assert.ok(page.indexOf('Tech Week1<') < page.indexOf('class="later"'));              // the nearest weeks are never hidden
  // A short schedule has nothing to hide and no button.
  db.prepare('DELETE FROM oncall_shifts WHERE branch_id = ? AND start_on > ?').run(office, day(20));
  const short = (await c.get('/oncall')).text;
  assert.doesNotMatch(short, /data-oncall-all|class="later"/);
  const css = (await new Client().get('/styles.css')).text;
  assert.match(css, /\.oncall-table:not\(\.all\) tr\.later \{ display: none; \}/);
  assert.match((await c.get('/site.js')).text, /data-oncall-all/);
});

test('the Feed page: the activity feed in full, with shout-outs and past events, and the home panel links to it', async () => {
  const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2');
  const home = (await t1.get('/')).text;
  assert.match(home, /<h2 id="around-h">Activity feed<\/h2><a href="\/feed">Feed<\/a>/);
  assert.doesNotMatch(/<section class="panel p-around"[\s\S]*?<\/section>/.exec(home)[0], /href="\/people">People</);
  assert.equal((await new Client().get('/feed')).location, '/login?next=%2Ffeed');
  // It is in the Community menu too, marked as the current page when you are on it.
  const menu = (html) => /<summary[^>]*>Community[\s\S]*?<\/details>/.exec(html)[0];
  assert.match(menu(home), /<a href="\/feed"[^>]*>Activity feed<\/a>[\s\S]*<a href="\/people"/);
  assert.match(menu((await t1.get('/feed')).text), /<a href="\/feed" aria-current="page"[^>]*>Activity feed/);
  // More than the home page's eight, and things the home list leaves out.
  const sec = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  for (let i = 0; i < 11; i++) db.prepare('INSERT INTO forum_threads (section_id, user_id, title, created_at, last_post_at, last_post_user_id) VALUES (?, ?, ?, ?, ?, ?)').run(sec, userId('tech2'), `FEEDPAGE thread ${i}`, new Date(Date.now() - i * 60000).toISOString(), new Date().toISOString(), userId('tech2'));
  await t2.post('/shoutouts', { to_user: String(userId('tech1')), message: 'FEEDPAGE covered my Saturday call' }, { page: '/shoutouts' });
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO events (title, event_date, created_by, created_at) VALUES (?, ?, ?, ?)').run('FEEDPAGE cookout that already happened', past, userId('tech2'), new Date(Date.now() - 5 * 86400000).toISOString());
  const feed = (await t1.get('/feed')).text.replace(/\s+/g, ' ');
  assert.match(feed, /<h1>Activity feed<\/h1>/);
  assert.equal((feed.match(/FEEDPAGE thread \d+<\/strong>/g) || []).length, 11);
  assert.match(feed, /<li class="feed-shout"[^>]*>[\s\S]*?<strong>FEEDPAGE covered my Saturday call<\/strong>[\s\S]*?gave [^<]* a shout-out<\/p>/);
  assert.match(feed, /FEEDPAGE cookout that already happened, /);
  assert.ok((feed.match(/<li class="feed-/g) || []).length > 8);
  const onHome = /<section class="panel p-around"[\s\S]*?<\/section>/.exec((await t1.get('/')).text)[0];
  assert.ok((onHome.match(/<li class="feed-/g) || []).length <= 8); assert.doesNotMatch(onHome, /FEEDPAGE covered|already happened/);   // the home page keeps its short list
  // One kind at a time.
  assert.match(feed, /<a href="\/feed" aria-current="true">Everything<\/a>/); assert.match(feed, /<a href="\/feed\?show=shout" >Shout-outs \(\d+\)<\/a>/);
  const shouts = (await t1.get('/feed?show=shout')).text;
  assert.match(shouts, /FEEDPAGE covered my Saturday call/); assert.doesNotMatch(shouts, /FEEDPAGE thread/);
  assert.match((await t1.get('/feed?show=nonsense')).text, /FEEDPAGE thread 0/);
  // Never more than a hundred on the page.
  const add = db.prepare('INSERT INTO forum_threads (section_id, user_id, title, created_at, last_post_at, last_post_user_id) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 130; i++) add.run(sec, userId('tech2'), `FEEDFLOOD ${i}`, new Date(Date.now() - 86400000 - i * 1000).toISOString(), new Date().toISOString(), userId('tech2'));
  assert.equal(((await t1.get('/feed')).text.match(/<li class="feed-/g) || []).length, 100);
  db.prepare("DELETE FROM forum_threads WHERE title LIKE 'FEEDFLOOD %' OR title LIKE 'FEEDPAGE %'").run();
});

// ===== Fixes from the November 2026 review. Each area keeps its checks under its own heading. =====
// -- review: accounts and access --
const accessChecks = {
  /** A profile with everything an office admin has, for one office only (in these checks the profile called Admin sees every office). */
  oneOffice: () => access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all')),
  office: (name) => db.prepare('INSERT INTO branches (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString()).lastInsertRowid,
  person: (username, name, profile, office) => {
    const id = makeUser(username, name);
    db.prepare('UPDATE users SET profile_id = ?, branch_id = ? WHERE id = ?').run(typeof profile === 'string' ? profileId(profile) : profile, office, id);
    return id;
  },
};

test('contact list: an upload changes only accounts the uploader could edit by hand, never the master account, and does not undo a hidden phone or email', async () => {
  const R = accessChecks;
  R.person('imp.admin', 'Irma Importer', R.oneOffice(), 1);                    // an office admin in the master account's office
  const corp = R.person('imp.corp', 'Carl Corporate', 'Corporate admin', 1);
  const shy = R.person('imp.shy', 'Shay Private', 'Technician', 1);
  db.prepare("UPDATE users SET email = 'carl@example.com' WHERE id = ?").run(corp);
  db.prepare("UPDATE users SET email = 'shay@example.com', phone = '717-555-0111' WHERE id = ?").run(shy);
  await loggedIn('imp.shy');                                                   // Shay uses the site, and has left "show my phone" and "show my email" unticked
  const reset = R.person('imp.reset', 'Rae Resetpw', 'Technician', 1);
  await loggedIn('imp.reset');                                                 // so does Rae, whose password an admin has since reset
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(reset);
  const fresh = auth.createUser({ username: 'imp.new', displayName: 'Nina Notyet', password: 'temp-pass-1234' });   // has an account, has never signed in
  const master = db.prepare('SELECT id, display_name FROM users WHERE is_master = 1').get();
  const row = (id) => ({ ...db.prepare('SELECT email, phone, job_title, started_on, show_phone, show_email, in_directory FROM users WHERE id = ?').get(id) });
  const was = row(master.id);
  db.prepare("UPDATE users SET email = 'max@example.com' WHERE id = ?").run(master.id);
  const before = { master: row(master.id), corp: row(corp) };
  const admin = await loggedIn('imp.admin');
  // The Edit person page refuses this admin on both accounts. The upload must not be a way round that.
  for (const id of [master.id, corp]) assert.equal((await admin.get(`/admin/users/${id}/edit`)).status, 403);
  const csv = ['Name,Title,Email,Phone', `${master.display_name},Janitor,attacker@evil.example,717-555-0000`, 'Carl Corporate,Janitor,attacker2@evil.example,717-555-0001',
    'Shay Private,Service Tech,shay.new@example.com,717-555-0112', 'Rae Resetpw,Service Tech,,717-555-0115', 'Nina Notyet,Apprentice,nina@example.com,717-555-0113', 'Brand Newperson,Helper,brand@example.com,717-555-0114'].join('\n');
  const send = (client, text) => client.post('/admin/people/import', [['file', new File([text], 'list.csv', { type: 'text/csv' })]], { multipart: true, page: '/admin/import' });
  db.prepare("DELETE FROM activity_log WHERE action LIKE 'Contact list%'").run();
  assert.equal((await send(admin, csv)).location, '/admin/import#contacts');
  assert.deepEqual(row(master.id), before.master);
  assert.deepEqual(row(corp), before.corp);
  // The uploader is told who was left alone.
  const page = (await admin.get('/admin/import')).text;
  assert.match(page, /<strong>3<\/strong> existing accounts filled in and <strong>1<\/strong> person added/);
  assert.match(page, new RegExp(`<strong>Not changed, because you cannot edit these accounts:</strong> ${master.display_name}, Carl Corporate<`));
  // Someone the admin may edit: the list's email and phone replace what was there, but what the person keeps hidden stays hidden.
  assert.deepEqual(row(shy), { email: 'shay.new@example.com', phone: '717-555-0112', job_title: 'Service Tech', started_on: null, show_phone: 0, show_email: 0, in_directory: 1 });
  assert.deepEqual([row(reset).phone, row(reset).show_phone], ['717-555-0115', 0]);
  // Someone who has never signed in, and someone the upload adds, are shown as before.
  assert.deepEqual([row(fresh).email, row(fresh).show_phone, row(fresh).show_email], ['nina@example.com', 1, 1]);
  const brand = db.prepare("SELECT id, show_phone, show_email, active FROM users WHERE display_name = 'Brand Newperson'").get();
  assert.deepEqual([brand.show_phone, brand.show_email, brand.active], [1, 1, 0]);
  // The log names whose email or phone changed.
  const log = db.prepare("SELECT action, detail FROM activity_log WHERE action LIKE 'Contact list%' ORDER BY id").all().map((r) => `${r.action}: ${r.detail}`);
  assert.deepEqual(log, ['Contact list imported: 3 existing accounts updated, 1 person added, 2 left alone',
    'Contact list: email or phone changed: Shay Private (email and phone), Rae Resetpw (phone), Nina Notyet (email and phone)']);
  // Uploading the same list again changes nothing, so there are no names to log.
  await send(admin, csv);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'Contact list: email or phone changed'").get().n, 1);
  // A corporate admin is refused the master account in the same way. The master account's own upload does change it.
  await send(await loggedIn('imp.corp'), `Name,Email\n${master.display_name},attacker3@evil.example`);
  assert.deepEqual(row(master.id), before.master);
  await send(await loggedIn('master'), `Name,Phone\n${master.display_name},717-555-0999`);
  assert.equal(row(master.id).phone, '717-555-0999');
  // The same rule for announcing someone as a new hire, which sets a job title and start date: only for people the admin may edit.
  assert.equal((await admin.post(`/admin/users/${master.id}/welcome`, { job_title: 'Janitor', started_on: '2020-01-01' }, { page: '/admin/users' })).status, 403);
  assert.deepEqual([row(master.id).job_title, row(master.id).started_on], [before.master.job_title, before.master.started_on]);
  assert.equal((await admin.post(`/admin/users/${shy}/welcome`, { started_on: '2026-11-02' }, { page: '/admin/users' })).status, 302);
  assert.equal(row(shy).started_on, '2026-11-02');
  db.prepare('UPDATE users SET email = ?, phone = ?, in_directory = ? WHERE id = ?').run(was.email, was.phone, was.in_directory, master.id);
  db.prepare('DELETE FROM welcomes WHERE user_id = ?').run(shy);
  require('../app/removal').remove(brand.id);
});

test('training sessions: a request from another office or team cannot be scheduled, shown or marked done, and a private request does not become a session title the office sees', async () => {
  const R = accessChecks;
  const here = R.office('Trainford'); const there = R.office('Elsewhere Falls');
  const tech = R.person('trn.tech', 'Tara Trainford', 'Technician', here);
  R.person('trn.admin', 'Adam Trainford', R.oneOffice(), here); R.person('trn.mgr', 'Mona Noteam', 'Manager', here);   // a manager with nobody assigned
  R.person('trn.far', 'Fern Elsewhere', R.oneOffice(), there);
  const tc = await loggedIn('trn.tech');
  await tc.post('/training', { description: 'TRNPRIV zone expanders\nMore about it', wants_contact: 'no', is_private: 'yes' });
  const priv = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  await tc.post('/training', { description: 'TRNOPEN panel programming', wants_contact: 'no', is_private: 'no' });
  const open = db.prepare('SELECT MAX(id) id FROM training_requests').get().id;
  const list = '/admin/training/sessions';
  const far = await loggedIn('trn.far'); const mgr = await loggedIn('trn.mgr'); const admin = await loggedIn('trn.admin');
  const state = () => ({ ...db.prepare('SELECT status, unseen FROM training_requests WHERE id = ?').get(priv) });

  // Another office's admin, and a manager who does not manage the requester, are refused the request itself.
  // Naming it on a new session used to show its wording and move it along; now that is refused too.
  for (const c of [far, mgr]) {
    assert.equal((await c.get(`/admin/training/${priv}`)).status, 403);
    assert.doesNotMatch((await c.get(`${list}?request=${priv}`)).text, /TRNPRIV|name="request_id"|Trainford office/);
    assert.equal((await c.post(list, { title: 'anything', session_date: '2031-08-01', request_id: String(priv) }, { page: list })).status, 403);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_sessions WHERE request_id = ?').get(priv).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_attendance WHERE user_id = ?').get(tech).n, 0);
  assert.deepEqual(state(), { status: 'new', unseen: 0 });
  // A session tied to it before this was checked (made by hand here): the wording is not shown, and holding the session leaves the request alone.
  const stray = db.prepare('INSERT INTO training_sessions (title, request_id, session_date, created_by, created_at, branch_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('Stray session', priv, '2031-08-02', userId('trn.far'), new Date().toISOString(), there).lastInsertRowid;
  assert.doesNotMatch((await far.get(`${list}/${stray}`)).text, /TRNPRIV|For training request/);
  await far.post(`${list}/${stray}`, { held: '1' }, { page: `${list}/${stray}` });
  assert.ok(db.prepare('SELECT completed_at FROM training_sessions WHERE id = ?').get(stray).completed_at);
  assert.deepEqual(state(), { status: 'new', unseen: 0 });
  db.prepare('DELETE FROM training_sessions WHERE id = ?').run(stray);
  // Someone who sees every office schedules from a request while looking at that request's office, not from "All offices".
  const owner = await loggedIn('owner');
  await owner.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
  const afar = (await owner.get(`${list}?request=${open}`)).text;
  assert.match(afar, /That request is from the Trainford office\. Choose that office first/); assert.doesNotMatch(afar, /name="request_id"|value="TRNOPEN/);
  assert.equal((await owner.post(list, { title: 'From afar', session_date: '2031-08-05', request_id: String(open) }, { page: list })).status, 403);
  assert.deepEqual({ ...db.prepare('SELECT status FROM training_requests WHERE id = ?').get(open) }, { status: 'new' });

  // The office's own admin schedules from either request as before. A private request does not offer its wording as the title...
  const form = (await admin.get(`${list}?request=${priv}`)).text;
  assert.match(form, new RegExp(`name="request_id" value="${priv}"`)); assert.doesNotMatch(form, /value="TRNPRIV/);
  assert.match((await admin.get(`${list}?request=${open}`)).text, /value="TRNOPEN panel programming"/);
  // ...and whatever the session is called, one made from a private request is not listed to the office under Coming up.
  // The person who asked is expected at it, so she still sees when it is.
  await admin.post(list, { title: 'TRNPRIV zone expanders', session_date: '2031-08-03', request_id: String(priv) }, { page: list });
  const sPriv = db.prepare('SELECT MAX(id) id FROM training_sessions').get().id;
  await admin.post(list, { title: 'TRNOPEN panel programming', session_date: '2031-08-04', request_id: String(open) }, { page: list });
  assert.deepEqual(state(), { status: 'scheduled', unseen: 1 });
  R.person('trn.mate', 'Matt Trainford', 'Technician', here);
  const topics = (await (await loggedIn('trn.mate')).get('/training/topics')).text;
  assert.match(topics, /<h2>Coming up<\/h2>[\s\S]*?TRNOPEN panel programming[\s\S]*?<h2>Requested<\/h2>/); assert.doesNotMatch(topics, /TRNPRIV/);
  assert.match((await tc.get('/training/topics')).text, /<h2>Coming up<\/h2>[\s\S]*?TRNPRIV zone expanders[\s\S]*?TRNOPEN panel programming[\s\S]*?<h2>Requested<\/h2>/);
  // Their own admin sees which request a session is for, and marking it held finishes the request.
  assert.match((await admin.get(`${list}/${sPriv}`)).text, new RegExp(`For training request: <a href="/admin/training/${priv}">TRNPRIV zone expanders`));
  assert.doesNotMatch((await mgr.get(`${list}/${sPriv}`)).text, /For training request/);          // the office's session, but not her request to read
  await admin.post(`${list}/${sPriv}`, [['people', String(tech)], ['held', '1']], { page: `${list}/${sPriv}` });
  assert.equal(state().status, 'completed');
  db.prepare('DELETE FROM training_sessions WHERE branch_id = ?').run(here);
});

test('sales: the "already on this customer" check answers a part of a name only inside the office, says only who to ask about another office\'s customer, and pauses after 60 lookups', async () => {
  const R = accessChecks;
  const here = R.office('Lookupville'); const there = R.office('Farfield');
  R.person('lk.sam', 'Sam Lookup', 'Sales', here); R.person('lk.busy', 'Bo Busy', 'Sales', here); R.person('lk.harry', 'Harry Farfield', 'Sales', there);
  const sam = await loggedIn('lk.sam'); const far = await loggedIn('lk.harry');
  await far.post('/sales', { company: 'Susquehanna Cold Storage LLC', phone: '(717) 555-0199', email: 'ed@susqcold.example', address: '400 River Road, Columbia' }, { page: '/sales' });
  const lead = db.prepare("SELECT id FROM leads WHERE company = 'Susquehanna Cold Storage LLC'").get().id;
  await sam.post('/sales', { company: 'Lititz Storage Barn' }, { page: '/sales' });
  const own = db.prepare("SELECT id FROM leads WHERE company = 'Lititz Storage Barn'").get().id;
  const ask = async (client, q) => JSON.parse((await client.get('/sales/check?' + new URLSearchParams(q))).text).matches;

  // Part of a name finds the customer in the asker's own office, with a link to it, and nothing anywhere else.
  assert.deepEqual(await ask(sam, { company: 'Stora' }), [{ company: 'Lititz Storage Barn', owner: 'Sam Lookup', office: 'Lookupville', stage: 'New', why: 'same name', url: `/sales/${own}` }]);
  for (const q of [{ company: 'Cold Storage' }, { company: 'Susquehanna' }, { company: 'Susquehanna Cold Storage of Columbia' }, { company: 'Nobody', address: '400 River Road, Columbia' }, { company: 'Nobody', phone: '555-0199' }]) {
    assert.deepEqual(await ask(sam, q), [], JSON.stringify(q));
  }
  // The whole name, the whole phone number or the whole email does find it. The answer is the office and who to ask, and no more.
  const elsewhere = { company: null, owner: 'Harry Farfield', office: 'Farfield', stage: null, url: null };
  assert.deepEqual(await ask(sam, { company: 'susquehanna cold storage' }), [{ ...elsewhere, why: 'same name' }]);
  assert.deepEqual(await ask(sam, { company: 'Nobody', phone: '717.555.0199' }), [{ ...elsewhere, why: 'same phone number' }]);
  assert.deepEqual(await ask(sam, { company: 'Nobody', email: 'ED@susqcold.example' }), [{ ...elsewhere, why: 'same email' }]);
  assert.equal((await sam.get(`/sales/${lead}`)).status, 403);
  // The check made when a lead is saved follows the same rule.
  assert.equal((await sam.post('/sales', { company: 'Cold Storage' }, { page: '/sales' })).status, 302);       // part of another office's customer name: nothing to warn about
  const dup = await sam.post('/sales', { company: 'Susquehanna Cold Storage', phone: '717 555 0199' }, { page: '/sales' });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /<strong>Another office&#39;s customer<\/strong> <span class="meta">· same name, same phone number<\/span><\/span><span>Harry Farfield · Farfield<\/span>/);
  assert.doesNotMatch(dup.text, /Cold Storage LLC|susqcold|River Road/);
  // The page asks in the body of a request, so what is typed about a customer is not left in a web address.
  const posted = await sam.post('/sales/check', { company: 'Lititz Storage Barn' }, { page: '/sales' });
  assert.equal(posted.status, 200); assert.equal(JSON.parse(posted.text).matches[0].url, `/sales/${own}`);
  const js = (await sam.get('/sales.js')).text;
  assert.match(js, /fetch\('\/sales\/check', \{ method: 'POST'/); assert.doesNotMatch(js, /sales\/check\?/);

  // The page asks again at every pause in the typing. One lead typed a letter at a time, with a slip rubbed out on the way,
  // is a hundred requests and still only a customer or two looked up.
  const busy = await loggedIn('lk.busy');
  const look = async (q) => (await busy.get('/sales/check?' + new URLSearchParams(q))).status;
  const typing = { company: '', phone: '', email: '', address: '' }; let asked = 0;
  const type = async (box, text) => { for (const ch of text) { typing[box] += ch; assert.equal(await look(typing), 200, `${box}: ${typing[box]}`); asked += 1; } };
  await type('company', 'Conestoga Valley Dentl');
  typing.company = typing.company.slice(0, -1); assert.equal(await look(typing), 200);
  await type('company', 'al'); await type('phone', '(717) 555-0123 x45'); await type('email', 'office@cvdental.example'); await type('address', '1200 Lititz Pike, Lancaster');
  assert.ok(asked > 80, String(asked));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'Customer lookups paused'").get().n, 0);
  // Sixty different customers in fifteen minutes is plenty for adding leads. After that the answer is empty until the time is up, and the log says so once.
  // (The lead typed above counted three times: as typed, when the slip was put right, and for the extension on the phone number.)
  // Rubbing most of a name out and typing a different ending is a different customer too.
  for (let i = 4; i <= 60; i++) { assert.equal(await look({ company: 'Gue' }), 200); assert.equal(await look({ company: `Guess number ${i}` }), 200, `customer ${i}`); }
  const over = await busy.get('/sales/check?company=One%20guess%20too%20many');
  assert.equal(over.status, 429); assert.deepEqual(JSON.parse(over.text), { matches: [] });
  assert.equal(await look({ company: 'One guess too many, carried on' }), 429);
  assert.equal((await busy.post('/sales/check', { company: 'Lititz Storage Barn' }, { page: '/sales' })).status, 429);
  const paused = db.prepare("SELECT detail FROM activity_log WHERE action = 'Customer lookups paused' AND user_id = ?").all(userId('lk.busy'));
  assert.equal(paused.length, 1); assert.match(paused[0].detail, /60 different customers/);
  assert.equal((await sam.get('/sales/check?company=Lititz%20Storage%20Barn')).status, 200);                    // each person has their own count
  // Digits added to a phone number without end are not one number being typed: each one tries a different number, and counts.
  R.person('lk.dial', 'Dee Dialler', 'Sales', here);
  const dial = await loggedIn('lk.dial');
  const dialled = [];
  for (const digit of '1234') for (let n = 12; n <= 30; n++) dialled.push((await dial.get('/sales/check?' + new URLSearchParams({ company: 'Nobody', phone: digit.repeat(n) }))).status);
  assert.deepEqual([dialled.slice(0, 60).every((st) => st === 200), dialled.slice(60).every((st) => st === 429), dialled.length], [true, true, 76]);
  // Saving a lead is not held up by it: the check there still runs.
  assert.equal((await busy.post('/sales', { company: 'Lititz Storage Barn' }, { page: '/sales' })).status, 400);
  db.prepare('DELETE FROM lead_notes WHERE lead_id IN (SELECT id FROM leads WHERE branch_id IN (?, ?))').run(here, there);
  db.prepare('DELETE FROM leads WHERE branch_id IN (?, ?)').run(here, there);
});

test('sales: removing a lead is logged by its number and office, not the customer\'s name, and the name is not the page title', async () => {
  const R = accessChecks;
  const office = R.office('Forgetford');
  R.person('fg.mgr', 'Mia Forgetford', 'Sales manager', office);
  const mgr = await loggedIn('fg.mgr');
  await mgr.post('/sales', { company: 'Homer Forgetme', phone: '717-555-0177' }, { page: '/sales' });
  const lead = db.prepare("SELECT id FROM leads WHERE company = 'Homer Forgetme'").get().id;
  // The customer's name heads the page, but is not what the browser keeps as the page's title in its history.
  const page = (await mgr.get(`/sales/${lead}`)).text;
  assert.match(page, /<h1>Homer Forgetme<\/h1>/); assert.match(page, /<title>Lead · /); assert.doesNotMatch(page, /<title>[^<]*Forgetme/);
  await mgr.post(`/sales/${lead}/delete`, {}, { page: `/sales/${lead}` });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE id = ?').get(lead).n, 0);
  assert.equal(db.prepare("SELECT detail FROM activity_log WHERE action = 'Lead removed' ORDER BY id DESC").get().detail, `Lead ${lead}, Forgetford office`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE detail LIKE '%Forgetme%'").get().n, 0);
});

test('activity log: an office admin does not see when people changed a password, a reset address or Face ID; people who look after every office do', async () => {
  const R = accessChecks;
  const office = R.office('Logford');
  const tid = R.person('log.tech', 'Lena Logford', 'Technician', office); const aid = R.person('log.admin', 'Alan Logford', R.oneOffice(), office); R.person('log.corp', 'Cora Logford', 'Corporate admin', office);
  const activity = require('../app/activity');
  const lena = await loggedIn('log.tech');
  await lena.post('/account/email', { email: 'lena@example.com', current: 'correct horse battery' });
  await lena.post('/account/password', { current: 'correct horse battery', password: 'walnut ferry lantern 4', confirm: 'walnut ferry lantern 4' });
  const kinds = ['Email address changed', 'Password changed', 'Password reset by email', 'Face ID / fingerprint sign-in set up', 'Face ID / fingerprint sign-in removed'];
  for (const a of kinds.slice(2)) activity.log({ id: tid }, a, 'Written for this check');
  activity.log({ id: aid }, 'Stock count', 'LOGFORD-PART counted');
  assert.deepEqual(db.prepare('SELECT action FROM activity_log WHERE user_id = ? AND action <> ? ORDER BY id').all(tid, 'Signed in').map((r) => r.action), kinds);
  // To the minute, next to the date on an anonymous complaint, these would hint at who sent it, just as sign-ins would.
  const admin = await loggedIn('log.admin');
  const hidden = /Password changed|Password reset by email|Email address changed|Face ID \/ fingerprint sign-in/;
  assert.match((await admin.get('/admin/activity')).text, /LOGFORD-PART counted/);
  for (const url of ['/admin/activity', '/admin/activity?q=Lena', '/admin/activity?q=changed', '/admin/activity?show=signins']) assert.doesNotMatch((await admin.get(url)).text, hidden, url);
  const corp = await loggedIn('log.corp');
  await corp.post('/branch/view', { branch: String(office), back: '/' }, { page: '/' });
  const all = (await corp.get('/admin/activity?q=Lena')).text;
  for (const a of kinds) assert.ok(all.includes(`<td>Lena Logford</td><td class="nowrap">${a}</td>`), a);
});

test('removing a person: their photo file and sign-in history go with them, and sign-ins alone do not keep their name on file', async () => {
  const R = accessChecks;
  const office = R.office('Removeford');
  require('../app/routes/auth').clearLoginFailures();
  const used = R.person('rmv.used', 'Una Usedit', 'Technician', office);       // signed in, chose a password, added a photo; recorded nothing for the office
  const guessed = R.person('rmv.guess', 'Gus Guessed', 'Technician', office);  // never signed in; someone typed a wrong password against the username
  const busy = R.person('rmv.busy', 'Bix Busy', 'Technician', office);         // has a parts entry, so the name stays on it
  const addPhoto = (client) => client.post('/profile', [['about', 'Hello'], ['photo', new File([PNG], 'me.png', { type: 'image/png' })]], { multipart: true, page: '/profile' });
  const una = await loggedIn('rmv.used');
  await una.post('/account/password', { current: 'correct horse battery', password: 'copper meadow lantern 7', confirm: 'copper meadow lantern 7' });
  await addPhoto(una);
  assert.equal((await new Client().post('/login', { username: 'rmv.guess', password: 'not the password 1' }, { page: '/login' })).status, 401);
  await addPhoto(await loggedIn('rmv.busy'));
  db.prepare("INSERT INTO parts_submissions (user_id, action, source, created_at, created_local_date) VALUES (?, 'take', 'van', ?, ?)").run(busy, new Date().toISOString(), new Date().toISOString().slice(0, 10));
  require('../app/activity').log({ id: busy }, 'Stock count', 'REMOVEFORD-PART counted');
  const logged = (id) => db.prepare('SELECT action FROM activity_log WHERE user_id = ? ORDER BY id').all(id).map((r) => r.action);
  assert.deepEqual(logged(used), ['Signed in', 'Password changed']); assert.deepEqual(logged(guessed), ['Sign-in failed']); assert.deepEqual(logged(busy), ['Signed in', 'Stock count']);
  const file = (name) => path.join(dataDir, 'uploads', name);
  const photos = [used, busy].map((id) => db.prepare('SELECT photo_path FROM users WHERE id = ?').get(id).photo_path);
  for (const p of photos) assert.ok(p && fs.existsSync(file(p)));

  const owner = await loggedIn('owner');
  await owner.post('/branch/view', { branch: String(office), back: '/' }, { page: '/' });
  for (const id of [used, guessed, busy]) await owner.post(`/admin/users/${id}/remove`, {}, { page: '/admin/users' });
  // Nothing was on record for the first two but their own sign-ins, so they are gone entirely, that history included.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id IN (?, ?)').get(used, guessed).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_log WHERE user_id IN (?, ?)').get(used, guessed).n, 0);
  // Bix's parts entry keeps the name. The sign-in history does not stay with it; what Bix did for the office does.
  assert.deepEqual({ ...db.prepare('SELECT username, display_name, photo_path FROM users WHERE id = ?').get(busy) }, { username: `removed-${busy}`, display_name: 'Bix Busy', photo_path: null });
  assert.deepEqual(logged(busy), ['Stock count']);
  // The photo files themselves are deleted, not just forgotten.
  for (const p of photos) {
    for (let i = 0; i < 80 && fs.existsSync(file(p)); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(fs.existsSync(file(p)), false, p);
  }
});

test('folding a duplicate account into the one kept: a photo nobody will see again is deleted, and one the kept account takes over stays', async () => {
  const R = accessChecks;
  const office = R.office('Doubleford');
  const keep = R.person('dbl.keep', 'Dana Double', 'Technician', office); const extra = R.person('dbl.extra', 'Dana Double', 'Technician', office);   // both have a photo
  const bare = R.person('dbl.bare', 'Pat Pair', 'Technician', office); const twin = R.person('dbl.twin', 'Pat Pair', 'Technician', office);          // only the extra one has
  for (const u of ['dbl.keep', 'dbl.extra', 'dbl.twin']) {
    await (await loggedIn(u)).post('/profile', [['about', 'Hello'], ['photo', new File([PNG], 'me.png', { type: 'image/png' })]], { multipart: true, page: '/profile' });
  }
  const photo = (id) => db.prepare('SELECT photo_path FROM users WHERE id = ?').get(id).photo_path;
  const file = (name) => path.join(dataDir, 'uploads', name);
  const was = { keep: photo(keep), extra: photo(extra), twin: photo(twin) };
  for (const p of Object.values(was)) assert.ok(p && fs.existsSync(file(p)));
  const owner = await loggedIn('owner');
  await owner.post('/branch/view', { branch: String(office), back: '/' }, { page: '/' });
  await owner.post('/admin/users/duplicates', { keep: String(keep), extra: String(extra) }, { page: '/admin/users' });
  await owner.post('/admin/users/duplicates', { keep: String(bare), extra: String(twin) }, { page: '/admin/users' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id IN (?, ?)').get(extra, twin).n, 0);
  // The kept account already had its own photo: the other one has no account left to show it, so the file goes.
  assert.equal(photo(keep), was.keep); assert.ok(fs.existsSync(file(was.keep)));
  for (let i = 0; i < 80 && fs.existsSync(file(was.extra)); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(fs.existsSync(file(was.extra)), false);
  // The kept account had none: it takes the other one's photo over, file and all.
  assert.equal(photo(bare), was.twin); assert.ok(fs.existsSync(file(was.twin)));
  assert.equal((await owner.get(`/people/photo/${bare}`)).status, 200);
});

// -- review: sign-in, sessions, the lock and alerts --

test('idle lock: only things a person does count as using the site, so a page that moves by itself still locks', async () => {
  const js = (await new Client().get('/site.js')).text;
  // One list of events feeds both the page's own idle clock and the "still here" call to the server.
  const list = /var PERSON_EVENTS = \[([^\]]*)\]/.exec(js);
  assert.ok(list, 'the list of events that count as activity');
  assert.deepEqual(list[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort(), ['input', 'keydown', 'pointerdown', 'touchmove', 'touchstart', 'wheel']);
  // Scrolling is not in it (the home page banner scrolls itself every few seconds), nor is a resting mouse being "moved" by the page under it.
  assert.doesNotMatch(js, /\[[^\]]*'(scroll|mousemove|pointermove)'[^\]]*\]\.forEach/);
  assert.equal((js.match(/PERSON_EVENTS\.forEach/g) || []).length, 2);
  // And only real ones: an event a script made up is ignored by both.
  assert.match(js, /if \(!e\.isTrusted\) return; lastActive = Date\.now\(\)/);
  assert.match(js, /if \(e\.isTrusted\) ping\(\)/);

  // On the server, what the page does by itself never counts either: not the check for new alerts, not re-attaching this device's alerts.
  makeUser('idle.ida', 'Ida Idle');
  const c = await loggedIn('idle.ida');
  await c.get('/');
  const sidOf = () => decodeURIComponent(/portal\.sid=([^;]+)/.exec(c.cookie)[1]).slice(2).split('.')[0];
  const seen = () => JSON.parse(db.prepare('SELECT data FROM sessions WHERE sid = ?').get(sidOf()).data).seenAt;
  const token = await c.csrf('/');
  db.prepare("UPDATE sessions SET data = json_set(data, '$.seenAt', ?) WHERE sid = ?").run(Date.now() - 5 * 60000, sidOf());
  const was = seen();
  assert.equal((await c.get('/pulse')).status, 200);
  assert.equal((await c.req('POST', '/push/attach', new URLSearchParams({ _csrf: token, endpoint: 'https://fcm.googleapis.com/fcm/send/nobody' }))).status, 200);
  assert.equal(seen(), was);
  assert.equal((await c.req('HEAD', '/alive')).status, 204);                // a person typing or tapping: this one does count
  assert.ok(seen() > was);
});

test('alerts: a device gets them only while its own sign-in is alive, and the next person at that device does not inherit them', async () => {
  const push = require('../app/push');
  const pushed = [];
  push.setSender(async (sub, payload) => { pushed.push({ device: sub.endpoint.split('/').pop(), ...JSON.parse(payload) }); });
  const take = async () => { await new Promise((r) => setTimeout(r, 30)); return pushed.splice(0); };
  const devices = async () => (await take()).map((p) => p.device).sort();
  const page = '/settings/notifications';
  const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  const ep = (name) => `https://fcm.googleapis.com/fcm/send/${name}`;
  const turnOn = (client, name) => client.post('/push/subscribe', { endpoint: ep(name), ...KEYS, device: name }, { page });
  // What every signed-in page does by itself on a device that already allows alerts: no prompt, nothing shown.
  const reattach = async (client, name) => { const r = await client.post('/push/attach', { endpoint: ep(name) }, { page: '/' }); try { return JSON.parse(r.text).ok; } catch (e) { return false; } };
  const signOut = (client) => client.post('/logout', {}, { page: '/' });
  const owns = (name) => (db.prepare('SELECT u.username FROM push_subscriptions p JOIN users u ON u.id = p.user_id WHERE p.endpoint = ?').get(ep(name)) || {}).username;

  access.ensureProfile('Alert tester', 'all', [...access.SUBMIT, 'forum.use']);
  for (const [u, n] of [['al.ann', 'Ann Alert'], ['al.bob', 'Bob Borrow'], ['al.cat', 'Cat Colleague']]) db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId('Alert tester'), makeUser(u, n));
  makeUser('al.boss', 'Bea Boss', { role: 'admin', reviewer: true }); makeUser('al.corp', 'Cory Corporate', { role: 'admin', reviewer: true });
  const ann = userId('al.ann'), bob = userId('al.bob');
  const cat = await loggedIn('al.cat'); const boss = await loggedIn('al.boss');
  let n = 0;
  const thank = async (id) => assert.equal((await cat.post('/shoutouts', { to_user: String(id), message: `Thank you ${++n}` }, { page: '/shoutouts' })).status, 302);
  // The senders that name one person directly, by id: these never checked the account at all.
  const direct = (id) => push.notify([id], 'task_assigned', { title: 'Note on your lead: Keystone Bakery Supply', body: 'Cat Colleague: "customer signed, PO 88213"', url: '/sales/1' });

  // Ann turns alerts on, on her phone and on the shared computer in the office. Each sign-in gets her alerts.
  const phone = await loggedIn('al.ann'); let desk = await loggedIn('al.ann');
  assert.equal((await turnOn(phone, 'ann-phone')).status, 200); assert.equal((await turnOn(desk, 'office-pc')).status, 200);
  await thank(ann);
  assert.deepEqual(await devices(), ['ann-phone', 'office-pc']);

  // She signs out of the office computer. Nothing more goes to it, from that moment. Her phone carries on.
  await signOut(desk);
  await thank(ann); await direct(ann);
  assert.deepEqual(await devices(), ['ann-phone', 'ann-phone']);

  // Bob signs in on that computer. The browser there still holds the registration, but it is not his: the page's quiet
  // re-attach does nothing for him, his alerts do not appear there, and Ann's do not come back because someone signed in.
  const bobDesk = await loggedIn('al.bob');
  assert.equal(await reattach(bobDesk, 'office-pc'), false);
  await thank(bob); await direct(bob); await thank(ann);
  assert.deepEqual(await devices(), ['ann-phone']);
  assert.equal(owns('office-pc'), 'al.ann');
  assert.doesNotMatch((await bobDesk.get(page)).text, /office-pc/);
  await signOut(bobDesk);

  // Ann signs in there again. The page re-attaches what she had already allowed: no new permission, nothing to press.
  desk = await loggedIn('al.ann');
  await thank(ann);
  assert.deepEqual(await devices(), ['ann-phone']);                          // signing in alone is not enough: the device has to say it is the same one
  assert.equal(await reattach(desk, 'office-pc'), true);
  await thank(ann);
  assert.deepEqual(await devices(), ['ann-phone', 'office-pc']);
  // Her settings page lists the devices that get her alerts now, and the test alert goes to exactly those.
  let mine = (await phone.get(page)).text;
  assert.match(mine, /<strong>ann-phone<\/strong>/); assert.match(mine, /<strong>office-pc<\/strong>/);
  await signOut(desk);
  mine = (await phone.get(page)).text;
  assert.match(mine, /<strong>ann-phone<\/strong>/); assert.doesNotMatch(mine, /<strong>office-pc<\/strong>/);
  await phone.post('/push/test', {}, { page });
  assert.deepEqual((await take()).map((p) => [p.device, p.title]), [['ann-phone', 'Test alert']]);
  assert.match((await phone.get(page)).text, /Test alert sent to 1 device\./);

  // Bob turns alerts on himself at the office computer. That is the one way to take a device over: it is his now, not Ann's.
  const bobAgain = await loggedIn('al.bob');
  assert.equal((await turnOn(bobAgain, 'office-pc')).status, 200);
  assert.equal(owns('office-pc'), 'al.bob');
  desk = await loggedIn('al.ann');
  assert.equal(await reattach(desk, 'office-pc'), false);                    // and Ann, back at that computer, does not get it back by signing in
  await thank(ann); await thank(bob);
  assert.deepEqual(await devices(), ['ann-phone', 'office-pc']);
  await signOut(desk); await signOut(bobAgain);

  // Changing her own password signs her other devices out: only the one she changed it on keeps getting alerts.
  const tablet = await loggedIn('al.ann'); await turnOn(tablet, 'ann-tablet');
  await thank(ann);
  assert.deepEqual(await devices(), ['ann-phone', 'ann-tablet']);
  await phone.post('/account/password', { current: 'correct horse battery', password: 'harbor violet anchor 22', confirm: 'harbor violet anchor 22' });
  await thank(ann);
  assert.deepEqual(await devices(), ['ann-phone']);

  // Things are waiting for Ann from three directions: a task, a discussion she follows, and a parts request.
  await boss.post('/admin/tasks', { title: 'Alert task', to: String(ann) }, { page: '/admin/tasks' });
  const task = db.prepare("SELECT id FROM tasks WHERE title = 'Alert task' AND assigned_to = ?").get(ann).id;
  const section = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  await phone.post('/discussions/new', [['section_id', String(section)], ['title', 'Alert thread'], ['body', 'First post']], { multipart: true, page: '/discussions/new' });
  const thread = db.prepare("SELECT id FROM forum_threads WHERE title = 'Alert thread'").get().id;
  await phone.post('/parts', [['action', 'request'], ['part_name', 'ALERT-PART'], ['quantity', '1'], ['source', 'van'], ['needed_by', '2031-10-01']], { multipart: true });
  const request = lastParts().id;
  await take();
  const nudge = async (i) => {
    await boss.post(`/admin/tasks/${task}/note`, { note: `Any news? ${i}` }, { page: `/admin/tasks/${task}` });
    await cat.post(`/discussions/t/${thread}/reply`, [['body', `Reply ${i}: the customer is Marta Ruiz`]], { multipart: true, page: `/discussions/t/${thread}` });
    await boss.post(`/admin/parts/${request}/status`, { status: i % 2 ? 'ordered' : 'new', back: 'requests' }, { page: '/admin/requests' });
    await direct(ann);
    return take();
  };
  let got = await nudge(1);
  assert.deepEqual(got.map((p) => p.tag).sort(), ['forum_reply', 'request_status', 'task_assigned', 'task_assigned']);
  assert.ok(got.every((p) => p.device === 'ann-phone'));

  // An admin disables her account. Her phone still has the registration, and none of those senders reach it any more.
  await boss.post(`/admin/users/${ann}/toggle-active`, {}, { page: '/admin/users' });
  assert.equal(db.prepare('SELECT active FROM users WHERE id = ?').get(ann).active, 0);
  assert.deepEqual(await nudge(2), []);
  // Switched back on: still nothing, until she signs in on the phone again and the page re-attaches it.
  await boss.post(`/admin/users/${ann}/toggle-active`, {}, { page: '/admin/users' });
  assert.deepEqual(await nudge(3), []);
  const phoneAgain = new Client(); await phoneAgain.login('al.ann', 'harbor violet anchor 22');
  assert.equal(await reattach(phoneAgain, 'ann-phone'), true);
  got = await nudge(4);
  assert.equal(got.length, 4); assert.ok(got.every((p) => p.device === 'ann-phone'));

  // A sign-in that has run out is no sign-in: nothing goes to its device.
  const sidOf = (client) => decodeURIComponent(/portal\.sid=([^;]+)/.exec(client.cookie)[1]).slice(2).split('.')[0];
  const expires = db.prepare('SELECT expires FROM sessions WHERE sid = ?').get(sidOf(phoneAgain)).expires;
  db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(Date.now() - 1000, sidOf(phoneAgain));
  assert.deepEqual(await nudge(5), []);
  db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sidOf(phoneAgain));
  assert.equal((await nudge(6)).length, 4);

  // The lost-phone step: an admin resets her password. The phone is signed out and its alerts stop, though its registration is still on record.
  await boss.post(`/admin/users/${ann}/reset-password`, {}, { page: '/admin/users' });
  assert.deepEqual(await nudge(7), []);
  assert.equal(owns('ann-phone'), 'al.ann');

  // A corporate admin who is stood down is signed out, and so are their alerts.
  const cory = await loggedIn('al.corp'); await turnOn(cory, 'cory-phone');
  await thank(userId('al.corp'));
  assert.deepEqual(await devices(), ['cory-phone']);
  await boss.post(`/admin/corporate/admins/${userId('al.corp')}/remove`, {}, { page: '/admin/branches' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE json_extract(data, '$.userId') = ?").get(userId('al.corp')).n, 0);
  await thank(userId('al.corp'));
  assert.deepEqual(await devices(), []);

  // "Sign out everyone" stops everyone's alerts except on the device of the person who pressed it.
  const bobPhone = await loggedIn('al.bob'); await turnOn(bobPhone, 'bob-phone'); await turnOn(boss, 'boss-pc');
  await thank(bob); await thank(userId('al.boss'));
  assert.deepEqual(await devices(), ['bob-phone', 'boss-pc']);
  await boss.post('/admin/security/sign-out-everyone', {}, { page: '/admin/security' });
  await direct(bob); await direct(userId('al.boss'));
  assert.deepEqual(await devices(), ['boss-pc']);

  // The pages do their part: every signed-in page re-attaches quietly, and the settings page no longer hands a device
  // to whoever happens to open it.
  const site = (await new Client().get('/site.js')).text; const settings = (await new Client().get('/push.js')).text;
  assert.match(site, /fetch\('\/push\/attach'/); assert.match(site, /Notification\.permission !== 'granted'/);
  assert.match(settings, /post\('\/push\/attach'/);
  assert.equal((settings.match(/post\('\/push\/subscribe'/g) || []).length, 1);   // only behind the "Turn on" button
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE '%/ann-%' OR endpoint LIKE '%/office-pc' OR endpoint LIKE '%/cory-phone' OR endpoint LIKE '%/bob-phone' OR endpoint LIKE '%/boss-pc'").run();
  db.prepare("DELETE FROM tasks WHERE title = 'Alert task'").run();
  push.setSender(async () => {});
});

test('signed-out visitors: only a page with a form leaves a session behind, it is short-lived, and floods from one address are turned away', async () => {
  const count = () => db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  const cookies = (r) => r.headers.getSetCookie().filter((c) => c.startsWith('portal.sid'));
  makeUser('so.sam', 'Sam Signedout');
  const before = count();

  // Pages that send a visitor elsewhere, pages that do not exist, files, refused forms: no session, and no cookie either.
  const nothing = [['GET', '/', 302], ['GET', '/parts?action=take', 302], ['GET', '/no-such-page', 404], ['GET', '/wp-login.php', 404], ['GET', '/.env', 404],
    ['GET', '/complaint', 302], ['GET', '/complaint/status', 302], ['GET', '/pulse', 401], ['GET', '/alive', 401], ['GET', '/unlock', 302], ['GET', '/account/password', 302],
    ['GET', '/healthz', 200], ['GET', '/site.js', 200], ['GET', '/reset/' + 'cd'.repeat(32), 404], ['HEAD', '/', 302], ['HEAD', '/no-such-page', 404],
    ['POST', '/login', 403], ['POST', '/forgot', 403], ['POST', '/lock', 403], ['POST', '/no-such-page', 403]];
  for (const [method, url, status] of nothing) {
    const r = await new Client().req(method, url, method === 'POST' ? new URLSearchParams({ username: 'so.sam', password: 'correct horse battery' }) : undefined);
    assert.equal(r.status, status, `${method} ${url}`);
    assert.deepEqual(cookies(r), [], `${method} ${url} set a session cookie`);
  }
  assert.equal(count(), before);

  // The sign-in page has a form, so it gets one: a single row, kept for about two hours, not thirty days.
  const sidOf = (client) => decodeURIComponent(/portal\.sid=([^;]+)/.exec(client.cookie)[1]).slice(2).split('.')[0];
  const life = (client) => db.prepare('SELECT expires FROM sessions WHERE sid = ?').get(sidOf(client)).expires - Date.now();
  const HOUR = 3600000;
  const c = new Client();
  assert.equal((await c.get('/parts?action=take')).location, '/login?next=%2Fparts%3Faction%3Dtake');
  const form = await c.get('/login?next=%2Fparts%3Faction%3Dtake');
  assert.match(form.text, /name="next" value="\/parts\?action=take"/);
  assert.equal(count(), before + 1);
  assert.ok(life(c) > 1.9 * HOUR && life(c) < 2.1 * HOUR, `a visitor's session lasts about two hours, not ${Math.round(life(c) / HOUR)}`);
  await c.get('/login'); await c.get('/no-such-page'); await c.get('/');
  assert.equal(count(), before + 1);                                         // the same visitor keeps the same row
  assert.ok(life(c) < 2.1 * HOUR);
  // Signing in works as before, goes back to the page that was asked for, and swaps the short session for the 30-day one.
  const token = /name="_csrf" value="([0-9a-f]+)"/.exec(form.text)[1];
  const signedIn = await c.req('POST', '/login', new URLSearchParams({ _csrf: token, username: 'so.sam', password: 'correct horse battery', next: '/parts?action=take' }));
  assert.equal(signedIn.location, '/parts?action=take');
  assert.equal((await c.get('/parts?action=take')).status, 200);
  assert.equal(count(), before + 1);
  assert.ok(life(c) > 29 * 24 * HOUR);
  await c.post('/logout', {}, { page: '/' });
  assert.equal(count(), before);

  // Forgot password and a working reset link have forms too; the answer pages and a dead link do not.
  db.prepare("UPDATE users SET email = 'sam@example.com' WHERE username = 'so.sam'").run();
  sent.length = 0;
  const f = new Client();
  await f.post('/forgot', { who: 'so.sam' }, { page: '/forgot' });
  assert.equal(count(), before + 1);
  assert.ok(life(f) < 2.1 * HOUR);
  const link = /http:\/\/portal\.test(\/reset\/[0-9a-f]{64})/.exec(sent.pop().text)[1];
  const r = new Client();
  assert.equal((await r.post(link, { password: 'meadow lantern copper 7', confirm: 'meadow lantern copper 7' }, { page: link })).location, '/login');
  assert.equal(count(), before + 2);
  assert.match((await r.get('/login')).text, /Password changed\. Sign in with your new password\./);
  await new Client().login('so.sam', 'meadow lantern copper 7');

  // A visitor's session that has run out is simply gone: the form it carried is refused, and a fresh page works.
  const late = new Client();
  const old = await late.csrf('/login');
  db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(Date.now() - 1000, sidOf(late));
  assert.equal((await late.req('POST', '/login', new URLSearchParams({ _csrf: old, username: 'so.sam', password: 'meadow lantern copper 7' }))).status, 403);
  await late.login('so.sam', 'meadow lantern copper 7');
  // The sign-in page copes with having sat open for hours: it collects a fresh token before it sends (checked in a browser too).
  const js = (await new Client().get('/site.js')).text;
  assert.match(js, /window\.portalFreshToken = fresh/); assert.match((await new Client().get('/passkey.js')).text, /window\.portalFreshToken \? window\.portalFreshToken\(\)/);

  // Rows left over from when every visitor got a 30-day session are cut down to two hours when the site starts, not deleted
  // on the spot: a sign-in page that was open while the site was updated still works. Sign-ins are not touched.
  const Store = require('../app/sessionStore');
  const put = db.prepare('INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)');
  put.run('old-visitor', Date.now() + 29 * 24 * HOUR, JSON.stringify({ cookie: {}, csrf: 'x' }));
  put.run('new-visitor', Date.now() + HOUR, JSON.stringify({ cookie: {}, csrf: 'y' }));
  put.run('old-signed-in', Date.now() + 29 * 24 * HOUR, JSON.stringify({ cookie: {}, csrf: 'z', userId: userId('so.sam') }));
  put.run('ran-out', Date.now() - 1000, JSON.stringify({ cookie: {}, csrf: 'w', userId: userId('so.sam') }));
  const open = new Client();
  const openToken = await open.csrf('/login?next=%2Fpeople');                // a sign-in page somebody has open, from before the update
  db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(Date.now() + 29 * 24 * HOUR, sidOf(open));
  const lives = () => Object.fromEntries(db.prepare("SELECT sid, expires FROM sessions WHERE sid IN ('old-visitor', 'new-visitor', 'old-signed-in', 'ran-out')").all().map((x) => [x.sid, Math.round((x.expires - Date.now()) / HOUR)]));
  clearInterval(new Store(db, 30 * 24 * HOUR, 2 * HOUR).timer);
  assert.deepEqual(lives(), { 'old-visitor': 2, 'new-visitor': 1, 'old-signed-in': 29 * 24 });
  assert.ok(life(open) < 2.1 * HOUR);
  assert.equal((await open.req('POST', '/login', new URLSearchParams({ _csrf: openToken, username: 'so.sam', password: 'meadow lantern copper 7', next: '/people' }))).location, '/people');
  clearInterval(new Store(db, 30 * 24 * HOUR, 2 * HOUR).timer);              // a second start changes nothing
  assert.deepEqual(lives(), { 'old-visitor': 2, 'new-visitor': 1, 'old-signed-in': 29 * 24 });
  db.prepare("DELETE FROM sessions WHERE sid IN ('old-visitor', 'new-visitor', 'old-signed-in')").run();

  // The allowance for one address, tried on a site started with the ordinary settings (this file raises the sign-in
  // limit for its own sake, and the allowance follows it). 600 requests in five minutes from people who are not signed in,
  // then "wait". Someone who is signed in is never counted or refused, and neither is the health check.
  // (It runs beside this file's own site, not in place of it: holding this one still for seconds leaves its open
  // connections stale, and the next test's first request then fails.)
  const L = encryptionLab();
  const beside = (code) => new Promise((resolve) => require('child_process').execFile(process.execPath, ['-e', code],
    { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, DATA_DIR: L.dir, BCRYPT_ROUNDS: '4', APP_TIMEZONE: 'America/New_York' }, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') })));
  const out = await beside(`
    const db = require('./app/db'); const auth = require('./app/auth'); const app = require('./app/app');
    const id = auth.createUser({ username: 'lim.one', displayName: 'Lim One', password: 'correct horse battery', profile: 'Technician' });
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id);
    const server = app.listen(0, async () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const page = await fetch(base + '/login');
      const cookie = page.headers.getSetCookie()[0].split(';')[0];
      const token = /name="_csrf" value="([0-9a-f]+)"/.exec(await page.text())[1];
      const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams({ _csrf: token, username: 'lim.one', password: 'correct horse battery' }) });
      const mine = login.headers.getSetCookie()[0].split(';')[0];
      const tally = {}; let rows = 0;
      for (let i = 0; i < 640; i++) { const r = await fetch(base + (i % 2 ? '/wp-login.php' : '/'), { redirect: 'manual' }); tally[r.status] = (tally[r.status] || 0) + 1; await r.arrayBuffer(); }
      rows = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
      const refused = await fetch(base + '/login'); const said = await refused.text();
      const signedIn = []; for (let i = 0; i < 700; i++) { const r = await fetch(base + '/pulse', { headers: { cookie: mine } }); signedIn.push(r.status); await r.arrayBuffer(); }
      const health = (await fetch(base + '/healthz')).status; const file = (await fetch(base + '/site.js')).status;
      console.log(JSON.stringify({ login: login.status, tally, rows, refused: refused.status, said, signedIn: [...new Set(signedIn)], health, file }));
      server.close(); db.close();
    });`);
  assert.ok(out.ok, out.err);
  const lab = JSON.parse(out.out.trim().split('\n').pop());
  assert.equal(lab.login, 302);
  assert.deepEqual(lab.tally, { 302: 299, 404: 299, 429: 42 });               // 2 of the 600 went on the sign-in itself
  assert.equal(lab.rows, 1);                                                  // and all of that left one row: the sign-in
  assert.equal(lab.refused, 429); assert.equal(lab.said, 'Too many requests from this connection. Wait a few minutes and try again.');
  assert.deepEqual(lab.signedIn, [200]); assert.equal(lab.health, 200); assert.equal(lab.file, 200);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('temporary password: the reset email cannot be set, and the password cannot be re-confirmed, until the person has chosen their own', async () => {
  const id = auth.createUser({ username: 'tp.pat', displayName: 'Pat Pending', password: 'temp-pass-5678' });   // as an admin hands it out: must be changed
  const c = new Client();
  assert.equal((await c.login('tp.pat', 'temp-pass-5678')).location, '/account/password');
  assert.doesNotMatch((await c.get('/account/password')).text, /action="\/account\/email"/);                     // the page does not offer it
  const logged = () => db.prepare("SELECT COUNT(*) n FROM activity_log WHERE user_id = ? AND action = 'Email address changed'").get(id).n;
  // Someone who saw the temporary password in a chat cannot quietly point password resets at their own address.
  const tried = await c.post('/account/email', { email: 'pat@evil.example', current: 'temp-pass-5678' });
  assert.equal(tried.location, '/account/password');
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(id).email, null);
  assert.equal(logged(), 0);
  assert.equal((await c.post('/account/confirm', { password: 'temp-pass-5678', next: '/admin/backups' })).location, '/account/password');
  assert.deepEqual(await sendJson(c, '/account/confirm', { password: 'temp-pass-5678' }), { status: 403, body: { ok: false } });
  sent.length = 0;
  await new Client().post('/forgot', { who: 'tp.pat' }, { page: '/forgot' });
  assert.equal(sent.length, 0);                                                                                  // so no reset link goes anywhere
  // Once they have chosen their own password, both work as before.
  assert.equal((await c.post('/account/password', { current: 'temp-pass-5678', password: 'copper meadow lantern 4', confirm: 'copper meadow lantern 4' })).status, 302);
  await c.post('/account/email', { email: 'pat@example.com', current: 'copper meadow lantern 4' });
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(id).email, 'pat@example.com');
  assert.equal(logged(), 1);
  assert.deepEqual(await sendJson(c, '/account/confirm', { password: 'copper meadow lantern 4' }), { status: 200, body: { ok: true } });
});

test('sign-in history: a successful sign-in records the address it came from, with a password or with Face ID', async () => {
  const id = makeUser('ip.ivy', 'Ivy Inward');
  const mine = () => db.prepare("SELECT detail FROM activity_log WHERE user_id = ? AND action = 'Signed in' ORDER BY id").all(id).map((r) => r.detail);
  const DESK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const c = new Client(DESK); await c.login('ip.ivy', 'correct horse battery');
  // The same form the failed ones use ("Wrong password, from ..."), so the two can be lined up.
  assert.match(mine().pop(), /^With a password, on a computer, from [0-9a-f.:]+$/);
  await new Client().post('/login', { username: 'ip.ivy', password: 'not it at all' }, { page: '/login' });
  const failed = db.prepare("SELECT detail FROM activity_log WHERE user_id = ? AND action = 'Sign-in failed' ORDER BY id DESC").get(id).detail;
  assert.equal(failed.replace('Wrong password, from ', ''), mine().pop().split(', from ')[1]);
  // Face ID or a fingerprint: the device, the kind of device, and the address.
  const phone = new FakeDevice(base);
  let opts = (await sendJson(c, '/passkey/register/options')).body.options;
  assert.equal((await sendJson(c, '/passkey/register/verify', { response: phone.create(opts), device: 'Ivy iPhone (Safari)' })).status, 200);
  const fresh = new Client();
  opts = (await sendJson(fresh, '/passkey/auth/options', {}, '/login')).body.options;
  assert.equal((await sendJson(fresh, '/passkey/auth/verify', { response: phone.get(opts) }, '/login')).status, 200);
  assert.match(mine().pop(), /^With Face ID or a fingerprint \(Ivy iPhone \(Safari\)\), on a phone or tablet, from [0-9a-f.:]+$/);
  // Still for corporate admins only: an office admin sees no sign-in entries, with or without an address.
  access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all'));
  db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId('Office admin (one office)'), makeUser('ip.office', 'Olga Office'));
  const office = await loggedIn('ip.office');
  for (const url of ['/admin/activity', '/admin/activity?show=signins', '/admin/activity?q=Ivy', '/admin/activity?q=from']) assert.doesNotMatch((await office.get(url)).text, /Signed in|With a password|Wrong password, from/, url);
  const corp = await loggedIn('owner');
  assert.match((await corp.get('/admin/activity?show=signins&q=Ivy')).text, /Signed in<\/td><td>With a password, on a computer, from /);
});

test('complaint notice: every office with new complaints is counted and told, once a day, by date, with nothing about the complaints in the email', async () => {
  const was = db.prepare("SELECT value FROM meta WHERE key = 'complaint_digest_date'").get();
  const home = db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
  const office = (name) => db.prepare('INSERT INTO branches (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString()).lastInsertRowid;
  const north = office('Noticeville North'), south = office('Noticeville South');
  access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all'));
  access.ensureProfile('Corporate admin', 'all', access.ALL);
  const person = (username, profile, branch, email, active = 1) => db.prepare('UPDATE users SET profile_id = ?, branch_id = ?, email = ?, active = ? WHERE id = ?').run(profileId(profile), branch, email, active, makeUser(username, username));
  person('cn.north', 'Office admin (one office)', north, 'north@example.com');
  person('cn.south', 'Office admin (one office)', south, 'south@example.com');
  person('cn.corp', 'Corporate admin', home, 'corp@example.com');
  person('cn.left', 'Office admin (one office)', north, 'left@example.com', 0);       // disabled: told nothing
  person('cn.tech', 'Technician', north, 'tech@example.com');                         // cannot read complaints: told nothing
  const add = (branch, date, text) => db.prepare("INSERT INTO complaints (id, category, description, tracking_code_hash, created_date, branch_id, notified) VALUES (?, 'other', ?, ?, ?, ?, 1)")
    .run(nodeCrypto.randomBytes(8).toString('hex'), text, nodeCrypto.randomBytes(16).toString('hex'), date, branch);
  db.prepare("INSERT INTO meta (key, value) VALUES ('complaint_digest_date', '2031-03-10') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  add(home, '2031-03-10', 'NOTICE-TEXT home'); add(north, '2031-03-10', 'NOTICE-TEXT north one'); add(north, '2031-03-10', 'NOTICE-TEXT north two');
  add(north, '2031-03-11', 'NOTICE-TEXT north, written on the day of the notice');
  add(south, '2031-03-09', 'NOTICE-TEXT south, covered by an earlier notice');
  // Who was told, out of the mailbox and the five people above (other reviewers made earlier in this file get theirs too).
  const WATCHED = ['reviewer@example.com', 'north@example.com', 'south@example.com', 'corp@example.com', 'left@example.com', 'tech@example.com'];
  const told = () => Object.fromEntries(sent.splice(0).filter((m) => WATCHED.includes(m.to)).map((m) => [m.to, m.subject]));
  const marks = () => db.prepare("SELECT DISTINCT notified FROM complaints").all().map((r) => r.notified);
  const before = db.prepare("SELECT id, notified FROM complaints WHERE description LIKE 'NOTICE-TEXT%' ORDER BY id").all();

  // The notice of 11 March covers the day before: one in the first office, two in the north office, none in the south.
  sent.length = 0;
  assert.equal(await mail.runComplaintDigest(new Date('2031-03-11T18:00:00Z')), 3);
  const bodies = sent.map((m) => m.text).join('\n');
  assert.deepEqual(told(), {
    'reviewer@example.com': 'A new complaint was submitted',          // the first office's mailbox, as before
    'north@example.com': '2 new complaints were submitted',           // the north office's own reviewer: nobody was told before
    'corp@example.com': '3 new complaints were submitted',            // someone who reads every office's complaints
  });
  assert.doesNotMatch(bodies, /NOTICE-TEXT|Noticeville|other/i);       // a count and a link, nothing else
  assert.match(bodies, /^2 new anonymous complaints are waiting for review\.\n\nhttp:\/\/portal\.test\/admin\/complaints\n$/m);
  assert.equal(await mail.runComplaintDigest(new Date('2031-03-11T22:00:00Z')), 0);   // once a day
  assert.deepEqual(told(), {});
  // The next day's notice picks up the one written on the 11th. Each complaint is counted exactly once.
  assert.equal(await mail.runComplaintDigest(new Date('2031-03-12T18:00:00Z')), 1);
  assert.deepEqual(told(), { 'north@example.com': 'A new complaint was submitted', 'corp@example.com': 'A new complaint was submitted' });
  assert.equal(await mail.runComplaintDigest(new Date('2031-03-13T18:00:00Z')), 0);
  assert.deepEqual(told(), {});
  // Sending a notice marks nothing: every complaint carries the same value before and after, so the database cannot
  // show which side of a notice one fell on.
  assert.deepEqual(db.prepare("SELECT id, notified FROM complaints WHERE description LIKE 'NOTICE-TEXT%' ORDER BY id").all(), before);
  assert.deepEqual(marks(), [1]);

  db.prepare("DELETE FROM complaints WHERE description LIKE 'NOTICE-TEXT%'").run();
  if (was) db.prepare("UPDATE meta SET value = ? WHERE key = 'complaint_digest_date'").run(was.value); else db.prepare("DELETE FROM meta WHERE key = 'complaint_digest_date'").run();
  db.prepare("UPDATE users SET email = NULL WHERE username LIKE 'cn.%'").run();
});

test('complaint trail: capitals in the address, the lock screen, the Back button and switching office leave no trace of the form either', async () => {
  makeUser('ct.tess', 'Tess Trail'); makeUser('ct.ida', 'Ida Idle');
  const pw = 'correct horse battery';
  const sidOf = (client) => decodeURIComponent(/portal\.sid=([^;]+)/.exec(client.cookie)[1]).slice(2).split('.')[0];
  const rowOf = (client) => ({ ...db.prepare('SELECT expires, data FROM sessions WHERE sid = ?').get(sidOf(client)) });
  // The request lines written since the last look (the captured log itself is left as it is, for whoever reads it next).
  let read = logLines.length;
  const logged = async () => { await new Promise((r) => setTimeout(r, 30)); const lines = logLines.slice(read).filter((l) => /^(GET|POST|HEAD) /.test(l)); read = logLines.length; return lines; };
  const tess = await loggedIn('ct.tess');
  await tess.get('/');
  await logged();

  // The same pages typed with capitals, or with a slash on the end, are shown just the same. So they are treated just the
  // same: nothing in the log, and the session row is left exactly as it was.
  const before = rowOf(tess);
  await new Promise((r) => setTimeout(r, 15));
  for (const url of ['/Complaint', '/COMPLAINT', '/complaint/', '/Complaint/Status', '/complaint/STATUS/']) {
    const r = await tess.get(url);
    assert.equal(r.status, 200, url);
    assert.match(r.text, /<form method="post" action="\/complaint(\/status)?"/, url);
  }
  assert.deepEqual(await logged(), []);
  assert.deepEqual(rowOf(tess), before);
  // A sign-in aimed at one of them goes by the home page, like the plain address.
  const aimed = async (next) => (await new Client().post('/login', { username: 'ct.tess', password: pw, next }, { page: '/login' })).location;
  assert.equal(await aimed('/Complaint'), '/#complaint-form');
  assert.equal(await aimed('/COMPLAINT/Status/'), '/#complaint-status');
  assert.equal(await aimed('/people'), '/people');
  // Face ID or a fingerprint does the same, signing in from scratch and unlocking.
  const phone = new FakeDevice(base);
  let opts = (await sendJson(tess, '/passkey/register/options')).body.options;
  assert.equal((await sendJson(tess, '/passkey/register/verify', { response: phone.create(opts), device: 'Tess phone' })).status, 200);
  const byFace = new Client();
  opts = (await sendJson(byFace, '/passkey/auth/options', {}, '/login')).body.options;
  assert.deepEqual((await sendJson(byFace, '/passkey/auth/verify', { response: phone.get(opts), next: '/complaint' }, '/login')).body, { ok: true, next: '/#complaint-form' });
  assert.equal((await byFace.post('/lock', {}, { page: '/' })).status, 204);
  opts = (await sendJson(byFace, '/passkey/auth/options', {}, '/unlock')).body.options;
  assert.deepEqual((await sendJson(byFace, '/passkey/auth/verify', { response: phone.get(opts), next: '/Complaint/status' }, '/unlock')).body, { ok: true, next: '/#complaint-status' });
  // None of those sign-ins kept a note of where the person was heading.
  assert.doesNotMatch(db.prepare('SELECT data FROM sessions').all().map((x) => x.data).join('\n'), /complaint/i);

  // The Back button after unlocking asks for the lock screen again while the site is open. That goes by the home page
  // too, not straight to the form from a request that is on record.
  assert.equal((await tess.get('/unlock?next=%2Fcomplaint')).location, '/#complaint-form');
  assert.equal((await tess.post('/unlock', { password: pw, next: '/complaint/status' }, { page: '/' })).location, '/#complaint-status');
  assert.equal((await tess.get('/unlock?next=%2Fpeople')).location, '/people');

  // The site closed and opened again straight at the form (a restored tab, a bookmark): the page locks itself and the
  // person unlocks. In the log that reads line for line like a site that sat unused on the home page until it locked.
  const unlock = async (client, next) => {
    const screen = await client.get('/unlock?next=' + encodeURIComponent(next));
    assert.equal(screen.status, 200);
    return client.req('POST', '/unlock', new URLSearchParams({ _csrf: /name="_csrf" value="([0-9a-f]+)"/.exec(screen.text)[1], password: pw, next }));
  };
  await logged();
  assert.equal((await tess.post('/lock', {}, { page: '/complaint' })).status, 204);
  assert.equal((await unlock(tess, '/complaint')).location, '/#complaint-form');
  assert.equal((await tess.get('/')).status, 200);
  const reopenedAtTheForm = await logged();
  const ida = await loggedIn('ct.ida');
  await ida.get('/');
  await logged();
  db.prepare("UPDATE sessions SET data = json_set(data, '$.seenAt', ?) WHERE sid = ?").run(Date.now() - 3 * 3600000, sidOf(ida));
  assert.equal((await ida.get('/pulse')).location, '/unlock?next=%2Fpulse');   // the page's own check finds the site has locked
  assert.equal((await unlock(ida, '/')).location, '/');
  assert.equal((await ida.get('/')).status, 200);
  assert.deepEqual(reopenedAtTheForm, await logged());
  assert.deepEqual(reopenedAtTheForm, ['POST /unlock 302', 'GET / 200']);

  // Someone who looks at every office, changing office while a complaint page is open, is taken back by the home page as well.
  const corp = await loggedIn('owner');
  assert.equal((await corp.post('/branch/view', { branch: 'all', back: '/complaint' }, { page: '/' })).location, '/#complaint-form');
  assert.equal((await corp.post('/branch/view', { branch: 'all', back: '/Complaint/status' }, { page: '/' })).location, '/#complaint-status');
  assert.equal((await corp.post('/branch/view', { branch: 'all', back: '/people' }, { page: '/' })).location, '/people');
});

test('alerts: an account that is switched off or removed gets nothing, even with a sign-in of theirs still on record', async () => {
  const push = require('../app/push');
  const pushed = [];
  push.setSender(async (sub) => { pushed.push(sub.endpoint.split('/').pop()); });
  const id = makeUser('al.dee', 'Dee Device');
  const c = await loggedIn('al.dee');
  const turnedOn = await c.post('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/dee-phone', device: 'dee-phone',
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }, { page: '/settings/notifications' });
  assert.equal(turnedOn.status, 200);
  const tell = async () => { pushed.length = 0; await push.notify([id], 'task_assigned', { title: 'Note on your lead: Keystone Diner LLC', body: 'x', url: '/sales/1' }); return pushed.slice(); };
  const signIns = () => db.prepare("SELECT COUNT(*) n FROM sessions WHERE json_extract(data, '$.userId') = ?").get(id).n;
  assert.deepEqual(await tell(), ['dee-phone']);
  // Switched off by something that did not end their sign-ins: the alerts stop all the same.
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
  assert.equal(signIns(), 1);
  assert.deepEqual(await tell(), []);
  db.prepare('UPDATE users SET active = 1, removed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  assert.deepEqual(await tell(), []);
  db.prepare('UPDATE users SET removed_at = NULL WHERE id = ?').run(id);
  assert.deepEqual(await tell(), ['dee-phone']);
  // Only their own sign-in counts. A registration that names somebody else's sign-in is not sent to.
  const other = await loggedIn('tech2');
  const mine = db.prepare('SELECT sid FROM push_subscriptions WHERE user_id = ?').get(id).sid;
  db.prepare('UPDATE push_subscriptions SET sid = ? WHERE user_id = ?').run(decodeURIComponent(/portal\.sid=([^;]+)/.exec(other.cookie)[1]).slice(2).split('.')[0], id);
  assert.deepEqual(await tell(), []);
  db.prepare('UPDATE push_subscriptions SET sid = ? WHERE user_id = ?').run(mine, id);
  assert.deepEqual(await tell(), ['dee-phone']);
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(id);
  push.setSender(async () => {});
});

// -- review: backups, restore and the key --
// A running copy of the site on a lab folder (see encryptionLab), and a client that talks to it.
const labSites = [];
after(() => { for (const child of labSites) if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });   // a failed check must not leave one running
async function labSite(L, settings = {}) {
  const { spawn } = require('child_process'); const net = require('net');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  let log = '';
  const child = spawn(process.execPath, ['app/server.js'], { cwd: L.root, env: L.env({ PORT: String(port), SESSION_SECRET: 'x'.repeat(40), ...settings }), stdio: ['ignore', 'pipe', 'pipe'] });
  labSites.push(child);
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const origin = `http://localhost:${port}`;
  const get = (url) => fetch(origin + url, { redirect: 'manual' }).then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
  for (let i = 0; i < 100; i++) { try { await get('/healthz'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  const stop = (signal = 'SIGTERM') => new Promise((r) => { if (child.exitCode !== null || child.signalCode) return r(child.exitCode); child.once('exit', (code) => r(code)); child.kill(signal); });
  return { origin, get, log: () => log, stop };
}
class LabClient extends Client {
  constructor(origin) { super(); this.origin = origin; }
  async req(method, url, body) {
    const res = await fetch(this.origin + url, { method, body, redirect: 'manual', headers: this.cookie ? { cookie: this.cookie } : {} });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }
}
// The last line a lab run printed, as JSON.
const labJson = (r) => { assert.ok(r.ok, r.err); return JSON.parse(r.out.trim().split('\n').pop()); };
// A lab run that stops itself dead, the way a deploy or a crash stops the site, just before its nth file operation.
const STOP_AT = (n, then) => `const fs = require('fs'); let seen = 0;
  for (const op of ['copyFileSync', 'renameSync', 'rmSync', 'writeFileSync']) { const real = fs[op]; fs[op] = (...a) => { seen += 1; if (seen === ${n}) process.kill(process.pid, 'SIGKILL'); return real(...a); }; }
  ${then}; console.log('FINISHED');`;

test('backups: a copy counts only once it has been opened and checked; a failed night leaves nothing behind, is tried again and is reported; sessions are left out', async () => {
  const backup = require('../app/backup'); const dbfile = require('../app/dbfile'); const push = require('../app/push');
  const dir = backup.backupDir; fs.mkdirSync(dir, { recursive: true }); const had = new Set(fs.readdirSync(dir));
  const owner = await loggedIn('owner'); const tech = await loggedIn('tech1');
  const page = '/admin/backups';
  const bellOf = (html) => (/<details class="bell"[\s\S]*?<\/details>/.exec(html) || [''])[0];
  const checkLine = () => require('../app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }).find((c) => /^A recent backup exists/.test(c.title));
  const pushed = []; push.setSender(async (sub, payload) => { if (/\/backup-/.test(sub.endpoint)) pushed.push({ to: sub.user_id, ...JSON.parse(payload) }); });
  // A device only gets alerts while the sign-in it belongs to is alive, so each registration is tied to one of the person's own.
  const signInOf = (username) => db.prepare("SELECT sid FROM sessions WHERE json_extract(data, '$.userId') = ? AND expires > ? ORDER BY expires DESC").get(userId(username), Date.now()).sid;
  const subscribe = (username) => db.prepare('INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at, sid) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId(username), `https://fcm.googleapis.com/fcm/send/backup-${username}`, 'k', 'a', 'Test phone', new Date().toISOString(), signInOf(username));
  await loggedIn('admin');
  subscribe('owner'); subscribe('tech1'); subscribe('admin');               // admin: runs an office, but has no backups permission
  db.prepare("DELETE FROM meta WHERE key IN ('backup_alert_day')").run();

  try {
    // A night the old way of working would have called done: an empty file under tonight's name. It is not a backup, so one is made.
    const night = new Date('2031-03-10T12:00:00Z'), next = new Date('2031-03-11T12:00:00Z');
    fs.writeFileSync(path.join(dir, 'portal-2031-03-10.db'), '');
    assert.equal(await backup.nightly(night), 'portal-2031-03-10.db');
    assert.ok(fs.statSync(path.join(dir, 'portal-2031-03-10.db')).size > 0);
    assert.equal(dbfile.inspect(path.join(dir, 'portal-2031-03-10.db'), '').fault, null);
    assert.equal(await backup.nightly(night), null);                          // a good one is there: once a night is enough
    assert.equal(backup.failing(), false);
    assert.equal(checkLine().ok, true); assert.match(checkLine().detail, /portal-2031-03-10\.db, today\. It opens with the key in use and passes its check/);

    // The copy leaves the sign-in sessions out; the site's own are untouched.
    const sid = db.prepare("SELECT sid FROM sessions WHERE json_extract(data, '$.userId') = ?").get(userId('owner')).sid;
    const live = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
    assert.ok(live > 0);
    const copy = dbfile.connect(path.join(dir, 'portal-2031-03-10.db'), '', { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n, db.prepare('SELECT COUNT(*) n FROM users').get().n);
    copy.close();
    assert.equal(fs.readFileSync(path.join(dir, 'portal-2031-03-10.db')).includes(sid), false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, live);
    assert.equal((await owner.get('/')).status, 200);                         // still signed in

    // A night that fails (here the copy cannot be written): no file is left under the night's name, and it says so.
    const inTheWay = path.join(dir, 'portal-2031-03-11.db.partial');
    fs.mkdirSync(path.join(inTheWay, 'x'), { recursive: true });
    await assert.rejects(backup.nightly(next));
    assert.equal(fs.existsSync(path.join(dir, 'portal-2031-03-11.db')), false);
    assert.equal(backup.failing(), true);
    const err = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'backup_last_error'").get().value);
    assert.equal(err.kind, 'nightly'); assert.ok(err.at && err.why);
    await assert.rejects(backup.nightly(next));                               // the next tick tries again, rather than calling it done
    await new Promise((r) => setTimeout(r, 30));
    // The people who hold backups are told once, on their phones and on the bell; nobody else is.
    assert.deepEqual(pushed.map((p) => [p.to, p.tag, p.url]), [[userId('owner'), 'backup_failed', '/admin/backups']]);
    assert.match(bellOf((await owner.get('/')).text), /href="\/admin\/backups"><span class="bell-n">1<\/span><span>backup did not work<\/span>/);
    assert.doesNotMatch(bellOf((await tech.get('/')).text), /backup/);
    assert.doesNotMatch(bellOf((await (await loggedIn('admin')).get('/')).text), /backup did not work/);
    assert.match((await owner.get(page)).text, /<strong>The last backup did not work<\/strong>/);
    const line = checkLine();
    assert.equal(line.ok, false); assert.match(line.detail, /^The last backup did not work \(.+\): .+ The site tries again every half hour\. The newest good backup is portal-2031-03-10\.db/);
    assert.match((await owner.get('/settings/notifications')).text, /value="backup_failed" checked/);
    assert.doesNotMatch((await tech.get('/settings/notifications')).text, /backup_failed/);

    // The cause goes away: the next tick makes the copy, and the warnings clear.
    fs.rmSync(inTheWay, { recursive: true, force: true });
    assert.equal(await backup.nightly(next), 'portal-2031-03-11.db');
    assert.equal(backup.failing(), false);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'backup_last_good'").get().value).name, 'portal-2031-03-11.db');
    assert.doesNotMatch(bellOf((await owner.get('/')).text), /backup did not work/);
    assert.doesNotMatch((await owner.get(page)).text, /The last backup did not work/);
    assert.equal(checkLine().ok, true);

    // A backup that does not open is shown as such, on the Backups page and on the Security check.
    fs.writeFileSync(path.join(dir, 'portal-2031-03-12.db'), require('crypto').randomBytes(8192));
    assert.match((await owner.get(page)).text, /portal-2031-03-12\.db <span class="tag overdue">Does not open with the key in use<\/span>/);
    assert.equal(checkLine().ok, false); assert.match(checkLine().detail, /The newest backup, portal-2031-03-12\.db, does not open with the key in use\. The newest that opens is portal-2031-03-11\.db/);
    assert.match((await owner.get(page)).text, /kept apart: the newest 5\./);
  } finally {
    for (const f of fs.readdirSync(dir)) if (!had.has(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    db.prepare("DELETE FROM meta WHERE key IN ('backup_last_error', 'backup_alert_day')").run();
    db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE '%/backup-%'").run();
    push.setSender(async () => {});
  }

  // Each kind of copy has its own limit, and only copies that open count towards it. A separate site, keeping 3 nightly copies.
  const L = encryptionLab();
  assert.ok(L.run(L.SEED).ok);                                                // one "Back up now" copy
  const names = () => fs.readdirSync(path.join(L.dir, 'backups')).sort();
  const day = (n) => `new Date('2031-05-${String(n).padStart(2, '0')}T12:00:00Z')`;
  const NIGHTS = (list) => `const b = require('./app/backup'); (async () => { for (const d of [${list.map(day).join(', ')}]) await b.runBackup({ now: d }); console.log(JSON.stringify(b.listBackups().map((x) => x.name))); })();`;
  assert.ok(L.run(NIGHTS([1, 2, 3]), { BACKUP_KEEP: '3' }).ok);
  // Three failed nights the old way (empty files), one file of rubbish, then a good night.
  for (const n of [4, 5, 6]) fs.writeFileSync(path.join(L.dir, 'backups', `portal-2031-05-0${n}.db`), '');
  fs.writeFileSync(path.join(L.dir, 'backups', 'portal-2031-05-07.db'), require('crypto').randomBytes(4096));
  fs.writeFileSync(path.join(L.dir, 'backups', 'portal-2031-05-08.db.partial'), 'half a copy'); fs.writeFileSync(path.join(L.dir, 'backups', 'portal-2031-05-08.db.partial-journal'), 'x');
  assert.equal(L.state({ BACKUP_KEEP: '3' }).users, 1);                       // a start of the site clears the unfinished copy and the empty files
  assert.doesNotMatch(names().join(' '), /partial|portal-2031-05-0[456]\.db/);
  assert.ok(L.run(NIGHTS([8]), { BACKUP_KEEP: '3' }).ok);
  const real = names().filter((n) => /^portal-2031-05-\d\d\.db$/.test(n) && dbfile.inspect(path.join(L.dir, 'backups', n), '').fault === null);
  assert.deepEqual(real, ['portal-2031-05-02.db', 'portal-2031-05-03.db', 'portal-2031-05-08.db']);   // the newest three good ones; the empty files pushed nothing out
  assert.equal(names().includes('portal-2031-05-01.db'), false); assert.ok(names().includes('portal-2031-05-07.db'));   // the oldest good one made way; the rubbish is left for a person to see
  // Seven presses of "Back up now": the newest five of those are kept, and the nightly copies are all still there.
  assert.ok(L.run(`const b = require('./app/backup'); (async () => { for (let i = 1; i <= 7; i++) await b.runBackup({ manual: true, now: new Date(Date.UTC(2031, 4, 9, 10, 0, i)) }); })();`, { BACKUP_KEEP: '3' }).ok);
  assert.equal(names().filter((n) => /-\d{6}\.db$/.test(n)).length, 5);
  assert.deepEqual(names().filter((n) => /^portal-2031-05-\d\d\.db$/.test(n) && n !== 'portal-2031-05-07.db'), real);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('backups: after a key is set or changed each stored copy is converted as a copy and swapped in, so a start that is cut short cannot leave a damaged backup', async () => {
  const dbfile = require('../app/dbfile');
  const KEY = 'convert-key-0123456789-abcdefgh', KEY2 = 'convert-key-two-0123456789-abcd';
  const L = encryptionLab();
  assert.ok(L.run(L.SEED).ok);
  assert.ok(L.run(`require('./app/backup').runBackup({ now: new Date('2031-06-01T12:00:00Z') })`).ok);
  assert.equal(L.backups().length, 2);
  const made = Object.fromEntries(L.backups().map((b) => [b, fs.statSync(b).mtimeMs]));
  const opens = (f, k) => dbfile.isPlain(f) === !k && dbfile.inspect(f, k, { full: true }).fault === null;
  // Bringing the stored copies into line with the key, as a start does, but stopped dead before the nth file operation.
  const ALIGN = `const d = require('./app/dbfile'); const dir = process.env.DATA_DIR + '/backups';
    console.log(JSON.stringify(d.alignCopies(fs.readdirSync(dir).filter((f) => d.BACKUP.test(f)).map((f) => dir + '/' + f), { encrypted: true, usingOldKey: false })))`;

  // The first start with a key. Whatever the moment it stops, every backup is either still the ordinary file it was or
  // already a whole encrypted one: never something that opens with neither.
  let working = 0;
  for (let n = 5; n <= 9; n++) {
    if (/FINISHED/.test(L.run(STOP_AT(n, ALIGN), { DB_KEY: KEY }).out)) break;
    for (const b of L.backups()) assert.ok(opens(b, '') || opens(b, KEY), `after a stop at step ${n}, ${path.basename(b)} opens with neither`);
    // The rewriting is done to a working copy beside the backup; the backup itself is only ever swapped whole.
    if (fs.readdirSync(path.join(L.dir, 'backups')).some((f) => f.endsWith('.db.converting'))) working += 1;
  }
  assert.ok(working >= 2);
  // The start that is allowed to finish: both under the key, nothing left lying about, and each still dated the night it was made.
  const s = L.state({ DB_KEY: KEY });
  assert.equal(s.e.encrypted, true); assert.equal(s.aligned.plain + s.aligned.foreign, 0);
  for (const b of L.backups()) { assert.ok(opens(b, KEY), path.basename(b)); assert.ok(Math.abs(fs.statSync(b).mtimeMs - made[b]) < 2); }
  assert.deepEqual(fs.readdirSync(path.join(L.dir, 'backups')).filter((f) => !/^portal-[0-9-]+\.db$/.test(f)), []);

  // A copy that the key does not open is reported as that, not counted as encrypted.
  fs.writeFileSync(path.join(L.dir, 'backups', 'portal-2031-06-03.db'), require('crypto').randomBytes(8192));
  const CHECK = `require('./app/app'); const list = require('./app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }); console.log(JSON.stringify(list.find((c) => c.title === 'The database is encrypted')));`;
  const item = labJson(L.run(CHECK, { DB_KEY: KEY }));
  assert.equal(item.ok, false); assert.match(item.detail, /2 of 3 backups are encrypted\. 1 does not open with the key in use\./);
  fs.rmSync(path.join(L.dir, 'backups', 'portal-2031-06-03.db'));

  // A key change is carried out the same way: each copy opens with the old key or the new one at every moment.
  assert.doesNotMatch(L.run(STOP_AT(6, ALIGN), { DB_KEY: KEY2, DB_KEY_OLD: KEY }).out, /FINISHED/);   // the working copy is under the new key; the backup has not been swapped yet
  assert.ok(fs.readdirSync(path.join(L.dir, 'backups')).some((f) => f.endsWith('.db.converting')));
  for (const b of L.backups()) assert.ok(opens(b, KEY), path.basename(b));
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('restore: RESTORE_BACKUP brings a backup back at start-up, sets the database from before aside whole, does it once, and refuses without touching anything when it cannot', async () => {
  const dbfile = require('../app/dbfile');
  const L = encryptionLab();
  assert.ok(L.run(L.SEED).ok);
  const B = path.basename(L.backups()[0]);
  // Work entered after the backup, which sits only in the file SQLite keeps beside the database: the site is stopped dead, as a deploy stops it.
  L.run(`const db = require('./app/db'); db.prepare("INSERT INTO meta (key, value) VALUES ('era', 'after the backup')").run(); process.kill(process.pid, 'SIGKILL');`);
  assert.ok(fs.statSync(L.file + '-wal').size > 0);
  const before = { db: L.sha(L.file), wal: L.sha(L.file + '-wal') };
  const STATE = `const db = require('./app/db'); const get = (k) => (db.prepare('SELECT value v FROM meta WHERE key = ?').get(k) || {}).v || null;
    console.log(JSON.stringify({ restored: db.encryption.restored, era: get('era'), later: get('later'), marker: get('marker'), users: db.prepare('SELECT COUNT(*) n FROM users').get().n, integrity: db.pragma('integrity_check', { simple: true }) }));`;
  const QUICK = `const { db, status } = require('./app/dbfile').open(process.env.DATA_DIR); const get = (k) => (db.prepare('SELECT value v FROM meta WHERE key = ?').get(k) || {}).v || null;
    console.log(JSON.stringify({ restored: status.restored, era: get('era'), later: get('later'), marker: get('marker'), users: db.prepare('SELECT COUNT(*) n FROM users').get().n, integrity: db.pragma('integrity_check', { simple: true }) })); db.close();`;
  const asides = (dir = L.dir) => fs.readdirSync(dir).filter((f) => /^portal-before-restore-[0-9-]+\.db$/.test(f));
  const listing = () => fs.readdirSync(L.dir).sort().join(' ');
  // Is the database from before the restore still whole somewhere: where it was, or set aside under its dated name?
  const kept = (dir) => {
    const whole = (db, wal) => fs.existsSync(db) && L.sha(db) === before.db && fs.existsSync(wal) && L.sha(wal) === before.wal;
    const here = path.join(dir, 'portal.db');
    return whole(here, here + '-wal') || asides(dir).some((a) => whole(path.join(dir, a), (fs.existsSync(path.join(dir, a) + '-wal') ? path.join(dir, a) : here) + '-wal'));
  };

  // What cannot be done is refused, with the reason, and nothing on the disk changes.
  const garbage = path.join(L.dir, 'backups', 'portal-2031-01-01.db'), empty = path.join(L.dir, 'backups', 'portal-2031-01-02.db');
  fs.writeFileSync(garbage, Buffer.concat([fs.readFileSync(L.backups()[0]).subarray(0, 4096), require('crypto').randomBytes(8192)])); fs.writeFileSync(empty, '');
  const was = listing();
  for (const [name, says] of [['../portal.db', /is not the name of one of the site's backups/], ['portal-1999-01-01.db', /there is no backup named portal-1999-01-01\.db/],
    [path.basename(empty), /is empty/], [path.basename(garbage), /is damaged/]]) {
    const r = L.run(QUICK, { RESTORE_BACKUP: name });
    assert.equal(r.ok, false, name); assert.match(r.err, /The site was asked to bring back a backup \(RESTORE_BACKUP in the hosting settings\) and could not/); assert.match(r.err, says); assert.match(r.err, /Nothing has been changed/);
    assert.equal(listing(), was); assert.equal(L.sha(L.file), before.db); assert.equal(L.sha(L.file + '-wal'), before.wal);
  }
  fs.rmSync(garbage); fs.rmSync(empty);

  // Stopped dead before each file operation of the restore in turn: the database from before is never lost, and the next start finishes the job, once.
  // (Each try has a copy of the folder to itself, so they can all run side by side.)
  const copyOf = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-restore-')); fs.cpSync(L.dir, dir, { recursive: true }); return dir; };
  const { execFile, spawn } = require('child_process');
  const runIn = (dir, code) => new Promise((resolve) => execFile(process.execPath, ['-e', code], { cwd: L.root, env: L.env({ DATA_DIR: dir, RESTORE_BACKUP: B }), encoding: 'utf8' }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || '') })));
  const tries = await Promise.all(Array.from({ length: 18 }, async (unused, i) => {
    const n = i + 1; const dir = copyOf();
    const finished = /FINISHED/.test((await runIn(dir, STOP_AT(n, "require('./app/dbfile').open(process.env.DATA_DIR)"))).out);
    if (!finished) assert.ok(kept(dir), `after a stop at step ${n} the database from before is gone: ${fs.readdirSync(dir).join(' ')}`);
    const s = labJson(await runIn(dir, QUICK));
    assert.deepEqual([s.era, s.marker, s.users, s.integrity], [null, 'kept', 1, 'ok'], `step ${n}`);
    assert.ok(kept(dir), `step ${n}`); assert.equal(asides(dir).length, 1, `step ${n}`);
    assert.doesNotMatch(fs.readdirSync(dir).join(' '), /restore-plan|restoring/);
    fs.rmSync(dir, { recursive: true, force: true });
    return finished;
  }));
  assert.ok(tries.filter((finished) => !finished).length >= 8, 'too few stops were tried');
  assert.equal(tries[tries.length - 1], true);                                // the last tries ran to the end: every step before that was covered
  // ...and stopped at moments nobody chose.
  await Promise.all([0, 1, 2].map(async () => {
    const dir = copyOf();
    const child = spawn(process.execPath, ['-e', "require('./app/db')"], { cwd: L.root, env: L.env({ DATA_DIR: dir, RESTORE_BACKUP: B }), stdio: 'ignore' });
    await new Promise((done) => { setTimeout(() => child.kill('SIGKILL'), 30 + Math.random() * 150); child.once('exit', done); });
    assert.ok(kept(dir), `after a stop at a random moment the database from before is gone: ${fs.readdirSync(dir).join(' ')}`);
    assert.deepEqual([labJson(L.run(QUICK, { DATA_DIR: dir, RESTORE_BACKUP: B })).era, asides(dir).length, kept(dir)], [null, 1, true]);
    fs.rmSync(dir, { recursive: true, force: true });
  }));

  // The restore itself. The site is as the backup had it; the newer work is not merged in, and not thrown away either.
  let s = labJson(L.run(STATE, { RESTORE_BACKUP: B }));
  assert.deepEqual([s.restored.backup, s.restored.again, s.era, s.marker, s.users, s.integrity], [B, false, null, 'kept', 1, 'ok']);
  assert.equal(asides().length, 1); assert.equal(s.restored.aside, asides()[0]);
  // The file SQLite kept beside the old database went with it, so it can no longer be replayed onto the restored one...
  const aside = path.join(L.dir, asides()[0]);
  assert.equal(L.sha(aside), before.db); assert.equal(L.sha(aside + '-wal'), before.wal);
  // ...and the database that was set aside still opens, with the newer work in it.
  const old = dbfile.connect(aside, '', { readonly: true });
  assert.equal(old.prepare("SELECT value v FROM meta WHERE key = 'era'").get().v, 'after the backup'); old.close();

  // The setting is still there at the next start: nothing is restored a second time, so work done since stays.
  assert.ok(L.run(`require('./app/db').prepare("INSERT INTO meta (key, value) VALUES ('later', 'entered after the restore')").run()`, { RESTORE_BACKUP: B }).ok);
  s = labJson(L.run(QUICK, { RESTORE_BACKUP: B }));
  assert.deepEqual([s.restored.again, s.later, asides().length], [true, 'entered after the restore', 1]);
  const CHECK = `require('./app/app'); const list = require('./app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }); console.log(JSON.stringify(list.find((c) => /restore setting/.test(c.title)) || null));`;
  const item = labJson(L.run(CHECK, { RESTORE_BACKUP: B }));
  assert.equal(item.ok, false); assert.match(item.detail, new RegExp(`restored from ${B.replace(/\./g, '\\.')} on \\d+/\\d+/\\d{4}`)); assert.match(item.fix, /delete RESTORE_BACKUP/);
  // Something else opening the database without the setting (a script, a shell) changes nothing: the backup is still not restored twice.
  assert.equal(labJson(L.run(CHECK)), null);                                    // and with the setting gone there is no reminder
  s = labJson(L.run(QUICK, { RESTORE_BACKUP: B }));
  assert.deepEqual([s.restored.again, s.later, asides().length], [true, 'entered after the restore', 1]);
  // Once the site itself has started without the setting, setting it again later is a new request.
  const between = await labSite(L); assert.equal((await between.get('/login')).status, 200); await between.stop();
  s = labJson(L.run(QUICK, { RESTORE_BACKUP: B }));
  assert.deepEqual([s.restored.again, s.later, asides().length], [false, null, 2]);

  // A running site: the log says what was done, everyone is signed out, and the activity log has a line.
  let site = await labSite(L, { RESTORE_BACKUP: B });
  assert.match(site.log(), /RESTORE_BACKUP is still set\. .* was restored on an earlier start, so nothing was done this time/);
  await site.stop();
  site = await labSite(L); await site.stop();                                   // the setting is taken out, as the Security check asks
  // A backup from before sessions were left out of them still signs nobody in when it is brought back.
  const olden = dbfile.connect(L.backups()[0], ''); olden.prepare("INSERT INTO sessions (sid, expires, data) VALUES ('from-the-backup', ?, '{}')").run(Date.now() + 600000);
  olden.prepare("INSERT INTO meta (key, value) VALUES ('key_copy_checked', '2031-01-01')").run(); olden.close();   // ...and its word that the saved key was checked is about the key of its day
  site = await labSite(L, { RESTORE_BACKUP: B });
  assert.equal((await site.get('/login')).status, 200);
  assert.match(site.log(), new RegExp(`\\[restore\\] The database was restored from ${B.replace(/\./g, '\\.')}\\. The database from before is set aside on the disk as portal-before-restore-[0-9-]+\\.db\\. RESTORE_BACKUP can now be removed`));
  await site.stop();
  const after = labJson(L.run(`const db = require('./app/db'); console.log(JSON.stringify({ sessions: db.prepare("SELECT COUNT(*) n FROM sessions WHERE sid = 'from-the-backup'").get().n, log: db.prepare("SELECT detail FROM activity_log WHERE action = 'Backup restored'").get(),
    checked: db.prepare("SELECT COUNT(*) n FROM meta WHERE key = 'key_copy_checked'").get().n }))`, { RESTORE_BACKUP: B }));
  assert.equal(after.sessions, 0); assert.match(after.log.detail, new RegExp('^' + B.replace(/\./g, '\\.'))); assert.equal(after.checked, 0);

  // With encryption: the backup must open with the key in the settings, and a backup from before a key change is brought back and moved to the new key.
  const E = encryptionLab(); const KEY = 'restore-key-0123456789-abcdefgh', KEY2 = 'restore-key-two-0123456789-abcd';
  assert.ok(E.run(E.SEED, { DB_KEY: KEY }).ok);
  const EB = path.basename(E.backups()[0]);
  const wrong = E.run(QUICK, { DB_KEY: KEY, RESTORE_BACKUP: EB.replace(/\d{6}\.db$/, '000000.db') });
  assert.equal(wrong.ok, false); assert.match(wrong.err, /there is no backup named/);
  fs.copyFileSync(E.backups()[0], path.join(E.dir, 'kept-elsewhere.db'));      // a copy taken off the server while the first key was in use
  assert.equal(E.state({ DB_KEY: KEY2, DB_KEY_OLD: KEY }).e.changed, 'rekeyed');
  fs.copyFileSync(path.join(E.dir, 'kept-elsewhere.db'), path.join(E.dir, 'backups', 'portal-2031-02-02.db'));
  const locked = E.run(QUICK, { DB_KEY: KEY2, RESTORE_BACKUP: 'portal-2031-02-02.db' });
  assert.equal(locked.ok, false); assert.match(locked.err, /does not open with the key in the hosting settings \(DB_KEY\)/); assert.doesNotMatch(locked.err + locked.out, /restore-key/);
  s = labJson(E.run(QUICK, { DB_KEY: KEY2, DB_KEY_OLD: KEY, RESTORE_BACKUP: 'portal-2031-02-02.db' }));
  assert.deepEqual([s.restored.backup, s.marker, s.users, s.integrity], ['portal-2031-02-02.db', 'kept', 1, 'ok']);
  assert.ok(dbfile.readable(E.file, KEY2)); assert.equal(dbfile.readable(E.file, KEY), false);
  for (const lab of [L, E]) fs.rmSync(lab.dir, { recursive: true, force: true });
});

test('stopping: the site closes its database when it is told to stop, so the one file holds everything', async () => {
  const dbfile = require('../app/dbfile');
  const L = encryptionLab();
  assert.ok(L.run(L.SEED).ok);
  const site = await labSite(L);
  assert.equal((await site.get('/login')).status, 200);                         // a visit writes to the database
  assert.ok(fs.existsSync(L.file + '-wal'));
  // An open, idle connection (a browser tab left on the site) must not hold the stop up.
  const idle = require('net').connect(Number(new URL(site.origin).port), 'localhost'); idle.on('error', () => {});
  idle.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await new Promise((r) => setTimeout(r, 100));
  const began = Date.now();
  assert.equal(await site.stop('SIGTERM'), 0);                                  // a clean exit, not one the host had to force
  assert.ok(Date.now() - began < 5000);
  idle.destroy();
  // Nothing is left beside the database: a copy of portal.db alone is the whole of it.
  assert.deepEqual(fs.readdirSync(L.dir).filter((f) => /^portal\.db./.test(f)), []);
  const alone = path.join(L.dir, 'copied-by-hand.db'); fs.copyFileSync(L.file, alone);
  const copy = dbfile.connect(alone, '', { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM users').get().n, 1); assert.ok(copy.prepare('SELECT COUNT(*) n FROM sessions').get().n >= 1);
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok'); copy.close();
  assert.doesNotMatch(site.log(), /did not close cleanly/);
  // The closed page stops when asked as well.
  fs.writeFileSync(L.file, require('crypto').randomBytes(8192));
  const closed = await labSite(L);
  assert.equal((await closed.get('/')).status, 503);
  assert.equal(await closed.stop('SIGTERM'), 0);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('closed page: a damaged or missing database is called that, with the backup to go back to; a new site still starts by itself', async () => {
  const dbfile = require('../app/dbfile');
  const KEY = 'closed-page-key-0123456789-abcd';
  const damage = (file, at) => { const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, require('crypto').randomBytes(100), 0, 100, at); fs.closeSync(fd); };
  const settle = (L, settings) => assert.ok(L.run("const db = require('./app/db'); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();", settings).ok);

  // Encrypted, the key in the settings is right, and the first page of the file is damaged.
  const L = encryptionLab();
  assert.ok(L.run(L.SEED, { DB_KEY: KEY }).ok); settle(L, { DB_KEY: KEY });
  const B = path.basename(L.backups()[0]);
  damage(L.file, 1000);
  let site = await labSite(L, { DB_KEY: KEY });
  let page = await site.get('/');
  assert.equal(page.status, 503); assert.match(page.text, /PB Portal is closed for the moment/);
  assert.match(page.text, /The database file is damaged\. The key is not the problem\./);
  assert.match(page.text, new RegExp(`The newest backup that opens is ${B.replace(/\./g, '\\.')}\\. To go back to it, open the hosting settings \\(Render, then the service, then Environment\\), add a setting named RESTORE_BACKUP with the value ${B.replace(/\./g, '\\.')} and save`));
  assert.match(page.text, /Anything entered after that backup was made will not be in it/);
  assert.doesNotMatch(page.text, /Nothing has been lost|different key|put the right value back/);
  assert.equal((await site.get('/healthz')).status, 200);
  assert.match(site.log(), /showing a "closed" page/); assert.doesNotMatch(site.log() + page.text, /closed-page-key/);
  await site.stop();
  // A key that really is wrong still gets the page about the key, and opens neither the file nor the backup.
  site = await labSite(L, { DB_KEY: 'not-the-right-key-not-at-all-99' });
  page = await site.get('/');
  assert.match(page.text, /different key from the one in the hosting settings/); assert.match(page.text, /Nothing has been lost/); assert.doesNotMatch(page.text, /damaged/);
  await site.stop();
  // Following the page: the backup comes back, the damaged file is set aside, and the site opens.
  site = await labSite(L, { DB_KEY: KEY, RESTORE_BACKUP: B });
  assert.equal((await site.get('/login')).status, 200);
  await site.stop();
  assert.equal(L.state({ DB_KEY: KEY, RESTORE_BACKUP: B }).sign, true);
  assert.equal(fs.readdirSync(L.dir).filter((f) => /^portal-before-restore-[0-9-]+\.db$/.test(f)).length, 1);

  // Not encrypted, and the first bytes are damaged: there never was a key, and the page does not ask for one.
  const P = encryptionLab();
  assert.ok(P.run(P.SEED).ok); settle(P, {});
  const PB = path.basename(P.backups()[0]);
  damage(P.file, 4);
  site = await labSite(P);
  page = await site.get('/');
  assert.equal(page.status, 503); assert.match(page.text, /The database file is damaged/); assert.match(page.text, new RegExp(`RESTORE_BACKUP with the value ${PB.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(page.text, /DB_KEY|Nothing has been lost/);
  await site.stop();
  // Damage further in, which only shows once the site reads that part: the same page, not a start that fails over and over.
  fs.copyFileSync(P.backups()[0], P.file);
  const size = fs.statSync(P.file).size; const fd = fs.openSync(P.file, 'r+'); fs.writeSync(fd, Buffer.alloc(size - 4096, 7), 0, size - 4096, 4096); fs.closeSync(fd);
  site = await labSite(P);
  page = await site.get('/');
  assert.equal(page.status, 503); assert.match(page.text, /The database file is damaged/);
  await site.stop();

  // The database file is gone (or empty) while backups of the site are on the disk: no quiet start as an empty site.
  for (const state of ['missing', 'empty']) {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(P.file + ext, { force: true });
    if (state === 'empty') fs.writeFileSync(P.file, '');
    site = await labSite(P, { BOOTSTRAP_ADMIN_USERNAME: 'newboss', BOOTSTRAP_ADMIN_PASSWORD: 'a password for the first start' });
    page = await site.get('/login');
    assert.equal(page.status, 503); assert.match(page.text, new RegExp(`The database file is ${state}, but a backup of this site is on the disk\\.`));
    assert.match(page.text, new RegExp(`The newest backup that opens is ${PB.replace(/\./g, '\\.')}\\. To bring it back, .* add a setting named RESTORE_BACKUP with the value ${PB.replace(/\./g, '\\.')} and save\\. If this is meant to be a new, empty site instead, add a setting named NEW_SITE with the value yes\\.`));
    assert.doesNotMatch(page.text, /Nothing has been lost/); assert.doesNotMatch(site.log(), /Created the master account/);
    await site.stop();
    assert.equal(fs.existsSync(P.file) && fs.statSync(P.file).size > 0, false);  // and nothing was created in its place
  }
  // NEW_SITE=yes says an empty site is meant. The Security check then asks for the setting to be taken out again.
  site = await labSite(P, { NEW_SITE: 'yes', BOOTSTRAP_ADMIN_USERNAME: 'newboss', BOOTSTRAP_ADMIN_PASSWORD: 'a password for the first start' });
  assert.equal((await site.get('/login')).status, 200); assert.match(site.log(), /Created the master account "newboss"/);
  await site.stop();
  const CHECK = `require('./app/app'); const list = require('./app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }); console.log(JSON.stringify(list.filter((c) => /new-site/.test(c.title))));`;
  assert.match(labJson(P.run(CHECK, { NEW_SITE: 'yes' }))[0].fix, /delete NEW_SITE/);
  assert.deepEqual(labJson(P.run(CHECK)), []);
  // A site that has never run (no backups) starts by itself, exactly as before.
  const N = encryptionLab();
  site = await labSite(N);
  assert.equal((await site.get('/login')).status, 200); assert.match(site.log(), /No users yet/);
  await site.stop();
  assert.ok(dbfile.isPlain(N.file));
  for (const lab of [L, P, N]) fs.rmSync(lab.dir, { recursive: true, force: true });
});

test('updates: the first start of a new version keeps a checked copy of the database as the last version left it, and only the newest two', async () => {
  const dbfile = require('../app/dbfile');
  const L = encryptionLab();
  assert.ok(L.run(L.SEED).ok);
  const before = () => L.backups().filter((b) => /-before-update\.db$/.test(b));
  const version = (v) => labJson(L.run(`const db = require('./app/db'); console.log(JSON.stringify({ v: (db.prepare("SELECT value FROM meta WHERE key = 'code_version'").get() || {}).value || null, list: require('./app/backup').listBackups().map((b) => b.kind) }))`, v ? { RENDER_GIT_COMMIT: v } : {}));
  assert.equal(version(null).v, null); assert.equal(before().length, 0);        // the host gives no version: nothing happens
  assert.equal(version('aaa1111').v, 'aaa1111'); assert.equal(before().length, 1);
  assert.equal(dbfile.inspect(before()[0], '', { full: true }).fault, null);
  assert.equal(version('aaa1111').list.filter((k) => k === 'update').length, 1); // the same version again: no second copy
  // Two more versions. (The copies are named to the second; these are given names of their own so the test need not wait for the clock.)
  const rename = (n) => { const to = before()[0].replace(/-\d{6}-before/, `-00000${n}-before`); fs.renameSync(before().find((b) => !/-00000\d-before/.test(b)), to); return to; };
  const one = rename(1);
  version('bbb2222'); assert.equal(before().length, 2); rename(2);
  version('ccc3333'); assert.equal(before().length, 2); assert.equal(before().includes(one), false);   // the newest two are kept
  assert.equal(L.backups().filter((b) => /-\d{6}\.db$/.test(b)).length, 1);     // the "Back up now" copy is not theirs to push out
  // The copy is taken before the new version changes anything. A database from the first release still has its old shape in the copy.
  const O = encryptionLab(); const Database = require('better-sqlite3-multiple-ciphers');
  const old = new Database(O.file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, email TEXT,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', can_review_complaints INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('boss', 'First Admin', 'x', 'admin', '2026-01-02');`);
  old.close();
  assert.ok(O.run("require('./app/db')", { RENDER_GIT_COMMIT: 'ddd4444' }).ok);
  const kept = O.backups().filter((b) => /-before-update\.db$/.test(b));
  assert.equal(kept.length, 1);
  const copy = dbfile.connect(kept[0], '', { readonly: true });
  const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  assert.deepEqual(tables, ['users']); assert.equal(copy.prepare('SELECT username FROM users').get().username, 'boss'); copy.close();
  // A site with nobody in it yet has nothing to keep; the version is still remembered.
  const N = encryptionLab();
  assert.ok(N.run("require('./app/db')", { RENDER_GIT_COMMIT: 'eee5555' }).ok);
  assert.equal(N.backups().length, 0);
  assert.equal(labJson(N.run(`console.log(JSON.stringify((require('./app/db').prepare("SELECT value FROM meta WHERE key = 'code_version'").get() || {}).value))`, { RENDER_GIT_COMMIT: 'eee5555' })), 'eee5555');
  for (const lab of [L, O, N]) fs.rmSync(lab.dir, { recursive: true, force: true });
});

test('the photo archive: the download is in the activity log, tar is told nothing of the site\'s settings, and a failed tar does not pass for a whole archive', async () => {
  const owner = await loggedIn('owner');
  assert.equal((await owner.post('/account/confirm', { password: 'correct horse battery', next: '/admin/backups' }, { page: '/admin/backups' })).status, 302);
  const url = '/admin/backups/photos.tar.gz';
  const logged = () => db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action = 'Photo archive downloaded' AND user_id = ?").get(userId('owner')).n;
  const was = logged();
  const res = await fetch(base + url, { headers: { cookie: owner.cookie } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/gzip');
  const whole = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([whole[0], whole[1]], [0x1f, 0x8b]);                          // a gzip file, complete
  assert.ok(require('zlib').gunzipSync(whole).length > 0);
  assert.equal(logged(), was + 1);
  assert.match(db.prepare("SELECT detail FROM activity_log WHERE action = 'Photo archive downloaded' ORDER BY id DESC").get().detail, /^\d+ files?$/);
  assert.equal((await (await loggedIn('tech1')).get(url)).status, 403);
  assert.equal(logged(), was + 1);

  // A stand-in for tar that notes what it was given, writes a little and fails.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-tar-'));
  fs.writeFileSync(path.join(fake, 'tar'), `#!/bin/sh\nenv > "${fake}/given.txt"\nprintf 'half an archive'\nexit 2\n`, { mode: 0o755 });
  const realPath = process.env.PATH; process.env.PATH = `${fake}:${realPath}`; process.env.SMTP_PASS = 'a-secret-that-must-not-travel';
  try {
    const cut = await fetch(base + url, { headers: { cookie: owner.cookie } });
    await assert.rejects(cut.arrayBuffer());                                     // the download breaks off instead of ending as if complete
    const given = fs.readFileSync(path.join(fake, 'given.txt'), 'utf8');
    assert.match(given, /^PATH=/m);
    assert.doesNotMatch(given, /DATA_DIR|SMTP_PASS|a-secret-that-must-not-travel|NOTIFY_TO|BASE_URL/);
  } finally { process.env.PATH = realPath; delete process.env.SMTP_PASS; fs.rmSync(fake, { recursive: true, force: true }); }
});

test('Security check: the saved copy of the key can be checked, yes or no; room on the disk is shown; switching encryption off says how many files still need the key', async () => {
  const security = require('../app/routes/security');
  // Room on the disk: enough means three times the database and at least 15% of the disk.
  const GB = 1024 ** 3, MB = 1024 ** 2;
  assert.equal(security.roomy({ free: 800 * MB, total: GB, database: 7 * MB }), true);
  assert.equal(security.roomy({ free: 100 * MB, total: GB, database: 7 * MB }), false);     // under 15% of the disk
  assert.equal(security.roomy({ free: 170 * MB, total: GB, database: 60 * MB }), false);    // under three times the database
  const owner = await loggedIn('owner');
  const mine = (await owner.get('/admin/security')).text;
  assert.match(mine, /<strong>The disk has room to spare<\/strong><\/div>\s*<p class="plain">[\d.]+ (MB|GB) free of [\d.]+ (MB|GB)\. The database is \d+ MB\.<\/p>/);
  assert.match(mine, /<strong>A recent backup exists and opens<\/strong>/);
  assert.doesNotMatch(mine, /saved copy of the key|check-key|restore setting|new-site setting/);   // this test site has no key: nothing to check, nothing extra shown
  // Without a key there is nothing to compare with, and the box needs a password typed in the last few minutes.
  assert.equal((await (await loggedIn('tech1')).post('/admin/security/check-key', { key: 'anything' }, { page: '/' })).status, 403);
  await owner.post('/admin/security/check-key', { key: 'anything-at-all-0123456789' }, { page: '/admin/security' });
  assert.match((await owner.get('/admin/security')).text, /The database is not encrypted, so there is no key to check/);
  db.prepare("UPDATE sessions SET data = json_remove(data, '$.pwAt') WHERE json_extract(data, '$.userId') = ?").run(userId('owner'));
  await owner.post('/admin/security/check-key', { key: 'anything-at-all-0123456789' }, { page: '/admin/security' });
  assert.match((await owner.get('/admin/security')).text, /Type your password first/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM meta WHERE key = 'key_copy_checked'").get().n, 0);

  // An encrypted site, running.
  const KEY = 'saved-copy-key-0123456789-abcdefg', WRONG = 'saved-copy-key-0123456789-abcdefX';
  const L = encryptionLab();
  assert.ok(L.run(L.SEED, { DB_KEY: KEY }).ok);
  assert.ok(L.run(`const auth = require('./app/auth'); const db = require('./app/db');
    auth.createUser({ username: 'lab.boss', displayName: 'Lab Boss', password: 'correct horse battery', profile: 'Admin', master: true });
    db.prepare('UPDATE users SET must_change_password = 0').run();`, { DB_KEY: KEY }).ok);
  const site = await labSite(L, { DB_KEY: KEY });
  const boss = new LabClient(site.origin); await boss.login('lab.boss', 'correct horse battery');
  const page = '/admin/security';
  const card = (html) => (/<li class="card[^"]*">\s*<div class="rec-head">[^\n]*The saved copy of the key has been checked[\s\S]*?<\/li>/.exec(html) || [''])[0];
  let html = (await boss.get(page)).text;
  assert.match(card(html), /Needs attention/); assert.match(card(html), /Never checked\./);
  assert.match(card(html), /<form method="post" action="\/admin\/security\/check-key"[^>]*autocomplete="off">/); assert.match(card(html), /<input name="key" type="text" autocomplete="off"/);
  // A copy with one character wrong: no. Nothing is recorded as checked.
  assert.equal((await boss.post(`${page}/check-key`, { key: WRONG }, { page })).location, '/admin/security');   // back at the top of the page, where the answer is shown
  html = (await boss.get(page)).text;
  assert.match(html, /No\. That is not the key the site is using\./); assert.match(card(html), /Never checked\./);
  // The right one, with the stray spaces a paste brings: yes, and the day is remembered.
  await boss.post(`${page}/check-key`, { key: `  ${KEY}\n` }, { page });
  html = (await boss.get(page)).text;
  assert.match(html, /Yes\. That is the key the site is using\./);
  assert.match(card(html), /class="tag return">OK/); assert.match(card(html), /Last checked on \d+\/\d+\/\d{4}\./);
  // Five tries in a quarter of an hour, then no more, right or wrong.
  for (let i = 0; i < 3; i++) await boss.post(`${page}/check-key`, { key: WRONG }, { page });
  await boss.post(`${page}/check-key`, { key: KEY }, { page });
  assert.match((await boss.get(page)).text, /Too many tries\. Wait 15 minutes and try again\./);
  // Someone who cannot see this page cannot use the box.
  const tech = new LabClient(site.origin); await tech.login('enc.one', 'correct horse battery');
  assert.equal((await tech.post(`${page}/check-key`, { key: KEY }, { page: '/' })).status, 403);
  await site.stop();
  // Neither the key nor what was pasted is in the log, on a page, or anywhere in the database. Only the day of the last match is kept.
  assert.doesNotMatch(site.log() + html, /saved-copy-key/);
  const kept = L.run(`const db = require('./app/db'); const out = {};
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) out[t.name] = db.prepare('SELECT * FROM "' + t.name + '"').all();
    console.log(JSON.stringify(out));`, { DB_KEY: KEY });
  assert.ok(kept.ok); assert.doesNotMatch(kept.out, /saved-copy-key/);
  const all = JSON.parse(kept.out.trim().split('\n').pop());
  assert.match(all.meta.find((m) => m.key === 'key_copy_checked').value, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(all.activity_log.filter((a) => a.action === 'Saved key checked').map((a) => a.detail), ['It did not match the key in use', 'It matched the key in use', 'It did not match the key in use', 'It did not match the key in use', 'It did not match the key in use']);
  // Checked more than six months ago: time to do it again.
  const CHECK = `const db = require('./app/db'); require('./app/app'); if (process.env.SET_DAY) db.prepare("UPDATE meta SET value = ? WHERE key = 'key_copy_checked'").run(process.env.SET_DAY);
    const list = require('./app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }); console.log(JSON.stringify(list.filter((c) => /saved copy|is encrypted/.test(c.title))));`;
  const longAgo = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  const stale = labJson(L.run(CHECK, { DB_KEY: KEY, SET_DAY: longAgo })).find((c) => /saved copy/.test(c.title));
  assert.equal(stale.ok, false); assert.match(stale.detail, /^Last checked on \d+\/\d+\/\d{4}\.$/); assert.match(stale.fix, /paste it into the box below/);

  // A key change, and then encryption switched off. The log says what the page says: leave the key where it is until the files have followed.
  const KEY2 = 'saved-copy-two-0123456789-abcdef';
  let lab = await labSite(L, { DB_KEY: KEY2, DB_KEY_OLD: KEY });
  assert.match(lab.log(), /The database now uses the new key\. Photos and documents are still moving to it: leave DB_KEY_OLD in the hosting settings until the Security check says it can be deleted\. Keep the key that was replaced on record/);
  assert.doesNotMatch(lab.log(), /DB_KEY_OLD can be removed/);
  // The Backups page keeps the day of the change in view, for anyone holding copies downloaded before it.
  const later = new LabClient(lab.origin); later.cookie = boss.cookie;
  assert.match((await later.get('/admin/backups')).text, /The key was changed on \d+\/\d+\/\d{4}\. A backup or photo archive downloaded before then opens only with the key from before/);
  // The copy that was checked was a copy of the key from before. Nobody has checked a copy of the new one yet, and the page says so.
  assert.match(card((await later.get(page)).text), /Needs attention/); assert.match(card((await later.get(page)).text), /Never checked\./);
  await lab.stop();
  const sealed = require('../app/sealed');
  const up = path.join(L.dir, 'uploads');
  for (const name of ['one.jpg', 'two.jpg', 'three.jpg']) { fs.writeFileSync(path.join(up, name), PNG); sealed.seal(path.join(up, name), sealed.keyFrom(KEY2)); }
  lab = await labSite(L, { DB_KEY: KEY2, DB_DECRYPT: 'yes' });
  assert.match(lab.log(), /The database has been decrypted, as DB_DECRYPT asked\. Photos and documents are still being opened: leave DB_KEY in the hosting settings until the Security check says none are still encrypted/);
  await lab.stop();
  // While photos are still sealed the page counts them and says to keep the key until none are left. No new key is offered meanwhile.
  let off = labJson(L.run(CHECK, { DB_KEY: KEY2, DB_DECRYPT: 'yes' })).find((c) => /is encrypted/.test(c.title));
  assert.equal(off.ok, false); assert.match(off.detail, /3 photos and documents are still encrypted\.$/);
  assert.match(off.fix, /^Leave DB_KEY and DB_DECRYPT in the hosting settings until this page says no photos or documents are still encrypted/); assert.match(off.fix, /Keep the old key on record/);
  assert.equal(off.code, undefined);
  // Both settings removed too soon: the files are locked, and the page says which key to put back.
  off = labJson(L.run(CHECK)).find((c) => /is encrypted/.test(c.title));
  assert.match(off.detail, /3 photos and documents are still encrypted, 3 of them with a key that is not in the settings\.$/); assert.match(off.fix, /put the key they were encrypted with back in DB_KEY, with DB_DECRYPT set to yes/);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('backups: a copy that does not pass its check, or does not hold the same rows as the database, never gets a backup\'s name', async () => {
  const L = encryptionLab();
  assert.ok(L.run(L.SEED).ok);
  const dir = path.join(L.dir, 'backups');
  // The copy is spoiled the moment it has been written, before the site looks at it: what a failing disk would do.
  const NIGHT = (spoil, how = '{}') => `const Database = require('better-sqlite3-multiple-ciphers'); const fs = require('fs'); const real = Database.prototype.exec;
    Database.prototype.exec = function (sql) { const out = real.call(this, sql); const m = /^VACUUM INTO '(.+)'$/.exec(sql); if (m) { const part = m[1]; ${spoil} } return out; };
    const b = require('./app/backup'); const db = require('./app/db'); const now = new Date('2031-07-01T12:00:00Z');
    b.runBackup({ now, ...${how} }).then((name) => ({ made: name }), (e) => ({ failed: e.message })).then((r) => { require('./app/app'); console.log(JSON.stringify({ ...r, failing: b.failing(),
      why: (JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'backup_last_error'").get() || {}).value || '{}')).why || null,
      line: require('./app/routes/security').checks({ headers: {}, ip: '203.0.113.9', socket: {} }).find((c) => /^A recent backup/.test(c.title)).detail })); });`;
  const ROW_LOST = `const copy = new Database(part); copy.prepare("DELETE FROM meta WHERE key = 'marker'").run(); copy.close();`;
  // A few bytes go wrong in a part of the copy that counting its rows never reads (the tail of one long value). Only SQLite's check finds it.
  assert.ok(L.run(`require('./app/db').prepare("INSERT INTO meta (key, value) VALUES ('long', ?)").run('LONGVALUE'.repeat(3000))`).ok);
  let r = labJson(L.run(NIGHT(`const at = fs.readFileSync(part).lastIndexOf('LONGVALUELONGVALUE'); const fd = fs.openSync(part, 'r+');
    fs.writeSync(fd, Buffer.from([0x7f, 0xff, 0xff, 0xff]), 0, 4, Math.floor(at / 4096) * 4096); fs.closeSync(fd);`)));
  assert.match(r.failed, /the copy did not pass its check/); assert.equal(r.failing, true); assert.match(r.why, /did not pass its check/);
  assert.match(r.line, /The site tries again every half hour\./);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /2031-07-01/.test(f)), []);   // no backup under the night's name, and no working copy left lying about
  // A row goes missing from the copy. It still opens and still passes SQLite's check; only the count gives it away.
  r = labJson(L.run(NIGHT(ROW_LOST)));
  assert.match(r.failed, /does not hold the same rows as the database/); assert.equal(r.failing, true);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /2031-07-01/.test(f)), []);
  // Left alone, the same night's copy is made, and the warning clears.
  r = labJson(L.run(NIGHT('')));
  assert.equal(r.made, 'portal-2031-07-01.db'); assert.equal(r.failing, false);
  assert.equal(require('../app/dbfile').inspect(path.join(dir, 'portal-2031-07-01.db'), '', { full: true }).fault, null);
  // "Back up now" failing is reported as well. Nothing tries that one again by itself (the night's copy is there), so the page does not say it will.
  r = labJson(L.run(NIGHT(ROW_LOST, '{ manual: true }')));
  assert.match(r.failed, /does not hold the same rows/); assert.equal(r.failing, true);
  assert.match(r.line, /^The last backup did not work \(.+\): the copy does not hold the same rows as the database\. The newest good backup is portal-2031-07-01\.db, today\.$/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /2031-07-01/.test(f)), ['portal-2031-07-01.db']);
  // The night's copy was made while the failures before it were still the latest news, and it carries that with it.
  // Brought back, it must not raise an alarm about a failure from before it existed: not on that start, nor on the next.
  const AFTER = `const db = require('./app/db'); const b = require('./app/backup'); console.log(JSON.stringify({ again: db.encryption.restored.again, failing: b.failing() }));`;
  assert.deepEqual(labJson(L.run(AFTER, { RESTORE_BACKUP: 'portal-2031-07-01.db' })), { again: false, failing: false });
  assert.deepEqual(labJson(L.run(AFTER, { RESTORE_BACKUP: 'portal-2031-07-01.db' })), { again: true, failing: false });
  fs.rmSync(L.dir, { recursive: true, force: true });
});

// -- review: uploaded files --
// What these checks share: the uploads folder, a sender on a weak signal, and stand-in photos.
const uplStore = require('../app/uploads'); const uplSeal = require('../app/sealed');
const uplDir = path.join(dataDir, 'uploads');
const uplList = () => fs.readdirSync(uplDir).sort();
const uplHead = (name) => fs.readFileSync(path.join(uplDir, name)).subarray(0, 7).toString('latin1');
const uplSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function uplUntil(check, what, ms = 5000) { const end = Date.now() + ms; for (;;) { const v = check(); if (v) return v; assert.ok(Date.now() < end, `timed out waiting for ${what}`); await uplSleep(10); } }
/** The folder goes back to exactly these names (deleting is done a moment after the answer is sent). */
async function uplBackTo(names, what) { const end = Date.now() + 3000; while (Date.now() < end && uplList().join() !== names.join()) await uplSleep(10); assert.deepEqual(uplList().filter((n) => !names.includes(n)), [], what); assert.deepEqual(names.filter((n) => !uplList().includes(n)), [], `${what} (something was removed that should have stayed)`); }
const uplPng = (bytes) => Buffer.concat([PNG.subarray(0, 8), require('crypto').randomBytes(bytes)]);   // passes the look at the first bytes, at any length
const uplDoc = (bytes) => Buffer.concat([Buffer.from('%PDF-1.4\n'), require('crypto').randomBytes(bytes), Buffer.from('\n%%EOF\n')]);
const uplFile = (field, data, type = 'image/png', name = 'p.png') => ({ field, name, type, data });
// A real picture, 16 wide and 8 high: left half red, right half blue.
const UPL_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDGrJoor0uHv+Xny/U9fPP+Xfz/AEP/2Q==', 'base64');
const uplPiece = (code, body) => { const b = Buffer.alloc(4 + body.length); b[0] = 0xff; b[1] = code; b.writeUInt16BE(body.length + 2, 2); Buffer.from(body).copy(b, 4); return b; };
/** That picture as a phone would send it: turned on its side, with the maker, the time, a position, an editing history and a comment hidden inside. */
function uplPhonePhoto(orientation = 6, { bigEndian = false } = {}) {
  const w16 = (b, v, at) => (bigEndian ? b.writeUInt16BE(v, at) : b.writeUInt16LE(v, at)); const w32 = (b, v, at) => (bigEndian ? b.writeUInt32BE(v, at) : b.writeUInt32LE(v, at));
  const text = Buffer.from('Apple\0iPhone 15 Pro\0GPSLatitude 40.0379 N GPSLongitude 76.3055 W\x002026:11:02 08:15:44\0', 'latin1');
  const list = Buffer.alloc(2 + 3 * 12 + 4); w16(list, 3, 0);
  const entry = (i, tag, type, count, value) => { const at = 2 + i * 12; w16(list, tag, at); w16(list, type, at + 2); w32(list, count, at + 4); if (type === 3) w16(list, value, at + 8); else w32(list, value, at + 8); };
  entry(0, 0x010f, 2, 6, 8 + list.length); entry(1, 0x0112, 3, 1, orientation); entry(2, 0x8825, 4, 1, 8 + list.length + 20);
  const start = Buffer.alloc(8); start.write(bigEndian ? 'MM' : 'II', 0, 'latin1'); w16(start, 42, 2); w32(start, 8, 4);
  return Buffer.concat([UPL_JPEG.subarray(0, 2),
    uplPiece(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), start, list, text])),
    uplPiece(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="40,2.274N" xmp:CreatorTool="Hidden Phone 9"/></x:xmpmeta>', 'latin1')),
    uplPiece(0xed, Buffer.from('Photoshop 3.0\x008BIM\x04\x04 taken at 12 Main Street by J Smith', 'latin1')),
    uplPiece(0xfe, Buffer.from('comment: customer gate code 4471', 'latin1')),
    UPL_JPEG.subarray(2),
    Buffer.from('a short video tacked on after the picture, with its own location +40.0379-076.3055/', 'latin1')]);
}
const UPL_HIDDEN = /GPS|Apple|iPhone|2026:11:02|xmpmeta|Hidden Phone|Photoshop|Main Street|gate code|40\.0379|tacked on/;
/** The "which way up" value a stored JPEG still carries (0 when it carries none). */
function uplTurn(buf) {
  for (let at = 2; at + 4 <= buf.length && buf[at] === 0xff && buf[at + 1] !== 0xda;) {
    const end = at + 2 + buf.readUInt16BE(at + 2);
    if (buf[at + 1] === 0xe1 && buf.toString('latin1', at + 4, at + 10) === 'Exif\0\0') return require('../app/jpeg').orientationOf(buf.subarray(at + 10, end));
    at = end;
  }
  return 0;
}
/**
 * Send a form the way a phone on a weak signal does: everything up to the middle of the last file, then `during` runs
 * while the connection stays open and the server waits, then the rest. cut: hang up instead of sending the rest.
 */
function uplSlowPost(client, url, token, fields, files, during, { cut = false } = {}) {
  const http = require('http'); const at = new URL(base);
  const B = '----upl' + require('crypto').randomBytes(8).toString('hex');
  const field = (n, v) => `--${B}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const head = (f) => `--${B}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: at.hostname, port: at.port, method: 'POST', path: url, headers: { cookie: client.cookie, 'content-type': `multipart/form-data; boundary=${B}`, 'transfer-encoding': 'chunked' } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', (e) => (cut ? resolve({ status: 0 }) : reject(e)));
    (async () => {
      r.write(field('_csrf', token));
      for (const [n, v] of fields) r.write(field(n, v));
      for (const f of files.slice(0, -1)) { r.write(head(f)); r.write(f.data); r.write('\r\n'); }
      const last = files[files.length - 1], half = Math.floor(last.data.length / 2);
      r.write(head(last)); r.write(last.data.subarray(0, half));
      await during();
      if (cut) { r.destroy(); return resolve({ status: 0 }); }
      r.write(last.data.subarray(half)); r.write(`\r\n--${B}--\r\n`); r.end();
    })().catch((e) => { r.destroy(); reject(e); });
  });
}
/** Every form on the site that stores a file, with enough filled in to be accepted. made: the files to send. */
async function uplForms(c) {
  const section = db.prepare('SELECT id FROM forum_sections ORDER BY id LIMIT 1').get().id;
  const me = db.prepare("SELECT id, branch_id FROM users WHERE username = 'upl.boss'").get();
  const office = db.prepare('SELECT address, phone, about FROM branches WHERE id = ?').get(me.branch_id);
  const officeFields = [['address', office.address || ''], ['phone', office.phone || ''], ['about', office.about || '']];
  const items = [...new Set([...(await c.get('/inspection')).text.matchAll(/name="(item_\d+)"/g)].map((m) => m[1]))];
  const thread = db.prepare('INSERT INTO forum_threads (section_id, user_id, title, created_at, last_post_at, last_post_user_id) VALUES (?, ?, ?, ?, ?, ?)').run(section, me.id, `Upload checks ${Date.now()}`, new Date().toISOString(), new Date().toISOString(), me.id).lastInsertRowid;
  db.prepare('INSERT INTO forum_posts (thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(thread, me.id, 'first post', new Date().toISOString());
  const entry = db.prepare("INSERT INTO parts_submissions (user_id, action, source, created_at, created_local_date) VALUES (?, 'return', 'van', ?, ?)").run(me.id, new Date().toISOString(), new Date().toISOString().slice(0, 10)).lastInsertRowid;
  db.prepare("INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, 'UPL-EDIT', 1)").run(entry);
  let n = 0; const tag = () => `${Date.now()}-${n++}`;
  return [
    { what: 'photo wall', url: '/photos', fields: () => [['caption', 'upload check']], wrong: () => [['caption', 'upload check']], field: 'photos', many: true },
    { what: 'new discussion', url: '/discussions/new', fields: () => [['section_id', String(section)], ['title', `Upload check ${tag()}`], ['body', 'with photos']], wrong: () => [['section_id', String(section)], ['title', ''], ['body', 'no title']], field: 'photos', many: true },
    { what: 'discussion reply', url: `/discussions/t/${thread}/reply`, fields: () => [['body', `reply ${tag()}`]], wrong: () => [['body', '']], field: 'photos', many: true },
    { what: 'truck inspection', url: '/inspection', fields: () => [['truck', 'UPL-1'], ['odometer', '100'], ...items.map((i) => [i, 'ok'])], wrong: () => [['truck', ''], ['odometer', '100'], ...items.map((i) => [i, 'ok'])], field: 'photos', many: true },
    { what: 'parts return', url: '/parts', fields: () => [['action', 'return'], ['part_name', 'UPL-PART'], ['quantity', '1'], ['source', 'van']], wrong: () => [['action', 'return'], ['part_name', 'UPL-PART'], ['quantity', '0'], ['source', 'van']], field: 'photo' },
    { what: 'parts entry edited', url: `/parts/${entry}/edit`, fields: () => [['part_name', 'UPL-EDIT'], ['quantity', '2'], ['source', 'van']], wrong: () => [['part_name', 'UPL-EDIT'], ['quantity', '0'], ['source', 'van']], field: 'photo' },
    { what: 'profile photo', url: '/profile', fields: () => [['about', 'upload check']], wrong: () => [['phone', 'not a number']], field: 'photo' },
    { what: 'office photo', url: `/branches/${me.branch_id}`, fields: () => officeFields, wrong: () => [['phone', 'not a number']], field: 'photo' },
    { what: 'newsletter', url: '/admin/newsletters', fields: () => [['issue_month', '2031-05'], ['title', `Upload check ${tag()}`]], wrong: () => [['issue_month', 'May']], field: 'pdf', pdf: true },
    { what: 'sales library', url: '/sales/library', fields: () => [['title', `Upload check ${tag()}`]], wrong: () => [['title', '']], field: 'file', doc: true },
  ];
}
let uplBoss = null;
async function uplSignedIn() {
  if (!uplBoss) { makeUser('upl.boss', 'Una Uploads', { role: 'admin', reviewer: true }); uplBoss = { office: db.prepare("SELECT b.id, b.photo_path FROM branches b JOIN users u ON u.branch_id = b.id WHERE u.username = 'upl.boss'").get() }; }
  return loggedIn('upl.boss');
}
/** Take away what these checks posted, and any file that was not there when the check began. */
function uplTidy(start) {
  const me = userId('upl.boss');
  for (const sql of ['DELETE FROM wall_photos WHERE user_id = ?', 'DELETE FROM forum_threads WHERE user_id = ?', 'DELETE FROM inspections WHERE user_id = ?', 'DELETE FROM parts_submissions WHERE user_id = ?',
    'DELETE FROM sales_files WHERE uploaded_by = ?', 'DELETE FROM newsletters WHERE created_by = ?', "DELETE FROM tasks WHERE assigned_to = ? AND title = 'Upload check'", 'UPDATE users SET photo_path = NULL WHERE id = ?']) db.prepare(sql).run(me);
  db.prepare('UPDATE branches SET photo_path = ? WHERE id = ?').run(uplBoss.office.photo_path, uplBoss.office.id);
  for (const n of uplList()) if (!start.includes(n)) fs.rmSync(path.join(uplDir, n), { force: true });
}
/** Stands in for the tool that draws a newsletter's pages: it notes what it was started with, draws half a page, waits to be told to go on, then finishes. */
function uplFakeRenderer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-pdftoppm-'));
  const page = Buffer.concat([UPL_JPEG, require('crypto').randomBytes(4000)]);
  fs.writeFileSync(path.join(dir, 'page.bin'), page);
  fs.writeFileSync(path.join(dir, 'pdftoppm'), `#!${process.execPath}
const fs = require('fs'); const path = require('path');
if (process.argv[2] === 'can-you-run') process.exit(0);
fs.writeFileSync(path.join(__dirname, 'started-with.json'), JSON.stringify(Object.keys(process.env).sort()));
const page = fs.readFileSync(path.join(__dirname, 'page.bin')); const out = process.argv[process.argv.length - 1] + '-1.jpg';
fs.writeFileSync(out, page.subarray(0, 2000));
const wait = () => { if (!fs.existsSync(__dirname)) process.exit(1); if (!fs.existsSync(path.join(__dirname, 'go'))) return setTimeout(wait, 15); fs.appendFileSync(out, page.subarray(2000)); };
wait();
`, { mode: 0o755 });
  const before = process.env.PATH;
  // Some machines do not allow programs to be run from the temporary folder; there the newsletter's pages are left out of the check.
  const works = require('child_process').spawnSync(path.join(dir, 'pdftoppm'), ['can-you-run'], { timeout: 10000 }).status === 0;
  if (works) process.env.PATH = dir + path.delimiter + before;
  return { dir, page, works, go: () => fs.writeFileSync(path.join(dir, 'go'), '1'), hold: () => fs.rmSync(path.join(dir, 'go'), { force: true }),
    startedWith: () => JSON.parse(fs.readFileSync(path.join(dir, 'started-with.json'), 'utf8')), done: () => { process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('uploaded files: a slow upload is never sealed part-way, on any form; what is kept is exactly what was sent, sealed once the form is accepted', async (t) => {
  const c = await uplSignedIn(); const start = uplList(); const token = await c.csrf('/profile');
  const k = uplSeal.keyFrom('upload-check-key-0123456789-abcdef');
  const tool = uplFakeRenderer();
  const forms = (await uplForms(c)).filter((f) => tool.works || !f.pdf);
  if (!tool.works) t.diagnostic('programs cannot be run from the temporary folder here: the newsletter form was not checked');
  try {
    uplStore.useKeys({ current: k, all: [k], off: false });
    uplStore.tend({ minAgeMs: 0, limit: 100000 });                                                   // what earlier checks left behind is sealed first, as a backlog would be
    for (const f of forms) {
      const before = uplList(); tool.hold();
      const sent = f.pdf ? [uplFile('pdf', tinyPdf(), 'application/pdf', 'n.pdf')] : f.doc ? [uplFile('file', uplDoc(30000), 'application/pdf', 'prices.pdf')]
        : f.many ? [uplFile(f.field, uplPng(20000)), uplFile(f.field, uplPng(20000))] : [uplFile(f.field, uplPng(20000))];
      const arrived = () => { const mine = uplList().filter((n) => !before.includes(n)); return mine.length === sent.length && mine.reduce((sum, n) => sum + fs.statSync(path.join(uplDir, n)).size, 0) >= sent.reduce((sum, x) => sum + x.data.length, 0) - Math.ceil(sent[sent.length - 1].data.length / 2) - 200 && mine; };   // (the last few bytes sent may still be held back, in case they turn out to be the end of the file)
      const answer = uplSlowPost(c, f.url, token, f.fields(), sent, async () => {
        // The first files are whole and the last is half there. Two minutes pass (minAgeMs: 0) and the background pass comes round.
        const mine = await uplUntil(arrived, `${f.what}: the first half to arrive`);
        uplStore.tend({ minAgeMs: 0, limit: 100000 });
        for (const n of mine) assert.notEqual(uplHead(n), 'PBSEAL1', `${f.what}: a file was sealed while its upload was still arriving`);
      });
      if (f.pdf) {
        // The pages are being drawn from the PDF: neither is touched while that goes on.
        const page = await uplUntil(() => uplList().find((n) => !before.includes(n) && /-1\.jpg$/.test(n)), 'the page picture to be started');
        await uplUntil(() => fs.statSync(path.join(uplDir, page)).size === 2000, 'half a page');
        uplStore.tend({ minAgeMs: 0, limit: 100000 });
        for (const n of uplList().filter((x) => !before.includes(x))) assert.notEqual(uplHead(n), 'PBSEAL1', 'newsletter: a file was sealed while its pages were being drawn');
        tool.go();
      }
      const r = await answer;
      assert.equal(r.status, 302, `${f.what}: ${(/<div class="errors"[\s\S]*?<\/div>/.exec(r.text) || [r.text.slice(0, 200)])[0]}`);
      const expect = f.pdf ? [sent[0].data, tool.page] : sent.map((x) => x.data);
      const mine = await uplUntil(() => { const now = uplList().filter((n) => !before.includes(n) && !n.endsWith('.sealing')); return now.length === expect.length && now; }, `${f.what}: its files`);
      const opened = mine.map((n) => uplSeal.read(path.join(uplDir, n), [k]));
      for (const data of expect) assert.ok(opened.some((b) => b.equals(data)), `${f.what}: what is stored is not what was sent`);
      for (const n of mine) assert.equal(uplHead(n), 'PBSEAL1', `${f.what}: stored without being sealed`);
      assert.deepEqual(uplStore.tend({ minAgeMs: 0 }), { sealed: 0, moved: 0, opened: 0, left: 0, stuck: 0 }, `${f.what}: nothing is left for the background pass`);
    }
    // People still get exactly what was sent.
    const raw = async (url) => { const r = await fetch(base + url, { headers: { cookie: c.cookie }, redirect: 'manual' }); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; };
    const issue = db.prepare("SELECT id FROM newsletters WHERE issue_month = '2031-05'").get();
    if (tool.works) { assert.ok((await raw(`/newsletters/${issue.id}/page/1`)).body.equals(tool.page)); assert.ok((await raw(`/newsletters/${issue.id}/pdf`)).body.equals(tinyPdf())); }
    const wall = db.prepare("SELECT id, path FROM wall_photos WHERE caption = 'upload check' ORDER BY id DESC").get();
    assert.ok((await raw(`/wall/photo/${wall.id}`)).body.equals(uplSeal.read(path.join(uplDir, wall.path), [k])));
    // The tool that draws the pages is started with nothing of the site's settings: it cannot see the database key.
    if (tool.works) assert.deepEqual(tool.startedWith(), ['PATH']);
  } finally {
    tool.done(); uplTidy(start);
    uplStore.useKeys({ current: null, all: [k], off: true }); uplStore.tend({ limit: 100000 }); uplStore.useKeys(null);   // back to ordinary files for the checks that follow
  }
});

test('uploaded files: a form that is refused leaves nothing behind, and an error after saving does not take away a photo that was kept', async () => {
  const c = await uplSignedIn(); const start = uplList(); const forms = await uplForms(c); const token = await c.csrf('/profile');
  const send = (f, fields, files, opts) => c.post(f.url, [...fields, ...files.map((x) => [x.field, new File([x.data], x.name, { type: x.type })])], { multipart: true, page: '/profile', ...opts });
  const fileFor = (f) => (f.pdf ? uplFile('pdf', tinyPdf(), 'application/pdf', 'n.pdf') : f.doc ? uplFile('file', uplDoc(3000), 'application/pdf', 'p.pdf') : uplFile(f.field, uplPng(3000)));
  for (const f of forms) {
    const before = uplList();
    // The form expired (or was sent without its token).
    const stale = await send(f, f.fields(), [fileFor(f)], { csrf: false });
    assert.equal(stale.status, 403, f.what); assert.match(stale.text, /Form expired/);
    await uplBackTo(before, `${f.what}: files left behind by an expired form`);
    // Something in the form is wrong.
    const wrong = await send(f, f.wrong(), f.what === 'photo wall' ? [fileFor(f), uplFile('photos', Buffer.from('not a picture'))] : [fileFor(f)]);
    assert.equal(wrong.status, 400, f.what);
    await uplBackTo(before, `${f.what}: files left behind by a form with a mistake in it`);
    // The connection drops half-way through the file.
    const big = { ...fileFor(f), data: f.pdf ? Buffer.concat([tinyPdf(), Buffer.alloc(40000)]) : f.doc ? uplDoc(40000) : uplPng(40000) };
    await uplSlowPost(c, f.url, token, f.fields(), [big], () => uplUntil(() => uplList().length > before.length, `${f.what}: the first half to arrive`), { cut: true });
    await uplBackTo(before, `${f.what}: files left behind by an upload that was cut off`);
  }
  // Something goes wrong on the server before the form is saved: the files go too.
  const wallForm = forms[0]; let before = uplList();
  db.exec("CREATE TEMP TRIGGER upl_fail BEFORE INSERT ON wall_photos BEGIN SELECT RAISE(ABORT, 'made to fail'); END");
  try { assert.equal((await send(wallForm, wallForm.fields(), [uplFile('photos', uplPng(3000)), uplFile('photos', uplPng(3000))])).status, 500); } finally { db.exec('DROP TRIGGER upl_fail'); }
  await uplBackTo(before, 'files left behind when the server failed before saving');
  // ...but when it goes wrong after the form was saved, the file the database now points at stays.
  const library = forms.find((f) => f.doc); const activity = require('../app/activity'); const realLog = activity.log; const doc = uplDoc(3000);
  before = uplList();
  activity.log = () => { throw new Error('made to fail after saving'); };
  let failed;
  try { failed = await send(library, [['title', 'Kept through an error']], [uplFile('file', doc, 'application/pdf', 'p.pdf')]); } finally { activity.log = realLog; }
  assert.equal(failed.status, 500);
  const kept = db.prepare("SELECT id, path FROM sales_files WHERE title = 'Kept through an error'").get();
  await uplSleep(150);
  assert.ok(fs.readFileSync(path.join(uplDir, kept.path)).equals(doc)); await uplBackTo(before.concat(kept.path).sort(), 'only the kept file is added');
  const dl = await fetch(`${base}/sales/library/${kept.id}`, { headers: { cookie: c.cookie } });
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(doc));
  await c.post(`/sales/library/${kept.id}/delete`, {}, { page: '/sales/library' });
  await uplBackTo(before, 'removing it from the library removes its file');
  // An accepted form keeps its files, as before.
  assert.equal((await send(wallForm, wallForm.fields(), [uplFile('photos', uplPng(3000))])).status, 302);
  assert.equal(uplList().length, before.length + 1);
  uplTidy(start);
});

test('uploaded files: the background pass opens each file once, does nothing when nothing changed, and a file that fails cannot hold it up', async () => {
  const crypto = require('crypto'); const k = uplSeal.keyFrom('background-pass-key-0123456789-abc');
  const real = { openSync: fs.openSync, statSync: fs.statSync, readdirSync: fs.readdirSync, seal: uplSeal.seal };
  /** Run one pass and count what it asked of the disk: files opened for reading, files looked up, folder listings. */
  const counted = (opts) => {
    const n = { opened: 0, lookedUp: 0, listed: 0 };
    fs.openSync = (...a) => { if (a[1] === 'r') n.opened += 1; return real.openSync(...a); };
    fs.statSync = (...a) => { if (String(a[0]) !== uplDir) n.lookedUp += 1; return real.statSync(...a); };
    fs.readdirSync = (...a) => { n.listed += 1; return real.readdirSync(...a); };
    try { n.pass = uplStore.tend(opts); } finally { Object.assign(fs, { openSync: real.openSync, statSync: real.statSync, readdirSync: real.readdirSync }); }
    return n;
  };
  const made = [];
  const make = (name) => { fs.writeFileSync(path.join(uplDir, name), Buffer.concat([PNG.subarray(0, 8), crypto.randomBytes(300)])); made.push(name); };
  let tick = 0;
  const longAgo = () => { const then = new Date(Date.now() - 60000 - 1000 * tick++); fs.utimesSync(uplDir, then, then); };   // the folder last changed a minute or more ago
  try {
    for (let i = 0; i < 240; i++) make(`bulk-${String(i).padStart(3, '0')}.png`);
    const total = uplList().length;

    // No key in use: every file is looked at once, and then never again.
    uplStore.useKeys({ current: null, all: [], off: false });
    longAgo();
    const first = counted(); assert.equal(first.opened, total); assert.equal(first.listed, 1);
    const second = counted(); assert.deepEqual([second.opened, second.lookedUp, second.listed], [0, 0, 0], 'a pass with nothing changed asks the folder one question and stops');
    assert.deepEqual(second.pass, { sealed: 0, moved: 0, opened: 0, left: 0, stuck: 0 });
    make('bulk-new.png'); longAgo();                                                                // one file is added: only that one is opened
    const third = counted(); assert.deepEqual([third.opened, third.listed], [1, 1]);
    assert.equal(uplStore.census().plain, total + 1);

    // A key is switched on: the work is spread over many short passes, and all of them together open each file a fixed number of times.
    uplStore.useKeys({ current: k, all: [k], off: false });
    let opened = 0, passes = 0, sealedSoFar = 0;
    for (;;) {
      const p = counted({ minAgeMs: 0, limit: 20 }); passes += 1; opened += p.opened; sealedSoFar += p.pass.sealed;
      assert.ok(p.pass.sealed <= 20); assert.equal(p.pass.stuck, 0);
      if (!p.pass.left) break;
      assert.ok(passes < 200, 'the passes never finish');
    }
    assert.equal(sealedSoFar, total + 1); assert.equal(passes, Math.ceil((total + 1) / 20));
    assert.ok(opened <= 3 * (total + 1), `${opened} files opened to seal ${total + 1}: every pass is reading the whole folder again`);
    assert.equal(uplStore.census().sealed, total + 1);
    longAgo(); counted({ minAgeMs: 0 });
    const quiet = counted({ minAgeMs: 0 }); assert.deepEqual([quiet.opened, quiet.lookedUp, quiet.listed], [0, 0, 0]);

    // Files that fail use up their turn in the pass, so one bad file (or twelve) cannot make a pass run on, and the good ones still get done.
    let tries = 0;
    uplSeal.seal = (file, key) => { tries += 1; if (/bulk-bad/.test(file)) throw new Error('made to fail'); return real.seal(file, key); };
    for (let i = 0; i < 12; i++) make(`bulk-bad-${i}.png`);
    for (let i = 0; i < 10; i++) make(`bulk-ok-${i}.png`);
    const noise = logLines.length; let good = 0; passes = 0;
    while (good < 10) {
      const was = tries; const p = uplStore.tend({ minAgeMs: 0, limit: 5 }); passes += 1; good += p.sealed;
      assert.ok(tries - was <= 5, `a pass limited to 5 files tried ${tries - was}`); assert.ok(p.stuck <= 5);
      assert.ok(passes <= 8, 'the files that fail are holding up the ones that do not');
    }
    // Only the twelve that fail are left now, whichever order the folder listed them in: each pass tries five of them and stops.
    for (let i = 0; i < 3; i++) {
      const was = tries; const p = uplStore.tend({ minAgeMs: 0, limit: 5 }); passes += 1;
      assert.equal(tries - was, 5, `a pass limited to 5 files tried ${tries - was} that fail`); assert.equal(p.stuck, 5); assert.equal(p.left, 12);
    }
    assert.ok(logLines.slice(noise).filter((l) => /could not convert bulk-bad/.test(l)).length <= passes * 5);
    for (let i = 0; i < 10; i++) assert.equal(uplHead(`bulk-ok-${i}.png`), 'PBSEAL1');
    for (let i = 0; i < 12; i++) assert.notEqual(uplHead(`bulk-bad-${i}.png`), 'PBSEAL1');             // untouched, and tried again later
    uplSeal.seal = real.seal;
    assert.ok(uplStore.tend({ minAgeMs: 0, limit: 100 }).sealed >= 1);
  } finally {
    Object.assign(fs, { openSync: real.openSync, statSync: real.statSync, readdirSync: real.readdirSync }); uplSeal.seal = real.seal;
    for (const name of made) fs.rmSync(path.join(uplDir, name), { force: true });
    uplStore.useKeys({ current: null, all: [k], off: true }); uplStore.tend({ limit: 100000 }); uplStore.useKeys(null);
  }
});

test('uploaded files: a JPEG photo loses its hidden details as it arrives and stays the right way up; every photo box redraws the picture in the browser first', async () => {
  const jpeg = require('../app/jpeg');
  // The stripper on its own.
  const phone = uplPhonePhoto(6); const lean = jpeg.strip(phone);
  assert.match(phone.toString('latin1'), UPL_HIDDEN); assert.doesNotMatch(lean.toString('latin1'), UPL_HIDDEN);
  assert.equal(uplTurn(phone), 6); assert.equal(uplTurn(lean), 6);                                   // still says "turn me a quarter turn"
  assert.ok(lean.subarray(lean.length - (UPL_JPEG.length - 2)).equals(UPL_JPEG.subarray(2)));        // the picture itself, byte for byte, and nothing after it
  assert.equal(lean.length, UPL_JPEG.length + 36);
  assert.equal(jpeg.strip(lean), lean);                                                              // nothing more to take out
  assert.equal(jpeg.strip(UPL_JPEG), UPL_JPEG);
  for (const turn of [2, 3, 4, 5, 7, 8]) assert.equal(uplTurn(jpeg.strip(uplPhonePhoto(turn, { bigEndian: turn % 2 === 0 }))), turn);
  assert.equal(jpeg.strip(uplPhonePhoto(1)).length, UPL_JPEG.length);                                // already upright: no note is needed at all
  // Anything not laid out as expected is left exactly as it came.
  const cutDetails = Buffer.concat([UPL_JPEG.subarray(0, 2), uplPiece(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\x09\x01\x12', 'latin1')), UPL_JPEG.subarray(2)]);
  assert.equal(jpeg.strip(cutDetails), null);
  assert.equal(jpeg.strip(Buffer.from('\xff\xd8\xff\xe0 not really a picture', 'latin1')), null);
  assert.equal(jpeg.strip(PNG), null); assert.equal(jpeg.strip(Buffer.alloc(0)), null);
  assert.equal(jpeg.strip(Buffer.concat([UPL_JPEG.subarray(0, 2), Buffer.from([0xff, 0xe1, 0xff, 0xff]), UPL_JPEG.subarray(2)])), null);   // a piece that says it is longer than the file
  // A picture whose end is missing keeps everything from the picture data on, untouched; only the details before it go.
  const noEnd = phone.subarray(0, phone.indexOf(Buffer.from([0xff, 0xd9]), phone.length - 90));
  const noEndLean = jpeg.strip(noEnd);
  assert.doesNotMatch(noEndLean.toString('latin1'), UPL_HIDDEN); assert.ok(noEndLean.subarray(noEndLean.length - 200).equals(noEnd.subarray(noEnd.length - 200)));

  // On the site: every form that takes a picture stores it without the hidden details.
  const c = await uplSignedIn(); const start = uplList(); const forms = (await uplForms(c)).filter((f) => !f.pdf);
  for (const f of forms) {
    const before = uplList();
    const r = await c.post(f.url, [...f.fields(), [f.field, new File([phone], 'IMG_0042.jpg', { type: 'image/jpeg' })]], { multipart: true, page: '/profile' });
    assert.equal(r.status, 302, f.what);
    const mine = await uplUntil(() => { const now = uplList().filter((n) => !before.includes(n)); return now.length === 1 && now; }, `${f.what}: its file`);
    const stored = fs.readFileSync(path.join(uplDir, mine[0]));
    assert.ok(stored.equals(lean), `${f.what}: the photo was stored with its hidden details`);
  }
  // ...and it is what people are sent. The size checked for a profile photo is the size after the details are gone.
  const me = userId('upl.boss');
  const seen = await fetch(`${base}/people/photo/${me}`, { headers: { cookie: c.cookie } }); const body = Buffer.from(await seen.arrayBuffer());
  assert.ok(body.equals(lean)); assert.doesNotMatch(body.toString('latin1'), UPL_HIDDEN); assert.equal(uplTurn(body), 6);
  // Other kinds of picture, and a JPEG that cannot be read with certainty, are stored exactly as they arrive.
  for (const [data, type] of [[PNG, 'image/png'], [cutDetails, 'image/jpeg']]) {
    const before = uplList();
    assert.equal((await c.post('/photos', [['caption', 'as it came'], ['photos', new File([data], 'x', { type })]], { multipart: true, page: '/social' })).status, 302);
    const mine = uplList().filter((n) => !before.includes(n));
    assert.ok(fs.readFileSync(path.join(uplDir, mine[0])).equals(data));
  }
  assert.doesNotMatch(uplList().join(' '), /\.sealing/);

  // In the browser: the parts form and both discussion forms now redraw their photos too, like the others, and a small photo is no longer sent as it is.
  const thread = /\/discussions\/t\/(\d+)\/reply/.exec(forms.find((f) => f.what === 'discussion reply').url)[1];
  for (const page of ['/parts', '/discussions/new', `/discussions/t/${thread}`, '/social', '/inspection']) {
    const html = (await c.get(page)).text;
    assert.match(html, /<script src="\/shrink\.js\?v=[^"]+" defer><\/script>/, page);
    for (const box of html.match(/<input type="file"[^>]*>/g)) assert.match(box, /data-shrink="\d+"/, `${page}: ${box}`);
  }
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'shrink.js'), 'utf8');
  assert.doesNotMatch(js, /file\.size/);                                                             // no "small enough, send it as it is"
  assert.match(js, /resolve\(blob \? new File\(\[blob\]/); assert.match(js, /ctx\.drawImage\(img, 0, 0, c\.width, c\.height\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'profile.js'), 'utf8'), /out\.toBlob\(/);   // the profile photo has always been redrawn
  uplTidy(start);
});

test('uploaded files: when the data disk is nearly full new photos and files are refused in one sentence, and everything else keeps working', async () => {
  const MB = 1024 * 1024, GB = 1024 * MB;
  const diskWith = (size, free) => () => ({ bsize: 4096, blocks: size / 4096, bavail: free / 4096, bfree: free / 4096 });
  const c = await uplSignedIn(); const start = uplList(); const forms = await uplForms(c); const noise = logLines.length;
  try {
    // Nearly full: less than 5% of the disk (never asking for more than 500 MB), or less than 50 MB.
    for (const [size, free, room] of [[GB, 60 * MB, true], [GB, 51 * MB, false], [GB, 0, false], [GB / 2, 40 * MB, false], [GB / 2, 52 * MB, true], [100 * GB, 400 * MB, false], [100 * GB, 600 * MB, true]]) {
      uplStore.useDisk(diskWith(size, free)); assert.equal(uplStore.hasRoom(), room, `${free / MB} MB free of ${size / MB}`);
    }
    // If the disk cannot be asked, or answers nonsense, nothing is refused.
    uplStore.useDisk(() => { throw new Error('not available here'); }); assert.equal(uplStore.hasRoom(), true);
    uplStore.useDisk(() => ({})); assert.equal(uplStore.hasRoom(), true);
    assert.equal((await c.post('/photos', [['caption', 'room unknown'], ['photos', new File([PNG], 'p.png', { type: 'image/png' })]], { multipart: true, page: '/social' })).status, 302);

    uplStore.useDisk(diskWith(GB, 20 * MB));
    const SENTENCE = 'The site is almost out of storage space, so photos and files cannot be added right now; please tell your admin.';
    for (const f of forms) {
      const before = uplList();
      const file = f.pdf ? new File([tinyPdf()], 'n.pdf', { type: 'application/pdf' }) : f.doc ? new File([uplDoc(2000)], 'p.pdf', { type: 'application/pdf' }) : new File([PNG], 'p.png', { type: 'image/png' });
      const r = await c.post(f.url, [...f.fields(), ...(f.many ? [[f.field, file], [f.field, file]] : [[f.field, file]])], { multipart: true, page: '/profile' });
      assert.equal(r.status, 400, f.what);
      const errors = (/<div class="errors"[\s\S]*?<\/div>/.exec(r.text) || [''])[0];
      assert.deepEqual(errors.match(/<li>[\s\S]*?<\/li>/g), [`<li>${SENTENCE}</li>`], f.what);          // that one sentence, and nothing else
      await uplBackTo(before, `${f.what}: nothing is stored while the disk is nearly full`);
      // The same form without a file is saved as usual (a newsletter or a photo post is nothing without its file).
      if (!f.pdf && f.what !== 'photo wall') {
        const plain = await c.post(f.url, f.doc ? [...f.fields(), ['link', 'https://example.com/sheet']] : f.fields(), { multipart: true, page: '/profile' });
        assert.equal(plain.status, 302, `${f.what} without a file`);
      }
    }
    // A truck inspection that needs its six photos says the one thing that matters, not six more lines about missing photos.
    const me = userId('upl.boss'); const inspection = forms.find((f) => f.what === 'truck inspection');
    const task = db.prepare("INSERT INTO tasks (title, assigned_to, assigned_by, created_at, kind) VALUES ('Upload check', ?, ?, ?, 'inspection')").run(me, me, new Date().toISOString()).lastInsertRowid;
    const six = await c.post('/inspection', [...inspection.fields(), ['task', String(task)], ...['front', 'rear', 'driver', 'passenger', 'cab', 'back'].map((s) => [`shot_${s}`, new File([PNG], 'p.png', { type: 'image/png' })])], { multipart: true, page: '/profile' });
    assert.equal(six.status, 400); assert.deepEqual((/<div class="errors"[\s\S]*?<\/div>/.exec(six.text) || [''])[0].match(/<li>[\s\S]*?<\/li>/g), [`<li>${SENTENCE}</li>`]);
    assert.equal(logLines.slice(noise).filter((l) => /\[files\] The data disk is nearly full/.test(l)).length, 1);   // said once in the log, not once per upload
    // Signing in and ordinary saves are untouched.
    const other = new Client(); await other.login('tech1', 'correct horse battery');
    assert.equal((await other.post('/training', { description: 'still works', wants_contact: 'no', is_private: 'no' }, { page: '/training' })).status, 302);
  } finally { uplStore.useDisk(null); }
  assert.equal(uplStore.hasRoom(), true, 'the machine running these checks is itself nearly out of disk space');
  assert.equal((await c.post('/photos', [['caption', 'room again'], ['photos', new File([PNG], 'p.png', { type: 'image/png' })]], { multipart: true, page: '/social' })).status, 302);
  uplTidy(start);
});

test('uploaded files: a file kept through an error after saving is sealed there and then, however slowly it arrived', async () => {
  const c = await uplSignedIn(); const start = uplList(); const token = await c.csrf('/profile');
  const k = uplSeal.keyFrom('kept-through-an-error-key-0123456789');
  const activity = require('../app/activity'); const realLog = activity.log; const doc = uplDoc(30000);
  try {
    uplStore.useKeys({ current: k, all: [k], off: false });
    uplStore.tend({ minAgeMs: 0, limit: 100000 });
    const before = uplList();
    activity.log = () => { throw new Error('made to fail after saving'); };
    const r = await uplSlowPost(c, '/sales/library', token, [['title', 'Slow and kept through an error']], [uplFile('file', doc, 'application/pdf', 'p.pdf')], async () => {
      // Half the file is here and the folder has been quiet for a minute when the background pass comes round and looks at it.
      await uplUntil(() => uplList().length > before.length, 'the first half to arrive');
      const then = new Date(Date.now() - 60000); fs.utimesSync(uplDir, then, then);
      uplStore.tend({ minAgeMs: 0, limit: 100000 });
    });
    assert.equal(r.status, 500);
    const kept = db.prepare("SELECT path FROM sales_files WHERE title = 'Slow and kept through an error'").get();
    assert.ok(kept, 'the form was saved before the error');
    assert.equal(uplHead(kept.path), 'PBSEAL1', 'the file was kept but left unsealed');
    assert.ok(uplSeal.read(path.join(uplDir, kept.path), [k]).equals(doc));
    // Nothing is left over for the background pass to find, or to miss.
    assert.deepEqual(uplStore.tend({ minAgeMs: 0 }), { sealed: 0, moved: 0, opened: 0, left: 0, stuck: 0 });
    assert.equal(uplStore.census().plain, 0);
  } finally {
    activity.log = realLog; uplTidy(start);
    uplStore.useKeys({ current: null, all: [k], off: true }); uplStore.tend({ limit: 100000 }); uplStore.useKeys(null);
  }
});

test('uploaded files: a parts photo that is refused after it arrived says why, and nothing is kept', async () => {
  const c = await uplSignedIn(); const start = uplList(); const forms = await uplForms(c);
  for (const f of forms.filter((x) => x.url.startsWith('/parts'))) {
    const before = uplList();
    // Two photos where the form takes one: the first is already stored when the second is refused.
    const two = ['a.png', 'b.png'].map((name) => ['photo', new File([uplPng(3000)], name, { type: 'image/png' })]);
    const r = await c.post(f.url, [...f.fields(), ...two], { multipart: true, page: '/profile' });
    assert.equal(r.status, 400, f.what); assert.match(r.text, /The photo could not be uploaded\./);
    await uplBackTo(before, `${f.what}: nothing is kept`);
  }
  uplTidy(start);
});

// -- review: speed and small defects --

/** Everything the database is asked while `fn` runs: each statement, and how many rows came back. */
async function watched(fn) {
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')); const seen = []; const orig = { all: proto.all, get: proto.get, run: proto.run };
  for (const m of Object.keys(orig)) proto[m] = function (...a) { const out = orig[m].apply(this, a); seen.push({ sql: this.source.replace(/\s+/g, ' '), rows: Array.isArray(out) ? out.length : m === 'get' && out ? 1 : 0 }); return out; };
  try { await fn(); } finally { Object.assign(proto, orig); }
  return seen;
}
/** A small office with its own admin (who sees that office only), a manager above a second manager above a technician, and one more technician. */
function speedOffice() {
  const have = db.prepare("SELECT id FROM branches WHERE name = 'Speedville'").get();
  if (have) return have.id;
  const office = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Speedville', ?)").run(new Date().toISOString()).lastInsertRowid;
  access.ensureProfile('Office lead', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all'));
  const mk = (username, name, profile) => { const id = makeUser(username, name); db.prepare('UPDATE users SET profile_id = ?, branch_id = ? WHERE id = ?').run(profileId(profile), office, id); return id; };
  const boss = mk('sp.admin', 'Sasha Speedville', 'Office lead'); const mgr = mk('sp.mgr', 'Morgan Speedville', 'Manager'); const sub = mk('sp.sub', 'Sidney Speedville', 'Manager');
  const t1 = mk('sp.tech1', 'Tatum Speedville', 'Technician'); mk('sp.tech2', 'Uri Speedville', 'Technician');
  db.prepare('INSERT INTO user_managers (manager_id, user_id) VALUES (?, ?), (?, ?)').run(mgr, sub, sub, t1);
  db.prepare("UPDATE users SET default_truck = 'SPD-1' WHERE id = ?").run(t1);
  assert.ok(boss);
  return office;
}

test('speed: the look-ups made on nearly every page have an index to use', () => {
  const plan = (sql, ...args) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | ');
  for (const [sql, index] of [
    ['SELECT MAX(created_local_date) FROM inspections WHERE user_id = 5', 'inspections_user'],
    ['SELECT u.id, (SELECT MAX(created_local_date) FROM inspections i WHERE i.user_id = u.id) AS last FROM users u WHERE u.active = 1 AND u.id IN (1,2,3)', 'inspections_user'],
    ['SELECT COUNT(*) FROM inspections WHERE problems > 0 AND resolved_at IS NULL AND user_id IN (1,2,3)', 'inspections_open'],
    ['SELECT * FROM inspection_results WHERE inspection_id = 5 ORDER BY id', 'inspection_results_inspection'],
    ['SELECT id, label FROM inspection_photos WHERE inspection_id = 5 ORDER BY id', 'inspection_photos_inspection'],
    ['SELECT id FROM users WHERE branch_id = 5', 'users_branch'],
    ['SELECT b.id, (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND (u.active = 1 OR u.in_directory = 1)) AS people FROM branches b', 'users_branch'],
    ['SELECT manager_id FROM user_managers WHERE user_id = 5', 'user_managers_user'],
    ['SELECT COUNT(*) FROM training_requests WHERE user_id = 5 AND unseen = 1', 'training_user'],
    ["SELECT COUNT(*) FROM parts_submissions WHERE action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered') AND user_id IN (1,2,3)", 'parts_open'],
    ['DELETE FROM sessions WHERE expires <= 5', 'sessions_expires'],
    ['SELECT a.at FROM activity_log a LEFT JOIN users u ON u.id = a.user_id WHERE u.branch_id = 5 ORDER BY a.id DESC LIMIT 500', 'activity_user'],
  ]) assert.match(plan(sql), new RegExp(`USING (COVERING )?INDEX ${index}\\b`), `${sql} should use ${index}`);
  // Stock for one office is its own warehouse's movements, found by index: never a pass over every movement.
  const stockPlan = (() => { const seen = []; const orig = db.prepare; db.prepare = function (sql) { seen.push(sql); return orig.apply(this, arguments); }; try { require('../app/stock').list(1); } finally { delete db.prepare; } return plan(seen.find((q) => /LEFT JOIN branch_stock bs/.test(q)), 1); })();
  assert.match(stockPlan, /USING (COVERING )?INDEX inv_moves_to\b/); assert.match(stockPlan, /USING (COVERING )?INDEX inv_moves_from\b/);
  assert.doesNotMatch(stockPlan, /SCAN m\b/);
});

test('speed: a page for one office reads that office\'s people and tasks, not the whole company\'s, and shows the same thing', async () => {
  const office = speedOffice(); const boss = await loggedIn('sp.admin');
  const far = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Speed Farville', ?)").run(new Date().toISOString()).lastInsertRowid;
  const now = new Date().toISOString(); const today = now.slice(0, 10);
  // The rest of the company: 40 people in another office, each with an inspection, a certification and a great many open tasks.
  const addUser = db.prepare("INSERT INTO users (username, display_name, password_hash, must_change_password, active, created_at, profile_id, branch_id, default_truck) VALUES (?, ?, 'x', 0, 1, ?, ?, ?, ?)");
  const farIds = []; for (let i = 0; i < 40; i++) farIds.push(addUser.run(`spdfar${i}`, `Farley Farville ${i}`, now, profileId('Technician'), far, `FAR-${i}`).lastInsertRowid);
  const addTask = db.prepare("INSERT INTO tasks (title, assigned_to, assigned_by, due_on, done_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const id of farIds) {
      db.prepare("INSERT INTO inspections (user_id, truck, problems, created_at, created_local_date) VALUES (?, 'FAR', 1, ?, ?)").run(id, now, today);
      db.prepare("INSERT INTO certifications (user_id, name, expires_on, created_at) VALUES (?, 'FARCERT', '2020-01-01', ?)").run(id, now);
      for (let k = 0; k < 27; k++) addTask.run('FARTASK', id, farIds[0], '2020-01-01', null, now);   // 1,080 open and long overdue: ahead of everyone else's in the company-wide order
    }
  })();
  const t1 = userId('sp.tech1'); const me = userId('sp.admin');
  db.prepare("INSERT INTO inspections (user_id, truck, problems, created_at, created_local_date) VALUES (?, 'SPD-1', 0, ?, ?)").run(t1, now, today);
  db.prepare("INSERT INTO certifications (user_id, name, expires_on, created_at) VALUES (?, 'SPDCERT', '2031-01-01', ?)").run(t1, now);
  addTask.run('SPDTASK open', t1, me, '2021-03-03', null, now); addTask.run('SPDTASK done', userId('sp.tech2'), me, today, now, now);

  const pages = ['/', '/admin/users', '/admin/users/invite', '/admin/inspections', '/admin/parts', '/admin/parts/audit', '/admin/parts/summary', '/admin/training', '/admin/training/sessions', '/admin/certs', '/admin/tasks'];
  const text = {};
  const seen = await watched(async () => { for (const p of pages) { const r = await boss.get(p); assert.equal(r.status, 200, p); text[p] = r.text.replace(/\s+/g, ' '); } });
  // Five people work in this office. No list of people, tasks or certifications read for these pages comes anywhere near the
  // size of the company. (Birthdays this week are looked up across every office on purpose.)
  const outer = (sql) => { let t = sql; while (/\([^()]*\)/.test(t)) t = t.replace(/\([^()]*\)/g, ''); return t; };   // the statement without anything in brackets: what it lists, not what it counts on the side
  const tooMany = seen.filter((s) => s.rows > 12 && /\bFROM (users|tasks|certifications)\b/.test(outer(s.sql)) && !/u\.birthday/.test(s.sql)).map((s) => `${s.rows} rows: ${s.sql.slice(0, 140)}`);
  assert.deepEqual(tooMany, []);
  // And the pages still say what they said.
  assert.equal((text['/admin/users'].match(/Speedville<\/(?:strong|a|td)>|Speedville /g) || []).length > 0, true);
  for (const name of ['Sasha Speedville', 'Morgan Speedville', 'Sidney Speedville', 'Tatum Speedville', 'Uri Speedville']) assert.match(text['/admin/users'], new RegExp(name));
  assert.doesNotMatch(text['/admin/users'], /Farley Farville/);
  assert.match(text['/admin/inspections'], /Tatum Speedville/); assert.doesNotMatch(text['/admin/inspections'], /Farley Farville|FAR-\d/);
  assert.match(text['/admin/certs'], /SPDCERT/); assert.doesNotMatch(text['/admin/certs'], /FARCERT/);
  // Manage tasks: the office's own tasks are all there, however many the rest of the company has open.
  assert.match(text['/admin/tasks'], /<strong>1<\/strong> open, <strong>1 overdue<\/strong>, 1 done\./); assert.match(text['/admin/tasks'], /SPDTASK open/); assert.doesNotMatch(text['/admin/tasks'], /FARTASK/);
  assert.match((await boss.get('/admin/tasks?show=done')).text, /SPDTASK done/);
  // Someone looking at every office at once gets the first 1,000 and is told so; picking a person shows all of that person's.
  const corp = await loggedIn('owner'); await corp.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
  const everything = (await corp.get('/admin/tasks')).text;
  assert.match(everything, /<strong>1000<\/strong> open, <strong>1000 overdue<\/strong>, 0 done\. These are the first 1000 only: choose a person below to see all of theirs\./);
  const oneFar = (await corp.get(`/admin/tasks?user=${farIds[3]}`)).text;
  assert.match(oneFar, /<strong>27<\/strong> open, <strong>27 overdue<\/strong>, 0 done\. A task shows/); assert.doesNotMatch(oneFar, /first 1000 only/);
  assert.match((await corp.get(`/admin/tasks?user=${t1}`)).text, /<strong>1<\/strong> open, <strong>1 overdue<\/strong>, 0 done\. A task shows/);
  assert.doesNotMatch(text['/admin/tasks'], /first 1000 only/);
  assert.match(text['/'].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), /Overdue tasks 1 1 open in all|1 Overdue tasks 1 open in all/);   // the home page counts the same ones
  // A manager's pages cover their own people only, as before.
  const mgr = await loggedIn('sp.mgr');
  const who = (await mgr.get('/admin/inspections')).text;
  assert.match(who, /Tatum Speedville/); assert.doesNotMatch(who, /Uri Speedville|Farley/);
  const certPeople = /<select name="user_id"[\s\S]*?<\/select>/.exec((await mgr.get('/admin/certs')).text)[0];
  assert.match(certPeople, /Sidney Speedville/); assert.match(certPeople, /Tatum Speedville/); assert.doesNotMatch(certPeople, /Uri Speedville|Sasha Speedville|Farley/);

  db.transaction(() => {
    db.prepare("DELETE FROM tasks WHERE title IN ('FARTASK', 'SPDTASK open', 'SPDTASK done')").run();
    db.prepare("DELETE FROM certifications WHERE name IN ('FARCERT', 'SPDCERT')").run();
    db.prepare("DELETE FROM inspections WHERE truck IN ('FAR', 'SPD-1')").run();
    db.prepare('DELETE FROM users WHERE branch_id = ?').run(far); db.prepare('DELETE FROM branches WHERE id = ?').run(far);
  })();
  assert.ok(office);
});

test('stock: one office\'s figures come from its own entries only, whatever another office does with the same part', () => {
  const stock = require('../app/stock'); const office = speedOffice();
  const other = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Speed Stockton', ?)").run(new Date().toISOString()).lastInsertRowid;
  const away = makeUser('stock.away', 'Avery Away'); db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(other, away);
  const part = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES ('SPD-100', 'Speed test strobe', ?)").run(new Date().toISOString()).lastInsertRowid;
  const count = db.prepare('INSERT INTO branch_stock (branch_id, catalog_id, count_qty, count_at, min_level) VALUES (?, ?, ?, ?, ?)');
  count.run(office, part, 50, '2026-06-01T12:00:00.000Z', 60); count.run(other, part, 20, '2026-06-01T12:00:00.000Z', null);
  const entry = (user, action, name, qty, at, cancelled) => {
    const id = db.prepare("INSERT INTO parts_submissions (user_id, action, source, status, cancelled_at, created_at, created_local_date) VALUES (?, ?, 'van', ?, ?, ?, ?)").run(user, action, action === 'request' ? 'new' : null, cancelled ? at : null, at, at.slice(0, 10)).lastInsertRowid;
    db.prepare('INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, ?, ?)').run(id, name, qty); inv.record(id); return id;
  };
  const inv = require('../app/inventory');
  // Each office's shelf begins with what was counted: one opening movement into its own warehouse.
  for (const [o, n] of [[office, 50], [other, 20]]) inv.move({ branchId: o, catalogId: part, to: inv.warehouseOf(o).id, quantity: n, kind: 'opening' });
  const t1 = userId('sp.tech1'); const made = [];
  made.push(entry(t1, 'take', 'spd-100', 5, '2026-06-02T09:00:00.000Z'));           // counts: typed in small letters
  made.push(entry(t1, 'return', 'SPD-100', 2, '2026-06-03T09:00:00.000Z'));         // counts
  made.push(entry(t1, 'take', 'SPD-100', 7, '2026-06-04T09:00:00.000Z', true));     // cancelled: does not count
  made.push(entry(t1, 'request', 'SPD-100', 4, '2026-06-05T09:00:00.000Z'));        // a request moves nothing
  made.push(entry(away, 'take', 'SPD-100', 11, '2026-06-06T09:00:00.000Z'));        // the other office's shelf, not this one's
  const adjust = db.prepare("INSERT INTO stock_adjustments (catalog_id, quantity, reason, user_id, created_at, branch_id) VALUES (?, ?, 'Delivery', ?, '2026-06-07T09:00:00.000Z', ?)");
  adjust.run(part, 10, t1, office); adjust.run(part, 3, away, other);
  inv.move({ branchId: office, catalogId: part, to: inv.warehouseOf(office).id, quantity: 10, kind: 'receive' }); inv.move({ branchId: other, catalogId: part, to: inv.warehouseOf(other).id, quantity: 3, kind: 'receive' });
  const mine = stock.list(office).find((r) => r.part_number === 'SPD-100'); const theirs = stock.list(other).find((r) => r.part_number === 'SPD-100');
  assert.equal(mine.on_hand, 50 + 10 - 5 + 2); assert.equal(mine.low, true);
  assert.equal(theirs.on_hand, 20 + 3 - 11); assert.equal(theirs.low, false);
  assert.equal(stock.forNames(office, [' spd-100 ', 'NOT-A-PART'])[0].on_hand, 57); assert.equal(stock.forNames(office, ['NOT-A-PART']).length, 0);
  assert.equal(stock.lowCount(office), 1); assert.equal(stock.list(office, { q: 'strobe' }).length, 1); assert.equal(stock.list(office, { q: 'nothing like it' }).length, 0);
  db.transaction(() => {
    db.prepare('DELETE FROM inv_moves WHERE catalog_id = ?').run(part);
    db.prepare(`DELETE FROM parts_submissions WHERE id IN (${made.join(',')})`).run(); db.prepare('DELETE FROM stock_adjustments WHERE catalog_id = ?').run(part);
    db.prepare('DELETE FROM branch_stock WHERE catalog_id = ?').run(part); db.prepare('DELETE FROM parts_catalog WHERE id = ?').run(part);
  })();
});

test('alerts: who is told about a parts request or a truck problem is unchanged, and found without going through everyone with alerts on', async () => {
  const push = require('../app/push'); speedOffice();
  const far = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Speed Alertville', ?)").run(new Date().toISOString()).lastInsertRowid;
  const now = new Date().toISOString();
  const addUser = db.prepare("INSERT INTO users (username, display_name, password_hash, must_change_password, active, created_at, profile_id, branch_id) VALUES (?, ?, 'x', 0, 1, ?, ?, ?)");
  const farIds = []; for (let i = 0; i < 50; i++) farIds.push(addUser.run(`spdalert${i}`, `Alex Alertville ${i}`, now, profileId(i === 0 ? 'Office lead' : i === 1 ? 'Manager' : 'Technician'), far).lastInsertRowid);
  const sub = db.prepare("INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, 'k', 'a', 'Phone', ?)");
  const mine = ['sp.admin', 'sp.mgr', 'sp.sub', 'sp.tech1', 'sp.tech2'].map(userId);
  for (const id of [...farIds, ...mine]) sub.run(id, `https://push.invalid/speed/${id}`, now);
  // An old link from before offices were kept apart: a manager elsewhere with one of this office's people on their team.
  db.prepare('INSERT INTO user_managers (manager_id, user_id) VALUES (?, ?)').run(farIds[1], userId('sp.tech2'));

  // The rule, spelled out the long way: everyone with alerts on, one by one.
  const longWay = (perm, ownerId, exceptId) => db.prepare('SELECT DISTINCT u.* FROM users u JOIN push_subscriptions s ON s.user_id = u.id WHERE u.active = 1').all()
    .map((u) => access.loadAccess(u)).filter((u) => u.id !== exceptId && access.can(u, perm) && (ownerId === undefined || access.canSee(u, ownerId))).map((u) => u.id);
  const sorted = (a) => [...a].sort((x, y) => x - y);
  const [boss, mgr, under, t1, t2] = mine;
  // A technician's request reaches the office's admin and every manager above them, however many levels up; nobody in another office.
  assert.deepEqual(sorted(push.peopleWith('parts.manage', t1, t1)), sorted([boss, mgr, under]));
  assert.deepEqual(sorted(push.peopleWith('parts.manage', t2, t2)), sorted([boss, farIds[1]]));
  assert.deepEqual(sorted(push.peopleWith('parts.manage', boss, boss)), []);          // nobody else in the office holds it for the admin's own request
  for (const perm of ['parts.manage', 'inspections.view', 'stock.manage', 'tasks.assign', 'no.such.permission']) {
    for (const owner of [...mine, farIds[0], farIds[5], userId('tech1'), 987654]) {
      for (const args of [[perm, owner, owner], [perm, owner], [perm, owner, boss]]) assert.deepEqual(sorted(push.peopleWith(...args)), sorted(longWay(...args)), JSON.stringify(args));
    }
    assert.deepEqual(sorted(push.peopleWith(perm)), sorted(longWay(perm)));
  }
  // With 55 people's phones signed up, finding the three to tell takes a handful of questions, not a few for each phone.
  const asked = await watched(async () => { push.peopleWith('parts.manage', t1, t1); });
  assert.ok(asked.length < 40, `asked the database ${asked.length} times`);

  db.transaction(() => {
    db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE 'https://push.invalid/speed/%'").run();
    db.prepare('DELETE FROM user_managers WHERE manager_id = ?').run(farIds[1]);
    db.prepare('DELETE FROM users WHERE branch_id = ?').run(far); db.prepare('DELETE FROM branches WHERE id = ?').run(far);
  })();
});

test('People: past 500 the page says how many there are and goes on to the next page; long pickers and tables say when they stop', async () => {
  speedOffice(); const now = new Date().toISOString();
  const town = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Speed Bulkton', ?)").run(now).lastInsertRowid;
  const add = db.prepare("INSERT INTO users (username, display_name, password_hash, must_change_password, active, in_directory, created_at, branch_id, job_title) VALUES (?, ?, 'x', 1, 0, 1, ?, ?, 'Bulk Fitter')");
  db.transaction(() => { for (let i = 1; i <= 1010; i++) add.run(`spdbulk${i}`, `Zz Bulk ${String(i).padStart(4, '0')}`, now, town); })();
  const total = db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1 OR in_directory = 1').get().n;
  const pages = Math.ceil(total / 500); const count = (html) => (html.match(/<li><a href="\/people\/\d+">/g) || []).length;
  const t = await loggedIn('sp.tech1');

  // The first page says there are more, and every page leads to the next: the last person in the alphabet can be reached.
  const first = (await t.get('/people')).text;
  assert.match(first, new RegExp(`<p class="meta">Showing 1 to 500 of ${total} people</p>`)); assert.equal(count(first), 500);
  assert.match(first, /<a class="btn small" href="\/people\?page=2">Next<\/a>/); assert.doesNotMatch(first, />Previous</);
  const last = (await t.get(`/people?page=${pages}`)).text;
  assert.match(last, new RegExp(`Showing ${(pages - 1) * 500 + 1} to ${total} of ${total} people`)); assert.match(last, /Zz Bulk 1010/);
  assert.match(last, new RegExp(`href="/people\\?page=${pages - 1}">Previous</a>`)); assert.doesNotMatch(last, />Next</);
  assert.equal(count(first) + count(last) + (pages - 2) * 500, total);
  // Asking for a page that is not there gives the nearest one that is.
  assert.match((await t.get('/people?page=999')).text, /Zz Bulk 1010/); assert.match((await t.get('/people?page=nonsense')).text, /Showing 1 to 500 of/);
  // A search with many answers is paged the same way, and keeps the search as it goes.
  const found = (await t.get('/people?q=Zz+Bulk')).text;
  assert.match(found, new RegExp(`Showing 1 to 500 of 1010 people found, of ${total}</p>`)); assert.match(found, /href="\/people\?q=Zz\+Bulk&amp;page=2">Next<\/a>/);
  assert.match((await t.get('/people?q=Zz+Bulk&page=3')).text, /Showing 1001 to 1010 of 1010 people found/);
  assert.match((await t.get(`/people?branch=${town}&page=2`)).text, new RegExp(`href="/people\\?branch=${town}">Previous</a>[\\s\\S]*href="/people\\?branch=${town}&amp;page=3">Next</a>`));
  // A short list reads as it always did.
  assert.match((await t.get('/people?q=Tatum+Speedville')).text, new RegExp(`<p class="meta">1 person found, of ${total}</p>`));

  // Shout-outs: in a market this size the list is the person's own office; anyone else in the market is reached from their own page.
  const spMarket = db.prepare("INSERT INTO markets (name, created_at) VALUES ('Speed Valley', ?)").run(now).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id IN (?, ?)').run(spMarket, db.prepare("SELECT branch_id FROM users WHERE username = 'sp.tech1'").get().branch_id, town);
  const give = (html) => /<select name="to_user"[\s\S]*?<\/label>/.exec(html)[0];
  const picker = give((await t.get('/shoutouts')).text);
  assert.match(picker, /Morgan Speedville/); assert.match(picker, /Uri Speedville/); assert.doesNotMatch(picker, /Tatum Speedville|Zz Bulk|Terry Tech|optgroup/);
  assert.match(picker, /For someone in another office of your market, open their page from <a href="\/people">People<\/a> and choose Give a shout-out there\./);
  const one = db.prepare("SELECT id FROM users WHERE username = 'spdbulk7'").get().id;
  assert.match((await t.get(`/people/${one}`)).text, new RegExp(`href="/shoutouts\\?to=${one}#give"`));
  const chosen = give((await t.get(`/shoutouts?to=${one}`)).text);
  assert.match(chosen, new RegExp(`<optgroup label="Other offices in your market"><option value="${one}" selected>Zz Bulk 0007 · Speed Bulkton</option></optgroup>`)); assert.equal((chosen.match(/Zz Bulk/g) || []).length, 1);
  assert.equal((await t.post('/shoutouts', { to_user: String(one), message: 'BULKSHOUT thanks for the loan of the lift' }, { page: '/shoutouts' })).status, 302);
  assert.equal(db.prepare("SELECT to_user FROM shoutouts WHERE message LIKE 'BULKSHOUT%'").get().to_user, one);
  // A form sent back with a mistake still shows who was picked.
  const again = await t.post('/shoutouts', { to_user: String(one), message: '' }, { page: '/shoutouts' });
  assert.equal(again.status, 400); assert.match(give(again.text), new RegExp(`<option value="${one}" selected>`));
  // Someone outside the market is not offered, on their page or through the form.
  assert.doesNotMatch((await t.get(`/people/${userId('tech1')}`)).text, /Give a shout-out/);
  const outside = await t.post('/shoutouts', { to_user: String(userId('tech1')), message: 'BULKSHOUT too far' }, { page: '/shoutouts' });
  assert.equal(outside.status, 400); assert.match(outside.text, /Shout-outs are for people in your own office or your market\./);
  db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(spMarket); db.prepare('DELETE FROM markets WHERE id = ?').run(spMarket);

  // Positions for every office at once: the table stops at 1,000 and says so; one office is shown whole, with no notice.
  const owner = await loggedIn('owner');
  await owner.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
  const all = (await owner.get('/admin/users/positions')).text;
  assert.match(all, /Only the first 1000 people are listed here\. To work on everyone in one office, choose that office instead of Corporate\./);
  assert.equal((all.match(/<tr id="p\d+"/g) || []).length, 1000);
  await owner.post('/branch/view', { branch: String(town), back: '/' }, { page: '/' });
  const oneOffice = (await owner.get('/admin/users/positions')).text;
  assert.equal((oneOffice.match(/<tr id="p\d+"/g) || []).length, 1000); assert.match(oneOffice, /Only the first 1000 people are listed here\.<\/p>/);   // this one office is itself over the limit, and there is no other office to send them to
  await owner.post('/branch/view', { branch: String(speedOffice()), back: '/' }, { page: '/' });
  const small = (await owner.get('/admin/users/positions')).text;
  assert.equal((small.match(/<tr id="p\d+"/g) || []).length, 5); assert.doesNotMatch(small, /Only the first/);

  db.transaction(() => {
    db.prepare("DELETE FROM shoutouts WHERE message LIKE 'BULKSHOUT%'").run();
    db.prepare('DELETE FROM inv_locations WHERE branch_id = ?').run(town);
    db.prepare('DELETE FROM users WHERE branch_id = ?').run(town); db.prepare('DELETE FROM branches WHERE id = ?').run(town);
  })();
  // A market small enough for one list: the person's own office first, then the market's other offices, as two groups.
  // People outside the market are not in it at all.
  const smMarket = db.prepare("INSERT INTO markets (name, created_at) VALUES ('Speed Small Valley', ?)").run(now).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id IN (1, ?)').run(smMarket, db.prepare("SELECT branch_id FROM users WHERE username = 'sp.tech1'").get().branch_id);
  const small2 = give((await t.get('/shoutouts')).text);
  assert.match(small2, /<optgroup label="Your office">[\s\S]*Morgan Speedville · Speedville[\s\S]*<\/optgroup><optgroup label="Other offices in your market">[\s\S]*Terry Tech/);
  assert.doesNotMatch(small2, /For someone in another office/);
  db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(smMarket); db.prepare('DELETE FROM markets WHERE id = ?').run(smMarket);
  const alone = give((await t.get('/shoutouts')).text);
  assert.doesNotMatch(alone, /Terry Tech|optgroup/); assert.match(alone, /Morgan Speedville/);
  assert.match((await t.get('/people')).text, /<p class="meta">\d+ people<\/p>/);
});

test('task notes: the tidy for double-tapped notes runs once, and a note someone wrote again later is kept', () => {
  const L = encryptionLab();
  // A database from before this change: notes already in it, and no record that the tidy has been done.
  const seed = L.run(`const db = require('./app/db'); const auth = require('./app/auth');
    const a = auth.createUser({ username: 'note.a', displayName: 'Nora Notes', password: 'correct horse battery' });
    const b = auth.createUser({ username: 'note.b', displayName: 'Ned Notes', password: 'correct horse battery' });
    const t = db.prepare("INSERT INTO tasks (title, assigned_to, assigned_by, created_at) VALUES ('Call the customer', ?, ?, '2026-11-02T14:00:00.000Z')").run(a, b).lastInsertRowid;
    const add = db.prepare('INSERT INTO task_notes (task_id, user_id, status, body, created_at) VALUES (?, ?, NULL, ?, ?)');
    add.run(t, a, 'Called, no answer', '2026-11-02T14:00:00.000Z'); add.run(t, b, 'Try the site office', '2026-11-02T14:04:00.000Z');
    add.run(t, a, 'Called, no answer', '2026-11-02T14:08:00.000Z');       // written again on purpose, after someone else's note
    add.run(t, a, 'On my way', '2026-11-02T15:00:00.000Z'); add.run(t, a, 'On my way', '2026-11-02T15:00:20.000Z'); add.run(t, a, 'On my way', '2026-11-02T15:00:40.000Z');   // one note, tapped three times
    db.prepare("DELETE FROM meta WHERE key = 'task_notes_tidy_1'").run();
    console.log(db.prepare('SELECT COUNT(*) n FROM task_notes').get().n);`);
  assert.ok(seed.ok, seed.err); assert.equal(seed.out.trim().split('\n').pop(), '6');
  const NOTES = `const db = require('./app/db'); console.log(JSON.stringify(db.prepare("SELECT strftime('%H:%M:%S', created_at) || ' ' || body AS n FROM task_notes ORDER BY id").all().map((r) => r.n)));`;
  const notes = () => { const r = L.run(NOTES); assert.ok(r.ok, r.err); return JSON.parse(r.out.trim().split('\n').pop()); };
  // The next start tidies the triple tap and leaves the note that was written twice on purpose.
  const kept = ['14:00:00 Called, no answer', '14:04:00 Try the site office', '14:08:00 Called, no answer', '15:00:00 On my way'];
  assert.deepEqual(notes(), kept);
  // After that it never runs again: nothing a later restart finds is removed.
  const more = L.run(`const db = require('./app/db'); const n = db.prepare('SELECT task_id, user_id FROM task_notes ORDER BY id LIMIT 1').get();
    const add = db.prepare("INSERT INTO task_notes (task_id, user_id, status, body, created_at) VALUES (?, ?, NULL, 'Parts are in', ?)");
    add.run(n.task_id, n.user_id, '2026-11-03T09:00:00.000Z'); add.run(n.task_id, n.user_id, '2026-11-03T09:00:30.000Z');`);
  assert.ok(more.ok, more.err);
  assert.deepEqual(notes(), [...kept, '09:00:00 Parts are in', '09:00:30 Parts are in']);
  assert.deepEqual(notes(), [...kept, '09:00:00 Parts are in', '09:00:30 Parts are in']);
  fs.rmSync(L.dir, { recursive: true, force: true });
});

test('certification reminders are ticked off only when the email has really gone', async () => {
  const certs = require('../app/certs');
  const recorder = { sendMail: async (m) => { sent.push(m); } };
  const soon = (days) => { const d = new Date(`${require('../app/util').localDate()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const cora = makeUser('cert.cora', 'Cora Certwell'); db.prepare("UPDATE users SET email = 'cora@example.com' WHERE id = ?").run(cora);
  const ned = makeUser('cert.ned', 'Ned Noaddress');
  const add = (user, name, days) => db.prepare('INSERT INTO certifications (user_id, name, expires_on, created_at) VALUES (?, ?, ?, ?)').run(user, name, soon(days), new Date().toISOString()).lastInsertRowid;
  const c1 = add(cora, 'REMIND state license', 20); const c2 = add(ned, 'REMIND first aid', 20);
  const flags = (id) => db.prepare('SELECT reminded_30, reminded_7 FROM certifications WHERE id = ?').get(id);
  const mine = () => sent.filter((m) => /REMIND/.test(m.subject)).map((m) => [m.to, m.subject]);
  const untouched = db.prepare("SELECT COUNT(*) n FROM certifications WHERE reminded_30 = 1 OR reminded_7 = 1").get().n;
  try {
    // Email not set up, which is how a new site starts out: nothing can be sent, so nothing is used up.
    mail.setTransport(null); sent.length = 0;
    assert.equal(await certs.runReminders(), 0);
    assert.deepEqual(flags(c1), { reminded_30: 0, reminded_7: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM certifications WHERE reminded_30 = 1 OR reminded_7 = 1").get().n, untouched);
    // A mail server that refuses the message: still not ticked off, so it is tried again at the next pass.
    mail.setTransport({ sendMail: async (m) => { if (/REMIND/.test(m.subject)) throw new Error('mailbox unavailable'); sent.push(m); } });
    await certs.runReminders();
    assert.deepEqual(flags(c1), { reminded_30: 0, reminded_7: 0 }); assert.deepEqual(mine(), []);
  } finally { mail.setTransport(recorder); }
  // Email working: it goes once, and only then is it ticked off. Someone with no address on their account is not ticked off either.
  sent.length = 0; await certs.runReminders();
  assert.deepEqual(mine(), [['cora@example.com', 'REMIND state license expires in 20 days']]);
  assert.deepEqual(flags(c1), { reminded_30: 1, reminded_7: 0 }); assert.deepEqual(flags(c2), { reminded_30: 0, reminded_7: 0 });
  sent.length = 0; await certs.runReminders(); assert.deepEqual(mine(), []);
  // Once Ned has an address, his reminder goes too.
  db.prepare("UPDATE users SET email = 'ned@example.com' WHERE id = ?").run(ned);
  await certs.runReminders(); assert.deepEqual(mine(), [['ned@example.com', 'REMIND first aid expires in 20 days']]); assert.deepEqual(flags(c2), { reminded_30: 1, reminded_7: 0 });
  // The second reminder, inside the last week, works the same way.
  const later = new Date(Date.now() + 15 * 86400000);
  mail.setTransport(null);
  try { assert.equal(await certs.runReminders(later), 0); assert.deepEqual(flags(c1), { reminded_30: 1, reminded_7: 0 }); } finally { mail.setTransport(recorder); }
  sent.length = 0; await certs.runReminders(later);
  assert.deepEqual(mine().sort(), [['cora@example.com', 'REMIND state license expires in 5 days'], ['ned@example.com', 'REMIND first aid expires in 5 days']]);
  assert.deepEqual(flags(c1), { reminded_30: 1, reminded_7: 1 });
  db.prepare("DELETE FROM certifications WHERE name LIKE 'REMIND %'").run();

  // Reminders ticked off in the days when email was off and nothing went: cleared once, at the first start with this fix,
  // and only while email is still off. Ones for certifications already run out are left alone.
  const L = encryptionLab();
  const SEED = `const db = require('./app/db'); const auth = require('./app/auth');
    const u = auth.createUser({ username: 'cert.old', displayName: 'Olga Oldflag', password: 'correct horse battery' });
    const add = db.prepare('INSERT INTO certifications (user_id, name, expires_on, reminded_30, reminded_7, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    add.run(u, 'due soon', '${soon(10)}', 1, 0, '2026-01-01T00:00:00.000Z'); add.run(u, 'due this week', '${soon(3)}', 1, 1, '2026-01-01T00:00:00.000Z'); add.run(u, 'long gone', '2020-01-01', 1, 1, '2026-01-01T00:00:00.000Z');
    db.prepare("DELETE FROM meta WHERE key = 'cert_reminders_1'").run();`;
  const FLAGS = `const db = require('./app/db'); console.log(JSON.stringify(db.prepare('SELECT name, reminded_30 AS a, reminded_7 AS b FROM certifications ORDER BY id').all().map((c) => c.name + ' ' + c.a + c.b)));`;
  const state = (lab, extra) => { const r = lab.run(FLAGS, extra); assert.ok(r.ok, r.err); return JSON.parse(r.out.trim().split('\n').pop()); };
  assert.ok(L.run(SEED).ok);
  assert.deepEqual(state(L), ['due soon 00', 'due this week 00', 'long gone 11']);
  assert.ok(L.run(`require('./app/db').prepare("UPDATE certifications SET reminded_30 = 1 WHERE name = 'due soon'").run();`).ok);
  assert.deepEqual(state(L), ['due soon 10', 'due this week 00', 'long gone 11']);       // once only: a reminder sent later is not sent twice
  // Where email is already set up, the ticks may be real, so they stay.
  const M = encryptionLab();
  assert.ok(M.run(SEED).ok);
  assert.deepEqual(state(M, { SMTP_HOST: 'smtp.example.invalid' }), ['due soon 10', 'due this week 11', 'long gone 11']);
  assert.deepEqual(state(M), ['due soon 10', 'due this week 11', 'long gone 11']);
  for (const lab of [L, M]) fs.rmSync(lab.dir, { recursive: true, force: true });
});

test('spreadsheets: a very large export is the same file as before, put together a piece at a time', async () => {
  const csv = require('../app/csv');
  const header = ['Id', 'Name', 'Typed', 'Awkward', 'Empty', 'Accents'];
  const rows = Array.from({ length: 30000 }, (_, i) => [i, `Name ${i}`, i % 7 ? 'plain' : '=SUM(1,2)', 'has "quotes", a comma\nand a new line', null, 'é ü 漢']);
  const want = csv.toCsv(header, rows);
  const reply = () => { const r = { headers: {}, body: [], req: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.send = (b) => { r.sent = true; r.body.push(Buffer.from(b)); }; r.write = (b) => { r.body.push(b); }; r.end = () => { r.ended = true; }; return r; };
  // From a list, and from rows handed over one at a time (how the big exports now read the database).
  for (const source of [rows, csv.rowsFrom(rows.values(), (r) => r)]) {
    const r = reply(); csv.sendCsv(r, 'big.csv', header, source);
    assert.equal(Buffer.concat(r.body).toString('utf8'), want); assert.ok(r.body.length > 4 && r.ended);
    assert.equal(r.headers['Content-Length'], Buffer.byteLength(want)); assert.equal(r.headers['Content-Disposition'], 'attachment; filename="big.csv"');
  }
  // An ordinary export still goes out in one go.
  const small = reply(); csv.sendCsv(small, 'small.csv', header, rows.slice(0, 20));
  assert.equal(small.sent, true); assert.equal(small.body.length, 1); assert.equal(small.body[0].toString('utf8'), csv.toCsv(header, rows.slice(0, 20)));
  // Over the site: the parts and truck exports carry the same rows as before, and the log still says how many.
  speedOffice(); const boss = await loggedIn('sp.admin'); const t1 = userId('sp.tech1'); const now = new Date().toISOString();
  const sid = db.prepare("INSERT INTO parts_submissions (user_id, action, source, job_number, created_at, created_local_date) VALUES (?, 'take', 'job', 'CSVJOB', ?, ?)").run(t1, now, now.slice(0, 10)).lastInsertRowid;
  db.prepare("INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, 'CSV-PART-A', 2), (?, 'CSV-PART-B', 3)").run(sid, sid);
  const iid = db.prepare("INSERT INTO inspections (user_id, truck, odometer, problems, created_at, created_local_date) VALUES (?, 'CSV-TRUCK', '1200', 1, ?, ?)").run(t1, now, now.slice(0, 10)).lastInsertRowid;
  db.prepare("INSERT INTO inspection_results (inspection_id, label, ok, note) VALUES (?, 'Brakes', 0, 'soft pedal'), (?, 'Horn', 1, NULL)").run(iid, iid);
  const parts = await boss.get('/admin/parts.csv');
  assert.equal(parts.headers.get('content-type'), 'text/csv; charset=utf-8');
  const lines = (r) => r.text.replace(/^\ufeff/, '').trim().split('\r\n').slice(1).map((l) => l.replace(/^\d+,"[^"]*",/, ''));   // without the id and the time
  assert.deepEqual(lines(parts).map((l) => l.split(',').slice(0, 7).join(',')), ['Tatum Speedville,sp.tech1,Take parts,CSV-PART-A,2,Job,CSVJOB', 'Tatum Speedville,sp.tech1,Take parts,CSV-PART-B,3,Job,CSVJOB']);
  assert.deepEqual(lines(await boss.get('/admin/inspections.csv')), ['Tatum Speedville,CSV-TRUCK,1200,Brakes,Problem,soft pedal,Not yet,', 'Tatum Speedville,CSV-TRUCK,1200,Horn,OK,,,']);
  const logged = db.prepare("SELECT detail FROM activity_log WHERE action = 'Spreadsheet exported' AND user_id = ? ORDER BY id DESC LIMIT 2").all(userId('sp.admin')).map((r) => r.detail.replace(/\d{4}-\d\d-\d\d/, 'DAY'));
  assert.deepEqual(logged, ['truck-inspections-DAY.csv, 2 rows', 'parts-DAY.csv, 2 rows']);
  db.prepare('DELETE FROM parts_submissions WHERE id = ?').run(sid); db.prepare('DELETE FROM inspections WHERE id = ?').run(iid);
});

test('spreadsheets: an export that goes wrong part-way never leaves the site unable to save', async () => {
  const csv = require('../app/csv');
  const reply = () => { const r = { headers: {}, body: [], req: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.send = (b) => { r.body.push(Buffer.from(b)); }; r.write = (b) => { r.body.push(b); }; r.end = () => {}; return r; };
  const save = () => db.prepare("INSERT INTO meta (key, value) VALUES ('csv_probe', '1') ON CONFLICT(key) DO UPDATE SET value = value + 1").run();
  const people = 'SELECT id, username FROM users ORDER BY id';
  // The query is started only when the file is being put together, not when the rows are asked for.
  let started = 0;
  const rows = csv.rowsFrom(() => { started += 1; return db.prepare(people).iterate(); }, (u) => [u.id, u.username]);
  assert.equal(started, 0); save();
  const ok = reply(); csv.sendCsv(ok, 'people.csv', ['Id', 'Username'], rows);
  assert.equal(started, 1); assert.equal(ok.body[0].toString('utf8'), csv.toCsv(['Id', 'Username'], db.prepare(people).all().map((u) => [u.id, u.username]))); save();
  // A record that cannot be written stops that export only: the next thing anyone saves still goes in.
  let n = 0;
  assert.throws(() => csv.sendCsv(reply(), 'bad.csv', ['Id'], csv.rowsFrom(() => db.prepare(people).iterate(), (u) => { if (++n === 2) throw new Error('bad record'); return [u.id]; })), /bad record/);
  save();
  assert.throws(() => csv.sendCsv(reply(), 'bad.csv', ['Id'], csv.rowsFrom(() => db.prepare(people).iterate(), (u) => u.id)));   // a row that is not a list of cells
  save();
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'csv_probe'").get().value, '4');
  db.prepare("DELETE FROM meta WHERE key = 'csv_probe'").run();
  // Over the site: both big exports, then a form saved straight afterwards.
  speedOffice(); const boss = await loggedIn('sp.admin');
  for (const p of ['/admin/parts.csv', '/admin/inspections.csv', '/admin/parts.csv?from=2020-01-01&sort=name', '/admin/inspections.csv?show=open']) { const r = await boss.get(p); assert.equal(r.status, 200, p); assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8'); }
  const t = await loggedIn('sp.tech1');
  assert.equal((await t.post('/shoutouts', { to_user: String(userId('sp.tech2')), message: 'CSVPROBE thanks' }, { page: '/shoutouts' })).status, 302);
  assert.equal(db.prepare("DELETE FROM shoutouts WHERE message = 'CSVPROBE thanks'").run().changes, 1);
});

test('certification reminders: a record given a new date while its email was going out starts again', async () => {
  const certs = require('../app/certs');
  const recorder = { sendMail: async (m) => { sent.push(m); } };
  const day = (n) => { const d = new Date(`${require('../app/util').localDate()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const who = makeUser('cert.renew', 'Rena Renewed'); db.prepare("UPDATE users SET email = 'rena@example.com' WHERE id = ?").run(who);
  const id = db.prepare('INSERT INTO certifications (user_id, name, expires_on, created_at) VALUES (?, ?, ?, ?)').run(who, 'RENEW backflow license', day(20), new Date().toISOString()).lastInsertRowid;
  // The record is renewed (as the Certifications page does it: new date, reminders start again) while the reminder is on its way.
  mail.setTransport({ sendMail: async (m) => { if (/RENEW/.test(m.subject)) db.prepare('UPDATE certifications SET expires_on = ?, reminded_30 = 0, reminded_7 = 0 WHERE id = ?').run(day(385), id); sent.push(m); } });
  try { await certs.runReminders(); } finally { mail.setTransport(recorder); }
  assert.deepEqual(db.prepare('SELECT expires_on, reminded_30, reminded_7 FROM certifications WHERE id = ?').get(id), { expires_on: day(385), reminded_30: 0, reminded_7: 0 });
  // So next year's reminder still goes, once.
  const nextYear = new Date(Date.now() + 365 * 86400000); sent.length = 0;
  await certs.runReminders(nextYear); await certs.runReminders(nextYear);
  assert.deepEqual(sent.filter((m) => /RENEW/.test(m.subject)).map((m) => m.to), ['rena@example.com']);
  assert.equal(db.prepare('SELECT reminded_30 FROM certifications WHERE id = ?').get(id).reminded_30, 1);
  db.prepare('DELETE FROM certifications WHERE id = ?').run(id);
});

// -- review: where the areas meet --
test('complaint trail: the page asks the site for nothing of its own, and neither the alerts call nor a profile picture is ever logged', async () => {
  const t = await loggedIn('tech1');
  // The header on a complaint page shows initials, so the browser does not fetch the person's own picture from it.
  db.prepare("UPDATE users SET photo_path = 'somephoto.jpg' WHERE username = 'tech1'").run();
  try {
    assert.match((await t.get('/parts')).text, new RegExp(`src="/people/photo/${userId('tech1')}\\?`));
    for (const page of ['/complaint', '/Complaint', '/complaint/status']) assert.doesNotMatch((await t.get(page)).text, /\/people\/photo\//, page);
  } finally { db.prepare("UPDATE users SET photo_path = NULL WHERE username = 'tech1'").run(); }
  // What a page does by itself never reaches the request log, so a lone line cannot point at the page around it.
  const from = logLines.length;
  await t.post('/push/attach', { endpoint: 'https://fcm.googleapis.com/fcm/send/nobody' }, { page: '/parts' });
  await t.get(`/people/photo/${userId('tech1')}`);
  await new Promise((r) => setTimeout(r, 30));
  const logged = logLines.slice(from).join('\n');
  assert.match(logged, /GET \/parts 200/);                                  // the page whose token was used is an ordinary page
  assert.doesNotMatch(logged, /push\/attach|people\/photo/);
  // The page's own script leaves the alerts call out on complaint pages, and says "still here" on the first key there.
  const js = (await t.get('/site.js')).text;
  assert.match(js, /\/\^\\\/complaint\/i\.test\(location\.pathname\)\) return;/);
  assert.match(js, /var last = \/\^\\\/complaint\/i\.test\(location\.pathname\) \? 0 : Date\.now\(\);/);
});

test('Positions and welcomes follow the Edit person rule; forms that answer with a new page are sent the ordinary way', async () => {
  access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all' && p !== 'backups'));
  const boss = makeUser('seam.master', 'Sam Master', { profile: 'Corporate admin', master: false });
  db.prepare("UPDATE users SET is_master = 0 WHERE id = ?").run(boss);
  const office = auth.createUser({ username: 'seam.office', displayName: 'Olly Office', password: 'correct horse battery', profile: 'Office admin (one office)' });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(office);
  const tech = makeUser('seam.tech', 'Tia Tech');
  const title = db.prepare('SELECT name FROM job_titles ORDER BY id LIMIT 1').get().name;
  const admin = await loggedIn('seam.office');
  const page = (await admin.get('/admin/users/positions')).text;
  // Someone on a fuller profile is listed but cannot be changed here; a technician can.
  assert.match(page, new RegExp(`<select name="job_${boss}" disabled `));
  assert.match(page, new RegExp(`<select name="job_${tech}"  aria-label`));
  await admin.post('/admin/users/positions', { [`job_${boss}`]: title, [`mgr_${boss}`]: String(tech), [`job_${tech}`]: title }, { page: '/admin/users/positions' });
  assert.equal(db.prepare('SELECT job_title FROM users WHERE id = ?').get(boss).job_title, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_managers WHERE user_id = ?').get(boss).n, 0);
  assert.equal(db.prepare('SELECT job_title FROM users WHERE id = ?').get(tech).job_title, title);
  // A welcome written for that person cannot be taken down by someone who could not edit them.
  db.prepare('INSERT INTO welcomes (user_id, intro, created_by, created_at) VALUES (?, ?, ?, ?)').run(boss, 'Welcome Sam', userId('owner'), new Date().toISOString());
  assert.equal((await admin.post(`/admin/users/${boss}/welcome`, { remove: '1' }, { page: '/admin/users' })).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM welcomes WHERE user_id = ?').get(boss).n, 1);
  // Reset password, Add an admin and Give a shout-out answer with a whole page (the temporary password is on it), so the page's script must not swap in a part of it.
  const owner = await loggedIn('owner');
  assert.match((await owner.get('/admin/users')).text, new RegExp(`action="/admin/users/${tech}/reset-password" data-no-live `));
  assert.match((await owner.get('/admin/branches')).text, /action="\/admin\/branches\/\d+\/admins" class="stack" data-no-live>/);
  assert.match((await owner.get('/shoutouts')).text, /<form method="post" action="\/shoutouts" class="card stack" id="give" data-no-live>/);
  // An entry with no person (a restore, a nightly backup) shows to people who see every office whichever office they are looking at, and to nobody else.
  db.prepare("INSERT INTO activity_log (user_id, action, detail, at) VALUES (NULL, 'Backup restored', 'SEAMCHECK portal-2026-01-01.db', ?)").run(new Date().toISOString());
  const branch = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  await owner.post('/branch/view', { branch_id: String(branch) }, { page: '/' });
  assert.match((await owner.get('/admin/activity?q=SEAMCHECK')).text, /SEAMCHECK portal-2026-01-01\.db/);
  assert.doesNotMatch((await admin.get('/admin/activity?q=SEAMCHECK')).text, /SEAMCHECK portal/);
  await owner.post('/branch/view', { branch_id: '' }, { page: '/' });
  db.prepare("DELETE FROM activity_log WHERE detail LIKE 'SEAMCHECK%'").run();
  db.prepare('DELETE FROM welcomes WHERE user_id = ?').run(boss);
});

test('reset addresses and keys: a duplicate entry never supplies an admin\'s email; the key box is never spell-checked; a backup carries no sign-in ids; a wrong restore setting is not repeated on the closed page', async () => {
  // An admin with no email on file, and an entry in the same name that anybody in the office could have added.
  const keepId = makeUser('seam.keeper', 'Kim Keeper', { profile: 'Admin' });
  const extraId = auth.createUser({ username: 'seam.keeper.dir', displayName: 'Kim Keeper', password: 'correct horse battery' });
  db.prepare("UPDATE users SET active = 0, in_directory = 1, email = 'someone.else@outside.example', phone = '717-555-0177' WHERE id = ?").run(extraId);
  const owner = await loggedIn('owner');
  assert.match((await owner.get('/admin/users')).text, /seam\.keeper\.dir/);
  assert.equal((await owner.post('/admin/users/duplicates', { keep: String(keepId), extra: String(extraId) }, { page: '/admin/users' })).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(extraId).n, 0);   // the extra entry is gone
  const kept = db.prepare('SELECT email, phone FROM users WHERE id = ?').get(keepId);
  assert.equal(kept.email, null);                                           // the reset address is not taken from the other entry
  assert.equal(kept.phone, '717-555-0177');                                 // the rest still is
  // The box for the saved key is one the page's spell checker leaves alone.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'views', 'admin_security.ejs'), 'utf8'), /<input name="key" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required>/);
  assert.match((await owner.get('/site.js')).text, /el\.getAttribute\('spellcheck'\) === 'false'/);
  // A backup holds no sign-in ids, in the sessions table or beside an alert registration.
  const backup = require('../app/backup'); const dbfile = require('../app/dbfile');
  const sid = db.prepare("SELECT sid FROM sessions WHERE json_extract(data, '$.userId') = ? ORDER BY expires DESC").get(userId('owner')).sid;
  db.prepare("INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at, sid) VALUES (?, 'https://fcm.googleapis.com/fcm/send/seam-sid', 'k', 'a', 'Phone', ?, ?)").run(userId('owner'), new Date().toISOString(), sid);
  const name = await backup.runBackup({ manual: true });
  const copy = dbfile.connect(path.join(backup.backupDir, name), '', { fileMustExist: true });
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.deepEqual(copy.prepare("SELECT sid FROM push_subscriptions WHERE endpoint LIKE '%/seam-sid'").all().map((r) => r.sid), [null]);
  } finally { copy.close(); }
  assert.equal(db.prepare("SELECT sid FROM push_subscriptions WHERE endpoint LIKE '%/seam-sid'").get().sid, sid);   // the live site keeps it
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE '%/seam-sid'").run();
  fs.rmSync(path.join(backup.backupDir, name), { force: true });
  // Whatever was typed into RESTORE_BACKUP by mistake is not shown to the world.
  const L = encryptionLab();
  try {
    assert.ok(L.run(L.SEED).ok);
    const typed = 'Qk3vX9pLm2Zr8TfYw1NcHs6Jd4Ga7UeBo5KiVtRx0Wz';
    const r = L.run("try { require('./app/db'); console.log('OPENED'); } catch (e) { console.log('STOPPED ' + e.message + ' ' + (e.advice || '')); }", { RESTORE_BACKUP: typed });
    const said = r.out + (r.err || '');
    assert.match(said, /STOPPED [\s\S]*RESTORE_BACKUP is not the name of one of the site's backups/);
    assert.doesNotMatch(said, new RegExp(typed));
  } finally { fs.rmSync(L.dir, { recursive: true, force: true }); }
});

// -- inventory --
test('inventory: each office has a main warehouse, a vehicle per technician and its own other locations; another office\'s are out of reach', async () => {
  const inv = require('../app/inventory');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  const other = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Invtown', ?)").run(new Date().toISOString()).lastInsertRowid;
  access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all' && p !== 'backups'));
  const away = auth.createUser({ username: 'inv.away', displayName: 'Avery Away', password: 'correct horse battery', profile: 'Office admin (one office)' });
  db.prepare('UPDATE users SET must_change_password = 0, branch_id = ? WHERE id = ?').run(other, away);
  const driver = makeUser('inv.driver', 'Dee Driver'); const walker = makeUser('inv.walker', 'Wes Walker');
  db.prepare("UPDATE users SET default_truck = '14' WHERE id = ?").run(driver);
  const owner = await loggedIn('owner'); const tech = await loggedIn('inv.driver'); const outsider = await loggedIn('inv.away');
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const page = '/admin/inventory';

  // The first look makes the warehouse, and a vehicle for everyone with a truck number on file. Looking again adds nothing.
  const first = (await owner.get(page)).text.replace(/\s+/g, ' ');
  assert.match(first, /<strong>Main warehouse<\/strong><\/a><\/td> <td>Main warehouse<\/td>/);
  assert.match(first, /<strong>Truck 14<\/strong><\/a><\/td> <td>Vehicle<\/td> <td>Dee Driver<\/td> <td class="num">0<\/td>/);
  await owner.get(page);
  const mine = () => db.prepare('SELECT kind, name, user_id, active FROM inv_locations WHERE branch_id = ? ORDER BY id').all(home);
  assert.equal(mine().filter((l) => l.kind === 'warehouse').length, 1);
  assert.equal(mine().filter((l) => l.user_id === driver).length, 1);

  // A technician sees no Inventory page; an admin of another office sees their own office's, never this one's.
  assert.equal((await tech.get(page)).status, 403);
  const truck = db.prepare("SELECT id FROM inv_locations WHERE user_id = ? AND kind = 'vehicle'").get(driver).id;
  assert.doesNotMatch((await outsider.get(page)).text, /<strong>Truck 14<|Dee Driver/);
  assert.equal((await outsider.get(`${page}/locations/${truck}`)).status, 404);
  assert.equal((await outsider.post(`${page}/locations/${truck}`, { name: 'Taken' }, { page })).status, 403);
  assert.equal((await outsider.post(`${page}/locations/${truck}/retire`, {}, { page })).status, 403);
  assert.equal(inv.location(truck).name, 'Truck 14');

  // Adding: a vehicle needs a person of this office who has none yet; names are not repeated; anything else is an "other" location.
  const add = (fields) => owner.post(`${page}/locations`, fields, { page });
  await add({ kind: 'vehicle', name: 'Truck 22', user_id: String(walker) });
  await add({ kind: 'vehicle', name: 'Truck 23', user_id: String(walker) });      // one vehicle a technician
  await add({ kind: 'vehicle', name: 'Truck 24', user_id: String(away) });        // someone from another office
  await add({ kind: 'custom', name: 'truck 22' });                                // that name is taken
  await add({ kind: 'custom', name: 'Job trailer' });
  assert.deepEqual(mine().map((l) => l.name).filter((n) => /^(Job trailer|Truck (14|22|23|24))$/i.test(n)).sort(), ['Job trailer', 'Truck 14', 'Truck 22']);
  assert.doesNotMatch((await outsider.get(page)).text, /Job trailer/);

  // Handing a vehicle over keeps what is in it. A location that holds parts cannot be put away; an empty one can, and comes back.
  const part = db.prepare("INSERT INTO parts_catalog (part_number, description, cost_cents, created_at) VALUES ('INV-1', 'Inventory test part', 250, ?)").run(new Date().toISOString()).lastInsertRowid;
  db.prepare("INSERT INTO inv_moves (branch_id, catalog_id, to_id, quantity, kind, user_id, created_at) VALUES (?, ?, ?, 6, 'opening', ?, ?)").run(home, part, truck, userId('owner'), new Date().toISOString());
  db.prepare("INSERT INTO inv_moves (branch_id, catalog_id, from_id, quantity, kind, user_id, created_at) VALUES (?, ?, ?, 2, 'use', ?, ?)").run(home, part, truck, driver, new Date().toISOString());
  const inside = (await owner.get(`${page}/locations/${truck}`)).text.replace(/\s+/g, ' ');
  assert.match(inside, /<strong>INV-1<\/strong><\/td><td>Inventory test part<\/td><td class="num"><strong>4<\/strong><\/td> <td class="num">\$2\.50<\/td><td class="num">\$10\.00<\/td>/);
  assert.match((await owner.get(page)).text.replace(/\s+/g, ' '), /Truck 14<\/strong><\/a><\/td> <td>Vehicle<\/td> <td>Dee Driver<\/td> <td class="num">1<\/td> <td class="num">4<\/td>/);
  await owner.post(`${page}/locations/${truck}/retire`, {}, { page });
  assert.equal(inv.location(truck).active, 1);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(walker);            // Wes has left; his empty truck is put away, then Dee's goes to nobody new
  const t22 = db.prepare("SELECT id FROM inv_locations WHERE name = 'Truck 22'").get().id;
  await owner.post(`${page}/locations/${t22}/retire`, {}, { page });
  assert.equal(inv.location(t22).active, 0);
  await owner.post(`${page}/locations/${t22}/restore`, {}, { page });
  assert.equal(inv.location(t22).active, 1);
  const heir = makeUser('inv.heir', 'Hal Heir');
  await owner.post(`${page}/locations/${truck}`, { name: 'Truck 14', user_id: String(heir) }, { page });
  assert.equal(inv.location(truck).user_id, heir);
  assert.equal(inv.contents(truck)[0].on_hand, 4);
  await owner.post(`${page}/locations/${truck}`, { name: 'Truck 14', user_id: String(away) }, { page });   // not to another office
  assert.equal(inv.location(truck).user_id, heir);
  const wh = db.prepare("SELECT id FROM inv_locations WHERE branch_id = ? AND kind = 'warehouse'").get(home).id;
  await owner.post(`${page}/locations/${wh}/retire`, {}, { page });
  assert.equal(inv.location(wh).active, 1);
  // The activity log says what was added, renamed and handed over.
  const log = db.prepare("SELECT action, detail FROM activity_log WHERE action LIKE 'Inventory location%' OR action = 'Vehicle handed over' ORDER BY id").all().map((r) => `${r.action}: ${r.detail}`);
  assert.ok(log.includes('Inventory location added: Truck 22 (vehicle, Wes Walker)')); assert.ok(log.includes('Vehicle handed over: Truck 14: now Hal Heir'));
  await owner.post('/branch/view', { branch: 'all' }, { page: '/' });
  db.prepare('DELETE FROM inv_moves WHERE catalog_id = ?').run(part); db.prepare('DELETE FROM parts_catalog WHERE id = ?').run(part);
});

test('inventory: taking and returning parts moves them between the warehouse and the technician\'s vehicle; a shortfall is allowed and flagged; edits, cancels and deletions follow', async () => {
  const inv = require('../app/inventory'); const stockLib = require('../app/stock');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  const van = makeUser('inv.van', 'Vera Van'); const foot = makeUser('inv.foot', 'Finn Foot');
  db.prepare("UPDATE users SET default_truck = '71' WHERE id = ?").run(van);
  const part = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES ('MOVE-1', 'Movement test part', ?)").run(new Date().toISOString()).lastInsertRowid;
  const wh = inv.warehouseOf(home).id; const truck = inv.vehicleOf(van).id;
  const owner = await loggedIn('owner'); const vera = await loggedIn('inv.van'); const finn = await loggedIn('inv.foot');
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const at = () => [inv.onHand(wh, part), inv.onHand(truck, part)];
  const send = (c, fields) => c.post('/parts', [['part_name', 'move-1'], ...Object.entries(fields)], { multipart: true, page: '/parts' });
  const last = () => db.prepare('SELECT id FROM parts_submissions ORDER BY id DESC').get().id;

  // A delivery into the warehouse, by hand, from the Inventory page. A technician cannot.
  assert.equal((await vera.post('/admin/inventory/moves', { from: 'delivery', to: String(wh), part_number: 'MOVE-1', quantity: '5' }, { page: '/parts' })).status, 403);
  await owner.post('/admin/inventory/moves', { from: 'delivery', to: String(wh), part_number: 'MOVE-1', quantity: '20', note: 'PO 77' }, { page: '/admin/inventory' });
  assert.deepEqual(at(), [20, 0]);
  // The form names the person's own vehicle and offers no choice. Only someone who looks after the stock picks a vehicle.
  const form = (await vera.get('/parts?action=take')).text;
  assert.match(form, /Your vehicle: <strong>Truck 71<\/strong>/); assert.doesNotMatch(form, /name="place"/); assert.doesNotMatch(form, /<label>Truck /);
  const plain = (await finn.get('/parts?action=take')).text;
  assert.doesNotMatch(plain, /Truck 71|name="place"/); assert.match(plain, /<label>Truck /);
  db.prepare("UPDATE users SET default_truck = '72' WHERE id = ?").run(userId('seam.keeper')); inv.ensureOffice(home);
  const keeper = (await (await loggedIn('seam.keeper')).get('/parts?action=take')).text;   // a manager with a vehicle of their own: the list, and no truck box
  assert.match(keeper, /<option value="">Truck 72 \(yours\)<\/option>/); assert.doesNotMatch(keeper, /<label>Truck /);
  assert.match((await owner.get('/parts?action=take')).text, new RegExp(`<select name="place">[\\s\\S]*?<option value="${truck}" >Truck 71 · Vera Van</option>`));
  // Van stock: out of the warehouse, into the vehicle. For a job: out of the vehicle. Back from a job: into the vehicle. Van stock handed back: to the warehouse.
  await send(vera, { action: 'take', source: 'van', quantity: '6' });                              assert.deepEqual(at(), [14, 6]);
  await send(vera, { action: 'take', source: 'job', job_number: 'J1', quantity: '4' });            assert.deepEqual(at(), [14, 2]);
  await send(vera, { action: 'return', source: 'job', job_number: 'J1', quantity: '1' });          assert.deepEqual(at(), [14, 3]);
  await send(vera, { action: 'return', source: 'van', quantity: '2' });                            assert.deepEqual(at(), [16, 1]);
  // Whoever looks after the stock can load someone else's vehicle from the form: warehouse to Vera's truck.
  await send(owner, { action: 'take', source: 'van', quantity: '3', place: String(truck) });       assert.deepEqual(at(), [13, 4]);
  // Someone with no vehicle takes from, and returns to, the warehouse. A request moves nothing. Naming someone else's vehicle does nothing for a technician.
  await send(finn, { action: 'take', source: 'job', job_number: 'J3', quantity: '2' });            assert.deepEqual(at(), [11, 4]);
  await send(finn, { action: 'take', source: 'van', quantity: '1', place: String(truck) });        assert.deepEqual(at(), [10, 4]);
  await send(finn, { action: 'request', source: 'van', quantity: '9', needed_by: '2031-01-01' });  assert.deepEqual(at(), [10, 4]);
  // More than the vehicle has on record: the work is not held up, and the movement is marked for the next count.
  await send(vera, { action: 'take', source: 'job', job_number: 'J4', quantity: '5' });            assert.deepEqual(at(), [10, -1]);
  const short = last();
  assert.equal(db.prepare('SELECT flagged FROM inv_moves WHERE submission_id = ?').get(short).flagged, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inv_moves WHERE flagged = 1 AND catalog_id = ?').get(part).n, 1);
  assert.match((await owner.get('/admin/inventory')).text.replace(/\s+/g, ' '), /Truck 71<\/strong>[\s\S]*?1 to check<\/span>/);
  assert.match((await owner.get(`/admin/inventory/locations/${truck}`)).text.replace(/\s+/g, ' '), /<strong>-5<\/strong><\/td> <td>Used[\s\S]*?To check<\/span>/);
  // Editing the entry remakes its movements; cancelling takes them away; so does deleting an entry for good.
  await vera.post(`/parts/${short}/edit`, [['part_name', 'MOVE-1'], ['quantity', '1'], ['source', 'job'], ['job_number', 'J4']], { multipart: true, page: `/parts/${short}/edit` });
  assert.deepEqual(at(), [10, 3]); assert.equal(db.prepare('SELECT flagged FROM inv_moves WHERE submission_id = ?').get(short).flagged, 0);
  await vera.post(`/parts/${short}/cancel`, {}, { page: '/my' });                                   assert.deepEqual(at(), [10, 4]);
  await send(vera, { action: 'take', source: 'van', quantity: '2' });                              assert.deepEqual(at(), [8, 6]);
  await owner.post(`/admin/parts/${last()}/delete`, {}, { page: `/admin/parts/${last()}` });        assert.deepEqual(at(), [10, 4]);
  // A part that is not in the catalog moves nothing, as before.
  await vera.post('/parts', [['part_name', 'Some loose fitting'], ['quantity', '3'], ['action', 'take'], ['source', 'van']], { multipart: true, page: '/parts' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inv_moves WHERE submission_id = ?').get(last()).n, 0);

  // The Stock page is the warehouse: tracking a part with a count, a delivery and a recount each leave the movements agreeing with it.
  await owner.post('/admin/stock', { part_number: 'MOVE-1', count: '12', min_level: '9' }, { page: '/admin/stock' });
  assert.deepEqual(at(), [12, 4]); assert.equal(stockLib.forNames(home, ['MOVE-1'])[0].on_hand, 12);
  await owner.post(`/admin/stock/${part}/adjust`, { quantity: '5', reason: 'Delivery' }, { page: `/admin/stock/${part}` });   assert.deepEqual(at(), [17, 4]);
  await owner.post(`/admin/stock/${part}/adjust`, { quantity: '-2', reason: 'Damaged' }, { page: `/admin/stock/${part}` });   assert.deepEqual(at(), [15, 4]);
  await owner.post(`/admin/stock/${part}/count`, { count: '11' }, { page: `/admin/stock/${part}` });                        assert.deepEqual(at(), [11, 4]);
  // Taking for a job out of the vehicle leaves the warehouse, and so the low-stock figure, alone; van stock from the warehouse lowers it.
  await send(vera, { action: 'take', source: 'job', job_number: 'J5', quantity: '1' });            assert.equal(stockLib.forNames(home, ['MOVE-1'])[0].on_hand, 11);
  await send(vera, { action: 'take', source: 'van', quantity: '3' });                              assert.equal(stockLib.list(home, { low: true }).find((r) => r.part_number === 'MOVE-1').on_hand, 8);
  // Moving by hand between two places; not to the same place, not an unknown part, not another office's place.
  const far = db.prepare("SELECT id FROM inv_locations WHERE branch_id <> ? LIMIT 1").get(home);
  const mv = (f) => owner.post('/admin/inventory/moves', f, { page: '/admin/inventory' });
  await mv({ from: String(wh), to: String(truck), part_number: 'MOVE-1', quantity: '2' });         assert.deepEqual(at(), [6, 8]);
  await mv({ from: String(wh), to: String(wh), part_number: 'MOVE-1', quantity: '2' });
  await mv({ from: String(wh), to: String(truck), part_number: 'NOPE-9', quantity: '2' });
  if (far) await mv({ from: String(wh), to: String(far.id), part_number: 'MOVE-1', quantity: '2' });
  assert.deepEqual(at(), [6, 8]);
  // A removed person's vehicle stays, with nobody's name on it, and what it holds stays in it.
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(van); require('../app/removal').remove(van);
  assert.equal(inv.location(truck).user_id, null); assert.equal(inv.onHand(truck, part), 8);
  await owner.post('/branch/view', { branch: 'all' }, { page: '/' });
});

test('inventory: what the Stock page showed on the shelf becomes each office\'s opening warehouse stock, once', () => {
  const L = encryptionLab();
  try {
    // An office as it stood before movements: a count, a delivery, a take and a return since, and a part that had run out.
    const SEEDED = `const db = require('./app/db'); const auth = require('./app/auth'); require('./app/app');
      const u = auth.createUser({ username: 'old.tech', displayName: 'Olga Old', password: 'correct horse battery', profile: 'Technician' });
      const b = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(u).branch_id; const t = '2026-06-01T12:00:00.000Z';
      const part = (n) => db.prepare("INSERT INTO parts_catalog (part_number, created_at) VALUES (?, ?)").run(n, t).lastInsertRowid;
      const a = part('OLD-A'), z = part('OLD-Z');
      db.prepare('INSERT INTO branch_stock (branch_id, catalog_id, count_qty, count_at) VALUES (?, ?, 30, ?)').run(b, a, t);
      db.prepare('INSERT INTO branch_stock (branch_id, catalog_id, count_qty, count_at) VALUES (?, ?, 0, ?)').run(b, z, t);
      db.prepare("INSERT INTO stock_adjustments (catalog_id, quantity, user_id, created_at, branch_id) VALUES (?, 10, ?, '2026-06-02T12:00:00.000Z', ?)").run(a, u, b);
      const entry = (action, qty) => { const id = db.prepare("INSERT INTO parts_submissions (user_id, action, source, created_at, created_local_date) VALUES (?, ?, 'van', '2026-06-03T12:00:00.000Z', '2026-06-03')").run(u, action).lastInsertRowid;
        db.prepare('INSERT INTO parts_items (submission_id, part_name, quantity) VALUES (?, ?, ?)').run(id, 'old-a', qty); };
      entry('take', 7); entry('return', 2);
      db.prepare("DELETE FROM inv_moves").run(); db.prepare("DELETE FROM meta WHERE key = 'inv_opening_1'").run(); console.log('seeded');`;
    assert.match(L.run(SEEDED).out, /seeded/);
    const LOOK = `const db = require('./app/db'); require('./app/app'); const stock = require('./app/stock'); const b = db.prepare("SELECT branch_id FROM users WHERE username = 'old.tech'").get().branch_id;
      console.log(JSON.stringify({ shelf: stock.list(b).map((r) => [r.part_number, r.on_hand]), moves: db.prepare('SELECT kind, quantity FROM inv_moves ORDER BY id').all() }));`;
    const first = JSON.parse(L.run(LOOK).out.trim().split('\n').pop());
    assert.deepEqual(first.shelf, [['OLD-A', 35], ['OLD-Z', 0]]);           // 30 counted + 10 delivered - 7 taken + 2 returned
    assert.deepEqual(first.moves, [{ kind: 'opening', quantity: 35 }]);
    assert.deepEqual(JSON.parse(L.run(LOOK).out.trim().split('\n').pop()), first);   // a second start adds nothing
  } finally { fs.rmSync(L.dir, { recursive: true, force: true }); }
});

test('inventory: a count sets what was counted against the records, closing corrects the records and keeps the month as it stood', async () => {
  const inv = require('../app/inventory'); const counts = require('../app/invcount');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  db.prepare("DELETE FROM inv_audits WHERE branch_id = ?").run(home);
  const driver = makeUser('cnt.driver', 'Cam Counter'); const walker = makeUser('cnt.walker', 'Wyn Walker');
  db.prepare("UPDATE users SET default_truck = '88' WHERE id = ?").run(driver);
  const t = new Date().toISOString();
  const p1 = db.prepare("INSERT INTO parts_catalog (part_number, description, cost_cents, created_at) VALUES ('CNT-1', 'Count test part', 250, ?)").run(t).lastInsertRowid;
  const p2 = db.prepare("INSERT INTO parts_catalog (part_number, description, cost_cents, created_at) VALUES ('CNT-2', 'Found on the shelf', 1000, ?)").run(t).lastInsertRowid;
  const wh = inv.warehouseOf(home).id; const truck = inv.vehicleOf(driver).id;
  const owner = await loggedIn('owner'); const cam = await loggedIn('cnt.driver'); const wyn = await loggedIn('cnt.walker'); const outsider = await loggedIn('inv.away');
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const send = (c, fields) => c.post('/parts', [['part_name', 'CNT-1'], ...Object.entries(fields)], { multipart: true, page: '/parts' });
  await owner.post('/admin/inventory/moves', { from: 'delivery', to: String(wh), part_number: 'CNT-1', quantity: '20' }, { page: '/admin/inventory' });
  await send(cam, { action: 'take', source: 'van', quantity: '6' }); await send(cam, { action: 'take', source: 'job', job_number: 'C1', quantity: '9' });
  assert.deepEqual([inv.onHand(wh, p1), inv.onHand(truck, p1)], [14, -3]);
  const bell = (html) => (/<details class="bell"[\s\S]*?<\/details>/.exec(html) || [''])[0];

  // Only someone who can close the month starts a count; one at a time.
  const page = '/admin/inventory/count'; const P = { page: '/admin/inventory' };
  assert.equal((await cam.get(page)).status, 403);
  assert.equal((await cam.post(page, { month: '2031-02' }, { page: '/parts' })).status, 403);
  assert.doesNotMatch(bell((await cam.get('/')).text), /vehicle to count/);
  const started = await owner.post(page, { month: '2031-02' }, P);
  const audit = db.prepare("SELECT * FROM inv_audits WHERE branch_id = ? AND status = 'open'").get(home);
  assert.equal(started.location, `${page}/${audit.id}`);
  await owner.post(page, { month: '2031-03' }, P);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inv_audits WHERE branch_id = ?').get(home).n, 1);

  // A technician is asked, on the bell, to count their own vehicle, and can count that and nothing else. Another office cannot look in.
  assert.match(bell((await cam.get('/')).text), new RegExp(`href="${page}/${audit.id}/${truck}"[^>]*>[\\s\\S]*?vehicle to count`));
  assert.doesNotMatch(bell((await wyn.get('/')).text), /vehicle to count/);
  const sheet = (await cam.get(`${page}/${audit.id}/${truck}`)).text;
  assert.match(sheet, /<h1>Count: Truck 88<\/h1>/); assert.match(sheet, new RegExp(`name="qty_${p1}" value=""`));
  assert.doesNotMatch(sheet, />-3</);                                       // the sheet does not say what the records expect
  assert.equal((await cam.get(`${page}/${audit.id}/${wh}`)).status, 403);
  assert.equal((await wyn.get(`${page}/${audit.id}/${truck}`)).status, 403);
  assert.equal((await wyn.post(`${page}/${audit.id}/${truck}`, { [`qty_${p1}`]: '99' }, { page: '/parts' })).status, 403);
  for (const url of [`${page}/${audit.id}`, `${page}/${audit.id}/${truck}`]) assert.equal((await outsider.get(url)).status, 403, url);
  await cam.post(`${page}/${audit.id}/${truck}`, { [`qty_${p1}`]: '2' }, { page: `${page}/${audit.id}/${truck}` });
  assert.deepEqual({ ...db.prepare('SELECT expected, counted, counted_by FROM inv_counts WHERE audit_id = ? AND location_id = ?').get(audit.id, truck) }, { expected: -3, counted: 2, counted_by: driver });
  // Saving keeps the progress and nothing more: the vehicle is still theirs to count, and it is not shown as done.
  assert.match(bell((await cam.get('/')).text), /vehicle to count/);
  const row = (html, name) => (new RegExp(`<td><strong>${name}</strong></td>[\\s\\S]*?</tr>`).exec(html) || [''])[0];
  assert.match(row((await owner.get(`${page}/${audit.id}`)).text, 'Truck 88'), /<span class="tag request">In progress<\/span>/);
  const mid = (await cam.get(`${page}/${audit.id}/${truck}`)).text;
  assert.match(mid, new RegExp(`name="qty_${p1}" value="2"`));                 // what was saved is there to carry on from
  assert.match(mid, />Save and come back later<\/button>/); assert.match(mid, /name="finish" value="1"[^>]*>Save and mark as finished<\/button>/);
  // Finishing is its own button. Only then is it done, and the reminder goes.
  assert.equal((await cam.post(`${page}/${audit.id}/${truck}`, { [`qty_${p1}`]: '2', finish: '1' }, { page: `${page}/${audit.id}/${truck}` })).location, '/');
  assert.doesNotMatch(bell((await cam.get('/')).text), /vehicle to count/);
  assert.match(row((await owner.get(`${page}/${audit.id}`)).text, 'Truck 88'), /<span class="tag return"[^>]*>Done<\/span>/);
  const after = (await cam.get(`${page}/${audit.id}/${truck}`)).text;
  assert.match(after, /Marked as finished by /); assert.match(after, /name="finish" value="reopen"[^>]*>Not finished after all<\/button>/);
  // It can be opened again, and finished again.
  await cam.post(`${page}/${audit.id}/${truck}`, { [`qty_${p1}`]: '2', finish: 'reopen' }, { page: `${page}/${audit.id}/${truck}` });
  assert.match(bell((await cam.get('/')).text), /vehicle to count/);
  await cam.post(`${page}/${audit.id}/${truck}`, { [`qty_${p1}`]: '2', finish: '1' }, { page: `${page}/${audit.id}/${truck}` });

  // The warehouse: a count, a part found that the records did not have there, and the mistakes a person makes.
  const whSheet = `${page}/${audit.id}/${wh}`;
  assert.equal((await owner.post(whSheet, { [`qty_${p1}`]: 'lots' }, { page: whSheet })).status, 400);
  assert.match((await owner.post(whSheet, { [`qty_${p1}`]: '13', add_part: 'NOT-REAL', add_qty: '' }, { page: whSheet })).text, /Enter how many of NOT-REAL there are/);
  await owner.post(whSheet, { [`qty_${p1}`]: '13', add_part: 'cnt-2', add_qty: '4' }, { page: whSheet });
  assert.match((await owner.get(whSheet)).text, new RegExp(`name="qty_${p2}" value="4"`));
  // Every warehouse part has a number now, but nobody has said the warehouse is finished: it is in progress, and closing says so.
  const midway = (await owner.get(`${page}/${audit.id}`)).text;
  assert.match(row(midway, 'Main warehouse'), /<span class="tag request">In progress<\/span>/); assert.doesNotMatch(row(midway, 'Main warehouse'), />Done</);
  assert.match(midway, /Not marked as finished yet: [^<]*Main warehouse/);
  const view = (await owner.get(`${page}/${audit.id}`)).text.replace(/\s+/g, ' ');
  assert.match(view, /3 parts counted so far, <strong>3 different from the records<\/strong>/);
  assert.match(view, /<td>Truck 88<\/td><td><strong>CNT-1<\/strong>[\s\S]*?<td class="num">-3<\/td><td class="num">2<\/td><td class="num"><strong>\+5<\/strong><\/td> <td class="num">\$12\.50<\/td>/);
  assert.match(view, /The differences come to \$50\.00 at today's costs\./);          // +5 and -1 at $2.50, +4 at $10.00
  assert.doesNotMatch((await wyn.get('/admin/inventory')).text || '', /Monthly count/);

  // Parts keep moving while the count is open. Closing corrects each place by what the count found, on top of that.
  await send(cam, { action: 'take', source: 'van', quantity: '1' });
  assert.deepEqual([inv.onHand(wh, p1), inv.onHand(truck, p1)], [13, -2]);
  assert.equal((await cam.post(`${page}/${audit.id}/close`, {}, { page: '/parts' })).status, 403);
  db.prepare("UPDATE sessions SET data = json_remove(data, '$.pwAt') WHERE json_extract(data, '$.userId') = ?").run(userId('owner'));
  await owner.post(`${page}/${audit.id}/close`, {}, { page: `${page}/${audit.id}` });                  // the password has to have been typed lately
  assert.equal(counts.get(audit.id).status, 'open');
  await owner.post('/account/confirm', { password: 'correct horse battery', next: `${page}/${audit.id}` }, { page: `${page}/${audit.id}` });
  await owner.post(`${page}/${audit.id}/close`, {}, { page: `${page}/${audit.id}` });
  assert.equal(counts.get(audit.id).status, 'closed');
  assert.deepEqual([inv.onHand(wh, p1), inv.onHand(truck, p1), inv.onHand(wh, p2)], [12, 3, 4]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inv_moves WHERE from_id = ? AND flagged = 1').get(truck).n, 0);   // what was "to check" is settled
  const figures = () => counts.closedFigures(audit.id).filter((r) => /^CNT-/.test(r.part_number)).map((r) => [r.location, r.part_number, r.quantity, r.cost_cents]);
  assert.deepEqual(figures(), [['Main warehouse', 'CNT-1', 12, 250], ['Main warehouse', 'CNT-2', 4, 1000], ['Truck 88', 'CNT-1', 3, 250]]);

  // A closed month stays as it was: later movements, a new cost and another try at counting change nothing in it.
  await send(cam, { action: 'take', source: 'job', job_number: 'C2', quantity: '2' });
  db.prepare('UPDATE parts_catalog SET cost_cents = 999 WHERE id = ?').run(p1);
  await cam.post(`${page}/${audit.id}/${truck}`, { [`qty_${p1}`]: '50' }, { page: '/parts' });
  assert.equal(inv.onHand(truck, p1), 1); assert.deepEqual(figures()[2], ['Truck 88', 'CNT-1', 3, 250]);
  const closed = (await owner.get(`${page}/${audit.id}`)).text.replace(/\s+/g, ' ');
  assert.match(closed, /<h1>Inventory, February 2031<\/h1>/); assert.match(closed, /<td>Truck 88<\/td><td><strong>CNT-1<\/strong><\/td><td>Count test part<\/td><td class="num">3<\/td> <td class="num">\$2\.50<\/td><td class="num">\$7\.50<\/td>/);
  assert.match((await owner.get(page)).text, /<strong>February 2031<\/strong>/);
  await owner.post(page, { month: '2031-02' }, P);                                             // that month is done
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inv_audits WHERE branch_id = ?').get(home).n, 1);
  // Setting a count aside throws away what was counted and changes nothing else.
  await owner.post(page, { month: '2031-03' }, P);
  const next = counts.open(home);
  await owner.post(`${page}/${next.id}/${wh}`, { [`qty_${p1}`]: '0' }, { page: `${page}/${next.id}/${wh}` });
  await owner.post(`${page}/${next.id}/discard`, {}, { page: `${page}/${next.id}` });
  assert.equal(counts.open(home), null); assert.equal(inv.onHand(wh, p1), 12);
  const log = db.prepare("SELECT action, detail FROM activity_log WHERE action LIKE 'Inventory count%' ORDER BY id").all().map((r) => `${r.action}: ${r.detail}`);
  assert.ok(log.includes('Inventory count closed: February 2031: 3 counted, 3 corrected'));
  await owner.post('/branch/view', { branch: 'all' }, { page: '/' });
});

test('inventory: the office\'s inventory can be exported as it stands: by location, as totals, one location by itself, and every office for corporate', async () => {
  const inv = require('../app/inventory');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  const other = db.prepare("SELECT id FROM branches WHERE name = 'Invtown'").get().id;
  const t = new Date().toISOString();
  const part = db.prepare("INSERT INTO parts_catalog (part_number, description, cost_cents, created_at) VALUES ('EXP-1', 'Export test, \"quoted\"', 1250, ?)").run(t).lastInsertRowid;
  const bare = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES ('EXP-2', 'No cost on file', ?)").run(t).lastInsertRowid;
  const driver = makeUser('exp.driver', 'Ed Export'); db.prepare("UPDATE users SET default_truck = '55' WHERE id = ?").run(driver);
  const wh = inv.warehouseOf(home).id; const truck = inv.vehicleOf(driver).id; const trailer = inv.addCustom(home, 'Export trailer'); const far = inv.warehouseOf(other).id;
  const put = (branchId, to, catalogId, quantity) => inv.move({ branchId, catalogId, to, quantity, kind: 'receive' });
  put(home, wh, part, 10); put(home, truck, part, 3); put(home, trailer, part, 2); put(home, wh, bare, 4); put(other, far, part, 7);
  inv.move({ branchId: home, catalogId: bare, from: truck, quantity: 1, kind: 'use' });          // a vehicle the records have gone below zero on
  const owner = await loggedIn('owner'); const tech = await loggedIn('exp.driver'); const outsider = await loggedIn('inv.away');
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const lines = async (c, url) => { const r = await c.get(url); assert.equal(r.status, 200, url); return r.text.replace(/^﻿/, '').trim().split('\r\n'); };
  const mine = (rows) => rows.filter((l) => /EXP-/.test(l));

  // By location: one line per part in each place, with what one costs and what the lot is worth.
  const byPlace = await lines(owner, '/admin/inventory/export.csv');
  assert.equal(byPlace[0], 'Office,Location,Kind,Technician,Part number,Description,On hand,Cost each,Value');
  const office = db.prepare('SELECT name FROM branches WHERE id = ?').get(home).name;
  assert.deepEqual(mine(byPlace), [
    `${office},Main warehouse,Main warehouse,,EXP-1,"Export test, ""quoted""",10,12.50,125.00`,
    `${office},Main warehouse,Main warehouse,,EXP-2,No cost on file,4,,`,
    `${office},Truck 55,Vehicle,Ed Export,EXP-1,"Export test, ""quoted""",3,12.50,37.50`,
    `${office},Truck 55,Vehicle,Ed Export,EXP-2,No cost on file,-1,,`,
    `${office},Export trailer,Other,,EXP-1,"Export test, ""quoted""",2,12.50,25.00`]);
  // Totals: one line per part, split between the warehouse, the vehicles and anywhere else.
  const totals = await lines(owner, '/admin/inventory/export.csv?view=totals');
  assert.equal(totals[0], 'Office,Part number,Description,On hand in all,Main warehouse,Vehicles,Other locations,Cost each,Value');
  assert.deepEqual(mine(totals), [`${office},EXP-1,"Export test, ""quoted""",15,10,3,2,12.50,187.50`, `${office},EXP-2,No cost on file,3,4,-1,0,,`]);
  // One location by itself.
  assert.deepEqual(mine(await lines(owner, `/admin/inventory/locations/${truck}/export.csv`)).map((l) => l.split(',')[1]), ['Truck 55', 'Truck 55']);
  // Every office, for someone who sees them all; another office's admin gets only their own, and never this office's location.
  assert.ok(mine(await lines(owner, '/admin/inventory/export.csv?office=all')).some((l) => l.startsWith('Invtown,Main warehouse')));
  assert.deepEqual(mine(await lines(outsider, '/admin/inventory/export.csv?office=all')), ['Invtown,Main warehouse,Main warehouse,,EXP-1,"Export test, ""quoted""",7,12.50,87.50']);
  assert.equal((await outsider.get(`/admin/inventory/locations/${truck}/export.csv`)).status, 403);
  // A technician cannot export, and has no buttons for it; every export is written in the activity log.
  for (const url of ['/admin/inventory/export.csv', `/admin/inventory/locations/${truck}/export.csv`]) assert.equal((await tech.get(url)).status, 403, url);
  assert.match((await owner.get('/admin/inventory')).text, /href="\/admin\/inventory\/export\.csv">Export by location<\/a>/);
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'Spreadsheet exported' AND detail LIKE 'inventory-%-totals-%'").get());
  await owner.post('/branch/view', { branch: 'all' }, { page: '/' });
  db.prepare('DELETE FROM inv_moves WHERE catalog_id IN (?, ?)').run(part, bare);
});

test('alerts: someone signed in is offered alerts on any page, with what the device needs to register; nobody signed out is', async () => {
  const t = await loggedIn('tech1');
  const home = (await t.get('/')).text;
  assert.match(home, /<meta name="push-key" content="[A-Za-z0-9_-]{60,}">/);
  assert.match(home, /<aside class="install-bar no-print" id="alerts-bar" hidden aria-label="Turn on alerts">[\s\S]*?id="alerts-go">Turn on<\/button>/);
  assert.match(home, /<script src="\/alerts-prompt\.js\?v=[^"]+" defer><\/script>/);
  const out = (await new Client().get('/login')).text;
  assert.doesNotMatch(out, /name="push-key"/);
  const js = (await t.get('/alerts-prompt.js')).text;
  assert.match(js, /Notification\.requestPermission\(\)/); assert.match(js, /\/push\/subscribe/);
  assert.match(js, /\^\\\/\(complaint\|settings\\\/notifications\|unlock\)/);       // never on a complaint page
  assert.match((await t.get('/sw.js')).text, /'\/alerts-prompt\.js'/);
  // The mark in a phone's status bar is the flame by itself on a see-through background; a full-colour icon there shows as a white square.
  assert.match((await t.get('/sw.js')).text, /badge: '\/icons\/badge-96\.png'/);
  const badge = await fetch(base + '/icons/badge-96.png'); assert.equal(badge.status, 200); assert.equal(badge.headers.get('content-type'), 'image/png');
});

test('view as: the master account and corporate admins can look at the site as another profile sees it, and get back; nobody else can, and it never adds anything', async () => {
  const tech = profileId('Technician'); const corp = access.profileByName('Corporate admin');
  const master = makeUser('va.master', 'Mia Master', { master: true });
  const m = await loggedIn('va.master');
  const menu = (html) => [...(/<nav class="nav"[\s\S]*?<\/nav>/.exec(html) || [''])[0].matchAll(/<a href="(\/admin\/[a-z/]+)"/g)].map((x) => x[1]);
  const before = (await m.get('/')).text;
  assert.ok(menu(before).includes('/admin/users')); assert.match(before, /<select name="profile" data-autosubmit>/);
  assert.doesNotMatch(before, /You are looking at the site as/);
  // As a technician: the banner says so, the admin menu and admin pages are gone, and the way back is on every page.
  assert.equal((await m.post('/view-as', { profile: String(tech) }, { page: '/' })).status, 302);
  const as = (await m.get('/')).text;
  assert.match(as, /You are looking at the site as <strong>Technician<\/strong> sees it\.[\s\S]*?Back to my own view/);
  assert.deepEqual(menu(as), []);
  for (const url of ['/admin/users', '/admin/security', '/admin/backups', '/admin/inventory', '/admin/profiles']) assert.equal((await m.get(url)).status, 403, url);
  assert.equal((await m.get('/parts?action=take')).status, 200);
  assert.doesNotMatch((await m.get('/parts?action=take')).text, /<select name="place">/);      // the technician's form, not the manager's
  assert.equal(db.prepare('SELECT is_master FROM users WHERE id = ?').get(master).is_master, 1);   // nothing about the account is changed
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'Viewed the site as a profile' AND user_id = ? AND detail = 'Technician'").get(master));
  // Back to their own view.
  await m.post('/view-as', { profile: '' }, { page: '/' });
  const after = (await m.get('/')).text;
  assert.ok(menu(after).includes('/admin/users')); assert.doesNotMatch(after, /You are looking at the site as/);
  assert.equal((await m.get('/admin/security')).status, 200);
  // A technician has no such choice, and asking for it does nothing.
  const t = await loggedIn('tech1');
  assert.doesNotMatch((await t.get('/')).text, /name="profile" data-autosubmit|action="\/view-as"/);
  assert.equal((await t.post('/view-as', { profile: String(corp ? corp.id : tech) }, { page: '/' })).status, 403);
  assert.equal((await t.get('/admin/users')).status, 403);
  // Someone who sees every office is offered only profiles that can do no more than their own.
  access.ensureProfile('Corporate without backups', 'all', access.ALL.filter((p) => p !== 'backups'));
  const cid = auth.createUser({ username: 'va.corp', displayName: 'Cory Corp', password: 'correct horse battery', profile: 'Corporate without backups' });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(cid);
  const c = await loggedIn('va.corp');
  const full = access.ensureProfile('Everything there is', 'all', access.ALL);
  const offered = /<form method="post" action="\/view-as" class="view-as-pick"[\s\S]*?<\/form>/.exec((await c.get('/')).text)[0];   // the list in the account menu
  assert.match(offered, new RegExp(`<option value="${tech}" >Technician</option>`)); assert.doesNotMatch(offered, new RegExp(`<option value="${full}" `));
  await c.post('/view-as', { profile: String(full) }, { page: '/' });
  assert.doesNotMatch((await c.get('/')).text, /You are looking at the site as/);
  assert.equal((await c.get('/admin/backups')).status, 403);
  await c.post('/view-as', { profile: String(tech) }, { page: '/' });
  assert.equal((await c.get('/admin/users')).status, 403);
  await c.post('/view-as', { profile: '' }, { page: '/' });
  assert.equal((await c.get('/admin/users')).status, 200);
  db.prepare('UPDATE users SET is_master = 0, active = 0 WHERE id = ?').run(master);
});

test('inventory: each location opens with its figures at a glance, and every way back is the site\'s own back button', async () => {
  const inv = require('../app/inventory');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  const t = new Date().toISOString();
  const a = db.prepare("INSERT INTO parts_catalog (part_number, description, cost_cents, created_at) VALUES ('GLC-1', 'Glance part', 400, ?)").run(t).lastInsertRowid;
  const b = db.prepare("INSERT INTO parts_catalog (part_number, description, created_at) VALUES ('GLC-2', 'No cost', ?)").run(t).lastInsertRowid;
  const place = inv.addCustom(home, 'Glance shelf');
  const mv = (o) => inv.move({ branchId: home, userId: userId('owner'), ...o });
  mv({ catalogId: a, to: place, quantity: 10, kind: 'receive' }); mv({ catalogId: b, to: place, quantity: 2, kind: 'receive' });
  mv({ catalogId: a, from: place, quantity: 3, kind: 'use' }); mv({ catalogId: b, from: place, quantity: 5, kind: 'use' });   // the second takes more than is there
  db.prepare("INSERT INTO inv_moves (branch_id, catalog_id, from_id, quantity, kind, created_at) VALUES (?, ?, ?, 4, 'use', '2020-01-01T00:00:00.000Z')").run(home, a, place);   // long ago: not in the last 30 days
  const s = inv.stats(place);
  assert.deepEqual([s.parts, s.items, s.value, s.unpriced, s.belowZero, s.toCheck, s.cameIn, s.wentOut, s.used], [2, 3, 1200, 0, 1, 1, 12, 8, 8]);
  assert.deepEqual(s.mostUsed.map((p) => [p.part_number, p.used]), [['GLC-2', 5], ['GLC-1', 3]]);
  const owner = await loggedIn('owner'); await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const page = (await owner.get(`/admin/inventory/locations/${place}`)).text.replace(/\s+/g, ' ');
  assert.match(page, /<span class="stat-label">On hand<\/span><span class="stat-num">3<\/span><span class="stat-sub">items across 2 parts<\/span>/);
  assert.match(page, /<span class="stat-label">Value<\/span><span class="stat-num">\$12\.00<\/span>/);
  assert.match(page, /<span class="stat-label">Went out<\/span><span class="stat-num">8<\/span><span class="stat-sub">8 of them used on jobs<\/span>/);
  assert.match(page, /<span class="stat-label">To check<\/span><span class="stat-num">1<\/span><span class="stat-sub">1 part is below zero<\/span>/);
  assert.match(page, /Most used in the last 30 days:<\/strong> GLC-2 \(5\), GLC-1 \(3\)/);
  assert.ok(page.indexOf('class="stats"') < page.indexOf('<table>'));                       // the figures come first
  // Back buttons: the site's own, on every page of the inventory (and nowhere a bare link dressed as one).
  assert.match(page, /<p class="back"><a class="back-link" href="\/admin\/inventory">Inventory<\/a><\/p>/);
  assert.match((await owner.get('/admin/inventory/count')).text, /<p class="back"><a class="back-link" href="\/admin\/inventory">Inventory<\/a><\/p>/);
  const views = path.join(__dirname, '..', 'app', 'views');
  for (const f of fs.readdirSync(views).filter((n) => n.endsWith('.ejs'))) assert.doesNotMatch(fs.readFileSync(path.join(views, f), 'utf8'), /<a class="back"/, f);
  await owner.post('/branch/view', { branch: 'all' }, { page: '/' });
  db.prepare('DELETE FROM inv_moves WHERE catalog_id IN (?, ?)').run(a, b);
});

test('on call: each office keeps its own on-call rates on the On call page; whoever keeps the schedule edits them, and another office never sees them', async () => {
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  const owner = await loggedIn('owner'); const tech = await loggedIn('tech1'); const outsider = await loggedIn('inv.away');
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const P = { page: '/oncall' }; const url = '/admin/oncall/rates';
  const rows = (b) => db.prepare('SELECT id, label, rate FROM oncall_rates WHERE branch_id = ? ORDER BY position, id').all(b).map((r) => ({ ...r }));
  // Nothing yet: a technician sees no rates section; whoever keeps the schedule sees where to add them.
  assert.doesNotMatch((await tech.get('/oncall')).text, /On-call rates/);
  assert.match((await owner.get('/oncall')).text, /<h2 id="rates">On-call rates<\/h2>[\s\S]*?No rates have been added for this office yet/);
  assert.equal((await tech.post(url, { label: 'Sneaky', rate: '$1' }, P)).status, 403);
  await owner.post(url, { label: 'Weeknight', rate: '$50' }, P);
  await owner.post(url, { label: 'Holiday <b>', rate: '$200 a day' }, P);
  await owner.post(url, { label: 'No rate given', rate: '' }, P);
  assert.deepEqual(rows(home).map((r) => [r.label, r.rate]), [['Weeknight', '$50'], ['Holiday <b>', '$200 a day']]);
  // The office's own people read them, with nothing to change them. They are shown as typed, never run as code.
  const seen = (await tech.get('/oncall')).text.replace(/\s+/g, ' ');
  assert.match(seen, /<td><strong>Weeknight<\/strong><\/td><td class="num">\$50<\/td>/); assert.match(seen, /<strong>Holiday &lt;b&gt;<\/strong>/);
  assert.doesNotMatch(seen, /action="\/admin\/oncall\/rates"/);
  // Another office has its own list: it sees none of these, adds its own, and cannot reach this office's lines.
  const theirs = db.prepare('SELECT branch_id FROM users WHERE username = ?').get('inv.away').branch_id;
  assert.doesNotMatch((await outsider.get('/oncall')).text, /<strong>Weeknight<|\$200 a day/);
  await outsider.post(url, { label: 'Weekend', rate: '$125' }, P);
  assert.deepEqual(rows(theirs).map((r) => r.label), ['Weekend']);
  const id = rows(home)[0].id;
  assert.equal((await outsider.post(url, { id: String(id), label: 'Taken over', rate: '$0' }, P)).status, 403);
  assert.equal((await outsider.post(url, { id: String(id), remove: '1' }, P)).status, 403);
  // Changing and removing.
  await owner.post(url, { id: String(id), label: 'Weeknight', rate: '$60' }, P);
  await owner.post(url, { id: String(rows(home)[1].id), remove: '1' }, P);
  assert.deepEqual(rows(home).map((r) => [r.label, r.rate]), [['Weeknight', '$60']]);
  assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'On-call rate changed' AND detail = 'Weeknight: $60'").get());
  await owner.post('/branch/view', { branch: 'all' }, { page: '/' });
});

test('Social: it sits in the bar where Discussions was, Discussions moves under Community, and the old photo wall\'s pictures arrive as posts with their likes', async () => {
  const t = await loggedIn('tech1'); const home = (await t.get('/')).text;
  const bar = /<nav class="nav"[\s\S]*?<span class="nav-sep"/.exec(home)[0];
  assert.match(bar, /<a href="\/social"[^>]*>Social<\/a>/); assert.doesNotMatch(bar, /href="\/discussions"/);
  const community = /<summary[^>]*>Community[\s\S]*?<\/details>/.exec(home)[0];
  assert.match(community, /<a href="\/discussions"[^>]*>Discussions/); assert.doesNotMatch(community, /href="\/photos"/);
  assert.match((await t.get('/settings/notifications')).text, /Someone comments on my post in Social/);
  // A comment tells the post's owner on their phone (never the person who wrote it).
  const push = require('../app/push'); const told = []; push.setSender(async (sub, payload) => { told.push({ to: sub.user_id, ...JSON.parse(payload) }); });
  const o = await loggedIn('owner');
  const sid = db.prepare("SELECT sid FROM sessions WHERE json_extract(data, '$.userId') = ? AND expires > ? ORDER BY expires DESC").get(userId('tech1'), Date.now()).sid;
  db.prepare("INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at, sid) VALUES (?, 'https://fcm.googleapis.com/fcm/send/social-t1', 'k', 'a', 'Phone', ?, ?)").run(userId('tech1'), new Date().toISOString(), sid);
  await t.post('/social', [['body', 'SOCIALTEST first day in the new truck']], { multipart: true, page: '/social' });
  const post = db.prepare("SELECT id FROM social_posts WHERE body LIKE 'SOCIALTEST%'").get().id;
  await t.post(`/social/${post}/comment`, { body: 'my own note' }, { page: '/social' });
  await o.post(`/social/${post}/comment`, { body: 'Looking sharp' }, { page: '/social' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(told.map((x) => [x.to, x.title, x.url]), [[userId('tech1'), 'Olive Owner commented on your post', `/social/p/${post}`]]);
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE '%/social-t1'").run(); db.prepare('DELETE FROM social_posts WHERE id = ?').run(post);

  // The carry-over, on a site as it was before: two pictures put up together and one alone, with likes.
  const L = encryptionLab();
  try {
    const SEEDED = `const db = require('./app/db'); const auth = require('./app/auth'); require('./app/app');
      const a = auth.createUser({ username: 'wall.a', displayName: 'Wally A', password: 'correct horse battery', profile: 'Technician' });
      const b = auth.createUser({ username: 'wall.b', displayName: 'Wendy B', password: 'correct horse battery', profile: 'Technician' });
      db.prepare('DELETE FROM social_posts').run(); db.prepare("DELETE FROM reactions WHERE kind = 'social'").run(); db.prepare("DELETE FROM meta WHERE key = 'social_from_wall_1'").run();
      const put = db.prepare('INSERT INTO wall_photos (user_id, path, caption, created_at) VALUES (?, ?, ?, ?)');
      const p1 = put.run(a, 'one.jpg', 'Job done', '2026-10-01T15:00:00.100Z').lastInsertRowid; put.run(a, 'two.jpg', 'Job done', '2026-10-01T15:00:00.180Z');
      const p3 = put.run(b, 'three.jpg', null, '2026-10-02T09:00:00.000Z').lastInsertRowid;
      const like = db.prepare('INSERT INTO wall_likes (photo_id, user_id) VALUES (?, ?)'); like.run(p1, b); like.run(p3, a); like.run(p3, b);
      console.log('seeded');`;
    assert.match(L.run(SEEDED).out, /seeded/);
    const LOOK = `const db = require('./app/db'); require('./app/app');
      console.log(JSON.stringify({ posts: db.prepare('SELECT p.body, u.username, (SELECT COUNT(*) FROM wall_photos w WHERE w.post_id = p.id) AS photos, (SELECT COUNT(*) FROM reactions r WHERE r.kind = \\'social\\' AND r.target_id = p.id AND r.emoji = \\'like\\') AS likes FROM social_posts p JOIN users u ON u.id = p.user_id ORDER BY p.id').all(),
        loose: db.prepare('SELECT COUNT(*) n FROM wall_photos WHERE post_id IS NULL').get().n }));`;
    const first = JSON.parse(L.run(LOOK).out.trim().split('\n').pop());
    assert.deepEqual(first, { posts: [{ body: 'Job done', username: 'wall.a', photos: 2, likes: 1 }, { body: null, username: 'wall.b', photos: 1, likes: 2 }], loose: 0 });
    assert.deepEqual(JSON.parse(L.run(LOOK).out.trim().split('\n').pop()), first);        // a second start changes nothing
  } finally { fs.rmSync(L.dir, { recursive: true, force: true }); }
});

test('photos: the browser saves each picture in the smallest form it can write (WebP, or JPEG where it cannot), and the site takes and serves both', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'shrink.js'), 'utf8');
  assert.match(js, /'image\/webp', 0\.8\)/); assert.match(js, /blob\.type === 'image\/webp'/); assert.match(js, /else asJpeg\(\)/);   // tried first, with the way back
  assert.match(js, /'image\/jpeg', 0\.8\)/);
  const t = await loggedIn('tech1');
  // The smallest real WebP there is: one pixel.
  const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  await t.post('/social', [['body', 'WEBPTEST'], ['photos', new File([WEBP], 'p.webp', { type: 'image/webp' })]], { multipart: true, page: '/social' });
  const post = db.prepare("SELECT id FROM social_posts WHERE body = 'WEBPTEST'").get();
  assert.ok(post, 'a WebP photo is accepted');
  const photo = db.prepare('SELECT id FROM wall_photos WHERE post_id = ?').get(post.id).id;
  const got = await t.get(`/wall/photo/${photo}`);
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/webp'); assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  await t.post(`/social/${post.id}/delete`, {}, { page: '/social' });
});

test('Social: the three dots on a post hold Edit and Delete; only the poster can edit, the poster and moderators can delete', async () => {
  const t = await loggedIn('tech1'); const other = await loggedIn('tech2'); const boss = await loggedIn('admin');
  await t.post('/social', [['body', 'DOTS first words']], { multipart: true, page: '/social' });
  const post = db.prepare("SELECT * FROM social_posts WHERE body = 'DOTS first words'").get();
  const card = (html) => (new RegExp(`<article class="card social-post" id="s${post.id}">[\\s\\S]*?</article>`).exec(html) || [''])[0];
  // The poster: three dots holding Edit and Delete, and no loose Remove button.
  const mine = card((await t.get('/social')).text);
  assert.match(mine, /<details class="row-menu post-menu">\s*<summary aria-label="Post options">/);
  assert.match(mine, new RegExp(`<a href="/social/p/${post.id}/edit">Edit</a>`)); assert.match(mine, />Delete<\/button>/);
  assert.doesNotMatch(mine.split('social-comments')[0], />Remove</);
  // Someone else sees no dots at all; a moderator sees Delete but not Edit.
  assert.doesNotMatch(card((await other.get('/social')).text), /post-menu/);
  const theirs = card((await boss.get('/social')).text);
  assert.match(theirs, /post-menu/); assert.match(theirs, />Delete<\/button>/); assert.doesNotMatch(theirs, />Edit<\/a>/);
  // Editing: only the poster reaches the page or can save; the post is then marked Edited.
  assert.equal((await other.get(`/social/p/${post.id}/edit`)).status, 403);
  assert.equal((await boss.get(`/social/p/${post.id}/edit`)).status, 403);
  assert.equal((await boss.post(`/social/${post.id}/edit`, { body: 'words put in their mouth' }, { page: '/social' })).status, 403);
  const page = await t.get(`/social/p/${post.id}/edit`);
  assert.equal(page.status, 200); assert.match(page.text, /<a class="back-link" href="\/social\/p\/\d+">/); assert.match(page.text, />DOTS first words<\/textarea>/);
  assert.equal((await t.post(`/social/${post.id}/edit`, { body: '' }, { page: `/social/p/${post.id}/edit` })).status, 400);       // nothing left: use Delete
  await t.post(`/social/${post.id}/edit`, { body: 'DOTS better words' }, { page: `/social/p/${post.id}/edit` });
  const now = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(post.id);
  assert.equal(now.body, 'DOTS better words'); assert.ok(now.edited_at); assert.equal(now.created_at, post.created_at);
  assert.match(card((await other.get('/social')).text), /DOTS better words/); assert.match(card((await other.get('/social')).text), /· Edited<\/span>/);
  // A photo can be taken off while editing; one belonging to another post cannot be named.
  const add = db.prepare('INSERT INTO wall_photos (user_id, path, caption, created_at, post_id) VALUES (?, ?, NULL, ?, ?)');
  const a = add.run(userId('tech1'), 'dots-a.jpg', post.created_at, post.id).lastInsertRowid;
  const elsewhere = db.prepare('INSERT INTO social_posts (user_id, body, created_at) VALUES (?, ?, ?)').run(userId('tech2'), 'DOTS other post', post.created_at).lastInsertRowid;
  const b = add.run(userId('tech2'), 'dots-b.jpg', post.created_at, elsewhere).lastInsertRowid;
  assert.match((await t.get(`/social/p/${post.id}/edit`)).text, new RegExp(`name="drop" value="${a}"`));
  await t.post(`/social/${post.id}/edit`, [['body', 'DOTS better words'], ['drop', String(a)], ['drop', String(b)]], { page: `/social/p/${post.id}/edit` });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wall_photos WHERE id = ?').get(a).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wall_photos WHERE id = ?').get(b).n, 1);
  // Deleting still works for a moderator, and not for a bystander.
  assert.equal((await other.post(`/social/${post.id}/delete`, {}, { page: '/social' })).status, 403);
  await boss.post(`/social/${post.id}/delete`, {}, { page: '/social' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM social_posts WHERE id = ?').get(post.id).n, 0);
  db.prepare('DELETE FROM wall_photos WHERE id = ?').run(b); db.prepare("DELETE FROM social_posts WHERE body LIKE 'DOTS %'").run();
});

test('Social: a comment has three dots with Edit and Delete for its writer; holding a reaction lists who gave it, newest first', async () => {
  const t = await loggedIn('tech1'); const other = await loggedIn('tech2'); const boss = await loggedIn('admin');
  const post = db.prepare('INSERT INTO social_posts (user_id, body, created_at) VALUES (?, ?, ?)').run(userId('tech1'), 'CDOTS post', new Date().toISOString()).lastInsertRowid;
  await other.post(`/social/${post}/comment`, { body: 'CDOTS frist comment' }, { page: '/social' });
  const c = db.prepare("SELECT * FROM social_comments WHERE body = 'CDOTS frist comment'").get();
  const row = (html) => (new RegExp(`<div class="social-comment" id="c${c.id}">[\\s\\S]*?(?=<div class="social-comment"|<form method="post" action="/social/${post}/comment"|</section>)`).exec(html) || [''])[0];
  const writer = row((await other.get('/social')).text);
  assert.match(writer, /<details class="row-menu comment-menu">\s*<summary aria-label="Comment options">/);
  assert.match(writer, new RegExp(`<a href="/social/comment/${c.id}/edit">Edit</a>`)); assert.match(writer, />Delete<\/button>/);
  assert.doesNotMatch(writer, />Remove</);
  // The owner of the post and a moderator can delete it, not edit it.
  for (const who of [t, boss]) { const seen = row((await who.get('/social')).text); assert.match(seen, />Delete<\/button>/); assert.doesNotMatch(seen, />Edit<\/a>/); }
  for (const who of [t, boss]) {
    assert.equal((await who.get(`/social/comment/${c.id}/edit`)).status, 403);
    assert.equal((await who.post(`/social/comment/${c.id}/edit`, { body: 'not mine' }, { page: '/social' })).status, 403);
  }
  const page = await other.get(`/social/comment/${c.id}/edit`);
  assert.equal(page.status, 200); assert.match(page.text, /<a class="back-link" href="\/social\/p\/\d+#c\d+">/); assert.match(page.text, />CDOTS frist comment<\/textarea>/);
  assert.equal((await other.post(`/social/comment/${c.id}/edit`, { body: '  ' }, { page: `/social/comment/${c.id}/edit` })).status, 400);
  await other.post(`/social/comment/${c.id}/edit`, { body: 'CDOTS first comment' }, { page: `/social/comment/${c.id}/edit` });
  const now = db.prepare('SELECT * FROM social_comments WHERE id = ?').get(c.id);
  assert.equal(now.body, 'CDOTS first comment'); assert.ok(now.edited_at);
  assert.match(row((await t.get('/social')).text), /· Edited<\/span>\s*<p>CDOTS first comment<\/p>/);
  await other.post(`/social/comment/${c.id}/delete`, {}, { page: '/social' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM social_comments WHERE id = ?').get(c.id).n, 0);
  // Reactions carry the list a long press shows: the reaction, then names with the most recent first.
  const give = db.prepare("INSERT INTO reactions (kind, target_id, user_id, emoji, created_at) VALUES ('social', ?, ?, 'like', ?)");
  give.run(post, userId('tech1'), '2026-01-01T10:00:00.000Z'); give.run(post, userId('tech2'), '2026-01-02T10:00:00.000Z');
  const feed = (await t.get('/social')).text;
  assert.match(feed, /data-who="👍 Like: Uma Tech, Terry Tech"/);
  const js = (await t.get('/site.js')).text; assert.match(js, /react-who/); assert.match(js, /data-who/);
  db.prepare("DELETE FROM reactions WHERE kind = 'social' AND target_id = ?").run(post); db.prepare('DELETE FROM social_posts WHERE id = ?').run(post);
});

test('Social page: a prompt to post beside your picture opens into the full form, posts sit under day headings with their time, and the feed says where it ends', async () => {
  const t = await loggedIn('tech1');
  db.prepare("DELETE FROM social_posts").run();
  const empty = (await t.get('/social')).text.replace(/\s+/g, ' ');
  // Closed, the form is a prompt with the person's own picture or initials; the full box and the photo button are inside it.
  assert.match(empty, /<details class="card composer" id="composer" > <summary aria-label="Write a post"> <(img|span) class="avatar[\s\S]*?<span class="composer-prompt">What's on your mind, Terry\?<\/span>/);
  assert.match(empty, /<details class="card composer"[\s\S]*?<textarea name="body" rows="5"[\s\S]*?<input type="file" name="photos"[^>]*multiple[\s\S]*?<\/details>/);
  assert.match(empty, /<p class="social-end">The feed is empty\. Say something! <a href="#composer" data-open-composer>Write a post<\/a><\/p>/);
  assert.match((await t.get('/site.js')).text, /data-open-composer/);
  // A mistake brings the form back open, with what was typed.
  assert.match((await t.post('/social', [['body', '']], { multipart: true, page: '/social' })).text, /<details class="card composer" id="composer" open>/);
  // Posts from different days sit under their own heading, newest day first, each showing its time.
  const add = db.prepare('INSERT INTO social_posts (user_id, body, created_at) VALUES (?, ?, ?)');
  const now = new Date(`${require('../app/util').localDate()}T17:00:00Z`).getTime();   // the middle of today, so the test reads the same at midnight
  add.run(userId('tech1'), 'DAYS older post', new Date(now - 9 * 86400000).toISOString());
  add.run(userId('tech1'), 'DAYS from yesterday', new Date(now - 86400000).toISOString());
  add.run(userId('tech2'), 'DAYS first today', new Date(now - 60000).toISOString());
  add.run(userId('tech1'), 'DAYS second today', new Date(now).toISOString());
  const feed = (await t.get('/social')).text.replace(/\s+/g, ' ');
  const heads = [...feed.matchAll(/<h2 class="social-day">([^<]+)<\/h2>/g)].map((m) => m[1]);
  assert.equal(heads.length, 3); assert.equal(heads[0], 'Today'); assert.equal(heads[1], 'Yesterday'); assert.match(heads[2], /\d/);
  assert.ok(feed.indexOf('DAYS second today') < feed.indexOf('DAYS first today') && feed.indexOf('DAYS first today') < feed.indexOf('>Yesterday<') && feed.indexOf('>Yesterday<') < feed.indexOf('DAYS from yesterday'));
  assert.match(feed, /<span class="meta">[^<]*\d{1,2}:\d{2} [AP]M<\/span>/);              // the time, the day being in the heading
  assert.match(feed, /<p class="social-end">That(&#39;|')s the end of the feed\. Say something!/);
  // With more than a page, the end is only announced on the last one.
  for (let i = 0; i < 20; i++) add.run(userId('tech2'), `DAYS filler ${i}`, new Date(now - 20 * 86400000 - i * 1000).toISOString());
  assert.doesNotMatch((await t.get('/social')).text, /class="social-end"/);
  assert.match((await t.get('/social?page=2')).text, /s the end of the feed\./);
  db.prepare("DELETE FROM social_posts WHERE body LIKE 'DAYS %'").run();
});

test('on call: the picker holds the people of every office the person runs, and someone picked goes on their own office\'s schedule', async () => {
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  const owner = await loggedIn('owner'); const tech = await loggedIn('tech1'); const now = new Date().toISOString();
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const far = db.prepare('INSERT INTO branches (name, state, created_at) VALUES (?, ?, ?)').run('Pick Faraway', 'OH', now).lastInsertRowid;
  const put = (username, name, office, profile) => { const id = auth.createUser({ username, displayName: name, password: 'correct horse battery', profile, branchId: office }); db.prepare("UPDATE users SET must_change_password = 0, phone = ? WHERE id = ?").run(`717-555-${String(id).padStart(4, '0')}`, id); return id; };
  const near = put('pick.near', 'Nell Nearby', home, profileId('Technician')); const away = put('pick.away', 'Abe Away', far, profileId('Technician'));
  const lead = put('pick.lead', 'Lena Lead', home, access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all')));
  const listOf = async (c) => (/<datalist id="oncall-people">([\s\S]*?)<\/datalist>/.exec((await c.get('/oncall')).text) || [])[1] || '';
  // Someone who sees every office is offered everyone, each labelled with their office; an office's own admin only their office.
  const wide = await listOf(owner); const homeName = db.prepare('SELECT name FROM branches WHERE id = ?').get(home).name;
  assert.ok(wide.includes(`<option value="Nell Nearby" data-id="${near}" data-phone="717-555-${String(near).padStart(4, '0')}" label="${homeName}"></option>`));
  assert.ok(wide.includes(`<option value="Abe Away" data-id="${away}" data-phone="717-555-${String(away).padStart(4, '0')}" label="Pick Faraway"></option>`));
  const lc = await loggedIn('pick.lead'); const narrow = await listOf(lc);
  assert.ok(narrow.includes('value="Nell Nearby"')); assert.ok(!narrow.includes('Abe Away'));
  assert.match((await owner.get('/oncall')).text, /<input name="name"[^>]*list="oncall-people" data-fills-phone data-picks-person/);
  assert.match((await owner.get('/oncall')).text, /Someone from another office goes on their own/); assert.doesNotMatch((await lc.get('/oncall')).text, /Someone from another office goes on their own/);
  // Someone who does not keep the schedule is sent no list of names and numbers.
  assert.doesNotMatch((await tech.get('/oncall')).text, /oncall-people/);
  // Picked from another office: the shift goes on that office's schedule, with what they cover. Typed by hand: the office being looked at.
  const day = (n) => { const d = new Date(`${require('../app/util').localDate()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const add = (c, body) => c.post('/admin/oncall', { start_on: day(1), end_on: day(8), role: 'tech', ...body }, { page: '/oncall' });
  await add(owner, { name: 'Abe Away', user_id: String(away), phone: '717-555-0000', covers: 'Sprinkler' });
  await add(owner, { name: 'Walk-in Contractor', user_id: '', phone: '717-555-1111' });
  await add(owner, { name: 'Somebody Else', user_id: String(away) });                       // an id that does not go with the name is ignored
  const where = (name) => db.prepare('SELECT branch_id, covers FROM oncall_shifts WHERE name = ?').get(name);
  assert.deepEqual({ ...where('Abe Away') }, { branch_id: far, covers: 'Sprinkler' });
  assert.equal(where('Walk-in Contractor').branch_id, home); assert.equal(where('Somebody Else').branch_id, home);
  // An office's own admin cannot put anyone on another office's schedule, whatever is sent.
  await add(lc, { name: 'Abe Away', user_id: String(away), phone: '1' });
  assert.deepEqual(db.prepare("SELECT branch_id FROM oncall_shifts WHERE name = 'Abe Away' ORDER BY id").all().map((r) => r.branch_id), [far, home]);
  db.prepare("DELETE FROM oncall_shifts WHERE name IN ('Abe Away', 'Walk-in Contractor', 'Somebody Else')").run();
});

test('on call: one file can fill several offices and the whole market, saying what each person covers, with phones taken from accounts', async () => {
  const owner = await loggedIn('owner'); const now = new Date().toISOString(); const page = '/oncall';
  const mk = (name) => { const id = db.prepare('INSERT INTO branches (name, state, created_at) VALUES (?, ?, ?)').run(name, 'PA', now).lastInsertRowid; require('../app/branches').setUp(id); return id; };
  const a = mk('Call Alpha'); const b = mk('Call Beta'); const out = mk('Call Outside');
  const m = db.prepare('INSERT INTO markets (name, created_at) VALUES (?, ?)').run('Call Valley', now).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id IN (?, ?)').run(m, a, b);
  const put = (username, name, office, phone) => { const id = auth.createUser({ username, displayName: name, password: 'correct horse battery', profile: profileId('Technician'), branchId: office }); db.prepare('UPDATE users SET must_change_password = 0, phone = ? WHERE id = ?').run(phone, id); return id; };
  put('call.sue', 'Sue Supervisor', a, '610-555-0101'); put('call.sam', 'Sam Sprinkler', b, '610-555-0202'); put('call.al', 'Al Alpha', a, null);
  const day = (n) => { const d = new Date(`${require('../app/util').localDate()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const us = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}/${ymd.slice(0, 4)}`;
  const file = (lines) => new File([['Start,End,Office,Covers,Role,Name,Phone,Holiday', ...lines].join('\n')], 'q4.csv', { type: 'text/csv' });
  const sheet = file([
    `${day(-1)},${day(6)},Market,Supervisor,On call,Sue Supervisor,,`,
    `${day(-1)},${day(6)},Market,"Security: access, video",Backup,Typed Number,610-555-0909,`,
    `${us(day(-1))}*,${us(day(6))},Call Beta,Sprinkler,On call,Sam Sprinkler,,`,                 // dates as the sheet writes them, star and all
    `${day(-1)},${day(6)},Call Alpha,Sprinkler,On call,Al Alpha,,`,
    `${day(2)},${day(3)},Market,Supervisor,On call,Sue Supervisor,,Thanksgiving`,
    `${day(-1)},${day(6)},No Such Office,Sprinkler,On call,Lost Soul,,`,
    `not a date,${day(6)},Call Alpha,Sprinkler,On call,Bad Line,,`,
  ]);
  await owner.post('/branch/view', { branch: String(a), back: '/' }, { page: '/' });
  const up = await owner.post('/admin/oncall/import', { file: sheet }, { page, multipart: true });
  assert.equal(up.status, 302);
  const rows = () => db.prepare('SELECT branch_id, market_id, role, name, phone, covers, note FROM oncall_shifts WHERE market_id = ? OR branch_id IN (?, ?, ?) ORDER BY id').all(m, a, b, out).map((r) => ({ ...r }));
  assert.deepEqual(rows(), [
    { branch_id: a, market_id: m, role: 'tech', name: 'Sue Supervisor', phone: '610-555-0101', covers: 'Supervisor', note: null },        // the phone on her account
    { branch_id: a, market_id: m, role: 'backup', name: 'Typed Number', phone: '610-555-0909', covers: 'Security: access, video', note: null },
    { branch_id: b, market_id: null, role: 'tech', name: 'Sam Sprinkler', phone: '610-555-0202', covers: 'Sprinkler', note: null },
    { branch_id: a, market_id: null, role: 'tech', name: 'Al Alpha', phone: null, covers: 'Sprinkler', note: null },                      // none on file: listed without
    { branch_id: a, market_id: m, role: 'tech', name: 'Sue Supervisor', phone: '610-555-0101', covers: 'Supervisor', note: 'Thanksgiving' },
  ]);
  const said = (await owner.get(page)).text.replace(/\s+/g, ' ');
  assert.match(said, /Schedule loaded: 5 entries\. Skipped lines for: No Such Office[^<]*No phone number on file for 1: Al Alpha\. 1 line\(s\) could not be read\./);
  // Everyone in the market sees the market-wide people under the market's name, and each office's own under that office.
  const shown = (await owner.get(page)).text.replace(/\s+/g, ' ');
  assert.match(shown, /<h3 class="sub-h">Call Valley market<\/h3>[\s\S]*?<span class="oncall-covers">Supervisor<\/span><strong>Sue Supervisor<\/strong>/);
  assert.match(shown, /<h3 class="sub-h">Call Beta office<\/h3>[\s\S]*?<span class="oncall-covers">Sprinkler<\/span><strong>Sam Sprinkler<\/strong>/);
  assert.equal((shown.match(/<strong>Sue Supervisor<\/strong>/g) || []).length, 1);                    // once, not once per office
  const bob = auth.createUser({ username: 'call.bob', displayName: 'Bob Beta', password: 'correct horse battery', profile: profileId('Technician'), branchId: b }); db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(bob);
  const bc = await loggedIn('call.bob'); const his = (await bc.get(page)).text;
  assert.match(his, /Sue Supervisor/); assert.match(his, /Sam Sprinkler/); assert.match(his, /Al Alpha/);
  // The home page's On call now is only the office being looked at: Bob's own sprinkler person, not the market's or another office's.
  const bobHome = (/<section class="panel p-oncall"[\s\S]*?<\/section>/.exec((await bc.get('/')).text) || [''])[0];
  assert.match(bobHome, /<span class="oncall-covers">Sprinkler<\/span><strong>Sam Sprinkler<\/strong>/); assert.doesNotMatch(bobHome, /Sue Supervisor|Al Alpha|Typed Number/);
  // An office outside the market sees none of it.
  const oc = auth.createUser({ username: 'call.out', displayName: 'Olga Outside', password: 'correct horse battery', profile: profileId('Technician'), branchId: out }); db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(oc);
  assert.doesNotMatch((await (await loggedIn('call.out')).get(page)).text, /Sue Supervisor|Sam Sprinkler/);
  // Loading the file again replaces what it covers rather than doubling it.
  await owner.post('/admin/oncall/import', { file: sheet }, { page, multipart: true });
  assert.equal(rows().length, 5);
  // A line whose role is "Clear" empties the market (or an office) for those days and adds nobody.
  await owner.post('/admin/oncall/import', { file: file([`${day(-1)},${day(6)},Market,,Clear,,,`, `${day(-1)},${day(6)},Call Alpha,Supervisor,On call,Sue Supervisor,,`]) }, { page, multipart: true });
  assert.deepEqual(rows().map((r) => `${r.market_id ? 'market' : r.branch_id === a ? 'alpha' : 'beta'}:${r.name}`), ['beta:Sam Sprinkler', 'alpha:Sue Supervisor']);
  // From an office outside the market, "Market" still means the market the file's own offices are in.
  const outside = db.prepare("INSERT INTO branches (name, created_at) VALUES ('Call Faraway Nomarket', ?)").run(new Date().toISOString()).lastInsertRowid;
  await owner.post('/branch/view', { branch: String(outside), back: '/' }, { page: '/' });
  await owner.post('/admin/oncall/import', { file: file([`${day(-1)},${day(6)},Market,,On call,Mark Market,,`, `${day(-1)},${day(6)},Call Alpha,Supervisor,On call,Sue Supervisor,,`]) }, { page, multipart: true });
  assert.ok(rows().some((r) => r.market_id && r.name === 'Mark Market' && r.branch_id === a));
  await owner.post('/admin/oncall/import', { file: file([`${day(-1)},${day(6)},Market,,Clear,,,`, `${day(-1)},${day(6)},Call Alpha,Supervisor,On call,Sue Supervisor,,`]) }, { page, multipart: true });
  assert.ok(!rows().some((r) => r.market_id));
  await owner.post('/branch/view', { branch: String(a), back: '/' }, { page: '/' });
  // An office's own admin cannot write to another office through a file: those lines are skipped.
  const lead = auth.createUser({ username: 'call.lead', displayName: 'Lou Lead', password: 'correct horse battery', profile: access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all')), branchId: a });
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(lead);
  const lc = await loggedIn('call.lead');
  await lc.post('/admin/oncall/import', { file: file([`${day(10)},${day(17)},Call Beta,Sprinkler,On call,Sneaky Entry,,`, `${day(10)},${day(17)},Call Alpha,Sprinkler,On call,Fair Entry,,`]) }, { page, multipart: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM oncall_shifts WHERE name = 'Sneaky Entry'").get().n, 0);
  assert.equal(db.prepare("SELECT branch_id FROM oncall_shifts WHERE name = 'Fair Entry'").get().branch_id, a);
  // Tick shifts and remove them together: only those of offices the person runs go.
  const keep = db.prepare("INSERT INTO oncall_shifts (branch_id, start_on, end_on, role, name, created_at) VALUES (?, ?, ?, 'tech', 'Beta Keep', ?)").run(b, day(10), day(17), now).lastInsertRowid;
  const fair = db.prepare("SELECT id FROM oncall_shifts WHERE name = 'Fair Entry'").get().id;
  const lcPage = (await lc.get('/oncall')).text;
  assert.match(lcPage, /data-oncall-pick-all/); assert.match(lcPage, new RegExp(`class="oncall-pick" form="oncall-clear" name="ids" value="${fair}"`)); assert.doesNotMatch(lcPage, new RegExp(`name="ids" value="${keep}"`));
  await lc.post('/admin/oncall/clear', { ids: `${fair},${keep}` }, { page });
  assert.deepEqual(db.prepare('SELECT name FROM oncall_shifts WHERE id IN (?, ?)').all(fair, keep).map((r) => r.name), ['Beta Keep']);
  assert.match((await owner.get('/oncall')).text, new RegExp(`name="ids" value="${keep}"`));
  await owner.post('/admin/oncall/clear', { ids: String(keep) }, { page });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM oncall_shifts WHERE id = ?').get(keep).n, 0);
  assert.doesNotMatch((await (await loggedIn('tech1')).get('/oncall')).text, /oncall-pick|oncall-clear/);
  db.prepare('DELETE FROM oncall_shifts WHERE market_id = ? OR branch_id IN (?, ?, ?)').run(m, a, b, out);
  db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(m); db.prepare('DELETE FROM markets WHERE id = ?').run(m);
  const homeId = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  await owner.post('/branch/view', { branch: String(homeId), back: '/' }, { page: '/' });
});

test('Help: how-to guides for the jobs a person can do, a "?" on the page each one explains, and nothing for jobs they cannot do', async () => {
  const help = require('../app/help'); const access = require('../app/permissions');
  const known = new Set(access.GROUPS.flatMap((g) => g.items.map((i) => i[0])));
  // Every guide is well formed: its own address, a known group, real permissions, steps to follow, and no page claimed twice.
  assert.ok(help.guides.length >= 30);
  const slugs = new Set(); const owned = new Map();
  for (const g of help.guides) {
    assert.match(g.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/); assert.ok(!slugs.has(g.slug), `two guides called ${g.slug}`); slugs.add(g.slug);
    assert.ok(help.GROUPS.includes(g.group), `${g.slug}: group ${g.group}`);
    assert.ok(g.title && g.intro && g.where, `${g.slug}: title, intro and where`);
    assert.ok(Array.isArray(g.steps) && g.steps.length >= 2 && g.steps.length <= 10, `${g.slug}: steps`);
    for (const p of g.perms || []) assert.ok(known.has(p), `${g.slug}: unknown permission ${p}`);
    for (const p of g.pages || []) {
      assert.match(p, /^\/[\w\-./]*$/); assert.doesNotMatch(p, /^\/complaint/i, `${g.slug}: complaint pages carry no extras`);
      assert.ok(!owned.has(p), `${p} is claimed by ${owned.get(p)} and ${g.slug}`); owned.set(p, g.slug);
    }
    for (const r of g.related || []) assert.ok(help.guides.some((x) => x.slug === r), `${g.slug}: related guide ${r} does not exist`);
    for (const line of [g.title, g.intro, g.where, ...g.steps, ...(g.tips || [])]) { assert.doesNotMatch(line, /[<>`]|\u2014/, `${g.slug}: plain words only`); assert.equal((line.match(/\*\*/g) || []).length % 2, 0, `${g.slug}: unbalanced bold`); }
  }
  assert.equal(help.rich('Tap **Save** <now>'), 'Tap <strong>Save</strong> &lt;now&gt;');
  // A technician sees the everyday guides and none of the managers'; the owner sees those as well.
  const t = await loggedIn('tech1'); const owner = await loggedIn('owner');
  const mine = (await t.get('/help')).text; const theirs = (await owner.get('/help')).text;
  const listed = (html) => [...html.matchAll(/<a href="\/help\/([a-z0-9-]+)">/g)].map((m) => m[1]);
  const manager = help.guides.find((g) => (g.perms || []).includes('users.manage')); assert.ok(manager);
  assert.ok(listed(mine).length >= 8); assert.ok(!listed(mine).includes(manager.slug)); assert.ok(listed(theirs).includes(manager.slug));
  assert.ok(listed(theirs).length > listed(mine).length);
  assert.equal((await t.get(`/help/${manager.slug}`)).status, 404); assert.equal((await owner.get(`/help/${manager.slug}`)).status, 200);
  assert.equal((await t.get('/help/no-such-guide')).status, 404);
  // A guide page: numbered steps, bold button names, a custom back button, and a print button.
  const first = help.guides.find((g) => listed(mine).includes(g.slug) && (g.pages || []).length);
  const page = (await t.get(`/help/${first.slug}?from=${encodeURIComponent(first.pages[0])}`)).text;
  assert.match(page, /<ol class="help-steps">\s*<li>/); assert.match(page, new RegExp(`<a class="back-link" href="${first.pages[0]}">Back to the page</a>`)); assert.match(page, /data-print>Print this guide/);
  assert.match((await t.get(`/help/${first.slug}?from=//evil.example`)).text, /<a class="back-link" href="\/help">Help<\/a>/);   // never sent off the site
  // The page a guide explains offers it with a "?"; a page with no guide for this person, and Help itself, do not.
  assert.match((await t.get(first.pages[0])).text, new RegExp(`<a class="help-link no-print" href="/help/${first.slug}\\?from=`));
  assert.doesNotMatch((await t.get('/help')).text, /class="help-link/);
  assert.match((await t.get('/')).text, /<a class="nav-help" href="\/help" >Help<\/a>/);          // in the menu bar; first under More on a phone
  assert.match((await t.get('/help')).text, /<a class="nav-help" href="\/help" aria-current="page">Help<\/a>/);
  assert.equal((await new Client().get('/help')).status, 302);                                // signed-in people only
});

test('search: one box finds pages, guides, people, offices and parts, and only what the person may open', async () => {
  const search = require('../app/search');
  // Every link in the menu can be found by search.
  const header = fs.readFileSync(path.join(__dirname, '..', 'app', 'views', 'partials', 'header.ejs'), 'utf8');
  const menu = [...header.matchAll(/\[[^\[\]]*?'(\/[^']*)', '([^']+)', (?:is\(|path|false)/g)].map((m) => m[1]);
  assert.ok(menu.length >= 40);
  for (const url of menu) assert.ok(search.PAGES.some((p) => p[1] === url), `${url} is in the menu but not in search`);
  const t = await loggedIn('tech1'); const owner = await loggedIn('owner');
  const find = async (who, q) => JSON.parse((await who.get(`/search/suggest?q=${encodeURIComponent(q)}`)).text).groups;
  const urls = (groups, name) => ((groups.find((g) => g.name === name) || {}).items || []).map((i) => i.url);
  // A page by its name, and by another word for it.
  assert.equal(urls(await find(t, 'on call'), 'Pages')[0], '/oncall');
  assert.ok(urls(await find(t, 'fingerprint'), 'Pages').includes('/account/password'));
  assert.ok(urls(await find(t, 'on call'), 'How-to guides').includes('/help/see-who-is-on-call'));
  // "reset password": a manager is sent to Users; a technician only to their own password page and guides.
  assert.ok(urls(await find(owner, 'reset password'), 'Pages').includes('/admin/users'));
  const mine = await find(t, 'reset password');
  assert.ok(!urls(mine, 'Pages').includes('/admin/users')); assert.ok(urls(mine, 'Pages').includes('/account/password'));
  for (const g of await find(t, 'backup')) for (const u of urls([g], g.name)) assert.doesNotMatch(u, /^\/admin\/(backups|users|profiles)/);
  assert.ok(!urls(await find(t, 'add a person'), 'How-to guides').includes('/help/add-a-person'));
  assert.ok(urls(await find(owner, 'add a person'), 'How-to guides').includes('/help/add-a-person'));
  // People by name, an office by name.
  assert.ok(urls(await find(t, 'uma'), 'People').includes(`/people/${userId('tech2')}`));
  const office = db.prepare('SELECT b.id, b.name FROM branches b JOIN users u ON u.branch_id = b.id WHERE u.id = ?').get(userId('tech1'));
  assert.ok(urls(await find(t, office.name), 'Offices').includes(`/branches/${office.id}`));
  // A part: the technician lands on the parts form with it filled in; someone who runs stock lands on Stock.
  db.prepare("INSERT OR IGNORE INTO parts_catalog (part_number, description, active, created_at) VALUES ('SRCH-100', 'Searchable smoke detector', 1, ?)").run(new Date().toISOString());
  assert.deepEqual(urls(await find(t, 'srch-100'), 'Parts'), ['/parts?action=take&part=SRCH-100']);
  assert.ok(urls(await find(t, 'searchable smoke'), 'Parts').length === 1);
  assert.deepEqual(urls(await find(owner, 'srch-100'), 'Parts'), ['/admin/stock?q=SRCH-100']);
  assert.match((await t.get('/parts?action=take&part=SRCH-100')).text, /<input name="part_name" value="SRCH-100"/);
  // Odd input is harmless: wildcards match nothing special, one letter asks for nothing, and signed-out people get nothing.
  assert.deepEqual(await find(t, '%'), []); assert.deepEqual(await find(t, 'a'), []); assert.deepEqual(urls(await find(t, '%%__'), 'People'), []);
  assert.equal((await new Client().get('/search/suggest?q=uma')).status, 302);
  // The page itself works without scripts, and the magnifier is in the top bar.
  const page = (await t.get('/search?q=on+call')).text;
  assert.match(page, /<input type="search" name="q" id="search-box" value="on call"/); assert.match(page, /<a href="\/oncall"><strong>On call<\/strong><span>Page<\/span><\/a>/);
  assert.match((await t.get('/search?q=zzzqqq')).text, /Nothing found for "zzzqqq"/);
  assert.match((await t.get('/')).text, /<a class="search-link" href="\/search"/);
  db.prepare("DELETE FROM parts_catalog WHERE part_number = 'SRCH-100'").run();
});

test('Manage page for people who run things (not on the home page), and a first-time checklist that can be put away', async () => {
  makeUser('newbie1', 'Nora Newbie');
  const nora = await loggedIn('newbie1'); const owner = await loggedIn('owner');
  // The jobs someone runs are on their own Manage page, not on the home page. A technician has no such page or link.
  const hers = (await nora.get('/')).text; const theirs = (await owner.get('/')).text;
  assert.doesNotMatch(hers, /manage-panel|manage-jobs|class="nav-manage"/); assert.doesNotMatch(theirs, /manage-panel|manage-jobs/);
  assert.equal((await nora.get('/manage')).status, 403);
  assert.match(theirs, /<a class="nav-manage" href="\/manage" >Manage/);
  const panel = (await owner.get('/manage')).text;
  for (const title of ['People', 'Schedule and news', 'Parts', 'Fleet and training', 'The site']) assert.ok(panel.includes(`<h2>${title}</h2>`), title);
  for (const job of ['People and passwords', 'Assign a task', 'Post an announcement', 'On-call schedule', 'Parts requests', 'Inventory', 'Fleet list', 'Activity log']) assert.ok(panel.includes(`<span>${job}</span>`), job);
  assert.match(panel, /<a href="\/help">How-to guides<\/a>/);
  // Someone who runs only one thing sees only that.
  const wh = (await (await loggedIn('wh1')).get('/manage')).text;
  assert.ok(wh.includes('<span>Parts requests</span>')); assert.ok(!wh.includes('<span>People and passwords</span>')); assert.ok(!wh.includes('<h2>The site</h2>'));
  // The checklist: four steps, none ticked for a new person, with the guide to start from; no managers' line for a technician.
  const card = (/<section class="card welcome-card"[\s\S]*?<\/section>/.exec(hers) || [''])[0];
  assert.match(card, /Welcome, Nora\. A few things to set up/);
  assert.equal((card.match(/<li class="" data-step=/g) || []).length, 4);
  assert.match(card, /<a href="\/help\/find-your-way-around">/); assert.doesNotMatch(card, /For managers/);
  assert.doesNotMatch(hers, /id="profile-tip"|id="passkey-tip"/);                              // one card at a time, not three
  // Adding a photo ticks that step.
  db.prepare("UPDATE users SET photo_path = 'nora.jpg' WHERE id = ?").run(userId('newbie1'));
  assert.match((await nora.get('/')).text, /<li class="done" data-step="photo">/);
  db.prepare('UPDATE users SET photo_path = NULL WHERE id = ?').run(userId('newbie1'));
  // A manager's checklist also points at the managers' guides.
  db.prepare('UPDATE users SET welcomed_at = NULL WHERE id = ?').run(userId('owner'));
  const boss = (/<section class="card welcome-card"[\s\S]*?<\/section>/.exec((await owner.get('/')).text) || [''])[0];
  assert.match(boss, /<strong>For managers:<\/strong>\s*<a href="\/help\/[a-z-]+">/);
  // Putting it away is for good, and only for the person who did it.
  await nora.post('/welcome/done', {}, { page: '/' });
  assert.doesNotMatch((await nora.get('/')).text, /welcome-card/);
  assert.ok(db.prepare('SELECT welcomed_at FROM users WHERE id = ?').get(userId('newbie1')).welcomed_at);
  assert.match((await owner.get('/')).text, /welcome-card/);
  await owner.post('/welcome/done', {}, { page: '/' });
});

test('parts section: a short menu, tabs for the pages that belong together, and every part box offers the catalog', async () => {
  const owner = await loggedIn('owner'); const t = await loggedIn('tech1');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  // The Parts menu holds five things for someone who runs parts.
  const menu = /<summary[^>]*>Parts[\s\S]*?<\/details>/.exec((await owner.get('/')).text)[0];
  assert.deepEqual([...menu.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)/g)].map((m) => `${m[2].trim()} ${m[1]}`),
    ['Take, return or request /parts', 'Parts requests /admin/requests', 'Inventory /admin/inventory', 'Parts log /admin/parts', 'Catalog /admin/catalog']);
  // Inventory, Warehouse stock and the count share one strip of tabs; so do the log, the audit and the usage summary.
  const tabs = (html) => [...((/<nav class="section-tabs[\s\S]*?<\/nav>/.exec(html) || [''])[0]).matchAll(/<a href="([^"]+)" (aria-current="page")?>/g)].map((m) => m[1] + (m[2] ? '*' : ''));
  assert.deepEqual(tabs((await owner.get('/admin/inventory')).text), ['/admin/inventory*', '/admin/stock', '/admin/inventory/count']);
  assert.deepEqual(tabs((await owner.get('/admin/stock')).text), ['/admin/inventory', '/admin/stock*', '/admin/inventory/count']);
  assert.deepEqual(tabs((await owner.get('/admin/inventory/count')).text), ['/admin/inventory', '/admin/stock', '/admin/inventory/count*']);
  assert.deepEqual(tabs((await owner.get('/admin/parts')).text), ['/admin/parts*', '/admin/parts/audit', '/admin/parts/summary']);
  assert.deepEqual(tabs((await owner.get('/admin/parts/audit')).text), ['/admin/parts', '/admin/parts/audit*', '/admin/parts/summary']);
  assert.deepEqual(tabs((await owner.get('/admin/weekly')).text), ['/admin/parts', '/admin/parts/audit', '/admin/parts/summary*']);
  assert.deepEqual(tabs((await owner.get('/admin/catalog')).text), []); assert.deepEqual(tabs((await t.get('/parts')).text), []);
  // The Inventory page leads with the list; moving parts and adding places are folded away until wanted.
  const inv = (await owner.get('/admin/inventory')).text;
  for (const s of ['Move parts or record a delivery', 'Add a vehicle', 'Add another location']) assert.match(inv, new RegExp(`<details class="mod-tools[^"]*">\\s*<summary>${s}</summary>`));
  // Every box where a part is typed offers the catalog, and still takes anything typed.
  assert.match(inv, /<input name="part_number"[^>]*data-catalog/);
  assert.match((await owner.get('/admin/stock')).text, /<input name="part_number"[^>]*data-catalog/);
  db.prepare("INSERT OR IGNORE INTO parts_catalog (part_number, description, cost_cents, active, created_at) VALUES ('PICK-200', 'Pickable pull station', 1234, 1, ?)").run(new Date().toISOString());
  const got = JSON.parse((await t.get('/catalog/suggest?q=pick-2')).text);
  assert.deepEqual(got, [{ n: 'PICK-200', d: 'Pickable pull station' }]);                          // the number and the name, never the cost
  assert.deepEqual(JSON.parse((await t.get('/catalog/suggest?q=pull+station')).text).map((p) => p.n), ['PICK-200']);
  assert.deepEqual(JSON.parse((await t.get('/catalog/suggest?q=%25')).text), []);
  assert.equal((await new Client().get('/catalog/suggest?q=pick')).status, 302);
  assert.match((await t.get('/site.js')).text, /input\[data-catalog\]/);
  // A part typed by hand that the catalog does not have is accepted: it joins the catalog and is moved like any other.
  const whId = require('../app/inventory').warehouseOf(home).id;
  await owner.post('/admin/inventory/moves', { from: 'delivery', to: String(whId), part_number: 'HAND-TYPED-1', quantity: '3' }, { page: '/admin/inventory' });
  const made = db.prepare("SELECT id, description FROM parts_catalog WHERE part_number = 'HAND-TYPED-1'").get();
  assert.ok(made); assert.equal(require('../app/inventory').onHand(whId, made.id), 3);
  db.prepare('DELETE FROM inv_moves WHERE catalog_id = ?').run(made.id); db.prepare('DELETE FROM parts_catalog WHERE id = ?').run(made.id);
  db.prepare("DELETE FROM parts_catalog WHERE part_number = 'PICK-200'").run();
});

test('warehouse stock: levels without a count, a maximum to order up to, figures at the top, and an alert when any move reaches the minimum', async () => {
  const wh = await loggedIn('wh1'); const owner = await loggedIn('owner'); const page = '/admin/stock';
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('wh1')).branch_id;
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  const invLib = require('../app/inventory'); const w = invLib.warehouseOf(home);
  // The form asks for the part and its levels, not for a count.
  const form = (/<h2>Set a minimum and maximum<\/h2>[\s\S]*?<\/form>/.exec((await wh.get(page)).text) || [''])[0];
  assert.match(form, /name="part_number"[^>]*data-catalog/); assert.match(form, /name="min_level"/); assert.match(form, /name="max_level"/); assert.doesNotMatch(form, /name="count"|On the shelf now/);
  // A part already in the warehouse keeps what the records hold; setting levels moves nothing.
  const now = new Date().toISOString();
  const pid = db.prepare("INSERT INTO parts_catalog (part_number, description, cost_cents, active, created_at) VALUES ('LVL-1', 'Level test horn', 250, 1, ?)").run(now).lastInsertRowid;
  invLib.move({ branchId: home, catalogId: pid, to: w.id, quantity: 12, kind: 'receive', userId: userId('wh1') });
  const movesBefore = db.prepare('SELECT COUNT(*) n FROM inv_moves WHERE catalog_id = ?').get(pid).n;
  assert.equal((await wh.post(page, { part_number: 'LVL-1' }, { page })).status, 400);                       // a minimum, a maximum, or both
  assert.equal((await wh.post(page, { part_number: 'LVL-1', min_level: '9', max_level: '5' }, { page })).status, 400);
  assert.equal((await wh.post(page, { part_number: 'LVL-1', min_level: '5', max_level: '20' }, { page })).status, 302);
  const row = () => stockLib.list(home).find((r) => r.part_number === 'LVL-1');
  assert.deepEqual([row().on_hand, row().min_level, row().max_level, row().low], [12, 5, 20, false]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inv_moves WHERE catalog_id = ?').get(pid).n, movesBefore);
  // A part the warehouse has never held starts at nothing on hand: at once low, with an order up to its maximum.
  await wh.post(page, { part_number: 'LVL-NEW', min_level: '2', max_level: '6' }, { page });
  const fresh = stockLib.list(home).find((r) => r.part_number === 'LVL-NEW');
  assert.deepEqual([fresh.on_hand, fresh.low, fresh.order], [0, true, 6]);
  // Moving parts out to a vehicle takes it to its minimum: the people who run stock are told once.
  const pushLib = require('../app/push'); const got = []; pushLib.setSender(async (sub, payload) => { got.push(JSON.parse(payload)); });
  await wh.post('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/lvl-device', p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg', device: 'Test phone' }, { page: '/settings/notifications' });
  const truck = invLib.addCustom ? db.prepare("INSERT INTO inv_locations (branch_id, kind, name, active, created_at) VALUES (?, 'custom', 'LVL trailer', 1, ?)").run(home, now).lastInsertRowid : null;
  await owner.post('/admin/inventory/moves', { from: String(w.id), to: String(truck), part_number: 'LVL-1', quantity: '3' }, { page: '/admin/inventory' });   // 9 left
  await new Promise((r) => setTimeout(r, 20)); assert.equal(got.filter((g) => /LVL-1/.test(g.title)).length, 0);
  await owner.post('/admin/inventory/moves', { from: String(w.id), to: String(truck), part_number: 'LVL-1', quantity: '4' }, { page: '/admin/inventory' });   // 5 left: at the minimum
  await new Promise((r) => setTimeout(r, 20));
  const alerts = got.filter((g) => /LVL-1/.test(g.title));
  assert.equal(alerts.length, 1); assert.deepEqual([alerts[0].title, alerts[0].tag, alerts[0].url], ['Low stock: LVL-1', 'low_stock', '/admin/stock?low=1']); assert.match(alerts[0].body, /5 left \(minimum 5\)/);
  await owner.post('/admin/inventory/moves', { from: String(w.id), to: String(truck), part_number: 'LVL-1', quantity: '1' }, { page: '/admin/inventory' });   // already low: not told again
  await new Promise((r) => setTimeout(r, 20)); assert.equal(got.filter((g) => /LVL-1/.test(g.title)).length, 1);
  // The page: what was used, how long it lasts, how many to order, and the value for someone who may see costs.
  const r = row(); assert.deepEqual([r.on_hand, r.used, r.low, r.order], [4, 8, true, 16]); assert.equal(r.days_left, 15);   // 8 used in 30 days, 4 left
  const html = (await owner.get(page)).text.replace(/\s+/g, ' ');
  for (const label of ['Parts', 'Low or out', 'To order', 'Used in 30 days', 'Value on the shelf']) assert.ok(html.includes(`<span class="stat-label">${label}</span>`), label);
  assert.match(html, /Most used, last 30 days<\/h2>[\s\S]*?LVL-1<\/strong><\/a> <span class="hint">8 used, 4 left/);
  assert.match(html, /Running out soonest<\/h2>[\s\S]*?LVL-1<\/strong><\/a> <span class="hint">about 15 days left/);
  assert.match(html, /<strong>LVL-1<\/strong><\/a><\/td> <td>Level test horn<\/td> <td class="num"><strong>4<\/strong><\/td> <td class="num">5<\/td> <td class="num">20<\/td> <td class="num">8<\/td> <td><span class="tag request">Low<\/span><\/td> <td class="num"><strong>16<\/strong>/);
  // The list of what to order, as a spreadsheet.
  const csv = (await wh.get('/admin/stock/reorder.csv')).text;
  assert.match(csv, /Part number,Description,On hand,Minimum,Maximum,Used in 30 days,Order/); assert.match(csv, /LVL-1,Level test horn,4,5,20,8,16/); assert.match(csv, /LVL-NEW,,0,2,6,0,6/);
  assert.equal((await (await loggedIn('tech1')).get('/admin/stock/reorder.csv')).status, 403);
  // The page and the Inventory page agree: a part that is in the warehouse shows here even though nobody set a level for it.
  const loose = db.prepare("INSERT INTO parts_catalog (part_number, description, active, created_at) VALUES ('LVL-LOOSE', 'No level set', 1, ?)").run(now).lastInsertRowid;
  invLib.move({ branchId: home, catalogId: loose, to: w.id, quantity: 7, kind: 'receive', userId: userId('wh1') });
  const lr = stockLib.list(home).find((x) => x.part_number === 'LVL-LOOSE');
  assert.deepEqual([lr.on_hand, lr.min_level, lr.low, lr.order], [7, null, false, 0]);
  const listed = stockLib.list(home); const held = invLib.contents(w.id).filter((x) => x.on_hand !== 0);
  for (const h of held) assert.ok(listed.some((x) => x.id === h.id && x.on_hand === h.on_hand), `${h.part_number} is in the warehouse but not on the stock page`);
  assert.match((await owner.get(page)).text, new RegExp(`<a class="hint" href="/admin/stock/${loose}#levels">Set</a>`));
  await wh.post(`${page}/${loose}/min`, { min_level: '10', max_level: '12' }, { page: `${page}/${loose}` });      // a level can be set straight from its page
  assert.deepEqual((({ min_level, max_level, low, order }) => [min_level, max_level, low, order])(stockLib.list(home).find((x) => x.part_number === 'LVL-LOOSE')), [10, 12, true, 5]);
  // On the part's own page both levels are edited together.
  await wh.post(`${page}/${pid}/min`, { min_level: '3', max_level: '' }, { page: `${page}/${pid}` });
  assert.deepEqual([row().min_level, row().max_level, row().low], [3, null, false]);
  pushLib.setSender(async () => {});
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint LIKE '%lvl-device'").run();
  for (const n of ['LVL-1', 'LVL-NEW', 'LVL-LOOSE']) { const c = db.prepare('SELECT id FROM parts_catalog WHERE part_number = ?').get(n); db.prepare('DELETE FROM inv_moves WHERE catalog_id = ?').run(c.id); db.prepare('DELETE FROM branch_stock WHERE catalog_id = ?').run(c.id); db.prepare('DELETE FROM parts_catalog WHERE id = ?').run(c.id); }
  db.prepare('DELETE FROM inv_locations WHERE id = ?').run(truck);
});

test('fleet: the office\'s trucks, trailers, lifts and other equipment in one list, and a lift signed out for a time and a place', async () => {
  const owner = await loggedIn('owner'); const t1 = await loggedIn('tech1'); const t2 = await loggedIn('tech2'); const outsider = await loggedIn('inv.away');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  await owner.post('/branch/view', { branch: String(home) }, { page: '/' });
  // Whoever runs the fleet adds to it; a technician cannot.
  assert.equal((await t1.post('/fleet', { kind: 'lift', name: 'Sneaky lift' }, { page: '/fleet' })).status, 403);
  await owner.post('/fleet', { kind: 'lift', name: 'Scissor lift 1', details: 'Genie GS-1930, 19 ft', ident: 'SN 4471', bookable: '1' }, { page: '/fleet' });
  await owner.post('/fleet', { kind: 'trailer', name: 'Enclosed trailer', ident: 'PA XKT-2210' }, { page: '/fleet' });
  await owner.post('/fleet', { kind: 'truck', name: 'Box truck 7', user_id: String(userId('tech2')) }, { page: '/fleet' });
  await owner.post('/fleet', { kind: 'lift', name: 'scissor LIFT 1', bookable: '1' }, { page: '/fleet' });        // the same name again is refused
  const lift = db.prepare("SELECT * FROM fleet_items WHERE name = 'Scissor lift 1'").get();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fleet_items WHERE name = 'Scissor lift 1' COLLATE NOCASE").get().n, 1);
  // Everyone in the office sees the list, grouped by kind; another office does not see this one's.
  const list = (await t1.get('/fleet')).text.replace(/\s+/g, ' ');
  for (const h of ['Trucks and vans', 'Trailers', 'Lifts']) assert.ok(list.includes(`<h2>${h}</h2>`), h);
  assert.match(list, /<strong>Scissor lift 1<\/strong><\/a><\/td><td>Genie GS-1930, 19 ft<\/td><td>SN 4471<\/td><td><\/td> <td><span class="tag return">Available<\/span>/);
  assert.match(list, /<strong>Box truck 7<\/strong><\/a><\/td><td><\/td><td><\/td><td>Uma Tech<\/td>/);
  assert.match(list, new RegExp(`<a href="/fleet/signout\\?item=${lift.id}">Sign out</a>`)); assert.doesNotMatch(list, /Add to the fleet/);
  assert.match((await owner.get('/fleet')).text, /<summary>Add to the fleet<\/summary>/);
  assert.doesNotMatch((await outsider.get('/fleet')).text, /SN 4471|Genie GS-1930/); assert.equal((await outsider.get(`/fleet/${lift.id}`)).status, 404);
  // Signing it out: which lift, when, where, and until when. Each is asked for.
  const day = (n) => { const d = new Date(`${require('../app/util').localDate()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const form = (await t1.get(`/fleet/signout?item=${lift.id}`)).text;
  assert.match(form, new RegExp(`<option value="${lift.id}" selected>Scissor lift 1 \\(Genie GS-1930, 19 ft\\)</option>`)); assert.doesNotMatch(form, /Enclosed trailer<\/option>/);   // only what is set up to be signed out
  for (const f of ['start_date', 'start_time', 'end_date', 'end_time', 'place']) assert.match(form, new RegExp(`name="${f}"[^>]*required`));
  const ask = (c, o) => c.post('/fleet/signout', { item: String(lift.id), start_date: day(2), start_time: '07:00', end_date: day(3), end_time: '15:30', place: 'Lincoln Elementary gym', job_number: 'J-5512', ...o }, { page: '/fleet/signout' });
  assert.match((await ask(t1, { place: '' })).text, /Say where it will be used/);
  assert.match((await ask(t1, { end_date: day(2), end_time: '06:00' })).text, /has to be after the time it goes out/);
  assert.match((await ask(t1, { start_date: day(-3), end_date: day(-2) })).text, /already passed/);
  assert.match((await ask(t1, { item: '999999' })).text, /Choose which lift/);
  assert.equal((await ask(t1, {})).status, 302);
  const s = db.prepare('SELECT * FROM fleet_signouts WHERE item_id = ?').get(lift.id);
  assert.deepEqual([s.user_id, s.start_at, s.end_at, s.place, s.job_number, s.returned_at], [userId('tech1'), `${day(2)}T07:00`, `${day(3)}T15:30`, 'Lincoln Elementary gym', 'J-5512', null]);
  // Two people cannot have it at once; a time that does not overlap is fine.
  const clash = (await ask(t2, { start_date: day(3), start_time: '08:00', end_date: day(3), end_time: '12:00', place: 'Elsewhere' })).text;
  assert.match(clash, /Scissor lift 1 is already signed out by Terry Tech from [A-Z][a-z]{2} \d+\/\d+, 7:00 AM until [A-Z][a-z]{2} \d+\/\d+, 3:30 PM \(Lincoln Elementary gym\)/);
  assert.equal((await ask(t2, { start_date: day(3), start_time: '15:30', end_date: day(3), end_time: '18:00', place: 'Elsewhere' })).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fleet_signouts WHERE item_id = ?').get(lift.id).n, 2);
  // Everyone sees who has it, when, where and for how long.
  const board = (await t2.get('/fleet/signout')).text.replace(/\s+/g, ' ');
  assert.match(board, /<strong>Scissor lift 1<\/strong><\/a><\/td> <td>Terry Tech<\/td> <td>[A-Z][a-z]{2} \d+\/\d+, 7:00 AM<br><span class="hint">until [A-Z][a-z]{2} \d+\/\d+, 3:30 PM \(1 day 8\.5 hours\)<\/span><\/td> <td>Lincoln Elementary gym<br><span class="hint">Job J-5512<\/span>/);
  // Only the person who signed it out, or whoever runs the fleet, can cancel or return it.
  assert.equal((await t2.post(`/fleet/signout/${s.id}/return`, {}, { page: '/fleet/signout' })).status, 403);
  await t1.post(`/fleet/signout/${s.id}/return`, {}, { page: '/fleet/signout' });                               // not out yet: cancelled
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fleet_signouts WHERE id = ?').get(s.id).n, 0);
  // One that is out now shows on the fleet list, and coming back frees the lift.
  const nowId = db.prepare('INSERT INTO fleet_signouts (item_id, user_id, start_at, end_at, place, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(lift.id, userId('tech2'), `${day(-1)}T08:00`, `${day(1)}T17:00`, 'Warehouse racking job', new Date().toISOString()).lastInsertRowid;
  assert.match((await t1.get('/fleet')).text.replace(/\s+/g, ' '), /<span class="tag request">Out<\/span> <span class="hint">Uma Tech, until /);
  assert.match((await ask(t1, { start_date: day(0), start_time: '23:00', end_date: day(1), end_time: '09:00' })).text, /already signed out by Uma Tech/);
  await owner.post(`/fleet/signout/${nowId}/return`, { back: 'fleet' }, { page: '/fleet' });
  assert.ok(db.prepare('SELECT returned_at FROM fleet_signouts WHERE id = ?').get(nowId).returned_at);
  assert.match((await t1.get('/fleet')).text.replace(/\s+/g, ' '), /SN 4471<\/td><td><\/td> <td><span class="tag return">Available<\/span>/);
  assert.match((await owner.get(`/fleet/${lift.id}`)).text, /Warehouse racking job/);                              // its history is kept on its own page
  // Put away, it leaves the list and can no longer be signed out; its page uses the site's own back button.
  assert.match((await t1.get(`/fleet/${lift.id}`)).text, /<p class="back"><a class="back-link" href="\/fleet">Fleet<\/a><\/p>/);
  await owner.post(`/fleet/${lift.id}`, { op: 'retire' }, { page: `/fleet/${lift.id}` });
  assert.doesNotMatch((await t1.get('/fleet/signout')).text, /Scissor lift 1<\/option>|Scissor lift 1 \(/);
  assert.match((await ask(t1, { start_date: day(5), end_date: day(6) })).text, /Choose which lift/);
  db.prepare("DELETE FROM fleet_items WHERE branch_id = ?").run(home);
});

test('office box: a corporate admin can find and switch to any office by typing, including one with nobody in it', async () => {
  const owner = await loggedIn('owner');
  const empty = db.prepare("INSERT INTO branches (name, number, state, created_at) VALUES ('Quietville', '9876', 'OH', ?)").run(new Date().toISOString()).lastInsertRowid;
  const total = db.prepare('SELECT COUNT(*) n FROM branches').get().n;
  const home = (await owner.get('/')).text;
  const list = (/<datalist id="office-list">([\s\S]*?)<\/datalist>/.exec(home) || [])[1] || '';
  assert.equal((list.match(/<option /g) || []).length, total + 1);                                   // every office, and "All offices"
  assert.ok(list.includes(`<option value="Quietville" data-id="${empty}" data-find="Ohio" label="#9876 · OH"></option>`));   // found by "ohio" as well as by its name   // nobody works there, and it is still offered
  assert.equal((home.match(/<datalist id="office-list">/g) || []).length, 1);                        // one list serves the box on a computer and the one in the phone menu
  assert.match((await owner.get('/site.js')).text, /data-office-pick/);
  // The site draws its own list under these boxes (phones do not show the browser's), and Enter takes the top line.
  const picker = (await owner.get('/site.js')).text; assert.match(picker, /pick-list/); assert.match(picker, /data-find/); assert.match(picker, /e\.key !== 'Enter'/);
  const viewing = async () => (/<input name="office" list="office-list" value="([^"]*)"/.exec((await owner.get('/')).text) || [])[1];
  // Picked from the list (its id is sent), typed in full, by its number, or back to all of them.
  await owner.post('/branch/view', { branch: String(empty), office: 'Quietville', back: '/' }, { page: '/' }); assert.equal(await viewing(), 'Quietville');
  await owner.post('/branch/view', { branch: '', office: 'all offices', back: '/' }, { page: '/' }); assert.equal(await viewing(), 'Corporate');   // the old name still works when typed
  await owner.post('/branch/view', { branch: String(empty), back: '/' }, { page: '/' }); await owner.post('/branch/view', { branch: '', office: 'corporate', back: '/' }, { page: '/' }); assert.equal(await viewing(), 'Corporate');
  await owner.post('/branch/view', { branch: '', office: 'quietville', back: '/' }, { page: '/' }); assert.equal(await viewing(), 'Quietville');
  await owner.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
  await owner.post('/branch/view', { branch: '', office: '#9876', back: '/' }, { page: '/' }); assert.equal(await viewing(), 'Quietville');
  // The name at the top of every page follows the office being looked at, and says so when it is all of them.
  const top = async (url) => (/<span class="branch">([^<]*)<\/span>/.exec((await owner.get(url)).text) || [])[1];
  assert.equal(await top('/'), 'Quietville Office'); assert.equal(await top('/admin/users'), 'Quietville Office');
  assert.match((await owner.get('/')).text, /<p class="hero-sub">Quietville Office<\/p>/);
  assert.match((await owner.get('/parts')).text, /<title>Parts · Pye-Barker Quietville Office<\/title>/);
  await owner.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' }); assert.equal(await top('/'), 'Corporate');
  assert.match((await owner.get('/')).text, /<p class="hero-sub">Corporate<\/p>/);                    // and under the greeting on the home page
  await owner.post('/branch/view', { branch: String(empty), back: '/' }, { page: '/' });
  // Something that is no office changes nothing and says so.
  await owner.post('/branch/view', { branch: '', office: 'Nowhereville', back: '/' }, { page: '/' });
  assert.match((await owner.get('/')).text, /No single office matches/); assert.equal(await viewing(), 'Quietville');
  // Still only for people who see every office.
  assert.equal((await (await loggedIn('tech1')).post('/branch/view', { branch: String(empty) }, { page: '/' })).status, 403);
  const home1 = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  await owner.post('/branch/view', { branch: String(home1), back: '/' }, { page: '/' });
  db.prepare('DELETE FROM inv_locations WHERE branch_id = ?').run(empty); db.prepare('DELETE FROM branches WHERE id = ?').run(empty);
});

test('markets: corporate admins group offices into markets and appoint market admins, who run each office of their market and nothing outside it', async () => {
  const owner = await loggedIn('owner'); const now = new Date().toISOString();
  const mk = (name, state) => { const id = db.prepare('INSERT INTO branches (name, state, created_at) VALUES (?, ?, ?)').run(name, state, now).lastInsertRowid; require('../app/branches').setUp(id); return id; };
  const a = mk('Mkt Alpha', 'PA'); const b = mk('Mkt Beta', 'DE'); const outside = mk('Mkt Outside', 'OH');
  // Only people who see every office reach the Markets page; it is in the Corporate menu.
  assert.equal((await (await loggedIn('tech1')).get('/admin/markets')).status, 403);
  assert.match((await owner.get('/')).text, /<a href="\/admin\/markets"[^>]*>Markets/);
  // A market is made, named once, and filled with offices found by name or picked from the list.
  await owner.post('/admin/markets', { name: 'Test Valley' }, { page: '/admin/markets' });
  assert.match((await owner.post('/admin/markets', { name: 'test valley' }, { page: '/admin/markets' })).text, /already a market with that name/);
  const m = db.prepare("SELECT id FROM markets WHERE name = 'Test Valley'").get().id;
  await owner.post(`/admin/markets/${m}/offices`, { office: 'mkt alpha', branch: '' }, { page: '/admin/markets' });
  await owner.post(`/admin/markets/${m}/offices`, { office: 'Mkt Beta', branch: String(b) }, { page: '/admin/markets' });
  await owner.post(`/admin/markets/${m}/offices`, { office: 'No Such Town', branch: '' }, { page: '/admin/markets' });
  const inMarket = () => db.prepare('SELECT name FROM branches WHERE market_id = ? ORDER BY name').all(m).map((r) => r.name);
  assert.deepEqual(inMarket(), ['Mkt Alpha', 'Mkt Beta']);
  const page = (await owner.get('/admin/markets')).text.replace(/\s+/g, ' ');
  assert.match(page, /No single office matches/); assert.match(page, /<h2>Test Valley <span class="meta">2 offices<\/span>/);
  assert.match(page, new RegExp(`<option value="Mkt Outside" data-id="${outside}" data-find="Ohio" label="OH · no market yet">`)); assert.match(page, /label="PA · in Test Valley"/);
  // An office belongs to one market: adding it to another moves it. Taking it out leaves it in none.
  await owner.post('/admin/markets', { name: 'Other Side' }, { page: '/admin/markets' });
  const m2 = db.prepare("SELECT id FROM markets WHERE name = 'Other Side'").get().id;
  await owner.post(`/admin/markets/${m2}/offices`, { branch: String(b) }, { page: '/admin/markets' }); assert.deepEqual(inMarket(), ['Mkt Alpha']);
  await owner.post(`/admin/markets/${m2}/offices/${b}/remove`, {}, { page: '/admin/markets' }); assert.equal(db.prepare('SELECT market_id FROM branches WHERE id = ?').get(b).market_id, null);
  await owner.post(`/admin/markets/${m}/offices`, { branch: String(b) }, { page: '/admin/markets' }); assert.deepEqual(inMarket(), ['Mkt Alpha', 'Mkt Beta']);

  // A market admin is someone already listed in one of the market's offices, given a market admin profile by a corporate admin.
  const profile = access.ensureProfile('Market admin', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'backups'));
  assert.ok(access.permsOf(profile).has('market.all'));
  const put = (username, name, office) => { const id = auth.createUser({ username, displayName: name, password: 'correct horse battery', profile: profileId('Technician'), branchId: office }); db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id); return id; };
  const mia = put('mkt.mia', 'Mia Market', a); put('mkt.bea', 'Bea Beta', b); const otto = put('mkt.otto', 'Otto Outside', outside);
  assert.match((await owner.post(`/admin/markets/${m}/admins`, { profile_id: String(profile), user_id: String(otto) }, { page: '/admin/markets' })).text, /Choose someone from one of the Test Valley market/);   // not in this market
  assert.match((await owner.post(`/admin/markets/${m}/admins`, { profile_id: String(profileId('Corporate admin')), user_id: String(mia) }, { page: '/admin/markets' })).text, /Choose which market admin profile/);
  await owner.post(`/admin/markets/${m}/admins`, { profile_id: String(profile), person: 'mia market', user_id: '' }, { page: '/admin/markets' });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(mia).profile_id, profile);
  assert.match((await owner.get('/admin/markets')).text.replace(/\s+/g, ' '), /<strong>Mia Market<\/strong> <span class="meta">Mkt Alpha · Market admin<\/span>/);
  // The office admin form on the Corporate page does not hand out the market profile.
  assert.doesNotMatch((/<details class="appoint"[\s\S]*?<\/details>/.exec((await owner.get(`/admin/branches?office=${a}`)).text) || [''])[0], />Market admin</);

  // Mia: an office box holding her market's offices only, no "All offices", no Corporate menu.
  const mc = await loggedIn('mkt.mia');
  const home = (await mc.get('/')).text;
  const list = (/<datalist id="office-list">([\s\S]*?)<\/datalist>/.exec(home) || [])[1] || '';
  assert.deepEqual([...list.matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]), ['Mkt Alpha', 'Mkt Beta']);
  assert.doesNotMatch(home, /\/admin\/branches|\/admin\/markets|\/admin\/profiles/);
  for (const url of ['/admin/markets', '/admin/branches', '/admin/profiles', '/admin/backups']) assert.equal((await mc.get(url)).status, 403, url);
  // She runs Alpha, switches to Beta and runs that, and cannot reach an office outside the market or all of them at once.
  const sees = async () => (await mc.get('/admin/users')).text;
  assert.match(await sees(), /Mia Market/); assert.doesNotMatch(await sees(), /Bea Beta|Otto Outside|Terry Tech/);
  await mc.post('/branch/view', { branch: String(b), back: '/' }, { page: '/' });
  assert.match(await sees(), /Bea Beta/); assert.doesNotMatch(await sees(), /Otto Outside|Terry Tech/);
  // She keeps the office page of any office in her market, and takes down what its people posted; nothing outside it.
  assert.equal((await mc.post(`/branches/${b}`, [['address', '9 Market Row'], ['phone', '302-555-0100'], ['about', 'Kept by the market admin.']], { page: `/branches/${b}`, multipart: true })).status, 302);
  assert.equal(db.prepare('SELECT address FROM branches WHERE id = ?').get(b).address, '9 Market Row');
  assert.equal((await mc.post(`/branches/${outside}`, [['address', 'Not hers'], ['phone', ''], ['about', '']], { page: `/branches/${outside}`, multipart: true })).status, 403);
  const miaAcc = access.loadAccess(db.prepare('SELECT * FROM users WHERE id = ?').get(mia));
  assert.equal(access.moderates(miaAcc, 'forum.moderate', userId('mkt.bea')), true); assert.equal(access.moderates(miaAcc, 'forum.moderate', otto), false);
  await mc.post('/branch/view', { branch: String(outside), back: '/' }, { page: '/' });
  assert.match(await sees(), /Bea Beta/); assert.doesNotMatch(await sees(), /Otto Outside/);                    // refused: still looking at Beta
  await mc.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' }); await mc.post('/branch/view', { branch: '', office: 'All offices', back: '/' }, { page: '/' });
  assert.match(await sees(), /Bea Beta/); assert.doesNotMatch(await sees(), /Otto Outside|Terry Tech/);
  await mc.post('/branch/view', { branch: '', office: 'mkt alpha', back: '/' }, { page: '/' }); assert.match(await sees(), /Mia Market/);
  // On call is shared across the market's offices.
  assert.deepEqual(require('../app/oncall').officesFor({ workBranch: a, branch_id: a }).map((o) => o.name).sort(), ['Mkt Alpha', 'Mkt Beta']);
  assert.equal(require('../app/oncall').officesFor({ workBranch: a, branch_id: a })[0].market, 'Test Valley');
  // An office taken out of the market leaves her reach at once; someone who is not in a market sees only their own office.
  await owner.post(`/admin/markets/${m}/offices/${b}/remove`, {}, { page: '/admin/markets' });
  await mc.post('/branch/view', { branch: String(b), back: '/' }, { page: '/' });
  assert.match(await sees(), /Mia Market/); assert.doesNotMatch(await sees(), /Bea Beta/);
  assert.doesNotMatch((await mc.get('/')).text, /data-office-pick/);                                               // one office left: nothing to choose between
  // Looking at the site as the Market admin profile gives the same box, for the market of the office in view.
  await owner.post(`/admin/markets/${m}/offices`, { branch: String(b) }, { page: '/admin/markets' });
  await owner.post('/branch/view', { branch: String(a), back: '/' }, { page: '/' }); await owner.post('/view-as', { profile: String(profile) }, { page: '/' });
  const asMkt = (await owner.get('/')).text;
  assert.match(asMkt, /looking at the site as <strong>Market admin<\/strong>/);
  assert.deepEqual([...((/<datalist id="office-list">([\s\S]*?)<\/datalist>/.exec(asMkt) || [])[1] || '').matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]), ['Mkt Alpha', 'Mkt Beta']);
  await owner.post('/branch/view', { branch: String(b), back: '/' }, { page: '/' });
  assert.match((await owner.get('/')).text, /<span class="branch">Mkt Beta Office<\/span>/);
  await owner.post('/view-as', { profile: '' }, { page: '/' });
  await owner.post(`/admin/markets/${m}/offices/${b}/remove`, {}, { page: '/admin/markets' });
  // Stood down, she is a technician again and is signed out; renaming and removing a market keep its offices.
  await owner.post(`/admin/markets/${m}/admins/${mia}/remove`, {}, { page: '/admin/markets' });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(mia).profile_id, profileId('Technician'));
  assert.equal((await mc.get('/admin/users')).status, 302);
  await owner.post(`/admin/markets/${m}`, { name: 'Renamed Valley' }, { page: '/admin/markets' });
  assert.equal(db.prepare('SELECT name FROM markets WHERE id = ?').get(m).name, 'Renamed Valley');
  await owner.post(`/admin/markets/${m}`, { op: 'remove' }, { page: '/admin/markets' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM markets WHERE id = ?').get(m).n, 0); assert.equal(db.prepare('SELECT market_id FROM branches WHERE id = ?').get(a).market_id, null);
  assert.ok(db.prepare('SELECT 1 FROM branches WHERE id = ?').get(a));
  db.prepare('DELETE FROM markets WHERE id = ?').run(m2);
});

test('on call: the Call button carries the number so a computer can show it; a phone still dials', async () => {
  const owner = await loggedIn('owner');
  const home = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  await owner.post('/branch/view', { branch: String(home), back: '/' }, { page: '/' });
  const day = (n) => { const d = new Date(`${require('../app/util').localDate()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  await owner.post('/admin/oncall', { start_on: day(-1), end_on: day(2), role: 'tech', name: 'Cal Caller', phone: '(717) 555-0199' }, { page: '/oncall' });
  const page = (await owner.get('/oncall')).text;
  assert.match(page, /<a class="btn primary" href="tel:7175550199" data-full data-call-number="\(717\) 555-0199" data-call-name="Cal Caller">Call<\/a>/);   // the link a phone dials, and the number a computer shows
  assert.match((await owner.get('/')).text, /href="tel:7175550199" data-full data-call-number="\(717\) 555-0199" data-call-name="Cal Caller">Call<\/a>/);   // the home page's On call now panel does the same
  const js = (await owner.get('/site.js')).text;
  assert.match(js, /a\[data-call-number\]/); assert.match(js, /\(hover: hover\) and \(pointer: fine\)/); assert.match(js, /if \(!desk\) return;/);   // only a computer gets the pop-up
  db.prepare("DELETE FROM oncall_shifts WHERE name = 'Cal Caller'").run();
});

test('each office its own, each market together: shout-outs, events, newsletters, announcements, birthdays and the home page follow the office being looked at', async () => {
  const owner = await loggedIn('owner'); const now = new Date().toISOString();
  const mk = (name) => { const id = db.prepare('INSERT INTO branches (name, state, created_at) VALUES (?, ?, ?)').run(name, 'PA', now).lastInsertRowid; require('../app/branches').setUp(id); return id; };
  const a = mk('Reach Alpha'); const b = mk('Reach Beta'); const c = mk('Reach Gamma');
  const m = db.prepare("INSERT INTO markets (name, created_at) VALUES ('Reach Valley', ?)").run(now).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id IN (?, ?)').run(m, a, b);
  access.ensureProfile('Market admin', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'backups'));
  const put = (username, name, office, profile = 'Technician') => { const id = auth.createUser({ username, displayName: name, password: 'correct horse battery', profile: profileId(profile), branchId: office }); db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id); return id; };
  const amy = put('reach.amy', 'Amy Alphason', a); const bo = put('reach.bo', 'Bo Betason', b); const cy = put('reach.cy', 'Cy Gammason', c);
  put('reach.al', 'Al Alphason', a); put('reach.mk', 'Mara Market', a, 'Market admin');
  const al = await loggedIn('reach.al'); const boC = await loggedIn('reach.bo'); const cyC = await loggedIn('reach.cy'); const mara = await loggedIn('reach.mk');
  const view = (who, office) => who.post('/branch/view', { branch: String(office), back: '/' }, { page: '/' });
  const has = async (who, url, re) => assert.match((await who.get(url)).text, re);
  const hasNot = async (who, url, re) => assert.doesNotMatch((await who.get(url)).text, re);

  // ---- Shout-outs: the giver's office and the receiver's office see one, nobody else. They are given within the market.
  await al.post('/shoutouts', { to_user: String(amy), message: 'REACH inside Alpha' }, { page: '/shoutouts' });
  await al.post('/shoutouts', { to_user: String(bo), message: 'REACH Alpha to Beta' }, { page: '/shoutouts' });
  const far = await al.post('/shoutouts', { to_user: String(cy), message: 'REACH out of the market' }, { page: '/shoutouts' });
  assert.equal(far.status, 400); assert.match(far.text, /Shout-outs are for people in your own office or your market\./);
  for (const url of ['/', '/shoutouts']) {
    await has(al, url, /REACH inside Alpha/); await has(al, url, /REACH Alpha to Beta/);
    await has(boC, url, /REACH Alpha to Beta/); await hasNot(boC, url, /REACH inside Alpha/);
    await hasNot(cyC, url, /REACH/);
  }
  await hasNot(boC, `/people/${amy}`, /REACH inside Alpha/);                                   // nor on her page, seen from another office
  await has(al, `/people/${amy}`, /REACH inside Alpha/);
  await hasNot(cyC, `/people/${bo}`, /Give a shout-out/); await has(al, `/people/${bo}`, /Give a shout-out/);
  // Another office's page keeps its people and details, and leaves out its shout-outs and events.
  await has(al, `/branches/${a}`, /id="bsh-h"/); await hasNot(boC, `/branches/${a}`, /id="bsh-h"|REACH inside Alpha/);
  await has(boC, `/branches/${a}`, /Amy Alphason/);

  // ---- Events: for one office, for the market, or for the whole company. An event goes to the office being looked at.
  await view(owner, a);
  const soon = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };
  await owner.post('/events', { title: 'REACH Alpha lunch', event_date: soon(5), reach: 'office' }, { page: '/events' });
  await owner.post('/events', { title: 'REACH Valley picnic', event_date: soon(6), reach: 'market' }, { page: '/events' });
  await owner.post('/events', { title: 'REACH Company day', event_date: soon(7), reach: 'company' }, { page: '/events' });
  const ev = (title) => db.prepare('SELECT * FROM events WHERE title = ?').get(title);
  assert.deepEqual([ev('REACH Alpha lunch'), ev('REACH Valley picnic'), ev('REACH Company day')].map((e) => [e.branch_id, e.market_id]), [[a, null], [a, m], [null, null]]);
  for (const url of ['/', '/events']) {
    await has(al, url, /REACH Alpha lunch/); await has(al, url, /REACH Valley picnic/); await has(al, url, /REACH Company day/);
    await hasNot(boC, url, /REACH Alpha lunch/); await has(boC, url, /REACH Valley picnic/); await has(boC, url, /REACH Company day/);
    await hasNot(cyC, url, /REACH Alpha lunch|REACH Valley picnic/); await has(cyC, url, /REACH Company day/);
  }
  // A market admin posts for an office of their market or for the market, never for the company, and runs what is theirs.
  await view(mara, b);
  const maraForm = (await mara.get('/events')).text;
  assert.match(maraForm, /<option value="office" >Reach Beta office only<\/option><option value="market" >The Reach Valley market<\/option><\/select>/);
  await mara.post('/events', { title: 'REACH Beta cookout', event_date: soon(8), reach: 'company' }, { page: '/events' });   // not theirs to choose: it stays with the office
  assert.deepEqual([ev('REACH Beta cookout').branch_id, ev('REACH Beta cookout').market_id], [b, null]);
  await has(boC, '/events', /REACH Beta cookout/); await hasNot(al, '/events', /REACH Beta cookout/);
  assert.equal((await mara.post(`/events/${ev('REACH Company day').id}/delete`, {}, { page: '/events' })).status, 403);
  assert.equal((await mara.post(`/events/${ev('REACH Valley picnic').id}/delete`, {}, { page: '/events' })).status, 302);
  assert.equal(ev('REACH Valley picnic'), undefined); assert.ok(ev('REACH Company day'));
  await view(mara, a);

  // ---- Announcements: the same three reaches, and the home page shows the ones for the office being looked at.
  const post = (title, reach) => owner.post('/admin/announcements', { title, body: `${title} body`, reach }, { page: '/admin/announcements' });
  await post('REACH Alpha notice', 'office'); await post('REACH Valley notice', 'market'); await post('REACH Company notice', 'company');
  const note = (title) => db.prepare('SELECT branch_id, market_id FROM announcements WHERE title = ?').get(title);
  assert.deepEqual([note('REACH Alpha notice'), note('REACH Valley notice'), note('REACH Company notice')].map((n) => [n.branch_id, n.market_id]), [[a, null], [a, m], [null, null]]);
  for (const url of ['/', '/notices']) {
    await has(al, url, /REACH Alpha notice/); await has(al, url, /REACH Valley notice/); await has(al, url, /REACH Company notice/);
    await hasNot(boC, url, /REACH Alpha notice/); await has(boC, url, /REACH Valley notice/);
    await hasNot(cyC, url, /REACH Alpha notice|REACH Valley notice/); await has(cyC, url, /REACH Company notice/);
  }
  const who = (await owner.get('/admin/announcements')).text.replace(/\s+/g, ' ');
  assert.match(who, /REACH Valley notice[\s\S]*?<td>Reach Valley market<\/td>\s*<td><strong>\d of 4<\/strong>/);          // everyone in the market's two offices
  assert.match(who, /REACH Alpha notice[\s\S]*?<td>Reach Alpha office<\/td>\s*<td><strong>\d of 3<\/strong>/);

  // ---- Newsletters: each office has its own; a market or the company can have one too.
  const issue = (month, title, reach) => owner.post('/admin/newsletters', { issue_month: month, title, reach, pdf: new Blob([tinyPdf()], { type: 'application/pdf' }) }, { page: '/admin/newsletters', multipart: true });
  await issue('2031-01', 'REACH Alpha Barker', 'office'); await issue('2031-02', 'REACH Valley Barker', 'market'); await issue('2031-03', 'REACH Company Barker', 'company');
  const nl = (title) => db.prepare('SELECT * FROM newsletters WHERE title = ?').get(title);
  assert.deepEqual([nl('REACH Alpha Barker'), nl('REACH Valley Barker'), nl('REACH Company Barker')].map((n) => [n.branch_id, n.market_id]), [[a, null], [a, m], [null, null]]);
  const titles = async (who2) => [...(await who2.get('/newsletters')).text.matchAll(/href="\/newsletters\/(\d+)"/g)].map((x) => db.prepare('SELECT title FROM newsletters WHERE id = ?').get(x[1]).title);
  assert.deepEqual(await titles(al), ['REACH Company Barker', 'REACH Valley Barker', 'REACH Alpha Barker']);            // none of another office's earlier issues
  assert.deepEqual(await titles(boC), ['REACH Company Barker', 'REACH Valley Barker']);
  assert.deepEqual(await titles(cyC), ['REACH Company Barker']);
  for (const tail of ['', '/pdf']) {
    assert.equal((await boC.get(`/newsletters/${nl('REACH Alpha Barker').id}${tail}`)).status, 404);                     // another office's issue is not there for them
    assert.notEqual((await al.get(`/newsletters/${nl('REACH Alpha Barker').id}${tail}`)).status, 404);
  }
  // Whoever runs an office removes its issues; the company's are for corporate admins.
  const maraList = (await mara.get('/admin/newsletters')).text;
  assert.match(maraList, /REACH Alpha Barker/); assert.match(maraList, /REACH Valley Barker/); assert.doesNotMatch(maraList, /REACH Company Barker/);
  assert.equal((await mara.post(`/admin/newsletters/${nl('REACH Company Barker').id}/delete`, {}, { page: '/admin/newsletters' })).status, 403);
  assert.ok(nl('REACH Company Barker'));

  // ---- Birthdays reach the market; the office tiles count the office being looked at.
  const md = require('../app/util').localDate().slice(5);
  db.prepare('UPDATE users SET birthday = ? WHERE id IN (?, ?)').run(md, amy, cy);
  await has(boC, '/', /Amy Alphason/); await hasNot(boC, '/', /Cy Gammason/);
  await has(cyC, '/', /Cy Gammason/); await hasNot(cyC, '/', /Amy Alphason/);

  // ---- Someone who runs several offices sees each one as its own people do; the Corporate view has the company's own.
  await view(owner, b);
  const atBeta = (await owner.get('/')).text;
  assert.match(atBeta, /in the Reach Beta office/); assert.match(atBeta, /REACH Valley notice/); assert.match(atBeta, /REACH Alpha to Beta/);
  assert.doesNotMatch(atBeta, /REACH Alpha notice|REACH inside Alpha|REACH Alpha lunch/);
  await view(owner, c);
  assert.doesNotMatch((await owner.get('/')).text, /REACH Alpha|REACH Valley|REACH inside/);
  await owner.post('/branch/view', { branch: 'all', back: '/' }, { page: '/' });
  const corp = (await owner.get('/')).text;
  assert.match(corp, /across every office/); assert.match(corp, /REACH Company notice/); assert.match(corp, /REACH Company day/);
  assert.doesNotMatch(corp, /REACH Alpha notice|REACH Valley notice|REACH Alpha lunch|REACH Beta cookout/);
  await has(owner, '/events', /REACH Beta cookout[\s\S]*Reach Beta office/);                    // the full pages list every office's, each marked
  await has(owner, '/shoutouts', /REACH inside Alpha/);
  assert.deepEqual((await titles(owner)).filter((t) => /^REACH/.test(t)), ['REACH Company Barker', 'REACH Valley Barker', 'REACH Alpha Barker']);

  const homeId = db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId('owner')).branch_id;
  await view(owner, homeId);
  db.transaction(() => {
    db.prepare("DELETE FROM shoutouts WHERE message LIKE 'REACH%'").run(); db.prepare("DELETE FROM events WHERE title LIKE 'REACH%'").run();
    db.prepare("DELETE FROM announcement_reads WHERE announcement_id IN (SELECT id FROM announcements WHERE title LIKE 'REACH%')").run(); db.prepare("DELETE FROM announcements WHERE title LIKE 'REACH%'").run();
    db.prepare("DELETE FROM newsletters WHERE title LIKE 'REACH%'").run();
    db.prepare("UPDATE users SET active = 0, birthday = NULL WHERE username LIKE 'reach.%'").run();
    db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(m); db.prepare('DELETE FROM markets WHERE id = ?').run(m);
  })();
});

test('six roles: a level on each profile, a manager at every level who runs the day-to-day, and admins who also manage people and appoint', async () => {
  const owner = await loggedIn('owner'); const now = new Date().toISOString();
  // The ladder, from the profiles themselves: where each sits and what it is called.
  const at = (name) => { const p = access.profileByName(name); return access.position(p.scope, access.permsOf(p.id)); };
  assert.deepEqual(['Corporate admin', 'Corporate manager', 'Market manager', 'Branch manager', 'Manager', 'Technician'].map((n) => [at(n).level, at(n).kind]),
    [['company', 'admin'], ['company', 'manager'], ['market', 'manager'], ['office', 'manager'], ['team', 'manager'], ['office', 'staff']]);
  assert.ok(at('Corporate admin').rank > at('Corporate manager').rank && at('Corporate manager').rank > at('Market manager').rank && at('Market manager').rank > at('Branch manager').rank && at('Branch manager').rank > at('Manager').rank);
  // A manager holds none of the admin's side, at any level.
  for (const n of ['Corporate manager', 'Market manager', 'Branch manager']) for (const p of access.ADMIN_ONLY) assert.ok(!access.permsOf(profileId(n)).has(p), `${n} ${p}`);
  for (const p of ['parts.manage', 'tasks.assign', 'oncall.manage', 'announcements.post', 'events.post', 'stock.manage', 'fleet.manage']) assert.ok(access.permsOf(profileId('Branch manager')).has(p), p);

  // The level is one choice on the profile page, and it sets what the site reads: the scope and the two level permissions.
  await owner.post('/admin/profiles', { name: 'Level Check' }, { page: '/admin/profiles' });
  const pid = profileId('Level Check'); const save = (level) => owner.post(`/admin/profiles/${pid}`, [['name', 'Level Check'], ['level', level], ['perms', 'parts.submit'], ['perms', 'tasks.assign']], { page: `/admin/profiles/${pid}` });
  const state = () => { const p = db.prepare('SELECT scope FROM profiles WHERE id = ?').get(pid); const perms = access.permsOf(pid); return [p.scope, perms.has('market.all'), perms.has('branches.all'), perms.has('tasks.assign')]; };
  await save('market'); assert.deepEqual(state(), ['all', true, false, true]);
  await save('company'); assert.deepEqual(state(), ['all', true, true, true]);
  await save('team'); assert.deepEqual(state(), ['team', false, false, true]);
  await save('office'); assert.deepEqual(state(), ['all', false, false, true]);
  const list = (await owner.get('/admin/profiles')).text.replace(/\s+/g, ' ');
  assert.match(list, /<strong>Corporate manager<\/strong><\/a><\/td> <td>The whole company <span class="tag">Manager<\/span><\/td>/);
  assert.match(list, /<strong>Level Check<\/strong><\/a><\/td> <td>Their office <span class="tag">Manager<\/span><\/td>/);
  assert.ok(list.indexOf('<strong>Corporate admin</strong>') < list.indexOf('<strong>Corporate manager</strong>') && list.indexOf('<strong>Corporate manager</strong>') < list.indexOf('<strong>Branch manager</strong>'));   // top of the ladder first
  db.prepare('DELETE FROM profile_permissions WHERE profile_id = ?').run(pid); db.prepare('DELETE FROM profiles WHERE id = ?').run(pid);

  const mk = (name) => { const id = db.prepare('INSERT INTO branches (name, state, created_at) VALUES (?, ?, ?)').run(name, 'PA', now).lastInsertRowid; require('../app/branches').setUp(id); return id; };
  const a = mk('Role Alpha'); const b = mk('Role Beta'); const out = mk('Role Outside');
  const m = db.prepare("INSERT INTO markets (name, created_at) VALUES ('Role Valley', ?)").run(now).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id IN (?, ?)').run(m, a, b);
  access.ensureProfile('Market admin', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'backups'));
  const put = (username, name, office, profile = 'Technician') => { const id = auth.createUser({ username, displayName: name, password: 'correct horse battery', profile: profileId(profile), branchId: office }); db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id); return id; };
  const tess = put('role.tess', 'Tess Alphatech', a); put('role.bea', 'Bea Betatech', b); const brad = put('role.brad', 'Brad Branchman', a);
  put('role.cm', 'Cora Corpman', a, 'Corporate manager'); put('role.mm', 'Mack Marketman', a, 'Market manager'); put('role.ma', 'Mia Marketadmin', a, 'Market admin');

  // ---- Corporate manager: sees and runs every office, with none of the admin pages.
  const cora = await loggedIn('role.cm');
  const coraHome = (await cora.get('/')).text;
  assert.match(coraHome, /data-office-pick/); assert.match(coraHome, /<option value="Corporate"/);
  assert.doesNotMatch(coraHome, /href="\/admin\/branches"|href="\/admin\/markets"|href="\/admin\/profiles"|href="\/admin\/users"|href="\/admin\/backups"/);
  for (const url of ['/admin/branches', '/admin/markets', '/admin/profiles', '/admin/users', '/admin/backups', '/admin/activity', '/admin/complaints', '/admin/security']) assert.equal((await cora.get(url)).status, 403, url);
  for (const url of ['/admin/requests', '/admin/tasks', '/admin/stock', '/fleet', '/oncall', '/admin/announcements']) assert.equal((await cora.get(url)).status, 200, url);
  await cora.post('/branch/view', { branch: String(b), back: '/' }, { page: '/' });
  assert.match((await cora.get('/')).text, /<span class="branch">Role Beta Office<\/span>/);
  assert.match((await cora.get('/events')).text, /<option value="company" >The whole company<\/option>/);                 // posts for the company
  assert.equal((await cora.post(`/branches/${b}`, [['address', 'Not for a manager'], ['phone', ''], ['about', '']], { page: `/branches/${b}`, multipart: true })).status, 403);   // office pages are kept by admins
  assert.equal((await cora.post('/admin/markets', { name: 'Sneaky Market' }, { page: '/' })).status, 403);

  // ---- Market manager: each office of the market, nothing outside it, and no people pages.
  const mack = await loggedIn('role.mm');
  const offices = (html) => [...((/<datalist id="office-list">([\s\S]*?)<\/datalist>/.exec(html) || [])[1] || '').matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(offices((await mack.get('/')).text), ['Role Alpha', 'Role Beta']);
  assert.equal((await mack.get('/admin/users')).status, 403); assert.equal((await mack.get('/admin/requests')).status, 200);
  await mack.post('/branch/view', { branch: String(out), back: '/' }, { page: '/' });
  assert.match((await mack.get('/')).text, /<span class="branch">Role Alpha Office<\/span>/);                           // refused: still at Alpha
  assert.match((await mack.get('/events')).text, /<option value="market" >The Role Valley market<\/option><\/select>/);   // the market, not the company

  // ---- A branch manager is appointed on the Offices page beside the office's admins, and stood down the same way.
  const pick = /<details class="appoint"[\s\S]*?<\/details>/.exec((await owner.get(`/admin/branches?office=${a}`)).text)[0];
  assert.match(pick, /<label>Role <select name="profile_id">[\s\S]*>Office admin \(one office\)<\/option>[\s\S]*>Branch manager<\/option>/);   // admins first, then managers assert.doesNotMatch(pick, />Market manager<|>Corporate manager<|>Technician</);
  await owner.post(`/admin/branches/${a}/admins`, { profile_id: String(profileId('Branch manager')), user_id: String(brad) }, { page: '/admin/branches' });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(brad).profile_id, profileId('Branch manager'));
  assert.match((await owner.get(`/admin/branches?office=${a}`)).text.replace(/\s+/g, ' '), /<strong>Brad Branchman<\/strong><span class="meta">Branch manager/);
  const bradC = await loggedIn('role.brad');
  assert.equal((await bradC.get('/admin/requests')).status, 200); assert.equal((await bradC.get('/admin/users')).status, 403);
  assert.doesNotMatch((await bradC.get('/')).text, /data-office-pick/);                                                  // one office: nothing to switch between
  assert.match((await owner.get('/admin/markets')).text.replace(/\s+/g, ' '), /<strong>Mack Marketman<\/strong> <span class="meta">Role Alpha · Market manager<\/span>/);

  // ---- Admins appoint the level below: a market admin can make someone in their market an office admin or manager, and nothing above their own reach.
  const mia = await loggedIn('role.ma');
  const choices = /<select name="profile_id" required>[\s\S]*?<\/select>/.exec((await mia.get(`/admin/users/${tess}/edit`)).text)[0];
  for (const n of ['Office admin \\(one office\\)', 'Branch manager', 'Market manager', 'Manager', 'Technician']) assert.match(choices, new RegExp(`>${n}</option>`), n);
  assert.doesNotMatch(choices, />Corporate admin<|>Corporate manager</);
  // A branch manager cannot hand out anything: the Users page is not theirs.
  assert.equal((await bradC.get(`/admin/users/${tess}/edit`)).status, 403);

  await owner.post(`/admin/branches/${a}/admins/${brad}/remove`, {}, { page: '/admin/branches' });
  assert.equal(db.prepare('SELECT profile_id FROM users WHERE id = ?').get(brad).profile_id, profileId('Technician'));
  db.transaction(() => {
    db.prepare("UPDATE users SET active = 0, profile_id = ? WHERE username LIKE 'role.%'").run(profileId('Technician'));
    db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(m); db.prepare('DELETE FROM markets WHERE id = ?').run(m);
  })();
});

test('chain of command: an office answers to its market and the market to corporate, shown on the office page and on each person', async () => {
  const now = new Date().toISOString(); const chain = require('../app/chain');
  const mk = (name) => { const id = db.prepare('INSERT INTO branches (name, state, created_at) VALUES (?, ?, ?)').run(name, 'PA', now).lastInsertRowid; require('../app/branches').setUp(id); return id; };
  const a = mk('Chain Alpha'); const b = mk('Chain Beta'); const solo = mk('Chain Solo');
  const m = db.prepare("INSERT INTO markets (name, created_at) VALUES ('Chain Valley', ?)").run(now).lastInsertRowid;
  db.prepare('UPDATE branches SET market_id = ? WHERE id IN (?, ?)').run(m, a, b);
  access.ensureProfile('Market admin', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'backups'));
  const officeAdmin = access.ensureProfile('Office admin (one office)', 'all', access.ALL.filter((p) => p !== 'branches.all' && p !== 'market.all'));
  const put = (username, name, office, profile) => { const id = auth.createUser({ username, displayName: name, password: 'correct horse battery', profile, branchId: office }); db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(id); return id; };
  const tech = put('chain.tech', 'Tia Chaintech', a, profileId('Technician'));
  const bm = put('chain.bm', 'Bram Chainmanager', a, profileId('Branch manager'));
  const ba = put('chain.ba', 'Ada Chainadmin', a, officeAdmin);
  const mm = put('chain.mm', 'Mo Chainmarket', b, profileId('Market manager'));
  const ma = put('chain.ma', 'Mae Chainmarket', b, profileId('Market admin'));
  const cm = put('chain.cm', 'Cy Chaincorp', solo, profileId('Corporate manager'));
  const soloTech = put('chain.solo', 'Sol Chainsolo', solo, profileId('Technician'));

  // The office's chain, top first. Each level lists its admins before its managers.
  const steps = chain.forOffice(a);
  assert.deepEqual(steps.map((s) => s.label), ['Corporate', 'Chain Valley market', 'Chain Alpha office']);
  assert.deepEqual(steps[1].people.map((p) => [p.display_name, p.role]), [['Mae Chainmarket', 'Market admin'], ['Mo Chainmarket', 'Market manager']]);
  assert.deepEqual(steps[2].people.map((p) => [p.display_name, p.role]), [['Ada Chainadmin', 'Office admin (one office)'], ['Bram Chainmanager', 'Branch manager']]);
  // Corporate lists its admins first and stops at a dozen names, saying how many more there are.
  assert.ok(steps[0].people.length <= 12 && steps[0].people.every((p) => p.kind === 'admin' || steps[0].more === 0));
  const others = db.prepare("SELECT id FROM users WHERE active = 1 AND id <> ? AND is_master = 0 AND username NOT LIKE 'chain.%' AND profile_id IN (SELECT profile_id FROM profile_permissions WHERE permission = 'branches.all')").all(userId('owner')).map((r) => r.id);
  db.prepare(`UPDATE users SET active = 0 WHERE id IN (${others.join(',') || 0})`).run();                           // set aside for a moment, so the short list is this test's own
  const corp = chain.forOffice(a)[0];
  assert.ok(corp.people.some((p) => p.display_name === 'Cy Chaincorp' && p.role === 'Corporate manager'), JSON.stringify(corp.people.map((p) => p.display_name)));
  assert.equal(corp.people[corp.people.length - 1].display_name, 'Cy Chaincorp');                                  // a manager comes after the admins
  assert.ok(!steps.some((s) => s.people.some((p) => p.display_name === 'Tia Chaintech')));                        // staff are not in it
  // An office in no market answers straight to corporate; with nobody of its own yet, it says so.
  assert.deepEqual(chain.forOffice(solo).map((s) => [s.label, s.key === 'office' ? s.people.length : null]), [['Corporate', null], ['Chain Solo office', 0]]);

  // Who is above one person, nearest first. A manager answers to the admins of their own level before the next one up.
  const up = (id) => chain.above(id).map((s) => [s.label, s.people.map((p) => p.display_name).filter((n) => /Chain/.test(n))]);
  assert.deepEqual(up(tech).slice(0, 2), [['Chain Alpha office', ['Ada Chainadmin', 'Bram Chainmanager']], ['Chain Valley market', ['Mae Chainmarket', 'Mo Chainmarket']]]);
  assert.deepEqual(up(bm).slice(0, 2), [['Chain Alpha office', ['Ada Chainadmin']], ['Chain Valley market', ['Mae Chainmarket', 'Mo Chainmarket']]]);
  assert.deepEqual(up(ba)[0], ['Chain Valley market', ['Mae Chainmarket', 'Mo Chainmarket']]);
  assert.deepEqual(up(mm)[0], ['Chain Valley market', ['Mae Chainmarket']]);
  assert.equal(up(ma)[0][0], 'Corporate'); assert.equal(up(ma).length, 1);
  assert.ok(!chain.above(cm).some((s) => s.people.some((p) => p.display_name === 'Cy Chaincorp')));               // never themselves
  assert.deepEqual(chain.above(soloTech).map((s) => s.label), ['Corporate']);                                    // nobody runs Solo yet, and it is in no market
  assert.deepEqual(chain.above(db.prepare('SELECT id FROM users WHERE is_master = 1').get().id), []);             // the top has nobody above
  const top = db.prepare('SELECT id, branch_id FROM users WHERE is_master = 1').get();
  assert.ok(chain.forOffice(top.branch_id)[0].people.some((p) => p.id === top.id && p.role === 'Master account'));
  assert.ok(!chain.forOffice(top.branch_id).slice(1).some((s2) => s2.people.some((p) => p.id === top.id)));       // the master account is listed once, at the top

  // On the pages: the office page shows the whole chain; a person's page shows who is above them.
  const t = await loggedIn('chain.tech');
  const office = (/<ol class="chain">[\s\S]*?<\/ol>/.exec((await t.get(`/branches/${a}`)).text) || [''])[0].replace(/\s+/g, ' ');
  assert.match(office, /Corporate<\/span>[\s\S]*Chain Valley market<\/span>[\s\S]*Mae Chainmarket<\/strong><\/a> <span class="meta">Market admin<\/span>[\s\S]*Chain Alpha office<\/span>[\s\S]*Ada Chainadmin[\s\S]*Bram Chainmanager<\/strong><\/a> <span class="meta">Branch manager<\/span>/);
  assert.match((await t.get(`/branches/${solo}`)).text.replace(/\s+/g, ' '), /Chain Solo office<\/span> <span class="meta">Nobody appointed yet<\/span>/);
  const mine = (/<ol class="chain">[\s\S]*?<\/ol>/.exec((await t.get(`/people/${tech}`)).text) || [''])[0].replace(/\s+/g, ' ');
  assert.match(mine, /Chain Alpha office<\/span>[\s\S]*Ada Chainadmin[\s\S]*Chain Valley market<\/span>[\s\S]*Corporate<\/span>/);     // nearest first
  assert.match((await t.get(`/people/${tech}`)).text, /Above Tia in the chain of command, nearest first/);

  db.transaction(() => {
    db.prepare(`UPDATE users SET active = 1 WHERE id IN (${others.join(',') || 0})`).run();
    db.prepare("UPDATE users SET active = 0, profile_id = ? WHERE username LIKE 'chain.%'").run(profileId('Technician'));
    db.prepare('UPDATE branches SET market_id = NULL WHERE market_id = ?').run(m); db.prepare('DELETE FROM markets WHERE id = ?').run(m);
  })();
});
