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
    try { return Number(localStorage.getItem('install:snooze') || 0) > Date.now(); } catch (e) { return false; }
  }
  var installEvent = null;
  // `manual` is true when the browser has not offered its own install prompt (Samsung Internet, Firefox,
  // or Chrome that has not got round to it): the bar then says where the option is in the browser's menu.
  function showInstallBar(manual) {
    var bar = document.getElementById('install-bar');
    if (!bar || inApp() || snoozed() || !(isIOS || isAndroid)) return;
    var go = document.getElementById('install-go');
    var how = document.getElementById('install-how');
    if (installEvent) { go.hidden = false; how.textContent = 'Add it to your home screen for one-tap access.'; }
    else if (isIOS) how.textContent = 'Tap the Share button, then "Add to Home Screen".';
    else if (manual) how.textContent = 'Open your browser\u2019s menu (\u22ee or \u2261), then tap "Add to Home screen" or "Install app".';
    else return; // Android: give the browser a moment to offer its own prompt first.
    bar.hidden = false;
  }
  function hideInstallBar(days) {
    var bar = document.getElementById('install-bar');
    if (bar) bar.hidden = true;
    if (days) { try { localStorage.setItem('install:snooze', String(Date.now() + days * 86400000)); } catch (e) {} }
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // keep the event so our own Install button can use it
    installEvent = e;
    showInstallBar();
  });
  window.addEventListener('appinstalled', function () { installEvent = null; hideInstallBar(90); });
  // Spell check: boxes where people write sentences get the browser's spell checker (the red underline, and
  // suggestions on a right-click or long press) and the phone keyboard's autocorrect. Names, usernames, emails,
  // part numbers and search boxes are left alone, where "corrections" would only get in the way.
  function spellCheck(root) {
    var skip = /user|name|email|phone|part|qty|quantity|number|code|skill|birth|date|address|street|truck|^q$|^oq$|search|password|token/i;
    Array.prototype.forEach.call((root || document).querySelectorAll('textarea, input[type=text], input:not([type])'), function (el) {
      var prose = !(skip.test(el.name || '') || skip.test(el.id || '') || el.getAttribute('autocapitalize') === 'none' || el.getAttribute('spellcheck') === 'false' || el.hasAttribute('list'));
      if (!prose) return;
      el.spellcheck = true; el.setAttribute('autocorrect', 'on');
      if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'sentences');
    });
  }
  document.addEventListener('DOMContentLoaded', function () { spellCheck(document); });

  // Signing in from a link to a complaint page lands on the home page like any other sign-in (the site keeps no note of
  // where the person was heading), and this takes them on to the page they asked for. It waits for the home page to
  // finish loading first (a few seconds at most), so what the server saw is an ordinary visit to the home page.
  (function () {
    var to = { '#complaint-form': '/complaint', '#complaint-status': '/complaint/status' }[location.hash];
    if (!to || location.pathname !== '/' || !document.documentElement.hasAttribute('data-in')) return;
    var go = function () { location.replace(to); };
    if (document.readyState === 'complete') go(); else { window.addEventListener('load', go); setTimeout(go, 3000); }
  })();

  // A sign-in page can sit open for hours (a shared computer overnight), longer than the site keeps the form token of a
  // visitor who has not signed in. A form sent from a page that old collects a fresh token first, so it is not refused
  // as expired. passkey.js asks for the same before a Face ID sign-in. (The lock screen belongs to someone who is signed
  // in, whose token lasts as long as their sign-in, so it is left alone.)
  (function () {
    if (document.documentElement.hasAttribute('data-in') || document.querySelector('.lock-screen') || !window.fetch || !window.DOMParser) return;
    var loaded = Date.now();
    function fresh() {
      if (Date.now() - loaded < 60 * 60 * 1000) return Promise.resolve();
      return fetch(location.href, { credentials: 'same-origin', cache: 'no-store' }).then(function (res) { return res.text(); }).then(function (html) {
        var meta = new DOMParser().parseFromString(html, 'text/html').querySelector('meta[name="csrf"]');
        var token = meta && meta.getAttribute('content');
        if (!token) return;
        loaded = Date.now();
        var mine = document.querySelector('meta[name="csrf"]'); if (mine) mine.setAttribute('content', token);
        Array.prototype.forEach.call(document.querySelectorAll('input[name="_csrf"]'), function (f) { f.value = token; });
      }).catch(function () {});
    }
    window.portalFreshToken = fresh;
    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || !form.querySelector || !form.querySelector('input[name="_csrf"]') || Date.now() - loaded < 60 * 60 * 1000) return;
      e.preventDefault(); e.stopImmediatePropagation();
      var by = e.submitter;
      fresh().then(function () { loaded = Date.now(); if (form.requestSubmit) form.requestSubmit(by || undefined); else form.submit(); });
    }, true);
  })();

  // Alerts follow the sign-in. A device that already allows alerts tells the site which registration it holds, once per
  // page and with nothing shown. If it is this person's own, their alerts carry on under the sign-in they are using now.
  (function () {
    if (!document.documentElement.hasAttribute('data-in') || !window.fetch) return;
    if (/^\/complaint/i.test(location.pathname)) return;   // a complaint page asks the site for nothing of its own
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || Notification.permission !== 'granted') return;
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) return;
      var token = (document.querySelector('meta[name="csrf"]') || {}).content || '';
      return fetch('/push/attach', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(token) + '&endpoint=' + encodeURIComponent(sub.endpoint) });
    }).catch(function () {});
  })();

  // Social: opening the prompt to post puts the cursor in the box; "Write a post" at the end of the feed opens it.
  (function () {
    var box = document.getElementById('composer');
    if (!box) return;
    box.addEventListener('toggle', function () { if (box.open) { var t = box.querySelector('textarea'); if (t) t.focus(); } });
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-open-composer]');
      if (!a) return;
      e.preventDefault(); box.open = true; box.scrollIntoView({ block: 'start' });
    });
  })();

  // "Are you sure?" questions. Asked here, for the whole page, so they still work on parts of a page
  // that were swapped in without a reload.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form && form.getAttribute && form.getAttribute('data-confirm') && !window.confirm(form.getAttribute('data-confirm'))) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button[data-confirm-button]');
    if (btn && !window.confirm(btn.getAttribute('data-confirm-button'))) e.preventDefault();
    var print = e.target.closest && e.target.closest('[data-print]');
    if (print) window.print();
    // Small pop-ups inside the page (the reaction choices, row menus) close on a tap elsewhere.
    Array.prototype.forEach.call(document.querySelectorAll('main details.react-more[open], main details.row-menu[open]'), function (d) { if (!d.contains(e.target)) d.open = false; });
  });
  document.addEventListener('change', function (e) {
    var sel = e.target;
    if (sel && sel.matches && sel.matches('select[data-autosubmit]') && sel.form) sel.form.submit();
  });

  // ---- No reload: a button inside the page sends its form quietly and only the part that changed is redrawn,
  // so reacting, ticking something off or saving an update does not flash the whole page or jump to the top.
  function toast(text) {
    if (!text) return;
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('gone'); setTimeout(function () { t.remove(); }, 400); }, 3200);
  }
  document.addEventListener('DOMContentLoaded', function () {
    try { var kept = sessionStorage.getItem('toast'); if (kept) { sessionStorage.removeItem('toast'); if (!document.querySelector('main .flash')) toast(kept); } } catch (e) {}
  });
  // Runs a swapped-in part's own scripts again, in order, and says when they have all loaded.
  function rerun(root) {
    spellCheck(root);
    var waits = Array.prototype.map.call(root.querySelectorAll('script[src]'), function (old) {
      return new Promise(function (done) {
        var fresh = document.createElement('script'); fresh.async = false; fresh.onload = fresh.onerror = done; fresh.src = old.src;
        old.parentNode.replaceChild(fresh, old);
      });
    });
    return Promise.all(waits);
  }

  // ---- Moving between pages without a full reload. The next page is fetched, and only the middle of the screen
  // (and what is highlighted in the menus) changes, so the header and the bottom bar never blink. Anything this
  // cannot handle (a download, the lock screen, a failed fetch) falls back to an ordinary page load.
  var softUrl = location.pathname + location.search;
  var softSeq = 0;
  function markCurrent(doc) {
    [['#navbar a[href]', function (a) { return a.getAttribute('href'); }], ['#tabbar a[href]', function (a) { return a.getAttribute('href'); }],
      ['#navbar details.menu > summary', function (el) { return (el.childNodes[0] && el.childNodes[0].nodeValue || el.textContent).trim(); }]].forEach(function (g) {
      var fresh = {};
      Array.prototype.forEach.call(doc.querySelectorAll(g[0]), function (el) { fresh[g[1](el)] = el; });
      Array.prototype.forEach.call(document.querySelectorAll(g[0]), function (el) {
        var next = fresh[g[1](el)];
        if (!next) return;
        if (next.hasAttribute('aria-current')) el.setAttribute('aria-current', next.getAttribute('aria-current')); else el.removeAttribute('aria-current');
      });
    });
  }
  function showPage(doc, to, opts) {
    var main = document.querySelector('main'); var next = doc.querySelector('main');
    // If the menu itself is different (someone just set their first password, or their permissions changed),
    // swapping the middle of the page would leave the old menu behind: load the page properly instead.
    var links = function (d) { return d.querySelectorAll('#navbar a[href]').length; };
    if (links(document) !== links(doc)) { location.assign(to.pathname + to.search + to.hash); return Promise.resolve(); }
    Array.prototype.forEach.call(document.querySelectorAll('details.menu[open], details.bell[open], details.row-menu[open]'), function (d) { d.open = false; });
    main.className = next.className;
    main.innerHTML = next.innerHTML;
    var keepSheet = document.body.classList.contains('sheet-open');
    document.body.className = doc.body.className;
    document.title = doc.title || document.title;
    // The office name beside the logo shows only on pages about one office.
    var brand = document.querySelector('.banner .brand'), newBrand = doc.querySelector('.banner .brand');
    if (brand && newBrand && brand.textContent.trim() !== newBrand.textContent.trim()) brand.innerHTML = newBrand.innerHTML;
    Array.prototype.forEach.call(document.querySelectorAll('.nav-branch input[name="back"]'), function (i) { i.value = to.pathname; });
    markCurrent(doc); syncCounts(doc);
    softUrl = to.pathname + to.search;
    if (opts.push) history.pushState({ soft: true }, '', softUrl + to.hash);
    else if (opts.replace) history.replaceState({ soft: true }, '', softUrl + to.hash);
    var spot = to.hash && to.hash.length > 1 ? document.getElementById(to.hash.slice(1)) : null;
    if (spot) spot.scrollIntoView(); else if (!opts.keepScroll) window.scrollTo(0, 0);
    return rerun(main).then(function () {
      var again = document.createElement('script'); again.src = '/passkey.js?soft=' + Date.now(); document.head.appendChild(again);   // its buttons live inside pages
      initMain();
      try { var kept = sessionStorage.getItem('toast'); if (kept) { sessionStorage.removeItem('toast'); if (!main.querySelector('.flash')) toast(kept); } } catch (e) {}
    });
  }
  function softGo(url, opts) {
    opts = opts || { push: true };
    var mine = ++softSeq;
    var root = document.documentElement;
    if (!window.fetch || !window.DOMParser || !root.hasAttribute('data-in') || !document.querySelector('main')) { location.assign(url); return; }
    root.classList.add('page-loading');
    // The page may already be on its way: it is asked for the moment a finger touches the link, before the tap ends.
    var early = warm && warm.url === url && Date.now() - warm.at < 4000 ? warm.req : null;
    warm = null;
    (early || fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })).then(function (res) {
      if (mine !== softSeq) return null;
      if (!res.ok || !/text\/html/.test(res.headers.get('content-type') || '')) throw new Error('not a page');
      return res.text().then(function (html) { return { to: new URL(res.url), html: html }; });
    }).then(function (r) {
      if (!r || mine !== softSeq) return;
      var doc = new DOMParser().parseFromString(r.html, 'text/html');
      if (!doc.querySelector('main') || !doc.documentElement.hasAttribute('data-in') || doc.querySelector('.lock-screen, .logo-hero')) throw new Error('not signed in');
      if (new URL(url, location.href).hash && !r.to.hash) r.to.hash = new URL(url, location.href).hash;
      return showPage(doc, r.to, opts);
    }).catch(function () { if (mine === softSeq) { if (opts.pop) location.reload(); else location.assign(url); } })
      .then(function () { if (mine === softSeq) root.classList.remove('page-loading'); });
  }
  var warm = null;
  function softLink(a) {
    if (!a || a.target || a.hasAttribute('download') || a.getAttribute('role') === 'button' || a.hasAttribute('data-full')) return null;
    var to;
    try { to = new URL(a.href, location.href); } catch (err) { return null; }
    if (to.origin !== location.origin) return null;
    if (to.pathname === location.pathname && to.search === location.search && to.hash) return null;   // a jump within this page
    if (/\.(csv|pdf|png|jpe?g|webp|gif|json|zip|xlsx?)$|\/pdf$|\/photo\/|\/page\/\d+$|^\/(logout|lock|unlock|login|poster)\b|\/backups?\//i.test(to.pathname)) return null;
    return to;
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.button || !document.documentElement.hasAttribute('data-in') || !window.fetch) return;
    // Only the bottom tabs, where a touch is always a deliberate press. Elsewhere a finger may just be scrolling
    // past a link, and opening some pages marks things as read.
    var to = softLink(e.target.closest && e.target.closest('#tabbar a[href]'));
    if (!to) return;
    var url = to.pathname + to.search + to.hash;
    if (warm && warm.url === url && Date.now() - warm.at < 4000) return;
    warm = { url: url, at: Date.now(), req: fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } }) };
    warm.req.catch(function () {});
  }, { passive: true });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var to = softLink(a);
    if (!to) return;
    e.preventDefault();
    // Show straight away which tab was pressed, before the page arrives.
    var bar = a.closest('#tabbar');
    if (bar) { Array.prototype.forEach.call(bar.querySelectorAll('a[aria-current]'), function (x) { x.removeAttribute('aria-current'); }); a.setAttribute('aria-current', 'page'); }
    softGo(to.pathname + to.search + to.hash, { push: true });
  });
  window.addEventListener('popstate', function () {
    if (location.pathname + location.search === softUrl) return;   // only a menu or a photo closing
    softGo(location.pathname + location.search + location.hash, { pop: true, keepScroll: false });
  });

  // What counts as someone using the site, for the idle lock: a key, a tap or click, the mouse wheel, a finger on the screen.
  // Only things a person does. A page that moves by itself (the home page banner scrolls every few seconds) must not
  // count, so "scroll" is not here, and neither is anything a script made up (see isTrusted below).
  var PERSON_EVENTS = ['keydown', 'input', 'pointerdown', 'wheel', 'touchstart', 'touchmove'];

  // ---- The bell keeps itself up to date. Every half minute, while the page is on screen, the counts are fetched
  // and copied in. This does not count as "using the site", so it never keeps a forgotten phone unlocked.
  //
  // The same check is how a page left open finds out that the site has locked. Once it has, the page must stop
  // showing what was on it: it goes to the lock screen there and then, rather than sitting readable until someone
  // next taps it.
  (function () {
    var root = document.documentElement;
    if (!root.hasAttribute('data-in') || !window.fetch || !window.DOMParser) return;
    var busy = false, stopped = false;
    var after = Number(root.getAttribute('data-lock-after') || 0), lastActive = Date.now(), idleTimer = null;
    function leave(to) {
      if (stopped) return;
      stopped = true;
      location.replace(to + (to === '/unlock' ? '?next=' + encodeURIComponent(location.pathname + location.search) : ''));
    }
    function pulse() {
      if (busy || stopped || document.hidden || root.classList.contains('page-loading')) return;
      busy = true;
      fetch('/pulse', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } }).then(function (res) {
        var path = new URL(res.url).pathname;
        if (path === '/unlock') { leave('/unlock'); return null; }                // the site has locked
        if (res.status === 401 || path === '/login') { leave('/login'); return null; }   // signed out, here or on another device
        if (!res.ok || path !== '/pulse') return null;                             // a passing hiccup: try again next time
        return res.text();
      }).then(function (html) {
        if (!html) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        if (doc.documentElement.hasAttribute('data-in')) syncCounts(doc);
      }).catch(function () {
        // The site cannot be reached to ask. If nothing has been done here for the whole time allowed, cover the page anyway.
        if (after && Date.now() - lastActive > after) leave('/unlock');
      }).then(function () { busy = false; });
    }
    setInterval(pulse, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(pulse, 1500); });
    // Nothing typed, tapped or wheeled for the whole time allowed: ask straight away instead of waiting for the next half minute.
    function armIdle() { if (!after) return; clearTimeout(idleTimer); idleTimer = setTimeout(pulse, after + 1500); }
    var noted = 0;
    PERSON_EVENTS.forEach(function (n) {
      document.addEventListener(n, function (e) { if (!e.isTrusted) return; lastActive = Date.now(); if (lastActive - noted > 5000) { noted = lastActive; armIdle(); } }, { passive: true, capture: true });
    });
    armIdle();
  })();
  var initMain = function () {};   // set once the page is ready: what to run again on a page that was swapped in

  // A form that should only be sent once (posting a reply): a second tap while the first is sending does nothing.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-once')) return;
    if (form.getAttribute('data-sending')) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    form.setAttribute('data-sending', '1');
    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.setAttribute('data-label', btn.textContent); btn.setAttribute('aria-disabled', 'true'); btn.textContent = 'Posting\u2026'; }
  }, true);
  window.addEventListener('pageshow', function () {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-sending]'), function (form) {
      form.removeAttribute('data-sending');
      var btn = form.querySelector('button[data-label]');
      if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = btn.getAttribute('data-label'); }
    });
  });
  // Do not let a form vanish into a "no internet" page.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-offline-guard')) return;
    var msg = form.querySelector('#offline-msg');
    if (navigator.onLine === false) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (msg) { msg.hidden = false; msg.scrollIntoView({ block: 'center' }); }
    } else if (msg) msg.hidden = true;
  }, true);

  // The counts around the page (the bell and its list, the numbers in the menu and on the phone's bottom bar)
  // are copied across from the fresh copy of the page, so they keep up without a reload.
  function syncCounts(doc) {
    var pairs = [['#bell > summary', true], ['#bell > .bell-list', true]];
    pairs.forEach(function (pr) {
      var now = document.querySelector(pr[0]), next = doc.querySelector(pr[0]);
      if (now && next && now.innerHTML !== next.innerHTML) {
        now.innerHTML = next.innerHTML;
        ['aria-label', 'title'].forEach(function (a) { if (next.hasAttribute(a)) now.setAttribute(a, next.getAttribute(a)); });
      }
    });
    // Links and menu headings are matched by where they go (or what they say), so only their numbers change.
    [['#navbar a[href]', 'href'], ['#tabbar a[href]', 'href']].forEach(function (g) {
      var fresh = {};
      Array.prototype.forEach.call(doc.querySelectorAll(g[0]), function (a) { fresh[a.getAttribute(g[1])] = a; });
      Array.prototype.forEach.call(document.querySelectorAll(g[0]), function (a) {
        var next = fresh[a.getAttribute(g[1])];
        if (next && a.innerHTML !== next.innerHTML) a.innerHTML = next.innerHTML;
      });
    });
    var heads = {};
    var label = function (el) { return (el.childNodes[0] && el.childNodes[0].nodeValue || el.textContent).trim(); };
    Array.prototype.forEach.call(doc.querySelectorAll('#navbar details.menu > summary'), function (el) { heads[label(el)] = el; });
    Array.prototype.forEach.call(document.querySelectorAll('#navbar details.menu > summary'), function (el) {
      var next = heads[label(el)];
      if (next && el.innerHTML !== next.innerHTML) el.innerHTML = next.innerHTML;
    });
  }

  // For small scripts on a page that changed something themselves: bring the counts up to date from a fresh header.
  window.portalSync = function (html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.documentElement.hasAttribute('data-in')) syncCounts(doc);
  };

  document.addEventListener('submit', function (e) {
    var form = e.target;
    var main = document.querySelector('main');
    if (e.defaultPrevented || !window.fetch || !window.DOMParser || !window.URLSearchParams || !main || !form || form.tagName !== 'FORM') return;
    if (!document.documentElement.hasAttribute('data-in') || !main.contains(form)) return;
    if ((form.method || '').toLowerCase() !== 'post' || form.target === '_blank') return;
    if (form.hasAttribute('data-no-live') || form.hasAttribute('data-offline-guard') || form.hasAttribute('data-draft')) return;
    e.preventDefault();
    if (form.getAttribute('data-busy')) return;
    form.setAttribute('data-busy', '1');
    // A form with photos or files goes as it is; the rest go as plain fields.
    var files = /multipart/i.test(form.enctype || '');
    var body = files ? new FormData(form) : new URLSearchParams(new FormData(form));
    if (e.submitter && e.submitter.name) body.append(e.submitter.name, e.submitter.value);
    var region = form.closest('main [id]');
    var regionId = region && region.id;
    var here = location.pathname;
    fetch(form.action, files ? { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' }, body: body }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' }, body: body.toString() })
      .then(function (res) {
        var to = new URL(res.url);
        if (!/text\/html/.test(res.headers.get('content-type') || '')) { location.reload(); return null; }
        return res.text().then(function (html) { return { to: to, html: html }; });
      })
      .then(function (r) {
        if (!r) return;
        var doc = new DOMParser().parseFromString(r.html, 'text/html');
        var newMain = doc.querySelector('main');
        var flash = doc.querySelector('main .flash.ok');
        var note = flash ? flash.textContent.trim() : '';
        // Sent somewhere else (another page, the lock screen): go there properly, carrying the message along.
        if (r.to.pathname !== here || !newMain || !doc.documentElement.hasAttribute('data-in')) {
          try { if (note) sessionStorage.setItem('toast', note); } catch (e2) {}
          if (newMain && doc.documentElement.hasAttribute('data-in') && !doc.querySelector('.lock-screen, .logo-hero')) { softSeq++; showPage(doc, r.to, { push: true }); }
          else location.assign(r.to.pathname + r.to.search + r.to.hash);
          return;
        }
        var fresh = regionId ? doc.getElementById(regionId) : null;
        var bad = doc.querySelector('main .flash.err, main .errors');
        if (fresh && !bad) {
          // Something that was folded open (a task being updated) stays open after the save.
          var wasOpen = Array.prototype.map.call(region.querySelectorAll('details[open][data-task]'), function (d) { return d.getAttribute('data-task'); });
          region.parentNode.replaceChild(document.importNode(fresh, true), region);
          wasOpen.forEach(function (id) { var d = document.querySelector('details[data-task="' + id + '"]'); if (d) d.open = true; });
          rerun(document.getElementById(regionId));
          toast(note);
        } else {
          if (flash) flash.remove();
          main.innerHTML = newMain.innerHTML;
          rerun(main).then(function () { initMain(); });
          toast(note);
          if (bad) { var shown = main.querySelector('.flash.err, .errors'); if (shown) shown.scrollIntoView({ block: 'center' }); }
        }
        syncCounts(doc);
        document.title = doc.title || document.title;
        // Where the site pointed at something new (a reply just posted), bring it into view.
        var spot = r.to.hash && r.to.hash.length > 1 ? document.getElementById(r.to.hash.slice(1)) : null;
        if (spot && (!regionId || spot.id !== regionId)) spot.scrollIntoView({ block: 'center', behavior: 'smooth' });
      })
      .catch(function () { form.removeAttribute('data-busy'); form.setAttribute('data-no-live', ''); if (form.requestSubmit) form.requestSubmit(e.submitter || undefined); else form.submit(); })
      .then(function () { form.removeAttribute('data-busy'); });
  });

  // Still here: while someone is typing or tapping, tell the site about once a minute, so the idle lock
  // counts from when they last did something, not from when the page was opened.
  (function () {
    if (!document.documentElement.hasAttribute('data-in')) return;
    // Opening the complaint form does not restart the idle clock by itself, so there the first key or tap says so at once.
    var last = /^\/complaint/i.test(location.pathname) ? 0 : Date.now();
    function ping() {
      if (Date.now() - last < 60000) return;
      last = Date.now();
      try { fetch('/alive', { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' }).catch(function () {}); } catch (e) {}
    }
    PERSON_EVENTS.forEach(function (n) { document.addEventListener(n, function (e) { if (e.isTrusted) ping(); }, { passive: true, capture: true }); });
  })();

  // A form is sent once. On a slow connection a second or third tap on the button used to send it again.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM' || (form.method || '').toLowerCase() !== 'post') return;
    if (form.getAttribute('data-sent')) { e.preventDefault(); return; }
    form.setAttribute('data-sent', '1');
    setTimeout(function () {
      if (e.defaultPrevented) { form.removeAttribute('data-sent'); return; }   // a confirm box was cancelled, or the page handles it itself
      Array.prototype.forEach.call(form.querySelectorAll('button[type=submit], button:not([type])'), function (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
    }, 0);
  });
  window.addEventListener('pageshow', function () {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-sent]'), function (form) {
      form.removeAttribute('data-sent');
      Array.prototype.forEach.call(form.querySelectorAll('button[aria-busy]'), function (b) { b.disabled = false; b.removeAttribute('aria-busy'); });
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    var go = document.getElementById('install-go');
    var later = document.getElementById('install-later');
    if (go) go.addEventListener('click', function () {
      if (!installEvent) return;
      var ev = installEvent; installEvent = null;
      ev.prompt();
      if (ev.userChoice) ev.userChoice.then(function (c) { hideInstallBar(c && c.outcome === 'accepted' ? 90 : 14); });
      else hideInstallBar(14);
    });
    if (later) later.addEventListener('click', function () { hideInstallBar(14); });
    showInstallBar();
    if (isAndroid) setTimeout(function () { if (!installEvent) showInstallBar(true); }, 3500);
    // "Get the app" in the menu brings the bar back at any time, even after "Not now".
    var open = document.getElementById('install-open');
    if (open && !inApp() && (isIOS || isAndroid)) {
      open.hidden = false;
      open.addEventListener('click', function () {
        try { localStorage.removeItem('install:snooze'); } catch (e) {}
        var sheetBtn = document.querySelector('.tabbar [aria-expanded="true"]');
        if (sheetBtn) sheetBtn.click();
        showInstallBar(true);
      });
    }
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

  // On call, on a phone: the button brings in the rest of the schedule.
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-oncall-all]') : null;
    if (!b) return;
    var t = document.querySelector('.oncall-table'); if (t) t.classList.add('all');
    b.parentNode.hidden = true;
  });

  // Signing out leaves nothing behind on the device: half-written forms saved here are removed, and the site
  // tells the browser to drop the photos and files it kept (see the sign-out route).
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.getAttribute || form.getAttribute('action') !== '/logout') return;
    store.clearPrefix('draft:');
    try { sessionStorage.clear(); } catch (err) {}
  }, true);

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
    var menus = Array.prototype.slice.call(document.querySelectorAll('details.menu, details.bell, details.row-menu, details.react-more'));
    var navbar = document.getElementById('navbar');
    function closeMenus(except) { menus.forEach(function (m) { if (m !== except) m.open = false; }); }
    menus.forEach(function (m) {
      m.querySelector('summary').addEventListener('click', function () { closeMenus(m); });
      m.addEventListener('toggle', function () { if (m.open) closeMenus(m); });
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('details.menu, details.bell, details.row-menu, details.react-more')) closeMenus(null);
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
        if (history.state && history.state.menuSheet && !link.target && link.origin === location.origin && !/^\/(logout|poster)\b/.test(link.pathname)) {
          e.preventDefault(); closeSheet(true); softGo(link.pathname + link.search + link.hash, { replace: true });
        } else if (history.state && history.state.menuSheet) { e.preventDefault(); location.replace(link.href); }
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

    function initDraft() {
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
    }
    // On a phone a wide table is shown as a list of cards: each cell gets its column's heading as a label.
    function stackTables() {
      document.querySelectorAll('main table:not(.positions):not(.oncall-table):not(.audit):not(.plain):not(.stack)').forEach(function (t) {
        var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.querySelector('.sr') ? '' : th.textContent.trim(); });
        if (heads.length < 3) return;
        t.querySelectorAll('tbody tr').forEach(function (tr) {
          Array.prototype.forEach.call(tr.children, function (td, i) { if (heads[i] && td.textContent.trim()) td.setAttribute('data-label', heads[i]); });
        });
        t.classList.add('stack');
      });
    }
    // Editing a message: the box grows to fit all of its words, when opened and as you type.
    function fitBox(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 4) + 'px'; }
    document.addEventListener('toggle', function (e) {
      var d = e.target; if (!d || !d.matches || !d.matches('details.msg-edit') || !d.open) return;
      var t = d.querySelector('textarea'); if (t) { fitBox(t); t.focus(); }
    }, true);
    document.addEventListener('input', function (e) { if (e.target && e.target.matches && e.target.matches('.msg-edit textarea')) fitBox(e.target); });
    initDraft(); stackTables();
    initMain = function () { initDraft(); stackTables(); };
  });
})();
