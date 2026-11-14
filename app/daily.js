'use strict';
// The daily question: one a day on weekdays (the weekend keeps Friday's), the same for everyone.
const db = require('./db');
const { localDate } = require('./util');

/** The day whose question is showing: today on a weekday, the Friday before on a weekend. */
function questionDay(now = new Date()) {
  const ymd = localDate(now);
  const d = new Date(`${ymd}T12:00:00Z`);
  const back = d.getUTCDay() === 6 ? 1 : d.getUTCDay() === 0 ? 2 : 0;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

const optionsOf = (q) => [q.a, q.b, q.c, q.d].filter(Boolean);

/** The question for a day, choosing one the first time anybody asks. */
function forDay(day = questionDay()) {
  let q = db.prepare('SELECT * FROM daily_questions WHERE used_on = ?').get(day);
  if (q) return q;
  return db.transaction(() => {
    q = db.prepare("SELECT * FROM daily_questions WHERE scheduled_on = ? AND status = 'active' AND used_on IS NULL").get(day)
      || db.prepare("SELECT * FROM daily_questions WHERE status = 'active' AND used_on IS NULL AND scheduled_on IS NULL ORDER BY (source = 'builtin'), RANDOM() LIMIT 1").get();
    if (!q) {
      // Every question has had its day: bring back the one asked longest ago, with a clean slate.
      q = db.prepare("SELECT * FROM daily_questions WHERE status = 'active' AND scheduled_on IS NULL ORDER BY used_on LIMIT 1").get();
      if (!q) return null;
      db.prepare('DELETE FROM daily_answers WHERE question_id = ?').run(q.id);
    }
    db.prepare('UPDATE daily_questions SET used_on = ? WHERE id = ?').run(day, q.id);
    return { ...q, used_on: day };
  })();
}

/** Who picked what. `mine` is this person's choice (0-based) or null. */
function results(q, userId) {
  const options = optionsOf(q);
  const rows = db.prepare(
    `SELECT a.choice, a.user_id, u.display_name, u.photo_path FROM daily_answers a JOIN users u ON u.id = a.user_id
     WHERE a.question_id = ? AND u.active = 1 ORDER BY a.answered_at`).all(q.id);
  const total = rows.length;
  const mine = rows.find((r) => r.user_id === userId);
  return {
    total, mine: mine ? mine.choice : null,
    options: options.map((text, i) => {
      const people = rows.filter((r) => r.choice === i).map((r) => ({ id: r.user_id, display_name: r.display_name, photo_path: r.photo_path }));
      return { text, i, count: people.length, percent: total ? Math.round((people.length / total) * 100) : 0, people };
    }),
  };
}

/** Everything the "Today's question" card needs. */
function card(userId) {
  const q = forDay();
  return q ? { q, day: q.used_on, ...results(q, userId) } : null;
}

module.exports = { questionDay, forDay, results, card, optionsOf };
