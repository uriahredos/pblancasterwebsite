// Send sign-in details: filter the list of people, copy a message, and mark the ones already opened in Teams.
(function () {
  var find = document.getElementById('invite-find');
  if (find && !find.dataset.ready) {
    find.dataset.ready = '1';
    find.addEventListener('input', function () {
      var q = find.value.trim().toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll('.invite-pick li'), function (li) { li.hidden = Boolean(q) && li.textContent.toLowerCase().indexOf(q) === -1; });
    });
  }
  // Tick everyone with an email, only those not emailed yet, or nobody; and say how many are ticked.
  var form = document.getElementById('invite-form');
  if (form && !form.dataset.ready) {
    form.dataset.ready = '1';
    var boxes = function () { return Array.prototype.slice.call(form.querySelectorAll('input[name=who]')); };
    var count = function () {
      var n = boxes().filter(function (b) { return b.checked; }).length, out = document.getElementById('invite-count');
      if (out) out.textContent = n ? n + ' ticked' : '';
    };
    form.addEventListener('change', count);
    Array.prototype.forEach.call(form.querySelectorAll('[data-tick]'), function (btn) {
      btn.addEventListener('click', function () {
        var how = btn.getAttribute('data-tick');
        boxes().forEach(function (b) {
          b.checked = how === 'none' ? false : b.dataset.email === '1' && (how === 'email' || b.dataset.sent !== '1');
        });
        count();
      });
    });
    count();
  }
  // While sign-in details are being emailed, the page brings itself up to date.
  if (document.querySelector('[data-sending]') && !window.inviteWatch) {
    window.inviteWatch = setTimeout(function () { window.inviteWatch = null; if (document.querySelector('[data-sending]') && !document.querySelector('input[name=who]:checked')) location.reload(); }, 5000);
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-invite]'), function (card) {
    if (card.dataset.ready) return; card.dataset.ready = '1';
    var mark = function () { var t = card.querySelector('[data-sent]'); if (t) t.hidden = false; card.classList.add('invite-done'); };
    var link = card.querySelector('[data-mark]'); if (link) link.addEventListener('click', mark);
    var copy = card.querySelector('[data-copy]');
    if (copy) copy.addEventListener('click', function () {
      var text = card.querySelector('[data-text]').textContent;
      var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy message'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
      else { var r = document.createRange(); r.selectNodeContents(card.querySelector('[data-text]')); var s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch (e) {} }
    });
  });
})();
