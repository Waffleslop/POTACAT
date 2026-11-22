// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window: the radio's meters beside "Beacon now (radio)" (Casey
// 2026-11-19: "I should be able to see my SWR, S-meter"). The S-meter while
// listening; SWR and forward power while the beacon transmits; the last
// beacon's peak SWR and RF out after it.
//
// The values are the ones every POTACAT window gets (main.js sendCatSmeter,
// sendCatSwr, sendCatFwdPower, and the true SWR ratio on 'cat-swr-ratio').
// The scale math is the VFO and JTCAT pop-outs' on purpose: the wire values
// are the Flex-style 0-255 scale every backend rescales to, so a second
// reading of them would show a different S-unit than the VFO window for the
// same radio. A radio that never reported SWR (main.js vfoMetersAvailable)
// gets "No SWR from this radio", never a made-up 1.0.
//
// Pure. Dual-mode: require() in tests, window.AprsRfMeters in the window.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsRfMeters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NO_SWR = 'No SWR from this radio';

  /** The 0-255 S-meter wire value as S-units: S0..S9, then S9+dB (the VFO pop-out's scale). */
  function sLabel(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return '';
    return n <= 120 ? 'S' + Math.round(n * 9 / 120) : 'S9+' + Math.round((n - 120) * 60 / 135);
  }

  /** The 0-255 SWR wire value as a ratio (1 + v/60); 0 = no reading. */
  function swrFromWire(v) {
    const n = Number(v) || 0;
    return n > 0 ? 1 + n / 60 : 0;
  }

  /** The SWR as text: one decimal, '>10' past ten. */
  function swrText(r) {
    const n = Number(r) || 0;
    return n >= 10 ? '>10' : n.toFixed(1);
  }

  /** The colour class for an SWR (the JTCAT pop-out's steps): ok to 1.5, warn to 3, high past it. */
  function swrClass(r) {
    const n = Number(r) || 0;
    if (!(n > 0)) return '';
    return n <= 1.5 ? 'ok' : n <= 3 ? 'warn' : 'high';
  }

  function wattsText(w) {
    const n = Number(w) || 0;
    return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + ' W';
  }

  /**
   * The peaks of one beacon. start() when it keys; note(kind, v) for every
   * meter frame while keyed: 'swr' (a ratio from the wire value), 'swr-ratio'
   * (the radio's true ratio, which wins when it comes, as in the other
   * windows) or 'fwd' (watts). end() returns { swr, fwdW } (0 = none came).
   */
  function createPeak() {
    let on = false, wire = 0, ratio = 0, fwdW = 0;
    return {
      start() { on = true; wire = 0; ratio = 0; fwdW = 0; },
      note(kind, v) {
        if (!on) return;
        const n = Number(v) || 0;
        if (kind === 'swr' && n > wire) wire = n;
        else if (kind === 'swr-ratio' && n > ratio) ratio = n;
        else if (kind === 'fwd' && n > fwdW) fwdW = n;
      },
      active() { return on; },
      end() {
        on = false;
        const swr = ratio > 0 ? ratio : wire;
        return { swr: Math.round(swr * 10) / 10, fwdW: Math.round(fwdW * 10) / 10 };
      },
    };
  }

  /**
   * What the meter strip shows.
   *   txing          the beacon has the radio keyed now
   *   smeter         the last S-meter wire value (null: none yet)
   *   swr            the last SWR ratio while keyed (0: none)
   *   fwdW           the last forward power while keyed (0: none)
   *   available      { smeter, swr, power } from main.js vfoMetersAvailable
   *   last           the last beacon's { swr, fwdW } peaks, or null
   * Returns { items: [{ key, label, text, cls }], last: string }.
   */
  function meterView({ txing = false, smeter = null, swr = 0, fwdW = 0, available = {}, last = null } = {}) {
    const a = available || {};
    const items = [];
    if (!txing) {
      const s = a.smeter === false ? '' : sLabel(smeter);
      items.push(a.smeter === false ? { key: 'smeter', label: '', text: 'No S-meter from this radio', cls: '' } : { key: 'smeter', label: 'S-meter', text: s || '—', cls: '' });
      items.push(a.swr ? { key: 'swr', label: 'SWR', text: 'shows while transmitting', cls: '' } : { key: 'swr', label: '', text: NO_SWR, cls: '' });
    } else {
      items.push(Number(swr) > 0 || a.swr ? { key: 'swr', label: 'SWR', text: Number(swr) > 0 ? swrText(swr) : '—', cls: swrClass(swr) } : { key: 'swr', label: '', text: NO_SWR, cls: '' });
      items.push(Number(fwdW) > 0 || a.power ? { key: 'fwd', label: 'RF out', text: Number(fwdW) > 0 ? wattsText(fwdW) : '—', cls: Number(fwdW) > 0 ? 'live' : '' } : { key: 'fwd', label: '', text: 'No RF out reading from this radio', cls: '' });
    }
    let lastText = '';
    if (last) {
      const parts = [];
      parts.push(Number(last.swr) > 0 ? 'SWR ' + swrText(last.swr) : (a.swr ? 'no SWR reading' : 'no SWR from this radio'));
      parts.push(Number(last.fwdW) > 0 ? 'RF out ' + wattsText(last.fwdW) : 'no RF out reading');
      lastText = 'Peak on the last radio beacon: ' + parts.join(', ') + '.';
    }
    return { items, last: lastText };
  }

  return { NO_SWR, sLabel, swrFromWire, swrText, swrClass, wattsText, createPeak, meterView };
});
