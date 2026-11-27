// The count sheet. A scanned barcode opens a small panel: the part it is, how many, save, and the camera is ready
// for the next one. A barcode nobody has matched yet asks which part it is, once, and is remembered. Something
// nobody can name is photographed with how many there are.
(function () {
  var form = document.getElementById('count-form');
  if (!form) return;
  var $ = function (id) { return document.getElementById(id); };
  var panel = $('scan-result'), view = $('scan-view'), msg = $('scan-msg'), title = $('scan-title');
  var what = $('scan-what'), partRow = $('scan-part-row'), part = $('scan-part'), qty = $('scan-qty'), error = $('scan-error');
  var wrong = $('scan-wrong'), photoRow = $('scan-photo-row'), photo = $('scan-photo');
  var now = null;   // the scan being dealt with: { code, ctl }
  var token = function () { return form.querySelector('input[name="_csrf"]').value; };
  var rowFor = function (number) {
    var wanted = String(number || '').trim().toUpperCase();
    return Array.prototype.filter.call(form.querySelectorAll('tr[data-part]'), function (tr) { return tr.getAttribute('data-part') === wanted; })[0];
  };
  // Put a saved count on the sheet underneath: into its row, or a new row for a part that was not listed.
  function onSheet(d) {
    var row = rowFor(d.part_number);
    if (!row) {
      var body = form.querySelector('tbody'), empty = body.querySelector('td.empty');
      if (empty) body.removeChild(empty.parentNode);
      row = document.createElement('tr'); row.setAttribute('data-part', d.part_number.toUpperCase());
      var a = document.createElement('td'), label = document.createElement('label'), strong = document.createElement('strong'), hint = document.createElement('span');
      label.htmlFor = 'q' + d.id; strong.textContent = d.part_number; hint.className = 'hint'; hint.textContent = d.description || '';
      label.appendChild(strong); label.appendChild(document.createElement('br')); label.appendChild(hint); a.appendChild(label);
      var b = document.createElement('td'), box = document.createElement('input');
      b.className = 'num'; box.className = 'count-box'; box.id = 'q' + d.id; box.name = 'qty_' + d.id; box.setAttribute('inputmode', 'numeric'); box.maxLength = 6; box.autocomplete = 'off';
      b.appendChild(box); row.appendChild(a); row.appendChild(b); body.insertBefore(row, body.firstChild);
    }
    row.querySelector('input').value = d.counted;
  }
  function fail(text) { error.textContent = text; error.hidden = false; }
  function done(text) {
    panel.hidden = true; view.hidden = false; title.hidden = false; error.hidden = true; photo.value = ''; photoRow.open = false;
    msg.textContent = text + ' Scan the next one.';
    var ctl = now && now.ctl; now = null;
    if (ctl) ctl.next();
  }
  function show(code, d) {
    var isNumber = d.found && d.part_number.toUpperCase() === code.toUpperCase();
    what.textContent = '';
    var strong = document.createElement('strong'); strong.textContent = d.found ? d.part_number : 'New barcode: ' + code; what.appendChild(strong);
    if (d.found && d.description) { what.appendChild(document.createTextNode(' ')); var s = document.createElement('span'); s.className = 'hint'; s.textContent = d.description; what.appendChild(s); }
    partRow.hidden = d.found; photoRow.hidden = d.found; wrong.hidden = !d.found || isNumber;
    part.value = ''; qty.value = d.found && d.counted !== null && d.counted !== undefined ? d.counted : '';
    error.hidden = true; view.hidden = true; title.hidden = true; panel.hidden = false;
    msg.textContent = d.found ? (qty.value !== '' ? 'Counted before: change the number if there are more.' : '') : 'This barcode has not been matched to a part yet.';
    (d.found ? qty : part).focus(); if (d.found) qty.select();
  }
  function send(url, body) {
    return fetch(form.action + url, { method: 'POST', credentials: 'same-origin', body: body }).then(function (r) {
      return r.json().catch(function () { return { error: 'That did not save. Check your signal and try again.' }; });
    }, function () { return { error: 'That did not save. Check your signal and try again.' }; });
  }
  function save() {
    if (!now) return;
    var body = new URLSearchParams({ _csrf: token(), code: now.code, qty: qty.value.trim() });
    if (!partRow.hidden) body.append('part_number', part.value.trim());
    send('/scan', body).then(function (d) {
      if (!d.ok) return fail(d.error || 'That did not save.');
      onSheet(d);
      done('Saved: ' + d.counted + ' × ' + d.part_number + (d.learned ? '. Barcode remembered.' : '.'));
    });
  }
  function savePhoto() {
    if (!now) return;
    if (!photo.files || !photo.files[0]) return fail('Take a photo of it first.');
    var body = new FormData(); body.append('_csrf', token()); body.append('code', now.code); body.append('qty', qty.value.trim()); body.append('photo', photo.files[0]);
    send('/unknown', body).then(function (d) {
      if (!d.ok) return fail(d.error || 'That did not save.');
      done('Photo saved for someone to identify.');
    });
  }
  if (panel) {
    $('scan-save').addEventListener('click', save);
    $('scan-skip').addEventListener('click', function () { done('Skipped.'); });
    $('scan-photo-save').addEventListener('click', savePhoto);
    wrong.addEventListener('click', function () { partRow.hidden = false; wrong.hidden = true; part.focus(); });
    qty.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }
  window.partsForm = {
    // Typed or picked on the sheet itself: jump to that part's box, or fill in "not on the list".
    addPart: function (value) {
      var row = rowFor(value);
      if (row) { var box = row.querySelector('input'); row.scrollIntoView({ block: 'center' }); box.focus(); box.select(); return; }
      var add = $('add-part'); add.value = String(value || '').trim();
      add.scrollIntoView({ block: 'center' }); $('add-qty').focus();
    },
    // From the scanner: stay on the camera screen and deal with it there.
    onScan: panel ? function (code, ctl) {
      now = { code: code, ctl: ctl }; msg.textContent = 'Looking it up…';
      fetch(form.action + '/lookup?code=' + encodeURIComponent(code), { credentials: 'same-origin' })
        .then(function (r) { return r.json(); }).then(function (d) { show(code, d); }, function () { show(code, { found: false }); });
    } : null,
    // Leaving the camera screen part-way through one: put it back as it was for next time.
    onClose: function () { if (panel) { panel.hidden = true; view.hidden = false; title.hidden = false; } now = null; }
  };
})();
