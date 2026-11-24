'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const db = require('../db');
const activity = require('../activity');
const uploads = require('../uploads');
const { requireLogin, requirePerm, verifyCsrf, flash, forbidden } = require('../auth');
const { clean } = require('../util');

const router = express.Router();
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 12;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10" -> "October 2026" */
function monthName(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
const isMonth = (ym) => Boolean(monthName(ym)) && Number(ym.slice(0, 4)) >= 2000 && Number(ym.slice(0, 4)) <= 2100;

function decorate(n) {
  let pages = [];
  try { pages = JSON.parse(n.page_files || '[]'); } catch { pages = []; }
  return {
    ...n, pages, month: monthName(n.issue_month),
    highlightList: (n.highlights || '').split('\n').map((s) => s.replace(/^[\s\-*•]+/, '').trim()).filter(Boolean),
  };
}

// A newsletter belongs to one office, to a market, or to the whole company (see reach.js). People get the issues for
// the office they are looking at. `everything`: in the Corporate view, list every office's.
const reach = require('../reach');
/** Newest issue first. */
function latest(user, limit, everything = false) {
  return db.prepare(
    `SELECT n.*, u.display_name AS author FROM newsletters n JOIN users u ON u.id = n.created_by
     WHERE ${everything && reach.place(user).corporate ? '1 = 1' : reach.shown('n')}
     ORDER BY n.issue_month DESC, n.id DESC LIMIT @limit`).all({ ...reach.params(user), limit }).map((n) => ({ ...decorate(n), for: reach.label(n) }));
}
const getIssue = (id) => {
  const row = /^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM newsletters WHERE id = ?').get(id) : null;
  return row ? decorate(row) : null;
};
/** The issue, when it is one this person can read where they are looking: otherwise nothing, as if it were not there. */
const readable = (req) => { const n = getIssue(req.params.id); return n && (reach.place(req.user).corporate || reach.isShown(req.user, n)) ? n : null; };

/**
 * Make a picture of each page with pdftoppm (from poppler-utils). Resolves to the
 * file names, first page first; an empty list when the tool is missing or the PDF
 * cannot be read, in which case people simply open the PDF itself.
 * The tool reads a file someone uploaded, so it is started with nothing of the site's settings but where programs are found:
 * it never sees the database key.
 */
function renderPages(pdfName) {
  const prefix = pdfName.replace(/\.pdf$/, '');
  return new Promise((resolve) => {
    execFile('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82', '-scale-to-x', '1100', '-scale-to-y', '-1', '-f', '1', '-l', String(MAX_PAGES),
      path.join(uploads.uploadDir, pdfName), path.join(uploads.uploadDir, prefix)], { timeout: 90 * 1000, env: { PATH: process.env.PATH } }, (err) => {
      let files = [];
      try {
        files = fs.readdirSync(uploads.uploadDir).filter((f) => f.startsWith(prefix + '-') && f.endsWith('.jpg'))
          .sort((a, b) => parseInt(a.slice(prefix.length + 1), 10) - parseInt(b.slice(prefix.length + 1), 10));
      } catch { files = []; }
      if (err) {
        if (err.code !== 'ENOENT') console.error('Newsletter pages could not be made:', err.message);
        files.forEach((f) => uploads.remove(f));
        return resolve([]);
      }
      resolve(files);
    });
  });
}

function looksLikePdf(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(5);
  fs.readSync(fd, b, 0, 5, 0);
  fs.closeSync(fd);
  return b.toString('latin1') === '%PDF-';
}

// ---- Reading ---------------------------------------------------------------

router.get('/newsletters', requireLogin, (req, res) => {
  const issues = latest(req.user, 120, true);
  res.render('newsletters', { title: 'Newsletters', issues, labelled: reach.place(req.user).corporate || new Set(issues.map((n) => n.for)).size > 1 });
});

router.get('/newsletters/:id', requireLogin, (req, res, next) => {
  const n = readable(req);
  if (!n) return next();
  if (!n.pages.length) return res.redirect(`/newsletters/${n.id}/pdf`);
  // Newer and older step through the issues this person can read here, not every office's.
  const all = latest(req.user, 500, true); const at = all.findIndex((x) => x.id === n.id);
  const newer = at > 0 ? all[at - 1] : null; const older = at >= 0 && at < all.length - 1 ? all[at + 1] : null;
  res.render('newsletter', { title: n.title, n, newer, older, wide: false });
});

