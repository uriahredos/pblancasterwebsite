'use strict';
// Simple formatting for messages people write: bold, italic, lists, quotes, links. The text is escaped first, so
// nothing a person types can become page code; only the few marks below are turned into formatting.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Formatting inside one line. `text` is raw; the result is safe HTML. */
function inline(text) {
  const held = [];
  const hold = (html) => { held.push(html); return `\u0000${held.length - 1}\u0000`; };
  let s = String(text);
  // Code first, so marks inside it are left alone.
  s = s.replace(/`([^`\n]+)`/g, (m, code) => hold(`<code>${esc(code)}</code>`));
  // [words](https://link) and bare links. Only http and https are ever made clickable.
  s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g, (m, words, url) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(words)}</a>`));
  s = s.replace(/\bhttps?:\/\/[^\s<]{1,500}/g, (url) => { const tail = /[.,;:!?)]+$/.exec(url); const clean = tail ? url.slice(0, -tail[0].length) : url; return hold(`<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer nofollow">${esc(clean)}</a>`) + (tail ? tail[0] : ''); });
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => held[Number(i)]);
}

/** A whole message as safe HTML: paragraphs, line breaks, bullet and numbered lists, quotes, small headings. */
function render(text, depth = 0) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  const out = []; let para = [], list = null, quote = [];
  const endPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const endList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  // Quotes inside quotes stop at four levels: deeper than that the marks are shown as typed.
  const endQuote = () => { if (quote.length) { out.push(depth >= 4 ? `<p>${quote.map((q) => inline(`> ${q}`)).join('<br>')}</p>` : `<blockquote>${render(quote.join('\n'), depth + 1)}</blockquote>`); quote = []; } };
  const endAll = () => { endPara(); endList(); endQuote(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { endAll(); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { endPara(); endList(); quote.push(m[1]); continue; }
    endQuote();
    if ((m = /^\s*[-*•]\s+(.+)$/.exec(line))) { endPara(); if (!list || list.tag !== 'ul') { endList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line))) { endPara(); if (!list || list.tag !== 'ol') { endList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    endList();
    if ((m = /^#{1,3}\s+(.+)$/.exec(line))) { endPara(); out.push(`<p class="msg-h"><strong>${inline(m[1])}</strong></p>`); continue; }
    para.push(line);
  }
  endAll();
  return out.join('');
}

/** The same message with the marks taken out, for notifications and one-line previews. */
function plain(text) {
  return String(text || '').replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1').replace(/^\s*(>|[-*•]|#{1,3})\s?/gm, '').replace(/\s+/g, ' ').trim();
}

module.exports = { render, inline, plain };
