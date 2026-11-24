// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Can POTACAT set this radio's TX power? One rule, and what the RF-sense
// external-tuner Tune does when the answer is no.
//
// N5XHI, FT-857D through flrig, 2026-11-24: the Tune for an LDG-style tuner
// promised a 10 W carrier, the log said "power 100 W -> 10W ... radio confirms
// 100 W", and the radio transmitted at its own setting. Nothing had lowered it:
// the radio has no CAT command for power, on any path.
//
// Evidence, per radio and path (cited, never copied):
//   - FT-857D direct CAT: the Opcode Command Chart in the FT-857D Operating
//     Manual (EH007M108, printed p.117) lists lock, PTT, frequency, mode,
//     clarifier, VFO, split, repeater offset, tone and status reads. No power
//     opcode. Power is a front-panel menu (printed p.98). The FT-817/818 and
//     FT-897 speak the same legacy 5-byte CAT (lib/codecs/yaesu-legacy-codec.js,
//     where setTxPower is a stub).
//   - Its AM carrier is 25 W on HF and 6 m (spec table, printed p.2), which is
//     why the question names 25 W for the FT-857 and no figure for any other
//     radio: none of the others was checked against its manual.
//   - Hamlib: `rigctld -m <id> --dump-caps` on the bundled Hamlib 4.7.2 lists
//     no RFPOWER under "Set level" for 1020 FT-817, 1022 FT-857, 1023 FT-897,
//     1041 FT-818, 1043 FT-897D, 3010 IC-706MkII and 3011 IC-706MkIIG. Hamlib
//     refuses a level its backend does not list, so `L RFPOWER` sets nothing.
//   - flrig: its FT-817 / FT-857D / FT-897D drivers have no power control. Its
//     rig.set_power stores the number and rig.get_power returns that stored
//     number, so a set "succeeds" and "reads back" with the radio untouched.
//   - IC-706MKII / MKIIG: no CI-V level commands (lib/rig-models.js).
//   - DXLab Commander: the codec has no TX power command
//     (lib/codecs/commander-codec.js).
//
// What is NOT known is not guessed: any other radio through flrig, and a
// Hamlib backend that has not said what it can set, keep the behaviour they
// had (POTACAT sends the power commands).
//
// Dual-mode: Node `require()` gets module.exports; the browser gets
// window.TxPowerControl. Pure.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TxPowerControl = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Radios with no CAT command for TX power at all, so no program in front of
  // them can set it either. `names` are lib/rig-models.js rows, `xcvr` is
  // flrig's rig.get_xcvr name, `hamlib` the Hamlib model numbers above.
  var KNOWN_RADIOS = [
    { key: 'ft817', names: ['FT-817/818'], xcvr: /^FT-?81[78]/i, hamlib: [1020, 1041] },
    { key: 'ft857', names: ['FT-857'], xcvr: /^FT-?857/i, hamlib: [1022] },
    { key: 'ft897', names: ['FT-897'], xcvr: /^FT-?897/i, hamlib: [1023, 1043] },
    { key: 'ic706mkii', names: ['IC-706MKII'], xcvr: /^IC-?706\s*MK\s*II$/i, hamlib: [3010] },
    { key: 'ic706mkiig', names: ['IC-706MKIIG'], xcvr: /^IC-?706\s*MK\s*IIG$/i, hamlib: [3011] },
  ];

  // The only carrier figure that was checked against a manual (see above).
  var CARRIER_NOTE = { ft857: 'up to 25 W on HF for an FT-857' };

  function norm(s) { return String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ''); }

  /** The known no-power-command radio a rig-models row name is, or null. */
  function knownByName(modelName) {
    var n = norm(modelName);
    if (!n) return null;
    for (var i = 0; i < KNOWN_RADIOS.length; i++) {
      for (var j = 0; j < KNOWN_RADIOS[i].names.length; j++) if (norm(KNOWN_RADIOS[i].names[j]) === n) return KNOWN_RADIOS[i].key;
    }
    return null;
  }
  function knownByXcvr(xcvr) {
    var s = String(xcvr == null ? '' : xcvr).trim();
    if (!s) return null;
    for (var i = 0; i < KNOWN_RADIOS.length; i++) if (KNOWN_RADIOS[i].xcvr.test(s)) return KNOWN_RADIOS[i].key;
    return null;
  }
  function knownByHamlib(rigId) {
    var id = Number(rigId);
    if (!(id > 0)) return null;
    for (var i = 0; i < KNOWN_RADIOS.length; i++) if (KNOWN_RADIOS[i].hamlib.indexOf(id) >= 0) return KNOWN_RADIOS[i].key;
    return null;
  }

  /** How a rig is reached, from its catTarget: 'flrig' | 'rigctld' | 'commander' | 'none' | 'direct'. */
  function transportOf(catTarget) {
    var t = catTarget && catTarget.type;
    if (!t || t === 'none') return 'none';
    if (t === 'flrig') return 'flrig';
    if (t === 'rigctld' || t === 'rigctldnet') return 'rigctld';
    if (t === 'dxlab-commander') return 'commander';
    return 'direct';
  }

  /**
   * Can POTACAT set this radio's TX power?
   * @param {object} c
   *   transport         transportOf(catTarget); main's detectRigType() names also work
   *                     ('flrig', 'rigctld', 'commander'; anything else is a direct link)
   *   modelName         the rig's picked Radio Model ('' when none)
   *   ownRowTxpower     that model's own lib/rig-models.js caps.txpower (false = the
   *                     radio has no power command), null when no row
   *   ownRowProtocol    that row's protocol ('yaesu-legacy', ...)
   *   capsTxpower       the caps POTACAT runs the rig with (false = no power control)
   *   flrigXcvr         flrig's transceiver name, when connected
   *   hamlibRigId       the Hamlib model number, when known
   *   hamlibSetsRfpower what the connected Hamlib backend's dump_caps said about
   *                     RFPOWER under "Set level": true, false, or null (not said)
   * @returns {{canSet: boolean, why: string, radio: string|null}}
   */
  function canSetTxPower(c) {
    c = c || {};
    var transport = String(c.transport || '');
    var radio = knownByName(c.modelName)
      || (transport === 'flrig' ? knownByXcvr(c.flrigXcvr) : null)
      || (transport === 'rigctld' ? knownByHamlib(c.hamlibRigId) : null);
    if (radio) return { canSet: false, why: 'radio-has-no-power-command', radio: radio };
    if (c.ownRowProtocol === 'yaesu-legacy') return { canSet: false, why: 'radio-has-no-power-command', radio: null };
    if (transport === 'commander') return { canSet: false, why: 'commander', radio: null };
    // The radio's own row says it has no power command: no backend adds one.
    if (c.ownRowTxpower === false) return { canSet: false, why: 'radio-has-no-power-command', radio: null };
    if (transport === 'rigctld' && c.hamlibSetsRfpower === false) return { canSet: false, why: 'hamlib-no-rfpower', radio: null };
    if (c.capsTxpower === false) return { canSet: false, why: 'no-power-control', radio: null };
    // Everything else, an unknown flrig driver or Hamlib backend included:
    // not known to be unable, so nothing changes for it.
    return { canSet: true, why: '', radio: null };
  }

  // ---- The question, asked once per rig ------------------------------------

  var TUNE_LABEL = 'Tune now';
  var CANCEL_LABEL = 'Cancel';
  var CONFIRM_TITLE = "Tune at the radio's own power";
  var CONFIRM_MESSAGE = "POTACAT cannot turn this radio's power down.";

  function carrierLine(ctl) {
    var note = ctl && ctl.radio && CARRIER_NOTE[ctl.radio];
    return "The tune carrier goes out in AM at the radio's own power setting" + (note ? ' (' + note + ')' : '') + '.';
  }
  function confirmDetail(ctl) {
    return carrierLine(ctl) + '\n\nTurn RF POWER down on the radio first, then press ' + TUNE_LABEL + '.\n\nPOTACAT asks this once for this radio.';
  }
  /** The desktop question: dialog.showMessageBox options. Cancel is the default button. */
  function confirmDialog(ctl) {
    return {
      type: 'warning', title: CONFIRM_TITLE, message: CONFIRM_MESSAGE, detail: confirmDetail(ctl),
      buttons: [TUNE_LABEL, CANCEL_LABEL], defaultId: 1, cancelId: 1, noLink: true,
    };
  }
  /** The same question for a device (S2C tune-own-power-ask). */
  function remoteAsk(ctl, rig) {
    return {
      type: 'tune-own-power-ask', rigId: String((rig && rig.id) || ''), rigName: String((rig && rig.name) || ''),
      title: CONFIRM_TITLE, text: CONFIRM_MESSAGE + ' ' + confirmDetail(ctl), tuneLabel: TUNE_LABEL, cancelLabel: CANCEL_LABEL,
    };
  }
  /** True only for the Tune now button. Anything else, a closed dialog included, transmits nothing. */
  function answerIsTune(response) { return response === 0; }

  var REMOTE_REFUSAL = "Tune was not sent. POTACAT cannot turn this radio's power down, so the tune carrier goes out at the radio's own power setting. Confirm it once on the POTACAT desktop at the shack (press Tune there), then Tune works from here.";
  var NO_WINDOW_LINE = "[ExtATU] Tune not sent: POTACAT cannot turn this radio's power down and has to ask before the first tune at the radio's own power, and there is no POTACAT window to ask in. Press Tune once in POTACAT on this computer.";
  var CANCELLED_LINE = '[ExtATU] Tune cancelled at the own-power question: nothing was transmitted';
  var ASK_WINDOW_MS = 5 * 60 * 1000;   // how long a device's "Tune now" answers the question it was sent

  // ---- The remembered answer: settings.extAtuOwnPowerOk { rigId: {at, by, radio} }

  function radioTag(ctl) { return String((ctl && (ctl.radio || ctl.why)) || ''); }
  /** Confirmed for this rig AND for the radio it was confirmed as (a rig re-pointed at another radio asks again). */
  function isConfirmed(map, rigId, ctl) {
    var e = map && rigId && Object.prototype.hasOwnProperty.call(map, rigId) ? map[rigId] : null;
    return !!(e && typeof e === 'object' && e.at > 0 && String(e.radio || '') === radioTag(ctl));
  }
  function remember(map, rigId, ctl, now, by) {
    var out = {};
    if (map && typeof map === 'object') for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out[k] = map[k];
    if (rigId) out[rigId] = { at: Number(now) || Date.now(), by: String(by || 'desktop'), radio: radioTag(ctl) };
    return out;
  }
  function forget(map, rigId) {
    var out = {};
    if (map && typeof map === 'object') for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k) && k !== rigId) out[k] = map[k];
    return out;
  }

  /**
   * What a Tune press does on a rig with an RF-sense tuner.
   * @param {object} s
   *   canSet        canSetTxPower(...).canSet
   *   catConnected  the radio link is up (down: the tune itself says so and sends nothing)
   *   confirmed     isConfirmed(...) for this rig
   *   remote        the press came from an ECHOCAT device (phone, ECHOCAT Web, another desktop)
   *   guest         ... on a Guest Pass
   *   clientCanAsk  the device said it can show the question (ownPowerAsk: true)
   *   clientSaidTune the device answered Tune now to a question this shack sent it
   *                 for this rig, inside ASK_WINDOW_MS
   * @returns {{action: 'run'|'ask-desktop'|'ask-remote'|'refuse-remote', ownPower: boolean, remember: boolean}}
   *   ownPower: the tune sends no power command at all.
   */
  function tuneGate(s) {
    s = s || {};
    if (s.canSet) return { action: 'run', ownPower: false, remember: false };
    if (!s.catConnected || s.confirmed) return { action: 'run', ownPower: true, remember: false };
    if (s.remote) {
      if (s.guest) return { action: 'refuse-remote', ownPower: true, remember: false };
      if (s.clientSaidTune) return { action: 'run', ownPower: true, remember: true };
      if (s.clientCanAsk) return { action: 'ask-remote', ownPower: true, remember: false };
      return { action: 'refuse-remote', ownPower: true, remember: false };
    }
    return { action: 'ask-desktop', ownPower: true, remember: false };
  }

  // ---- Honest words for a tune that sends no power command ------------------

  function tuneStartLine(o) {
    return '[ExtATU] Firing ' + o.carrierMode + ' carrier for ' + o.seconds + "s at the radio's own power (mode " + o.restoreMode + ' → ' + o.carrierMode
      + "; POTACAT cannot set this radio's power, so no power command is sent)";
  }
  function tuneCompleteLine(modeText) {
    return '[ExtATU] Tune complete — ' + modeText + "; power not touched: this radio's power is set on the radio";
  }
  var MODAL_LINE = "Carrier out in AM at the radio's own power. The tuner's relays will click as it matches.";
  var FIELD_NOTE = "Set on the radio: POTACAT cannot set this radio's power.";
  var SETTINGS_HELP = "POTACAT cannot set this radio's power, so the Tune button sends the carrier in AM at the radio's own power setting. Turn RF POWER down on the radio before you tune. POTACAT asks before the first tune, and puts the mode back afterwards.";
  var CONFIRMED_NOTE = 'You answered Tune now for this radio, so POTACAT no longer asks before a tune.';

  return {
    KNOWN_RADIOS: KNOWN_RADIOS,
    transportOf: transportOf,
    canSetTxPower: canSetTxPower,
    knownByName: knownByName, knownByXcvr: knownByXcvr, knownByHamlib: knownByHamlib,
    TUNE_LABEL: TUNE_LABEL, CANCEL_LABEL: CANCEL_LABEL, CONFIRM_TITLE: CONFIRM_TITLE, CONFIRM_MESSAGE: CONFIRM_MESSAGE,
    confirmDetail: confirmDetail, confirmDialog: confirmDialog, remoteAsk: remoteAsk, answerIsTune: answerIsTune,
    REMOTE_REFUSAL: REMOTE_REFUSAL, NO_WINDOW_LINE: NO_WINDOW_LINE, CANCELLED_LINE: CANCELLED_LINE, ASK_WINDOW_MS: ASK_WINDOW_MS,
    isConfirmed: isConfirmed, remember: remember, forget: forget,
    tuneGate: tuneGate,
    tuneStartLine: tuneStartLine, tuneCompleteLine: tuneCompleteLine,
    MODAL_LINE: MODAL_LINE, FIELD_NOTE: FIELD_NOTE, SETTINGS_HELP: SETTINGS_HELP, CONFIRMED_NOTE: CONFIRMED_NOTE,
  };
});
