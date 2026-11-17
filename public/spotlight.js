// The banner on the home page: one slide at a time, moving on every few seconds. Swipe or use the dots to
// move yourself; it waits while you are touching or pointing at it, and does not move on its own for people
// who have asked their device for less motion.
(function () {
  var track = document.getElementById('spot-track'); var dots = document.getElementById('spot-dots'); var pause = document.getElementById('spot-pause');
  if (!track || !dots) return;
  if (window.spotTimer) clearInterval(window.spotTimer);
  var tabs = Array.prototype.slice.call(dots.querySelectorAll('button[data-slide]'));
  var count = tabs.length; var at = 0; var held = false; var stopped = false;
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function mark(n) { at = n; tabs.forEach(function (t, i) { t.setAttribute('aria-selected', i === n ? 'true' : 'false'); }); }
  function go(n, smooth) {
    n = (n + count) % count;
    track.scrollTo({ left: track.clientWidth * n, behavior: smooth && !calm ? 'smooth' : 'auto' });
    mark(n);
  }
  tabs.forEach(function (t, i) { t.addEventListener('click', function () { go(i, true); }); });
  // Swiping moves the track by itself; keep the dots in step with where it comes to rest.
  var settle;
  track.addEventListener('scroll', function () { clearTimeout(settle); settle = setTimeout(function () { if (track.clientWidth) mark(Math.round(track.scrollLeft / track.clientWidth)); }, 120); }, { passive: true });
  track.addEventListener('keydown', function (e) { if (e.key === 'ArrowRight') { go(at + 1, true); e.preventDefault(); } else if (e.key === 'ArrowLeft') { go(at - 1, true); e.preventDefault(); } });
  ['pointerenter', 'touchstart', 'focusin'].forEach(function (n) { track.addEventListener(n, function () { held = true; }, { passive: true }); });
  ['pointerleave', 'touchend', 'focusout'].forEach(function (n) { track.addEventListener(n, function () { held = false; }, { passive: true }); });
  if (pause) {
    if (calm) { stopped = true; pause.hidden = true; }
    pause.addEventListener('click', function () { stopped = !stopped; pause.setAttribute('aria-pressed', stopped ? 'true' : 'false'); pause.textContent = stopped ? 'Play' : 'Pause'; pause.title = stopped ? 'Play' : 'Pause'; });
  }
  window.spotTimer = setInterval(function () {
    if (!document.body.contains(track)) { clearInterval(window.spotTimer); return; }
    if (stopped || held || document.hidden || count < 2) return;
    go(at + 1, true);
  }, 6000);
})();
