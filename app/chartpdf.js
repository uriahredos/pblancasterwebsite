'use strict';
// The organization chart as a PDF: the same boxes and lines as the page, laid out here and drawn with pdfkit.
// The page is made as large as the chart needs (never smaller than a landscape letter sheet), so nothing is
// squeezed; a printer's "fit to page" handles the rest.
const path = require('path');
const PDFDocument = require('pdfkit');

const NAVY = '#00314F', BLUE = '#005BB9', GREEN = '#00B10B', GRAY = '#939598', INK = '#0f2233';
const BOX_W = 150, BOX_H = 40, GAP_X = 16, GAP_Y = 34, LINE = 12, CREW_HEAD = 22, MARGIN = 36, HEADER = 78;

/** Turn the chart's people into drawable nodes: a box per person who leads others, and one box per group of people with the same role under them. */
function shape(person, level) {
  const lead = person.reports.filter((k) => k.reports.length), crew = person.reports.filter((k) => !k.reports.length);
  const groups = [];
  for (const k of crew) { const key = (k.job_title || '').toLowerCase(); let g = groups.find((x) => x.key === key); if (!g) { g = { key, title: k.job_title || 'Team', people: [] }; groups.push(g); } g.people.push(k); }
  groups.sort((a, b) => a.people.length - b.people.length || a.title.localeCompare(b.title));
  const kids = lead.map((k) => shape(k, level + 1));
  for (const g of groups) {
    if (g.people.length === 1) kids.push({ kind: 'person', level: level + 1, title: g.title, name: g.people[0].display_name, w: BOX_W, h: BOX_H, kids: [] });
    else kids.push({ kind: 'crew', title: g.title + (/s$/i.test(g.title) || g.title === 'Team' ? '' : 's'), names: g.people.map((p) => p.display_name), w: BOX_W, h: CREW_HEAD + LINE * g.people.length + 8, kids: [] });
  }
  return { kind: 'person', level, title: person.job_title || person.department || 'Team lead', name: person.display_name, w: BOX_W, h: BOX_H, kids };
}

/** Width a node and everything under it needs. */
function measure(n) { n.span = Math.max(n.w, n.kids.reduce((s, k) => s + measure(k), 0) + GAP_X * Math.max(0, n.kids.length - 1)); return n.span; }
/** Place a node with its span starting at x; children are spread under it and it sits centered over them. */
function place(n, x, y) {
  n.y = y; let cx = x + (n.span - (n.kids.reduce((s, k) => s + k.span, 0) + GAP_X * Math.max(0, n.kids.length - 1))) / 2;
  for (const k of n.kids) { place(k, cx, y + n.h + GAP_Y); cx += k.span + GAP_X; }
  n.x = n.kids.length ? (n.kids[0].x + n.kids.at(-1).x + n.kids.at(-1).w) / 2 - n.w / 2 : x + (n.span - n.w) / 2;
}
const bottom = (n) => Math.max(n.y + n.h, ...n.kids.map(bottom));

