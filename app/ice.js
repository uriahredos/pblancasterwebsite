'use strict';
// The servers a phone uses to find a way to the other phone: free STUN always, and Cloudflare's TURN relay when the site has
// a TURN key. The relay's password is made fresh for each call, lasts two hours and is only ever asked for here, on the
// server: the key and token never reach a browser.
const config = require('./config');

const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const TTL_SECONDS = 2 * 60 * 60;

/** { servers, relay }: relay is true when Cloudflare's TURN credentials were obtained. */
async function iceServers() {
  const { keyId, token } = config.turn;
  if (!keyId || !token) return { servers: STUN, relay: false };
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Cloudflare answered ${res.status}`);
    const body = await res.json();
    // Port 53 is one browsers block, so it is left out.
    const servers = [].concat(body.iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) })).filter((s) => s.urls.length);
    if (!servers.length) throw new Error('no servers in the answer');
    return { servers, relay: true };
  } catch (e) {
    console.error('[call] relay credentials unavailable, using STUN only:', e.message);
    return { servers: STUN, relay: false };
  }
}

module.exports = { iceServers };
