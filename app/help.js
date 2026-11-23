'use strict';
// How-to guides, built into the site. Each file in app/help/ gives a list of guides; a guide is shown only to
// someone whose profile lets them do the job it describes.
//
// A guide: { slug, title, group, perms, pages, intro, where, steps, tips, related }
//   perms   - permissions; holding any one shows the guide. Empty = everyone.
//   pages   - addresses this guide explains ("/admin/users"); those pages get a "How to use this page" link.
//   where   - how to reach it from the menu, in words.
//   steps   - what to do, in order. **Two stars** around a word make it bold (use for button and menu names).
//   tips    - optional extra notes. related - optional slugs of other guides.
const fs = require('fs');
const path = require('path');
const access = require('./permissions');

const dir = path.join(__dirname, 'help');
const guides = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().flatMap((f) => require(path.join(dir, f)));
const GROUPS = ['Getting started', 'Everyday', 'Parts and inventory', 'People', 'Schedule and tasks', 'News and community', 'Fleet and training', 'Sales', 'Running the site'];
const bySlug = new Map(guides.map((g) => [g.slug, g]));

const maySee = (user, g) => !(g.perms || []).length || g.perms.some((p) => access.can(user, p));
const forUser = (user) => guides.filter((g) => maySee(user, g));
const get = (user, slug) => { const g = bySlug.get(String(slug)); return g && maySee(user, g) ? g : null; };

/** The guide for the page being looked at, if this person has one: the longest matching address wins. */
function forPage(user, at) {
  if (!user || /^\/(help|complaint)/i.test(at)) return null;
  let best = null, len = -1;
  for (const g of guides) {
    if (!maySee(user, g)) continue;
    for (const p of g.pages || []) if ((at === p || at.startsWith(`${p}/`)) && p.length > len) { best = g; len = p.length; }
  }
  return best;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A line of a guide as safe HTML: everything escaped, then **bold** turned into <strong>. */
const rich = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
/** A guide as plain words, for the filter box. */
const words = (g) => [g.title, g.intro, g.where, ...(g.steps || []), ...(g.tips || [])].join(' ').replace(/\*\*/g, '').toLowerCase();

module.exports = { guides, GROUPS, forUser, forPage, get, rich, words };
