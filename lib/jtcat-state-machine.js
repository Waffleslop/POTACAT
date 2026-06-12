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
 * Busy station (they answered someone else): WSJT-X parity. Verified
 * against WSJT-X mainwindow.cpp auto_sequence(): when the station you
 * are calling replies to another operator, WSJT-X just KEEPS CALLING —
 * bounded only by its 6-minute Tx watchdog (an upstream merge request
 * for a per-QSO retry counter was rejected). The single exception is
 * the "auto stop to avoid accidental QRM" guard: if, while you're still
 * in the calling (REPLYING) phase, their reply to the other station
 * lands within ~50 Hz of YOUR TX offset, WSJT-X halts TX so you don't
 * transmit on top of their QSO. We mirror both behaviors; our bound is
 * the existing per-QSO retry ceiling (jtcatMaxQsoAttempts, default 12
 * cycles ≈ 3 min) since busy decodes deliberately do NOT reset the
 * counter. The previous 'waiting' hold phase (v1.5.22) is gone —
 * Casey found the pause annoying and wanted WSJT-X behavior (2026-06-12).
 *
 * Departures from WSJT-X:
 *   - Logs at "reports exchanged" rather than "RR73 sent" so a missed
 *     courtesy doesn't lose the QSO. WSJT-X logs after RR73; we log
 *     at advance-to-73 and send the courtesy TX afterward.
 */

const QRM_GUARD_HZ = 50; // WSJT-X auto_sequence stop_tolerance for FT8/FT4

