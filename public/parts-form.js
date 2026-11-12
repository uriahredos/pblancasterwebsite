// Parts form: show the fields that fit the chosen action, and add/remove part rows.
(function () {
  var form = document.getElementById('parts-form');
  if (!form) return;
  var items = document.getElementById('items');
  var addBtn = document.getElementById('add-row');
  var MAX_ROWS = 40;

  function checked(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  function toggle(attr, value) {
    form.querySelectorAll('[' + attr + ']').forEach(function (el) {
      var show = el.getAttribute(attr) === value;
      el.hidden = !show;
      el.querySelectorAll('input, textarea, select').forEach(function (input) { input.disabled = !show; });
    });
  }

  function refresh() {
    toggle('data-show-action', checked('action'));
    toggle('data-show-source', checked('source'));
    var needed = form.querySelector('input[name="needed_by"]');
    needed.required = checked('action') === 'request';
    form.querySelector('input[name="job_number"]').required = checked('source') === 'job';
    var rows = items.querySelectorAll('.item-row');
    rows.forEach(function (row, i) {
      row.querySelector('.remove-row').hidden = rows.length === 1;
      row.querySelector('input[name="part_name"]').required = i === 0;
    });
    addBtn.hidden = rows.length >= MAX_ROWS;
  }

  addBtn.addEventListener('click', function () {
    var row = items.querySelector('.item-row').cloneNode(true);
    row.querySelectorAll('input').forEach(function (input) { input.value = ''; });
    row.querySelectorAll('.suggest').forEach(function (ul) { ul.remove(); });
    row.querySelectorAll('label > span').forEach(function (span) { span.className = 'sr'; });
    items.appendChild(row);
    refresh();
    row.querySelector('input').focus();
  });

  items.addEventListener('click', function (e) {
    var btn = e.target.closest('.remove-row');
    if (!btn) return;
    btn.closest('.item-row').remove();
    var first = items.querySelector('.item-row');
    first.querySelectorAll('label > span').forEach(function (span) { span.className = 'mini'; });
    refresh();
  });

  // Suggestions from the parts catalog while typing a part.
  var suggestTimer;
  function closeSuggest() { items.querySelectorAll('.suggest').forEach(function (ul) { ul.remove(); }); }
  function showSuggest(input, list) {
    closeSuggest();
    if (!list.length || document.activeElement !== input) return;
    var ul = document.createElement('ul');
    ul.className = 'suggest';
    list.forEach(function (p) {
      var li = document.createElement('li');
      var b = document.createElement('strong'); b.textContent = p.n; li.appendChild(b);
      if (p.d) { var d = document.createElement('span'); d.textContent = p.d; li.appendChild(d); }
      li.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        input.value = p.n;
        closeSuggest();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        var qty = input.closest('.item-row').querySelector('input[name="quantity"]');
        if (qty && !qty.value) qty.focus();
      });
      ul.appendChild(li);
    });
    input.closest('.suggest-wrap').appendChild(ul);
  }
  items.addEventListener('input', function (e) {
    var input = e.target;
    if (input.name !== 'part_name' || !e.isTrusted) return;
    clearTimeout(suggestTimer);
    var q = input.value.trim();
    if (q.length < 2) return closeSuggest();
    suggestTimer = setTimeout(function () {
      fetch('/parts/suggest?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (list) { if (input.value.trim() === q) showSuggest(input, list); })
        .catch(function () {});
    }, 200);
  });
  items.addEventListener('focusout', function () { setTimeout(closeSuggest, 150); });

  form.addEventListener('change', refresh);
  refresh();
})();
