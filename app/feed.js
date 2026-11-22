'use strict';
// The community side of the home page: what people across the company have been doing lately, in one list,
// and a few numbers that show how big the company is.
const db = require('./db');
const { localDate } = require('./util');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now", "3 hours ago", "yesterday", "5 days ago", then the date. */
function ago(iso, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * The newest things from every office, newest first: people joining, photos added, discussions started
 * and events posted. Each item says which office it came from.
 * The home page takes the latest few (shout-outs have their own panel there). The Feed page asks for `full`: three
 * months back, shout-outs included, and events that have already happened too.
 */
function recent(user, limit = 8, { full = false } = {}) {
  const since = new Date(Date.now() - (full ? 90 : 30) * 86400000).toISOString();
  const each = full ? 100 : 6;
  const items = [];
  const person = 'u.id AS user_id, u.display_name, u.photo_path, b.name AS office, b.id AS office_id';
  const from = 'JOIN users u ON u.id = x.USER LEFT JOIN branches b ON b.id = u.branch_id';

  for (const w of db.prepare(`SELECT x.id, x.intro, x.created_at, u.job_title, ${person},
      EXISTS (SELECT 1 FROM welcome_notes n WHERE n.welcome_id = x.id AND n.user_id = @me) AS waved,
      (SELECT COUNT(*) FROM welcome_notes n JOIN users nu ON nu.id = n.user_id WHERE n.welcome_id = x.id AND nu.active = 1) AS waves
      FROM welcomes x ${from.replace('USER', 'user_id')} WHERE u.active = 1 AND x.created_at >= @since ORDER BY x.created_at DESC LIMIT ${each}`).all({ me: user.id, since: full ? since : new Date(Date.now() - 14 * 86400000).toISOString() })) {
    items.push({ kind: 'hire', at: w.created_at, who: w, title: `${w.display_name} joined${w.office ? ' the ' + w.office + ' office' : ''}`, text: w.intro || w.job_title || '', url: `/people/${w.user_id}`,
      action: w.user_id === user.id || w.waved ? null : { url: `/welcome/${w.id}/wave`, label: '👋 Say welcome' }, done: w.waved ? 'You said welcome ✓' : '',
      extra: w.waves ? `${w.waves} ${w.waves === 1 ? 'welcome' : 'welcomes'}` : 'Be the first to say welcome', link: w.user_id === user.id ? { url: `/people/${w.user_id}#welcome`, label: 'See your messages' } : null });
  }
  for (const p of db.prepare(`SELECT x.id, x.caption, x.created_at, x.post_id, ${person} FROM wall_photos x ${from.replace('USER', 'user_id')}
      WHERE x.created_at >= @since ORDER BY x.created_at DESC LIMIT ${each}`).all({ since })) {
    items.push({ kind: 'photo', at: p.created_at, who: p, title: `${p.display_name} added a photo`, text: p.caption || '', url: p.post_id ? `/social/p/${p.post_id}` : '/social', photo: p.id });
  }
  if (user.perms && user.perms.has('forum.use')) {
    for (const t of db.prepare(`SELECT x.id, x.title, x.created_at, x.reply_count, ${person} FROM forum_threads x ${from.replace('USER', 'user_id')}
        WHERE x.created_at >= @since ORDER BY x.created_at DESC LIMIT ${each}`).all({ since })) {
      items.push({ kind: 'talk', at: t.created_at, who: t, title: `${t.display_name} started a discussion`, text: t.title, url: `/discussions/t/${t.id}`, extra: t.reply_count ? `${t.reply_count} ${t.reply_count === 1 ? 'reply' : 'replies'}` : 'Be the first to reply' });
    }
  }
  for (const e of db.prepare(`SELECT x.id, x.title, x.event_date, x.created_at, eb.name AS host, ${person} FROM events x ${from.replace('USER', 'created_by')}
      LEFT JOIN branches eb ON eb.id = x.branch_id WHERE x.created_at >= @since AND x.event_date >= @today ORDER BY x.created_at DESC LIMIT ${full ? each : 4}`).all({ since, today: full ? '0000-00-00' : localDate() })) {
    items.push({ kind: 'event', at: e.created_at, who: e, title: `${e.display_name} posted an event`, text: `${e.title}, ${MONTHS[Number(e.event_date.slice(5, 7)) - 1]} ${Number(e.event_date.slice(8))}${e.host ? '' : ' (whole company)'}`, url: `/events#e${e.id}` });
  }
  if (full) {
    for (const s of db.prepare(`SELECT x.id, x.message, x.created_at, t.display_name AS to_name, ${person} FROM shoutouts x ${from.replace('USER', 'from_user')}
        JOIN users t ON t.id = x.to_user WHERE x.created_at >= @since ORDER BY x.created_at DESC LIMIT ${each}`).all({ since })) {
      items.push({ kind: 'shout', at: s.created_at, who: s, title: `${s.display_name} gave ${s.to_name} a shout-out`, text: s.message, url: `/shoutouts#s${s.id}` });
    }
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, limit).map((i) => ({ ...i, when: ago(i.at), away: Boolean(i.who.office_id && i.who.office_id !== user.branch_id) }));
}

/** A few numbers for the top of the home page, and one office to get to know this week. */
function company(user, today = localDate()) {
  const n = (sql, ...args) => db.prepare(sql).get(...args).n;
  const month = `${today.slice(0, 7)}-01`;
  const stats = [
    { value: n('SELECT COUNT(*) AS n FROM branches'), label: 'Offices', url: '/branches' },
    { value: n('SELECT COUNT(*) AS n FROM users WHERE active = 1 OR in_directory = 1'), label: 'People Here', url: '/people' },
    { value: n('SELECT COUNT(*) AS n FROM shoutouts WHERE created_at >= ?', month), label: 'Shout-Outs This Month', one: 'Shout-Out This Month', url: '/shoutouts' },
    // Discussions only for people who can open them; everyone else sees how many photos were shared.
    user.perms && user.perms.has('forum.use')
      ? { value: n('SELECT COUNT(*) AS n FROM forum_threads WHERE created_at >= ?', new Date(Date.now() - 30 * 86400000).toISOString()), label: 'New Discussions', one: 'New Discussion', url: '/discussions' }
      : { value: n('SELECT COUNT(*) AS n FROM wall_photos WHERE created_at >= ?', new Date(Date.now() - 30 * 86400000).toISOString()), label: 'New Photos', one: 'New Photo', url: '/photos' },
  ];
  // The office of the week: the same one all week for everyone, a different one next week. Offices that say what they do come first.
  const offices = db.prepare(`SELECT b.id, b.name, b.city, b.state, b.about,
      (SELECT group_concat(s.name, ', ') FROM branch_services bs JOIN services s ON s.id = bs.service_id WHERE bs.branch_id = b.id) AS services,
      (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND (u.active = 1 OR u.in_directory = 1)) AS people
      FROM branches b WHERE b.id <> ? ORDER BY b.id`).all(user.branch_id || 0).filter((o) => o.services || o.about || o.people);
  const week = Math.floor(new Date(`${today}T12:00:00Z`).getTime() / (7 * 86400000));
  const spot = offices.length ? offices[week % offices.length] : null;
  for (const s of stats) if (s.value === 1 && s.one) s.label = s.one;
  return { stats, spot };
}

/**
 * The banner under the greeting: a handful of slides, one shown at a time. People first (someone joining,
 * a birthday today, a thank-you), then what was shared, then an office to get to know.
 * `around` is recent(), `shouts` the latest shout-outs, `week` this week's birthdays and anniversaries, `spot` the office of the week.
 */
function slides(user, { around, shouts, week, spot }) {
  const out = [];
  const who = (id, name, photo) => ({ user_id: id, display_name: name, photo_path: photo });
  for (const i of around.filter((x) => x.kind === 'hire').slice(0, 2)) { i.inBanner = true; out.push({ kind: 'hire', label: 'Welcome aboard', title: i.title, text: i.text, url: i.url, who: i.who, office: i.who.office, cta: 'Say hello' }); }
  for (const o of week.filter((x) => x.today && !x.mine).slice(0, 2)) {
    out.push({ kind: 'cheer', label: o.kind === 'birthday' ? 'Birthday today' : 'Work anniversary today', title: o.kind === 'birthday' ? `Happy birthday, ${o.display_name.split(' ')[0]}!` : `${o.display_name}: ${o.text}`,
      text: o.kind === 'birthday' ? o.display_name : 'Congratulations', url: `/people/${o.id}`, who: who(o.id, o.display_name, o.photo_path), office: o.branch, cta: 'See their page' });
  }
  for (const s of shouts.slice(0, 2)) out.push({ kind: 'shout', label: 'Shout-out', title: `${s.to_name}, thank you`, text: `"${s.message}" from ${s.from_name}`, url: `/shoutouts#s${s.id}`, who: who(s.to_user, s.to_name, s.to_photo), cta: 'All shout-outs' });
  for (const i of around.filter((x) => x.kind === 'photo').slice(0, 1)) out.push({ kind: 'photo', label: 'New photo', title: i.title, text: i.text, url: i.url, who: i.who, office: i.who.office, photo: i.photo, cta: 'See the photos' });
  for (const i of around.filter((x) => x.kind === 'talk').slice(0, 1)) out.push({ kind: 'talk', label: 'New discussion', title: i.text, text: `${i.who.display_name} is asking. ${i.extra}.`, url: i.url, who: i.who, office: i.who.office, cta: 'Join in' });
  for (const i of around.filter((x) => x.kind === 'event').slice(0, 1)) out.push({ kind: 'event', label: 'Coming up', title: i.text, text: `Posted by ${i.who.display_name}`, url: i.url, who: i.who, office: i.who.office, cta: "I'm in" });
  if (spot) {
    out.push({ kind: 'office', label: 'Meet an office this week', title: `${spot.name}${spot.city && spot.state ? ' · ' + spot.city + ', ' + spot.state : ''}`,
      text: spot.services || (spot.people ? `${spot.people} ${spot.people === 1 ? 'person' : 'people'} on this site` : 'See what they do'), url: `/branches/${spot.id}`, cta: 'Visit their page' });
  }
  return out.slice(0, 8).map((x) => ({ ...x, away: Boolean(x.who && x.who.office_id && x.who.office_id !== user.branch_id) }));
}

module.exports = { recent, company, slides, ago };
