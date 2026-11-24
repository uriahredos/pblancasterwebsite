'use strict';
const express = require('express');
const db = require('../db');
const access = require('../permissions');
const activity = require('../activity');
const { sendCsv } = require('../csv');
const { requirePerm, forbidden, flash } = require('../auth');
const { clean, isYmd, localDate, fmtDate } = require('../util');

const router = express.Router();

// ---- Topics everyone can see and add their name to --------------------------

const OPEN = "t.cancelled_at IS NULL AND t.is_private = 0 AND t.status IN ('new','reviewed','scheduled')";

router.get('/training/topics', requirePerm('training.submit'), (req, res) => {
  const topics = db.prepare(
    `SELECT t.id, t.description, t.status, t.user_id, u.display_name,
            (SELECT COUNT(*) FROM training_votes v WHERE v.request_id = t.id) AS votes,
            EXISTS (SELECT 1 FROM training_votes v WHERE v.request_id = t.id AND v.user_id = ?) AS mine
     FROM training_requests t JOIN users u ON u.id = t.user_id
     WHERE ${OPEN} AND u.branch_id = ? ORDER BY votes DESC, t.id DESC LIMIT 200`).all(req.user.id, req.user.branch_id);
  // Sessions scheduled from a private request are left out, as they are on the home page. The people expected at one
  // (whoever asked, and anyone the manager has ticked) still see it here, or they would have nowhere to see when it is.
  const upcoming = db.prepare(
    `SELECT s.id, s.title, s.session_date, s.session_time, s.location FROM training_sessions s
     LEFT JOIN training_requests t ON t.id = s.request_id
     WHERE s.completed_at IS NULL AND s.session_date >= ? AND s.branch_id = ?
       AND (t.id IS NULL OR t.is_private = 0 OR EXISTS (SELECT 1 FROM training_attendance a WHERE a.session_id = s.id AND a.user_id = ?))
     ORDER BY s.session_date, s.session_time`).all(localDate(), req.user.branch_id, req.user.id);
  res.render('training_topics', { title: 'Training topics', topics, upcoming });
});

// "I want this too" / take my name off. Not allowed on your own request (you already count).
router.post('/training/topics/:id/vote', requirePerm('training.submit'), (req, res) => {
  const t = db.prepare(`SELECT t.id, t.user_id FROM training_requests t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND ${OPEN} AND u.branch_id = ?`).get(req.params.id, req.user.branch_id);
  if (t && t.user_id !== req.user.id) {
    const has = db.prepare('SELECT 1 FROM training_votes WHERE request_id = ? AND user_id = ?').get(t.id, req.user.id);
    if (has) db.prepare('DELETE FROM training_votes WHERE request_id = ? AND user_id = ?').run(t.id, req.user.id);
    else db.prepare('INSERT INTO training_votes (request_id, user_id) VALUES (?, ?)').run(t.id, req.user.id);
  }
  res.redirect('/training/topics#t' + req.params.id);
});

// ---- Sessions and attendance -------------------------------------------------

// A session belongs to a branch; someone looking at another branch does not get it.
const getSession = (id, user) => {
  const s = /^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(id) : null;
  return s && (!user.viewBranch || s.branch_id === user.viewBranch) ? s : null;
};

/**
 * The training request a session may be tied to: one this person could open on the Training log (their own office's,
 * or for a manager one of their own people's) whose sender belongs to the office the session is in. Anything else is
 * treated as no request at all, so its wording is never shown and its status never moves.
 */
function requestFor(user, requestId, branchId) {
  const t = requestId ? db.prepare(
    'SELECT t.id, t.description, t.is_private, t.status, t.user_id, u.branch_id FROM training_requests t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(requestId) : null;
  return t && t.branch_id === branchId && access.canSee(user, t.user_id) ? t : null;
}

function readSession(body) {
  const values = {
    title: clean(body.title, 150), session_date: clean(body.session_date, 10), session_time: clean(body.session_time, 5),
    location: clean(body.location, 150), notes: clean(body.notes, 1000),
    request_id: /^\d+$/.test(body.request_id || '') ? Number(body.request_id) : null,
  };
  const errors = [];
  if (!values.title) errors.push('Enter what the session is about.');
  if (!isYmd(values.session_date)) errors.push('Choose the date.');
  if (values.session_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.session_time)) errors.push('The time does not look right.');
  return { values, errors };
}

