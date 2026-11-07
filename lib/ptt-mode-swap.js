'use strict';
/**
 * SSB-over-DATA: key only once the radio is in the DATA mode, and put the
 * voice mode back only once it is unkeyed — each confirmed by the radio's own
 * mode report.
 *
 * k8iko (IC-7410): the switch to USB-D clipped about half a second off the
 * start of every over, because PTT went out right behind the mode command and
 * the radio changed mode while already keyed. 9y4dg: PTT on LSB at 0 W left
 * the radio in DIGI LSB after release — the restore was sent once and never
 * checked. Now: set the DATA mode, ask the radio until it reports it (with a
 * timeout), then key; on release, unkey, restore, and confirm it took (one
 * re-send if not).
 */

const DATA_RE = /^(DIG[ULA]?|DIGFM|DIGAM|PKT|PKTUSB|PKTLSB|PKTFM|PKTAM|DATA|USB-D\d?|LSB-D\d?|FM-D\d?|AM-D\d?|DATA-[UL]|D-?USB|D-?LSB)$/i;

function isDataModeName(mode) {
  return DATA_RE.test(String(mode || '').trim());
}

/** Voice mode family for a confirm: the mode reads back as itself, never as DATA. */
function voiceModeMatches(want, got) {
  const w = String(want || '').toUpperCase();
  const g = String(got || '').toUpperCase();
  if (!g || isDataModeName(g)) return false;
  if (w === 'SSB') return g === 'USB' || g === 'LSB';
  if (w === 'FM') return g === 'FM' || g === 'FMN' || g === 'WFM';
  if (w === 'AM') return g === 'AM' || g === 'AMN' || g === 'AMS';
  return g === w;
}

/**
 * Poll the radio's mode until `accept(mode)` or the timeout.
 * @param {object} o
 *   read(): { mode, at, data? } | null — the last mode report (data: an
 *     Icom's separate DATA flag, when the radio reports it that way)
 *   ask(): void — ask the radio for its mode now
 *   accept(mode): boolean
 *   since: ms epoch — only reports after this count
 *   timeoutMs, stepMs (how often the report is read), askEveryMs (how often
 *     the radio is asked; default stepMs), minWaitMs
 *   sleep(ms): Promise (injectable)
 *   cancelled(): boolean — stop early (a release during the wait)
 * @returns {Promise<{ok:boolean, mode:string|null, waitedMs:number, cancelled?:boolean}>}
 */
async function confirmMode(o) {
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const start = now();
  const timeoutMs = o.timeoutMs == null ? 1200 : o.timeoutMs;
  const stepMs = o.stepMs || 100;
  // Read the last report every stepMs, but ask the radio only every
  // askEveryMs: a 25 ms read loop must not put a query on the CI-V bus 40
  // times a second.
  const askEveryMs = o.askEveryMs || stepMs;
  const minWaitMs = o.minWaitMs || 0;
  let last = null;
  let askedAt = -Infinity;
  for (;;) {
    if (o.cancelled && o.cancelled()) return { ok: false, mode: last, waitedMs: now() - start, cancelled: true };
    const r = o.read && o.read();
    if (r && r.at > o.since) {
      last = r.mode;
      if (o.accept(r.mode, r) && now() - start >= minWaitMs) return { ok: true, mode: r.mode, waitedMs: now() - start };
    }
    if (now() - start >= timeoutMs) return { ok: false, mode: last, waitedMs: now() - start };
    if (now() - askedAt >= askEveryMs) {
      askedAt = now();
      try { if (o.ask) o.ask(); } catch { /* a dead link reads as a timeout */ }
    }
    await sleep(stepMs);
  }
}

/**
 * What a forced-DATA key-down does with the mode (GitHub #187).
 * A Winlink session (hold) is one exchange: its QSY puts the radio in DATA
 * and the session end puts the mode back, once. So a frame keys as it is
 * when the radio already reports DATA ('keep'), and otherwise switches
 * without a per-over restore ('switch-hold'). Everything else (SSB-over-DATA
 * voice, SSTV) switches for the over and restores at the release.
 * NA4DQ IC-7300: an Icom reads USB with DATA as its own flag, so every ARDOP
 * frame went USB -> DIGU and back, undoing the session's own DIGU.
 * @returns {'keep'|'switch-hold'|'switch-restore'}
 */
function sessionDataPlan({ hold, inData } = {}) {
  if (!hold) return 'switch-restore';
  return inData ? 'keep' : 'switch-hold';
}

/** The data form of a voice mode, as tuneRadio names it (an Icom's USB + DATA flag is DIGU). */
function dataFormOf(mode) {
  const m = String(mode || '');
  return { USB: 'DIGU', LSB: 'DIGL', FM: 'DIGFM', AM: 'DIGAM' }[m.toUpperCase()] || m;
}

module.exports = { isDataModeName, voiceModeMatches, confirmMode, sessionDataPlan, dataFormOf };
