'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

// Encrypted when DB_KEY is set in the hosting settings (see dbfile.js); an ordinary file otherwise.
const { db, status: encryption } = require('./dbfile').open(config.dataDir);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// A new version of the code keeps a checked copy of the database, as the last version left it, before it makes any of the changes below.
// A database that was brought back from a backup on this very start is already a copy of something on the disk, so it is not copied again.
require('./dbfile').beforeUpdate(db, config.dataDir, process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION, require('./util').localDate(), Boolean(encryption.restored && !encryption.restored.again));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  can_review_complaints INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parts_submissions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('take','return','request')),
  source TEXT NOT NULL CHECK (source IN ('van','job')),
  job_number TEXT,
  note TEXT,
  needed_by TEXT,
  photo_path TEXT,
  status TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL,
  created_local_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS parts_user ON parts_submissions(user_id);
CREATE INDEX IF NOT EXISTS parts_date ON parts_submissions(created_local_date);

CREATE TABLE IF NOT EXISTS parts_items (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES parts_submissions(id) ON DELETE CASCADE,
  part_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS items_submission ON parts_items(submission_id);

CREATE TABLE IF NOT EXISTS training_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  wants_contact INTEGER NOT NULL,
  is_private INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  admin_note TEXT,
  created_at TEXT NOT NULL,
  created_local_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS training_user ON training_requests(user_id);

-- Anonymous complaints. On purpose there is NO user id, username, IP address or
-- time of day here, the id is random, and WITHOUT ROWID means rows are not kept
-- in the order they arrived. Do not add identifying columns to this table.
CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  occurred_text TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  reviewer_reply TEXT,
  tracking_code_hash TEXT NOT NULL UNIQUE,
  created_date TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);

