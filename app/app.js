'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const db = require('./db');
const SqliteStore = require('./sessionStore');
const auth = require('./auth');
const util = require('./util');

const MULTIPART_PATHS = /^\/(parts|parts\/\d+\/edit|admin\/catalog\/import|admin\/stock\/import|admin\/import|admin\/newsletters|inspection|profile|admin\/people\/import|discussions\/new|discussions\/t\/\d+\/reply)$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // stay signed in on a phone for 30 days

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (config.production) app.set('trust proxy', 1);

Object.assign(app.locals, {
  labels: util.labels, fmtDateTime: util.fmtDateTime, fmtDate: util.fmtDate, splitNote: util.splitNote,
  // "11/5/2026" and "8:48 AM" separately, for stacking in a narrow column.
  dateOnly: (iso) => util.fmtDateTime(iso).split(', ')[0], timeOnly: (iso) => util.fmtDateTime(iso).split(', ')[1] || '',
  // Changes on every start, so browsers fetch fresh styles and scripts after an update.
  assetV: Date.now().toString(36),
  lockAfterMs: config.lockAfterMs, minPasswordLength: config.minPasswordLength, editWindowHours: config.editWindowHours,
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'img-src': ["'self'", 'data:', 'blob:'],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': config.production ? [] : null,
    },
  },
}));

// Barcode scanning library, served from the installed package so nothing is loaded from other sites.
app.get('/vendor/html5-qrcode.min.js', (req, res) => {
  res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'), { maxAge: config.production ? '7d' : 0 });
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.production ? '1h' : 0 }));

// Request log. Complaint pages are left out on purpose and no user is ever logged.
app.use((req, res, next) => {
  if (!req.path.startsWith('/complaint')) {
    // A password-reset link is a key for an hour, so it is never written to the log.
    const shown = req.path.startsWith('/reset/') ? '/reset/…' : req.path;
    res.on('finish', () => console.log(`${req.method} ${shown} ${res.statusCode}`));
  }
  next();
});

app.use(session({
  name: 'portal.sid',
  secret: config.sessionSecret,
  store: new SqliteStore(db, SESSION_MS),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: SESSION_MS },
}));

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '60kb' }));   // Face ID / fingerprint sign-in talks to the server in JSON

app.use(auth.loadUser);

app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = auth.newCsrfToken();
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  res.setHeader('Cache-Control', 'no-store');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // These forms carry a file; their routes check the token after the upload is parsed.
  if (MULTIPART_PATHS.test(req.path) && req.is('multipart/form-data')) return next();
  auth.verifyCsrf(req, res, next);
});

// The lock. Someone stays remembered on their device for 30 days, but the site locks when it is
// closed (the page tells us, see site.js) or left unused for a few minutes, and then nothing
// opens until they prove who they are again with Face ID, a fingerprint or their password.
const WHILE_LOCKED = /^\/(unlock|lock|logout|passkey\/auth\/(options|verify))$/;
app.use((req, res, next) => {
  res.locals.locked = false;
  res.locals.fresh = false;
  if (!req.user) return next();
  const s = req.session;
  const now = Date.now();
  if (!s.locked && config.lockAfterMs && s.seenAt && now - s.seenAt > config.lockAfterMs) s.locked = true;
  if (!s.locked) {
    s.seenAt = now;
    if (s.fresh && req.method === 'GET') { res.locals.fresh = true; delete s.fresh; }
    return next();
  }
  res.locals.locked = true;
  if (WHILE_LOCKED.test(req.path)) return next();
  res.redirect(req.method === 'GET' ? '/unlock?next=' + encodeURIComponent(req.originalUrl) : '/unlock');
});

app.use(require('./routes/auth'));
app.use(require('./routes/passkeys'));
app.use(require('./routes/home'));
app.use(require('./routes/training'));
app.use(require('./routes/parts'));
app.use(require('./routes/complaints'));
app.use(require('./routes/catalog'));
app.use(require('./routes/stock'));
app.use(require('./routes/sessions'));
app.use(require('./routes/certs'));
app.use(require('./routes/inspections'));
app.use(require('./routes/announcements'));
app.use(require('./routes/tasks'));
app.use(require('./routes/push'));
app.use(require('./routes/newsletters'));
app.use(require('./routes/community'));
app.use(require('./routes/forum'));
app.use(require('./routes/digest'));
app.use(require('./routes/import'));
app.use(require('./routes/backups'));
app.use(require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again. If it keeps happening, tell your admin.' });
});

module.exports = app;
