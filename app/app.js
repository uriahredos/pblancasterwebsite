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

const MULTIPART_PATHS = /^\/(parts|parts\/\d+\/edit|admin\/catalog\/import|admin\/stock\/import)$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // stay signed in on a phone for 30 days

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (config.production) app.set('trust proxy', 1);

Object.assign(app.locals, {
  labels: util.labels, fmtDateTime: util.fmtDateTime, fmtDate: util.fmtDate,
  minPasswordLength: config.minPasswordLength, editWindowHours: config.editWindowHours,
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
    res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode}`));
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

app.use(require('./routes/auth'));
app.use(require('./routes/home'));
app.use(require('./routes/training'));
app.use(require('./routes/parts'));
app.use(require('./routes/complaints'));
app.use(require('./routes/catalog'));
app.use(require('./routes/stock'));
app.use(require('./routes/sessions'));
app.use(require('./routes/digest'));
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