-- The parts list (from Sedona). Part numbers and descriptions only: no prices.
CREATE TABLE IF NOT EXISTS parts_catalog (
  id INTEGER PRIMARY KEY,
  part_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  manufacturer TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Who edited or cancelled a parts entry or training request, and what it said before.
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('parts','training')),
  record_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('edited','cancelled')),
  before_json TEXT
);
CREATE INDEX IF NOT EXISTS change_log_record ON change_log(kind, record_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// When the database became encrypted, for the Security check page. Forgotten again if it ever stops being so.
if (!encryption.encrypted) db.prepare("DELETE FROM meta WHERE key = 'db_encrypted_at'").run();
else if (!db.prepare("SELECT 1 FROM meta WHERE key = 'db_encrypted_at'").get()) db.prepare("INSERT INTO meta (key, value) VALUES ('db_encrypted_at', ?)").run(new Date().toISOString());
db.encryption = encryption;

// Columns added after the first release. Safe to run on every start.
function addColumn(table, column, type) {
  const has = db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
for (const table of ['parts_submissions', 'training_requests']) {
  addColumn(table, 'edited_at', 'TEXT');
  addColumn(table, 'cancelled_at', 'TEXT');
}
// Parts requests still waiting on someone: counted for the bell on every page, so they get a small index of their own.
db.exec("CREATE INDEX IF NOT EXISTS parts_open ON parts_submissions(user_id) WHERE action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered')");

addColumn('parts_catalog', 'category', 'TEXT');

// ---- Added with stock, trucks, notifications, training sessions and the activity log ----
db.exec(`
-- Manual stock changes: deliveries received, write-offs, corrections.
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INTEGER PRIMARY KEY,
  catalog_id INTEGER NOT NULL REFERENCES parts_catalog(id),
  quantity INTEGER NOT NULL,
  reason TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_adj_part ON stock_adjustments(catalog_id);

-- Who did what on the admin side. Complaints are never written here.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_user ON activity_log(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- "I want this training too"
CREATE TABLE IF NOT EXISTS training_votes (
  request_id INTEGER NOT NULL REFERENCES training_requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (request_id, user_id)
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  request_id INTEGER REFERENCES training_requests(id),
  session_date TEXT NOT NULL,
  session_time TEXT,
  location TEXT,
  notes TEXT,
  completed_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS training_attendance (
  session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (session_id, user_id)
);
`);
// Stock: a part is tracked once it has a count. On hand = count + deliveries/corrections - taken + returned since the count.
db.exec('CREATE INDEX IF NOT EXISTS items_part_name ON parts_items(part_name COLLATE NOCASE)');
addColumn('parts_catalog', 'stocked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('parts_catalog', 'count_qty', 'INTEGER');
addColumn('parts_catalog', 'count_at', 'TEXT');
addColumn('parts_catalog', 'min_level', 'INTEGER');
addColumn('parts_submissions', 'truck', 'TEXT');
addColumn('users', 'default_truck', 'TEXT');
addColumn('parts_submissions', 'place_id', 'INTEGER');    // where the parts came from or went back to, when it is not the usual place
addColumn('parts_catalog', 'cost_cents', 'INTEGER');     // what one costs the company, in cents; shown only to people who manage parts
// Entries brought in from the old Microsoft Forms carry a reference, so the same file is never imported twice.
addColumn('parts_submissions', 'import_ref', 'TEXT');
addColumn('training_requests', 'import_ref', 'TEXT');
// Set when someone else changes the status, cleared when the sender opens "My submissions".
addColumn('parts_submissions', 'unseen', 'INTEGER NOT NULL DEFAULT 0');
addColumn('training_requests', 'unseen', 'INTEGER NOT NULL DEFAULT 0');
// Audit: who confirmed an entry against the shelf / paperwork, and when.
addColumn('parts_submissions', 'audited_at', 'TEXT');
addColumn('parts_submissions', 'audited_by', 'INTEGER');

// ---- Certifications, truck inspections, announcements ----
db.exec(`
CREATE TABLE IF NOT EXISTS certifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  issuer TEXT,
  number TEXT,
  issued_on TEXT,
  expires_on TEXT,
  notes TEXT,
  reminded_30 INTEGER NOT NULL DEFAULT 0,
  reminded_7 INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS certs_user ON certifications(user_id);

-- The checklist people fill in. Editable on the Inspections page.
CREATE TABLE IF NOT EXISTS inspection_items (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  truck TEXT NOT NULL,
  odometer TEXT,
  notes TEXT,
  problems INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_note TEXT,
  created_at TEXT NOT NULL,
  created_local_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inspections_date ON inspections(created_local_date);
-- Each person's inspections by date ("when was their last one?"), and the few with a problem nobody has fixed yet.
CREATE INDEX IF NOT EXISTS inspections_user ON inspections(user_id, created_local_date);
CREATE INDEX IF NOT EXISTS inspections_open ON inspections(user_id) WHERE problems > 0 AND resolved_at IS NULL;
-- The wording of each item is copied in, so old inspections still read correctly after the checklist changes.
CREATE TABLE IF NOT EXISTS inspection_results (
  id INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  ok INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS inspection_results_inspection ON inspection_results(inspection_id);
CREATE TABLE IF NOT EXISTS inspection_photos (
  id INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inspection_photos_inspection ON inspection_photos(inspection_id);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- 'all': everyone.  'team': the people the poster manages.
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','team')),
  expires_on TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  read_at TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);
`);
// Certification reminders used to be ticked off as sent even while email was switched off. If it is still off, none
// of those can have gone out, so the ticks on certifications that have not run out yet are cleared, once, and the
// reminders go out when email is set up.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'cert_reminders_1'").get()) {
  db.transaction(() => {
    if (!config.smtp.host) db.prepare("UPDATE certifications SET reminded_30 = 0, reminded_7 = 0 WHERE (reminded_30 = 1 OR reminded_7 = 1) AND expires_on >= date('now', '-1 day')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('cert_reminders_1', '1')").run();
  })();
}

// ---- Newsletters, and a category and pin for announcements ----
db.exec(`
-- A monthly newsletter: the PDF as uploaded, plus a picture of each page for reading on a phone.
CREATE TABLE IF NOT EXISTS newsletters (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  issue_month TEXT NOT NULL,           -- YYYY-MM
  highlights TEXT,                     -- one per line, shown on the home page
  pdf_path TEXT NOT NULL,
  page_files TEXT NOT NULL DEFAULT '[]', -- JSON list of page pictures, first page first
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS newsletters_month ON newsletters(issue_month);
`);
addColumn('announcements', 'category', "TEXT NOT NULL DEFAULT 'general'");
addColumn('announcements', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
// Critical announcements stay at the very top of the home page, read or not, until they end or are unmarked.
addColumn('announcements', 'critical', 'INTEGER NOT NULL DEFAULT 0');

// ---- Discussions: sections, threads, replies, and who has read what ----
db.exec(`
CREATE TABLE IF NOT EXISTS forum_sections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general','support')), -- support threads can be marked solved
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS forum_threads (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES forum_sections(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  is_locked INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  solved_at TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_post_at TEXT NOT NULL,
  last_post_user_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS forum_threads_section ON forum_threads(section_id, last_post_at);
-- Every message, the opening one included (it is the thread's first post).
CREATE TABLE IF NOT EXISTS forum_posts (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS forum_posts_thread ON forum_posts(thread_id, id);
CREATE TABLE IF NOT EXISTS forum_photos (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS forum_photos_post ON forum_photos(post_id);
-- When each person last opened a thread, and whether they want to hear about replies to it.
CREATE TABLE IF NOT EXISTS forum_reads (
  thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_read_at TEXT,
  following INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS forum_reads_user ON forum_reads(user_id, following);
`);
if (db.prepare('SELECT COUNT(*) AS n FROM forum_sections').get().n === 0) {
  const add = db.prepare('INSERT INTO forum_sections (name, description, kind, sort_order) VALUES (?, ?, ?, ?)');
  add.run('Tech support', 'Stuck on a panel, a device or a job? Ask here. Mark the thread solved when you have your answer.', 'support', 1);
  add.run('General', 'Shop talk, tips, tools and anything else worth sharing.', 'general', 2);
  add.run('Introductions', 'New here, or never said hello? Tell everyone who you are.', 'general', 3);
}

if (db.prepare('SELECT COUNT(*) AS n FROM inspection_items').get().n === 0) {
  const add = db.prepare('INSERT INTO inspection_items (label, sort) VALUES (?, ?)');
  ['Tires and wheels', 'Lights and turn signals', 'Brakes', 'No fluid leaks', 'Windshield, wipers and mirrors', 'Horn and backup alarm',
    'Ladders and rack secure', 'Fire extinguisher present and charged', 'First aid kit', 'Tools and meters accounted for', 'Cab and cargo area clean']
    .forEach((label, i) => add.run(label, i + 1));
}

// ---- Tasks: something one person asks another to do, with an optional due date ----
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT,
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  due_on TEXT,
  done_at TEXT,
  done_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assigned_to, done_at);
CREATE TABLE IF NOT EXISTS task_notes (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT,
  body TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(task_id, id);
`);

// ---- Community: branches, personal profiles, new-hire welcomes, the daily question ----
db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS welcomes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  intro TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS welcome_notes (
  welcome_id INTEGER NOT NULL REFERENCES welcomes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (welcome_id, user_id)
);
CREATE TABLE IF NOT EXISTS daily_questions (
  id INTEGER PRIMARY KEY,
  prompt TEXT NOT NULL,
  a TEXT NOT NULL, b TEXT NOT NULL, c TEXT, d TEXT,
  source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin','custom','suggested')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','rejected')),
  suggested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scheduled_on TEXT UNIQUE,      -- asked on this day in particular
  used_on TEXT UNIQUE,           -- the day it was the question
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_answers (
  question_id INTEGER NOT NULL REFERENCES daily_questions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id)
);
`);
if (!db.prepare('SELECT 1 FROM branches').get()) db.prepare("INSERT INTO branches (name, created_at) VALUES ('Lancaster', ?)").run(new Date().toISOString());
addColumn('users', 'branch_id', 'INTEGER');
// Nearly every page asks "who is in this office?".
db.exec('CREATE INDEX IF NOT EXISTS users_branch ON users(branch_id)');
addColumn('users', 'job_title', 'TEXT');
addColumn('users', 'started_on', 'TEXT');
addColumn('users', 'invited_at', 'TEXT');   // when their sign-in details were last emailed to them
addColumn('users', 'about', 'TEXT');
addColumn('users', 'skills', 'TEXT');
addColumn('users', 'phone', 'TEXT');
addColumn('users', 'show_phone', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'show_email', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'photo_path', 'TEXT');
addColumn('users', 'department', 'TEXT');
// On the People page even though the account is switched off: someone on the contact list who has not been given a sign-in yet.
addColumn('users', 'in_directory', 'INTEGER NOT NULL DEFAULT 0');
db.prepare('UPDATE users SET branch_id = (SELECT MIN(id) FROM branches) WHERE branch_id IS NULL').run();
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'daily_seed_1'").get()) {
  const add = db.prepare("INSERT INTO daily_questions (prompt, a, b, source, status, created_at) VALUES (?, ?, ?, 'builtin', 'active', ?)");
  db.transaction(() => {
    for (const [prompt, a, b] of require('./daily_questions')) add.run(prompt, a, b, new Date().toISOString());
    db.prepare("INSERT INTO meta (key, value) VALUES ('daily_seed_1', '1')").run();
  })();
}

// ---- Branch privacy: the things that are not tied to one person belong to a branch ----
db.exec(`
CREATE TABLE IF NOT EXISTS branch_stock (
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  catalog_id INTEGER NOT NULL REFERENCES parts_catalog(id),
  count_qty INTEGER NOT NULL DEFAULT 0,
  count_at TEXT NOT NULL,
  min_level INTEGER,
  PRIMARY KEY (branch_id, catalog_id)
);
`);
addColumn('branch_stock', 'max_level', 'INTEGER');   // the most to keep on the shelf: what an order should bring it back up to
addColumn('inspection_items', 'branch_id', 'INTEGER');
addColumn('training_sessions', 'branch_id', 'INTEGER');
addColumn('complaints', 'branch_id', 'INTEGER');          // the branch only; still nothing about who sent it
// "notified" used to change when the daily notice went out, which showed whether a complaint came in before or after that
// hour. The notice counts by date now and every complaint carries the same mark, so the marks are evened out.
// Done at every start, not once: after going back to an older version for a while, its complaints would otherwise stand out.
db.prepare('UPDATE complaints SET notified = 1 WHERE notified <> 1').run();
db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('complaint_notified_1', '1')").run();
db.exec(`
CREATE TABLE IF NOT EXISTS announcement_comments (
  id INTEGER PRIMARY KEY,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS announcement_comments_a ON announcement_comments(announcement_id, id);
`);
addColumn('announcements', 'branch_id', 'INTEGER');       // empty = every branch
addColumn('stock_adjustments', 'branch_id', 'INTEGER');
{
  const home = db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
  db.prepare('UPDATE inspection_items SET branch_id = ? WHERE branch_id IS NULL').run(home);
  db.prepare('UPDATE training_sessions SET branch_id = COALESCE((SELECT branch_id FROM users WHERE id = created_by), ?) WHERE branch_id IS NULL').run(home);
  db.prepare('UPDATE complaints SET branch_id = ? WHERE branch_id IS NULL').run(home);
  db.prepare('UPDATE stock_adjustments SET branch_id = COALESCE((SELECT branch_id FROM users WHERE id = user_id), ?) WHERE branch_id IS NULL').run(home);
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'branch_privacy_1'").get()) {
    db.transaction(() => {
      // Everything that existed before branches belongs to the first branch.
      db.prepare('UPDATE announcements SET branch_id = COALESCE((SELECT branch_id FROM users WHERE id = created_by), ?)').run(home);
      db.prepare(`INSERT OR IGNORE INTO branch_stock (branch_id, catalog_id, count_qty, count_at, min_level)
                  SELECT ?, id, COALESCE(count_qty, 0), COALESCE(count_at, created_at), min_level FROM parts_catalog WHERE stocked = 1`).run(home);
      db.prepare("INSERT INTO meta (key, value) VALUES ('branch_privacy_1', '1')").run();
    })();
  }
}

