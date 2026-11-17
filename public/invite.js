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
