// Positions page: filter the table as you type, and count the rows that have been changed.
(function () {
  var find = document.getElementById('pos-find'); var form = document.getElementById('pos-form'); var count = document.getElementById('pos-count');
  if (!form) return;
  var rows = Array.prototype.slice.call(form.querySelectorAll('tbody tr'));
  var inputs = Array.prototype.slice.call(form.querySelectorAll('tbody input, tbody select'));
  inputs.forEach(function (i) { i.setAttribute('data-was', i.value); });
  function tally() {
    var n = 0;
    rows.forEach(function (r) {
      var changed = Array.prototype.some.call(r.querySelectorAll('input, select'), function (i) { return i.value.trim() !== i.getAttribute('data-was').trim(); });
      r.classList.toggle('changed', changed); if (changed) n += 1;
    });
    count.textContent = n ? n + (n === 1 ? ' person changed' : ' people changed') + ', not saved yet' : 'No changes yet';
  }
  form.addEventListener('input', tally); form.addEventListener('change', tally);
  if (find) find.addEventListener('input', function () {
    var q = find.value.trim().toLowerCase();
    rows.forEach(function (r) {
      var text = r.cells[0].textContent.toLowerCase() + ' ' + Array.prototype.map.call(r.querySelectorAll('input'), function (i) { return i.value.toLowerCase(); }).join(' ') + ' ' + Array.prototype.map.call(r.querySelectorAll('select'), function (x) { return x.value ? x.options[x.selectedIndex].text.toLowerCase() : ''; }).join(' ');
      r.hidden = Boolean(q) && text.indexOf(q) === -1 && !r.classList.contains('changed');
    });
  });
  var focus = form.querySelector('tr.focus'); if (focus) focus.scrollIntoView({ block: 'center' });
})();
