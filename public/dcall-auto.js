// Arriving from Answer on the phone's alert: hand the call to the call window once it is ready.
(function () {
  'use strict';
  var el = document.querySelector('[data-dcall-auto]'); if (!el) return;
  var tries = 0, wait = setInterval(function () {
    tries += 1;
    if (tries > 40) { clearInterval(wait); return; }
    if (window.pbCall) { clearInterval(wait); el.removeAttribute('data-dcall-auto'); window.pbCall.answer(el.getAttribute('data-id'), el.getAttribute('data-mode'), el.getAttribute('data-name')); }
  }, 250);
})();