function listPage(req, res, extra = {}) {
  const person = /^\d+$/.test(req.query.user || '') && access.canSee(req.user, Number(req.query.user)) ? Number(req.query.user) : null;
  const sessions = db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM training_attendance a WHERE a.session_id = s.id) AS people
     FROM training_sessions s
     WHERE ${req.user.viewBranch ? 's.branch_id = ' + Number(req.user.viewBranch) : '1 = 1'}
     ${person ? 'AND EXISTS (SELECT 1 FROM training_attendance a WHERE a.session_id = s.id AND a.user_id = ?)' : ''}
     ORDER BY s.completed_at IS NOT NULL, s.session_date DESC, s.id DESC LIMIT 300`).all(...(person ? [person] : []));
  const ids = access.visibleUserIds(req.user);
  const users = db.prepare(`SELECT id, display_name FROM users ${ids ? `WHERE id IN (${ids.map(Number).join(',')})` : ''} ORDER BY display_name COLLATE NOCASE, id`).all();
  // Prefill from a training request: /admin/training/sessions?request=12
  let values = {}; let wrongOffice = null;
  if (/^\d+$/.test(req.query.request || '')) {
    const t = requestFor(req.user, Number(req.query.request), req.user.workBranch);
    // A private request does not offer its wording as the title: the title is what the office sees.
    if (t) values = { title: t.is_private ? '' : t.description.split('\n')[0].slice(0, 150), request_id: t.id };
    // Someone who sees every office is told which office to choose first, since the session belongs to the office being looked at.
    else if (req.user.allBranches) wrongOffice = db.prepare('SELECT b.name FROM training_requests t JOIN users u ON u.id = t.user_id JOIN branches b ON b.id = u.branch_id WHERE t.id = ?').get(req.query.request);
  }
  res.status(extra.errors ? 400 : 200).render('admin_sessions', {
    title: 'Training sessions', sessions, users, person, values, canManage: access.can(req.user, 'training.manage'),
    errors: wrongOffice ? [`That request is from the ${wrongOffice.name} branch. Choose that branch first, then schedule the session from the request.`] : [], ...extra,
  });
}

router.get('/admin/training/sessions', requirePerm('training.view'), (req, res) => listPage(req, res));

router.post('/admin/training/sessions', requirePerm('training.manage'), (req, res) => {
  const { values, errors } = readSession(req.body);
  const request = requestFor(req.user, values.request_id, req.user.workBranch);
  if (values.request_id && !request) return forbidden(res);   // another office's or another team's request, or one that is gone
  if (errors.length) return listPage(req, res, { errors, values });
  const info = db.prepare(
    `INSERT INTO training_sessions (title, request_id, session_date, session_time, location, notes, created_by, created_at, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(values.title, values.request_id, values.session_date, values.session_time || null, values.location || null,
    values.notes || null, req.user.id, new Date().toISOString(), req.user.workBranch);
  const id = info.lastInsertRowid;
  if (values.request_id) {
    // Expect the requester and everyone who added their name; the request shows as Scheduled.
    db.prepare(`INSERT OR IGNORE INTO training_attendance (session_id, user_id)
                SELECT ?, user_id FROM training_requests WHERE id = ?
                UNION SELECT ?, user_id FROM training_votes WHERE request_id = ?`).run(id, values.request_id, id, values.request_id);
    if (['new', 'reviewed'].includes(request.status)) {
      db.prepare("UPDATE training_requests SET status = 'scheduled', unseen = ? WHERE id = ?").run(request.user_id === req.user.id ? 0 : 1, values.request_id);
    }
  }
  activity.log(req.user, 'Training session added', `${values.title} on ${fmtDate(values.session_date)}`);
  res.redirect(`/admin/training/sessions/${id}`);
});

