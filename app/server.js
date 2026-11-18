'use strict';
const config = require('./config');

// The database is opened first. If it is encrypted and the key in the hosting settings is missing or wrong, the data is
// fine but nothing can run: show a page that says so, rather than a failed start that only the server log explains.
let db;
try { db = require('./db'); } catch (e) {
  if (!(e instanceof require('./dbfile').KeyProblem)) throw e;
  require('./locked').serve(config.port, e.message);
  return;
}
const app = require('./app');
const auth = require('./auth');
const mail = require('./mail');

// First start on a new host: create the first admin from environment variables.
const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
if (n === 0 && process.env.BOOTSTRAP_ADMIN_USERNAME && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  auth.createUser({
    username: process.env.BOOTSTRAP_ADMIN_USERNAME.trim(),
    displayName: process.env.BOOTSTRAP_ADMIN_USERNAME.trim(),
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    profile: 'Admin',
    master: true,
  });
  console.log(`Created the master account "${process.env.BOOTSTRAP_ADMIN_USERNAME.trim()}". They must change the password at first sign-in.`);
} else if (n === 0) {
  console.log('No users yet. Run "npm run create-admin -- <username>" to create the first admin.');
}

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set: everyone is signed out whenever the server restarts.');
}

// Encryption: say in the log what state the database is in (never the key), and bring older backups into line with it.
{
  const e = db.encryption; const backup = require('./backup');
  if (e.changed === 'encrypted') console.log('[database key] The database has been encrypted. Keep a copy of DB_KEY somewhere safe: without it the data cannot be opened.');
  if (e.changed === 'rekeyed') console.log('[database key] The database now uses the new key. DB_KEY_OLD can be removed from the hosting settings.');
  if (e.changed === 'decrypted') console.log('[database key] The database has been decrypted, as DB_DECRYPT asked.');
  if (e.note) console.warn(`[database key] ${e.note}`);
  if (!e.encrypted && !e.note) console.warn('[database key] DB_KEY is not set: the database and its backups are not encrypted.');
  const done = backup.alignWithKey();
  if (done.encrypted || done.rekeyed || done.decrypted) console.log(`[database key] Backups brought into line: ${done.encrypted} encrypted, ${done.rekeyed} moved to the new key, ${done.decrypted} decrypted.`);
  if (e.encrypted && (done.plain || done.foreign)) console.warn(`[database key] Backups not under the current key: ${done.plain} unencrypted, ${done.foreign} under another key.`);
}

mail.startComplaintDigest();
require('./backup').startNightlyBackups();
require('./uploads').startTending();          // photos and documents follow the database: sealed while it is encrypted
require('./digest').start();
require('./certs').start();
app.listen(config.port, () => console.log(`Pye-Barker portal listening on port ${config.port}`));
