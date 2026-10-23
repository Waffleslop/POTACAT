/**
 * Winlink transports and where each can run — SHARED between main, the
 * renderers and tests (dual-mode like lib/rig-family.js: require() gets
 * module.exports, a <script> tag gets window.WinlinkModes).
 *
 * The rule (rig-scoped UI): never offer a mode that cannot work on this
 * station, and when one is unavailable say WHY in words the operator can act
 * on. ARDOP and packet take their audio from POTACAT itself (the socket
 * backends, docs/modem-audio-bridge-plan.md) and run on every rig and OS;
 * Mercury and VARA open a sound device of their own, so a rig whose audio is
 * Flex Direct (VITA-49) or Icom Network (RS-BA1) has no device for them —
 * unless, for VARA, the operator set up the virtual cable POTACAT bridges.
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
    packet: 'Packet (VHF/UHF radio)',
    mercury: 'Mercury (radio, experimental)',
    vara: 'VARA HF (radio, your own VARA)',
    varafm: 'VARA FM (VHF/UHF radio, your own VARA FM)',
  };

  /**
   * @param {object} o
   * @param {string} o.rigFamily     RigFamily.rigFamily(activeRig)
   * @param {string} o.audioSource   the active rig's audioSource
   * @param {string} o.platform      process.platform / navigator-derived
   * @param {boolean} o.remote       this desktop is driving another shack
   * @param {boolean} o.mercuryEnabled
   * @param {number} o.mercuryPort   Mercury's control port
   * @param {boolean} o.ardopFound   the ardopcf binary was found
   * @param {boolean} o.direwolfFound the Dire Wolf binary was found
   * @param {boolean} o.ardopSocketAudio ardopcf AND Dire Wolf take their audio from POTACAT
   *                                 (the socket backends — no sound device of their own on any rig)
   * @param {{enabled:boolean, port:number, cable:boolean}} [o.varaHf]  the operator's own VARA HF
   *                                 (listed only when enabled in Settings; `cable` = rig.modemCable set)
   * @param {{enabled:boolean, port:number, cable:boolean}} [o.varaFm]  the operator's own VARA FM
   * @returns {{id:string,label:string,available:boolean,reason:string}[]}
   */
  function winlinkModesFor(o) {
    o = o || {};
    var out = [{ id: 'telnet', label: LABELS.telnet, available: true, reason: '' }];
    // Two kinds of reason: the LINK (no radio / not this PC) stops every radio
    // mode; the DEVICE (audio only POTACAT can reach) stops a modem that opens
    // a sound card itself.
    var linkReason = '';
    if (o.remote) linkReason = 'Radio sessions key the shack\'s radio — start them on the shack PC';
    else if (!o.rigFamily || o.rigFamily === 'none') linkReason = 'Needs a radio with CAT control (POTACAT tunes and keys it for the session)';
    var deviceReason = '';
    var deviceName = '';
    if (o.audioSource === 'smartsdr') { deviceName = 'Flex Direct'; deviceReason = 'This radio\'s audio is Flex Direct, which no other program can open — set the rig\'s audio to DAX to use radio Winlink'; }
    else if (o.audioSource === 'icom-network') { deviceName = 'Icom Network'; deviceReason = 'This radio\'s audio is Icom Network, which no other program can open — use a USB sound card for radio Winlink'; }
    var radioReason = linkReason || deviceReason;

    // ARDOP and packet need no sound device when the modem takes its audio
    // from POTACAT (the socket backends, every OS): the device reason does
    // not apply to them.
    var socketReason = o.ardopSocketAudio ? linkReason : radioReason;
    var ardopReason = socketReason;
    if (!ardopReason && o.ardopFound === false) ardopReason = 'ardopcf was not found — reinstall POTACAT or set its path in Settings';
    out.push({ id: 'ardop', label: LABELS.ardop, available: !ardopReason, reason: ardopReason });

    var packetReason = socketReason;
    if (!packetReason && o.direwolfFound === false) packetReason = 'Dire Wolf was not found — reinstall POTACAT or set its path in Settings';
    out.push({ id: 'packet', label: LABELS.packet, available: !packetReason, reason: packetReason });

    var mercReason = radioReason;
    if (!mercReason && !o.mercuryEnabled) mercReason = 'Turn on Mercury in Settings > Station first';
    out.push({ id: 'mercury', label: LABELS.mercury, available: !mercReason, reason: mercReason });

    // VARA (EA5HVK's closed-source modems): the operator's own installed copy
    // on Windows, pointed at by Pat — nothing of VARA ships. Listed only when
    // the operator turned it on in Settings, so the picker stays honest. The
    // program itself is checked at session start (started for them if asked),
    // never here: a copy run from an unusual path must not grey the mode.
    function vara(id, name, v) {
      var reason = '';
      if (o.platform && o.platform !== 'win32') reason = name + ' is a Windows program';
      else if (linkReason) reason = linkReason;
      else if (deviceReason && !v.cable) reason = 'VARA cannot open this radio\'s audio (' + deviceName + ') — set up the virtual audio cable in Settings > Station > Winlink';
      if (!reason && id === 'vara' && o.mercuryEnabled && Number(v.port) === Number(o.mercuryPort)) {
        reason = 'VARA and Mercury are set to the same port (' + v.port + ') — change one in Settings';
      }
      if (!reason && id === 'varafm' && o.varaHf && o.varaHf.enabled && Number(v.port) === Number(o.varaHf.port)) {
        reason = 'VARA FM and VARA HF are set to the same port (' + v.port + ') — set VARA FM to 8310 in its Settings and in POTACAT';
      }
      return { id: id, label: LABELS[id], available: !reason, reason: reason };
    }
    if (o.varaHf && o.varaHf.enabled) out.push(vara('vara', 'VARA HF', o.varaHf));
    if (o.varaFm && o.varaFm.enabled) out.push(vara('varafm', 'VARA FM', o.varaFm));
    return out;
  }

  /** The mode to use: the wanted one when available, else telnet. */
  function pickWinlinkMode(modes, wanted) {
    var list = Array.isArray(modes) ? modes : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === wanted && list[i].available) return wanted;
    return 'telnet';
  }

  function isRadioMode(id) {
    return id === 'ardop' || id === 'packet' || id === 'mercury' || id === 'vara' || id === 'varafm';
  }

  /** FM modes: the session QSYs to FM (an Icom keys FM-D through forceDataMode) and the band picker is VHF/UHF. */
  function isFmMode(id) {
    return id === 'packet' || id === 'varafm';
  }

  return { LABELS: LABELS, winlinkModesFor: winlinkModesFor, pickWinlinkMode: pickWinlinkMode, isRadioMode: isRadioMode, isFmMode: isFmMode };
});
