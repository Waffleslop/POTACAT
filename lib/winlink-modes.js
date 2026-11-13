/**
 * Winlink transports and where each can run — SHARED between main, the
 * renderers and tests (dual-mode like lib/rig-family.js: require() gets
 * module.exports, a <script> tag gets window.WinlinkModes).
 *
 * The rule (rig-scoped UI): never offer a mode that cannot work on this
 * station, and when one is unavailable say WHY in words the operator can act
 * on. ARDOP and packet take their audio from POTACAT itself (the socket
 * backends, docs/modem-audio-bridge-plan.md) and run on every rig and OS;
 * Mercury (not offered, #372) and VARA open a sound device of their own, so a rig whose audio is
 * Flex Direct (VITA-49) or Icom Network (RS-BA1) has no device for them —
 * unless, for VARA, the operator set up the virtual cable POTACAT bridges.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WinlinkModes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MERCURY_OFFERED = false;
  /** What a start in a mode that is no longer listed says. */
  var NOT_OFFERED = { mercury: 'Mercury is not offered for Winlink: no Winlink gateway runs it. Pick ARDOP, packet or the internet.' };

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
   * @param {string} [o.fmModeNote]  one line when the rig's packet mode is FM data the operator sets by hand (lib/packet-rig-mode.js)
   * @param {boolean} o.ardopFound   the ardopcf binary was found
   * @param {boolean} o.direwolfFound the Dire Wolf binary was found
   * @param {boolean} o.ardopSocketAudio ardopcf AND Dire Wolf take their audio from POTACAT
   *                                 (the socket backends — no sound device of their own on any rig)
   * @param {{enabled:boolean, port:number, host?:string, hostBad?:string, cable:boolean}} [o.varaHf]
   *                                 the operator's own VARA HF (listed only when enabled in Settings;
   *                                 `host` = where it runs, 127.0.0.1 by default; `hostBad` = a typed
   *                                 host that is not a name or address; `cable` = rig.modemCable set)
   * @param {{enabled:boolean, port:number, host?:string, hostBad?:string, cable:boolean}} [o.varaFm]
   *                                 the operator's own VARA FM
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
    else if (!o.rigFamily) linkReason = 'Set up a radio first (Settings > My Rigs)';
    // No CAT control (NA4DQ 2026-10-30, an HT and Dire Wolf: "They simply have
    // you manually QSY to the gateway frequency"): the session runs, the
    // operator sets the dial by hand and POTACAT keys the radio by VOX, a
    // serial PTT line or a CM108 sound card, the way every other no-CAT TX does.
    var noCatNote = o.rigFamily === 'none'
      ? 'No CAT control: set the radio to the gateway frequency yourself; POTACAT keys it by VOX or the PTT line chosen in Settings > My Rigs'
      : '';
    var deviceReason = '';
    var deviceName = '';
    if (o.audioSource === 'smartsdr') { deviceName = 'Flex Direct'; deviceReason = 'This radio\'s audio is Flex Direct, which no other program can open — set the rig\'s audio to DAX to use radio Winlink'; }
    else if (o.audioSource === 'icom-network') { deviceName = 'Icom Network'; deviceReason = 'This radio\'s audio is Icom Network, which no other program can open — use a USB sound card for radio Winlink'; }
    else if (o.audioSource === 'yaesu-lan') { deviceName = 'Yaesu LAN'; deviceReason = 'This radio\'s audio is the Yaesu LAN (SCU-LAN10), which is receive only and no other program can open — use a USB sound card for radio Winlink'; }
    var radioReason = linkReason || deviceReason;

    // ARDOP and packet need no sound device when the modem takes its audio
    // from POTACAT (the socket backends, every OS): the device reason does
    // not apply to them.
    var socketReason = o.ardopSocketAudio ? linkReason : radioReason;
    var ardopReason = socketReason;
    if (!ardopReason && o.ardopFound === false) ardopReason = 'ardopcf was not found — reinstall POTACAT or set its path in Settings';
    out.push({ id: 'ardop', label: LABELS.ardop, available: !ardopReason, reason: ardopReason , note: ardopReason ? '' : noCatNote });

    var packetReason = socketReason;
    if (!packetReason && o.direwolfFound === false) packetReason = 'Dire Wolf was not found — reinstall POTACAT or set its path in Settings';
    var fmNote = noCatNote || String(o.fmModeNote || '');
    out.push({ id: 'packet', label: LABELS.packet, available: !packetReason, reason: packetReason , note: packetReason ? '' : fmNote });

    // Mercury is NOT offered for Winlink (Casey 2026-11-12, #372): no Winlink
    // gateway runs it, so the mode listed VARA gateways that could never
    // answer, and it has not carried one session. The Mercury chat window
    // (More > Mercury HF Data) is a separate feature and is untouched. The
    // session code for it stays; flip MERCURY_OFFERED when gateways exist.
    if (MERCURY_OFFERED) {
      var mercReason = radioReason;
      if (!mercReason && !o.mercuryEnabled) mercReason = 'Turn on Mercury in Settings > Station first';
      out.push({ id: 'mercury', label: LABELS.mercury, available: !mercReason, reason: mercReason , note: mercReason ? '' : noCatNote });
    }

    // VARA (EA5HVK's closed-source modems): the operator's own copy, pointed
    // at by Pat — nothing of VARA ships. On Windows on this PC, under Wine on
    // Linux or macOS, or on another computer at `host` (#287, Casey 2026-11-11:
    // "I want mac, Linux and windows to have all available modems"). Listed
    // only when turned on in Settings, so the picker stays honest. Whether
    // VARA answers is checked at session start, never here: a VARA not yet
    // started must not grey the mode.
    function isLocal(h) { h = String(h || '127.0.0.1').toLowerCase(); return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h); }
    function sameHost(a, b) { return isLocal(a) && isLocal(b) ? true : String(a || '127.0.0.1').toLowerCase() === String(b || '127.0.0.1').toLowerCase(); }
    function vara(id, name, v) {
      var reason = '';
      var local = isLocal(v.host);
      if (linkReason) reason = linkReason;
      // VARA on another computer opens that computer's sound card: this
      // radio's audio type does not matter to it.
      else if (local && deviceReason && !v.cable) reason = 'VARA cannot open this radio\'s audio (' + deviceName + ') — set up the virtual audio cable in Settings > Station > Winlink';
      if (!reason && v.hostBad) reason = name + '\'s Host box says "' + v.hostBad + '", which is not a computer name or address — fix it in Settings > Station > Winlink';
      if (!reason && id === 'vara' && local && o.mercuryEnabled && Number(v.port) === Number(o.mercuryPort)) {
        reason = 'VARA and Mercury are set to the same port (' + v.port + ') — change one in Settings';
      }
      if (!reason && id === 'varafm' && o.varaHf && o.varaHf.enabled && sameHost(v.host, o.varaHf.host) && Number(v.port) === Number(o.varaHf.port)) {
        reason = 'VARA FM and VARA HF are set to the same port (' + v.port + ') — set VARA FM to 8310 in its Settings and in POTACAT';
      }
      // Each VARA also listens one port above its command port (its data
      // port), so two on the same computer cannot sit next to each other.
      if (!reason && id === 'varafm' && o.varaHf && o.varaHf.enabled && sameHost(v.host, o.varaHf.host) && Math.abs(Number(v.port) - Number(o.varaHf.port)) === 1) {
        reason = 'VARA FM and VARA HF are set to ports next to each other (' + v.port + ' and ' + o.varaHf.port + '), and each VARA also uses the next port up — set VARA FM to 8310 in its Settings and in POTACAT';
      }
      return { id: id, label: LABELS[id], available: !reason, reason: reason, note: reason ? '' : (id === 'varafm' ? fmNote : noCatNote) };
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

  /** FM modes: the session QSYs to FM, then to the rig's packet mode (lib/packet-rig-mode.js), and the band picker is VHF/UHF. */
  function isFmMode(id) {
    return id === 'packet' || id === 'varafm';
  }

  return { MERCURY_OFFERED: MERCURY_OFFERED, NOT_OFFERED: NOT_OFFERED, LABELS: LABELS, winlinkModesFor: winlinkModesFor, pickWinlinkMode: pickWinlinkMode, isRadioMode: isRadioMode, isFmMode: isFmMode };
});
