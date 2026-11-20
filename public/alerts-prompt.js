// Offers alerts on this device, once the person is signed in: a bar with "Turn on", which is what makes the phone or
// browser ask its own "Allow notifications?" question. A phone only lets a page ask after a tap, so the bar is the tap.
// It is not shown where alerts are already on or were refused, on a complaint page, or for two weeks after "Not now".
(function () {
  var bar = document.getElementById('alerts-bar');
  var key = (document.querySelector('meta[name="push-key"]') || {}).content;
  if (!bar || !key || !document.documentElement.hasAttribute('data-in')) return;
  if (/^\/(complaint|settings\/notifications|unlock)/i.test(location.pathname)) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;   // an iPhone before the site is on the Home Screen lands here
  if (Notification.permission !== 'default') return;                       // already allowed (the site re-attaches by itself) or refused
  var later = 0; try { later = Number(localStorage.getItem('alerts-later')) || 0; } catch (e) {}
  if (Date.now() < later) return;

  var go = document.getElementById('alerts-go'); var how = document.getElementById('alerts-how');
  function hide(days) { bar.hidden = true; try { localStorage.setItem('alerts-later', String(Date.now() + days * 86400000)); } catch (e) {} }
  function keyBytes(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4); var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out;
  }
  function b64(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function deviceName() {
    var ua = navigator.userAgent;
    var what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Windows/.test(ua) ? 'Windows computer' : /Mac/.test(ua) ? 'Mac' : 'Device';
    var browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return browser ? what + ' (' + browser + ')' : what;
  }

  navigator.serviceWorker.ready.then(function (reg) {
    // One bar at a time: while "Get the app" is showing, that comes first.
    var install = document.getElementById('install-bar');
    // (That bar can take a few seconds to decide whether to show, so this one waits for it, and steps back if it turns up.)
    function offer() { if (install && !install.hidden) { bar.hidden = true; return setTimeout(offer, 4000); } bar.hidden = false; setTimeout(function () { if (install && !install.hidden && !go.hidden && !go.disabled) offer(); }, 3000); }
    setTimeout(offer, 5000);
    go.addEventListener('click', function () {
      go.disabled = true;
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') { hide(perm === 'denied' ? 365 : 14); return null; }
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      }).then(function (sub) {
        if (!sub) return;
        var body = new URLSearchParams({ _csrf: (document.querySelector('meta[name="csrf"]') || {}).content || '', endpoint: sub.endpoint, p256dh: b64(sub.getKey('p256dh')), auth: b64(sub.getKey('auth')), device: deviceName() });
        return fetch('/push/subscribe', { method: 'POST', body: body, credentials: 'same-origin' }).then(function (res) {
          if (!res.ok) throw new Error('not saved');
          how.textContent = 'Alerts are on for this device. Choose which ones under Notification settings.';
          go.hidden = true; document.getElementById('alerts-later').textContent = 'Close';
        });
      }).catch(function () { how.textContent = 'Alerts could not be turned on. Try again from Notification settings.'; go.disabled = false; });
    });
    document.getElementById('alerts-later').addEventListener('click', function () { hide(go.hidden ? 365 : 14); });
  }).catch(function () {});
})();
