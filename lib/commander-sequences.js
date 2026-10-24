// SPDX-License-Identifier: Apache-2.0
//
// DXLab Commander: constants and the user-sequence table, SHARED between the
// codec (lib/codecs/commander-codec.js), main, the rig editor and tests.
//
// Commander's TCP interface (Commander TCPIP Messages, dxlabsuite.com) has
// commands for frequency, mode, split, PTT and CW text, and NOTHING for NB, NR,
// ANF, COMP, the ATU or power. What it does have is `seqname` / `seqindex`:
// "execute the user-defined command sequence" the operator built in Commander's
// own Command Sequences window. That is how POTACAT reaches the rest: the
// operator names a Commander sequence for each control, and the control lights
// up in POTACAT only when its sequence is configured.
//
// Dual-mode: Node `require()` gets `module.exports`; the renderer (a plain
// <script> tag, no require) gets a global `window.CommanderSequences`.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CommanderSequences = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Commander listens on Base Port + 2, and the Base Port defaults to 52000.
  var DEFAULT_PORT = 52002;

  // One entry per sequence slot. `key` is the name stored in
  // catTarget.sequences. `cap` is the rig capability the slot unlocks; a
  // capability that needs an on AND an off (a toggle) unlocks only when both
  // are filled in, since a button that can switch NB on but never off is worse
  // than no button.
  var SEQUENCE_SLOTS = [
    { key: 'atu-tune',  label: 'ATU tune',       cap: 'atu' },
    { key: 'nb-on',     label: 'Noise blanker on',  cap: 'nb',   pair: 'nb-off' },
    { key: 'nb-off',    label: 'Noise blanker off', cap: 'nb',   pair: 'nb-on' },
    { key: 'nr-on',     label: 'Noise reduction on',  cap: 'nr',  pair: 'nr-off' },
    { key: 'nr-off',    label: 'Noise reduction off', cap: 'nr',  pair: 'nr-on' },
    { key: 'anf-on',    label: 'Auto-notch on',  cap: 'anf',  pair: 'anf-off' },
    { key: 'anf-off',   label: 'Auto-notch off', cap: 'anf',  pair: 'anf-on' },
    { key: 'comp-on',   label: 'Compressor on',  cap: 'comp', pair: 'comp-off' },
    { key: 'comp-off',  label: 'Compressor off', cap: 'comp', pair: 'comp-on' },
    { key: 'power-on',  label: 'Radio power on',  cap: 'power' },
    { key: 'power-off', label: 'Radio power off', cap: 'power' },
  ];

  /** A slot's text is a sequence NAME, or "#N" for Commander's Nth sequence. */
  function sequenceRef(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return null;
    var idx = t.match(/^#\s*(\d+)$/);
    if (idx) {
      var n = parseInt(idx[1], 10);
      // Commander numbers its sequences from 1 on screen; seqindex is 0-based.
      return n >= 1 && n <= 32 ? { command: 'seqindex', value: String(n - 1) } : null;
    }
    return { command: 'seqname', value: t };
  }

  /** Slots the operator has filled in: { 'atu-tune': 'TUNE', ... }, blanks dropped. */
  function cleanSequences(seqs) {
    var out = {};
    if (!seqs || typeof seqs !== 'object') return out;
    for (var i = 0; i < SEQUENCE_SLOTS.length; i++) {
      var k = SEQUENCE_SLOTS[i].key;
      var v = typeof seqs[k] === 'string' ? seqs[k].trim() : '';
      if (v && sequenceRef(v)) out[k] = v;
    }
    return out;
  }

  /**
   * The rig capabilities the configured sequences unlock. Everything Commander
   * cannot do natively stays false; a control appears only when the operator
   * has told POTACAT which sequence performs it.
   */
  function capsFromSequences(seqs) {
    var have = cleanSequences(seqs);
    var caps = {};
    for (var i = 0; i < SEQUENCE_SLOTS.length; i++) {
      var s = SEQUENCE_SLOTS[i];
      if (!have[s.key]) continue;
      if (s.pair && !have[s.pair]) continue;
      caps[s.cap] = true;
    }
    return caps;
  }

  return {
    DEFAULT_PORT: DEFAULT_PORT,
    SEQUENCE_SLOTS: SEQUENCE_SLOTS,
    sequenceRef: sequenceRef,
    cleanSequences: cleanSequences,
    capsFromSequences: capsFromSequences,
  };
});