// ---- Community, part two: shout-outs, celebrations, events, the photo wall, branch pages ----
db.exec(`
CREATE TABLE IF NOT EXISTS shoutouts (
  id INTEGER PRIMARY KEY,
  from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shoutouts_to ON shoutouts(to_user);
CREATE TABLE IF NOT EXISTS shoutout_cheers (
  shoutout_id INTEGER NOT NULL REFERENCES shoutouts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (shoutout_id, user_id)
);
-- "Happy birthday" / "Congratulations": one per person, per occasion, per year.
CREATE TABLE IF NOT EXISTS celebrations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('birthday','anniversary')),
  year INTEGER NOT NULL,
  from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, kind, year, from_user)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT,
  event_date TEXT NOT NULL,
  event_time TEXT,
  location TEXT,
  branch_id INTEGER REFERENCES branches(id),     -- empty = every branch
  potluck INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_signups (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bringing TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS wall_photos (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  caption TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wall_likes (
  photo_id INTEGER NOT NULL REFERENCES wall_photos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, user_id)
);
`);
addColumn('users', 'welcomed_at', 'TEXT');        // when the person put the first-time checklist away
addColumn('users', 'birthday', 'TEXT');            // "MM-DD": the day only, never the year
addColumn('branches', 'address', 'TEXT');
addColumn('branches', 'phone', 'TEXT');
addColumn('branches', 'about', 'TEXT');
addColumn('branches', 'photo_path', 'TEXT');

