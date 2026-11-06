'use strict';
/**
 * Where the Station Setup test transmit may key (w0tlp, 2026-11-02: refused
 * as out of band, with the radio in LSB). The test sends a 1000 Hz tone.
 *
 * 1. At the dial, judged by the radio's mode (a tone in USB/LSB is a phone
 *    emission there; anything else is data) — the 1.13.10 rule.
 * 2. If the operator's licence does not allow that, move to a clear spot in
 *    the band's data segment, test, and come back. Clear = the tone is at
 *    least 3.5 kHz from every FT8, FT4, FT2, JS8 and WSPR dial on the band
 *    and outside each one's 3 kHz passband, searching upward from just above
 *    the FT8 passband (transmit-safety review: the FT8 dial + 1 kHz put a 5 W
 *    carrier inside live FT8 QSOs for 3 s).
 *    The mode is never changed: the tone lands on the side of the dial the
 *    radio's sideband puts it (LSB: 1000 Hz below), and THAT frequency is
 *    what is checked.
 * 3. No such frequency on this band: refuse, saying why, and key nothing.
 */
const { txPrivilegeRefusal } = require('./privileges');
const { freqToBand } = require('./bands');
const { DIGITAL_FREQS, freqsForMode } = require('./ft8-engine');
const WsprBands = require('./wspr/bands');

const CLEAR_HZ = 3500;        // from any digital dial
const PASSBAND_HZ = 3000;     // above each dial, where its signals are
const SEARCH_HZ = 40000;      // how far above the FT8 dial to look
const STEP_HZ = 500;

const TONE_HZ = 1000;

function rfOf(dialHz, mode, toneHz = TONE_HZ) {
  return /^LSB/.test(String(mode || '').toUpperCase()) ? dialHz - toneHz : dialHz + toneHz;
}

/**
 * @param {object} o { freqHz (the dial), mode (the radio's), licenseClass }
 * @returns {{ action: 'here', emission } | { action: 'move', dialHz, emission, why }
 *          | { action: 'refuse', why }}
 */
/** Every digital dial on the band, in Hz: FT8, FT4, FT2, WSPR and the
 *  caller's extras (main's JS8 table). */
function digitalDialsHz(band, extraKhz) {
  const out = [];
  const add = (khz) => { const n = Number(khz); if (Number.isFinite(n) && n > 0) out.push(Math.round(n * 1000)); };
  add(DIGITAL_FREQS[band]);
  for (const m of ['FT4', 'FT2']) { const t = freqsForMode(m); if (t && t !== DIGITAL_FREQS) add(t[band]); }
  try { const w = WsprBands.dialForBand(band); if (w) add(w * 1000); } catch { /* no WSPR dial */ }
  for (const k of extraKhz || []) add(k);
  return [...new Set(out)];
}

/** The first tone frequency above the FT8 passband clear of every dial. */
function clearTestRf(band, extraKhz, allowed) {
  const ft8 = DIGITAL_FREQS[band];
  if (!ft8) return null;
  const dials = digitalDialsHz(band, extraKhz);
  const start = Math.round(ft8 * 1000) + CLEAR_HZ;
  for (let rf = start; rf <= Math.round(ft8 * 1000) + SEARCH_HZ; rf += STEP_HZ) {
    const clear = dials.every((d) => Math.abs(rf - d) >= CLEAR_HZ && !(rf >= d && rf <= d + PASSBAND_HZ));
    if (clear && allowed(rf)) return rf;
  }
  return null;
}

function planTestFrequency(o) {
  const mode = String(o.mode || '').toUpperCase();
  const hereEmission = /^(USB|LSB|SSB)$/.test(mode) ? mode : 'DATA';
  const hereWhy = txPrivilegeRefusal({ freqHz: rfOf(o.freqHz, mode), mode: hereEmission, licenseClass: o.licenseClass });
  if (!hereWhy) return { action: 'here', emission: hereEmission };
  const band = freqToBand(o.freqHz / 1e6);
  const rfHz = band ? clearTestRf(band, o.extraDialsKhz,
    (rf) => !txPrivilegeRefusal({ freqHz: rf, mode: 'DATA', licenseClass: o.licenseClass })) : null;
  if (rfHz) {
    // The radio's sideband puts the tone above (USB/DATA) or below (LSB) the dial.
    const dialHz = /^LSB/.test(mode) ? rfHz + TONE_HZ : rfHz - TONE_HZ;
    return { action: 'move', dialHz, rfHz, emission: 'DATA', why: hereWhy };
  }
  return {
    action: 'refuse',
    why: `${hereWhy} There is no data frequency on ${band || 'this band'} where your licence allows a test either. Tune to a band where you can transmit, then test again.`,
  };
}

module.exports = { planTestFrequency, rfOf, TONE_HZ, clearTestRf, digitalDialsHz, CLEAR_HZ };
