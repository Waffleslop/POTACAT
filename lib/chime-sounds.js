/**
 * The chime sounds: every short notification tone POTACAT plays on the PC's
 * own speakers. One engine, used by "QSO logged chime" (Settings > Spots) and
 * the JTCAT chimes (the JTCAT window's Options > Sounds).
 *
 * Synthesized, so there is nothing to ship or find. Each sound is a list of
 * notes [frequency Hz, start s, length s, peak gain].
 *
 * Each event has its own list of sounds, and no sound is in two lists: the ear
 * can always tell "logged" from "a station is calling" from "TX stopped",
 * whatever the operator picks.
 *
 * play() writes into the AudioContext it is given and connects to that
 * context's own destination. The main window hands it a context made with no
 * options, which is the system default output; it never sets a sink, so a
 * chime cannot be sent to the device chosen for transmit audio.
 *
 * Dual-mode: require() in Node/tests, window.ChimeSounds in the pages.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChimeSounds = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var U = 0.06; // one Morse unit, seconds
  function morse(freq, pattern) { // pattern: units on, units of gap, units on, ...
    var out = [], at = 0;
    for (var i = 0; i < pattern.length; i += 2) {
      out.push([freq, at * U, pattern[i] * U, 0.2]);
      at += pattern[i] + (pattern[i + 1] || 0);
    }
    return out;
  }

  var NOTES = {
    // QSO logged (N2FSM 2026-09-12). Unchanged since they shipped.
    'soft': [[880, 0, 0.35, 0.18]],
    'twotone': [[660, 0, 0.18, 0.18], [990, 0.16, 0.32, 0.18]],
    'bell': [[1320, 0, 0.9, 0.16], [1980, 0, 0.45, 0.05], [2640, 0, 0.25, 0.03]],
    'morse-r': morse(700, [1, 1, 3, 1, 1]), // R = .-.
    // A station calls me: bright, going up.
    'call-rise': [[784, 0, 0.12, 0.18], [988, 0.11, 0.12, 0.18], [1319, 0.22, 0.3, 0.18]],
    'call-double': [[1047, 0, 0.16, 0.18], [1047, 0.2, 0.3, 0.18]],
    'call-morse-k': morse(800, [3, 1, 1, 1, 3]), // K = -.-
    // Transmitting stopped by itself: lower, going down.
    'stop-fall': [[660, 0, 0.2, 0.18], [440, 0.18, 0.4, 0.18]],
    'stop-three': [[880, 0, 0.14, 0.18], [660, 0.13, 0.14, 0.18], [440, 0.26, 0.4, 0.18]],
    'stop-low': [[392, 0, 0.6, 0.2]],
  };

  var QSO_SOUNDS = [
    { id: 'soft', label: 'Soft ding' },
    { id: 'twotone', label: 'Two-tone' },
    { id: 'bell', label: 'Bell' },
    { id: 'morse-r', label: 'Morse R (received)' },
  ];
  var CALL_SOUNDS = [
    { id: 'call-rise', label: 'Three rising notes' },
    { id: 'call-double', label: 'Double ding' },
    { id: 'call-morse-k', label: 'Morse K (go ahead)' },
  ];
  var STOP_SOUNDS = [
    { id: 'stop-fall', label: 'Two falling notes' },
    { id: 'stop-three', label: 'Three falling notes' },
    { id: 'stop-low', label: 'One low note' },
  ];

  function notesOf(id) {
    return Object.prototype.hasOwnProperty.call(NOTES, id) ? NOTES[id] : [];
  }

  /** Play a sound now. False when there is nothing to play. */
  function play(ctx, id) {
    var notes = notesOf(id);
    if (!ctx || !notes.length) return false;
    var t0 = ctx.currentTime;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = n[0];
      g.gain.setValueAtTime(0.0001, t0 + n[1]);
      g.gain.exponentialRampToValueAtTime(n[3], t0 + n[1] + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + n[1]);
      o.stop(t0 + n[1] + n[2] + 0.05);
    }
    return true;
  }

  return { QSO_SOUNDS: QSO_SOUNDS, CALL_SOUNDS: CALL_SOUNDS, STOP_SOUNDS: STOP_SOUNDS, notesOf: notesOf, play: play };
});
