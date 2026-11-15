// My tasks: a new task is folded shut. Opening it tells the site it has been seen, so it stops counting on the bell.
(function () {
  function token() { return (document.querySelector('meta[name="csrf"]') || {}).content || ''; }
  function seen(fold) {
    if (fold.getAttribute('data-seen')) return;
    fold.setAttribute('data-seen', '1');
    var card = fold.closest('.task');
    var tag = card && card.querySelector('.rec-head .tag.new'); if (tag) tag.remove();
    var hint = fold.querySelector('.fold-hint'); if (hint) hint.remove();
    fetch('/tasks/' + fold.getAttribute('data-task') + '/seen', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' }, body: '_csrf=' + encodeURIComponent(token()) })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (html) { if (html && window.portalSync) window.portalSync(html); })
      .catch(function () { fold.removeAttribute('data-seen'); });
  }
  // One listener for the whole page, added once however many times this file runs.
  if (!window.tasksBound) {
    window.tasksBound = true;
    document.addEventListener('toggle', function (e) {
      var fold = e.target;
      if (fold && fold.matches && fold.matches('details.task-fold[data-task]') && fold.open && fold.querySelector('.fold-hint')) seen(fold);
    }, true);
  }
  // Arriving from the bell (/tasks#t12): open that task.
  var target = location.hash && document.querySelector(location.hash.replace(/[^#\w-]/g, '') + ' details.task-fold');
  if (target && !target.open) { target.open = true; }
})();
