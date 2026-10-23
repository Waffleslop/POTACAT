// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Outbound fetch never OFFERS Brotli (2026-10-23).
//
// CVE-2026-111497: an out-of-bounds write in Node's bundled Brotli decoder,
// fixed in Node 22.23.4 / 24.22.1 on 2026-10-21. Electron 39 (POTACAT's,
// Node 22.22.1) is out of support and will never carry the fix, and as of
// 10/23 no Electron release does. Node's global fetch (undici) decodes a
// `Content-Encoding: br` response body through that decoder, and it offers
// `br` whenever the caller sets no Accept-Encoding, so every one of
// POTACAT's ~16 fetch sites invited a Brotli body from the host it called.
//
// This installs ONE rule at startup: when a request names no
// Accept-Encoding, send `gzip, deflate`. A compliant server (Cloudflare in
// front of api.potacat.com included) then never sends Brotli and the
// decoder is never reached. What it does NOT do: stop a hostile server from
// sending `br` unasked — undici still decodes that. So this narrows the
// exposure to a compromised host or an HTTPS MITM; the full fix is the
// Electron upgrade (memory: electron_39_eol_brotli_cve). A caller that sets
// its own Accept-Encoding is left alone. The https.request paths are not
// touched: they never decode a body on their own.

'use strict';

const SAFE_ACCEPT_ENCODING = 'gzip, deflate';

/** Return init with Accept-Encoding set when the caller named none. Pure. */
function withoutBrotli(init) {
  const o = init && typeof init === 'object' ? init : {};
  const h = new Headers(o.headers || undefined);
  if (!h.has('accept-encoding')) h.set('accept-encoding', SAFE_ACCEPT_ENCODING);
  return { ...o, headers: h };
}

/**
 * Wrap `target.fetch` once. Idempotent. A Request object as the first
 * argument carries its own headers; those are honoured the same way.
 */
function installNoBrotliFetch(target = globalThis) {
  if (!target || typeof target.fetch !== 'function' || target.fetch._potacatNoBrotli) return false;
  const original = target.fetch;
  const wrapped = function fetch(input, init) {
    if (input && typeof input === 'object' && typeof input.url === 'string' && input.headers && (!init || !init.headers)) {
      // A Request: its headers travel with it; merge there.
      const h = new Headers(input.headers);
      if (!h.has('accept-encoding')) {
        h.set('accept-encoding', SAFE_ACCEPT_ENCODING);
        input = new Request(input, { headers: h });
      }
      return original.call(this, input, init);
    }
    return original.call(this, input, withoutBrotli(init));
  };
  wrapped._potacatNoBrotli = true;
  wrapped._original = original;
  target.fetch = wrapped;
  return true;
}

module.exports = { SAFE_ACCEPT_ENCODING, withoutBrotli, installNoBrotliFetch };
