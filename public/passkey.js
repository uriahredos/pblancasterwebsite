// Face ID / fingerprint sign-in, using the browser's built-in passkey feature.
(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';
  var errorBox = document.getElementById('passkey-error');
  var supported = Boolean(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  function toBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function toText(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function post(url, data) {
    data = data || {}; data._csrf = csrf;
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function show(msg) { if (errorBox) { errorBox.textContent = msg; errorBox.hidden = !msg; } }
  function busy(btn, on, label) { if (!btn) return; btn.disabled = on; if (label) btn.textContent = label; }
  function remember(userId, on) { try { if (on) localStorage.setItem('passkey:' + userId, '1'); else localStorage.removeItem('passkey:' + userId); } catch (e) {} }
  function remembered(userId) { try { return localStorage.getItem('passkey:' + userId) === '1'; } catch (e) { return false; } }
  // Cancelling the phone's prompt is not an error worth shouting about.
  function cancelled(e) { return e && (e.name === 'NotAllowedError' || e.name === 'AbortError'); }

  function deviceName() {
    var ua = navigator.userAgent || '';
    var what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows computer' : /CrOS/.test(ua) ? 'Chromebook' : 'This device';
    var browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return browser ? what + ' (' + browser + ')' : what;
  }

  // ---- Unlocking, or signing in from the sign-in page -----------------------
  function signIn(next, btn, label) {
    show(''); busy(btn, true, 'Waiting for your device…');
    return post('/passkey/auth/options').then(function (r) {
      if (!r.ok) throw new Error(r.error || 'Could not start. Use your password.');
      var o = r.options;
      o.challenge = toBuf(o.challenge);
      (o.allowCredentials || []).forEach(function (c) { c.id = toBuf(c.id); });
      return navigator.credentials.get({ publicKey: o });
    }).then(function (c) {
      var a = c.response;
      return post('/passkey/auth/verify', { next: next, response: {
        id: c.id, rawId: toText(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
        authenticatorAttachment: c.authenticatorAttachment || undefined,
        response: { clientDataJSON: toText(a.clientDataJSON), authenticatorData: toText(a.authenticatorData), signature: toText(a.signature), userHandle: a.userHandle ? toText(a.userHandle) : undefined }
      } });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'That did not work. Use your password.');
      location.replace(r.next || '/');
    }).catch(function (e) {
      busy(btn, false, label);
      if (!cancelled(e)) show(e && e.name === 'Error' ? e.message : 'That did not work. Try again, or use your password.');
    });
  }

  var go = document.getElementById('passkey-go');
  var unlockBox = document.getElementById('passkey-unlock');
  var loginBox = document.getElementById('passkey-login');
  if (go && supported && (unlockBox || loginBox)) {
    var box = unlockBox || loginBox;
    var label = go.textContent;
    box.hidden = false;
    var or = document.getElementById('passkey-or'); if (or) or.hidden = false;
    go.addEventListener('click', function () { signIn(box.getAttribute('data-next') || '/', go, label); });
    // On a device where it has been set up, ask straight away: open the site, glance at the phone, in.
    if (unlockBox && remembered(unlockBox.getAttribute('data-user'))) signIn(box.getAttribute('data-next') || '/', go, label);
  }
  var hint = document.getElementById('passkey-hint');
  if (hint && supported) hint.hidden = false;

  // ---- Setting it up on this device ----------------------------------------
  var setup = document.getElementById('passkey-setup');
  var add = document.getElementById('passkey-add');
  if (setup && add) {
    var userId = setup.getAttribute('data-user');
    var canUse = supported && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
      ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; }) : Promise.resolve(false);
    canUse.then(function (yes) {
      if (!yes) { document.getElementById('passkey-unsupported').hidden = false; return; }
      // Nothing listed any more (removed, or reset by an admin): forget that this device was set up.
      if (!setup.querySelector('.plain-list li')) remember(userId, false);
      add.hidden = false;
      if (remembered(userId)) { add.textContent = 'Set up again on this device'; add.className = 'btn'; }
      add.addEventListener('click', function () {
        show(''); busy(add, true, 'Waiting for your device…');
        post('/passkey/register/options').then(function (r) {
          if (!r.ok) throw new Error(r.error || 'Could not start. Try again.');
          var o = r.options;
          o.challenge = toBuf(o.challenge); o.user.id = toBuf(o.user.id);
          (o.excludeCredentials || []).forEach(function (c) { c.id = toBuf(c.id); });
          return navigator.credentials.create({ publicKey: o });
        }).then(function (c) {
          var a = c.response;
          return post('/passkey/register/verify', { device: deviceName(), response: {
            id: c.id, rawId: toText(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
            authenticatorAttachment: c.authenticatorAttachment || undefined,
            response: { clientDataJSON: toText(a.clientDataJSON), attestationObject: toText(a.attestationObject), transports: a.getTransports ? a.getTransports() : undefined }
          } });
        }).then(function (r) {
          if (!r.ok) throw new Error(r.error || 'This device could not be set up. Try again.');
          remember(userId, true);
          location.reload();
        }).catch(function (e) {
          busy(add, false, remembered(userId) ? 'Set up again on this device' : 'Set up on this device');
          if (e && e.name === 'InvalidStateError') { remember(userId, true); show('This device is already set up.'); }
          else if (!cancelled(e)) show(e && e.name === 'Error' ? e.message : 'This device could not be set up. Try again.');
        });
      });
    });
  }

  // Home page tip: offered once on a device that can do it, to people who have not set it up anywhere.
  var tip = document.getElementById('passkey-tip');
  if (tip && supported && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    var dismissed = false; try { dismissed = localStorage.getItem('passkey:tip') === 'no'; } catch (e) {}
    if (!dismissed) PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function (yes) { if (yes) tip.hidden = false; }).catch(function () {});
    var later = document.getElementById('passkey-tip-no');
    if (later) later.addEventListener('click', function () { tip.hidden = true; try { localStorage.setItem('passkey:tip', 'no'); } catch (e) {} });
  }
})();
