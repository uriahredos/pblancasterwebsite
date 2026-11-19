// New lead: while the name, phone or email is typed, ask whether someone is already working that customer.
(function () {
  var form = document.getElementById('lead-form'); var box = document.getElementById('lead-dupes');
  if (!form || !box || !window.fetch) return;
  var fields = ['lead-company', 'lead-phone', 'lead-email', 'lead-address'].map(function (id) { return document.getElementById(id); });
  var timer = null, seq = 0;
  function text(tag, value, cls) { var el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; return el; }
  function check() {
    var q = { company: fields[0].value.trim(), phone: fields[1].value.trim(), email: fields[2].value.trim(), address: fields[3].value.trim() };
    if (q.company.length < 3 && q.phone.replace(/\D/g, '').length < 7 && q.email.indexOf('@') < 1) { box.hidden = true; return; }
    var mine = ++seq;
    // Sent in the body of the request, so what is typed about a customer is not left in a web address.
    q._csrf = form.querySelector('input[name="_csrf"]').value;
    fetch('/sales/check', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' }, body: new URLSearchParams(q).toString() })
      .then(function (res) { return res.ok ? res.json() : { matches: [] }; })
      .then(function (data) {
        if (mine !== seq) return;
        var list = data.matches || [];
        box.innerHTML = '';
        if (!list.length) { box.hidden = true; return; }
        box.appendChild(text('p', 'Already being worked?', 'dupes-title'));
        var ul = document.createElement('ul'); ul.className = 'plain-rows';
        list.forEach(function (m) {
          var li = document.createElement('li');
          var left = document.createElement('span');
          // A customer of another office comes without a name or a stage: only that office and who to ask.
          if (m.url) { var a = text('a', m.company); a.href = m.url; a.style.fontWeight = '700'; left.appendChild(a); } else left.appendChild(text('strong', m.company || "Another office's customer"));
          left.appendChild(text('span', ' · ' + m.why, 'meta'));
          li.appendChild(left); li.appendChild(text('span', [m.owner, m.office, m.stage].filter(Boolean).join(' · ')));
          ul.appendChild(li);
        });
        box.appendChild(ul); box.hidden = false;
      }).catch(function () {});
  }
  fields.forEach(function (f) { if (f) f.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(check, 350); }); });
})();
