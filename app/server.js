'use strict';
const config = require('./config');

// The database is opened first. If it is encrypted and the key in the hosting settings is missing or wrong, the data is
// fine but nothing can run: show a page that says so, rather than a failed start that only the server log explains.
// The same page, with its own words, covers a database file that is damaged or missing and a restore that could not be done.
let db;
try { db = require('./db'); } catch (e) {
  const dbfile = require('./dbfile');
  const stop = e instanceof dbfile.KeyProblem ? e : dbfile.damage(e, config.dataDir);
  if (!stop) throw e;
  require('./locked').serve(config.port, stop.message, stop);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
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

// A backup was brought back on this start (RESTORE_BACKUP): everyone signs in again, and the log and the activity log say what was done.
{
  const r = db.encryption.restored;
  if (r && !r.again) {
    db.prepare('DELETE FROM sessions').run();
    require('./activity').log(null, 'Backup restored', `${r.backup}${r.aside ? `; the database from before was set aside as ${r.aside}` : ''}`);
    console.log(`[restore] The database was restored from ${r.backup}.${r.aside ? ` The database from before is set aside on the disk as ${r.aside}.` : ''} RESTORE_BACKUP can now be removed from the hosting settings.`);
  } else if (r) console.log(`[restore] RESTORE_BACKUP is still set. ${r.backup} was restored on an earlier start, so nothing was done this time. Remove the setting.`);
}

// Encryption: say in the log what state the database is in (never the key), and bring older backups into line with it.
{
  const e = db.encryption; const backup = require('./backup');
  const RECORD = 'Keep the key that was replaced on record for as long as any backup or photo archive downloaded while it was in use is kept: those open only with it.';
  if (e.changed === 'encrypted') console.log('[database key] The database has been encrypted. Keep a copy of DB_KEY somewhere safe: without it the data cannot be opened.');
  if (e.changed === 'rekeyed') console.log(`[database key] The database now uses the new key. Photos and documents are still moving to it: leave DB_KEY_OLD in the hosting settings until the Security check says it can be deleted. ${RECORD}`);
  if (e.changed === 'decrypted') console.log(`[database key] The database has been decrypted, as DB_DECRYPT asked. Photos and documents are still being opened: leave DB_KEY in the hosting settings until the Security check says none are still encrypted. ${RECORD}`);
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
const server = app.listen(config.port, () => console.log(`Pye-Barker portal listening on port ${config.port}`));

// A clean stop (a deploy, a restart): stop taking requests, fold what SQLite keeps beside the database into the one
// file, and close it. Anything still running after ten seconds is cut off, so a stop never hangs.
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const finish = () => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) { console.error('[stop] the database did not close cleanly:', e.message); }
    process.exit(0);
  };
  setTimeout(finish, 10 * 1000).unref();
  server.close(finish);
  if (server.closeIdleConnections) server.closeIdleConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
