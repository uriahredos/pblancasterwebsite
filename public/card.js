// On every page: the small card that opens from a person's name, and the note that shows when an alert arrives while the
// site is open. Loaded once; it stays put while pages change under it.
(function () {
  'use strict';
  if (window.__card || !document.documentElement.hasAttribute('data-in')) return;
  window.__card = true;
  var card = document.getElementById('pcard');
  function getHtml(url) {
    return fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', 'X-Live': '1' } })
      .then(function (res) { if (!res.ok || res.redirected) throw new Error('gone'); return res.text(); });
  }
  // Go to a page the way a tapped link would, so the site's own quick page change is used when it can be.
  function go(url) {
    var a = document.createElement('a'); a.href = url; a.setAttribute('data-no-card', ''); a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
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
    if (!a || a.hasAttribute('data-no-card') || a.closest('[data-no-card], #pcard, .tabbar, .row-menu-list, .nav-account') || a.target === '_blank') return null;
    var m = /^\/people\/(\d+)$/.exec(a.getAttribute('href') || '');
    return m ? { a: a, id: m[1] } : null;
  }
  if (card) {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
        var who = personLink(t);
        if (who) { e.preventDefault(); e.stopPropagation(); openCard(who.id, who.a); return; }
      }
      if (!card.hidden && (!card.contains(t) || t.closest('a'))) closeCard();      // a tap elsewhere, or a link inside the card that has done its job
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCard(); });
    window.addEventListener('resize', closeCard);
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
})();