const FILE_HEADERS = { 'Cache-Control': 'private, max-age=86400' };

router.get('/newsletters/:id/pdf', requireLogin, (req, res, next) => {
  const n = readable(req);
  if (!n) return next();
  const name = `${n.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'newsletter'}.pdf`;
  uploads.send(res, n.pdf_path, { ...FILE_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"` }, next);
});

router.get('/newsletters/:id/page/:n', requireLogin, (req, res, next) => {
  const n = readable(req);
  const file = n && /^\d+$/.test(req.params.n) ? n.pages[Number(req.params.n) - 1] : null;
  if (!file) return next();
  uploads.send(res, file, FILE_HEADERS, next);
});

// ---- Uploading and removing --------------------------------------------------

const upload = uploads.receive({
  name: () => `nl-${crypto.randomBytes(16).toString('hex')}.pdf`,
  problem: 'uploadError',
  limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 20 },
}).single('pdf');

function parseUpload(req, res, next) {
  upload(req, res, (err) => {
    req.uploadError = err ? (err.code === 'LIMIT_FILE_SIZE' ? 'The PDF is larger than 25 MB.' : 'The PDF could not be uploaded.') : req.uploadError || null;
    req.body = req.body || {};
    next();
  });
}

function adminPage(req, res, extra = {}) {
  res.status(extra.errors ? 400 : 200).render('admin_newsletters', {
    title: 'Newsletters', issues: latest(req.user, 200, true).filter((n) => reach.runs(req.user, n)), reaches: reach.choices(req.user), errors: [], values: {}, ...extra,
  });
}

router.get('/admin/newsletters', requirePerm('newsletters.manage'), (req, res) => adminPage(req, res));

router.post('/admin/newsletters', requirePerm('newsletters.manage'), parseUpload, verifyCsrf, async (req, res, next) => {
  try {
    const values = { issue_month: clean(req.body.issue_month, 7), title: clean(req.body.title, 120), highlights: clean(req.body.highlights, 600), reach: clean(req.body.reach, 10) };
    const errors = [];
    if (!isMonth(values.issue_month)) errors.push('Choose the month this issue is for.');
    if (req.uploadError) errors.push(req.uploadError);
    else if (!req.file) errors.push('Choose the newsletter PDF.');
    else if (!looksLikePdf(req.file.path)) errors.push('That file is not a PDF. Save or export the newsletter as a PDF and upload that.');
    if (errors.length) return adminPage(req, res, { errors, values });

    const pages = await renderPages(req.file.filename);
    uploads.adopt(req, pages);                                  // the page pictures are kept, or dropped, with the PDF they came from
    const title = values.title || `${monthName(values.issue_month)} newsletter`;
    // For the office being looked at, or (from someone who runs them) its market or the whole company.
    const where = reach.target(req.user, values.reach);
    db.prepare('INSERT INTO newsletters (title, issue_month, highlights, pdf_path, page_files, created_by, created_at, branch_id, market_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(title, values.issue_month, values.highlights || null, req.file.filename, JSON.stringify(pages), req.user.id, new Date().toISOString(), where.branch_id, where.market_id);
    activity.log(req.user, 'Newsletter uploaded', `${title} (${reach.label(where)})`);
    flash(req, 'ok', pages.length ? `Newsletter posted. It is now on the home page for: ${reach.label(where)}.`
      : 'Newsletter posted. Page pictures could not be made, so people will open the PDF itself.');
    res.redirect('/admin/newsletters');
  } catch (err) { next(err); }
});

router.post('/admin/newsletters/:id/delete', requirePerm('newsletters.manage'), (req, res) => {
  const n = getIssue(req.params.id);
  if (n && !reach.runs(req.user, n)) return forbidden(res);
  if (n) {
    db.prepare('DELETE FROM newsletters WHERE id = ?').run(n.id);
    uploads.remove(n.pdf_path);
    n.pages.forEach((f) => uploads.remove(f));
    activity.log(req.user, 'Newsletter removed', n.title);
    flash(req, 'ok', 'Newsletter removed.');
  }
  res.redirect('/admin/newsletters');
});

module.exports = router;
module.exports.latest = latest;
module.exports.monthName = monthName;
