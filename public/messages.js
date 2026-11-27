// A private conversation: open at the newest message, send without leaving the page, and keep the box ready for the next one.
(function () {
  'use strict';
  var form = document.querySelector('[data-dm-send]');
  if (!form || !window.fetch || !document.documentElement.hasAttribute('data-in')) return;
  var box = form.querySelector('textarea');
  var busy = false;
  var errorEl = document.querySelector('[data-dm-error]');
  function problem(text) { if (errorEl) { errorEl.textContent = text || ''; errorEl.hidden = !text; } }
  var end = document.getElementById('end');
  function toBottom() { if (end && end.scrollIntoView) end.scrollIntoView({ block: 'end' }); }
  if (!/#m\d+/.test(location.hash)) toBottom();

  function send() {
    var text = box.value.trim();
    if (!text || busy) return;
    busy = true; problem('');
    var body = new URLSearchParams();
    body.append('_csrf', form.querySelector('input[name=_csrf]').value);
    body.append('body', text);
    fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', Accept: 'application/json' }, body: body.toString() })
      .then(function (res) {
        if (!/json/.test(res.headers.get('content-type') || '')) { location.reload(); return null; }       // signed out or locked: the page sorts it out
        return res.json().then(function (j) { if (!res.ok) throw new Error(j.error || 'Could not send.'); return j; });
      })
      .then(function (j) {
        if (!j) return;
        box.value = '';
        if (window.__liveRefresh) window.__liveRefresh();
        setTimeout(toBottom, 400);
      })
      .catch(function (e) { problem(e && e.message ? e.message : 'Could not send. Try again.'); })
      .then(function () { busy = false; box.focus(); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
  // Return sends; Shift+Return adds a line. On a phone the Send button is what you use.
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia && window.matchMedia('(hover: hover)').matches) { e.preventDefault(); send(); }
  });
})();