db.prepare("UPDATE forum_sections SET description = 'Shop talk, tips, tools and anything else worth sharing.' WHERE description = 'Branch talk, tips, tools and anything else worth sharing.'").run();

// ---- The company: every office with its number, region and what it does; who to contact ----
db.exec(`
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS branch_services (
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (branch_id, service_id)
);
CREATE TABLE IF NOT EXISTS company_contacts (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL,       -- Accounting & Finance, HR, Regional Layout ...
  grp TEXT,                    -- a heading inside the section: Tax, Fleet, a region's name ...
  topic TEXT,                  -- what to contact them about, or their role
  name TEXT,
  email TEXT,
  note TEXT,
  sort INTEGER NOT NULL
);
`);
addColumn('branches', 'number', 'TEXT');
addColumn('branches', 'city', 'TEXT');
addColumn('branches', 'state', 'TEXT');
addColumn('branches', 'street', 'TEXT');
addColumn('branches', 'region', 'TEXT');
addColumn('branches', 'marketing_name', 'TEXT');   // the name the office goes by, when it differs from its town
addColumn('branches', 'market', 'TEXT');
addColumn('branches', 'product_lines', 'TEXT');
// Markets: groups of offices that corporate admins make and fill. An office belongs to one market at most.
db.exec(`CREATE TABLE IF NOT EXISTS markets (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL)`);
addColumn('branches', 'market_id', 'INTEGER');
// 1 on the one row that stands for Corporate: where people belong who work for the company, not for a branch (see branches.js).
addColumn('branches', 'is_corporate', 'INTEGER NOT NULL DEFAULT 0');
// Who a post is for (see reach.js): one office (branch_id), a market (market_id), or the whole company (both empty).
addColumn('announcements', 'market_id', 'INTEGER');
addColumn('events', 'market_id', 'INTEGER');
addColumn('newsletters', 'branch_id', 'INTEGER');
addColumn('newsletters', 'market_id', 'INTEGER');
// Once: the newsletters posted before each office had its own belong to the office that uploaded them.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'newsletter_office_1'").get()) {
  db.transaction(() => {
    const first = db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
    db.prepare('UPDATE newsletters SET branch_id = COALESCE((SELECT u.branch_id FROM users u WHERE u.id = newsletters.created_by), ?) WHERE branch_id IS NULL AND market_id IS NULL').run(first);
    db.prepare("INSERT INTO meta (key, value) VALUES ('newsletter_office_1', ?)").run(new Date().toISOString());
  })();
}
addColumn('tasks', 'status', "TEXT NOT NULL DEFAULT 'new'");
// A task can be a vehicle inspection: it is finished by sending the inspection, which is then linked here.
addColumn('tasks', 'kind', "TEXT NOT NULL DEFAULT 'general'");
// When the person it is for last opened their Tasks page with it on. Empty = still new to them (it counts on the bell).
addColumn('tasks', 'seen_at', 'TEXT');
addColumn('tasks', 'inspection_id', 'INTEGER');
addColumn('inspection_photos', 'label', 'TEXT');
// Tidy up notes that were saved two or three times by repeated taps: the same person, task and words, with no
// status change, within ten minutes of the copy straight before it. The first copy stays. Done once: the page has
// refused such repeats ever since, and a note someone chose to write again later (after another note) is theirs to keep.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'task_notes_tidy_1'").get()) {
  db.transaction(() => {
    db.exec(`DELETE FROM task_notes WHERE status IS NULL AND body IS NOT NULL AND EXISTS (
      SELECT 1 FROM task_notes o WHERE o.task_id = task_notes.task_id AND o.user_id = task_notes.user_id AND o.body = task_notes.body
        AND o.id < task_notes.id AND (julianday(task_notes.created_at) - julianday(o.created_at)) * 1440 < 10
        AND NOT EXISTS (SELECT 1 FROM task_notes m WHERE m.task_id = task_notes.task_id AND m.id > o.id AND m.id < task_notes.id))`);
    db.prepare("INSERT INTO meta (key, value) VALUES ('task_notes_tidy_1', '1')").run();
  })();
}
if (!db.prepare('SELECT 1 FROM services').get()) {
  const add = db.prepare('INSERT INTO services (code, name, sort) VALUES (?, ?, ?)');
  // The company's own list of services, as its branch finder names them.
  [['FA', 'Fire Alarms & Detection'], ['FS', 'Fire Sprinklers'], ['FE', 'Fire Extinguishers'], ['SUP', 'Fire Suppression Systems'],
    ['SEC', 'Security'], ['PVM', 'Proactive Video Monitoring'], ['LSE', 'Life Safety Equipment'], ['MN', 'Mass Notification']].forEach(([code, name], i) => add.run(code, name, i + 1));
}

// ---- Face ID / fingerprint sign-in (passkeys) ----
db.exec(`
CREATE TABLE IF NOT EXISTS passkeys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
`);

// The contact sheet misspells the company's email address in places; an address sent there would not arrive.
db.prepare("UPDATE company_contacts SET email = replace(email, '@pyebarkefs.com', '@pyebarkerfs.com') WHERE email LIKE '%@pyebarkefs.com%'").run();

module.exports = db;
