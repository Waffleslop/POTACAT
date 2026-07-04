/**
 * Rig family resolution — SHARED between main, the renderer, and tests.
 * Single source of truth for "what kind of radio is this rig?" and "which
 * audio sources make sense for it?". Replaces the copy-pasted
 * `type === 'tcp' && port ∈ 5002-5005` Flex test that had drifted into 5+
 * call sites, and drives the rig-scoped settings UI (an IC-7300 user must
 * never see Flex DAX options — N3VD-adjacent report 2026-07-03).
 *
 * Dual-mode: Node `require()` gets `module.exports`; the browser (loaded via
 * a plain <script> tag — the renderers have no require) gets a global
 * `window.RigFamily`. No DOM or Node dependencies.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RigFamily = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FLEX_SHIM_PORTS = [5002, 5003, 5004, 5005];

  function _isLocalHost(host) {
    return !host || host === '127.0.0.1' || host === 'localhost';
  }

  /**
   * Family from a catTarget alone.
   * 'tcp' is ambiguous: the SmartSDR-Win Kenwood shim (localhost 5002-5005)
   * means Flex; any other host/port is a generic IP-CAT radio.
   * @returns {'flex'|'icom'|'icom-network'|'k4'|'serial'|'hamlib'|'rigctld'|'generic'|'none'}
   */
  function familyFromCatTarget(t) {
    if (!t || !t.type) return 'none';
    switch (t.type) {
      case 'tcp':
        return _isLocalHost(t.host) && FLEX_SHIM_PORTS.indexOf(t.port) !== -1
          ? 'flex' : 'generic';
      case 'k4-network':   return 'k4';
      case 'serial':       return 'serial';
      case 'icom':         return 'icom';
      case 'civ-tcp':      return 'icom';
      case 'icom-network': return 'icom-network';
      case 'rigctld':      return 'hamlib';
      case 'rigctldnet':   return 'rigctld';
      default:             return 'generic';
    }
  }

  /**
   * Family from a rig profile (settings.rigs[] entry) OR a bare catTarget.
   * A rig with flexApiHost set is a Flex regardless of catTarget shape
   * (Flex Direct talks to the radio on 4992; the tcp shim target is only
   * the SmartSDR-detect path).
   */
  function rigFamily(rig) {
    if (!rig) return 'none';
    if (rig.flexApiHost) return 'flex';
    return familyFromCatTarget(rig.catTarget || (rig.type ? rig : null));
  }

  /** Family from the rig editor's radio-type radio-button value. */
  function familyFromRadioType(radioType) {
    switch (radioType) {
      case 'flex':         return 'flex';
      case 'tcpcat':       return 'generic';
      case 'k4network':    return 'k4';
      case 'serialcat':    return 'serial';
      case 'icom':         return 'icom';
      case 'civ-tcp':      return 'icom';
      case 'icom-network': return 'icom-network';
      case 'hamlib':       return 'hamlib';
      case 'rigctldnet':   return 'rigctld';
      default:             return 'none';
    }
  }

  function isFlex(rig) {
    return rigFamily(rig) === 'flex';
  }

  /**
   * Which JTCAT/SSTV audio sources make sense for a rig family, in
   * preference order (first entry = the default for NEW rigs of that
   * family). Every family can fall back to a local soundcard ('dax'
   * internally, for legacy settings compat) — only Flex should ever see
   * the word "DAX" on screen. K4-network RX/TX audio rides the CAT
   * connection automatically (keyed off catTarget.type in main, not
   * audioSource), so the K4 offers only the local-device path here.
   */
  function audioSourcesFor(family) {
    if (family === 'flex') {
      return [
        { value: 'smartsdr', label: 'Flex Direct — VITA-49, no DAX program' },
        { value: 'dax', label: 'Local audio device (DAX)' },
      ];
    }
    if (family === 'icom-network') {
      return [
        { value: 'icom-network', label: 'Icom Network audio (RS-BA1)' },
        { value: 'dax', label: 'Local audio device (USB soundcard)' },
      ];
    }
    return [{ value: 'dax', label: 'Local audio device (USB soundcard)' }];
  }

  function defaultAudioSourceFor(family) {
    return audioSourcesFor(family)[0].value;
  }

  /** True when `source` is a legal audioSource value for the family. */
  function audioSourceValidFor(family, source) {
    return audioSourcesFor(family).some(function (o) { return o.value === source; });
  }

  return {
    familyFromCatTarget: familyFromCatTarget,
    familyFromRadioType: familyFromRadioType,
    rigFamily: rigFamily,
    isFlex: isFlex,
    audioSourcesFor: audioSourcesFor,
    defaultAudioSourceFor: defaultAudioSourceFor,
    audioSourceValidFor: audioSourceValidFor,
  };
});
