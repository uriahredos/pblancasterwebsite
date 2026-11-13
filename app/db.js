'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

const db = new Database(path.join(config.dataDir, 'portal.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

// Columns added after the first release. Safe to run on every start.
function addColumn(table, column, type) {
  const has = db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
for (const table of ['parts_submissions', 'training_requests']) {
  addColumn(table, 'edited_at', 'TEXT');
  addColumn(table, 'cancelled_at', 'TEXT');
}

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
-- The wording of each item is copied in, so old inspections still read correctly after the checklist changes.
CREATE TABLE IF NOT EXISTS inspection_results (
  id INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  ok INTEGER NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS inspection_photos (
  id INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);

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
if (db.prepare('SELECT COUNT(*) AS n FROM inspection_items').get().n === 0) {
  const add = db.prepare('INSERT INTO inspection_items (label, sort) VALUES (?, ?)');
  ['Tires and wheels', 'Lights and turn signals', 'Brakes', 'No fluid leaks', 'Windshield, wipers and mirrors', 'Horn and backup alarm',
    'Ladders and rack secure', 'Fire extinguisher present and charged', 'First aid kit', 'Tools and meters accounted for', 'Cab and cargo area clean']
    .forEach((label, i) => add.run(label, i + 1));
}

module.exports = db;
