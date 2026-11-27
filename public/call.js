// Video call in a tech-support thread: two phones, one picture each way, set up through the site and then connected
// directly (or through a relay when a network will not allow that). Nothing is recorded. The one who starts the call
// is usually the tech in the field, so the back camera is the default for them and the front camera for the one who joins.
(function () {
  'use strict';
  if (window.__callStop) window.__callStop();                 // this script runs again after a soft page change
  var root = document.querySelector('[data-call-root]');
  if (!root || !document.documentElement.hasAttribute('data-in')) return;
  var threadId = root.getAttribute('data-thread');
  var note = root.querySelector('[data-call-note]');
  var panel = root.querySelector('[data-call-panel]');
  var remoteEl = root.querySelector('[data-call-remote]');
  var localEl = root.querySelector('[data-call-local]');
  var statusEl = root.querySelector('[data-call-status]');
  var supported = Boolean(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  var pc = null, local = null, role = null, facing = 'user', servers = null, queue = [], pendingIce = [];
  var beatTimer = null, watchTimer = null, wake = null, active = false, remoteSet = false, ended = false;

  function say(text) { if (!note) return; note.textContent = text || ''; note.hidden = !text; }
  function status(text) { if (statusEl) statusEl.textContent = text || ''; }
  function csrf() { var m = document.querySelector('meta[name="csrf"]'); return m ? m.getAttribute('content') : ''; }

  function post(path, fields) {
    var body = new URLSearchParams(); body.append('_csrf', csrf());
    Object.keys(fields || {}).forEach(function (k) { body.append(k, fields[k]); });
    return fetch('/call/t/' + threadId + '/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', Accept: 'application/json' }, body: body.toString() })
      .then(function (res) {
        if (!/json/.test(res.headers.get('content-type') || '')) throw new Error('Sign in again to use video calls.');
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'That did not work.'); return j; });
      });
  }

  function mediaError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'The camera or microphone is blocked. On an iPhone, allow them for this site (the aA button in Safari, then Website Settings), and try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera or microphone was found on this device.';
    if (n === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
    return 'Could not start the camera or microphone.';
  }
  function getMedia(face) {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: { ideal: face }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  }

  function stopLocal() { if (local) { local.getTracks().forEach(function (t) { t.stop(); }); local = null; } }
  function closePc() { if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; try { pc.close(); } catch (e) { /* closed */ } pc = null; } remoteSet = false; pendingIce = []; if (remoteEl) remoteEl.srcObject = null; }

  function makePc() {
    closePc();
    pc = new RTCPeerConnection({ iceServers: servers });
    pc.onicecandidate = function (e) { if (e.candidate) post('signal', { kind: 'candidate', data: JSON.stringify(e.candidate.toJSON()) }).catch(function () {}); };
    pc.ontrack = function (e) {
      if (!remoteEl) return;
      if (e.streams && e.streams[0]) remoteEl.srcObject = e.streams[0];
      var p = remoteEl.play(); if (p && p.catch) p.catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if (!pc) return;
      var s = pc.connectionState;
      if (s === 'connected') status('Connected');
      else if (s === 'connecting') status('Connecting…');
      else if (s === 'disconnected') status('Connection lost. Trying to get it back…');
      else if (s === 'failed') status('The connection failed. This network may not allow video calls. End the call and try again from another network.');
    };
    local.getTracks().forEach(function (t) { pc.addTrack(t, local); });
  }

  function show(on) { panel.hidden = !on; active = on; window.__callActive = on; }

  function releaseWake() { if (wake && wake.release) { try { wake.release(); } catch (e) { /* gone */ } } wake = null; }
  function holdWake() { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {}); }

  function cleanup() {
    clearInterval(beatTimer); beatTimer = null; clearInterval(watchTimer); watchTimer = null; releaseWake();
    closePc(); stopLocal(); if (localEl) localEl.srcObject = null;
    queue = []; role = null; show(false);
  }

  function hangup(tell, message) {
    if (ended) return;
    ended = true;
    var p = tell ? post('leave').catch(function () {}) : Promise.resolve();
    cleanup();
    say(message || '');
    p.then(function () { ended = false; });
  }

  function begin(as) {
    if (active || !supported) return;
    if (!window.__liveOpen || !window.__liveOpen()) { say('The live connection is not up yet. Wait a moment and try again.'); return; }
    say(''); role = as; facing = as === 'host' ? 'environment' : 'user'; ended = false;
    getMedia(facing).then(function (stream) {
      local = stream;
      if (localEl) { localEl.srcObject = stream; var lp = localEl.play(); if (lp && lp.catch) lp.catch(function () {}); }
      show(true); status(as === 'host' ? 'Starting…' : 'Joining…');
      holdWake();
      // The site swaps pages without reloading, so leaving the thread (a menu link, the back button) does not close this
      // page. If the thread's page is gone from the screen, the call ends: the camera and microphone switch off and the other person is told.
      watchTimer = setInterval(function () {
        if (document.body.contains(root)) return;
        hangup(true);
        if (window.__callStop) window.__callStop();
      }, 500);
      return post('ice');
    }).then(function (ice) {
      servers = ice.servers; makePc();
      return post(as === 'host' ? 'start' : 'join');
    }).then(function () {
      status(as === 'host' ? 'Waiting for someone to join…' : 'Connecting…');
      beatTimer = setInterval(function () {
        post('beat').then(function (b) { if (!b.active) hangup(false, 'The call has ended.'); }).catch(function () {});
      }, 20000);
      var held = queue; queue = []; held.forEach(handle);     // anything that arrived while this was getting ready
    }).catch(function (e) {
      var wasMedia = !local;
      cleanup();
      say(wasMedia && e && e.name ? mediaError(e) : (e && e.message) || 'Could not start the call.');
    });
  }

  function sendDescription(kind) {
    return post('signal', { kind: kind, data: JSON.stringify({ type: pc.localDescription.type, sdp: pc.localDescription.sdp }) });
  }
  function flush() { var list = pendingIce; pendingIce = []; list.forEach(function (c) { if (pc) pc.addIceCandidate(c).catch(function () {}); }); }

  // A setup message from the other phone.
  function handle(m) {
    if (!pc) { queue.push(m); return; }
    if (m.type === 'joined') {                                    // we started the call and someone arrived: we make the offer
      if (role !== 'host') return;
      status((m.name || 'Someone') + ' joined. Connecting…');
      makePc();
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { return sendDescription('offer'); }).catch(function () { status('Could not set up the call. End it and try again.'); });
    } else if (m.type === 'offer') {
      pc.setRemoteDescription(m.data).then(function () { remoteSet = true; flush(); return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); }).then(function () { return sendDescription('answer'); })
        .catch(function () { status('Could not set up the call. End it and try again.'); });
    } else if (m.type === 'answer') {
      pc.setRemoteDescription(m.data).then(function () { remoteSet = true; flush(); }).catch(function () {});
    } else if (m.type === 'candidate') {
      if (remoteSet) pc.addIceCandidate(m.data).catch(function () {}); else pendingIce.push(m.data);
    } else if (m.type === 'bye') {
      if (role === 'host') { makePc(); status('They left. Waiting for someone to join…'); }
      else hangup(false, 'The call has ended.');
    }
  }

  function onSignal(e) { if (active || role) handle(e.detail || {}); }
  window.addEventListener('portal-signal', onSignal);

  function flip() {
    if (!local) return;
    var next = facing === 'user' ? 'environment' : 'user';
    var old = local.getVideoTracks()[0];
    if (old) old.stop();                                          // some phones will not open a second camera while the first runs
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next } } }).then(function (s) {
      var track = s.getVideoTracks()[0];
      if (old) local.removeTrack(old);
      local.addTrack(track);
      facing = next;
      var sender = pc && pc.getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0];
      if (sender) sender.replaceTrack(track);
      if (localEl) localEl.srcObject = local;
    }).catch(function (e) { say(mediaError(e)); });
  }

  function toggle(btn, kind, on, off) {
    if (!local) return;
    var tracks = kind === 'audio' ? local.getAudioTracks() : local.getVideoTracks();
    var nowOff = btn.getAttribute('aria-pressed') !== 'true';
    tracks.forEach(function (t) { t.enabled = !nowOff; });
    btn.setAttribute('aria-pressed', nowOff ? 'true' : 'false');
    btn.textContent = nowOff ? on : off;
  }

  function onClick(e) {
    var t = e.target.closest && e.target.closest('[data-call-start],[data-call-join],[data-call-end],[data-call-flip],[data-call-mute],[data-call-camera]');
    if (!t || !root.contains(t)) return;
    if (t.hasAttribute('data-call-start')) begin('host');
    else if (t.hasAttribute('data-call-join')) begin('guest');
    else if (t.hasAttribute('data-call-end')) hangup(true, 'You left the call.');
    else if (t.hasAttribute('data-call-flip')) flip();
    else if (t.hasAttribute('data-call-mute')) toggle(t, 'audio', 'Unmute', 'Mute');
    else if (t.hasAttribute('data-call-camera')) toggle(t, 'video', 'Camera on', 'Camera off');
  }
  root.addEventListener('click', onClick);

  document.addEventListener('visibilitychange', function () { if (!document.hidden && active && !wake) holdWake(); });
  function onHide() {
    if (!role || !navigator.sendBeacon) return;                   // closing the page ends the call on our side
    var body = new URLSearchParams(); body.append('_csrf', csrf());
    navigator.sendBeacon('/call/t/' + threadId + '/leave', new Blob([body.toString()], { type: 'application/x-www-form-urlencoded' }));
  }
  window.addEventListener('pagehide', onHide);

  if (!supported) {
    var btns = root.querySelectorAll('[data-call-start],[data-call-join]');
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    say('This browser cannot do video calls. Use Safari on an iPhone or Chrome on Android.');
  }

  window.__callStop = function () {
    window.removeEventListener('portal-signal', onSignal); window.removeEventListener('pagehide', onHide); root.removeEventListener('click', onClick);
    if (role) hangup(true); window.__callStop = null;
  };
})();
