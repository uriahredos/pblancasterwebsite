'use strict';
// A simple per-person allowance (so many of a thing in a window of time), so a stuck page or a mistake cannot flood the
// site or an outside service. Held in memory.
const used = new Map();

function allow(userId, kind, max, windowMs, now = Date.now()) {
  const key = `${kind}:${userId}`;
  const hits = (used.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { used.set(key, hits); return false; }
  hits.push(now); used.set(key, hits);
  if (used.size > 5000) for (const [k, v] of used) if (!v.some((t) => now - t < windowMs)) used.delete(k);
  return true;
}

module.exports = { allow };
