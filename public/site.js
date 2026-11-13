// Runs on every page: home-screen app support, saved drafts, and a few small helpers.
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    clearPrefix: function (prefix) {
      try {
        Object.keys(localStorage).forEach(function (k) { if (k.indexOf(prefix) === 0) localStorage.removeItem(k); });
      } catch (e) {}
    }
  };

  // After a form is sent the server adds ?sent=parts or ?sent=training: drop that draft.
  var sent = new URLSearchParams(location.search).get('sent');
  if (sent === 'parts' || sent === 'training') {
    store.clearPrefix('draft:' + sent + ':');
    history.replaceState(null, '', location.pathname);
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Light / dark switch. With no saved choice the site follows the phone or computer setting.
    var toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var root = document.documentElement;
        var current = root.getAttribute('data-theme') ||
          (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        var next = current === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
      });
    }

    // Print buttons.
    document.querySelectorAll('[data-print]').forEach(function (btn) {
      btn.addEventListener('click', function () { window.print(); });
    });

    // "Are you sure?" on cancel buttons.
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      });
    });

    // Do not let a form vanish into a "no internet" page.
    document.querySelectorAll('form[data-offline-guard]').forEach(function (form) {
      var msg = form.querySelector('#offline-msg');
      form.addEventListener('submit', function (e) {
        if (navigator.onLine === false) {
          e.preventDefault();
          if (msg) { msg.hidden = false; msg.scrollIntoView({ block: 'center' }); }
        } else if (msg) msg.hidden = true;
      });
    });

    var form = document.querySelector('form[data-draft]');
    if (!form) return;
    var key = 'draft:' + form.getAttribute('data-draft');

    function fields() {
      return Array.prototype.filter.call(form.elements, function (el) {
        return el.name && el.name !== '_csrf' && el.type !== 'file' && el.type !== 'submit' && el.type !== 'button';
      });
    }
    function save() {
      var data = [];
      fields().forEach(function (el) {
        if (el.disabled) return;
        if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) return;
        data.push([el.name, el.value]);
      });
      var typed = data.some(function (d) {
        var el = form.querySelector('[name="' + d[0] + '"]');
        return d[1] && el && el.type !== 'radio' && el.type !== 'checkbox';
      });
      if (typed) store.set(key, data); else store.clearPrefix(key);
    }
    function restore(data) {
      var byName = {};
      data.forEach(function (d) { (byName[d[0]] = byName[d[0]] || []).push(d[1]); });
      var add = form.querySelector('#add-row');
      for (var i = 1; add && i < (byName.part_name || []).length; i++) add.click();
      Object.keys(byName).forEach(function (name) {
        var els = form.querySelectorAll('[name="' + name + '"]');
        byName[name].forEach(function (value, idx) {
          if (els[0] && (els[0].type === 'radio' || els[0].type === 'checkbox')) {
            Array.prototype.forEach.call(els, function (el) { if (el.value === value) el.checked = true; });
          } else if (els[idx]) els[idx].value = value;
        });
      });
      // A link such as /parts?action=return wins over the action saved in the draft.
      var wanted = new URLSearchParams(location.search).get('action');
      var radio = wanted && form.querySelector('[name="action"][value="' + wanted + '"]');
      if (radio) radio.checked = true;
      form.dispatchEvent(new Event('change', { bubbles: true }));
    }

    var draft = form.hasAttribute('data-draft-restore') ? store.get(key) : null;
    if (Array.isArray(draft) && draft.length) {
      restore(draft);
      var note = document.createElement('p');
      note.className = 'flash info';
      note.textContent = 'We put back what you had typed before. ';
      var clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'link'; clear.textContent = 'Start over';
      clear.addEventListener('click', function () { store.clearPrefix(key); location.reload(); });
      note.appendChild(clear);
      form.parentNode.insertBefore(note, form);
    }

    var timer;
    function queue() { clearTimeout(timer); timer = setTimeout(save, 300); }
    form.addEventListener('input', queue);
    form.addEventListener('change', queue);
    form.addEventListener('click', function (e) { if (e.target.closest('#add-row, .remove-row')) queue(); });
    form.addEventListener('submit', save);
  });
})();
