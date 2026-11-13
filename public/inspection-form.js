// Truck inspection: only ask "What is wrong?" for items marked Problem.
(function () {
  var form = document.getElementById('inspection-form');
  if (!form) return;
  function refresh() {
    form.querySelectorAll('[data-why]').forEach(function (label) {
      var picked = form.querySelector('input[name="' + label.getAttribute('data-why') + '"]:checked');
      var show = Boolean(picked && picked.value === 'problem');
      label.hidden = !show;
      var input = label.querySelector('input');
      input.required = show;
      input.disabled = !show;
    });
  }
  form.addEventListener('change', refresh);
  refresh();
})();
