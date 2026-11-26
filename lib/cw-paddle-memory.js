// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Paddle memory for ECHOCAT Web's iambic keyer (#244).
//
// An iambic keyer remembers a paddle pressed while an element is sounding (or
// in the space after it) and sends that element next, even if the paddle was
// let go again before the keyer got there. That memory is what lets a quick
// operator tap the other paddle early. It is also what turns a touch that
// came too early, or a contact that closed again while the operator was
// still letting go of it, into one more dot or dash on the air.
//
// On ECHOCAT Web the operator hears his own sidetone late: LZ3AW (25 wpm,
// Chrome on a phone, 1.14.8) heard each element 55-59 ms after the keyer chose
// it, 39 ms of that the phone's own audio output. A dit at 25 wpm is 48 ms.
// So his hand is always one element behind the keyer, and the memory catches
// touches that, by the sound, belonged to the element before.
//
// The setting picks when in an element the memory listens:
//   'on'      always (the standard iambic keyer, and today's behaviour)
//   'half'    only from half way through the element, and in the space after it
//   'quarter' only in the last quarter of the element, and in the space after it
//   'off'     never: only a paddle still closed when the keyer chooses the next
//             element sends it (the paddle held, as on every keyer)
// A press the memory does not take is not lost while the paddle stays closed:
// the keyer still sees it held when it chooses the next element. Only a touch
// that is let go again before then is forgotten. The memory never adds an
// element; it only decides which presses it keeps. Nothing here keys anything.
//
// Dual-mode: `require()` in tests, `window.CwPaddleMemory` in ECHOCAT Web
// (inlined by lib/remote-server.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CwPaddleMemory = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT = 'on';

  // value -> { label, from }: `from` is the share of the element after which a
  // press is remembered (0 = from the start; null = never).
  var MODES = [
    { value: 'on', label: 'On (standard)', from: 0 },
    { value: 'half', label: 'Second half only', from: 0.5 },
    { value: 'quarter', label: 'Last quarter only', from: 0.75 },
    { value: 'off', label: 'Off', from: null },
  ];

  function find(value) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].value === value) return MODES[i];
    return null;
  }

  // A saved or received value, cleaned: anything unknown is the default.
  function normalize(value) {
    return find(value) ? value : DEFAULT;
  }

  // Does the keyer remember a press that came `sinceStartMs` after it chose
  // the element now sounding, `elementMs` long? In the space after the
  // element (sinceStartMs >= elementMs) every setting but 'off' remembers it.
  function remembers(value, sinceStartMs, elementMs) {
    var m = find(value) || find(DEFAULT);
    if (m.from === null) return false;
    if (m.from === 0) return true;
    var len = Number(elementMs) || 0;
    var since = Number(sinceStartMs) || 0;
    return since >= m.from * len;
  }

  return { DEFAULT: DEFAULT, MODES: MODES, normalize: normalize, remembers: remembers };
}));
