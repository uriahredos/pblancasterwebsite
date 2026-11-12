'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const { localDate, localHour } = require('./util');

const backupDir = path.join(config.dataDir, 'backups');
const NAME = /^portal-\d{4}-\d{2}-\d{2}(-\d{6})?\.db$/;

function listBackups() {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((f) => NAME.test(f)).sort().reverse()
    .map((name) => { const st = fs.statSync(path.join(backupDir, name)); return { name, size: st.size, mtime: st.mtime.toISOString() }; });
}

/** Writes a consistent copy of the database, prunes old copies, and emails it if configured. */
async function runBackup({ manual = false, now = new Date() } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = manual ? `-${now.toISOString().slice(11, 19).replace(/:/g, '')}` : '';
  const name = `portal-${localDate(now)}${stamp}.db`;
  const file = path.join(backupDir, name);
  await db.backup(file);
  for (const old of listBackups().slice(config.backupKeep)) fs.rmSync(path.join(backupDir, old.name), { force: true });

  if (!manual && config.backupEmailTo.length) {
    const gz = zlib.gzipSync(fs.readFileSync(file));
    if (gz.length <= 15 * 1024 * 1024) {
      await mail.send(config.backupEmailTo, `Portal backup ${localDate(now)}`,
        'Attached is last night\'s copy of the portal database. It contains everything in the site, ' +
        'including anonymous complaints, so keep it somewhere private.\n\nPhotos are not included; download them from the Backups page.\n',
        [{ filename: `${name}.gz`, content: gz }]);
    } else {
      await mail.send(config.backupEmailTo, `Portal backup ${localDate(now)} is too large to email`,
        `The backup is on the server. Download it from ${config.baseUrl}/admin/backups\n`);
    }
  }
  return name;
}

async function nightly(now = new Date()) {
  if (localHour(now) < config.backupHour) return null;
  const today = `portal-${localDate(now)}.db`;
  if (fs.existsSync(path.join(backupDir, today))) return null;
  return runBackup({ now });
}

function startNightlyBackups() {
  const tick = () => nightly().catch((e) => console.error('[backup] failed:', e.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 30 * 60 * 1000).unref();
}

module.exports = { backupDir, NAME, listBackups, runBackup, nightly, startNightlyBackups };
