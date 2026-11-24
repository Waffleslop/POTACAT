// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Where a rig's sound card interface plugs in, and what that means for the
// radio's mode while POTACAT transmits (GitHub #153).
//
// One question per rig in the rig editor:
//   - Data, ACC or USB jack (the default, and POTACAT's behaviour before this
//     setting): digital modes switch the radio to its DATA mode as before. A
//     tick box decides whether voice macros and ECHOCAT voice also switch to
//     DATA while transmitting; a rig that has never set it follows the global
//     SSB-over-DATA setting, with the Yaesu voice exception (a Yaesu's DATA-U
//     narrows and shifts voice), exactly as before. Ticked, it switches on a
//     Yaesu too: the operator with an FT-897D and a SignaLink on the data jack
//     asked for that (rocketrick9188, #894).
//   - Microphone jack: the radio is never switched to a DATA mode, on any path
//     (FT8, FT4, WSPR, PSK, JS8, FreeDV, SSTV, Winlink, packet, voice), and the
//     log says why. In a DATA mode the radio's microphone jack is off, so the
//     interface's audio would never reach the transmitter (minus03717,
//     IC-756PRO II with a RigBlaster).
//
// The global "Switch radio to DATA mode (PKTUSB) for FT8 / FT4 (JTCAT)" and
// "... for FreeDV" settings stay as they are for data-jack radios: they exist
// for radios whose DATA filter is too narrow (lib/plain-ssb-for-digital.js).
//
// What goes out is unchanged by this rule: FT8 sent in USB from a mic-jack
// radio is still DATA to the licence and Guest Pass checks (the caller's
// emission, never the radio's mode).
//
// Only radios that take a sound card interface have the question: a Flex, a
// TCI SDR, an Icom over the LAN and a Yaesu SCU-LAN10 carry audio over the
// network, and a radio with no CAT control is never switched by POTACAT.
//
// No radio menu path lives here; setup steps are lib/rig-setup-notes.js.
//
// Dual-mode: Node `require()` gets module.exports; the browser gets
// window.RigAudioJack. Pure: no DOM, no Node.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RigAudioJack = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DATA = 'data';
  var MIC = 'mic';

  // What the operator reads in the rig editor.
  var QUESTION = 'Where is your sound card interface plugged in?';
  var CHOICE_DATA = 'Data, ACC or USB jack';
  var CHOICE_MIC = 'Microphone jack';
  var HELP_DATA = 'Most interfaces, and a radio\'s own USB audio. POTACAT switches the radio to its DATA mode for FT8, WSPR, PSK, SSTV and Winlink, and puts the mode back afterwards.';
  var VOICE_SWITCH_LABEL = 'Voice macros and ECHOCAT voice switch to DATA while transmitting';
  var VOICE_SWITCH_HELP = 'The radio goes to DATA for the transmission and back to USB or LSB when it ends, so the radio\'s own microphone stays quiet. Works on a Yaesu too.';
  var HELP_MIC = 'POTACAT never switches this radio to a DATA mode: FT8, WSPR, PSK, FreeDV, SSTV, Winlink and voice all go out in USB, LSB or FM. Warning for Icom owners: an Icom takes USB or rear-socket audio only in a DATA mode unless its menus are changed, so picking the microphone jack by mistake sends SSTV and Winlink as a silent carrier. Pick this only if the audio cable really goes into the microphone socket.';

  // Families whose transmit audio comes from a sound card on one of the
  // radio's jacks (lib/rig-family.js names).
  var SOUND_CARD_FAMILIES = ['serial', 'icom', 'hamlib', 'rigctld', 'flrig', 'commander', 'generic'];

  // Radio-type values of the rig editor that show the question.
  var SOUND_CARD_RADIO_TYPES = ['serialcat', 'tcpcat', 'icom', 'civ-tcp', 'hamlib', 'rigctldnet', 'flrig', 'dxlab-commander'];

  function appliesToFamily(family) {
    return SOUND_CARD_FAMILIES.indexOf(String(family || '')) !== -1;
  }

  function appliesToRadioType(radioType) {
    return SOUND_CARD_RADIO_TYPES.indexOf(String(radioType || '')) !== -1;
  }

  function normalizeJack(v) {
    return v === MIC ? MIC : DATA;
  }

  /**
   * The rig's jack. Absent (every rig before #153) is the data jack.
   * @param {object|null} rig     settings.rigs[] entry
   * @param {string} [family]     RigFamily.rigFamily(rig); a network or no-CAT rig is always 'data'
   */
  function jackOf(rig, family) {
    if (!rig || rig.audioJack !== MIC) return DATA;
    if (family !== undefined && !appliesToFamily(family)) return DATA;
    return MIC;
  }

  /** The tick box: true or false once the operator set it, null = follow the global setting. */
  function voiceSwitchOf(rig) {
    if (!rig || typeof rig.voiceDataSwitch !== 'boolean') return null;
    return rig.voiceDataSwitch;
  }

  // Data mode names a tune can carry, and the voice mode each one becomes on
  // a microphone-jack radio. Engine names (FT8, WSPR, ...) are upper-sideband
  // data, the same as tuneRadio maps them.
  var TO_UPPER = ['FT8', 'FT4', 'FT2', 'DIGU', 'PKTUSB', 'JS8', 'WSPR', 'JTTY', 'USB-D', 'DATA-U'];
  var TO_LOWER = ['DIGL', 'PKTLSB', 'LSB-D', 'DATA-L'];
  var TO_FM = ['DIGFM', 'PKTFM', 'FM-D', 'DATA-FM'];
  var TO_AM = ['DIGAM', 'PKTAM', 'AM-D'];

  function voiceFormOf(mode) {
    var m = String(mode || '').toUpperCase();
    if (!m) return null;
    if (TO_UPPER.indexOf(m) !== -1 || /^PSK\d+$/.test(m)) return 'USB';
    if (TO_LOWER.indexOf(m) !== -1) return 'LSB';
    if (TO_FM.indexOf(m) !== -1) return 'FM';
    if (TO_AM.indexOf(m) !== -1) return 'AM';
    return null;
  }

  // The data-jack rule for a tune is lib/plain-ssb-for-digital.js, unchanged.
  // Node only: the browser uses this module for the editor's words.
  var plainSsbForDigital = (typeof require === 'function')
    ? require('./plain-ssb-for-digital').plainSsbForDigital
    : function (mode) { return mode; };

  var JTCAT_SETTING = '"Switch radio to DATA mode (PKTUSB) for FT8 / FT4 (JTCAT)"';

  function micJackTuneLog(from, to) {
    return '[tune] ' + String(from).toUpperCase() + ' -> ' + to + ': this rig\'s sound card interface is on the microphone jack (Settings > Radio, Edit the rig), so POTACAT does not switch the radio to a DATA mode';
  }

  /**
   * The mode a CAT tune sends (tuneRadio). Every digital tune comes here:
   * FT8/FT4/FT2, WSPR, JS8, JTTY, PSK, FreeDV (DIGU/DIGL), Winlink HF (DIGU),
   * APRS 30 m.
   * @param {string} mode
   * @param {object} o
   * @param {string} o.jack           jackOf(rig)
   * @param {boolean} o.useDataMode   settings.jtcatUseDataMode !== false (the data-jack fallback)
   * @param {string} [o.purpose]      'winlink' for a Winlink radio session
   * @param {boolean} [o.freedv]      a FreeDV tune (already resolved by its own setting)
   * @returns {{mode:string, log:string}} log '' when nothing changed
   */
  function tuneMode(mode, o) {
    o = o || {};
    if (!mode) return { mode: mode, log: '' };
    if (normalizeJack(o.jack) === MIC) {
      var voice = voiceFormOf(mode);
      if (!voice) return { mode: mode, log: '' };
      return { mode: voice, log: micJackTuneLog(mode, voice) };
    }
    var plain = plainSsbForDigital(mode, { useDataMode: o.useDataMode, purpose: o.purpose, freedv: o.freedv });
    if (plain === mode) return { mode: mode, log: '' };
    return { mode: plain, log: '[tune] ' + String(mode).toUpperCase() + ' -> ' + plain + ': ' + JTCAT_SETTING + ' is off' };
  }

  /** A TCI (SDR) tune's data flag: the same rule, for a family that has no jack. */
  function digitalUsesData(o) {
    o = o || {};
    if (normalizeJack(o.jack) === MIC) return false;
    return o.useDataMode !== false;
  }

  /**
   * "Packet mode on the radio" as the resolver sees it (lib/packet-rig-mode.js):
   * a microphone-jack radio runs packet in plain FM, whatever the choice says.
   */
  function packetChoice(choice, jack) {
    if (normalizeJack(jack) === MIC) return 'fm';
    return choice;
  }

  /** "Voice in DATA mode" (rig.voiceAsData, GitHub #24) applies only on a data-jack radio. */
  function voiceAsDataOn(rig, jack) {
    return !!(rig && rig.voiceAsData) && normalizeJack(jack) !== MIC;
  }

  var VOICE_SWITCH_REASON = 'this rig is set to switch voice to DATA while transmitting';
  var SSB_OVER_DATA_REASON = 'SSB-over-DATA: mic disabled';

  /**
   * What a key-down (handleRemotePtt) may do with the mode.
   * @param {object} o
   * @param {string} o.jack            jackOf(rig)
   * @param {boolean|null} o.voiceSwitch voiceSwitchOf(rig)
   * @param {boolean} o.ssbOverData    settings.ssbOverData (the fallback)
   * @param {boolean} o.forced         opts.forceDataMode: this audio reaches the radio only in DATA (SSTV/Winlink on an Icom, Icom LAN voice)
   * @param {boolean} o.yaesu          the active model is a Yaesu
   * @param {boolean} o.freedvRunning  the FreeDV engine is running
   * @param {boolean} o.voiceAsData    rig.voiceAsData
   * @returns {{forceData:boolean, want:boolean, yaesuVoice:boolean, voiceInData:boolean,
   *   yaesuSkip:boolean, micSkip:boolean, reason:string}}
   *   forceData   the forced path stands (keys even with the FT8 engine running)
   *   want        a switch to DATA is wanted, before the caller's own audio/engine checks
   *   yaesuVoice  voice on a Yaesu stays in USB/LSB (the global setting's exception)
   *   voiceInData the radio is in USB-D/LSB-D for voice already
   *   yaesuSkip   the global setting asked for a switch the Yaesu exception refused (log hint)
   *   micSkip     a switch would have happened, but the interface is on the microphone jack
   *   reason      the log's reason for a non-forced switch
   */
  function pttDataPlan(o) {
    o = o || {};
    var forced = !!o.forced;
    var ssbOverData = !!o.ssbOverData;
    if (normalizeJack(o.jack) === MIC) {
      return {
        forceData: false, want: false, yaesuVoice: false, voiceInData: false, yaesuSkip: false,
        micSkip: forced || ssbOverData, reason: '',
      };
    }
    var vs = typeof o.voiceSwitch === 'boolean' ? o.voiceSwitch : null;
    var voiceInData = !forced && !!o.voiceAsData;
    if (vs === true) {
      return { forceData: forced, want: true, yaesuVoice: false, voiceInData: voiceInData, yaesuSkip: false, micSkip: false, reason: VOICE_SWITCH_REASON };
    }
    var yaesuVoice = !forced && !!o.yaesu && !o.freedvRunning;
    if (vs === false) {
      return { forceData: forced, want: forced, yaesuVoice: yaesuVoice, voiceInData: voiceInData, yaesuSkip: false, micSkip: false, reason: SSB_OVER_DATA_REASON };
    }
    return {
      forceData: forced, want: ssbOverData || forced, yaesuVoice: yaesuVoice, voiceInData: voiceInData,
      yaesuSkip: ssbOverData && !forced && yaesuVoice, micSkip: false, reason: SSB_OVER_DATA_REASON,
    };
  }

  var KIND_NAMES = { sstv: 'SSTV', winlink: 'Winlink', tune: 'the tune carrier', macro: 'the voice macro', voice: 'voice' };

  /** The log line for a key-down that stays out of DATA because of the microphone jack. */
  function micJackPttLog(o) {
    o = o || {};
    var what = KIND_NAMES[o.txKind] || (o.forced ? 'this transmission' : 'voice');
    var mode = String(o.mode || '').toUpperCase() || 'its voice mode';
    return '[PTT] staying in ' + mode + ': this rig\'s sound card interface is on the microphone jack (Settings > Radio, Edit the rig), so ' + what + ' goes out without a switch to a DATA mode';
  }

  return {
    DATA: DATA, MIC: MIC,
    QUESTION: QUESTION, CHOICE_DATA: CHOICE_DATA, CHOICE_MIC: CHOICE_MIC,
    HELP_DATA: HELP_DATA, HELP_MIC: HELP_MIC, VOICE_SWITCH_LABEL: VOICE_SWITCH_LABEL, VOICE_SWITCH_HELP: VOICE_SWITCH_HELP,
    SOUND_CARD_FAMILIES: SOUND_CARD_FAMILIES, SOUND_CARD_RADIO_TYPES: SOUND_CARD_RADIO_TYPES,
    appliesToFamily: appliesToFamily, appliesToRadioType: appliesToRadioType,
    normalizeJack: normalizeJack, jackOf: jackOf, voiceSwitchOf: voiceSwitchOf, voiceFormOf: voiceFormOf,
    tuneMode: tuneMode, digitalUsesData: digitalUsesData, packetChoice: packetChoice, voiceAsDataOn: voiceAsDataOn,
    pttDataPlan: pttDataPlan, micJackPttLog: micJackPttLog, micJackTuneLog: micJackTuneLog,
  };
});