/** Write the chart for one office to `stream`. `teamChart` is what team.chart() returns. */
function write(stream, { office, teamChart, when }) {
  const tops = teamChart.tops.map((t) => shape(t, 1));
  let width = 0; for (const t of tops) { measure(t); width += t.span; } width += GAP_X * 2 * Math.max(0, tops.length - 1);
  let x = 0; for (const t of tops) { place(t, x, 0); x += t.span + GAP_X * 2; }
  const height = tops.length ? Math.max(...tops.map(bottom)) : 0;
  const rest = teamChart.rest; const restH = rest.length ? 30 + LINE * Math.ceil(rest.length / 4) : 0;
  const pageW = Math.max(792, width + MARGIN * 2), pageH = Math.max(612, HEADER + height + restH + MARGIN * 2);
  const doc = new PDFDocument({ size: [pageW, pageH], margin: 0, info: { Title: `${office.name} office organization chart`, Author: 'PB Portal' } });
  doc.pipe(stream);

  // Header: the logo as it is, the office, the date.
  try { doc.image(path.join(__dirname, '..', 'public', 'logo.png'), MARGIN, 24, { height: 34 }); } catch (e) { /* the chart still prints without it */ }
  doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text(`${office.name} office`, MARGIN + 150, 26, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(`Organization chart · ${when}`, MARGIN + 150, 46, { lineBreak: false });
  doc.moveTo(MARGIN, 68).lineTo(pageW - MARGIN, 68).lineWidth(1).strokeColor(GREEN).stroke();

  const ox = (pageW - width) / 2, oy = HEADER + 10;
  const fit = (text, w, font, size) => { doc.font(font).fontSize(size); let t = String(text || ''); if (doc.widthOfString(t) <= w) return t; while (t.length > 1 && doc.widthOfString(t + '…') > w) t = t.slice(0, -1); return t + '…'; };
  const draw = (n) => {
    const bx = ox + n.x, by = oy + n.y;
    // Lines first, so boxes sit on top of them.
    if (n.kids.length) {
      const midY = by + n.h + GAP_Y / 2, px = bx + n.w / 2;
      doc.lineWidth(1.2).strokeColor(BLUE).opacity(0.6);
      doc.moveTo(px, by + n.h).lineTo(px, midY).stroke();
      const xs = n.kids.map((k) => ox + k.x + k.w / 2);
      doc.moveTo(Math.min(px, ...xs), midY).lineTo(Math.max(px, ...xs), midY).stroke();
      for (const kx of xs) doc.moveTo(kx, midY).lineTo(kx, by + n.h + GAP_Y).stroke();
      doc.opacity(1);
    }
    if (n.kind === 'crew') {
      doc.roundedRect(bx, by, n.w, n.h, 6).lineWidth(1.5).fillAndStroke('#ffffff', GREEN);
      doc.fillColor('#0b7a37').text(fit(n.title.toUpperCase(), n.w - 12, 'Helvetica-Bold', 8), bx, by + 7, { width: n.w, align: 'center', lineBreak: false });
      n.names.forEach((name, i) => doc.fillColor(INK).text(fit(name, n.w - 16, 'Helvetica', 8.5), bx + 8, by + CREW_HEAD + LINE * i, { lineBreak: false }));
    } else {
      const fill = n.level === 1 ? NAVY : n.level === 2 ? '#e3edf8' : '#c5d9f0', ink = n.level === 1 ? '#ffffff' : NAVY;
      doc.roundedRect(bx, by, n.w, n.h, 6).lineWidth(1.5).fillAndStroke(fill, n.level === 1 ? NAVY : BLUE);
      doc.fillColor(ink).text(fit(n.title.toUpperCase(), n.w - 12, 'Helvetica-Bold', 8), bx, by + 9, { width: n.w, align: 'center', lineBreak: false });
      doc.fillColor(ink).text(fit(n.name, n.w - 12, 'Helvetica', 10), bx, by + 22, { width: n.w, align: 'center', lineBreak: false });
    }
    n.kids.forEach(draw);
  };
  tops.forEach(draw);
  if (!tops.length) doc.font('Helvetica').fontSize(12).fillColor(INK).text('No chart yet: nobody in this office has a role that others report to.', MARGIN, oy);

  if (rest.length) {
    const ry = oy + height + 26, colW = (pageW - MARGIN * 2) / 4;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Not on the chart', MARGIN, ry, { lineBreak: false });
    rest.forEach((p, i) => doc.fillColor(INK).text(fit(p.display_name + (p.job_title ? `, ${p.job_title}` : ''), colW - 10, 'Helvetica', 8.5), MARGIN + colW * (i % 4), ry + 16 + LINE * Math.floor(i / 4), { lineBreak: false }));
  }
  doc.end();
}

module.exports = { write };
