'use strict';
/**
 * Send the RF power again after a band change, on a radio that cannot report
 * its power. GitHub #184.
 *
 * SDR programs behind a Kenwood-style CAT port (deskHPSDR, Zeus, Thetis) keep
 * a drive level per band and answer `PC;` with `?`. After a band change the
 * radio is at that band's own level while POTACAT's slider still shows the
 * level the operator set: on a 6 W Hermes Lite that can be full drive where
 * the slider says 1 W. With no readback POTACAT is the only record of the
 * level, so it puts that level back.
 *
 * A radio that DOES report its power is left alone: its own per-band level is
 * what the slider shows a moment later, and resending would overwrite a level
 * the operator chose on the radio.
 */

/**
 * @param {object} s
 * @param {string|null} s.prevBand   band POTACAT last saw the dial on ('' / null: none yet)
 * @param {string|null} s.band       band of the dial just reported ('' / null: not a ham band)
 * @param {number}      s.watts      the level POTACAT has set (0: none)
 * @param {boolean}     s.readsBack  the radio has reported its power on this link
 * @param {number}      s.linkAgeMs  time since the CAT link was opened
 * @param {boolean}     [s.transmitting]
 * @param {string}      [s.rigType]  detectRigType(): a Flex's power is SmartSDR's
 * @returns {{ resend: boolean, watts?: number, reason: string }}
 */
const READBACK_GRACE_MS = 12000;

function decideBandPowerReapply(s) {
  const o = s || {};
  if (!o.band) return { resend: false, reason: 'not on a ham band' };
  if (!o.prevBand) return { resend: false, reason: 'first band seen' };
  if (o.band === o.prevBand) return { resend: false, reason: 'same band' };
  if (o.rigType === 'flex') return { resend: false, reason: 'SmartSDR holds the power' };
  if (o.readsBack) return { resend: false, reason: 'the radio reports its own power' };
  // A Kenwood is asked for its power every 5 s; before two asks have gone
  // unanswered, "no readback" says nothing about the radio.
  if (!(Number(o.linkAgeMs) >= READBACK_GRACE_MS)) return { resend: false, reason: 'too soon to know whether the radio reports its power' };
  if (o.transmitting) return { resend: false, reason: 'transmitting' };
  const w = Number(o.watts);
  if (!(w > 0)) return { resend: false, reason: 'no power set yet' };
  return { resend: true, watts: w, reason: `band ${o.prevBand} -> ${o.band}` };
}

module.exports = { decideBandPowerReapply, READBACK_GRACE_MS };
