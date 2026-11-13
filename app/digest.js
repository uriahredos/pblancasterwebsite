'use strict';
const db = require('./db');
const config = require('./config');
const access = require('./permissions');
const mail = require('./mail');
const { localDate, localHour, fmtDate } = require('./util');

/** Last 7 full days up to yesterday, for the people this person can see. */
function build(user, now = new Date()) {
  const today = localDate(now);
  const d = new Date(today + 'T12:00:00Z');
  const to = new Date(d); to.setUTCDate(d.getUTCDate() - 1);
  const from = new Date(d); from.setUTCDate(d.getUTCDate() - 7);
  const range = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  const ids = access.visibleUserIds(user);
  const scope = ids ? `AND s.user_id IN (${ids.map(Number).join(',')})` : '';
  const base = `FROM parts_items i JOIN parts_submissions s ON s.id = i.submission_id JOIN users u ON u.id = s.user_id
                WHERE s.cancelled_at IS NULL AND s.created_local_date >= ? AND s.created_local_date <= ? ${scope}`;
  const sums = `SUM(CASE WHEN s.action = 'take' THEN i.quantity ELSE 0 END) AS taken,
                SUM(CASE WHEN s.action = 'return' THEN i.quantity ELSE 0 END) AS returned,
                SUM(CASE WHEN s.action = 'request' THEN i.quantity ELSE 0 END) AS requested`;
  const p = [range.from, range.to];
  const totals = db.prepare(`SELECT ${sums}, COUNT(DISTINCT s.id) AS entries ${base}`).get(...p);
  const byPerson = db.prepare(`SELECT u.display_name AS name, ${sums} ${base} GROUP BY u.id ORDER BY taken DESC, name COLLATE NOCASE`).all(...p);
  const topParts = db.prepare(`SELECT MIN(i.part_name) AS part, ${sums} ${base} GROUP BY UPPER(i.part_name) HAVING taken > 0 ORDER BY taken DESC LIMIT 10`).all(...p);
  const scopePlain = scope.replace(/s\.user_id/g, 'user_id');
  const openRequests = db.prepare(
    `SELECT COUNT(*) AS n FROM parts_submissions WHERE action = 'request' AND cancelled_at IS NULL AND status IN ('new','ordered') ${scopePlain}`).get().n;
  const unchecked = db.prepare(
    `SELECT COUNT(*) AS n FROM parts_submissions WHERE cancelled_at IS NULL AND audited_at IS NULL
     AND created_local_date >= ? AND created_local_date <= ? ${scopePlain}`).get(...p).n;
  return {
    range, team: Boolean(ids), openRequests, unchecked, byPerson, topParts,
    totals: { taken: totals.taken || 0, returned: totals.returned || 0, requested: totals.requested || 0, entries: totals.entries || 0 },
  };
}

function asText(user, data) {
  const lines = [
    `Hi ${user.display_name},`, '',
    `Parts summary for ${fmtDate(data.range.from)} to ${fmtDate(data.range.to)}${data.team ? ' (your people)' : ''}:`, '',
    `  Taken:      ${data.totals.taken} units`,
    `  Returned:   ${data.totals.returned} units`,
    `  Requested:  ${data.totals.requested} units`,
    `  Entries:    ${data.totals.entries}`, '',
    `Open parts requests: ${data.openRequests}`,
    `Entries from this week not yet checked in the audit: ${data.unchecked}`,
  ];
  if (data.byPerson.length) {
    lines.push('', 'By person (taken / returned / requested):');
    for (const r of data.byPerson) lines.push(`  ${r.name}: ${r.taken} / ${r.returned} / ${r.requested}`);
  }
  if (data.topParts.length) {
    lines.push('', 'Most taken parts:');
    for (const r of data.topParts) lines.push(`  ${r.taken} x ${r.part}`);
  }
  lines.push('', `${config.baseUrl}/admin/parts/audit?from=${data.range.from}&to=${data.range.to}`, '');
  return lines.join('\n');
}

/** Monday morning: one email to each person whose profile has the weekly summary ticked. */
async function runWeekly(now = new Date()) {
  const today = localDate(now);
  const isMonday = new Date(today + 'T12:00:00Z').getUTCDay() === 1;
  if (!isMonday || localHour(now) < 7) return 0;
  const last = db.prepare("SELECT value FROM meta WHERE key = 'weekly_digest_date'").get();
  if (last && last.value === today) return 0;
  db.prepare("INSERT INTO meta (key, value) VALUES ('weekly_digest_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
  let sent = 0;
  for (const row of db.prepare("SELECT * FROM users WHERE active = 1 AND email IS NOT NULL AND email <> ''").all()) {
    const user = access.loadAccess(row);
    if (!access.can(user, 'digest.weekly') || !access.can(user, 'parts.view')) continue;
    const data = build(user, now);
    if (await mail.send([user.email], `Parts summary: week of ${fmtDate(data.range.from)}`, asText(user, data))) sent++;
  }
  return sent;
}

function start() {
  setInterval(() => runWeekly().catch((e) => console.error('[digest] failed:', e.message)), 20 * 60 * 1000).unref();
}

module.exports = { build, asText, runWeekly, start };
