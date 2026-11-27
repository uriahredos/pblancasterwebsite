// A call with one person, in a small window that floats over the site. It belongs to no page: it stays up, and the call
// carries on, while the person moves around the site underneath it. Two phones or computers are connected directly (or
// through a relay when a network will not allow that); nothing is recorded.
(function () {
  'use strict';
  var win = document.getElementById('callwin');
  if (window.pbCall || !win || !document.documentElement.hasAttribute('data-in')) return;
  var $ = function (id) { return document.getElementById(id); };
  var remoteEl = $('callwin-remote'), localEl = $('callwin-local'), statusEl = $('callwin-status'), nameEl = $('callwin-name');
  var supported = Boolean(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  var id = null, name = '', mode = 'video', role = null, pc = null, local = null, servers = null, facing = 'user';
  var queue = [], pendingIce = [], remoteSet = false, beatTimer = null, clock = null, since = 0, closing = null, wake = null, busy = false;

  function csrf() { var m = document.querySelector('meta[name="csrf"]'); return m ? m.getAttribute('content') : ''; }
  function post(path, fields) {
    var body = new URLSearchParams(); body.append('_csrf', csrf());
    Object.keys(fields || {}).forEach(function (k) { body.append(k, fields[k]); });
    return fetch('/call/dm/' + id + '/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', Accept: 'application/json' }, body: body.toString() })
      .then(function (res) {
        if (!/json/.test(res.headers.get('content-type') || '')) throw new Error('Sign in again to make calls.');
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'That did not work.'); return j; });
      });
  }
  function status(text) { statusEl.textContent = text || ''; }
  function initials(n) { return String(n || '?').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function mediaError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'The microphone or camera is blocked for this site. Allow it in the browser or phone settings and try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone or camera was found on this device.';
    if (n === 'NotReadableError') return 'The microphone or camera is in use by another app.';
    return 'Could not start the microphone or camera.';
  }

  // What the caller hears while the other end rings: the ordinary ringing tone, two seconds on and four off.
  var ringCtx = null, ringTimer = null;
  function ringback(on) {
    clearInterval(ringTimer); ringTimer = null;
    if (ringCtx) { try { ringCtx.close(); } catch (e) { /* closed */ } ringCtx = null; }
    win.classList.toggle('ringing', Boolean(on));
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!on || !AC) return;
    try {
      ringCtx = new AC();
      var burst = function () {
        if (!ringCtx) return;
        var t0 = ringCtx.currentTime, g = ringCtx.createGain();
        g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.07, t0 + 0.05); g.gain.setValueAtTime(0.07, t0 + 1.95); g.gain.linearRampToValueAtTime(0.0001, t0 + 2);
        g.connect(ringCtx.destination);
        [440, 480].forEach(function (f) { var o = ringCtx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t0); o.stop(t0 + 2.05); });
      };
      burst(); ringTimer = setInterval(burst, 6000);
    } catch (e) { ringCtx = null; }
  }

  function stopLocal() { if (local) { local.getTracks().forEach(function (t) { t.stop(); }); local = null; } localEl.srcObject = null; }
  function closePc() { if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; try { pc.close(); } catch (e) { /* closed */ } pc = null; } remoteSet = false; pendingIce = []; remoteEl.srcObject = null; }
  function startClock() {
    if (clock) return;
    since = Date.now();
    var draw = function () { var s = Math.floor((Date.now() - since) / 1000); status(Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2)); };
    draw(); clock = setInterval(draw, 1000);
  }
  function makePc() {
    closePc();
    pc = new RTCPeerConnection({ iceServers: servers });
    pc.onicecandidate = function (e) { if (e.candidate) post('signal', { kind: 'candidate', data: JSON.stringify(e.candidate.toJSON()) }).catch(function () {}); };
    pc.ontrack = function (e) { if (e.streams && e.streams[0]) remoteEl.srcObject = e.streams[0]; var p = remoteEl.play(); if (p && p.catch) p.catch(function () {}); };
    pc.onconnectionstatechange = function () {
      if (!pc) return;
      var s = pc.connectionState;
      if (s === 'connected') { ringback(false); win.classList.add('live'); startClock(); }
      else if (s === 'disconnected') { clearInterval(clock); clock = null; status('Connection lost. Trying to get it back…'); }
      else if (s === 'failed') { clearInterval(clock); clock = null; status('The connection failed. This network may not allow calls.'); }
    };
    local.getTracks().forEach(function (t) { pc.addTrack(t, local); });
  }

  function open() {
    clearTimeout(closing);
    nameEl.textContent = name; $('callwin-face').textContent = $('callwin-big').textContent = initials(name);
    win.classList.toggle('audio-only', mode === 'audio'); win.classList.remove('min', 'live', 'over');
    $('cw-mute').setAttribute('aria-pressed', 'false'); $('cw-cam').setAttribute('aria-pressed', 'false');
    win.hidden = false; document.body.classList.add('on-call');
  }
  function cleanup() {
    clearInterval(beatTimer); beatTimer = null; clearInterval(clock); clock = null; ringback(false);
    if (wake && wake.release) { try { wake.release(); } catch (e) { /* gone */ } } wake = null;
    closePc(); stopLocal(); queue = []; role = null; busy = false;
  }
  // The call is over: say why for a moment, then put the window away.
  function finish(tell, message) {
    if (!id) return;
    var was = id;
    if (tell && role) { var b = new URLSearchParams(); b.append('_csrf', csrf()); fetch('/call/dm/' + was + '/leave', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' }, body: b.toString() }).catch(function () {}); }
    cleanup(); id = null;
    win.classList.add('over'); win.classList.remove('min', 'ringing'); status(message || 'Call ended');
    document.body.classList.remove('on-call');
    closing = setTimeout(function () { win.hidden = true; }, message && message.length > 30 ? 6000 : 2200);
    if (window.__liveRefresh) setTimeout(window.__liveRefresh, 600);
  }

  function lineUp() {                                              // the person's own line to the site must be open: the other end's setup messages arrive on it
    return new Promise(function (resolve, reject) {
      var tries = 0, t = setInterval(function () {
        tries += 1;
        if (window.__dockOpen && window.__dockOpen()) { clearInterval(t); resolve(); }
        else if (tries > 32) { clearInterval(t); reject(new Error('The live connection is not up. Check your signal and try again.')); }
      }, 250);
    });
  }

  function begin(as, convo, how, who) {
    if (busy || id) { if (window.__dockNote) window.__dockNote('You are already on a call.'); return; }
    id = String(convo); name = who || 'Call'; mode = how === 'audio' ? 'audio' : 'video'; role = as; busy = true; facing = 'user';
    open();
    if (!supported) { finish(false, 'This browser cannot do calls. Use Safari on an iPhone or Chrome on Android.'); return; }
    status(as === 'host' ? 'Starting…' : 'Connecting…');
    var gotMedia = false;
    navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'audio' ? false : { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } }).then(function (stream) {
      gotMedia = true; local = stream; localEl.srcObject = stream; var lp = localEl.play(); if (lp && lp.catch) lp.catch(function () {});
      if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {});
      return lineUp();
    }).then(function () { return post('ice'); }).then(function (ice) {
      servers = ice.servers; makePc();
      return post(as === 'host' ? 'start' : 'join', { mode: mode });
    }).then(function () {
      if (as === 'host') { status('Calling…'); ringback(true); }
      beatTimer = setInterval(function () { post('beat').then(function (b) { if (!b.active) finish(false, 'Call ended'); }).catch(function () {}); }, 20000);
      var held = queue; queue = []; held.forEach(handle);
    }).catch(function (e) {
      var msg = !gotMedia && e && e.name ? mediaError(e) : (e && e.message) || 'Could not start the call.';
      var tell = Boolean(pc); finish(tell, msg);
    });
  }

  function sendDescription(kind) { return post('signal', { kind: kind, data: JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }) }); }
  function flush() { var list = pendingIce; pendingIce = []; list.forEach(function (c) { if (pc) pc.addIceCandidate(c).catch(function () {}); }); }
  function handle(m) {
    if (!pc) { queue.push(m); return; }
    if (m.type === 'joined') {
      if (role !== 'host') return;
      ringback(false); status('Connecting…'); makePc();
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { return sendDescription('offer'); }).catch(function () { status('Could not set up the call.'); });
    } else if (m.type === 'offer') {
      pc.setRemoteDescription(m.data).then(function () { remoteSet = true; flush(); return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); }).then(function () { return sendDescription('answer'); }).catch(function () { status('Could not set up the call.'); });
    } else if (m.type === 'answer') {
      pc.setRemoteDescription(m.data).then(function () { remoteSet = true; flush(); }).catch(function () {});
    } else if (m.type === 'candidate') {
      if (remoteSet) pc.addIceCandidate(m.data).catch(function () {}); else pendingIce.push(m.data);
    } else if (m.type === 'declined') finish(false, name + ' declined');
    else if (m.type === 'noanswer') finish(false, 'No answer');
    else if (m.type === 'bye') finish(true, 'Call ended');
  }
  window.addEventListener('pb-dsignal', function (e) { var d = e.detail || {}; if (id && role && d.key === 'dm:' + id) handle(d); });

  function toggle(btn, kind, on, off) {
    if (!local) return;
    var nowOff = btn.getAttribute('aria-pressed') !== 'true';
    (kind === 'audio' ? local.getAudioTracks() : local.getVideoTracks()).forEach(function (t) { t.enabled = !nowOff; });
    btn.setAttribute('aria-pressed', nowOff ? 'true' : 'false'); btn.title = nowOff ? on : off; btn.setAttribute('aria-label', btn.title);
  }
  function flip() {
    if (!local || mode === 'audio') return;
    var next = facing === 'user' ? 'environment' : 'user', old = local.getVideoTracks()[0];
    if (old) old.stop();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next } } }).then(function (s) {
      var track = s.getVideoTracks()[0];
      if (old) local.removeTrack(old);
      local.addTrack(track); facing = next;
      var sender = pc && pc.getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0];
      if (sender) sender.replaceTrack(track);
      localEl.srcObject = local;
    }).catch(function () {});
  }
  $('cw-mute').addEventListener('click', function () { toggle(this, 'audio', 'Unmute', 'Mute'); });
  $('cw-cam').addEventListener('click', function () { toggle(this, 'video', 'Camera on', 'Camera off'); });
  $('cw-flip').addEventListener('click', flip);
  $('cw-end').addEventListener('click', function () { if (id) finish(true, 'Call ended'); else win.hidden = true; });
  $('callwin-min').addEventListener('click', function (e) { e.stopPropagation(); win.classList.toggle('min'); });
  win.addEventListener('click', function (e) { if (win.classList.contains('min') && !e.target.closest('button')) win.classList.remove('min'); });

  // Buttons on a conversation page.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-dcall]');
    if (!b) return;
    e.preventDefault();
    var what = b.getAttribute('data-dcall'), convo = b.getAttribute('data-id');
    if (what === 'decline') {
      var body = new URLSearchParams(); body.append('_csrf', csrf());
      fetch('/call/dm/' + convo + '/decline', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' }, body: body.toString() }).catch(function () {});
    } else begin(what === 'join' ? 'guest' : 'host', convo, b.getAttribute('data-mode'), b.getAttribute('data-name'));
  });

  // Closing or reloading the page ends the call on our side.
  window.addEventListener('pagehide', function () {
    if (!id || !role || !navigator.sendBeacon) return;
    var body = new URLSearchParams(); body.append('_csrf', csrf());
    navigator.sendBeacon('/call/dm/' + id + '/leave', new Blob([body.toString()], { type: 'application/x-www-form-urlencoded' }));
  });
  window.addEventListener('beforeunload', function (e) { if (id && role) { e.preventDefault(); e.returnValue = ''; } });

  window.pbCall = {
    start: function (convo, how, who) { begin('host', convo, how, who); },
    answer: function (convo, how, who) { begin('guest', convo, how, who); },
    busy: function () { return Boolean(id); }
  };
})();
