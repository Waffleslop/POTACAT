// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Icom over USB: DATA MOD (where the radio takes its transmit audio in the
// DATA modes) set to USB for a data session, and put back afterwards (Casey
// 2026-11-21, sweep item 1a; "the rule above the rules": set it, say so,
// restore it). Out of the box an IC-7300, IC-7100 or IC-7610 takes data-mode
// audio from the rear ACC socket, so FT8, Winlink and SSTV sent over the USB
// cable key the radio with 0 W. The setup note (lib/rig-setup-notes.js
// ic7300-data-mod-usb and friends) asked the operator to change the menu by
// hand; now POTACAT does it when it puts the radio in a DATA mode.
//
// When: POTACAT's own mode set turns DATA on (lib/codecs/civ-codec.js emits
// 'data-set'). Then the item for the DATA number in use is read; a value that
// already includes USB is left alone; otherwise USB is written, the window
// says what changed, and the operator's value is written back when POTACAT
// turns DATA off again (a voice or CW mode), when another DATA number is
// picked (that item instead), and when the radio disconnects or POTACAT quits.
// An item that cannot be read is never written (no unsafe restore guess).
//
// Not for an interface on the ACC socket (a SignaLink): there DATA MOD must
// stay ACC. The rig editor's "Set DATA MOD to USB while POTACAT sends data"
// box turns it off for that radio (rig.icomUsbDataModOff).
//
// Items and values, each from the maker's document (ops manuals, not in this repo):
//   IC-7300     1A 05 00 67 DATA MOD: 00 MIC, 01 ACC, 02 MIC,ACC, 03 USB, 04 MIC,USB
//               (IC-7300 Full Manual rev 12b p.163 (19-5); default ACC p.126)
//   IC-7300 MK II 1A 05 00 85 DATA MOD: 00 MIC, 01 USB, 02 ACC, 03 MIC+USB,
//               04 MIC+ACC, 05 LAN (IC-7300MK2 CI-V Reference Guide rev 0 p.9)
//   IC-7100     1A 05 00 91 DATA MOD: 00 MIC, 01 ACC, 02 MIC,ACC, 03 USB
//               (IC-7100 Full Manual rev 5 p.366 (20-7); default ACC p.333)
//   IC-7610     1A 05 00 92 / 00 93 / 00 94 DATA1/2/3 MOD: 00 MIC, 01 ACC,
//               02 MIC+ACC, 03 USB, 04 MIC+USB, 05 LAN (IC-7610 CI-V Reference
//               Guide rev 4, 1A 05 table); 1A 06 data byte 01/02/03 = DATA1/2/3.
//
// Dual-mode: require() in main and tests, window.IcomUsbDataMod in the rig editor.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IcomUsbDataMod = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const V7300 = Object.freeze({ 0x00: 'MIC', 0x01: 'ACC', 0x02: 'MIC,ACC', 0x03: 'USB', 0x04: 'MIC,USB' });
  const VMK2 = Object.freeze({ 0x00: 'MIC', 0x01: 'USB', 0x02: 'ACC', 0x03: 'MIC+USB', 0x04: 'MIC+ACC', 0x05: 'LAN' });
  const V7100 = Object.freeze({ 0x00: 'MIC', 0x01: 'ACC', 0x02: 'MIC,ACC', 0x03: 'USB' });
  const V7610 = Object.freeze({ 0x00: 'MIC', 0x01: 'ACC', 0x02: 'MIC+ACC', 0x03: 'USB', 0x04: 'MIC+USB', 0x05: 'LAN' });

  const SPECS = Object.freeze({
    'IC-7300': Object.freeze({ usbValue: 0x03, values: V7300, perData: Object.freeze({ 1: { settingId: 0x0067, label: 'DATA MOD' } }) }),
    'IC-7300 MK II': Object.freeze({ usbValue: 0x01, values: VMK2, perData: Object.freeze({ 1: { settingId: 0x0085, label: 'DATA MOD' } }) }),
    'IC-7100': Object.freeze({ usbValue: 0x03, values: V7100, perData: Object.freeze({ 1: { settingId: 0x0091, label: 'DATA MOD' } }) }),
    'IC-7610': Object.freeze({
      usbValue: 0x03, values: V7610,
      perData: Object.freeze({
        1: { settingId: 0x0092, label: 'DATA1 MOD' },
        2: { settingId: 0x0093, label: 'DATA2 MOD' },
        3: { settingId: 0x0094, label: 'DATA3 MOD' },
      }),
    }),
  });

  /** The spec for a model name, or null (any other radio is left alone). */
  function specFor(modelName) { return SPECS[String(modelName || '')] || null; }

  /** Does the rig editor offer the box for this model? */
  function hasChoice(modelName) { return !!specFor(modelName); }

  /** The item for a DATA number (the IC-7610 has three; the others one). Unknown = DATA1. */
  function itemFor(spec, dataNumber) {
    if (!spec) return null;
    const n = Number(dataNumber);
    return spec.perData[n] || spec.perData[1];
  }

  /** A value's name, e.g. 'ACC (0x01)'. */
  function valueText(spec, v) {
    const n = Number(v);
    const name = spec && spec.values[n];
    return (name || 'value') + ' (0x' + n.toString(16).toUpperCase().padStart(2, '0') + ')';
  }

  /** Does this value already send USB audio (USB, MIC+USB, MIC,USB)? */
  function hasUsb(spec, v) {
    const name = spec && spec.values[Number(v)];
    return !!name && /USB/.test(name);
  }

  /**
   * The guard main keeps for a serial Icom connection.
   * deps:
   *   model                         the rig's model name
   *   enabled() -> bool             false when the rig editor's box is off
   *   read(settingId) -> Promise<number|null>   the item's value, or null (no answer)
   *   write(settingId, value)
   *   log(line), notice(sentence)
   */
  function createGuard(deps) {
    const d = deps || {};
    const spec = specFor(d.model);
    const log = typeof d.log === 'function' ? d.log : () => {};
    const notice = typeof d.notice === 'function' ? d.notice : () => {};
    let held = null;            // { settingId, label, previous }
    let stopped = false;        // restore() ran: this connection is ending, nothing more is set
    let chain = Promise.resolve();
    const queue = (fn) => { chain = chain.then(fn, fn); return chain; };

    function restoreNow(why) {
      const h = held;
      held = null;
      if (!h) return { action: 'none' };
      try { d.write(h.settingId, h.previous); } catch (e) { log(`${h.label} could not be put back: ${e.message}`); return { action: 'failed' }; }
      log(`${h.label} put back to ${valueText(spec, h.previous)} (${why})`);
      return { action: 'restored', settingId: h.settingId, value: h.previous };
    }

    async function ensureUsb(dataNumber) {
      if (!spec || stopped) return { action: 'none' };
      if (typeof d.enabled === 'function' && !d.enabled()) return { action: 'off' };
      const item = itemFor(spec, dataNumber);
      if (held && held.settingId === item.settingId) return { action: 'held' };
      if (held) restoreNow(`DATA${dataNumber} selected`);
      let v = null;
      try { v = await d.read(item.settingId); } catch { v = null; }
      if (stopped) return { action: 'stopped' };
      if (v == null || !Number.isInteger(Number(v))) {
        log(`${item.label} could not be read, so it is left as it is (no restore guess)`);
        return { action: 'unread' };
      }
      v = Number(v);
      if (hasUsb(spec, v)) return { action: 'already', value: v };
      d.write(item.settingId, spec.usbValue);
      held = { settingId: item.settingId, label: item.label, previous: v };
      log(`${item.label} was ${valueText(spec, v)}; set to ${valueText(spec, spec.usbValue)} so the audio POTACAT sends over the USB cable reaches the transmitter. It goes back when the radio leaves data mode or disconnects.`);
      notice(`POTACAT set the radio's ${item.label} from ${spec.values[v] || 'its setting'} to USB for data. It goes back afterwards. If your interface is on the ACC socket (a SignaLink), turn off "Set DATA MOD to USB while POTACAT sends data" for this radio in Settings > Radio.`);
      return { action: 'set', settingId: item.settingId, previous: v };
    }

    return {
      get held() { return held ? Object.assign({}, held) : null; },
      /** POTACAT's own mode set turned DATA on (with its number) or off. */
      onDataSet({ on, data } = {}) {
        return queue(() => (on ? ensureUsb(data) : restoreNow('data mode off')));
      },
      /**
       * Disconnect, quit, rig change: put the operator's value back NOW, before
       * the link closes (the caller disconnects right after), and set nothing more.
       */
      restore(why) { stopped = true; return restoreNow(why || 'disconnect'); },
    };
  }

  return { SPECS, specFor, hasChoice, itemFor, hasUsb, valueText, createGuard };
});
