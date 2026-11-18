'use strict';
// Usage: DB_KEY=<the key> npm run decrypt-photos -- <folder> [output folder]
//
// Photos and documents are stored encrypted when the database is. This opens a copy of them somewhere else: a folder
// unpacked from the "Download all photos" archive, or a copy of the uploads folder. Each file is written, unencrypted
// and under the same name, into the output folder (default: "<folder>-opened"). The originals are not changed.
// The key is taken from DB_KEY rather than the command line, where other people on the machine could see it.
const fs = require('fs');
const path = require('path');
const sealed = require('../app/sealed');

const [input, wanted] = process.argv.slice(2);
const key = String(process.env.DB_KEY || '').trim();
const stop = (message) => { console.error(message); process.exit(1); };

if (!input) stop('Usage: DB_KEY=<the key> npm run decrypt-photos -- <folder> [output folder]');
if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) stop(`No such folder: ${input}`);
if (!key) stop('Set DB_KEY to the key that was in use when the files were stored.');
const output = wanted || input.replace(/[/\\]+$/, '') + '-opened';
if (path.resolve(output) === path.resolve(input)) stop('Choose a different output folder: the originals are left as they are.');
fs.mkdirSync(output, { recursive: true });

const keys = [sealed.keyFrom(key)];
const count = { opened: 0, plain: 0, failed: 0 };
for (const name of fs.readdirSync(input)) {
  const file = path.join(input, name);
  if (!fs.statSync(file).isFile()) continue;
  try {
    if (!sealed.isSealed(file)) { fs.copyFileSync(file, path.join(output, name)); count.plain += 1; continue; }
    sealed.unseal(file, keys, path.join(output, name));
    count.opened += 1;
  } catch (e) {
    count.failed += 1;
    console.error(`${name}: ${e.message}`);
  }
}
console.log(`${count.opened} opened, ${count.plain} were not encrypted and were copied as they were, ${count.failed} could not be opened.\nThey are in ${output}, in the clear. Delete that folder when you are done.`);
if (count.failed) process.exit(2);
