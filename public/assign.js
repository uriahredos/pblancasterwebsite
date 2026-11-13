// Assign-a-task form: pick a whole group with one tap, or find people by typing instead of scrolling a long list.
(function () {
  var box = document.getElementById('assign-to');
  if (!box) return;
  var search = document.getElementById('person-search');
  var list = document.getElementById('person-list');
  var picked = document.getElementById('picked');
  var count = document.getElementById('assign-count');
  var rows = Array.prototype.slice.call(list.querySelectorAll('label.choice'));
  var groups = Array.prototype.slice.call(box.querySelectorAll('input[name="group"]'));
  search.hidden = false; picked.hidden = false;
  list.classList.add('searching');

  function refresh() {
    var q = search.value.trim().toLowerCase();
    var everyone = groups.some(function (g) { return g.value === 'all' && g.checked; });
    var chosenGroups = groups.filter(function (g) { return g.checked; }).map(function (g) { return g.value; });
    var total = 0, shown = 0;
    picked.textContent = '';
    rows.forEach(function (row) {
      var input = row.querySelector('input');
      var viaGroup = everyone || chosenGroups.indexOf(row.getAttribute('data-group')) >= 0;
      if (input.checked || viaGroup) total++;
      // Only show people who match what was typed; nobody is listed until something is typed.
      var match = q.length > 0 && row.getAttribute('data-name').indexOf(q) >= 0;
      row.hidden = !match;
      if (match) shown++;
      if (input.checked) {
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'chip picked-chip';
        chip.textContent = row.querySelector('span').firstChild.textContent.trim() + ' ×';
        chip.setAttribute('aria-label', 'Remove ' + row.querySelector('span').firstChild.textContent.trim());
        chip.addEventListener('click', function () { input.checked = false; refresh(); });
        picked.appendChild(chip);
      }
    });
    list.hidden = shown === 0;
    count.textContent = total === 0 ? 'Nobody chosen yet.'
      : 'This will give the task to ' + total + (total === 1 ? ' person.' : ' people, each with their own copy.') + (q && shown === 0 ? ' Nobody matches "' + search.value.trim() + '".' : '');
  }

  search.addEventListener('input', refresh);
  // Enter in the search box picks the only match rather than sending the form.
  search.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var visible = rows.filter(function (r) { return !r.hidden; });
    if (visible.length === 1) { visible[0].querySelector('input').checked = true; search.value = ''; refresh(); }
  });
  list.addEventListener('change', function (e) { if (e.target.checked) { search.value = ''; search.focus(); } refresh(); });
  groups.forEach(function (g) { g.addEventListener('change', refresh); });
  refresh();
})();
