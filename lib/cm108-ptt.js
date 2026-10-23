/**
 * PTT through a CM108-family USB sound card's GPIO pin — the Digirig Lite,
 * AIOC-style and DMK/URI interfaces, many "sound card + PTT" cables. The
 * radio (a Baofeng, say) has no CAT; the sound card keys it.
 *
 * The chip is driven with one HID output report, the same bytes Dire Wolf
 * (cm108.c) and Hamlib (cm108.c) write to hidraw:
 *   [0x00, iodata, iomask, 0x00] on report id 0,
 *   iomask = 1 << (gpio - 1), iodata = state ? iomask : 0.
 * The Digirig Lite keys on GPIO3 (its default; the board's solder pads can
 * disable it). The renderer sends it through WebHID (no native module), so
 * it works the same on Windows, macOS and Linux (Linux needs read/write on
 * the hidraw node — the usual udev rule Dire Wolf documents).
 *
 * Dual-mode: require() in main and tests, window.Cm108Ptt in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cm108Ptt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // C-Media (0x0d8c): CM108, CM108AH, CM108B, CM109, CM119, CM119A, CM119B ...
  // Any C-Media part answers this report; SSS (0x0c76) parts are listed by PID
  // (the list Dire Wolf ships).
  const CMEDIA_VID = 0x0d8c;
  const SSS_VID = 0x0c76;
  const SSS_PIDS = [0x1605, 0x1607, 0x160b];

  function isCm108(vendorId, productId) {
    if (vendorId === CMEDIA_VID) return true;
    return vendorId === SSS_VID && SSS_PIDS.includes(productId);
  }

  function hidFilters() {
    return [{ vendorId: CMEDIA_VID }, ...SSS_PIDS.map((productId) => ({ vendorId: SSS_VID, productId }))];
  }

  /** The 4 data bytes after report id 0. gpio 1..8; anything else → GPIO3. */
  function report(state, gpio) {
    const g = Number.isInteger(gpio) && gpio >= 1 && gpio <= 8 ? gpio : 3;
    const mask = 1 << (g - 1);
    return [0x00, state ? mask : 0x00, mask, 0x00];
  }

  function describe(dev) {
    if (!dev) return '';
    const hex = (n) => '0x' + Number(n || 0).toString(16).padStart(4, '0');
    return `${dev.productName || 'USB sound card'} (${hex(dev.vendorId)}:${hex(dev.productId)})`;
  }

  return { CMEDIA_VID, SSS_VID, SSS_PIDS, isCm108, hidFilters, report, describe };
});
