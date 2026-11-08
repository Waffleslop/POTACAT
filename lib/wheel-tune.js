/**
 * Which way one mouse-wheel notch tunes. The convention on radios and every
 * major logger: wheel up (deltaY < 0) = frequency up, wheel down = down
 * (#192 w0tlp: the VFO window had it backwards). No vertical movement
 * (a sideways scroll) tunes nothing.
 * Dual-mode: require() in tests, window.WheelTune in the VFO window.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WheelTune = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /** @returns {1|-1|0} +1 = tune up, -1 = tune down, 0 = do nothing */
  function wheelDir(deltaY) {
    const d = Number(deltaY);
    if (!(d < 0) && !(d > 0)) return 0;
    return d < 0 ? 1 : -1;
  }
  return { wheelDir: wheelDir };
});
