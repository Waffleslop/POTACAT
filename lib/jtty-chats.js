/**
 * JTTY chats — per-station conversation tabs over the JTTY message rows
 * (Casey 2026-10-18: "chat bubbles", freeform; "that's the magic of JTTY").
 *
 * SHARED with ECHOCAT (potacat-app src/utils/jttyChats.ts): the same rules
 * and the same test cases on both sides, so a line lands in the same chat on
 * the phone and on the desktop. A rule change here is a rule change there
 * (mobile handoff: docs/desktop-handoffs/jtty-chats-for-desktop.md).
 *
 * A chat is a VIEW, not a copy: its lines are picked out of the one row list
 * on every render, so closing a chat loses nothing and reopening it shows
 * the whole history again.
 *
 * Which rows belong to the chat with CALL (`chatRows`):
 *   - our rows that name CALL;
 *   - received rows SENT BY CALL: the "TO FROM" word order (senderOf), or
 *     CALL named later in the line with no readable sender ("TNX 73 DE
 *     W9XYZ"); a received row whose FIRST word is CALL with no readable
 *     sender is addressed TO them by someone unnamed ("W9XYZ PSE AGN") and
 *     is NOT theirs — the one departure from the phone's first version,
 *     where it was counted as theirs and moved the chat's frequency;
 *   - a received row with no recognisable sender on CALL's frequency
 *     (within FREQ_MATCH_HZ of the last row they sent). Freeform JTTY lines
 *     usually carry no calls at all ("FB. IC-7300 AND A VERTICAL HERE");
 *     after the follow-the-station move both ends transceive on one
 *     frequency, so frequency is what ties them.
 * A third station calling CALL is never part of our chat with them, though
 * it names them (N4FFF 2026-10-19). CALL's frequency updates only from
 * CALL's own lines, so a caller elsewhere cannot drag the chat away.
 *
 * Our chat lines go out as "THEIR MY text" (the TO FROM order, so the far
 * end credits us); the composer shows the prefix and the bubbles keep it
 * greyed, because what is shown must be what goes on air (N4FFF).
 *
 * Dual-mode: Node `require()` and the pop-out's `<script>` (window.JttyChats).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JttyChats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FREQ_MATCH_HZ = 25;
  var IDLE_MS = 10 * 60 * 1000; // a chat with nothing heard this long dims; it never closes itself

  var GRID_RE = /^[A-R]{2}\d{2}$/;
  function isCall(w) {
    return /^[A-Z0-9/]{3,11}$/.test(w) && /\d/.test(w) && /[A-Z]/.test(w) && !GRID_RE.test(w) && w !== 'RR73';
  }
  function words(text) { return String(text == null ? '' : text).toUpperCase().trim().split(/\s+/).filter(Boolean); }
  function bare(tok) { return String(tok).replace(/^</, '').replace(/>$/, ''); }
  function clean(call) { return String(call == null ? '' : call).toUpperCase().trim(); }

  /** Who SENT a line, by the TO FROM order (identical to lib/jtty-macros.js senderOf). */
  function senderOf(text) {
    var w = words(text).map(bare);
    if (!w.length) return '';
    if (w[0] === 'CQ') return w[1] && isCall(w[1]) ? w[1] : '';
    if (w.length >= 2 && isCall(w[0]) && isCall(w[1])) return w[1];
    if (w.length === 1 && isCall(w[0])) return w[0];
    return '';
  }

  /** True when `call` appears in the text as a whole word (hash brackets off). */
  function mentions(text, call) {
    var c = clean(call);
    if (!c) return false;
    return words(text).some(function (w) { return bare(w) === c; });
  }

  /** The rows that make up the chat with `call`, in list order. Rows are
   *  {key, kind:'rx'|'tx'|'marker', text, complete, freqHz, snrDb, utcMs}. */
  function chatRows(rows, call, myCall) {
    var them = clean(call);
    var me = clean(myCall);
    var out = [];
    if (!them) return out;
    var partnerHz = null;
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r || r.kind === 'marker') continue;
      if (r.kind === 'tx') {
        if (mentions(r.text, them)) out.push(r);
        continue;
      }
      var w = words(r.text);
      var named = mentions(r.text, them);
      var from = senderOf(r.text);
      var namedFirst = w.length > 0 && bare(w[0]) === them;
      // Theirs: they sent it, or they are named later in the line with no
      // readable sender. CALL as the FIRST word with no sender is a line
      // addressed to them by someone unnamed, not theirs.
      if (from === them || (named && !from && !namedFirst)) {
        out.push(r);
        if (r.freqHz != null) partnerHz = r.freqHz;
        continue;
      }
      if (named && from) continue;        // someone else calling them
      if (r.freqHz == null || partnerHz == null) continue;
      if (Math.abs(r.freqHz - partnerHz) > FREQ_MATCH_HZ) continue;
      // On their frequency: theirs unless the line names someone else, or
      // is addressed to us by someone else.
      if (from && from !== them) continue;
      if (me && mentions(r.text, me) && from !== them) continue;
      if (namedFirst) continue;           // "W9XYZ PSE AGN" on their frequency is still to them
      out.push(r);
    }
    return out;
  }

  /** The station a received line is calling us from, or '' ("K3SBP W9XYZ -09 GA" → "W9XYZ"). */
  function directedSender(text, myCall) {
    var me = clean(myCall);
    var w = words(text);
    if (!me || w.length < 2 || bare(w[0]) !== me) return '';
    var s = senderOf(text);
    return s && s !== me ? s : '';
  }

  /** The call pair put in front of a chat line ("THEIR MY"), or '' when the
   *  operator already started with their call (or a CQ). */
  function chatPrefix(text, theirCall, myCall) {
    var them = clean(theirCall);
    var me = clean(myCall);
    if (!them) return '';
    var first = bare(words(text)[0] || '');
    if (first === them || first === 'CQ') return '';
    return me ? them + ' ' + me : them;
  }

  /** What goes on air for a chat line: the prefix, then the text. */
  function chatOutgoing(text, theirCall, myCall) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return t;
    var p = chatPrefix(t, theirCall, myCall);
    return p ? p + ' ' + t : t;
  }

  /** A bubble split into the "THEIR MY" / "MY THEIR" call pair (greyed) and the rest. */
  function bubbleParts(text, theirCall, myCall) {
    var w = String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
    var them = clean(theirCall);
    var me = clean(myCall);
    if (w.length > 2 && them && me) {
      var a = bare(w[0].toUpperCase());
      var b = bare(w[1].toUpperCase());
      if ((a === them && b === me) || (a === me && b === them)) {
        return { pair: w.slice(0, 2).join(' '), body: w.slice(2).join(' ') };
      }
    }
    return { pair: '', body: w.join(' ') };
  }

  /** Received lines in the chat newer than `sinceMs`. */
  function chatUnread(rows, sinceMs) {
    var n = 0;
    for (var i = 0; i < (rows || []).length; i++) if (rows[i].kind === 'rx' && rows[i].utcMs > sinceMs) n++;
    return n;
  }

  /** When we last heard them (newest received line), or null. */
  function chatLastHeard(rows) {
    var last = null;
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (r.kind === 'rx' && (last == null || r.utcMs > last)) last = r.utcMs;
    }
    return last;
  }

  /**
   * The open chats and which is active. Pure state; the pane renders it.
   * Chats open when the operator picks a station (and switch to it), or when
   * a station calls us (without switching). A chat closed while a line was
   * still arriving stays closed for that line — otherwise one long incoming
   * line would keep reopening it.
   */
  function ChatState() {
    this.chats = [];        // [{call, openedAt, lastViewedMs, logged, closedForKey}]
    this.active = '';       // '' = All traffic
    this._closedFor = {};   // call -> row key it was closed on
  }
  ChatState.prototype.get = function (call) {
    var c = clean(call);
    for (var i = 0; i < this.chats.length; i++) if (this.chats[i].call === c) return this.chats[i];
    return null;
  };
  ChatState.prototype.open = function (call, opts) {
    var c = clean(call);
    if (!c) return null;
    var now = (opts && opts.now) || Date.now();
    var chat = this.get(c);
    if (!chat) {
      chat = { call: c, openedAt: now, lastViewedMs: 0, logged: false };
      this.chats.push(chat);
      delete this._closedFor[c];
    }
    if (opts && opts.activate) { this.active = c; chat.lastViewedMs = now; }
    return chat;
  };
  ChatState.prototype.close = function (call, rowKey) {
    var c = clean(call);
    this.chats = this.chats.filter(function (x) { return x.call !== c; });
    if (rowKey) this._closedFor[c] = rowKey;
    if (this.active === c) this.active = '';
  };
  ChatState.prototype.activate = function (call, now) {
    var c = clean(call);
    if (c && !this.get(c)) return;
    this.active = c;
    var chat = this.get(c);
    if (chat) chat.lastViewedMs = now || Date.now();
  };
  /** Leaving a chat counts as having read it. */
  ChatState.prototype.leave = function (now) {
    var chat = this.get(this.active);
    if (chat) chat.lastViewedMs = now || Date.now();
  };
  /** A received row arrived (or grew): open a chat for a station calling us,
   *  without switching to it. Returns the call opened, or ''. */
  ChatState.prototype.noteRow = function (row, myCall, now) {
    if (!row || row.kind !== 'rx') return '';
    var from = directedSender(row.text, myCall);
    if (!from) return '';
    if (this._closedFor[from] === row.key) return '';
    if (this.get(from)) return '';
    this.open(from, { now: now });
    return from;
  };
  ChatState.prototype.markLogged = function (call) {
    var chat = this.get(call);
    if (chat) chat.logged = true;
    return !!chat;
  };
  ChatState.prototype.closeLogged = function () {
    var self = this;
    var gone = this.chats.filter(function (c) { return c.logged; }).map(function (c) { return c.call; });
    gone.forEach(function (c) { self.close(c); });
    return gone;
  };

  return {
    FREQ_MATCH_HZ: FREQ_MATCH_HZ, IDLE_MS: IDLE_MS,
    senderOf: senderOf, mentions: mentions, chatRows: chatRows, directedSender: directedSender,
    chatPrefix: chatPrefix, chatOutgoing: chatOutgoing, bubbleParts: bubbleParts,
    chatUnread: chatUnread, chatLastHeard: chatLastHeard, ChatState: ChatState,
  };
});
