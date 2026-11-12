// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Why a WebSDR / KiwiSDR / rtl_tcp receiver would not come on, in plain words
// (#390). A receiver that is offline used to look like any other in the VFO
// window's SDR list, and pressing its button did nothing: main logged
// "[WebSDR] Error: Opening handshake has timed out" ten seconds later and the
// window ignored it. The window now says "<name> did not answer" (or "is
// full", "needs a password") with Try again, and marks that receiver in the
// list for the rest of the session. Nothing pings receivers in the background
// (agreed in the thread): a receiver is only marked after the operator tried it.
// Pure, dual-mode: `require` in tests, `window.SdrFailure` in the VFO window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SdrFailure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Order matters: the first rule whose pattern matches the raw error wins.
  var RULES = [
    { kind: 'apps', re: /does not allow apps/i, words: 'only allows its own web page, not apps' },
    { kind: 'full', re: /too_busy|server may be full|no audio slot|public slots? taken|is full/i, words: 'is full' },
    { kind: 'callsign', re: /identification required|badp=5/i, words: 'needs your callsign (Settings > Station)' },
    { kind: 'password', re: /bad password|badp=|auth rejected|password/i, words: 'needs a password' },
    { kind: 'no-answer', re: /handshake has timed out|timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|Unexpected server response|no audio received|did not answer|closed before the connection/i, words: 'did not answer' },
  ];

  /** { kind, words } for a raw error text from lib/kiwisdr.js, lib/websdr.js or rtl_tcp. */
  function classify(raw) {
    var s = String(raw == null ? '' : raw);
    for (var i = 0; i < RULES.length; i++) if (RULES[i].re.test(s)) return { kind: RULES[i].kind, words: RULES[i].words };
    return { kind: 'other', words: 'could not be reached' };
  }

  /** The sentence the VFO window shows: "Twente did not answer." */
  function message(name, raw) {
    var who = String(name || '').trim() || 'The receiver';
    return who + ' ' + classify(raw).words + '.';
  }

  /** The short mark beside a receiver in the list after it failed this session. */
  function mark(kind) {
    if (kind === 'full') return 'full';
    if (kind === 'password' || kind === 'callsign') return 'needs a password';
    if (kind === 'apps') return 'web page only';
    return 'did not answer';
  }

  // "pw@host:port", "http://host:8073/", "HOST" -> "host:port"; a host with
  // no port is a KiwiSDR on 8073, as main.js 'kiwi-connect' treats it.
  function hostKey(h) {
    var s = String(h == null ? '' : h).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    var at = s.lastIndexOf('@');
    if (at >= 0) s = s.slice(at + 1);
    s = s.toLowerCase();
    if (!s) return '';
    return /:\d+$/.test(s) ? s : s + ':8073';
  }

  /** Whether two ways of writing a receiver's address are the same receiver. */
  function sameHost(a, b) {
    var ka = hostKey(a);
    return !!ka && ka === hostKey(b);
  }

  return { classify: classify, message: message, mark: mark, hostKey: hostKey, sameHost: sameHost };
});
