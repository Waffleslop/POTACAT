'use strict';
/**
 * Wait for a promise at most `ms`; past that, resolve with `fallback` (and
 * report it), never reject. The work itself is not cancelled: a QRZ lookup
 * that finishes late still fills QRZ's cache for the next contact.
 *
 * Used where an optional enrichment must never hold up the thing it enriches:
 * logContact waited for every QRZ lookup before saving, so a slow QRZ held the
 * Activator log button for seconds, and a second press saved the contact
 * twice (.eddiejames, 150-QSO activation, 2026-11-05).
 */
function withTimeout(promise, ms, { fallback = null, onTimeout } = {}) {
  let timer = null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => { if (onTimeout) { try { onTimeout(); } catch { /* reporting only */ } } finish(fallback); }, ms);
    Promise.resolve(promise).then(finish, () => finish(fallback));
  });
}

module.exports = { withTimeout };
