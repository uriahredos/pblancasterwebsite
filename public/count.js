// The count sheet: a scanned barcode jumps to that part's box, or fills in "not on the list" when the part is not there.
(function () {
  var form = document.getElementById('count-form');
  if (!form) return;
  window.partsForm = {
    addPart: function (value) {
      var wanted = String(value || '').trim().toUpperCase();
      var row = Array.prototype.filter.call(form.querySelectorAll('tr[data-part]'), function (tr) { return tr.getAttribute('data-part') === wanted; })[0];
      if (row) { var box = row.querySelector('input'); row.scrollIntoView({ block: 'center' }); box.focus(); box.select(); return; }
      var add = document.getElementById('add-part'); add.value = String(value || '').trim();
      add.scrollIntoView({ block: 'center' }); document.getElementById('add-qty').focus();
    }
  };
})();
