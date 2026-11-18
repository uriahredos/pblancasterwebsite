'use strict';
// Usage: DB_KEY=<the key> npm run decrypt-backup -- <backup file> [output file]
//
// Writes an unencrypted copy of an encrypted backup, so it can be read with ordinary SQLite tools. The backup itself
// is not changed. The key is taken from DB_KEY rather than the command line, where other people on the machine could see it.
// (Any SQLCipher 4 tool, such as DB Browser for SQLite, can also open a backup directly with the same key.)
const fs = require('fs');
const path = require('path');
const dbfile = require('../app/dbfile');

const [input, wanted] = process.argv.slice(2);
const key = String(process.env.DB_KEY || '').trim();
const stop = (message) => { console.error(message); process.exit(1); };

if (!input) stop('Usage: DB_KEY=<the key> npm run decrypt-backup -- <backup file> [output file]');
if (!fs.existsSync(input)) stop(`No such file: ${input}`);
if (dbfile.isPlain(input)) stop('That file is not encrypted. It can be opened as it is.');
if (!key) stop('Set DB_KEY to the key the backup was made with.');
if (!dbfile.readable(input, key)) stop('That key does not open this backup. Backups open only with the key that was in DB_KEY when they were made.');

const output = wanted || input.replace(/(\.db)?$/, '.plain.db');
if (path.resolve(output) === path.resolve(input)) stop('Choose a different name for the output: the backup itself is left as it is.');
if (fs.existsSync(output)) stop(`${output} already exists. Remove it first, or give another name.`);
fs.copyFileSync(input, output);
try {
  dbfile.rekey(output, key, '');
  if (!dbfile.isPlain(output)) throw new Error('the copy is still encrypted');
} catch (e) {
  fs.rmSync(output, { force: true });
  stop(`Could not decrypt: ${e.message}`);
}
for (const ext of ['-wal', '-shm']) fs.rmSync(output + ext, { force: true });
console.log(`Unencrypted copy written to ${output}\nIt holds everything, in the clear. Delete it when you are done.`);
