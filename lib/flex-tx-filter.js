// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The Flex transmit filter (the TX passband, Hz above the carrier in USB).
//
// Verified against FlexLib 1.6.17, FlexLib/Radio.cs (public mirror
// systechllc/FlexCommunityAPIWork, FlexAPI/FlexLib_API_v1.6.17):
// - _SetTXFilter (about lines 5950-5966) sends ONE command with both edges,
//   `transmit set filter_low=<lo> filter_high=<hi>`; it returns early when
//   low >= high, clamps high to <= 10000 and low to >= 0. The TXFilterLow /
//   TXFilterHigh setters keep low <= high - 50 and high >= low + 50.
// - ParseTransmitStatus (line 6748 on) reads lo=, hi= and
//   tx_filter_changes_allowed= from the transmit status:
//     S<handle>|transmit freq=14.100000 rfpower=69 ... lo=100 hi=3100 tx_filter_changes_allowed=1 ...
//   (8600M v4.2.20 GUI capture, 2026-11-17).
// FlexLib sends the set with no reply handler, so the reply is not
// documented there: R<seq>|0| is taken as success and any non-zero status
// as a failure (not yet verified on the radio).
//
// Both edges always go in one command: two commands would pass through an
// intermediate filter where low >= high (restoring 2100-2800 over 1400-2000,
// for example), which FlexLib itself never sends.
'use strict';

const MIN_WIDTH_HZ = 50;
const MAX_HIGH_HZ = 10000;

/**
 * The TX filter in a transmit status body ("freq=... lo=100 hi=3100 ..."):
 * { filter:{lo,hi}|null, lo, hi, allowed }. `allowed` is
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

/** Within FlexLib's limits: whole Hz, 0 <= low, high <= 10000, high - low >= 50. */
function validTxFilter(f) {
  if (!f || f.lo == null || f.hi == null || f.lo === '' || f.hi === '') return false;
  const lo = Number(f.lo), hi = Number(f.hi);
  return Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi <= MAX_HIGH_HZ && hi - lo >= MIN_WIDTH_HZ;
}

/** The one command that sets both edges, or null when the filter is outside FlexLib's limits (never sent). */
function txFilterCommand(f) {
  if (!validTxFilter(f)) return null;
  return `transmit set filter_low=${Number(f.lo)} filter_high=${Number(f.hi)}`;
}

module.exports = { MIN_WIDTH_HZ, MAX_HIGH_HZ, parseTxFilter, validTxFilter, txFilterCommand };
