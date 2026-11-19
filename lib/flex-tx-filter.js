// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The Flex transmit filter (the TX passband, Hz above the carrier in USB).
//
// Readback: the transmit status the radio sends after `sub tx all` carries
// it as lo= and hi=, with tx_filter_changes_allowed= beside them:
//   S<handle>|transmit freq=14.100000 rfpower=69 ... lo=100 hi=3100 tx_filter_changes_allowed=1 ...
// (8600M v4.2.20 GUI capture, 2026-11-17.)
//
// Write: `transmit set filter_low=<Hz>` and `transmit set filter_high=<Hz>`,
// the commands FlexLib's Radio.cs sends for TXFilterLow / TXFilterHigh (one
// key per command), which also keeps low at least 50 Hz under high. So the
// edge that would cross the other goes first.
'use strict';

const MIN_GAP_HZ = 50;

/**
 * The TX filter in a transmit status body ("freq=... lo=100 hi=3100 ..."),
 * or null when the line does not carry both edges. `allowed` is
 * tx_filter_changes_allowed (true/false), or null when the line omits it.
 */
function parseTxFilter(body) {
  const s = ' ' + String(body || '');
  const num = (k) => { const m = s.match(new RegExp(' ' + k + '=(-?\\d+)(?: |$)')); return m ? Number(m[1]) : null; };
  const lo = num('lo');
  const hi = num('hi');
  const a = s.match(/ tx_filter_changes_allowed=([01])(?: |$)/);
  return {
    filter: lo != null && hi != null ? { lo, hi } : null,
    lo, hi,
    allowed: a ? a[1] === '1' : null,
  };
}

/**
 * The commands that move the TX filter from `from` to `to`, edge by edge,
 * in an order the radio accepts: when the new low edge would sit at or above
 * the current high edge (less the 50 Hz gap), the high edge moves first.
 * An edge already in place is not sent, unless opts.force (a put-back that
 * must not trust a readback that may not have caught up).
 */
function txFilterCommands(from, to, opts = {}) {
  const lo = Math.round(Number(to.lo));
  const hi = Math.round(Number(to.hi));
  const f = from && Number.isFinite(Number(from.lo)) && Number.isFinite(Number(from.hi)) ? { lo: Number(from.lo), hi: Number(from.hi) } : null;
  const loCmd = (opts.force || !f || f.lo !== lo) ? `transmit set filter_low=${lo}` : null;
  const hiCmd = (opts.force || !f || f.hi !== hi) ? `transmit set filter_high=${hi}` : null;
  const highFirst = f ? lo >= f.hi - MIN_GAP_HZ : false;
  return (highFirst ? [hiCmd, loCmd] : [loCmd, hiCmd]).filter(Boolean);
}

module.exports = { MIN_GAP_HZ, parseTxFilter, txFilterCommands };
