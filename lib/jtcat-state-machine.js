'use strict';
/**
 * JTCAT QSO state machine — extracted from main.js so it can be unit-tested
 * without spinning the full Electron app. Behavior is intentionally
 * matched to WSJT-X v2.6+ QSO sequencing; any deliberate departures are
 * called out inline.
 *
 * Phases for `reply` mode (we are answering THEIR CQ):
 *   reply       → we transmit "THEIRCALL MYCALL MYGRID"
 *   r+report    → we received their signal report; transmit "THEIRCALL MYCALL R+rpt"
 *   73          → exchange complete; courtesy 73 cycle, then done
 *   done        → terminal
 *
 * Phases for `cq` mode (we called CQ):
 *   cq          → calling CQ, watching for replies
 *   cq-report   → we got "MYCALL THEIRCALL GRID"; transmit "THEIRCALL MYCALL rpt"
 *   cq-rr73     → we got "MYCALL THEIRCALL R+rpt"; transmit "THEIRCALL MYCALL RR73"
 *   done        → terminal
 *
 * Busy station (they answered someone else): WSJT-X parity. When the
 * station you are calling replies to another operator, WSJT-X just KEEPS
 * CALLING — it does NOT auto-halt — bounded only by its Tx watchdog and
 * the operator's judgement. We mirror the keep-calling, bounded by the
 * per-phase TX cap below. The previous 'waiting' hold phase (v1.5.22) is
 * gone — Casey found the pause annoying and wanted WSJT-X behavior
 * (2026-06-12). A later 50 Hz "QRM guard" auto-halt (e4259ce) was a
 * POTACAT invention mis-attributed to WSJT-X and has been removed
 * (2026-06-29).
 *
 * Departures from WSJT-X:
 *   - Logs at "reports exchanged" rather than "RR73 sent" so a missed
 *     courtesy doesn't lose the QSO. WSJT-X logs after RR73; we log
 *     at advance-to-73 and send the courtesy TX afterward.
 *   - Hard per-phase TX cap: every decode cycle that does not advance the
 *     phase counts toward jtcatMaxQsoAttempts ("max transmissions of the
 *     same message"), whether the partner was heard or not. WSJT-X has no
 *     such cap — only its wall-clock Tx watchdog. Before 2026-07 the
 *     counter reset whenever the partner was heard, so a station that kept
 *     re-sending a non-advancing message (their grid, their report) hung
 *     the QSO forever (Chuck KQ4MHD's report). q._heardThisCycle survives
 *     purely to flavor the give-up message. When the cap trips with
 *     reports exchanged both ways, the QSO closes out gracefully: log +
 *     one final courtesy 73 (see canCloseoutQso/closeoutStalledQso).
 */

// Shared classifier/formatter (pure JS, dual-mode) — used for nonstandard-call
// bracket rules and callsign-shape checks. Safe here: no DOM/Electron deps.
const JtcatParser = require('../renderer/jtcat-parser');

// ARRL Field Day exchange token: <transmitters><class>, 1–32 then A–F (e.g. 6A, 16C, 32F)
const FD_NTX_CLASS = '\\d{1,2}[A-F]';
const FD_SECTION = '[A-Z]{2,3}'; // ARRL/RAC section abbreviation (validated on the wire by the codec)

// Decodes render a hashed call in <brackets> ("<GB13COL>" — or "<...>" when
// unresolved). Strip the brackets before matching so a nonstandard partner
// still advances the QSO; "<...>" degrades to "..." which matches nothing.
function _normText(t) {
  return String(t || '').toUpperCase().replace(/[<>]/g, '');
}

// Directed message with WSJT-X bracket rules for nonstandard calls; falls back
// to the plain legacy form if the formatter refuses (e.g. both calls
// nonstandard — the codec would reject that TX anyway).
function _directedMsg(theirCall, myCall, payload) {
  return JtcatParser.formatDirectedMsg(theirCall, myCall, payload)
    || (theirCall + ' ' + myCall + ' ' + payload);
}

