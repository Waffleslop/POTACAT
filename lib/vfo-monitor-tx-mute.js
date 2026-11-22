'use strict';
/**
 * The VFO window's radio audio monitor ("Audio on") while transmitting
 * (GitHub #713, w9tef). Pure. Dual-mode: require() in tests,
 * window.VfoMonitorTxMute in the VFO window.
 *
 * Many radios send their transmit monitor down the USB audio while keyed, so
 * with the monitor on the operator heard his own voice on the PC speakers:
 * echo, then feedback once the mic picked it up. The monitor is silent while
 * transmitting, from any source (the window's PTT, or the radio / ECHOCAT /
 * FT8 reported through the TX state), and afterwards it is exactly what the
 * operator had: his volume, or still muted if he muted it, or still silent
 * while the SDR is the receiver he hears. The gain is worked out from that
 * state every time, never saved and put back, so a mute or a volume change
 * made during TX is what he gets when TX ends.
 *
 * monitorGain({ volume, muted, sdrLive, transmitting }) -> gain (>= 0)
 * transmitting(localPtt, radioTx) -> boolean
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VfoMonitorTxMute = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function monitorGain(state) {
    const s = state || {};
    if (s.muted || s.sdrLive || s.transmitting) return 0;
    const v = Number(s.volume);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function transmitting(localPtt, radioTx) {
    return !!(localPtt || radioTx);
  }

  return { monitorGain, transmitting };
}));
