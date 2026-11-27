// On every page: the round button that opens a quick list of people to message or call, the small card that opens from a
// person's name, and the screen that shows when someone is calling. Loaded once; it stays put while pages change under it.
(function () {
  'use strict';
  if (window.__dock || !document.documentElement.hasAttribute('data-in')) return;
  window.__dock = true;
  var dock = document.getElementById('dock');                  // only for people who have messages
  var card = document.getElementById('pcard');
  function csrf() { var m = document.querySelector('meta[name="csrf"]'); return m ? m.getAttribute('content') : ''; }
  function post(url) {
    var body = new URLSearchParams(); body.append('_csrf', csrf());
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', 'X-Live': '1', Accept: 'application/json' }, body: body.toString() })
      .then(function (res) { if (!/json/.test(res.headers.get('content-type') || '')) throw new Error('Sign in again.'); return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'That did not work.'); return j; }); });
  }
  function getHtml(url) {
    return fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', 'X-Live': '1' } })
      .then(function (res) { if (!res.ok || res.redirected) throw new Error('gone'); return res.text(); });
  }
  // Go to a page the way a tapped link would, so the site's own quick page change is used when it can be.
  function go(url) {
    var a = document.createElement('a'); a.href = url; a.setAttribute('data-no-card', ''); a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function leaveNote(id, as, mode) { try { sessionStorage.setItem('pbCall', JSON.stringify({ base: '/call/dm/' + id, as: as, mode: mode, at: Date.now() })); } catch (e) { /* the page's own buttons still work */ } }

  // ---- Calling someone from anywhere: find (or make) the conversation, then open it with the call starting -----------
  function callPerson(userId, mode, btn) {
    if (btn) btn.disabled = true;
    post('/messages/open/' + userId).then(function (j) {
      closeCard(); closeDock();
      leaveNote(j.id, 'host', mode);
      go('/messages/c/' + j.id);
    }).catch(function (e) { window.alert ? note(e.message) : 0; }).then(function () { if (btn) btn.disabled = false; });
  }
  function note(text) {
    var p = document.createElement('p'); p.className = 'dock-toast'; p.setAttribute('role', 'alert'); p.textContent = text;
    document.body.appendChild(p); setTimeout(function () { p.remove(); }, 5000);
  }

  // ---- The card that opens from a person's name --------------------------------------------------------------------
  var cardFor = null;
  function closeCard() { if (card && !card.hidden) { card.hidden = true; card.innerHTML = ''; cardFor = null; } }
  function place(anchor) {
    var r = anchor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    if (vw < 560) { card.classList.add('sheet'); card.style.left = card.style.top = ''; return; }      // a phone: it rises from the bottom
    card.classList.remove('sheet');
    var left = Math.min(Math.max(8, r.left), vw - w - 8);
    var top = r.bottom + 6 + h > vh - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : r.bottom + 6;
    card.style.left = (left + window.scrollX) + 'px'; card.style.top = (top + window.scrollY) + 'px';
  }
  function openCard(id, anchor) {
    if (cardFor === anchor) { closeCard(); return; }
    getHtml('/people/' + id + '/card').then(function (html) {
      card.innerHTML = html; card.hidden = false; cardFor = anchor; place(anchor);
      var first = card.querySelector('a, button'); if (first && first.focus) first.focus({ preventScroll: true });
    }).catch(function () { go(anchor.getAttribute('href')); });
  }
  function personLink(el) {
    var a = el && el.closest ? el.closest('a[href]') : null;
    if (!a || a.hasAttribute('data-no-card') || a.closest('[data-no-card], #pcard, #dock, .tabbar, .row-menu-list, .nav-account') || a.target === '_blank') return null;
    var m = /^\/people\/(\d+)$/.exec(a.getAttribute('href') || '');
    return m ? { a: a, id: m[1] } : null;
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    var callBtn = t.closest && t.closest('[data-call-person]');
    if (callBtn) { e.preventDefault(); e.stopPropagation(); callPerson(callBtn.getAttribute('data-call-person'), callBtn.getAttribute('data-mode') === 'audio' ? 'audio' : 'video', callBtn); return; }
    var fav = t.closest && t.closest('[data-fav]');
    if (fav) {
      e.preventDefault();
      post('/messages/favorite/' + fav.getAttribute('data-fav')).then(function (j) { fav.setAttribute('aria-pressed', j.on ? 'true' : 'false'); if (dock && !panel.hidden) load(); }).catch(function () {});
      return;
    }
    if (card && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      var who = personLink(t);
      if (who) { e.preventDefault(); e.stopPropagation(); openCard(who.id, who.a); return; }
    }
    if (card && !card.hidden && !card.contains(t)) closeCard();
    else if (card && !card.hidden && t.closest('a')) closeCard();          // a link inside the card: it has done its job
    if (dock && !panel.hidden && !dock.contains(t)) closeDock();
    else if (dock && t.closest && t.closest('[data-dock-close], .dock-who')) closeDock();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeCard(); if (dock && !panel.hidden) { closeDock(); btn.focus(); } } });
  window.addEventListener('resize', closeCard);

  // ---- The quick list -------------------------------------------------------------------------------------------
  var btn = document.getElementById('dock-btn'), panel = document.getElementById('dock-panel'), body = document.getElementById('dock-body');
  var q = document.getElementById('dock-q'), count = document.getElementById('dock-count'), typing = null, asked = 0;
  function closeDock() { if (!dock || panel.hidden) return; panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  function load() {
    var mine = ++asked;
    getHtml('/messages/dock' + (q.value.trim() ? '?q=' + encodeURIComponent(q.value.trim()) : '')).then(function (html) { if (mine === asked) body.innerHTML = html; })
      .catch(function () { if (mine === asked) body.innerHTML = '<p class="empty">Could not load. Try again.</p>'; });
  }
  function setCount(n) {
    if (!count) return;
    count.textContent = n > 99 ? '99+' : String(n); count.hidden = !n;
  }
  function recount() { fetch('/messages/unread', { credentials: 'same-origin', headers: { 'X-Live': '1' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j) setCount(j.n); }).catch(function () {}); }
  if (dock) {
    btn.addEventListener('click', function () {
      var open = panel.hidden;
      panel.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { load(); if (window.matchMedia && window.matchMedia('(hover: hover)').matches) q.focus(); }
    });
    q.addEventListener('input', function () { clearTimeout(typing); typing = setTimeout(load, 250); });
  }

  // ---- Someone is calling ----------------------------------------------------------------------------------------
  var ring = document.getElementById('ring'), ringing = null, tone = null, toneTimer = null;
  // A ringtone: a rising run of notes, then a pause, over and over until the call is dealt with.
  function startTone() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || tone) return;
    try {
      tone = new AC();
      var phrase = function () {
        if (!tone) return;
        var base = tone.currentTime;
        [0, 1.1].forEach(function (rep) {
          [[659, 0], [784, 0.16], [988, 0.32], [784, 0.48], [988, 0.64]].forEach(function (n) {
            var o = tone.createOscillator(), g = tone.createGain(), t0 = base + rep + n[1];
            o.type = 'triangle'; o.frequency.value = n[0]; o.connect(g); g.connect(tone.destination);
            g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
            o.start(t0); o.stop(t0 + 0.22);
          });
        });
        if (navigator.vibrate) { try { navigator.vibrate([500, 250, 500, 250, 500]); } catch (e) { /* not allowed */ } }
      };
      phrase(); toneTimer = setInterval(phrase, 3500);
    } catch (e) { tone = null; }
  }
  function stopTone() { clearInterval(toneTimer); toneTimer = null; if (tone) { try { tone.close(); } catch (e) { /* closed */ } tone = null; } }
  var realTitle = null, titleTimer = null;
  function flashTitle(text) {
    clearInterval(titleTimer); titleTimer = null;
    if (realTitle !== null) { document.title = realTitle; realTitle = null; }
    if (!text) return;
    realTitle = document.title; var on = false;
    titleTimer = setInterval(function () { on = !on; document.title = on ? text : realTitle; }, 900);
  }
  function hideRing() { if (!ring) return; ringing = null; ring.hidden = true; stopTone(); flashTitle(''); if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) { /* not allowed */ } } }
  function showRing(c) {
    if (!ring || !c || !c.id) return;
    // Already looking at that conversation: its own Answer button is right there.
    if (document.querySelector('[data-call-base="/call/dm/' + c.id + '"]')) { if (window.__liveRefresh) window.__liveRefresh(); return; }
    ringing = c;
    document.getElementById('ring-what').textContent = c.mode === 'audio' ? 'Incoming voice call' : 'Incoming video call';
    document.getElementById('ring-who').textContent = c.from || 'Someone';
    var face = document.getElementById('ring-face'); if (face) face.textContent = String(c.from || '?').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
    ring.hidden = false; startTone(); flashTitle('📞 ' + (c.from || 'Someone') + ' is calling');
  }
  if (ring) {
    document.getElementById('ring-yes').addEventListener('click', function () {
      var c = ringing; hideRing(); if (!c) return;
      leaveNote(c.id, 'guest', c.mode); go('/messages/c/' + c.id);
    });
    document.getElementById('ring-no').addEventListener('click', function () {
      var c = ringing; hideRing(); if (c) post('/call/dm/' + c.id + '/decline').catch(function () {});
    });
  }
  function askRinging() {
    if (!ring) return;
    fetch('/call/ringing', { credentials: 'same-origin', headers: { 'X-Live': '1' } }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.calls && j.calls[0]) showRing(j.calls[0]); else if (j) hideRing(); }).catch(function () {});
  }

  // ---- An alert that arrives while the site is open: said here, on the page, instead of as a phone notification -------
  function chime() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      var ctx = new AC(), t0 = ctx.currentTime;
      [[880, 0], [1175, 0.16]].forEach(function (n) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = n[0]; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t0 + n[1]); g.gain.exponentialRampToValueAtTime(0.2, t0 + n[1] + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + 0.3);
        o.start(t0 + n[1]); o.stop(t0 + n[1] + 0.32);
      });
      setTimeout(function () { try { ctx.close(); } catch (e) { /* closed */ } }, 900);
    } catch (e) { /* no sound on this device */ }
  }
  var toast = null, toastTimer = null;
  function inApp(d) {
    if (d.ring) return;                                            // a call has its own ringing screen
    var here = location.pathname + location.search, there = d.url || '/';
    if (!d.quiet) { chime(); if (navigator.vibrate) { try { navigator.vibrate([150, 80, 150]); } catch (e) { /* not allowed */ } } }
    if (there === here || there === location.pathname) return;     // already looking at it: the page shows the news itself
    if (toast) toast.remove();
    toast = document.createElement('a'); toast.className = 'in-toast'; toast.href = there; toast.setAttribute('role', 'status'); toast.setAttribute('data-no-card', '');
    var strong = document.createElement('strong'); strong.textContent = d.title || 'PB Portal'; toast.appendChild(strong);
    if (d.body) { var span = document.createElement('span'); span.textContent = d.body; toast.appendChild(span); }
    toast.addEventListener('click', function () { if (toast) { var t = toast; toast = null; setTimeout(function () { t.remove(); }, 0); } });
    document.body.appendChild(toast);
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { if (toast) { toast.remove(); toast = null; } }, 7000);
  }
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'pb-push') inApp(e.data); });

  // ---- One quiet line to the site for this person's own news: a new message, a call ringing, a call given up -------
  var es = null, retry = null;
  function listen() {
    if (!dock || !window.EventSource || es) return;
    es = new EventSource('/live/stream?topics=inbox:' + dock.getAttribute('data-me'));
    es.addEventListener('open', function () { askRinging(); recount(); });
    es.addEventListener('update', function () { setTimeout(recount, 1500); if (!panel.hidden && !q.value.trim()) load(); });   // a moment later: an open conversation marks it read first
    es.addEventListener('ring', function (e) { try { showRing(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
    es.addEventListener('ringend', function (e) { try { var d = JSON.parse(e.data); if (ringing && 'dm:' + ringing.id === d.key) hideRing(); } catch (x) { /* ignore */ } });
    es.addEventListener('bye', function () { es.close(); es = null; hideRing(); });             // signed out or locked
    es.onerror = function () {
      if (es && es.readyState === 2) { es = null; clearTimeout(retry); retry = setTimeout(listen, 30000); }
    };
  }
  listen();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { if (!es) listen(); else { askRinging(); recount(); } } });
})();
