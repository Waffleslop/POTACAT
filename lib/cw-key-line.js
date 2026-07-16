'use strict';

// Resolve which serial modem-control line(s) key CW on the main CAT port.
//
// A rig model supplies a default (cw.dtrPins), but the radio's own "USB Keying
// (CW)" menu can be set to either DTR or RTS — and the two vendors' docs don't
// agree (the IC-7300's documented default is RTS, e.g. fldigi/HRD/N1MM). Rather
// than force the operator to reconfigure the radio to match POTACAT, a per-rig
// override (rig.cwKeyLine) lets them tell POTACAT which line their radio reads.
//
// Returns { dtr: boolean, rts: boolean } — which line(s) follow the key. The
// caller (RigController.setCwKeyDtr) drives the chosen line(s) with the key and
// forces the other LOW, so node-serialport can't latch it high.
//
// Pure + dependency-free so it's unit-testable and usable from both main and
// the transport layer.

/**
 * @param {object} o
 * @param {{dtr?:boolean, rts?:boolean}} [o.modelPins] - rig model cw.dtrPins default
 * @param {string} [o.cwKeyLine] - per-rig override: 'auto' | 'dtr' | 'rts' | 'both'
 * @returns {{ dtr: boolean, rts: boolean }}
 */
function resolveCwKeyPins({ modelPins, cwKeyLine } = {}) {
  const line = String(cwKeyLine || 'auto').toLowerCase();
  if (line === 'dtr') return { dtr: true, rts: false };
  if (line === 'rts') return { dtr: false, rts: true };
  if (line === 'both') return { dtr: true, rts: true };
  // 'auto' / unset / unrecognized → fall back to the rig model default.
  const p = modelPins || { dtr: true, rts: false };
  return { dtr: !!p.dtr, rts: !!p.rts };
}

module.exports = { resolveCwKeyPins };
