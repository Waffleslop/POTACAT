// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Which channel of the rig's sound card carries transmit audio (GitHub #654).
//
// POTACAT's transmit audio is mono, and Web Audio plays a mono node to a
// stereo output on BOTH channels. Most interfaces want that. Some carry
// something else on the right channel: a Digirig DR-891 keys its own
// hardware VOX from it, so a right channel with modem audio on it keyed the
// FT-891 in bursts inside each ARDOP frame (the reporter proved it by muting
// the right channel in the OS). So the choice is the operator's, per rig:
//   - 'both' (absent): left and right, as before. Nobody else changes.
//   - 'left': left only; the right channel stays silent.
//
// One rule for every sound-card transmit path that plays to the rig's output:
// the Winlink modem bridge (renderer/modem-audio-bridge.js) and JTCAT's FT8
// transmit and Tune tone (renderer/app.js).
//
// Dual-mode: Node `require()` gets module.exports; the browser gets
// window.TxChannel. Pure apart from the Web Audio nodes it is handed.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TxChannel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LEFT = 'left';
  var BOTH = 'both';

  var LABELS = {
    both: 'Both channels (left and right)',
    left: 'Left channel only',
  };

  /** Any stored value -> 'left' or 'both'. Unknown or absent is 'both'. */
  function normalize(v) {
    return String(v || '').toLowerCase() === LEFT ? LEFT : BOTH;
  }

  /** The rig's choice (rig.txChannel). */
  function ofRig(rig) {
    return normalize(rig && rig.txChannel);
  }

  /** The active rig's choice from a settings object ({ rigs, activeRigId }). */
  function ofSettings(s) {
    if (!s || !Array.isArray(s.rigs)) return BOTH;
    for (var i = 0; i < s.rigs.length; i++) {
      if (s.rigs[i] && s.rigs[i].id === s.activeRigId) return ofRig(s.rigs[i]);
    }
    return BOTH;
  }

  /**
   * Connect a mono transmit node to its context's output on the chosen
   * channels. 'both' is a plain connect (Web Audio up-mixes mono to both).
   * 'left' goes through a two-input ChannelMerger with only input 0 fed, so
   * the right channel is silence. An output that has one channel only gets the
   * plain connect: there is no right channel to keep quiet, and a merger would
   * be down-mixed to half level.
   * Returns the node that was connected to the destination (the merger for
   * 'left'), so the caller can disconnect it.
   */
  function connect(ctx, node, mode) {
    var dest = ctx.destination;
    var max = dest && typeof dest.maxChannelCount === 'number' ? dest.maxChannelCount : 2;
    if (normalize(mode) !== LEFT || max < 2 || typeof ctx.createChannelMerger !== 'function') {
      node.connect(dest);
      return node;
    }
    if (typeof dest.channelCount === 'number' && dest.channelCount < 2) {
      try { dest.channelCount = 2; } catch (e) { /* keep what the output allows */ }
    }
    var merger = ctx.createChannelMerger(2);
    node.connect(merger, 0, 0);
    merger.connect(dest);
    return merger;
  }

  return { LEFT: LEFT, BOTH: BOTH, LABELS: LABELS, normalize: normalize, ofRig: ofRig, ofSettings: ofSettings, connect: connect };
});