function formatReport(db) {
  const v = Math.round(db || 0);
  return v >= 0
    ? '+' + String(v).padStart(2, '0')
    : '-' + String(Math.abs(v)).padStart(2, '0');
}

function _reEsc(call) {
  return String(call || '').replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function advanceJtcatQso(q, results, setTxMsg, onDone, deps) {
  if (!q || q.phase === 'done' || q.phase === 'idle') return;
  deps = deps || {};
  const engine = deps.engine || {};
  const log = deps.log || (() => {});
  const myCall = q.myCall;
  const _phaseBefore = q.phase;
  function _qsoLog(action, extra) {
    try {
      const head = `[JTCAT QSO] phase=${_phaseBefore}${q.phase !== _phaseBefore ? '->' + q.phase : ''} call=${q.call || '-'} mode=${q.mode} results=${results.length}`;
      log(extra ? `${head} ${action} ${extra}` : `${head} ${action}`);
    } catch { /* ignore log errors */ }
  }

  // ARRL Field Day uses a class+section exchange in place of grid/report and
  // exchanges no dB signal report, so the QSO is one message shorter in each
  // direction. Handled in dedicated functions to keep the (hardware-validated)
  // standard flow untouched. q.fd is set by the caller when FD mode is active;
  // q.myExch holds our own exchange, e.g. "2A EMA".
  if (q.fd) {
    if (q.mode === 'cq') return advanceFdCqQso(q, results, setTxMsg, onDone, engine, _qsoLog);
    return advanceFdReplyQso(q, results, setTxMsg, onDone, engine, _qsoLog);
  }

  if (q.mode === 'cq') {
    // Courtesy RR73 cycle — wait one decode cycle so the RR73 has a chance to TX
    if (q.phase === 'cq-rr73') {
      if (!q._courtesySent) {
        q._courtesySent = true;
        _qsoLog('courtesy-RR73 wait (first cycle in cq-rr73)');
        return;
      }
      q.phase = 'done';
      if (engine) {
        engine._txEnabled = false;
        if (typeof engine.setTxMessage === 'function') engine.setTxMessage('');
        if (typeof engine.setTxSlot === 'function') engine.setTxSlot('auto');
      }
      _qsoLog('QSO done (courtesy RR73 sent)');
      return;
    }

    if (q.phase === 'cq') {
      const reply = results.find((d) => {
        const t = _normText(d.text);
        return t.indexOf(myCall) >= 0 && !t.startsWith('CQ ');
      });
      if (!reply) {
        _qsoLog('no advance', `(no decode containing ${myCall} that isn't a CQ)`);
        return;
      }
      const replyNorm = _normText(reply.text);
      const m = replyNorm.match(
        new RegExp(myCall.replace(/[/]/g, '\\/') + '\\s+([A-Z0-9/]+)\\s+([A-R]{2}\\d{2})', 'i'),
      );
      if (m) {
        q.call = m[1];
        q.grid = m[2];
        const rpt = formatReport(reply.db);
        q.sentReport = rpt;
        q.txMsg = _directedMsg(q.call, myCall, rpt);
        q.phase = 'cq-report';
        if (engine && typeof engine.setRxFreq === 'function') engine.setRxFreq(reply.df);
        setTxMsg(q.txMsg);
        _qsoLog('advance to cq-report', `("${reply.text}" -> tx "${q.txMsg}")`);
        return;
      }
      // Compressed-reply variant (no Step-2 grid): some ops auto-sequence
      // straight to a signal report — "<MyCall> <TheirCall> <±NN>". We
      // ack with R+report (combines acknowledging their report with
      // sending our report of them) and jump straight to the courtesy
      // cycle. WSJT-X auto-sequencer does the same when its operator
      // disables Tx1. K3SBP report 2026-06-01 — KB2ELA sat there
      // sending -12 for a minute while we kept CQing because the
      // grid-only matcher above silently dropped them. The negative
      // lookbehind on `(?<!R)` keeps R+report decodes (Step 3 of the
      // standard flow) from being mis-classified as compressed Step 2.
      const text = replyNorm.trim();
      const parts = text.split(/\s+/);
      const isReport = parts.length >= 3
        && parts[0] === myCall.toUpperCase()
        && /^[+-]\d{2}$/.test(parts[2])
        && !/^R[+-]\d{2}$/.test(parts[2]);
      if (isReport) {
        q.call = parts[1];
        q.grid = '';
        q.report = parts[2];
        const ourRpt = formatReport(reply.db);
        q.sentReport = ourRpt;
        q.txMsg = _directedMsg(q.call, myCall, 'R' + ourRpt);
        q.phase = 'cq-rr73';
        if (engine && typeof engine.setRxFreq === 'function') engine.setRxFreq(reply.df);
        setTxMsg(q.txMsg);
        onDone();
        _qsoLog('advance to cq-rr73 + log (compressed reply)', `("${reply.text}" -> tx "${q.txMsg}")`);
        return;
      }
      // Bare two-call reply — "<MyCall> <TheirCall>" with no grid and no
      // report. This is a NONSTANDARD-call station answering our CQ: type-4
      // and hash-first type-1 messages have no room for a locator, so their
      // Tx1 is just the two calls (WSJT-X model QSO: "<PJ4/K1ABC> W9XYZ").
      // Standard stations always send a grid or report, so this branch only
      // fires for them. Advance exactly like a grid reply, with grid unknown.
      const isBare = parts.length === 2
        && parts[0] === myCall.toUpperCase()
        && JtcatParser.looksLikeCallsign(parts[1]);
      if (isBare) {
        q.call = parts[1];
        q.grid = '';
        const rpt = formatReport(reply.db);
        q.sentReport = rpt;
        q.txMsg = _directedMsg(q.call, myCall, rpt);
        q.phase = 'cq-report';
        if (engine && typeof engine.setRxFreq === 'function') engine.setRxFreq(reply.df);
        setTxMsg(q.txMsg);
        _qsoLog('advance to cq-report (bare nonstandard reply)', `("${reply.text}" -> tx "${q.txMsg}")`);
        return;
      }
      _qsoLog('no advance', `(decode "${reply.text}" matched ${myCall} but didn't parse <call> <grid>, <call> <±NN>, or bare <call>)`);
      return;
    }

    if (q.phase === 'cq-report') {
      const resp = results.find((d) => {
        const t = _normText(d.text);
        return t.indexOf(myCall) >= 0 && t.indexOf(q.call) >= 0;
      });
      if (!resp) {
        _qsoLog('no advance', `(no decode containing ${myCall}+${q.call})`);
        return;
      }
      const rptM = _normText(resp.text).match(/R?([+-]\d{2})/);
      if (!rptM) {
        q._heardThisCycle = true;
        _qsoLog('heard but no advance', `(decode "${resp.text}" had no R-report yet)`);
        return;
      }
      q.report = rptM[1];
      q.txMsg = _directedMsg(q.call, myCall, 'RR73');
      q.phase = 'cq-rr73';
      setTxMsg(q.txMsg);
      onDone();
      _qsoLog('advance to cq-rr73 + log', `("${resp.text}" -> tx "${q.txMsg}")`);
      return;
    }
    return;
  }

  // --- Reply mode ---
  const theirCall = q.call;

  if (q.phase === '73') {
    if (!q._courtesySent) {
      q._courtesySent = true;
      _qsoLog('courtesy-73 wait (first cycle in 73)');
      return;
    }
    q.phase = 'done';
    if (engine) {
      engine._txEnabled = false;
      if (typeof engine.setTxMessage === 'function') engine.setTxMessage('');
      if (typeof engine.setTxSlot === 'function') engine.setTxSlot('auto');
    }
    _qsoLog('QSO done (courtesy 73 sent)');
    return;
  }

  const resp = results.find((d) => {
    const t = _normText(d.text);
    return t.indexOf(myCall) >= 0 && t.indexOf(theirCall) >= 0;
  });
  if (!resp) {
    // No decode for us. Are they working someone else? WSJT-X parity:
    // keep calling them anyway (tail-end) — WSJT-X does NOT auto-halt when
    // the DX answers another op; it keeps transmitting until the operator
    // stops or its Tx watchdog fires. We bound it with the per-phase TX cap
    // (jtcatMaxQsoAttempts) instead — every non-advancing cycle counts,
    // busy or silent. (The old 50 Hz "QRM guard" abort was a POTACAT
    // invention, not real WSJT-X behavior — removed 2026-06-29.)
    const busy = results.find((d) => {
      const t = _normText(d.text);
      if (t.startsWith('CQ ')) return false;
      if (t.indexOf(myCall) >= 0) return false;
      const parts = t.split(/\s+/);
      return parts.length >= 2 && parts[1] === theirCall;
    });
    if (busy) {
      const otherStation = _normText(busy.text).split(/\s+/)[0] || '';
      _qsoLog('no advance', `(${theirCall} is working ${otherStation || 'another station'} — still calling)`);
      return;
    }
    _qsoLog('no advance', `(no decode containing ${myCall}+${theirCall} -- decoder probably missed their reply this cycle)`);
    return;
  }
  let text = _normText(resp.text);

  // Hound mode: a Fox dual message packs two QSOs into one transmission —
  // "K1ABC RR73; W9XYZ <KH1/KH7Z> -08". Parse only OUR segment so the other
  // hound's report/RR73 can't advance our QSO.
  if (q.hound && text.indexOf(';') >= 0) {
    const seg = text.split(';').map((s) => s.trim()).find((s) => s.indexOf(myCall) >= 0) || '';
    if (!seg) {
      _qsoLog('no advance', '(fox dual message not addressed to us)');
      return;
    }
    text = seg;
  }

  if (q.phase === 'reply') {
    // Hound: fox can jump straight to RR73 (we missed the report cycle, or a
    // dual-message pairing). Log and stop TX — hounds send NO 73 courtesy;
    // the fox has already moved on to the next caller.
    if (q.hound && /\bRR73\b/.test(text)) {
      onDone();
      _fdTeardown(q, engine);
      _qsoLog('hound QSO done (RR73 direct)', `("${resp.text}")`);
      return;
    }
    const rptM = text.match(/[R]?([+-]\d{2})/);
    if (!rptM) {
      _qsoLog('no advance', `(decode "${resp.text}" had no signal report yet)`);
      return;
    }
    q.report = rptM[1];
    const ourRpt = formatReport(resp.db);
    if (text.indexOf('R' + rptM[1]) >= 0 || text.indexOf('R+') >= 0 || text.indexOf('R-') >= 0) {
      // Their R+report acks a report we already sent (Skip Grid opener, or a
      // shortened flow) — preserve what we actually transmitted; only fall
      // back to a fresh estimate if we somehow never sent one.
      q.sentReport = q.sentReport || ourRpt;
      q.txMsg = _directedMsg(theirCall, myCall, 'RR73');
      q.phase = '73';
      setTxMsg(q.txMsg);
      onDone();
      _qsoLog('advance to 73 + log', `("${resp.text}" had R-report -> tx "${q.txMsg}")`);
    } else {
      // We're about to transmit R+ourRpt — that IS our sent report.
      q.sentReport = ourRpt;
      q.txMsg = _directedMsg(theirCall, myCall, 'R' + ourRpt);
      q.phase = 'r+report';
      // Hound rule: when the Fox answers, the hound's TX moves to the
      // frequency the Fox called on (nominally 300–540 Hz) for the R+rpt leg.
      if (q.hound && engine && typeof engine.setTxFreq === 'function' && resp.df) {
        engine.setTxFreq(resp.df);
      }
      setTxMsg(q.txMsg);
      _qsoLog('advance to r+report', `("${resp.text}" -> tx "${q.txMsg}")`);
    }
    return;
  }

  if (q.phase === 'r+report') {
    if (/\bRR73\b/.test(text) || /\bRRR\b/.test(text) || /\s73$/.test(text)) {
      if (q.hound) {
        // Hound: log and stop — no 73 courtesy; the fox is already working
        // the next caller and a 73 would just waste a slot in the pileup.
        onDone();
        _fdTeardown(q, engine);
        _qsoLog('hound QSO done (RR73)', `("${resp.text}")`);
        return;
      }
      q.txMsg = _directedMsg(theirCall, myCall, '73');
      q.phase = '73';
      setTxMsg(q.txMsg);
      onDone();
      _qsoLog('advance to 73 + log', `("${resp.text}" had RR73 -> tx "${q.txMsg}")`);
    } else {
      q._heardThisCycle = true;
      _qsoLog('heard but no advance', `(decode "${resp.text}" — still waiting for RR73)`);
    }
  }
}

function _fdTeardown(q, engine) {
  q.phase = 'done';
  if (engine) {
    engine._txEnabled = false;
    if (typeof engine.setTxMessage === 'function') engine.setTxMessage('');
    if (typeof engine.setTxSlot === 'function') engine.setTxSlot('auto');
  }
}

/**
 * Field Day, CQ side (we called "CQ FD MYCALL GRID"). Sequence:
 *   Tx1 CQ FD K1ABC FN42         (our opening CQ, built by caller)
 *   Tx2 K1ABC W9XYZ 6A WI        (answerer's exchange — we receive this)
 *   Tx3 W9XYZ K1ABC R 2B EMA     (our R + exchange — we send this; log here)
 *   Tx4 K1ABC W9XYZ RR73         (answerer confirms — we receive this)
 * No dB report is exchanged. Phases: cq → cq-rr73 → done.
 */
function advanceFdCqQso(q, results, setTxMsg, onDone, engine, _qsoLog) {
  const myCall = q.myCall;

  if (q.phase === 'cq-rr73') {
    // We've sent our R+exchange and logged. Wait one cycle for it to TX, then
    // close out (their RR73 in Tx4 needs no further transmission from us).
    if (!q._courtesySent) {
      q._courtesySent = true;
      _qsoLog('FD cq-rr73 wait (R+exchange sent)');
      return;
    }
    _fdTeardown(q, engine);
    _qsoLog('FD QSO done (CQ side)');
    return;
  }

  if (q.phase === 'cq') {
    const reply = results.find((d) => {
      const t = (d.text || '').toUpperCase();
      return t.indexOf(myCall) >= 0 && !t.startsWith('CQ ');
    });
    if (!reply) {
      _qsoLog('no advance', `(no FD reply containing ${myCall})`);
      return;
    }
    // Answerer's exchange: "MYCALL THEIRCALL <ntx><class> <section>" (no R)
    const re = new RegExp('^' + _reEsc(myCall) + '\\s+([A-Z0-9/]+)\\s+(' + FD_NTX_CLASS + ')\\s+(' + FD_SECTION + ')$', 'i');
    const m = (reply.text || '').toUpperCase().trim().match(re);
    if (!m) {
      _qsoLog('no advance', `(FD decode "${reply.text}" matched ${myCall} but not <call> <class> <section>)`);
      return;
    }
    q.call = m[1];
    q.theirClass = m[2];
    q.theirSection = m[3];
    q.theirExch = m[2] + ' ' + m[3];
    q.txMsg = q.call + ' ' + myCall + ' R ' + q.myExch;
    q.phase = 'cq-rr73';
    if (engine && typeof engine.setRxFreq === 'function') engine.setRxFreq(reply.df);
    setTxMsg(q.txMsg);
    onDone(); // both exchanges in hand — log now
    _qsoLog('advance to cq-rr73 + log (FD)', `("${reply.text}" -> tx "${q.txMsg}")`);
    return;
  }
}

/**
 * Field Day, S&P side (we answer someone's "CQ FD"). Sequence:
 *   Tx1 CQ FD K1ABC FN42         (their CQ)
 *   Tx2 K1ABC W9XYZ 6A WI        (our exchange — sent on QSO start by caller)
 *   Tx3 W9XYZ K1ABC R 2B EMA     (their R + exchange — we receive this; log here)
 *   Tx4 K1ABC W9XYZ RR73         (we confirm — we send this)
 * Phases: reply → 73 → done.
 */
function advanceFdReplyQso(q, results, setTxMsg, onDone, engine, _qsoLog) {
  const myCall = q.myCall;
  const theirCall = q.call;

  if (q.phase === '73') {
    if (!q._courtesySent) {
      q._courtesySent = true;
      _qsoLog('FD courtesy-73 wait');
      return;
    }
    _fdTeardown(q, engine);
    _qsoLog('FD QSO done (S&P side)');
    return;
  }

  const resp = results.find((d) => {
    const t = (d.text || '').toUpperCase();
    return t.indexOf(myCall) >= 0 && t.indexOf(theirCall) >= 0;
  });
  if (!resp) {
    // WSJT-X parity: if they're working someone else, just keep calling
    // (no auto-halt — see the standard reply path).
    const busy = results.find((d) => {
      const t = (d.text || '').toUpperCase();
      if (t.startsWith('CQ ')) return false;
      if (t.indexOf(myCall) >= 0) return false;
      const parts = t.split(/\s+/);
      return parts.length >= 2 && parts[1] === theirCall;
    });
    if (busy) {
      const otherStation = (busy.text || '').toUpperCase().split(/\s+/)[0] || '';
      _qsoLog('no advance', `(${theirCall} is working ${otherStation || 'another station'} — still calling)`);
      return;
    }
    _qsoLog('no advance', `(no FD decode containing ${myCall}+${theirCall})`);
    return;
  }

  const text = (resp.text || '').toUpperCase();
  if (q.phase === 'reply') {
    // Their R + exchange: "MYCALL THEIRCALL R <ntx><class> <section>"
    const m = text.match(new RegExp('\\bR\\s+(' + FD_NTX_CLASS + ')\\s+(' + FD_SECTION + ')\\b'));
    if (m) {
      q.theirClass = m[1];
      q.theirSection = m[2];
      q.theirExch = m[1] + ' ' + m[2];
      q.txMsg = theirCall + ' ' + myCall + ' RR73';
      q.phase = '73';
      setTxMsg(q.txMsg);
      onDone(); // log
      _qsoLog('advance to 73 + log (FD)', `("${resp.text}" -> tx "${q.txMsg}")`);
      return;
    }
    // They already rolled to RR73/RRR (we missed their R+exch) — still close out.
    if (/\bRR73\b/.test(text) || /\bRRR\b/.test(text)) {
      q.txMsg = theirCall + ' ' + myCall + ' 73';
      q.phase = '73';
      setTxMsg(q.txMsg);
      onDone();
      _qsoLog('advance to 73 + log (FD, late RR73)', `("${resp.text}" -> tx "${q.txMsg}")`);
      return;
    }
    q._heardThisCycle = true;
    _qsoLog('heard but no advance', `(FD decode "${resp.text}" — waiting for R+exchange)`);
    return;
  }
}

/**
 * Can this stalled QSO be closed out gracefully (log + final 73) instead of
 * aborted unlogged? True only when signal reports were exchanged BOTH ways:
 * reply-side r+report — we have their report (q.report) and transmitted ours
 * (q.sentReport); only their RR73 is missing. CQ-side cq-report does NOT
 * qualify (q.report is still null — sending RR73 would falsely acknowledge a
 * report we never received, and there is no complete QSO to log).
 * Hound excluded: the fox never acked our R+rpt, so the fox won't log —
 * logging locally manufactures a likely-busted contact against the
 * DXpedition log, and hounds send no 73 by design. FD excluded: its
 * post-log phases self-terminate, and a capped FD 'reply' has no received
 * exchange to log.
 */
function canCloseoutQso(q) {
  return !!q && !q.fd && !q.hound && q.mode === 'reply'
    && q.phase === 'r+report' && !!(q.report && q.sentReport);
}

/**
 * Give-up closeout: reports were exchanged both ways but the partner went
 * silent/stuck before RR73. Log the QSO and send one final courtesy 73,
 * exactly as if the RR73 had arrived — mirrors the r+report → 73 advance in
 * advanceJtcatQso, so the existing courtesy-73 leg (one wait cycle, then
 * done + engine teardown) finishes the job. Returns false (and does nothing)
 * if the QSO isn't closeout-eligible.
 */
function closeoutStalledQso(q, setTxMsg, onDone, deps) {
  if (!canCloseoutQso(q)) return false;
  const log = (deps && deps.log) || (() => {});
  q.txMsg = _directedMsg(q.call, q.myCall, '73');
  q.phase = '73';
  setTxMsg(q.txMsg);
  onDone();
  log(`[JTCAT QSO] closeout: ${q.call} stalled in r+report with reports exchanged — logging + final 73`);
  return true;
}

/**
 * One give-up message builder shared by all four retry call sites in main.js
 * (popout/remote × single-engine/multi-slice) so the wording can't drift.
 * `kind` is 'abort' or 'closeout'; `heard` flavors the abort (partner kept
 * transmitting vs went silent).
 */
function giveUpMessage(o) {
  const call = o.call || 'partner';
  if (o.kind === 'closeout') {
    return `${call} stopped responding after ${o.max} tries — QSO logged, sending final 73.`;
  }
  if (o.phase === 'cq') return `CQ: no answer after ${o.max} calls — TX stopped.`;
  if (o.hound) return `Fox ${call} never confirmed after ${o.max} tries — TX stopped, not logged.`;
  return o.heard
    ? `QSO with ${call}: gave up after ${o.max} tries — exchange never completed. TX stopped, not logged.`
    : `QSO with ${call}: gave up after ${o.max} tries — no reply heard. TX stopped, not logged.`;
}

/**
 * Decide what to do when a QSO did NOT advance this decode cycle. Pure +
 * unit-tested so all four decode-handler call sites in main.js (popout +
 * remote, single-engine + multi-slice) share one policy.
 *
 * Hard per-phase cap: EVERY non-advancing cycle counts — heard or not.
 * (Until 2026-07 a heard partner reset the counter, so a station repeating
 * a non-advancing message hung the QSO forever — KQ4MHD.)
 *
 * @param {object} o
 * @param {string} o.phase     current QSO phase ('cq','cq-report','reply',…)
 * @param {number} o.txRetries cycles already spent in this phase
 * @param {number} o.maxCq     CQ-phase ceiling
 * @param {number} o.maxQso    in-QSO ceiling (settings.jtcatMaxQsoAttempts)
 * @param {boolean} o.runMode  Full Auto CQ run mode active for this owner?
 * @param {boolean} o.closeoutEligible  canCloseoutQso(q) — reports exchanged
 * @returns {{retries:number, action:'continue'|'abort'|'rearm'|'closeout'}}
 *   continue → keep transmitting; abort → stop + notify (unlogged);
 *   closeout → log + final 73 via closeoutStalledQso (beats rearm so run
 *   mode logs before moving on); rearm → drop this QSO and call CQ again
 *   (run mode only, in-QSO stall).
 */
function decideRetryOutcome(o) {
  const isCq = o.phase === 'cq';
  const retries = (o.txRetries || 0) + 1;
  // Run mode calls CQ indefinitely — never abort on the cq phase.
  if (isCq && o.runMode) return { retries: 0, action: 'continue' };
  const max = isCq ? o.maxCq : o.maxQso;
  if (retries >= max) {
    if (o.closeoutEligible) return { retries, action: 'closeout' };
    if (o.runMode && !isCq) return { retries, action: 'rearm' };
    return { retries, action: 'abort' };
  }
  return { retries, action: 'continue' };
}

module.exports = {
  advanceJtcatQso,
  formatReport,
  decideRetryOutcome,
  canCloseoutQso,
  closeoutStalledQso,
  giveUpMessage,
};
