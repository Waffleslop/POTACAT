/**
 * Which sideband voice SSB uses on a frequency: LSB below 10 MHz, USB from
 * 10 MHz up, and USB on 60 m by rule. 60 m here is 5.250-5.450 MHz, every
 * national 60 m allocation (the UK's starts at 5.2585 MHz, below the US
 * channels; the codecs and SSTV already used this range, the spot path used
 * 5.300-5.410 until #445 made them one). This is the ONE copy
 * of that rule (test/ssb-sideband-one-rule-test.js keeps it that way): spot
 * clicks, the codecs, the SDR follow, SSTV and the band jumps below all ask
 * here.
 *
 * A band button or a typed frequency (#445) carries no mode. When the radio
 * is in plain voice SSB it follows the band plan too, so 20 m USB does not
 * come along to 40 m. Every other mode is left alone: CW, AM, FM, RTTY, every
 * data mode (USB-D, DIGU, PKTUSB, DATA-U...), a radio in DATA while it reads
 * USB, an FT8/FreeDV/JS8 session that runs in plain USB, and an unknown mode.
 *
 * Dual-mode: require() in main, the codecs and tests; window.SsbSideband in
 * the SSTV window.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SsbSideband = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var USB_FROM_HZ = 10000000;   // 10 MHz and up: USB
  var SIXTY_M_LO_HZ = 5250000;  // 60 m, every country's: USB by rule
  var SIXTY_M_HI_HZ = 5450000;  // (exclusive)

  /** 'USB' or 'LSB' for voice SSB at freqHz. */
  function ssbSideband(freqHz) {
    var hz = Number(freqHz) || 0;
    if (hz >= SIXTY_M_LO_HZ && hz < SIXTY_M_HI_HZ) return 'USB';
    return hz >= USB_FROM_HZ ? 'USB' : 'LSB';
  }

  /** True only for plain voice sideband names: USB, LSB, SSB. */
  function isPlainSsb(mode) {
    return /^(USB|LSB|SSB)$/.test(String(mode || '').trim().toUpperCase());
  }

  /**
   * The sideband to send with a band button or typed frequency, or null to
   * leave the radio's mode alone.
   * rig: {
   *   mode        the radio's current mode as POTACAT read it ('' = unknown)
   *   dataOn      the radio reports DATA on (an Icom 1A 06, a Kenwood DA1)
   *   voiceAsData this rig sends voice as USB-D/LSB-D on purpose (#24)
   *   digitalBusy an FT8/FT4, FreeDV or JS8 session is running
   * }
   * Null also when the sideband is already right: nothing to send.
   */
  function bandJumpSideband(rig, freqHz) {
    if (!rig || !isPlainSsb(rig.mode)) return null;
    if (rig.dataOn && !rig.voiceAsData) return null;
    if (rig.digitalBusy) return null;
    if (!(Number(freqHz) > 0)) return null;
    var want = ssbSideband(freqHz);
    return String(rig.mode).trim().toUpperCase() === want ? null : want;
  }

  return { ssbSideband: ssbSideband, isPlainSsb: isPlainSsb, bandJumpSideband: bandJumpSideband };
});
