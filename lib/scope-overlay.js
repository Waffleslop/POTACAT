// lib/scope-overlay.js
//
// What the Band Scope draws ON TOP of the spectrum (docs/scope-improvements-
// plan.md Phase 3): the receiver's passband, and the band plan around the
// dial — band edges, the operator's privileges and the digital-mode dials.
// Pure; main.js builds both from the rig state and sends them in scope-state,
// so the pop-out, ECHOCAT Web, the JTCAT strip and the phone draw the same
// thing. lib/scope-view.js turns them into pixels.
//
// The passband is sent as OFFSETS from the dial, so it changes only when the
// mode or filter does — never on a tune.
'use strict';

const { BANDS } = require('./bands');
const { PRIVILEGE_MAP } = require('./privileges');

// The width drawn (dashed, labelled "nominal") when the radio does not
// report one. Never filled: it must not be mistaken for a reading.
const NOMINAL_WIDTH = { ssb: 2400, cw: 500, digital: 3000, am: 6000, fm: 12000 };
// An SSB / data passband starts this far from the carrier.
const SIDEBAND_LOW_HZ = 100;

// The JTTY and PSK31 dials (kHz) — verbatim copies of the JTCAT window's
// JTTY_BAND_FREQS / PSK_BAND_FREQS (renderer/jtcat-popout.js); test/scope-
// overlay-test.js fails if the two drift. FT8/FT4/FT2 come from
// lib/ft8-engine.js freqsForMode, passed in by main.
const JTTY_DIALS = {
  '160m': 1838, '80m': 3575, '60m': 5357, '40m': 7090, '30m': 10140,
  '20m': 14090, '17m': 18100, '15m': 21090, '12m': 24920, '10m': 28090,
  '6m': 50160, '2m': 144160,
};
const PSK_DIALS = {
  '160m': 1838, '80m': 3580, '60m': 5357, '40m': 7070, '30m': 10142,
  '20m': 14070, '17m': 18100, '15m': 21070, '12m': 24920, '10m': 28120,
  '6m': 50291,
};

const CLASS_LABELS = {
  us_extra: 'Extra', us_general: 'General', us_technician: 'Technician',
  ca_basic: 'Basic', ca_honours: 'Basic with Honours',
};

/**
 * How a mode name sits around the dial: 'upper' | 'lower' | 'centre' |
 * 'symmetric', plus which nominal width applies. Null for a mode with no
 * passband worth drawing (unknown / empty).
 */
function modeShape(mode) {
  const m = String(mode || '').toUpperCase().replace(/\s+/g, '');
  if (!m) return null;
  if (m === 'CW' || m === 'CW-R' || m === 'CWR' || m === 'CW-L' || m === 'CW-U') return { side: 'centre', kind: 'cw' };
  if (/^(RTTY|RTTY-R|FSK|FSK-R)$/.test(m)) return { side: 'centre', kind: 'cw' };
  if (/^(AM|SAM|AM-D|AMN)$/.test(m)) return { side: 'symmetric', kind: 'am' };
  if (/^(FM|NFM|WFM|FMN|FM-D|DFM|C4FM|DV)$/.test(m)) return { side: 'symmetric', kind: 'fm' };
  if (/^(LSB|DIGL|PKTLSB|DATA-L|LSB-D\d?|DATAL)$/.test(m)) return { side: 'lower', kind: /^LSB$/.test(m) ? 'ssb' : 'digital' };
  if (/^(USB|SSB)$/.test(m)) return { side: 'upper', kind: 'ssb' };
  if (/^(DIGU|PKTUSB|DATA|DATA-U|DATAU|USB-D\d?|DIGI|FT8|FT4|FT2|JS8|PSK|PSK31|JTTY|WSPR|SSTV|FREEDV)$/.test(m)) return { side: 'upper', kind: 'digital' };
  return null;
}

/**
 * The passband as dial offsets: { loOffsetHz, hiOffsetHz, reported, kind }.
 *  - flexLo/flexHi: the Flex slice's own filter edges (filter_lo/filter_hi,
 *    already dial-relative, LSB negative) — the real edges, used as they are.
 *  - widthHz: the width the radio reported (any rig); placed by the mode.
 *  - neither: the mode's nominal width, reported:false (drawn dashed).
 */
function passbandFor(opts) {
  const o = opts || {};
  const shape = modeShape(o.mode);
  if (!shape) return null;
  const lo = Number(o.flexLo), hi = Number(o.flexHi);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
    return { loOffsetHz: Math.round(lo), hiOffsetHz: Math.round(hi), reported: true, kind: shape.kind };
  }
  const reported = Number(o.widthHz) > 0;
  const w = reported ? Math.round(Number(o.widthHz)) : NOMINAL_WIDTH[shape.kind];
  let a, b;
  if (shape.side === 'upper') { a = SIDEBAND_LOW_HZ; b = SIDEBAND_LOW_HZ + w; }
  else if (shape.side === 'lower') { a = -(SIDEBAND_LOW_HZ + w); b = -SIDEBAND_LOW_HZ; }
  else { a = -Math.round(w / 2); b = a + w; }
  return { loOffsetHz: a, hiOffsetHz: b, reported, kind: shape.kind };
}

/** The band (from lib/bands.js) holding `hz`, as { name, loHz, hiHz }. */
function bandAt(hz) {
  const mhz = Number(hz) / 1e6;
  for (const [name, b] of Object.entries(BANDS)) {
    if (mhz >= b.lower && mhz <= b.upper) return { name, loHz: Math.round(b.lower * 1e6), hiHz: Math.round(b.upper * 1e6) };
  }
  return null;
}

/**
 * The band plan around the dial:
 *   { band, loHz, hiHz, licenseClass, classLabel, allowed, dials }
 *  - allowed: null when no licence class is set (band edges only), else the
 *    class's ranges inside this band as [{loHz, hiHz, kind: cw_digi|phone|all}]
 *    — everything else in the band is outside the operator's privileges.
 *  - dials: [{hz, label}] — the digital-mode meeting places in this band,
 *    from tables main passes in ({ FT8: {'20m': 14074}, ... } in kHz).
 * Null when the dial is in no amateur band.
 */
function bandPlanFor(dialHz, opts) {
  const o = opts || {};
  const band = bandAt(dialHz);
  if (!band) return null;
  const cls = o.licenseClass && o.licenseClass !== 'none' && PRIVILEGE_MAP[o.licenseClass] ? o.licenseClass : null;
  let allowed = null;
  if (cls) {
    allowed = [];
    for (const [lk, uk, kind] of PRIVILEGE_MAP[cls]) {
      const lo = Math.max(band.loHz, lk * 1000), hi = Math.min(band.hiHz, uk * 1000);
      if (hi > lo) allowed.push({ loHz: lo, hiHz: hi, kind });
    }
  }
  const dials = [];
  const tables = o.dials || {};
  for (const label of Object.keys(tables)) {
    const khz = tables[label] && tables[label][band.name];
    if (khz > 0) dials.push({ hz: Math.round(khz * 1000), label });
  }
  dials.sort((a, b) => a.hz - b.hz);
  return {
    band: band.name, loHz: band.loHz, hiHz: band.hiHz,
    licenseClass: cls, classLabel: cls ? CLASS_LABELS[cls] : null,
    allowed, dials,
  };
}

module.exports = { NOMINAL_WIDTH, SIDEBAND_LOW_HZ, CLASS_LABELS, JTTY_DIALS, PSK_DIALS, modeShape, passbandFor, bandAt, bandPlanFor };
