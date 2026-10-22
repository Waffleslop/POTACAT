/**
 * Winlink transports and where each can run — SHARED between main, the
 * renderers and tests (dual-mode like lib/rig-family.js: require() gets
 * module.exports, a <script> tag gets window.WinlinkModes).
 *
 * The rule (rig-scoped UI): never offer a mode that cannot work on this
 * station, and when one is unavailable say WHY in words the operator can act
 * on. Every radio mode runs an external modem that must open a real sound
 * device, so a rig whose audio is Flex Direct (VITA-49) or Icom Network
 * (RS-BA1) has no device for it — that is a fact about the rig, not a bug.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WinlinkModes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABELS = {
    telnet: 'Internet (telnet)',
    ardop: 'ARDOP (radio)',
    mercury: 'Mercury (radio, experimental)',
    vara: 'VARA HF (radio, your own VARA)',
  };

  /**
   * @param {object} o
   * @param {string} o.rigFamily     RigFamily.rigFamily(activeRig)
   * @param {string} o.audioSource   the active rig's audioSource
   * @param {string} o.platform      process.platform / navigator-derived
   * @param {boolean} o.remote       this desktop is driving another shack
   * @param {boolean} o.mercuryEnabled
   * @param {number} o.mercuryPort   Mercury's control port
   * @param {number} o.varaPort
   * @param {boolean} o.ardopFound   the ardopcf binary was found
   * @param {boolean} o.showVara     offer VARA HF (off: Casey 2026-10-22 — not in
   *                                 the first release; nothing of VARA ships either way)
   * @returns {{id:string,label:string,available:boolean,reason:string}[]}
   */
  function winlinkModesFor(o) {
    o = o || {};
    var out = [{ id: 'telnet', label: LABELS.telnet, available: true, reason: '' }];
    var radioReason = '';
    if (o.remote) radioReason = 'Radio sessions key the shack\'s radio — start them on the shack PC';
    else if (!o.rigFamily || o.rigFamily === 'none') radioReason = 'Needs a radio with CAT control (POTACAT tunes and keys it for the session)';
    else if (o.audioSource === 'smartsdr') radioReason = 'This radio\'s audio is Flex Direct, which no other program can open — set the rig\'s audio to DAX to use radio Winlink';
    else if (o.audioSource === 'icom-network') radioReason = 'This radio\'s audio is Icom Network, which no other program can open — use a USB sound card for radio Winlink';

    var ardopReason = radioReason;
    if (!ardopReason && o.platform === 'darwin') ardopReason = 'ARDOP (ardopcf) has no macOS build';
    if (!ardopReason && o.ardopFound === false) ardopReason = 'ardopcf was not found — reinstall POTACAT or set its path in Settings';
    out.push({ id: 'ardop', label: LABELS.ardop, available: !ardopReason, reason: ardopReason });

    var mercReason = radioReason;
    if (!mercReason && !o.mercuryEnabled) mercReason = 'Turn on Mercury in Settings > Station first';
    out.push({ id: 'mercury', label: LABELS.mercury, available: !mercReason, reason: mercReason });

    if (!o.showVara) return out;
    var varaReason = radioReason;
    if (!varaReason && o.platform && o.platform !== 'win32') varaReason = 'VARA HF is a Windows program';
    if (!varaReason && o.mercuryEnabled && Number(o.varaPort) === Number(o.mercuryPort)) {
      varaReason = 'VARA and Mercury are set to the same port (' + o.varaPort + ') — change one in Settings';
    }
    out.push({ id: 'vara', label: LABELS.vara, available: !varaReason, reason: varaReason });
    return out;
  }

  /** The mode to use: the wanted one when available, else telnet. */
  function pickWinlinkMode(modes, wanted) {
    var list = Array.isArray(modes) ? modes : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === wanted && list[i].available) return wanted;
    return 'telnet';
  }

  function isRadioMode(id) {
    return id === 'ardop' || id === 'mercury' || id === 'vara';
  }

  return { LABELS: LABELS, winlinkModesFor: winlinkModesFor, pickWinlinkMode: pickWinlinkMode, isRadioMode: isRadioMode };
});