router.get('/admin/training/sessions.csv', requirePerm('training.view'), (req, res) => {
  const ids = access.visibleUserIds(req.user);
  const rows = db.prepare(
    `SELECT s.title, s.session_date, s.location, s.completed_at, u.id AS uid, u.display_name, u.username
     FROM training_attendance a JOIN training_sessions s ON s.id = a.session_id JOIN users u ON u.id = a.user_id
     ${ids ? `WHERE u.id IN (${ids.map(Number).join(',')})` : ''}
     ORDER BY s.session_date, s.id, u.display_name COLLATE NOCASE, u.id`).all();
  sendCsv(res, `training-attendance-${localDate()}.csv`, ['Session', 'Date', 'Location', 'Held', 'Name', 'Username'],
    rows.map((r) => [r.title, r.session_date, r.location, r.completed_at ? 'Yes' : 'Not yet', r.display_name, r.username]));
});

router.get('/admin/training/sessions/:id', requirePerm('training.view'), (req, res) => {
  const session = getSession(req.params.id, req.user);
  if (!session) return res.status(404).render('error', { title: 'Page not found', message: 'That session does not exist.' });
  const ids = access.visibleUserIds(req.user);
  const attending = new Set(db.prepare('SELECT user_id FROM training_attendance WHERE session_id = ?').all(session.id).map((r) => r.user_id));
  const people = db.prepare(`SELECT id, display_name, active FROM users WHERE removed_at IS NULL ${ids ? `AND id IN (${ids.map(Number).join(',')})` : ''} ORDER BY display_name COLLATE NOCASE, id`).all()
    .filter((u) => u.active || attending.has(u.id));
  const others = ids ? [...attending].filter((id) => !ids.includes(id)).length : 0;
  res.render('admin_session', {
    title: session.title, session, people, attending, others, canManage: access.can(req.user, 'training.manage'),
    request: requestFor(req.user, session.request_id, session.branch_id),
  });
});

// Save who attended (ticks), optionally marking the session as held.
router.post('/admin/training/sessions/:id', requirePerm('training.manage'), (req, res) => {
  const session = getSession(req.params.id, req.user);
  if (!session) return res.redirect('/admin/training/sessions');
  const ids = access.visibleUserIds(req.user);
  const picked = [].concat(req.body.people || []).filter((v) => /^\d+$/.test(v)).map(Number).filter((id) => !ids || ids.includes(id));
  db.transaction(() => {
    // A manager only changes ticks for their own people; other people's ticks are left alone.
    if (ids) db.prepare(`DELETE FROM training_attendance WHERE session_id = ? AND user_id IN (${ids.map(Number).join(',')})`).run(session.id);
    else db.prepare('DELETE FROM training_attendance WHERE session_id = ?').run(session.id);
    const add = db.prepare('INSERT OR IGNORE INTO training_attendance (session_id, user_id) SELECT ?, id FROM users WHERE id = ?');
    for (const id of picked) add.run(session.id, id);
    if (req.body.held === '1' && !session.completed_at) {
      db.prepare('UPDATE training_sessions SET completed_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
      // The request it was scheduled from is finished too, when it belongs to the office the session is in.
      if (session.request_id) {
        db.prepare(`UPDATE training_requests SET status = 'completed', unseen = (user_id <> ?) WHERE id = ? AND cancelled_at IS NULL
                    AND user_id IN (SELECT id FROM users WHERE branch_id = ?)`)
          .run(req.user.id, session.request_id, session.branch_id);
      }
      activity.log(req.user, 'Training session held', `${session.title}: ${picked.length} attended`);
    } else if (req.body.held === '0' && session.completed_at) {
      db.prepare('UPDATE training_sessions SET completed_at = NULL WHERE id = ?').run(session.id);
    }
  })();
  flash(req, 'ok', req.body.held === '1' ? 'Session marked as held and attendance saved.' : 'Saved.');
  res.redirect(`/admin/training/sessions/${session.id}`);
});

router.post('/admin/training/sessions/:id/delete', requirePerm('training.manage'), (req, res) => {
  const session = getSession(req.params.id, req.user);
  if (!session) return res.redirect('/admin/training/sessions');
  if (req.user.scope === 'team') return forbidden(res); // deleting a whole session is not for managers of a team
  db.prepare('DELETE FROM training_sessions WHERE id = ?').run(session.id);
  activity.log(req.user, 'Training session deleted', session.title);
  flash(req, 'ok', 'Session deleted.');
  res.redirect('/admin/training/sessions');
});

module.exports = router;
