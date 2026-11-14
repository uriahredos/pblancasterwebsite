// Service worker: lets the site be installed on a phone's home screen and shows a
// friendly page when there is no signal. Pages themselves are never stored, so
// nothing private is kept on the phone by this file.
var CACHE = 'portal-static-v13';
var ASSETS = ['/offline.html', '/offline.js', '/styles.css', '/site.js', '/passkey.js', '/theme.js', '/logo.png', '/parts-form.js', '/scan.js', '/inspection-form.js', '/icons/icon-192.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// A push alert from the site: show it. The message carries only a short title, a line of text and where to go.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Pye-Barker Lancaster', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Pye-Barker Lancaster', {
    body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: data.tag || undefined, renotify: Boolean(data.tag),
    data: { url: data.url || '/' }
  }));
});

// Tapping the alert opens the right page, reusing a window that is already open.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) { list[i].navigate(url); return list[i].focus(); } }
    return self.clients.openWindow(url);
  }));
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
    }).catch(function () { return caches.match(req, { ignoreSearch: true }); }));
  }
});
