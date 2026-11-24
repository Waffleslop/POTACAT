// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// FT-891: which socket the radio takes its transmit audio from, per rig
// (GitHub #602; the Kenwood form is lib/tx-audio-input.js, #594/#596).
//
// The FT-891 picks the socket in its menu, per mode family, not in the CAT
// key-down (TX P1 is only off/on, CAT reference printed p. 18). An operator
// with his sound card interface on the rear jack at the desk and the hand mic
// away from it switched the menus by hand and forgot. So the rig editor has
// "Transmit audio input" for the FT-891:
//   - (blank, the default) the radio's menus are left as they are: nothing is
//     read or written, exactly today's behaviour;
//   - Rear (RTTY/DATA jack) or Front (microphone jack): while POTACAT is
//     connected over the serial CAT link, the four menus below are set to that
//     socket where they differ, the window says what changed, and the
//     operator's values are written back when POTACAT disconnects, switches
//     rig, hands the port to a CAT test or WSJT-X, or quits.
// A menu that does not answer its read is never written (no restore guess).
//
// Menus and values (Yaesu, ops manuals; nothing copied here but the numbers):
//   FT-891 CAT Operation Reference Book rev 1909-C:
//     printed p. 7 (PDF p. 8): EX P1 P1 P1 P1 P2 ; P1 = menu 0101-1803,
//       read EX P1 P1 P1 P1 ; answers EX P1 P1 P1 P1 P2 ;
//     printed p. 8 (PDF p. 9): 0605 AM MIC SELECT, 0809 DATA IN SELECT,
//       0901 FM MIC SELECT, 1105 SSB MIC SELECT; each P2 0: MIC 1: REAR, 1 digit.
//   FT-891 Operating Manual 1611A, printed p. 52-53 (PDF p. 54-55): the same
//     items as menu 06-05, 08-09, 09-01, 11-05, factory MIC, REAR, MIC, MIC.
//     Printed p. 25: the rear socket is the RTTY/DATA jack (DATA IN pin).
//
// Only the direct serial link (catTarget.type 'serial', our Kenwood-protocol
// codec): a Hamlib, flrig or other link is left alone.
//
// Dual-mode: require() in main and tests, window.Ft891TxAudioInput in the rig
// editor. Pure.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ft891TxAudioInput = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODEL = 'FT-891';
  var FRONT = 'front';
  var REAR = 'rear';

  // P2 per the CAT reference, printed p. 8: 0 MIC, 1 REAR.
  var VALUES = Object.freeze({ front: '0', rear: '1' });

  // The four items, in menu order. item = the operating manual's menu number.
  var MENUS = Object.freeze([
    Object.freeze({ menu: '0605', item: '06-05', label: 'AM MIC SELECT' }),
    Object.freeze({ menu: '0809', item: '08-09', label: 'DATA IN SELECT' }),
    Object.freeze({ menu: '0901', item: '09-01', label: 'FM MIC SELECT' }),
    Object.freeze({ menu: '1105', item: '11-05', label: 'SSB MIC SELECT' }),
  ]);

  var LABELS = Object.freeze({
    front: 'Front (microphone jack)',
    rear: 'Rear (RTTY/DATA jack)',
  });
  var BLANK_LABEL = 'As set on the radio (POTACAT changes nothing)';
  var HELP = 'The socket your sound card interface is plugged into. While POTACAT is connected it sets the radio to take transmit audio from that socket in SSB, DATA, AM and FM, and puts the radio\'s own settings back when it disconnects or closes. With Rear, the hand mic is silent while POTACAT is connected. Serial CAT link only.';
  var WHERE = Object.freeze({ front: 'front microphone jack', rear: 'rear RTTY/DATA jack' });

  function hasChoice(modelName) { return String(modelName || '') === MODEL; }

  /** Does the guard run on this CAT link? Only POTACAT's own serial codec. */
  function appliesToLink(catType) { return catType === 'serial'; }

  /** 'front' | 'rear' | null (leave the radio alone) for this rig. */
  function choiceFor(rig) {
    if (!rig || !hasChoice(rig.model)) return null;
    var v = rig.txAudioInput;
    return v === FRONT || v === REAR ? v : null;
  }

  function menuEntry(menu) {
    for (var i = 0; i < MENUS.length; i++) if (MENUS[i].menu === menu) return MENUS[i];
    return null;
  }

  function readCommand(menu) {
    if (!menuEntry(menu)) throw new Error('not an FT-891 transmit audio menu: ' + menu);
    return 'EX' + menu + ';';
  }

  function writeCommand(menu, value) {
    if (!menuEntry(menu)) throw new Error('not an FT-891 transmit audio menu: ' + menu);
    var v = String(value);
    if (v !== '0' && v !== '1') throw new Error('FT-891 ' + menu + ' takes 0 MIC or 1 REAR, not ' + v);
    return 'EX' + menu + v + ';';
  }

  /** '0' | '1' from the radio's answer to EXmmmm;, or null (no answer, ?;, another menu). */
  function parseReply(menu, reply) {
    var m = /^EX(\d{4})([01]);?$/.exec(String(reply == null ? '' : reply).trim());
    return m && m[1] === menu ? m[2] : null;
  }

  function valueName(v) { return v === '1' ? 'REAR' : v === '0' ? 'MIC' : '?'; }

  /**
   * The guard main keeps for one FT-891 serial connection.
   * deps:
   *   choice() -> 'front' | 'rear' | null   the active rig's saved choice
   *   query(cmd) -> Promise<string|null>    send a read, resolve with the reply
   *   send(cmd)                             write a command
   *   log(line), notice(sentence)
   */
  function createGuard(deps) {
    var d = deps || {};
    var log = typeof d.log === 'function' ? d.log : function () {};
    var notice = typeof d.notice === 'function' ? d.notice : function () {};
    var held = {};          // menu -> the operator's value, for every menu POTACAT changed
    var stopped = false;    // restore() ran: this connection is ending, nothing more is set
    var chain = Promise.resolve();
    function queue(fn) { chain = chain.then(fn, fn); return chain; }

    async function applyNow() {
      if (stopped) return { action: 'stopped' };
      var choice = typeof d.choice === 'function' ? d.choice() : null;
      if (choice !== FRONT && choice !== REAR) return { action: 'none' };
      var want = VALUES[choice];
      var changed = [];
      var unread = 0;
      for (var i = 0; i < MENUS.length; i++) {
        var m = MENUS[i];
        if (Object.prototype.hasOwnProperty.call(held, m.menu)) continue;
        var reply = null;
        try { reply = await d.query(readCommand(m.menu)); } catch (e) { reply = null; }
        if (stopped) return { action: 'stopped' };
        var v = parseReply(m.menu, reply);
        if (v == null) {
          unread++;
          log(m.item + ' ' + m.label + ' could not be read, so it is left as it is (no restore guess)');
          continue;
        }
        if (v === want) continue;
        d.send(writeCommand(m.menu, want));
        held[m.menu] = v;
        changed.push(m);
        log(m.item + ' ' + m.label + ' was ' + valueName(v) + '; set to ' + valueName(want) + ' (' + LABELS[choice] + ', this rig\'s Transmit audio input). It goes back when POTACAT disconnects.');
      }
      if (!changed.length) return { action: unread ? 'unread' : 'already' };
      var names = changed.map(function (m) { return m.label + ' (' + m.item + ')'; }).join(', ');
      notice('POTACAT set the FT-891 to take transmit audio from the ' + WHERE[choice] + ': ' + names
        + '. They go back to the radio\'s own settings when POTACAT disconnects or closes. Change it in Settings > Radio, Edit the rig, Transmit audio input.');
      return { action: 'set', menus: changed.map(function (m) { return m.menu; }) };
    }

    function restoreNow(why) {
      var menus = Object.keys(held);
      if (!menus.length) return { action: 'none' };
      var sent = [];
      for (var i = 0; i < MENUS.length; i++) {
        var m = MENUS[i];
        if (!Object.prototype.hasOwnProperty.call(held, m.menu)) continue;
        var prev = held[m.menu];
        delete held[m.menu];
        try { d.send(writeCommand(m.menu, prev)); sent.push(m.menu); } catch (e) { log(m.item + ' ' + m.label + ' could not be put back: ' + e.message); continue; }
        log(m.item + ' ' + m.label + ' put back to ' + valueName(prev) + ' (' + (why || 'disconnect') + ')');
      }
      return { action: sent.length ? 'restored' : 'failed', menus: sent };
    }

    return {
      get held() { return Object.assign({}, held); },
      /** The link is up (and again after a reconnect of the same link). */
      apply: function () { return queue(applyNow); },
      /**
       * Disconnect, quit, rig change: put the operator's values back NOW, before
       * the link closes (the caller disconnects right after), and set nothing more.
       */
      restore: function (why) { stopped = true; return restoreNow(why); },
    };
  }

  return {
    MODEL: MODEL,
    FRONT: FRONT,
    REAR: REAR,
    VALUES: VALUES,
    MENUS: MENUS,
    LABELS: LABELS,
    BLANK_LABEL: BLANK_LABEL,
    HELP: HELP,
    hasChoice: hasChoice,
    appliesToLink: appliesToLink,
    choiceFor: choiceFor,
    readCommand: readCommand,
    writeCommand: writeCommand,
    parseReply: parseReply,
    createGuard: createGuard,
  };
});
