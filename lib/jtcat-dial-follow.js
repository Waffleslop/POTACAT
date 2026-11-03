'use strict';
// JTCAT's band follows the radio when the dial lands on a digital watering
// hole (GitHub #115, ianturo). The wrong-band TX guard (KF0U 2026-07-17)
// anchors on the dial JTCAT tuned and refuses TX when the radio is elsewhere:
// it exists so a spot click or a scan cannot put FT8 on a phone frequency.
// But turning the knob from 7.074 to 14.074 left decodes flowing on 20 m
// while every transmission was refused with "wrong band". A dial within
// 2 kHz of the current mode's published dial is never a phone frequency, so
// it re-anchors the guard and the window's band follows. Any other dial
// keeps the guard; the refusal then offers "Follow the radio".
// Pure: main.js supplies the dial, the anchor and the mode's dial table.

const FOLLOW_TOLERANCE_HZ = 2000;
const GUARD_TOLERANCE_HZ = 2500; // the guard's own slack (main.js pre-TX guard)

/**
 * @param {object} o
 * @param {number} o.dialHz    the radio's dial now
 * @param {number} o.anchorHz  the dial JTCAT is anchored to (0 = no session)
 * @param {object} o.freqs     band -> kHz for the engine's mode (lib/ft8-engine freqsForMode)
 * @param {boolean} [o.qsoLive] a QSO is in progress (never move it to another band)
 * @returns {{action:'none'|'follow'|'refuse', band?:string, dialHz?:number}}
 */
function decideDialFollow(o) {
  const dial = Number(o && o.dialHz), anchor = Number(o && o.anchorHz);
  if (!(anchor > 0) || !(dial > 0)) return { action: 'none' };
  if (Math.abs(dial - anchor) <= GUARD_TOLERANCE_HZ) return { action: 'none' };
  if (o.qsoLive) return { action: 'refuse' };
  for (const [band, khz] of Object.entries(o.freqs || {})) {
    const hz = Math.round(Number(khz) * 1000);
    if (hz > 0 && Math.abs(dial - hz) <= FOLLOW_TOLERANCE_HZ) return { action: 'follow', band, dialHz: dial };
  }
  return { action: 'refuse' };
}

module.exports = { decideDialFollow, FOLLOW_TOLERANCE_HZ, GUARD_TOLERANCE_HZ };
