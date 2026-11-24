'use strict';
// The WSPR beacon's RF power for one frame (GitHub #521).
//
// Reports, 24-31 Oct 2026: a KX3 + KXPA100 set to 20 W beaconed at 110 W (one
// operator's amplifier went into protection), a G90 set to 5 W sent 20 W, and
// after a 29 Oct fix the KX3 was forced to 11 W whatever was entered. The
// conversions that caused those (rigctld's 0..1 RFPOWER fraction against the
// wrong full scale) were fixed in 4223647d, 25bd310e and b845bb00; what was
// left was the beacon's own policy:
//   - with no level entered it forced 1 W, which raises a radio set below 1 W
//     and changes every radio's setting;
//   - a level entered ABOVE the radio's setting was never put back (the
//     pre-beacon memory only remembered a radio above the beacon level);
//   - the level went out unrounded, and each codec rounds to its own step, so
//     an entered 0.5 W could become 1 W (KX3 PCnnn; is whole watts) and an
//     Icom's 0..255 step could land a hair above the entry.
//
// The rule now: the beacon uses the level the operator entered (TX Pwr while
// it is armed), clamped to what this rig can be set to over this link and
// rounded DOWN to the link's step, so the radio is never set above the entry.
// With no level entered it leaves the radio's power alone. main.js remembers
// the radio's level before each frame that changes it and puts it back when
// the frame ends (lib/wspr-power-memory.js).

/** Default beacon level when the operator has entered none. 0 = leave the
 *  radio's power alone (#521). A positive value is used only when it is not
 *  above the radio's known setting. */
const BEACON_DEFAULT_WATTS = 0;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What a power setting can be on this link, in watts: { minW, maxW, stepW }.
 * The step is the resolution the link's codec encodes, so a level on the
 * step goes out exactly and is never rounded up by the codec.
 *
 *   link 'flex'    SmartSDR `transmit set rfpower=<int %>`: 1 % of the radio's
 *                  rated power (lib/smartsdr.js setTxPower rounds the percent).
 *   link 'civ'     Icom CI-V 0x14 0x0A, 0..255 of the model's maxPower
 *                  (lib/codecs/civ-codec.js setTxPower).
 *   link 'kenwood' Kenwood/Elecraft/Yaesu `PCnnn;` (lib/codecs/kenwood-codec.js
 *                  setTxPower: round(watts * powerScale), clamped to the
 *                  model's minPower..maxPower). Elecraft KX2/KX3: whole watts,
 *                  000-012 on 80-20 m and 000-015 on 160/15-6 m without a
 *                  KXPA100, 000-110 with one (K3S/K3/KX3/KX2 Programmer's
 *                  Reference rev G5, PC, PDF p. 22); the 0.1 W unit needs the
 *                  K22 extended format, which POTACAT does not use.
 *   link 'rigctld' Hamlib `L RFPOWER <0..1, 3 decimals>` of fullScaleW
 *                  (Hamlib's own scale from \power2mW, or the model's
 *                  hamlibFullScaleW, e.g. 20 W for the G90).
 *   link 'flrig'   rig.set_power in whole watts, at least minPower (default 1).
 *   anything else  whole watts.
 */
function powerRange({ link, maxW, minW, powerScale, fullScaleW } = {}) {
  const max = num(maxW) > 0 ? num(maxW) : 100;
  const min = Math.max(0, num(minW));
  switch (link) {
    case 'flex': return { minW: 0, maxW: max, stepW: max / 100 };
    case 'civ': return { minW: 0, maxW: max, stepW: max / 255 };
    case 'kenwood': {
      const s = num(powerScale) > 0 ? num(powerScale) : 1;
      return { minW: min, maxW: max, stepW: 1 / s };
    }
    case 'rigctld': {
      // Hamlib's answer is the radio's real range (a KX3 with a KXPA100 is
      // 110 W, not the model's 15 W); before it answers, the codec divides
      // by at least 100 W, and the model's maximum is the ceiling.
      if (num(fullScaleW) > 0) return { minW: min, maxW: num(fullScaleW), stepW: num(fullScaleW) / 1000 };
      return { minW: min, maxW: max, stepW: Math.max(max, 100) / 1000 };
    }
    // rigctld with a raw PC write (a Yaesu, or a Kenwood whose Hamlib power
    // level writes PC000/PC255): whole watts, as the rigctld codec rounds them.
    case 'rigctld-raw': return { minW: min, maxW: max, stepW: 1 };
    case 'flrig': return { minW: min > 0 ? min : 1, maxW: max, stepW: 1 };
    default: return { minW: min, maxW: max, stepW: 1 };
  }
}

/** Round DOWN to the step (with a little float tolerance so 5 stays 5). */
function floorToStep(w, step) {
  if (!(step > 0)) return w;
  const n = Math.floor(w / step + 1e-9);
  return Math.round(n * step * 1000) / 1000;
}

/** Two power levels the radio would call the same setting. */
function sameLevel(a, b, stepW) {
  return Math.abs(num(a) - num(b)) < Math.max(num(stepW) / 2, 0.05);
}

/**
 * The beacon's power for the next frame.
 *   enteredW  the level the operator entered for the beacon (0 = none)
 *   radioW    the radio's power setting as last read or set (0 = unknown)
 *   range     powerRange() for this link
 *   defaultW  level used when none is entered (BEACON_DEFAULT_WATTS)
 * Returns:
 *   { action: 'leave', watts, reason }   send nothing ('none-entered' |
 *                                        'at-level'); watts = what it runs at
 *                                        (0 = unknown)
 *   { action: 'set', watts, belowMin, clamped }
 *       watts    the level to command, on the link's step, never above the
 *                entry unless the radio cannot be set that low (belowMin)
 *       clamped  the entry was above what this rig can be set to
 */
function planFrame({ enteredW, radioW, range, defaultW = BEACON_DEFAULT_WATTS } = {}) {
  const r = range || powerRange({});
  const radio = num(radioW) > 0 ? num(radioW) : 0;
  let want = num(enteredW) > 0 ? num(enteredW) : 0;
  if (!want) {
    // No level entered: a default may only ever lower a radio we can read.
    const d = num(defaultW);
    if (d > 0 && radio > 0 && d < radio) want = d;
    else return { action: 'leave', watts: radio, reason: 'none-entered' };
  }
  let w = want;
  const clamped = w > r.maxW;
  if (clamped) w = r.maxW;
  w = floorToStep(w, r.stepW);
  let belowMin = false;
  if (w < r.minW) { w = r.minW; belowMin = true; }
  if (radio > 0 && sameLevel(radio, w, r.stepW)) return { action: 'leave', watts: radio, reason: 'at-level' };
  return { action: 'set', watts: w, belowMin, clamped };
}

/** Watts for a log line: "5", "4.7", "0.5". */
function fmtW(w) {
  const n = num(w);
  return n >= 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n * 100) / 100);
}

module.exports = { BEACON_DEFAULT_WATTS, powerRange, floorToStep, sameLevel, planFrame, fmtW };
