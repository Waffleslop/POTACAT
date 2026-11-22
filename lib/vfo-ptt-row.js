/**
 * Whether ECHOCAT Web's VFO tab shows its PTT row for the radio's mode (#190).
 *
 * Voice modes (USB, LSB, SSB, FM, AM, FreeDV) show it. CW and data modes
 * (DIGU, FT8, PKTUSB, RTTY...) hide it on purpose. A mode that is not known
 * yet (no readback: an FT-891 that never answered MD0; kept the row hidden
 * for minutes) shows it, the same as the main PTT button. This is the UI
 * only; keying has its own guards.
 *
 * Dual-mode: Node require() gets module.exports; ECHOCAT Web has it inlined
 * by remote-server as window.VfoPttRow. Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VfoPttRow = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const VOICE = ['SSB', 'USB', 'LSB', 'FM', 'AM'];

  /** @param {string|null|undefined} mode the radio's mode as read over CAT */
  function showVfoPttRow(mode) {
    const m = String(mode == null ? '' : mode).trim().toUpperCase();
    if (!m) return true;
    return VOICE.indexOf(m) !== -1 || m.indexOf('FREEDV') === 0;
  }

  return { showVfoPttRow };
});
