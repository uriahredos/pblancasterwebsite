// Formatting buttons above a message box, and "Quote" on a post. They only put plain marks in the text
// (**bold**, *italic*, "- " for a list, "> " for a quote); the site turns those into formatting when it shows the message.
(function () {
  if (window.fmtBound) return; window.fmtBound = true;
  function boxFor(el) { var f = el.closest('form'); return f ? f.querySelector('textarea') : null; }
  function grow(t) { t.dispatchEvent(new Event('input', { bubbles: true })); }
  function wrap(t, before, after, filler) {
    var a = t.selectionStart, b = t.selectionEnd, picked = t.value.slice(a, b) || filler;
    t.setRangeText(before + picked + after, a, b, 'end');
    t.focus(); t.setSelectionRange(a + before.length, a + before.length + picked.length); grow(t);
  }
  function lines(t, mark) {
    var a = t.selectionStart, b = t.selectionEnd, start = t.value.lastIndexOf('\n', a - 1) + 1, end = t.value.indexOf('\n', b); if (end === -1) end = t.value.length;
    var block = t.value.slice(start, end) || 'Item';
    var done = block.split('\n').map(function (l, i) { return (typeof mark === 'function' ? mark(i) : mark) + l; }).join('\n');
    t.setRangeText(done, start, end, 'end'); t.focus(); grow(t);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-fmt]');
    if (b) {
      var t = boxFor(b); if (!t) return; e.preventDefault();
      var kind = b.getAttribute('data-fmt');
      if (kind === 'bold') wrap(t, '**', '**', 'bold words');
      else if (kind === 'italic') wrap(t, '*', '*', 'italic words');
      else if (kind === 'ul') lines(t, '- ');
      else if (kind === 'ol') lines(t, function (i) { return (i + 1) + '. '; });
      else if (kind === 'quote') lines(t, '> ');
      else if (kind === 'link') { var url = window.prompt('Paste the web address (it must start with http:// or https://)'); if (url && /^https?:\/\//i.test(url.trim())) wrap(t, '[', '](' + url.trim() + ')', 'link words'); }
      return;
    }
    var q = e.target.closest && e.target.closest('[data-quote]');
    if (q) {
      e.preventDefault();
      var reply = document.querySelector('form[data-reply] textarea'); var src = document.getElementById(q.getAttribute('data-quote'));
      if (!reply || !src) return;
      var text = src.value.trim().split('\n').map(function (l) { return '> ' + l; }).join('\n');
      reply.value = (reply.value ? reply.value.replace(/\s*$/, '') + '\n\n' : '') + '> **' + q.getAttribute('data-author') + ' wrote:**\n' + text + '\n\n';
      var menu = q.closest('details'); if (menu) menu.open = false;
      reply.focus(); reply.setSelectionRange(reply.value.length, reply.value.length); reply.scrollIntoView({ block: 'center', behavior: 'smooth' }); grow(reply);
    }
  });
})();
