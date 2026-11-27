// Live discussions: a thread, or a list of threads, keeps itself current without a reload.
// The site sends a short "something changed" note over /live/stream; this page then fetches its own fresh copy the
// ordinary way and merges what is new into what is on screen. Anything half-typed (a reply, an edit) is never touched.
// If the stream cannot be used (a proxy that holds it back, a locked or signed-out session) it asks every 20 seconds instead.
(function () {
  'use strict';
  if (window.__liveStop) window.__liveStop();                // this script runs again after a soft page change
  if (!window.EventSource || !window.fetch || !window.DOMParser) return;
  var root = document.querySelector('main');
  if (!root || !document.documentElement.hasAttribute('data-in')) return;
  // What this page keeps current: a discussion thread, a private conversation, the inbox, or a list of threads.
  var thread = root.querySelector('[data-live-thread]'), dmBox = root.querySelector('[data-live-dm]'), inbox = root.querySelector('[data-live-inbox]');
  var threadId = thread ? thread.getAttribute('data-live-thread') : null;
  var dmId = dmBox ? dmBox.getAttribute('data-live-dm') : null;
  var inboxId = inbox ? inbox.getAttribute('data-live-inbox') : null;
  if (!threadId && !dmId && !inboxId && !root.querySelector('[data-live-list]')) return;
  var topics = threadId ? 'thread:' + threadId : dmId ? 'dm:' + dmId : inboxId ? 'inbox:' + inboxId : 'forum';

  var es = null, stopped = false, busy = false, again = false, dirty = false;
  var opened = false, everOpened = false, timer = null, poll = null, watchdog = null, pill = null;

  function stop() {
    stopped = true;
    if (es) { es.close(); es = null; }
    clearTimeout(timer); clearInterval(poll); clearTimeout(watchdog);
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
    if (window.__liveStop === stop) window.__liveStop = null;
  }
  window.__liveStop = stop;
  window.__liveOpen = function () { return opened && !stopped; };   // the call script needs the live line to be up

  // Still the page this was started for? (A soft page change swaps <main> without stopping us.)
  function here() {
    var m = document.querySelector('main');
    return !stopped && m && (threadId ? m.querySelector('[data-live-thread="' + threadId + '"]') : dmId ? m.querySelector('[data-live-dm="' + dmId + '"]')
      : inboxId ? m.querySelector('[data-live-inbox]') : m.querySelector('[data-live-list]'));
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 300); }

  window.__liveRefresh = function () { clearTimeout(timer); refresh(); };   // a page that has just changed something itself asks for the news now

  function gone() {
    stop();
    var m = document.querySelector('main');
    if (!m || m.querySelector('.live-gone')) return;
    var p = document.createElement('p');
    p.className = 'flash warn live-gone';
    p.textContent = dmId ? 'This conversation is no longer available.' : 'This discussion was removed.';
    m.insertBefore(p, m.firstChild);
  }

  function refresh() {
    if (!here()) return stop();
    if (document.hidden) { dirty = true; return; }            // catch up when the tab comes back
    if (busy) { again = true; return; }
    busy = true; dirty = false;
    fetch(location.pathname + location.search, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch', 'X-Live': '1' } })
      .then(function (res) {
        var to = new URL(res.url);
        if (to.pathname !== location.pathname) {                // sent to the lock screen or sign-in: let the page do it properly
          if (/^\/(unlock|login)$/.test(to.pathname)) { stop(); location.reload(); }
          return null;
        }
        if (res.status === 404) { gone(); return null; }
        return res.ok ? res.text() : null;
      })
      .then(function (html) {
        if (!html || !here()) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        if (!doc.documentElement.hasAttribute('data-in')) { stop(); location.reload(); return; }
        if (threadId) mergeThread(doc); else if (dmId) mergeDm(doc); else if (inboxId) mergeInbox(doc); else mergeLists(doc);
        if (window.portalSync) window.portalSync(html);
      })
      .catch(function () { /* offline for a moment: the next change or poll tries again */ })
      .then(function () { busy = false; if (again) { again = false; schedule(); } });
  }

  // Something being typed into, or opened for editing, inside this post: leave the post alone.
  function inUse(el) {
    return el.contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName) || Boolean(el.querySelector('details.msg-edit[open]'));
  }

  // New articles are added at the end, ones whose revision changed are replaced, ones that are gone are dropped. An article
  // with something being typed into or opened for editing is left alone. Returns the articles added.
  function mergeArticles(box, next) {
    var have = {}, seen = {}, added = [];
    Array.prototype.forEach.call(box.children, function (a) { if (a.id) have[a.id] = a; });
    Array.prototype.forEach.call(next.children, function (a) {
      if (!a.id) return;
      seen[a.id] = true;
      var old = have[a.id];
      if (!old) { var fresh = document.importNode(a, true); box.appendChild(fresh); added.push(fresh); }
      else if (old.getAttribute('data-rev') !== a.getAttribute('data-rev') && !inUse(old)) box.replaceChild(document.importNode(a, true), old);
    });
    Object.keys(have).forEach(function (id) { if (!seen[id] && !inUse(have[id])) box.removeChild(have[id]); });
    return added;
  }

  // A private conversation: new messages arrive at the bottom.
  function mergeDm(doc) {
    var box = document.querySelector('[data-live-dm="' + dmId + '"]'), next = doc.querySelector('[data-live-dm]');
    if (!box || !next) return;
    var nearEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 300;
    var added = mergeArticles(box, next);
    var banner = document.querySelector('[data-call-banner]'), newBanner = doc.querySelector('[data-call-banner]');
    if (banner && newBanner && !window.__callActive && banner.innerHTML !== newBanner.innerHTML) banner.innerHTML = newBanner.innerHTML;
    var send = document.querySelector('[data-dm-send]'), canSend = doc.querySelector('[data-dm-send]');
    if (Boolean(send) !== Boolean(canSend) && (!send || !send.querySelector('textarea').value)) { stop(); location.reload(); return; }
    if (added.length) announce(added, nearEnd, 'message');
  }

  // The inbox: the list of conversations, redrawn when it changes.
  function mergeInbox(doc) {
    var now = root.querySelector('[data-live-inbox]'), next = doc.querySelector('[data-live-inbox]');
    if (now && next && now.innerHTML !== next.innerHTML) now.innerHTML = next.innerHTML;
  }

  function mergeThread(doc) {
    var box = document.querySelector('[data-live-thread="' + threadId + '"]');
    var next = doc.querySelector('[data-live-thread]');
    if (!box || !next) return;
    var nearEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 300;
    var added = mergeArticles(box, next);
    // The heading's tags and reply count (pinned, solved, locked, number of replies).
    var tags = document.querySelector('.thread-tags'), newTags = doc.querySelector('.thread-tags');
    if (tags && newTags && tags.innerHTML !== newTags.innerHTML) tags.innerHTML = newTags.innerHTML;
    // The video call banner (who is on a call, the Join button), unless this person is in a call right now.
    var banner = document.querySelector('[data-call-banner]'), newBanner = doc.querySelector('[data-call-banner]');
    if (banner && newBanner && !window.__callActive && banner.innerHTML !== newBanner.innerHTML) banner.innerHTML = newBanner.innerHTML;
    var title = document.querySelector('.thread-title'), newTitle = doc.querySelector('.thread-title');
    if (title && newTitle && title.textContent !== newTitle.textContent) { title.textContent = newTitle.textContent; document.title = doc.title || document.title; }
    // Locked or unlocked since this page was drawn: the reply box appears or goes. With nothing typed, redraw the whole page.
    var form = document.querySelector('form[data-reply]');
    if (Boolean(form) !== Boolean(doc.querySelector('form[data-reply]')) && (!form || !form.querySelector('textarea').value)) { stop(); location.reload(); return; }
    if (added.length) announce(added, nearEnd);
  }

  // New replies: follow them if the reader is at the bottom, otherwise offer a button, so reading is never yanked away.
  function announce(added, follow, noun) {
    noun = noun || 'reply';
    if (follow) { added[added.length - 1].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button'; pill.className = 'live-new';
      pill.addEventListener('click', function () { var t = document.getElementById(pill.getAttribute('data-first')); if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' }); clear(); });
      document.body.appendChild(pill);
      window.addEventListener('scroll', check, { passive: true });
    }
    pill.count = (pill.count || 0) + added.length;
    if (!pill.getAttribute('data-first')) pill.setAttribute('data-first', added[0].id);
    pill.textContent = pill.count + (noun === 'message' ? (pill.count === 1 ? ' new message ↓' : ' new messages ↓') : (pill.count === 1 ? ' new reply ↓' : ' new replies ↓'));
  }
  function check() {
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120) clear();
  }
  function clear() {
    window.removeEventListener('scroll', check);
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
    pill = null;
  }

  // The lists of threads: replace what changed, leaving the search box and everything else alone.
  function mergeLists(doc) {
    var sel = '.section-grid, [data-live-list]';
    var now = root.querySelectorAll(sel), next = doc.querySelectorAll(sel);
    if (now.length !== next.length) return;
    Array.prototype.forEach.call(now, function (el, i) {
      if (el.outerHTML !== next[i].outerHTML) el.parentNode.replaceChild(document.importNode(next[i], true), el);
    });
  }

  function startPolling() { if (!poll) poll = setInterval(function () { if (!document.hidden) refresh(); }, 20000); }

  function connect() {
    if (stopped) return;
    es = new EventSource('/live/stream?topics=' + encodeURIComponent(topics));
    es.onopen = function () {
      opened = true; clearInterval(poll); poll = null; clearTimeout(watchdog);
      if (everOpened) schedule();                              // reconnected: whatever was missed in between comes now
      everOpened = true;
    };
    es.addEventListener('update', schedule);
    // Messages meant for this person alone (setting up a video call) are handed to the call script.
    es.addEventListener('signal', function (e) { try { window.dispatchEvent(new CustomEvent('portal-signal', { detail: JSON.parse(e.data) })); } catch (x) { /* ignore a garbled one */ } });
    es.addEventListener('ping', function () { if (!here()) stop(); });
    es.addEventListener('bye', function () { stop(); location.reload(); });   // locked, signed out or switched off: the page sorts out where to go
    es.onerror = function () {
      opened = false;
      if (es && es.readyState === 2) { es.close(); es = null; startPolling(); refresh(); }   // refused (locked, signed out, too many tabs): ask now and then
      else { clearTimeout(watchdog); watchdog = setTimeout(function () { if (!opened) startPolling(); }, 10000); }
    };
    // A connection that never opens (something in between holds it back) is covered by asking now and then.
    watchdog = setTimeout(function () { if (!opened) startPolling(); }, 10000);
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden && dirty) refresh(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted && !stopped) { if (!es) connect(); refresh(); } });
  window.addEventListener('pagehide', function () { if (es) es.close(); });
  connect();
})();
