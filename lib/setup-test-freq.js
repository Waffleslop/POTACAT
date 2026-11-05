'use strict';
/**
 * Where the Station Setup test transmit may key (w0tlp, 2026-11-02: refused
 * as out of band, with the radio in LSB). The test sends a 1000 Hz tone.
 *
 * 1. At the dial, judged by the radio's mode (a tone in USB/LSB is a phone
 *    emission there; anything else is data) — the 1.13.10 rule.
 * 2. If the operator's licence does not allow that, move to the band's FT8
 *    dial, where a single tone is a data emission, test, and come back.
 *    The mode is never changed: the tone lands on the side of the dial the
 *    radio's sideband puts it (LSB: 1000 Hz below), and THAT frequency is
 *    what is checked.
 * 3. No such frequency on this band: refuse, saying why, and key nothing.
 */
const { txPrivilegeRefusal } = require('./privileges');
const { freqToBand } = require('./bands');
const { DIGITAL_FREQS } = require('./ft8-engine');

const TONE_HZ = 1000;

function rfOf(dialHz, mode, toneHz = TONE_HZ) {
  return /^LSB/.test(String(mode || '').toUpperCase()) ? dialHz - toneHz : dialHz + toneHz;
}

/**
 * @param {object} o { freqHz (the dial), mode (the radio's), licenseClass }
 * @returns {{ action: 'here', emission } | { action: 'move', dialHz, emission, why }
 *          | { action: 'refuse', why }}
 */
function planTestFrequency(o) {
  const mode = String(o.mode || '').toUpperCase();
  const hereEmission = /^(USB|LSB|SSB)$/.test(mode) ? mode : 'DATA';
  const hereWhy = txPrivilegeRefusal({ freqHz: rfOf(o.freqHz, mode), mode: hereEmission, licenseClass: o.licenseClass });
  if (!hereWhy) return { action: 'here', emission: hereEmission };
  const band = freqToBand(o.freqHz / 1e6);
  const dialKhz = band && DIGITAL_FREQS[band];
  if (dialKhz) {
    const dialHz = Math.round(dialKhz * 1000);
    const why = txPrivilegeRefusal({ freqHz: rfOf(dialHz, mode), mode: 'DATA', licenseClass: o.licenseClass });
    if (!why) return { action: 'move', dialHz, emission: 'DATA', why: hereWhy };
  }
  return {
    action: 'refuse',
    why: `${hereWhy} There is no data frequency on ${band || 'this band'} where your licence allows a test either. Tune to a band where you can transmit, then test again.`,
  };
}

module.exports = { planTestFrequency, rfOf, TONE_HZ };