function formatReport(db) {
  const v = Math.round(db || 0);
  return v >= 0
    ? '+' + String(v).padStart(2, '0')
    : '-' + String(Math.abs(v)).padStart(2, '0');
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
        const t = (d.text || '').toUpperCase();
        return t.indexOf(myCall) >= 0 && !t.startsWith('CQ ');
      });
      if (!reply) {
        _qsoLog('no advance', `(no decode containing ${myCall} that isn't a CQ)`);
        return;
      }
      const m = (reply.text || '').toUpperCase().match(
        new RegExp(myCall.replace(/[/]/g, '\\/') + '\\s+([A-Z0-9/]+)\\s+([A-R]{2}\\d{2})', 'i'),
      );
      if (m) {
        q.call = m[1];
        q.grid = m[2];
        const rpt = formatReport(reply.db);
        q.sentReport = rpt;
        q.txMsg = q.call + ' ' + myCall + ' ' + rpt;
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
      const text = (reply.text || '').toUpperCase().trim();
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
        q.txMsg = q.call + ' ' + myCall + ' R' + ourRpt;
        q.phase = 'cq-rr73';
        if (engine && typeof engine.setRxFreq === 'function') engine.setRxFreq(reply.df);
        setTxMsg(q.txMsg);
        onDone();
        _qsoLog('advance to cq-rr73 + log (compressed reply)', `("${reply.text}" -> tx "${q.txMsg}")`);
        return;
      }
      _qsoLog('no advance', `(decode "${reply.text}" matched ${myCall} but didn't parse <call> <grid> or <call> <±NN>)`);
      return;
    }

    if (q.phase === 'cq-report') {
      const resp = results.find((d) => {
        const t = (d.text || '').toUpperCase();
        return t.indexOf(myCall) >= 0 && t.indexOf(q.call) >= 0;
      });
      if (!resp) {
        _qsoLog('no advance', `(no decode containing ${myCall}+${q.call})`);
        return;
      }
      const rptM = (resp.text || '').toUpperCase().match(/R?([+-]\d{2})/);
      if (!rptM) {
        q._heardThisCycle = true;
        _qsoLog('heard but no advance', `(decode "${resp.text}" had no R-report yet)`);
        return;
      }
      q.report = rptM[1];
      q.txMsg = q.call + ' ' + myCall + ' RR73';
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
    const t = (d.text || '').toUpperCase();
    return t.indexOf(myCall) >= 0 && t.indexOf(theirCall) >= 0;
  });
  if (!resp) {
    // No decode for us. Are they working someone else? WSJT-X parity:
    // keep calling them anyway (tail-end) — with the one exception of
    // WSJT-X's "auto stop to avoid accidental QRM" guard: still in the
    // calling phase AND their reply to the other op landed within
    // QRM_GUARD_HZ of OUR TX offset → we'd be transmitting on top of
    // their QSO, so halt instead. (Checked AFTER the direct-response
    // find so a same-cycle reply to us always wins.)
    const busy = results.find((d) => {
      const t = (d.text || '').toUpperCase();
      if (t.startsWith('CQ ')) return false;
      if (t.indexOf(myCall) >= 0) return false;
      const parts = t.split(/\s+/);
      return parts.length >= 2 && parts[1] === theirCall;
    });
    if (busy) {
      const otherStation = (busy.text || '').toUpperCase().split(/\s+/)[0] || '';
      const txFreq = engine && typeof engine._txFreq === 'number' ? engine._txFreq : null;
      if (q.phase === 'reply' && txFreq != null && typeof busy.df === 'number'
          && Math.abs(busy.df - txFreq) <= QRM_GUARD_HZ) {
        q.phase = 'done';
        q.error = theirCall + ' is working ' + (otherStation || 'another station') + ' on our TX frequency';
        if (engine) {
          engine._txEnabled = false;
          if (typeof engine.setTxMessage === 'function') engine.setTxMessage('');
          if (typeof engine.setTxSlot === 'function') engine.setTxSlot('auto');
          if (engine._txActive && typeof engine.txComplete === 'function') engine.txComplete();
        }
        _qsoLog('aborted', `(QRM guard: ${theirCall} answered ${otherStation} at ${busy.df} Hz, within ${QRM_GUARD_HZ} Hz of our TX at ${txFreq} Hz)`);
        return;
      }
      // Busy elsewhere on the band — keep calling. Deliberately NOT
      // setting _heardThisCycle: busy decodes don't reset the retry
      // counter, so the per-QSO ceiling (jtcatMaxQsoAttempts, default
      // 12 cycles) bounds the tail-ending where WSJT-X relies on its
      // 6-minute Tx watchdog.
      _qsoLog('no advance', `(${theirCall} is working ${otherStation || 'another station'} — still calling)`);
      return;
    }
    _qsoLog('no advance', `(no decode containing ${myCall}+${theirCall} -- decoder probably missed their reply this cycle)`);
    return;
  }
  const text = (resp.text || '').toUpperCase();

  if (q.phase === 'reply') {
    const rptM = text.match(/[R]?([+-]\d{2})/);
    if (!rptM) {
      _qsoLog('no advance', `(decode "${resp.text}" had no signal report yet)`);
      return;
    }
    q.report = rptM[1];
    const ourRpt = formatReport(resp.db);
    q.sentReport = ourRpt;
    if (text.indexOf('R' + rptM[1]) >= 0 || text.indexOf('R+') >= 0 || text.indexOf('R-') >= 0) {
      q.txMsg = theirCall + ' ' + myCall + ' RR73';
      q.phase = '73';
      setTxMsg(q.txMsg);
      onDone();
      _qsoLog('advance to 73 + log', `("${resp.text}" had R-report -> tx "${q.txMsg}")`);
    } else {
      q.txMsg = theirCall + ' ' + myCall + ' R' + ourRpt;
      q.phase = 'r+report';
      setTxMsg(q.txMsg);
      _qsoLog('advance to r+report', `("${resp.text}" -> tx "${q.txMsg}")`);
    }
    return;
  }

  if (q.phase === 'r+report') {
    if (/\bRR73\b/.test(text) || /\bRRR\b/.test(text) || /\s73$/.test(text)) {
      q.txMsg = theirCall + ' ' + myCall + ' 73';
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

/**
 * Decide what to do when a QSO did NOT advance this decode cycle (the partner's
 * reply was missed or never sent). Pure + unit-tested so the two decode-handler
 * call sites in main.js (single-engine + multi-slice) share one policy.
 *
 * @param {object} o
 * @param {string} o.phase     current QSO phase ('cq','cq-report','reply',…)
 * @param {number} o.txRetries retry count carried on the QSO
 * @param {boolean} o.heard    was the partner decoded this cycle (still active)?
 * @param {number} o.maxCq     CQ-phase retry ceiling
 * @param {number} o.maxQso    in-QSO retry ceiling (user-configurable)
 * @param {boolean} o.runMode  Full Auto CQ run mode active for this owner?
 * @returns {{retries:number, action:'continue'|'abort'|'rearm'}}
 *   continue → keep transmitting; abort → stop + notify; rearm → drop this QSO
 *   and call CQ again (run mode only, in-QSO stall).
 */
function decideRetryOutcome(o) {
  const isCq = o.phase === 'cq';
  // Partner still being heard → they're responding; reset the counter.
  const retries = o.heard ? 0 : (o.txRetries || 0) + 1;
  // Run mode calls CQ indefinitely — never abort on the cq phase.
  if (isCq && o.runMode) return { retries: 0, action: 'continue' };
  const max = isCq ? o.maxCq : o.maxQso;
  if (retries >= max) {
    if (o.runMode && !isCq) return { retries, action: 'rearm' };
    return { retries, action: 'abort' };
  }
  return { retries, action: 'continue' };
}

module.exports = {
  advanceJtcatQso,
  formatReport,
  decideRetryOutcome,
  QRM_GUARD_HZ,
};
