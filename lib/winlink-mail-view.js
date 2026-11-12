// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// What ECHOCAT Web's Mail tab shows, decided in one place (#425, web items
// W1, W2 and W4). The page (renderer/remote.js) only draws what these
// functions return; every sentence about how a session ended is still the
// shack's (session.outcome, lib/winlink-outcome.js) and is passed through
// untouched.
//
//   endCard()        the card a finished session leaves: "Mail exchanged with
//                    KY4RY", or the not-finished card with Try again and OK
//   restoreOnLeave() whether leaving the Mail tab sends winlink-qsy-restore
//   modeOptionText() / modeReasons()   a greyed "Send via" mode says why
//   gatewayNote() / gatewaysFailed() / predictText()   the lines under the list
//   accountCheckFailed()   the account card when Winlink could not be reached
//   OFF_TEXT         what the tab says when Winlink is off on the shack
//   bandsFor() / qualityTag() / shortTime() / lastCard() / folderLabel()
//                    the W0 layout's band chips, quality tags, row times,
//                    last-session card and folder counts
//
// Pure: no DOM, no clock. Dual-mode: require() in tests, window.WinlinkMailView
// in the ECHOCAT Web page (inlined by lib/remote-server.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinlinkMailView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ACTIVE = ['starting', 'connecting', 'connected', 'disconnecting'];
  var MODE_WORDS = { telnet: 'Internet', ardop: 'ARDOP', packet: 'Packet', vara: 'VARA HF', varafm: 'VARA FM', mercury: 'Mercury' };

  var OFF_TEXT = 'Turn Winlink on at the shack: Settings > Station > Winlink';
  var TRY_AGAIN = 'Try again';
  var OK = 'OK';
  var CHECKING_ACCOUNT = 'Checking whether your callsign has an account…';
  var LEFT_OUT_WHY = 'this radio cannot call (outside the amateur bands, or bands not set up in Settings > My Rigs > Bands)';

  function str(v) { return v == null ? '' : String(v); }
  function sentence(s) {
    var t = str(s).trim();
    if (!t) return '';
    return /[.!?…]$/.test(t) ? t : t + '.';
  }

  /** A session is running (or stopping): the radio is the session's. */
  function sessionActive(ss) {
    return !!ss && ACTIVE.indexOf(ss.state) >= 0;
  }

  /**
   * The card a finished session leaves in the Mail tab, or null.
   *
   *   done, a radio session (session.result): "Mail exchanged with <call>" and
   *     one line of what moved. An internet check keeps its one-line sentence
   *     in the status line (the half-hourly automatic check must not stack
   *     cards), so it gets no card.
   *   error: the shack's label (outcome.word), its first sentence
   *     (outcome.title), then outcome.detail and outcome.next. Try again is
   *     offered exactly when the shack says a retry is sensible
   *     (outcome.retry), for a radio session with a gateway.
   *
   * Only the fields named here are read. Anything else on session.outcome
   * (the automatic retry's fields, when the shack sends them) is ignored.
   *
   * @param {object} ss        winlink-session.session
   * @param {object} [o]
   * @param {(khz:number)=>string} [o.fmtDial]  the page's frequency formatter
   * @returns {null | {key:string, kind:'done'|'ended', label:string, title:string,
   *   lines:string[], retry:null|{mode:string,gateway:string,dialKhz:number,url:string}, ok:string}}
   */
  function endCard(ss, o) {
    if (!ss || typeof ss !== 'object') return null;
    var fmtDial = (o && o.fmtDial) || function (k) { return str(k) + ' kHz'; };
    var started = str(ss.startedAt);
    var out = ss.outcome && typeof ss.outcome === 'object' ? ss.outcome : {};
    if (ss.state === 'done') {
      var r = ss.result;
      if (!r || !r.call) return null;
      var parts = [];
      if (r.band) parts.push(str(r.band));
      if (r.dialKhz) parts.push(fmtDial(Number(r.dialKhz)));
      parts.push(MODE_WORDS[r.mode] || str(r.mode));
      parts.push((Number(r.sent) || 0) + ' sent');
      parts.push((Number(r.received) || 0) + ' received');
      return {
        key: 'done|' + r.call + '|' + str(r.dialKhz) + '|' + started,
        kind: 'done',
        label: str(out.word) || 'Finished',
        title: 'Mail exchanged with ' + r.call,
        lines: [parts.filter(Boolean).join(' · ')],
        retry: null,
        ok: OK,
      };
    }
    if (ss.state !== 'error') return null;
    var title = str(out.title) || str(ss.error) || 'The session did not finish.';
    var lines = [str(out.detail), str(out.next)].filter(Boolean);
    var radio = !!ss.mode && ss.mode !== 'telnet';
    var canRetry = out.retry === true && radio && !!ss.gateway;
    var label = [str(out.word) || 'Not finished'];
    if (radio && ss.gateway) label.push(str(ss.gateway).toUpperCase());
    if (radio) label.push(MODE_WORDS[ss.mode] || str(ss.mode));
    return {
      key: 'ended|' + started,
      kind: 'ended',
      label: label.join(' · '),
      title: title,
      lines: lines,
      retry: canRetry ? { mode: str(ss.mode), gateway: str(ss.gateway), dialKhz: Number(ss.dialKhz) || undefined, url: str(ss.url) } : null,
      ok: OK,
    };
  }

  /** The winlink-connect a card's Try again sends: the session's own gateway, dial, mode and url. */
  function retryMessage(card) {
    if (!card || !card.retry) return null;
    var m = { type: 'winlink-connect', mode: card.retry.mode, gateway: card.retry.gateway, url: card.retry.url || '' };
    if (card.retry.dialKhz) m.dialKhz = card.retry.dialKhz;
    return m;
  }

  /**
   * The operator is leaving the gateway picker (another tab, the page closing,
   * or back to the internet) without connecting.
   *   'send'  this page moved the radio to a gateway: ask the shack to put it back
   *   'drop'  a session is running: the radio is the session's, and the shack
   *           puts it back when the session ends; forget the pick
   *   'none'  this page never moved the radio
   * The desktop Mail window follows the same rule when it closes
   * (lib/winlink-return.js atClose).
   */
  function restoreOnLeave(o) {
    if (!o || !o.moved) return 'none';
    return sessionActive(o.session) ? 'drop' : 'send';
  }

  /** The text of one "Send via" option. */
  function modeOptionText(m) {
    return str(m && m.label) + (m && m.available ? '' : ' (unavailable)');
  }

  /**
   * Why each greyed mode is greyed, one line per distinct reason:
   * "ARDOP (radio) and Packet (VHF/UHF radio) are not available: Set up a radio first (Settings > My Rigs)."
   */
  function modeReasons(modes) {
    var order = [], by = {};
    (modes || []).forEach(function (m) {
      if (!m || m.available || !m.reason) return;
      var why = str(m.reason);
      if (!by[why]) { by[why] = []; order.push(why); }
      by[why].push(str(m.label));
    });
    return order.map(function (why) {
      var names = by[why];
      var who = names.length === 1 ? names[0] + ' is' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' are';
      return who + ' not available: ' + sentence(why);
    });
  }

  /** The select's one option while the list loads. */
  function loadingText(mode, predictionOn) {
    var fm = mode === 'packet' || mode === 'varafm';
    return fm || predictionOn === false ? 'Loading gateways…' : 'Loading, predicting propagation…';
  }

  /**
   * The line under the list while the shack ranks every gateway by propagation.
   * '' when this list is not being ranked (FM modes, ranking off).
   * @param {{mode:string, predictionOn?:boolean, predictMs?:object, elapsedMs:number}} o
   */
  function predictText(o) {
    o = o || {};
    if (o.mode === 'telnet' || o.mode === 'packet' || o.mode === 'varafm' || o.predictionOn === false) return '';
    var s = Math.max(0, Math.round((Number(o.elapsedMs) || 0) / 1000));
    var expect = Number((o.predictMs || {})[o.mode]) || 0;
    return 'Predicting propagation for every gateway: ' + s + ' s so far'
      + (expect ? ', about ' + Math.round(expect / 1000) + ' s last time.' : '. The first ranking can take a minute or two.');
  }

  /**
   * The line under a list that arrived: the order it is in, as the shack says
   * it (note), and how many gateways were left out.
   * @param {{note?:string, predicted?:boolean, leftOut?:number, list?:Array}} msg  S2C winlink-gateways
   */
  function gatewayNote(msg) {
    msg = msg || {};
    var n = Array.isArray(msg.list) ? msg.list.length : 0;
    var parts = [];
    var order = str(msg.note) || (n ? (msg.predicted ? 'Best predicted path first, for right now' : 'Nearest first') : '');
    if (order) parts.push(sentence(order));
    var left = Math.round(Number(msg.leftOut) || 0);
    if (left > 0) parts.push(left + ' more ' + LEFT_OUT_WHY + '.');
    return parts.join(' ');
  }

  /** A gateway list that did not load (S2C winlink-result {op:'gateways', ok:false}). */
  function gatewaysFailed(error) {
    var why = sentence(error);
    return { option: 'The list did not load', text: 'The gateway list did not load' + (why ? ': ' + why : '.'), button: TRY_AGAIN };
  }

  /** The account card when Winlink could not be reached to check the callsign. */
  function accountCheckFailed(error) {
    return { text: 'Could not reach Winlink to check: ' + sentence(str(error) || 'no answer'), button: TRY_AGAIN };
  }

  // ── the W0 layout's small words ──────────────────────────────────────────

  var HF_BANDS = ['80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
  var FM_BANDS = ['2m', '1.25m', '70cm'];
  /** The band chips a mode offers: VHF/UHF for packet and VARA FM, HF for the rest. */
  function bandsFor(mode) {
    if (mode === 'telnet') return [];
    return (mode === 'packet' || mode === 'varafm' ? FM_BANDS : HF_BANDS).slice();
  }

  /** A gateway's quality word as a small tag: { text, tone } (tone ok | warn | none), or null. */
  function qualityTag(g) {
    var w = str(g && g.qualityWord);
    if (!w) return null;
    return { text: w.toUpperCase(), tone: w === 'Good' ? 'ok' : w === 'Fair' ? 'warn' : 'none' };
  }

  /** "1431z" for a time today (UTC), else "Nov 10". '' when the date does not parse. */
  function shortTime(date, nowMs) {
    var d = new Date(date);
    if (isNaN(d.getTime())) return '';
    var n = new Date(nowMs == null ? Date.now() : nowMs);
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    if (d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate()) {
      return pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + 'z';
    }
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + (d.getUTCFullYear() !== n.getUTCFullYear() ? ' ' + d.getUTCFullYear() : '');
  }

  /**
   * The card at the top of the inbox: the session running now, else the last
   * one (winlink-state.lastSession {at, ok, text}). null when there is neither.
   * @returns {null | {label:string, text:string, tone:'ok'|'warn'|'run'}}
   */
  function lastCard(s, nowMs) {
    s = s || {};
    var ss = s.session || {};
    if (sessionActive(ss)) {
      var who = ss.mode && ss.mode !== 'telnet' && ss.gateway ? str(ss.gateway).toUpperCase() : (MODE_WORDS[ss.mode] || '');
      return { label: ['Session running', who].filter(Boolean).join(' · '), text: str(ss.text) || 'Open Send / Receive to follow it.', tone: 'run' };
    }
    var l = s.lastSession;
    if (!l || !l.text) return null;
    var t = l.at ? shortTime(l.at, nowMs) : '';
    return { label: 'Last session' + (t ? ' · ' + t : ''), text: str(l.text), tone: l.ok ? 'ok' : 'warn' };
  }

  /** Folder button words: Inbox with its unread count, Outbox with what waits to go. */
  function folderLabel(box, s) {
    s = s || {};
    var names = { in: 'Inbox', out: 'Outbox', sent: 'Sent', archive: 'Archive' };
    var n = box === 'in' ? Number(s.unread) || 0 : box === 'out' ? Number(s.counts && s.counts.out) || 0 : 0;
    return (names[box] || box) + (n > 0 ? ' ' + n : '');
  }

  return {
    ACTIVE: ACTIVE, MODE_WORDS: MODE_WORDS, OFF_TEXT: OFF_TEXT, TRY_AGAIN: TRY_AGAIN, OK: OK, CHECKING_ACCOUNT: CHECKING_ACCOUNT,
    sessionActive: sessionActive, endCard: endCard, retryMessage: retryMessage, restoreOnLeave: restoreOnLeave,
    modeOptionText: modeOptionText, modeReasons: modeReasons, loadingText: loadingText, predictText: predictText,
    gatewayNote: gatewayNote, gatewaysFailed: gatewaysFailed, accountCheckFailed: accountCheckFailed,
    HF_BANDS: HF_BANDS, FM_BANDS: FM_BANDS, bandsFor: bandsFor, qualityTag: qualityTag, shortTime: shortTime,
    lastCard: lastCard, folderLabel: folderLabel,
  };
});
