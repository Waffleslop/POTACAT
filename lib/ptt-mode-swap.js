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
 *
 * `tried` (GitHub #300): the session has already asked for the DATA mode once.
 * A radio that still does not report it never will on this link (NA4DQ's
 * IC-7100 on rigctld read back FM after every "FM -> DIGFM": 70 switches in
 * 79 packet overs, each one a mode command and a late key), so the frame keys
 * as the radio is. One switch per session, never one per over.
 * @returns {'keep'|'switch-hold'|'switch-restore'}
 */
function sessionDataPlan({ hold, inData, tried } = {}) {
  if (!hold) return 'switch-restore';
  if (inData || tried) return 'keep';
  return 'switch-hold';
}

/** The data form of a voice mode, as tuneRadio names it (an Icom's USB + DATA flag is DIGU). */
function dataFormOf(mode) {
  const m = String(mode || '');
  return { USB: 'DIGU', LSB: 'DIGL', FM: 'DIGFM', AM: 'DIGAM' }[m.toUpperCase()] || m;
}

/**
 * Does this radio have real FM and AM data forms (FM-D / AM-D)? Icom does:
 * its DATA flag rides on FM and AM as it does on USB and LSB. Other radios
 * reached over POTACAT's CAT either have no FM data mode at all, or none
 * that SSB-over-DATA may send (lib/packet-rig-mode.js lists them per link).
 * The one place this is decided for the PTT data switch.
 * @param {object} o
 * @param {string} [o.brand]   the active rig model's brand (lib/rig-models.js)
 * @param {string} [o.rigType] detectRigType(): 'icom' for a CI-V link with no model picked
 */
function hasFmAmDataMode({ brand, rigType } = {}) {
  return brand === 'Icom' || (!brand && (rigType === 'icom' || rigType === 'icom-network'));
}

/**
 * The DATA mode a key-down switches to, for SSB-over-DATA or a forced DATA
 * transmission, or null to key the radio as it is.
 *
 * USB/SSB -> DIGU, LSB -> DIGL on every radio. FM -> DIGFM and AM -> DIGAM
 * only where the radio has those forms (hasFmAmDataMode); sending FM to
 * USB-D moved an IC-9700 off FM (KG5EIU), and on a radio with no FM data
 * mode it put an FM over out as USB data: KS9B, Elecraft KX3 on 2 m FM
 * (GitHub #561). There SSB-over-DATA keys in FM and says why ('fm-am').
 * A forced caller (SSTV, Winlink, Icom LAN voice) keeps its old choice,
 * DIGU; every forced caller is an Icom today (lib/packet-rig-mode.js
 * keyDownOpts sends a non-Icom FM packet frame with noDataSwap instead).
 * @param {object} o
 * @param {string} o.mode       the radio's current mode
 * @param {boolean} [o.forced]  opts.forceDataMode
 * @param {boolean} [o.fmAmData] hasFmAmDataMode() for the active radio
 * @returns {{dataMode: string|null, skip?: 'fm-am'}}
 */
function pttDataModeFor({ mode, forced, fmAmData } = {}) {
  const m = String(mode || '').toUpperCase();
  if (m === 'LSB') return { dataMode: 'DIGL' };
  if (m === 'USB' || m === 'SSB') return { dataMode: 'DIGU' };
  if (m === 'FM' || m === 'AM') {
    if (fmAmData) return { dataMode: m === 'FM' ? 'DIGFM' : 'DIGAM' };
    if (forced) return { dataMode: 'DIGU' };
    return { dataMode: null, skip: 'fm-am' };
  }
  return { dataMode: null };
}

/** Logged once per session when SSB-over-DATA leaves FM or AM alone. */
function fmAmSkipLog(mode) {
  const m = String(mode || '').toUpperCase() === 'AM' ? 'AM' : 'FM';
  return `[PTT] SSB-over-DATA does not apply in FM or AM on this radio: keying in ${m}. The radio's own microphone may also be live.`;
}

module.exports = { isDataModeName, voiceModeMatches, confirmMode, sessionDataPlan, dataFormOf, hasFmAmDataMode, pttDataModeFor, fmAmSkipLog };
