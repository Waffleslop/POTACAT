// Which receiver you hear (Casey 2026-10-30: "I may be making a QSO on HF via
// my Flex, then want to check weather on NOAA ... I should only hear NOAA from
// the SDR, and when I go back to a freq my Flex can reach, I should only hear
// my Flex. It should intelligently switch between.")
//
// Pure rules, dual-mode: `require` in main, `window.ListenSource` in the
// renderer (the Landmarks tab asks whether the SDR can hear a station).
// A reach is a list of [loHz, hiHz] ranges.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ListenSource = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // rtl_tcp tuner types (librtlsdr enum) and what each tuner receives.
  var TUNER_REACH = {
    1: [[52e6, 2200e6]],                     // E4000 (gap around 1100-1250 MHz ignored)
    2: [[22e6, 948e6]],                      // FC0012
    3: [[22e6, 1100e6]],                     // FC0013
    4: [[146e6, 308e6], [438e6, 924e6]],     // FC2580
    5: [[24e6, 1766e6]],                     // R820T / R820T2
    6: [[500e3, 1766e6]],                    // R828D (RTL-SDR Blog V4: HF through its own upconverter)
  };
  var DIRECT_SAMPLING_REACH = [[0, 28.8e6]];
  var RTL_TCP_ASSUMED = [[24e6, 1766e6]];    // before the greeting names the tuner
  var KIWI_REACH = [[0, 30e6]];

  /** What a listening SDR can receive, or null when nothing is known (WebSDR.org). */
  function sdrReach(sdr) {
    if (!sdr) return null;
    var kind = sdr.kind;
    if (kind === 'kiwisdr') return KIWI_REACH;
    if (kind === 'rtl_tcp') {
      var base = TUNER_REACH[Number(sdr.tunerType)] || RTL_TCP_ASSUMED;
      var ds = sdr.directSampling && sdr.directSampling !== 'off';
      return ds ? DIRECT_SAMPLING_REACH.concat(base) : base;
    }
    return null;
  }

  /** True when any range covers hz. A null reach covers nothing. */
  function covers(reach, hz) {
    if (!Array.isArray(reach) || !(hz > 0)) return false;
    for (var i = 0; i < reach.length; i++) {
      var r = reach[i];
      if (r && hz >= r[0] && hz <= r[1]) return true;
    }
    return false;
  }

  /**
   * Who you hear at hz.
   *   rigReach    the radio's receive ranges (null = no radio connected)
   *   sdr         { connected, reach, manual } or null
   * manual = the operator picked the SDR to listen through (local QRM on HF):
   * it stays the source wherever the dial goes, as it always has.
   * Returns { source: 'rig' | 'sdr' | 'none', reason }.
   */
  function decide(hz, rigReach, sdr) {
    var rigCan = covers(rigReach, hz);
    var sdrOn = !!(sdr && sdr.connected);
    if (sdrOn && sdr.manual) return { source: 'sdr', reason: 'chosen' };
    if (rigCan) return { source: 'rig', reason: 'rig' };
    // The SDR takes over only where the radio cannot go. An SDR with no
    // known reach yet (greeting pending) is given the benefit of the doubt.
    var sdrCan = sdrOn && (sdr.reach == null || covers(sdr.reach, hz));
    if (sdrCan) return { source: 'sdr', reason: 'out-of-rig-reach' };
    return { source: 'none', reason: sdrOn ? 'neither' : (rigReach ? 'rig-only' : 'no-rig') };
  }

  function fmtMhz(hz) {
    var m = hz / 1e6;
    return (m >= 100 ? m.toFixed(3) : m.toFixed(m >= 10 ? 4 : 5)).replace(/0+$/, '').replace(/\.$/, '') + ' MHz';
  }

  /** The one sentence every surface shows when nothing can receive hz. */
  function refusal(hz, decision, rigName, sdrLabel) {
    var f = fmtMhz(hz);
    var rig = rigName || 'the radio';
    if (decision.reason === 'neither') return f + ' is outside ' + rig + "'s range and the SDR (" + (sdrLabel || 'SDR') + ") cannot receive it either.";
    if (decision.reason === 'no-rig') return 'No radio is connected, and no SDR is set up to listen through (Settings > Station > WebSDR).';
    return f + ' is outside ' + rig + "'s range. Add an SDR that covers it under Settings > Station > WebSDR and POTACAT will listen through that.";
  }

  return { TUNER_REACH, KIWI_REACH, RTL_TCP_ASSUMED, sdrReach, covers, decide, refusal, fmtMhz };
});
