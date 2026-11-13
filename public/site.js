// Runs on every page: home-screen app support and its "Get the app" bar, saved drafts, and a few small helpers.
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  // "Get the app" bar. Only on a phone or tablet, only in the browser: inside the installed
  // app (opened from the home screen) it never shows. "Not now" hides it for two weeks.
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  function inApp() {
    return navigator.standalone === true ||
      (window.matchMedia && ['standalone', 'fullscreen', 'minimal-ui'].some(function (m) { return window.matchMedia('(display-mode: ' + m + ')').matches; }));
  }
  function snoozed() {
    try { return Number(localStorage.getItem('install:later') || 0) > Date.now(); } catch (e) { return false; }
  }
  var installEvent = null;
  function showInstallBar() {
    var bar = document.getElementById('install-bar');
    if (!bar || inApp() || snoozed() || !(isIOS || isAndroid)) return;
    var go = document.getElementById('install-go');
    var how = document.getElementById('install-how');
    if (installEvent) go.hidden = false;
    else if (isIOS) how.textContent = 'Tap the Share button, then "Add to Home Screen".';
    else return; // Android: wait for the browser to say the app can be installed (it will not if it already is).
    bar.hidden = false;
  }
  function hideInstallBar(days) {
    var bar = document.getElementById('install-bar');
    if (bar) bar.hidden = true;
    if (days) { try { localStorage.setItem('install:later', String(Date.now() + days * 86400000)); } catch (e) {} }
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // keep the event so our own Install button can use it
    installEvent = e;
    showInstallBar();
  });
  window.addEventListener('appinstalled', function () { installEvent = null; hideInstallBar(3650); });
  document.addEventListener('DOMContentLoaded', function () {
    var go = document.getElementById('install-go');
    var later = document.getElementById('install-later');
    if (go) go.addEventListener('click', function () {
      if (!installEvent) return;
      var ev = installEvent; installEvent = null;
      ev.prompt();
      if (ev.userChoice) ev.userChoice.then(function (c) { hideInstallBar(c && c.outcome === 'accepted' ? 3650 : 14); });
      else hideInstallBar(14);
    });
    if (later) later.addEventListener('click', function () { hideInstallBar(14); });
    showInstallBar();
  });

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
  if (sent === 'parts' || sent === 'training' || sent === 'inspection') {
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

    // The lock. A tab that was open a moment ago carries a marker that vanishes when the site is
    // closed. No marker means the site was closed and reopened, so lock it and ask who is there.
    // (A second tab opened from one that is still open is let in: the open one vouches for it.)
    (function () {
      var root = document.documentElement;
      if (!root.hasAttribute('data-in')) return;
      var chan = null;
      try { chan = window.BroadcastChannel ? new BroadcastChannel('portal-open') : null; } catch (e) {}
      var mine = !root.classList.contains('checking');
      if (chan) chan.onmessage = function (e) {
        if (e.data === 'anyone?' && mine) chan.postMessage('yes');
        else if (e.data === 'locked') location.reload();
      };
      function lock() {
        var token = (document.querySelector('meta[name="csrf"]') || {}).content || '';
        var go = function () { if (chan) chan.postMessage('locked'); location.replace('/unlock?next=' + encodeURIComponent(location.pathname + location.search)); };
        fetch('/lock', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + encodeURIComponent(token) }).then(go, go);
      }
      if (!mine) {
        var settled = false;
        var letIn = function () { if (settled) return; settled = true; mine = true; try { sessionStorage.setItem('open', '1'); } catch (e) {} root.classList.remove('checking'); };
        if (!chan) lock();
        else {
          var prev = chan.onmessage;
          chan.onmessage = function (e) { if (e.data === 'yes') letIn(); else prev(e); };
          chan.postMessage('anyone?');
          setTimeout(function () { if (!settled) { settled = true; lock(); } }, 250);
        }
      }
      // Coming back to a tab that sat in the background: reload so the server can lock it if it was away too long.
      var hiddenAt = 0;
      var after = Number(root.getAttribute('data-lock-after') || 0);
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) hiddenAt = Date.now();
        else if (after && hiddenAt && Date.now() - hiddenAt > after) location.reload();
      });
    })();

    // Menu: one drop-down open at a time; close on a click elsewhere or Escape.
    var menus = Array.prototype.slice.call(document.querySelectorAll('details.menu, details.bell'));
    var navbar = document.getElementById('navbar');
    function closeMenus(except) { menus.forEach(function (m) { if (m !== except) m.open = false; }); }
    menus.forEach(function (m) {
      m.querySelector('summary').addEventListener('click', function () { closeMenus(m); });
      m.addEventListener('toggle', function () { if (m.open) closeMenus(m); });
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('details.menu, details.bell')) closeMenus(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = menus.filter(function (m) { return m.open; })[0];
      if (open) { open.open = false; open.querySelector('summary').focus(); }
    });
    // On a phone the whole menu is a sheet that slides up from the More button in the bottom bar.
    // The phone's Back button closes it; choosing a link replaces the "sheet open" step in the
    // history so Back from the next page comes straight back here.
    var more = document.getElementById('more-toggle');
    function sheetOpen() { return Boolean(navbar && navbar.classList.contains('open')); }
    function closeSheet(fromBack) {
      if (!sheetOpen()) return;
      navbar.classList.remove('open');
      document.documentElement.classList.remove('sheet-open');
      more.setAttribute('aria-expanded', 'false');
      if (!fromBack && history.state && history.state.menuSheet) history.back();
    }
    if (more && navbar) {
      more.addEventListener('click', function (e) {
        e.preventDefault();
        if (sheetOpen()) { closeSheet(false); return; }
        closeMenus(null);
        navbar.classList.add('open');
        document.documentElement.classList.add('sheet-open');
        more.setAttribute('aria-expanded', 'true');
        var current = navbar.querySelector('summary[aria-current]'); if (current) current.parentNode.open = true;
        navbar.scrollTop = 0;
        history.pushState({ menuSheet: true }, '');
      });
      navbar.addEventListener('click', function (e) {
        var link = e.target.closest('a[href]');
        if (!link || !sheetOpen() || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
        if (history.state && history.state.menuSheet) { e.preventDefault(); location.replace(link.href); }
      });
      document.addEventListener('click', function (e) {
        if (sheetOpen() && !e.target.closest('#navbar, #more-toggle')) closeSheet(false);
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheetOpen() && !menus.some(function (m) { return m.open; })) closeSheet(false); });
      window.addEventListener('popstate', function () { closeSheet(true); });
      window.addEventListener('pageshow', function (e) { if (e.persisted) closeSheet(true); });
      // Turning the phone or widening the window past the phone layout puts the menu back in the bar.
      if (window.matchMedia) {
        var wide = window.matchMedia('(min-width: 900px)');
        var onWide = function () { if (wide.matches) closeSheet(false); };
        if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
      }
    }

    // Photos open in a viewer on top of the page rather than as a bare image with no way back.
    // The phone's Back button closes the viewer and leaves you where you were.
    var viewer = null, viewerLinks = [], viewerAt = 0;
    function photoLinks(link) {
      var group = link.closest('.photo-grid');
      return group ? Array.prototype.slice.call(group.querySelectorAll('a[href*="/photo/"]')) : [link];
    }
    function showPhoto(i) {
      viewerAt = (i + viewerLinks.length) % viewerLinks.length;
      var link = viewerLinks[viewerAt];
      var thumb = link.querySelector('img');
      viewer.querySelector('img').src = link.getAttribute('href');
      viewer.querySelector('img').alt = thumb ? thumb.alt : 'Photo';
      viewer.querySelector('.pv-count').textContent = viewerLinks.length > 1 ? (viewerAt + 1) + ' of ' + viewerLinks.length : '';
    }
    function closeViewer(fromBack) {
      if (!viewer) return;
      viewer.remove(); viewer = null;
      document.documentElement.classList.remove('pv-open');
      if (!fromBack && history.state && history.state.photoViewer) history.back();
    }
    function openViewer(link) {
      viewerLinks = photoLinks(link);
      viewer = document.createElement('div');
      viewer.className = 'photo-viewer';
      viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true'); viewer.setAttribute('aria-label', 'Photo');
      viewer.innerHTML = '<div class="pv-bar"><span class="pv-count"></span><button type="button" class="pv-close">Close</button></div>' +
        '<button type="button" class="pv-nav pv-prev" aria-label="Previous photo">&#8249;</button><img alt="">' +
        '<button type="button" class="pv-nav pv-next" aria-label="Next photo">&#8250;</button>';
      var many = viewerLinks.length > 1;
      viewer.querySelector('.pv-prev').hidden = !many; viewer.querySelector('.pv-next').hidden = !many;
      viewer.addEventListener('click', function (e) {
        if (e.target.closest('.pv-prev')) showPhoto(viewerAt - 1);
        else if (e.target.closest('.pv-next')) showPhoto(viewerAt + 1);
        else if (e.target.tagName !== 'IMG') closeViewer(false);      // Close button or the dark area around the photo
      });
      document.body.appendChild(viewer);
      document.documentElement.classList.add('pv-open');
      showPhoto(viewerLinks.indexOf(link));
      history.pushState({ photoViewer: true }, '');
      viewer.querySelector('.pv-close').focus();
    }
    document.addEventListener('click', function (e) {
      var link = e.target.closest && e.target.closest('a[href*="/photo/"]');
      if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      openViewer(link);
    });
    window.addEventListener('popstate', function () { closeViewer(true); });
    document.addEventListener('keydown', function (e) {
      if (!viewer) return;
      if (e.key === 'Escape') closeViewer(false);
      else if (e.key === 'ArrowLeft' && viewerLinks.length > 1) showPhoto(viewerAt - 1);
      else if (e.key === 'ArrowRight' && viewerLinks.length > 1) showPhoto(viewerAt + 1);
    });

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

    // A form that should only be sent once: a second tap while the first is still sending does nothing.
    document.querySelectorAll('form[data-once]').forEach(function (form) {
      var btn = form.querySelector('button[type="submit"]');
      var label = btn ? btn.textContent : '';
      form.addEventListener('submit', function (e) {
        if (form.getAttribute('data-sending')) { e.preventDefault(); return; }
        form.setAttribute('data-sending', '1');
        if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = 'Posting…'; }
      });
      // Coming back to the page with the Back button makes the form usable again.
      window.addEventListener('pageshow', function () {
        form.removeAttribute('data-sending');
        if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = label; }
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
