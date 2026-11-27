// Service worker: lets the site be installed on a phone's home screen and shows a
// friendly page when there is no signal. Pages themselves are never stored, so
// nothing private is kept on the phone by this file.
var CACHE = 'portal-static-v130';
var ASSETS = ['/offline.html', '/offline.js', '/styles.css', '/site.js', '/alerts-prompt.js', '/passkey.js', '/theme.js', '/logo.png', '/logo-p.png', '/logo-b.png', '/logo-flame.png', '/parts-form.js', '/scan.js', '/inspection-form.js', '/icons/icon-192.png', '/icons/badge-pb-96.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// A push alert from the site. If the site is open and on the screen, the page itself says so (a small note and a chime)
// and the phone's own notification is left out: nobody needs both. Otherwise the phone shows it.
// An iPhone must always be shown a notification for a push, or it takes the permission away, so there it is always shown.
var MUST_SHOW = /iPhone|iPad|iPod/.test(self.navigator.userAgent) || (/Safari/.test(self.navigator.userAgent) && !/Chrome|Chromium|Edg/.test(self.navigator.userAgent));
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'PB Portal', body: event.data ? event.data.text() : '' }; }
  var show = function () {
    return self.registration.showNotification(data.title || 'PB Portal', {
      // Every alert carries the same PB logo: the picture beside the text, and its outline as the small mark in the status bar.
      body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/badge-pb-96.png',
      // The ones that need someone now make the phone's alert sound and buzz; the rest arrive without a noise. A quiet one
      // takes the place of the last of its kind. A loud one is always its own new alert: a replacement is swapped in
      // without a sound, so a second message while the first was still on the screen made no noise at all.
      tag: data.quiet && data.tag ? data.tag : undefined, silent: Boolean(data.quiet), vibrate: data.quiet ? undefined : (data.ring ? [400, 200, 400, 200, 400] : [200, 100, 200]),
      requireInteraction: Boolean(data.ring),
      data: { url: data.url || '/' }
    });
  };
  event.waitUntil(MUST_SHOW ? show() : self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var open = list.filter(function (c) { return c.visibilityState === 'visible'; });
    if (!open.length) return show();
    open.forEach(function (c) { c.postMessage({ type: 'pb-push', title: data.title || '', body: data.body || '', url: data.url || '/', quiet: Boolean(data.quiet), ring: Boolean(data.ring) }); });
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
