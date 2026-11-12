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

  form.addEventListener('change', refresh);
  refresh();
})();
