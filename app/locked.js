'use strict';
// What the site shows when it cannot open its own database: the key in the hosting settings is missing or wrong, the
// file is damaged or missing, or a restore that was asked for could not be done. This says so in plain words, in the
// browser, instead of leaving a failed start that only shows up in a server log. It knows nothing and serves nothing else.
const http = require('http');

const KEY_ADVICE = 'Open the hosting settings (Render, then the service, then Environment), put the right value back in <code>DB_KEY</code> and save. The site restarts by itself and opens normally.';
const page = (reason, advice, safe) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>PB Portal is closed for the moment</title>
<style>body{font-family:Verdana,Geneva,sans-serif;background:#eef2f7;color:#00314f;margin:0;padding:24px;line-height:1.6}
main{max-width:640px;margin:8vh auto;background:#fff;border-radius:12px;padding:28px 32px;border-top:6px solid #00b10b}
h1{font-size:1.4rem;margin:0 0 12px}p{margin:0 0 12px}.hint{color:#55606b;font-size:.92rem}</style></head>
<body><main>
<h1>PB Portal is closed for the moment</h1>
<p>The site cannot open its database, so nobody can sign in right now.${safe ? ' Nothing has been lost.' : ''}</p>
<p><strong>If you look after this site:</strong> ${reason} ${advice}</p>
<p class="hint">Everyone else: please try again a little later.</p>
</main></body></html>`;

/**
 * Answer every request with the explanation. The health check passes, so the host keeps this page reachable.
 * `how` may carry `advice` (what to do, when it is not the key that needs putting right) and `safe` (false when
 * "nothing has been lost" cannot honestly be said, as with a damaged or missing file).
 */
function serve(port, reason, how) {
  const text = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const other = how && how.advice ? String(how.advice) : '';
  const html = page(text(reason), other ? text(other) : KEY_ADVICE, other ? Boolean(how.safe) : true);
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('locked'); }
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
  server.listen(port, () => console.error(other
    ? `[database] ${reason} ${other} The site is showing a "closed" page on port ${port} until then.`
    : `[database key] ${reason} The site is showing a "closed" page on port ${port} until DB_KEY is put right.`));
  return server;
}

module.exports = { serve };
