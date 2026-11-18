// Users page: narrow the list as you type, and by account state. Nothing is sent to the server.
(function () {
  var find = document.getElementById('users-find'), state = document.getElementById('users-state'), table = document.getElementById('users-table'), count = document.getElementById('users-count');
  if (!find || !table || find.dataset.ready) return;
  find.dataset.ready = '1';
  function apply() {
    var words = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean), want = state.value, shown = 0;
    Array.prototype.forEach.call(table.tBodies[0].rows, function (tr) {
      var text = tr.textContent.toLowerCase(), st = (tr.querySelector('[data-state]') || {}).textContent || '';
      var ok = words.every(function (w) { return text.indexOf(w) !== -1; }) && (!want || st.trim() === want);
      tr.hidden = !ok; if (ok) shown++;
    });
    var total = Number(count.getAttribute('data-total'));
    count.textContent = shown === total ? total + (total === 1 ? ' person' : ' people') : shown + ' of ' + total + ' shown';
  }
  find.addEventListener('input', apply); state.addEventListener('change', apply);
})();
