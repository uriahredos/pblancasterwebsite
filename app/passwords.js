'use strict';
// What makes a password too easy to guess. Used when someone chooses a password, and when they sign in:
// a password that no longer passes has to be replaced before they carry on.
const config = require('./config');

// Single words and well-worn passwords, compared with the letters of what was typed ("Password123!" -> "password").
const COMMON = new Set(`password passwords passwort pass passw0rd letmein welcome welcomeback testing test tester tests admin administrator root user guest login
  changeme changeit default temp temporary secret qwerty qwertyuiop asdfgh asdfghjkl zxcvbnm iloveyou loveyou monkey dragon master superman batman football baseball basketball
  soccer hockey golf sunshine princess shadow michael jordan charlie jessica ashley daniel jennifer hunter buster harley ranger thomas robert george summer winter spring autumn fall
  january february march april june july august september october november december monday tuesday wednesday thursday friday saturday sunday trustno starwars whatever freedom
  computer internet server database portal website company office work worker employee manager supervisor technician tech service install installer fire firealarm alarm alarms
  sprinkler sprinklers safety security pyebarker pyebarkerfire pyebarkerfs pbportal pyebarkerportal barker pye yarnell yarnellsecurity lancaster ephrata harrisburg pennsylvania
  america american steelers eagles phillies flyers penguins pirates ravens orioles yankees cowboys patriots abc abcd abcabc aaa hello hellothere goodbye money maga jesus god
  love lovely family mother father mom dad baby babygirl angel friend friends killer pepper ginger cookie chocolate coffee pizza apple orange banana flower purple blue green red black white
  truck trucks ford chevy dodge jeep harleydavidson mustang camaro corvette hunting fishing camping newpassword mypassword thepassword passwordpassword pwd pw`.split(/\s+/).filter(Boolean));

const RUNS = ['abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', '01234567890123456789'];
const WEAK = 'That password is too easy to guess. Do not use your name, the company name, a single common word or a simple pattern. Three or four unrelated words work well.';

/** Returns what is wrong with a chosen password, or null when it is acceptable. `user` (username, display_name) is optional. */
function problem(password, user) {
  const p = String(password === undefined || password === null ? '' : password);
  if (p.length < config.minPasswordLength) return `The password must be at least ${config.minPasswordLength} characters.`;
  if (p.length > 200) return 'The password is too long.';
  const lower = p.toLowerCase();
  const letters = lower.replace(/[^a-z]/g, '');
  const squashed = lower.replace(/[^a-z0-9]/g, '');
  if (new Set(lower).size < 5) return WEAK;                                   // "aaaaaaaaaa", "1212121212"
  if (!letters.length) return WEAK;                                           // only digits and symbols: dates, phone numbers
  const rep = /^(.+?)\1+$/.exec(letters);                                     // "testtest" counts as "test"
  if (COMMON.has(letters) || (rep && COMMON.has(rep[1]))) return WEAK;
  for (const run of RUNS) { const back = [...run].reverse().join(''); if (squashed.length >= 6 && (run.includes(squashed) || back.includes(squashed))) return WEAK; }
  if (user) {
    const own = [user.username, ...String(user.display_name || '').split(/\s+/)].map((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter((s) => s.length >= 4);
    if (own.some((n) => squashed.includes(n))) return WEAK;
  }
  return null;
}

module.exports = { problem, WEAK };
