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

/**
 * Line(s) the dedicated CW Key Port drives: an external USB-serial adapter, a
 * QMX second port, or a Yaesu's second ("Standard") USB COM port. The default
 * is the model's key pins only when they include DTR (QMX = DTR+RTS);
 * otherwise DTR, the near-universal default for a key adapter and the Yaesu
 * "PC KEYING = DTR" case. The per-rig cwKeyLine override still wins. The
 * radio's main-port pins are deliberately NOT the default here: an IC-7300's
 * RTS USB-keying line says nothing about an adapter on a different port.
 *
 * @param {object} o
 * @param {{dtr?:boolean, rts?:boolean}} [o.modelPins]
 * @param {string} [o.cwKeyLine]
 * @returns {{ dtr: boolean, rts: boolean }}
 */
function resolveKeyPortPins({ modelPins, cwKeyLine } = {}) {
  const def = (modelPins && modelPins.dtr) ? modelPins : { dtr: true, rts: false };
  return resolveCwKeyPins({ modelPins: def, cwKeyLine });
}

/** 'DTR' | 'RTS' | 'DTR+RTS' for a resolved pin pair. */
function keyLineLabel(pins) {
  if (pins && pins.dtr && pins.rts) return 'DTR+RTS';
  return pins && pins.rts ? 'RTS' : 'DTR';
}

module.exports = { resolveCwKeyPins, resolveKeyPortPins, keyLineLabel };
