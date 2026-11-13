// Notification settings page: turn alerts on or off for the device being used.
(function () {
  var box = document.getElementById('push-box');
  if (!box) return;
  var state = document.getElementById('push-state');
  var on = document.getElementById('push-on');
  var off = document.getElementById('push-off');
  var csrf = box.getAttribute('data-csrf');

  function say(text) { state.textContent = text; }
  function post(url, fields) {
    var body = new URLSearchParams(fields); body.append('_csrf', csrf);
    return fetch(url, { method: 'POST', body: body, credentials: 'same-origin' });
  }
  function keyBytes(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function b64(buf) {
    var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function deviceName() {
    var ua = navigator.userAgent;
    var what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Windows/.test(ua) ? 'Windows computer' : /Mac/.test(ua) ? 'Mac' : 'Device';
    var browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return browser ? what + ' (' + browser + ')' : what;
  }
  function mark(endpoint) {
    document.querySelectorAll('[data-endpoint]').forEach(function (li) {
      var tag = li.querySelector('.this-device'); if (tag) tag.hidden = li.getAttribute('data-endpoint') !== endpoint;
    });
  }

  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  var installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    say(ios && !installed
      ? 'On an iPhone or iPad, alerts only work once this site is on your Home Screen. In Safari tap Share, then "Add to Home Screen", open it from there, and come back to this page.'
      : 'This browser cannot show alerts. Try Chrome, Edge, Firefox, or Safari on a newer phone.');
    return;
  }

  function show(sub) {
    if (Notification.permission === 'denied') {
      say('Alerts are blocked for this site on this device. Allow notifications for it in your browser or phone settings, then reload this page.');
      on.hidden = true; off.hidden = true; return;
    }
    on.hidden = Boolean(sub); off.hidden = !sub;
    say(sub ? 'Alerts are on for this device.' : 'Alerts are off for this device.');
    mark(sub ? sub.endpoint : null);
  }

  navigator.serviceWorker.ready.then(function (reg) {
    reg.pushManager.getSubscription().then(function (sub) {
      // Keep the server in step with what this device actually has.
      if (sub) { var j = sub.toJSON(); post('/push/subscribe', { endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName() }); }
      show(sub);
    });
    on.addEventListener('click', function () {
      on.disabled = true;
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') { show(null); return null; }
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(box.getAttribute('data-key')) });
      }).then(function (sub) {
        if (!sub) return;
        return post('/push/subscribe', { endpoint: sub.endpoint, p256dh: b64(sub.getKey('p256dh')), auth: b64(sub.getKey('auth')), device: deviceName() })
          .then(function () { location.reload(); });
      }).catch(function () { say('Alerts could not be turned on. Check that notifications are allowed for this site, then try again.'); })
        .then(function () { on.disabled = false; });
    });
    off.addEventListener('click', function () {
      reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) return show(null);
        return post('/push/unsubscribe', { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); }).then(function () { location.reload(); });
      });
    });
  }).catch(function () { say('Alerts could not be set up on this device.'); });
})();
