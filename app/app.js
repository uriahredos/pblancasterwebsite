'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const SqliteStore = require('./sessionStore');
const auth = require('./auth');
const util = require('./util');
const device = require('./device');
const { rateKey } = require('./clientip');

const MULTIPART_PATHS = /^\/(social|parts|parts\/\d+\/edit|admin\/catalog\/import|admin\/stock\/import|admin\/import|admin\/newsletters|inspection|profile|admin\/people\/import|admin\/company\/contacts|admin\/company\/details|photos|branches\/\d+|discussions\/new|discussions\/t\/\d+\/reply|sales\/library|admin\/oncall\/import)$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // stay signed in on a phone for 30 days
const VISITOR_MS = 2 * 60 * 60 * 1000;       // a visitor who has not signed in: long enough to fill in the sign-in or reset form
// The anonymous complaint pages. Nothing about a request for one is written down anywhere: not in the log, not in the session.
// Capitals make no difference to which page is shown (/Complaint is the same form), so they make none here either.
const complaintPage = (req) => /^\/complaint/i.test(req.path);
// What a page does by itself: checking for news, saying "still here", locking when the site is reopened, showing the lock screen.
// A person's own picture is in the header of every page, so it counts as well: on its own in the log it would give away the page around it.
const pageItself = (req) => ['/pulse', '/alive', '/lock', '/push/attach', '/live/stream'].includes(req.path) || req.get('x-live') === '1' || (req.path === '/unlock' && req.method === 'GET') || /^\/people\/photo\/\d+$/.test(req.path);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
if (config.production) app.set('trust proxy', 1);

Object.assign(app.locals, {
  labels: util.labels, fmtDateTime: util.fmtDateTime, fmtDate: util.fmtDate, splitNote: util.splitNote,
  placeLabel: (name) => require('./branches').placeLabel(name),   // "Ephrata branch", plain "Corporate"
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
      // Styles and fonts come from this site only, and never from inside a page: nothing injected into a page can restyle it or call out.
      'style-src': ["'self'"],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      // No other site may show these pages inside its own (and this one never needs to).
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': config.production ? [] : null,
    },
  },
  frameguard: { action: 'deny' },
}));

// Device features the site may use: the camera (scanning part barcodes, video calls) and the microphone (video calls). Nothing else, and nothing for embedded pages.
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), midi=()'); next(); });

// Barcode scanning library, served from the installed package so nothing is loaded from other sites.
app.get('/vendor/html5-qrcode.min.js', (req, res) => {
  res.sendFile(require.resolve('html5-qrcode/html5-qrcode.min.js'), { maxAge: config.production ? '7d' : 0 });
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.production ? '1h' : 0 }));

// Request log. Complaint pages are left out on purpose and no user is ever logged. What a page does by itself is left
// out too, so a request that is missing from the log says nothing about what it was. That includes locking and the lock
// screen: a site reopened straight at the complaint form locks like any other page, and must not stand out by doing so.
app.use((req, res, next) => {
  if (!complaintPage(req) && !pageItself(req)) {
    // A password-reset link is a key for an hour, so it is never written to the log.
    const shown = req.path.startsWith('/reset/') ? '/reset/…' : req.path;
    res.on('finish', () => console.log(`${req.method} ${shown} ${res.statusCode}`));
  }
  next();
});

app.use(session({
  name: 'portal.sid',
  secret: config.sessionSecret,
  store: new SqliteStore(db, SESSION_MS, VISITOR_MS),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: SESSION_MS },
}));
// A complaint page leaves the person's session row exactly as it found it (the store checks for this mark), so the row
// cannot show that they opened or sent one, or when.
app.use((req, res, next) => { if (complaintPage(req)) Object.defineProperty(req.session, 'leaveAlone', { value: true }); next(); });

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '60kb' }));   // Face ID / fingerprint sign-in talks to the server in JSON

app.use(auth.loadUser);

// Visitors who are not signed in get a generous allowance per address (a whole office can share one): enough for everyone
// there to sign in several times over. It is only there so a flood from one place cannot keep the site busy or fill the
// disk. People who are signed in are never counted, and neither is the health check (answered above).
app.use(rateLimit({
  windowMs: 5 * 60 * 1000, limit: config.loginRateLimit * 60, standardHeaders: true, legacyHeaders: false, keyGenerator: rateKey,
  skip: (req) => Boolean(req.user),
  handler: (req, res) => res.status(429).type('text/plain').send('Too many requests from this connection. Wait a few minutes and try again.'),
}));

app.use((req, res, next) => {
  // Someone signed in always has a form token. A visitor who is not gets one only from a page that shows them a form
  // (sign-in, forgot password, reset: see routes/auth.js), so nothing else they ask for leaves a session behind.
  if (req.user) auth.formToken(req, res); else res.locals.csrf = req.session.csrf || '';
  // A message waiting to be shown is kept for the next ordinary page rather than used up on a complaint page.
  res.locals.flash = complaintPage(req) ? null : req.session.flash || null;
  if (!complaintPage(req)) delete req.session.flash;
  res.locals.path = req.path;
  // How long this device may sit unused: the page needs it too, to check when it comes back from the background.
  res.locals.lockAfterMs = device.lockAfterMs(req);
  // The key a device needs to register for alerts, for the bar that offers them (only to someone signed in).
  // The how-to guide for this page, if this person has one: the header offers it as "How to use this page".
  res.locals.runsThings = () => require('./manage').has(req.user);   // whether the menu offers Manage
  res.locals.helpFor = () => require('./help').forPage(req.user, req.path);
  res.locals.pushKey = req.session && req.session.userId ? require('./push').vapid().publicKey : '';
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
    // What the page does by itself (checking for new alerts, re-attaching this device's alerts) is not the person doing
    // something: it must not hold off the lock. A complaint page leaves no last-seen time either.
    if (req.path !== '/pulse' && req.path !== '/push/attach' && req.path !== '/live/stream' && req.get('x-live') !== '1' && !complaintPage(req)) s.seenAt = now;
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
app.use(require('./routes/posts'));
app.use(require('./routes/stock'));
app.use(require('./routes/inventory'));
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
app.use(require('./routes/live'));
app.use(require('./routes/call'));
app.use(require('./routes/messages'));
app.use(require('./routes/forum'));
app.use(require('./routes/reactions'));
app.use(require('./routes/sales'));
app.use(require('./routes/oncall'));
app.use(require('./routes/markets'));
app.use(require('./routes/fleet'));
app.use(require('./routes/help'));
app.use(require('./routes/search'));
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
