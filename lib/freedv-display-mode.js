/**
 * The mode every surface shows while FreeDV runs (#716).
 *
 * FreeDV needs the radio in a voice-width sideband: DIGU/DIGL by default
 * (rigctld reports PKTUSB/PKTLSB, Icom USB-D/LSB-D), plain USB/LSB with
 * "Use DATA mode" off. The radio never reports a "RADE" mode, so a surface
 * that shows the radio's own mode looks as if RADE switched itself off while
 * the engine keeps running. While the engine runs and the radio sits in one
 * of those sidebands, the display mode is FREEDV-<codec> (FREEDV-RADEV1, the
 * value ECHOCAT already takes, docs/echocat-protocol.md); otherwise it is the
 * radio's mode unchanged.
 *
 * freedvBadge is the short label a mode badge draws for it.
 *
 * Dual-mode: Node require() gets module.exports, a <script> gets
 * window.FreedvDisplayMode (the VFO window; ECHOCAT Web has it inlined by
 * remote-server). Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FreedvDisplayMode = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FREEDV_SIDEBANDS = ['USB', 'LSB', 'DIGU', 'DIGL', 'PKTUSB', 'PKTLSB', 'USB-D', 'LSB-D'];

  /**
   * @param {string} mode         the radio's mode as read over CAT
   * @param {string|null} engineCodec  the running engine's codec (RADEV1, 700E...), null when it is not running
   * @returns {string}
   */
  function freedvDisplayMode(mode, engineCodec) {
    if (!engineCodec || !mode) return mode;
    if (FREEDV_SIDEBANDS.indexOf(String(mode).toUpperCase()) < 0) return mode;
    return 'FREEDV-' + String(engineCodec).toUpperCase();
  }

  /** The badge text: RADE, FreeDV for the classic codecs, else the mode as given. */
  function freedvBadge(mode) {
    const m = String(mode || '').toUpperCase();
    if (!m.startsWith('FREEDV')) return mode || '';
    return m.includes('RADE') ? 'RADE' : 'FreeDV';
  }

  return { FREEDV_SIDEBANDS, freedvDisplayMode, freedvBadge };
});
