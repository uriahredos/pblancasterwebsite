'use strict';
// The address a request really came from, for throttling sign-in attempts.
// On Render every request arrives through Cloudflare, which states the visitor's address in its own header and
// refuses requests that try to supply that header themselves. Anywhere else, Express works it out from the proxy chain.
const net = require('net');
const { ipKeyGenerator } = require('express-rate-limit');

function clientIp(req) {
  if (process.env.RENDER) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf)) return cf;
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** The key the sign-in throttles count by: one visitor's address (a whole /56 for IPv6, which is one household or site). */
const rateKey = (req) => ipKeyGenerator(clientIp(req));

module.exports = { clientIp, rateKey };
