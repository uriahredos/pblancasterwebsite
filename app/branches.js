'use strict';
// What a new branch starts with.
const db = require('./db');

/** Give a new branch its own truck inspection checklist, copied from the first branch's current one. */
function setUp(branchId) {
  const home = db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
  if (branchId === home || db.prepare('SELECT 1 FROM inspection_items WHERE branch_id = ?').get(branchId)) return;
  db.prepare('INSERT INTO inspection_items (label, sort, active, branch_id) SELECT label, sort, 1, ? FROM inspection_items WHERE branch_id = ? AND active = 1 ORDER BY sort, id').run(branchId, home);
}

// ---- Corporate ---------------------------------------------------------------------------------------------------
// Some people work for the company rather than for one branch. They belong to "Corporate": one row among the branches
// (so everything that asks which branch a person is in still has an answer), marked so that it is never listed,
// chosen or counted as a branch. People are put there on their Users page, or by being added from the Corporate view.
let corporate = null;
function corporateId() {
  if (corporate) return corporate;
  let row = db.prepare('SELECT id FROM branches WHERE is_corporate = 1 ORDER BY id LIMIT 1').get();
  if (!row) {
    // A branch already called Corporate becomes it; otherwise it is made now.
    row = db.prepare("SELECT id FROM branches WHERE name = 'Corporate'").get();
    if (row) db.prepare('UPDATE branches SET is_corporate = 1, market_id = NULL WHERE id = ?').run(row.id);
    else row = { id: db.prepare("INSERT INTO branches (name, created_at, is_corporate) VALUES ('Corporate', ?, 1)").run(new Date().toISOString()).lastInsertRowid };
  }
  corporate = row.id;
  return corporate;
}
const isCorporate = (branchId) => Boolean(branchId) && Number(branchId) === corporateId();
/** How a place is named in a sentence: "Ephrata branch", but plain "Corporate". */
const title = (name, branchId, word = 'branch') => (isCorporate(branchId) ? name : `${name} ${word}`);
corporateId();
const corporateName = () => (db.prepare('SELECT name FROM branches WHERE id = ?').get(corporateId()) || {}).name || 'Corporate';
/** The same for a page that only has the name: "Ephrata branch", plain "Corporate". */
const placeLabel = (name) => (name && name === corporateName() ? name : `${name} branch`);

const homeId = () => db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
/** The branch a person belongs to. */
const of = (userId) => (db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId) || {}).branch_id || homeId();

/** Is this person in the first branch? The NOTIFY_TO mailboxes belong to that branch; other branches use the site's own alerts. */
const isHome = (user) => user.branch_id === homeId();

module.exports = { setUp, homeId, of, isHome, corporateId, isCorporate, title, placeLabel };
