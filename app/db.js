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

module.exports = db;
