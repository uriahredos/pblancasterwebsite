'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const activity = require('../activity');
const uploads = require('../uploads');
const { requireLogin, requirePerm, verifyCsrf, flash } = require('../auth');
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

/** Newest issue first. */
function latest(limit) {
  return db.prepare(
    `SELECT n.*, u.display_name AS author FROM newsletters n JOIN users u ON u.id = n.created_by
     ORDER BY n.issue_month DESC, n.id DESC LIMIT ?`).all(limit).map(decorate);
}
const getIssue = (id) => {
  const row = /^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM newsletters WHERE id = ?').get(id) : null;
  return row ? decorate(row) : null;
};

/**
 * Make a picture of each page with pdftoppm (from poppler-utils). Resolves to the
 * file names, first page first; an empty list when the tool is missing or the PDF
 * cannot be read, in which case people simply open the PDF itself.
 */
function renderPages(pdfName) {
  const prefix = pdfName.replace(/\.pdf$/, '');
  return new Promise((resolve) => {
    execFile('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82', '-scale-to-x', '1100', '-scale-to-y', '-1', '-f', '1', '-l', String(MAX_PAGES),
      path.join(uploads.uploadDir, pdfName), path.join(uploads.uploadDir, prefix)], { timeout: 90 * 1000 }, (err) => {
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
  res.render('newsletters', { title: 'Newsletters', issues: latest(120) });
});

router.get('/newsletters/:id', requireLogin, (req, res, next) => {
  const n = getIssue(req.params.id);
  if (!n) return next();
  if (!n.pages.length) return res.redirect(`/newsletters/${n.id}/pdf`);
  const newer = db.prepare('SELECT id FROM newsletters WHERE (issue_month, id) > (?, ?) ORDER BY issue_month, id LIMIT 1').get(n.issue_month, n.id);
  const older = db.prepare('SELECT id FROM newsletters WHERE (issue_month, id) < (?, ?) ORDER BY issue_month DESC, id DESC LIMIT 1').get(n.issue_month, n.id);
  res.render('newsletter', { title: n.title, n, newer, older, wide: false });
});

const FILE_HEADERS = { 'Cache-Control': 'private, max-age=86400' };

router.get('/newsletters/:id/pdf', requireLogin, (req, res, next) => {
  const n = getIssue(req.params.id);
  if (!n) return next();
  const name = `${n.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'newsletter'}.pdf`;
  res.sendFile(path.basename(n.pdf_path), {
    root: uploads.uploadDir, headers: { ...FILE_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"` },
  }, (err) => { if (err && !res.headersSent) next(); });
});

router.get('/newsletters/:id/page/:n', requireLogin, (req, res, next) => {
  const n = getIssue(req.params.id);
  const file = n && /^\d+$/.test(req.params.n) ? n.pages[Number(req.params.n) - 1] : null;
  if (!file) return next();
  res.sendFile(path.basename(file), { root: uploads.uploadDir, headers: FILE_HEADERS }, (err) => { if (err && !res.headersSent) next(); });
});

// ---- Uploading and removing --------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: uploads.uploadDir,
    filename: (req, file, cb) => cb(null, `nl-${crypto.randomBytes(16).toString('hex')}.pdf`),
  }),
  limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 20 },
}).single('pdf');

function parseUpload(req, res, next) {
  upload(req, res, (err) => {
    req.uploadError = err ? (err.code === 'LIMIT_FILE_SIZE' ? 'The PDF is larger than 25 MB.' : 'The PDF could not be uploaded.') : null;
    req.body = req.body || {};
    // If the form is refused after the file was saved, do not leave the file behind.
    res.once('finish', () => { if (res.statusCode >= 400 && req.file) uploads.remove(req.file.filename); });
    next();
  });
}

function adminPage(req, res, extra = {}) {
  res.status(extra.errors ? 400 : 200).render('admin_newsletters', {
    title: 'Newsletters', issues: latest(200), errors: [], values: {}, wide: true, ...extra,
  });
}

router.get('/admin/newsletters', requirePerm('newsletters.manage'), (req, res) => adminPage(req, res));

router.post('/admin/newsletters', requirePerm('newsletters.manage'), parseUpload, verifyCsrf, async (req, res, next) => {
  try {
    const values = { issue_month: clean(req.body.issue_month, 7), title: clean(req.body.title, 120), highlights: clean(req.body.highlights, 600) };
    const errors = [];
    if (!isMonth(values.issue_month)) errors.push('Choose the month this issue is for.');
    if (req.uploadError) errors.push(req.uploadError);
    else if (!req.file) errors.push('Choose the newsletter PDF.');
    else if (!looksLikePdf(req.file.path)) errors.push('That file is not a PDF. Save or export the newsletter as a PDF and upload that.');
    if (errors.length) return adminPage(req, res, { errors, values });

    const pages = await renderPages(req.file.filename);
    const title = values.title || `${monthName(values.issue_month)} newsletter`;
    db.prepare('INSERT INTO newsletters (title, issue_month, highlights, pdf_path, page_files, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(title, values.issue_month, values.highlights || null, req.file.filename, JSON.stringify(pages), req.user.id, new Date().toISOString());
    activity.log(req.user, 'Newsletter uploaded', title);
    flash(req, 'ok', pages.length ? 'Newsletter posted. It is now on everyone\'s home page.'
      : 'Newsletter posted. Page pictures could not be made, so people will open the PDF itself.');
    res.redirect('/admin/newsletters');
  } catch (err) { next(err); }
});

router.post('/admin/newsletters/:id/delete', requirePerm('newsletters.manage'), (req, res) => {
  const n = getIssue(req.params.id);
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
