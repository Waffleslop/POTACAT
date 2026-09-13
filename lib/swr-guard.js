'use strict';
/**
 * SWR guard policy — the pure half of main.js's Flex SWR guard: whether a
 * trip may auto-run the ATU, and what the radio's `atu status=` stream says
 * about a tune POTACAT started.
 *
 * Why this exists (K3SBP 2026-09-13, 20 m, 19:1): the guard aborted the
 * transmission correctly, then — with `settings.swrAutoTune` on — sent
 * `atu start` and cleared its own latch the moment the COMMAND went out,
 * before the radio had tried anything. A Flex ATU tune is a 10 W carrier
 * while the relays step through every L/C combination; into 19:1 it churned
 * the whole search and gave up (TUNE_FAIL_BYPASS), which was the
 * "tx/stop/tx/stop multiple times a second". The guard was blind for 30 s
 * after the tune, the latch was already gone, so the next Hunt answer keyed
 * 69 W into the same fault, tripped again, and — inside the 60 s gate — only
 * then stayed latched. Nothing in the log said the tune had FAILED.
 *
 * Rules, each load-bearing:
 *   - A tune never clears the latch by itself. TX is re-enabled only when
 *     the radio reports a MATCH (TUNE_OK / TUNE_SUCCESSFUL); a failure or a
 *     bypass keeps it off, and so does silence (the radio may not answer at
 *     all — a tune the operator started from SmartSDR while POTACAT was
 *     mid-reconnect, for instance).
 *   - No auto-tune above SWR_AUTOTUNE_MAX. Beyond ~10:1 no ATU matches, so
 *     the tune is just 10 W into a fault — the very thing the guard exists
 *     to prevent — and the radio's own foldback is the only thing left
 *     protecting the PA. The guard limit tops out at 10:1 for the same reason.
 *   - One failed auto-tune per band per session. A tune that failed on 20 m
 *     will fail on 20 m again until somebody touches the antenna; auto-
 *     retrying every 60 s is the churn K3SBP heard. A LATER SUCCESSFUL tune
 *     on that band (the operator's own, after fixing it) forgets the failure.
 *
 * Dual-mode (require + window.SwrGuard) so a renderer could share it.
 */

const SWR_AUTOTUNE_MAX = 10;                // an ATU can't match past this — don't try
const SWR_AUTOTUNE_MIN_INTERVAL_MS = 60000; // never more than one auto-tune a minute
const ATU_RESULT_TIMEOUT_MS = 20000;        // a Flex sweep takes a few seconds; 20 s = no report
const ATU_STALE_ECHO_MS = 1500;             // idle status this soon after `atu start` = pre-tune state, not a result

/**
 * Classify one `atu status=` value from the Flex status stream.
 *   sweeping — TUNE_IN_PROGRESS
 *   matched  — TUNE_OK (memory recall) / TUNE_SUCCESSFUL (fresh match)
 *   failed   — TUNE_FAIL / TUNE_FAIL_BYPASS / TUNE_ABORTED
 *   idle     — TUNE_NOT_STARTED / TUNE_BYPASS / TUNE_MANUAL_BYPASS / anything else
 */
function classifyAtuStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === 'TUNE_IN_PROGRESS') return 'sweeping';
  if (s === 'TUNE_OK' || s === 'TUNE_SUCCESSFUL') return 'matched';
  if (s === 'TUNE_FAIL' || s === 'TUNE_FAIL_BYPASS' || s === 'TUNE_ABORTED') return 'failed';
  return 'idle';
}

/**
 * Resolve a tune episode POTACAT started against one status report.
 *
 * @param {{startedAt:number, sawSweep:boolean}} episode — mutated: sawSweep
 * @param {string} status — kv.status from the `atu` status line
 * @param {number} now
 * @returns {{outcome: 'matched'|'failed'|null, kind: string}}
 *
 * An idle status is ambiguous: the radio re-sends its current state on the
 * subscription for reasons of its own, so TUNE_NOT_STARTED arriving right
 * after `atu start` is the state BEFORE our tune, not its result. Once the
 * sweep has been seen (or the echo window has passed with no sweep at all —
 * the ATU is absent, disabled, or the command was refused) an idle state
 * means the tune ended without a match.
 */
function decideAtuOutcome(episode, status, now) {
  const kind = classifyAtuStatus(status);
  if (kind === 'sweeping') { episode.sawSweep = true; return { outcome: null, kind }; }
  if (kind === 'matched') return { outcome: 'matched', kind };
  if (kind === 'failed') return { outcome: 'failed', kind };
  if (!episode.sawSweep && (now - episode.startedAt) < ATU_STALE_ECHO_MS) return { outcome: null, kind };
  return { outcome: 'failed', kind };
}

/**
 * May the guard auto-run the ATU after this trip?
 *
 * @param {object} o
 * @param {boolean} o.enabled        settings.swrAutoTune
 * @param {boolean} o.flexConnected  SmartSDR API up (the only radio with an ATU we can drive AND read)
 * @param {number}  o.swr            the tripping ratio
 * @param {string}  o.band           band at trip time ('' if unknown)
 * @param {string}  o.failedBand     band whose last auto-tune failed this session ('' if none)
 * @param {number}  o.lastAutoTuneAt ms timestamp of the last auto-tune (0 = never)
 * @param {number}  o.now
 * @returns {{tune: boolean, reason: 'ok'|'off'|'no-flex'|'beyond-atu'|'failed-on-band'|'rate-limited'}}
 */
function decideSwrAutoTune(o) {
  if (!o || !o.enabled) return { tune: false, reason: 'off' };
  if (!o.flexConnected) return { tune: false, reason: 'no-flex' };
  const swr = Number(o.swr);
  if (!(swr <= SWR_AUTOTUNE_MAX)) return { tune: false, reason: 'beyond-atu' };
  if (o.band && o.failedBand && o.band === o.failedBand) return { tune: false, reason: 'failed-on-band' };
  if ((o.now || 0) - (o.lastAutoTuneAt || 0) < SWR_AUTOTUNE_MIN_INTERVAL_MS) return { tune: false, reason: 'rate-limited' };
  return { tune: true, reason: 'ok' };
}

const api = {
  SWR_AUTOTUNE_MAX,
  SWR_AUTOTUNE_MIN_INTERVAL_MS,
  ATU_RESULT_TIMEOUT_MS,
  ATU_STALE_ECHO_MS,
  classifyAtuStatus,
  decideAtuOutcome,
  decideSwrAutoTune,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.SwrGuard = api;
