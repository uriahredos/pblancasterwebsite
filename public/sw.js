// Service worker: lets the site be installed on a phone's home screen and shows a
// friendly page when there is no signal. Pages themselves are never stored, so
// nothing private is kept on the phone by this file.
var CACHE = 'portal-static-v2';
var ASSETS = ['/offline.html', '/offline.js', '/styles.css', '/site.js', '/theme.js', '/logo.png', '/parts-form.js', '/icons/icon-192.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Opening or submitting a page with no signal: show the offline page instead of a browser error.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(function () { return caches.match('/offline.html'); }));
    return;
  }

  // Stylesheet, scripts and icons: use the network, fall back to the saved copy.
  if (req.method === 'GET' && (ASSETS.indexOf(url.pathname) >= 0 || url.pathname.indexOf('/icons/') === 0)) {
    event.respondWith(fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req); }));
  }
});
