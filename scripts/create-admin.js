'use strict';
// Usage: npm run create-admin -- <username> ["Display Name"]
const args = process.argv.slice(2);
const [username, displayName] = args.filter((a) => !a.startsWith('--'));
if (!username || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
  console.error('Usage: npm run create-admin -- <username> ["Display Name"]');
  console.error('Username: 3-40 letters, numbers, dot, dash or underscore.');
  process.exit(1);
}
const db = require('../app/db');
const auth = require('../app/auth');
if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
  console.error(`User "${username}" already exists.`);
  process.exit(1);
}
const password = auth.tempPassword();
auth.createUser({
  username, displayName: displayName || username, password, profile: 'Admin',
  master: !db.prepare('SELECT 1 FROM users WHERE is_master = 1').get(), // the first one is the master account
});
console.log(`Admin created.\n  Username: ${username}\n  Temporary password: ${password}\nYou will be asked to choose a new password at first sign-in.`);
