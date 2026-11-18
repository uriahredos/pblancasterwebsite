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
const device = require('./device');

const MULTIPART_PATHS = /^\/(parts|parts\/\d+\/edit|admin\/catalog\/import|admin\/stock\/import|admin\/import|admin\/newsletters|inspection|profile|admin\/people\/import|admin\/company\/contacts|admin\/company\/details|photos|branches\/\d+|discussions\/new|discussions\/t\/\d+\/reply|sales\/library|admin\/oncall\/import)$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // stay signed in on a phone for 30 days

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (config.production) app.set('trust proxy', 1);

Object.assign(app.locals, {
  labels: util.labels, fmtDateTime: util.fmtDateTime, fmtDate: util.fmtDate, splitNote: util.splitNote,
  // "11/5/2026" and "8:48 AM" separately, for stacking in a narrow column.
  money: util.money, fmt: require('./format').render,
  dateOnly: (iso) => util.fmtDateTime(iso).split(', ')[0], timeOnly: (iso) => util.fmtDateTime(iso).split(', ')[1] || '',
  // Changes on every start, so browsers fetch fresh styles and scripts after an update.
  assetV: Date.now().toString(36),
  lockAfterMs: config.lockAfterMs.phone, minPasswordLength: config.minPasswordLength, tempPasswordDays: config.tempPasswordDays, editWindowHours: config.editWindowHours,
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

// Device features the site may use: the camera, for scanning part barcodes. Nothing else, and nothing for embedded pages.
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), midi=()'); next(); });

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
  // How long this device may sit unused: the page needs it too, to check when it comes back from the background.
  res.locals.lockAfterMs = device.lockAfterMs(req);
  res.setHeader('Cache-Control', 'no-store');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // These forms carry a file; their routes check the token after the upload is parsed.
  if (MULTIPART_PATHS.test(req.path) && req.is('multipart/form-data')) return next();
  auth.verifyCsrf(req, res, next);
});

// The lock. Someone stays remembered on their device for 30 days, but the site locks when it is
// closed (the page tells us, see site.js) or left unused (10 minutes on a phone or tablet, 20 on a computer), and then nothing
// opens until they prove who they are again with Face ID, a fingerprint or their password.
const WHILE_LOCKED = /^\/(unlock|lock|logout|passkey\/auth\/(options|verify))$/;
app.use((req, res, next) => {
  res.locals.locked = false;
  res.locals.fresh = false;
  if (!req.user) return next();
  const s = req.session;
  const now = Date.now();
  const lockAfter = res.locals.lockAfterMs;
  if (!s.locked && lockAfter && s.seenAt && now - s.seenAt > lockAfter) s.locked = true;
  if (!s.locked) {
    // The page's own background check for new alerts is not the person doing something: it must not hold off the lock.
    if (req.path !== '/pulse') s.seenAt = now;
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
app.use(require('./routes/social'));
app.use(require('./routes/company'));
app.use(require('./routes/forum'));
app.use(require('./routes/reactions'));
app.use(require('./routes/sales'));
app.use(require('./routes/oncall'));
require('./team');   // adds its columns on first start
require('./removal');
app.use(require('./routes/digest'));
app.use(require('./routes/import'));
app.use(require('./routes/backups'));
app.use(require('./routes/security'));
app.use(require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Too much sent at once, or something that could not be read at all: say so plainly. Anything else is ours to look at.
  const status = err && (err.status === 413 || err.type === 'entity.too.large') ? 413 : err && err.status >= 400 && err.status < 500 ? 400 : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return next(err);
  const title = status === 413 ? 'Too much to send at once' : status === 400 ? 'That could not be read' : 'Something went wrong';
  const message = status === 413 ? 'That was more than the site accepts in one go. Shorten it, or send fewer or smaller files.' : status === 400 ? 'The site could not read what was sent. Go back and try again.' : 'Please try again. If it keeps happening, tell your admin.';
  // These can arrive before the page has what its header needs, so the plain version is always available.
  if (!('can' in res.locals)) return res.status(status).type('text/plain').send(`${title}. ${message}`);
  res.status(status).render('error', { title, message }, (e, html) => (e ? res.status(status).type('text/plain').send(`${title}. ${message}`) : res.send(html)));
});

module.exports = app;
