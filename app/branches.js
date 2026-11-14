'use strict';
// What a new branch starts with.
const db = require('./db');

/** Give a new branch its own truck inspection checklist, copied from the first branch's current one. */
function setUp(branchId) {
  const home = db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
  if (branchId === home || db.prepare('SELECT 1 FROM inspection_items WHERE branch_id = ?').get(branchId)) return;
  db.prepare('INSERT INTO inspection_items (label, sort, active, branch_id) SELECT label, sort, 1, ? FROM inspection_items WHERE branch_id = ? AND active = 1 ORDER BY sort, id').run(branchId, home);
}

const homeId = () => db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
/** The branch a person belongs to. */
const of = (userId) => (db.prepare('SELECT branch_id FROM users WHERE id = ?').get(userId) || {}).branch_id || homeId();

/** Is this person in the first branch? The NOTIFY_TO mailboxes belong to that branch; other branches use the site's own alerts. */
const isHome = (user) => user.branch_id === homeId();

module.exports = { setUp, homeId, of, isHome };
