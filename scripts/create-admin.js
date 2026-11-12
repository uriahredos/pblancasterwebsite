'use strict';
// Usage: npm run create-admin -- <username> ["Display Name"] [--no-reviewer]
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [username, displayName] = args.filter((a) => !a.startsWith('--'));
if (!username || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
  console.error('Usage: npm run create-admin -- <username> ["Display Name"] [--no-reviewer]');
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
  username, displayName: displayName || username, password, role: 'admin',
  reviewer: !flags.includes('--no-reviewer'),
});
console.log(`Admin created.\n  Username: ${username}\n  Temporary password: ${password}\nYou will be asked to choose a new password at first sign-in.`);
