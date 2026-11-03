'use strict';

// ATU Calibration Wizard — the policy and the run loop, with no Electron in it
// (Casey 2026-10-31; handoff "POTACAT ATU Calibration Wizard — Dev Handoff").
//
// A Flex keeps its antenna-tuner memories in the RADIO, keyed by TX antenna
// port and frequency range. Fill them once at every frequency the operator
// uses and every later QSY recalls a match instead of running a tune cycle.
// This module decides WHICH frequencies (buildPlan), WHAT a point's numbers
// mean (classifyPoint) and HOW a run proceeds (AtuWizardRun); main.js supplies
// the radio (lib/smartsdr.js), the SWR frames, the clock and the storage.
//
// Rules, all load-bearing:
//   - Never transmit outside the operator's privileges: lib/privileges.js is
//     the one edge table, and every point keeps `edgeMarginKhz` inside it.
//   - The operator's digital dials are the app's own tables (lib/ft8-engine.js),
//     never retyped here.
//   - The carrier is keyed only for the bypass and verify reads; `atu start`
//     keys the radio itself. Every key-down has a watchdog.
//   - A memory that already matches (RECALLED) and a spot that needs no tuner
//     (NATIVE) are passes, not failures: a resonant antenna produces many.
//   - `atu clear` is never sent from here or anywhere in POTACAT.

const { isOutOfPrivilege, PRIVILEGE_MAP } = require('./privileges');
const { DIGITAL_FREQS, FT2_FREQS, freqsForMode } = require('./ft8-engine');

const FT4_FREQS = freqsForMode('FT4');

// JTTY dials (kHz): the WSJT team's preliminary rc1 list, the same table the
// JTCAT window carries as JTTY_BAND_FREQS (renderer/jtcat-popout.js). The
// test pins the two copies together.
const JTTY_KHZ = { '40m': 7090, '20m': 14090 };

const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
const MODES = ['CW', 'DIGITAL', 'SSB'];
// The slice mode a test point is LISTENED in. The tune carrier is the same in
// every mode and the memory is keyed by frequency, so the mode only decides
// what the busy check hears. A digital dial is listened to in CW with a
// narrow filter on the exact carrier frequency: the S-meter in DIGU reads the
// whole 3 kHz passband and an FT8 dial is then "busy" all day (K3SBP's first
// run skipped 7.074, 7.250 and 14.074), while the carrier itself lands at the
// dial, below where FT8 signals live. SSB stays wide: a voice signal on the
// dial frequency sits above it.
// FT8 signals start 200 Hz above the dial, so the digital listen is ±100 Hz.
const SLICE_MODE = { CW: 'CW', DIGITAL: 'CW', SSB: 'USB' };
const LISTEN_FILTER_HZ = { CW: 500, DIGITAL: 200, SSB: 0 };
// Mode token the privilege table understands for each column.
const PRIV_MODE = { CW: 'CW', DIGITAL: 'FT8', SSB: 'SSB' };

const DEFAULTS = Object.freeze({
  tunePowerW: 10,
  maxTunePowerW: 25,
  swrThreshold: 2.0,      // TUNED needs tuned SWR at or below this
  nativeMax: 1.5,         // bypass SWR at or below this = NATIVE (no tuner needed)
  marginalMax: 3.0,       // tuned SWR above threshold but at or below this = MARGINAL
  dwellMs: 3000,          // listen before transmit (never below MIN_DWELL_MS)
  pauseMs: 2000,          // rest between points (finals and ATU relays)
  density: 'normal',      // 'normal' | 'dense'
  edgeMarginKhz: 3,       // keep this far inside every band / sub-band edge
  busyAction: 'skip',     // 'skip' | 'shift' | 'ask' when the frequency is busy
  busyDbm: -93,           // S5 at 50 ohms: a signal above this within the dwell = busy
  shiftKhz: 2,
  keyedMaxMs: 5000,       // longest any measurement keeps the carrier up
  tuneTimeoutMs: 15000,   // longest wait for a terminal ATU status
  statusTimeoutMs: 2000,  // longest wait for the ATU status that follows a QSY
  sampleMs: 1000,         // carrier time per SWR read
  trendRise: 0.5,         // bypass SWR rise over the previous run that flags a point
});
const MIN_DWELL_MS = 2000;
const DENSE_STEP_KHZ = { '160m': 10, '80m': 10, '60m': 5, '40m': 10, '30m': 10, '20m': 20, '17m': 20, '15m': 25, '12m': 25, '10m': 50, '6m': 100 };
const MERGE_WITHIN_KHZ = 2;

// The "Normal" plan: where POTA, FT8/FT4 and DX activity actually happens,
// plus POTACAT's own dials. US Extra edges; buildPlan() filters by the
// operator's class. Digital dials come from the app's tables.
const NORMAL_PLAN = {
  '160m': { CW: [1810, 1830], DIGITAL: [], SSB: [1850, 1900] },
  '80m':  { CW: [3525, 3550, 3570], DIGITAL: [], SSB: [3800, 3850, 3900] },
  '60m':  { CW: [], DIGITAL: [], SSB: [] },
  '40m':  { CW: [7025, 7040, 7060], DIGITAL: [], SSB: [7150, 7200, 7250] },
  '30m':  { CW: [10110, 10125], DIGITAL: [], SSB: [] },
  '20m':  { CW: [14025, 14045, 14065], DIGITAL: [], SSB: [14200, 14250, 14300] },
  '17m':  { CW: [18075, 18090], DIGITAL: [], SSB: [18130, 18150] },
  '15m':  { CW: [21025, 21045, 21065], DIGITAL: [], SSB: [21300, 21350, 21400] },
  '12m':  { CW: [24900, 24910], DIGITAL: [], SSB: [24950, 24975] },
  '10m':  { CW: [28025, 28050], DIGITAL: [], SSB: [28350, 28450, 28600] },
  '6m':   { CW: [50090], DIGITAL: [], SSB: [50125, 50200] },
};

/** The digital dials for a band, labelled, from the app's own tables. */
function digitalDials(band) {
  const out = [];
  if (DIGITAL_FREQS[band]) out.push({ khz: DIGITAL_FREQS[band], label: 'FT8' });
  if (FT4_FREQS[band]) out.push({ khz: FT4_FREQS[band], label: 'FT4' });
  if (FT2_FREQS[band] && band !== '6m') out.push({ khz: FT2_FREQS[band], label: 'FT2' });
  if (JTTY_KHZ[band]) out.push({ khz: JTTY_KHZ[band], label: 'JTTY' });
  return out.sort((a, b) => a.khz - b.khz);
}

/** Privilege ranges to keep inside: the class's own, or Extra's for 'none'. */
function rangesFor(licenseClass) {
  return PRIVILEGE_MAP[licenseClass] || PRIVILEGE_MAP.us_extra;
}

function modeAllowed(allowed, mode) {
  if (allowed === 'all') return true;
  if (allowed === 'cw') return mode === 'CW';
  if (allowed === 'cw_digi') return mode === 'CW' || mode === 'DIGITAL';
  if (allowed === 'phone') return mode === 'SSB';
  return false;
}

/** The ranges (kHz) a mode may use on a band under a class, margin applied. */
function segmentsFor(band, mode, licenseClass, marginKhz) {
  const [lo, hi] = BAND_KHZ[band] || [0, 0];
  const out = [];
  for (const [l, u, allowed] of rangesFor(licenseClass)) {
    if (u < lo || l > hi) continue;
    if (!modeAllowed(allowed, mode)) continue;
    const a = Math.max(l, lo) + marginKhz, b = Math.min(u, hi) - marginKhz;
    if (b > a) out.push([a, b]);
  }
  return out;
}

// Band limits (kHz), US. Only used to pick the privilege ranges per band.
const BAND_KHZ = {
  '160m': [1800, 2000], '80m': [3500, 4000], '60m': [5330, 5405], '40m': [7000, 7300],
  '30m': [10100, 10150], '20m': [14000, 14350], '17m': [18068, 18168], '15m': [21000, 21450],
  '12m': [24890, 24990], '10m': [28000, 29700], '6m': [50000, 54000],
};

/**
 * Is this frequency transmittable in this mode under this class, and far
 * enough from every edge? `reason` says why not.
 */
function pointAllowed(freqKhz, mode, licenseClass, marginKhz) {
  const cls = PRIVILEGE_MAP[licenseClass] ? licenseClass : 'us_extra';
  if (isOutOfPrivilege(freqKhz, PRIV_MODE[mode] || mode, cls)) return { ok: false, reason: 'outside your privileges' };
  for (const [l, u, allowed] of rangesFor(cls)) {
    if (freqKhz < l || freqKhz > u || !modeAllowed(allowed, mode)) continue;
    if (freqKhz - l < marginKhz || u - freqKhz < marginKhz) return { ok: false, reason: `within ${marginKhz} kHz of a band edge` };
    return { ok: true };
  }
  return { ok: false, reason: 'outside your privileges' };
}

function pointId(band, mode, khz) { return `${band}:${mode}:${khz}`; }

/**
 * Build the list of test points.
 * @param {object} o
 * @param {string[]} o.bands         e.g. ['40m','20m']
 * @param {string[]} [o.modes]       subset of MODES (default all three)
 * @param {string} [o.density]       'normal' | 'dense'
 * @param {string} [o.licenseClass]  lib/privileges.js key; 'none' = Extra edges
 * @param {number} [o.edgeMarginKhz]
 * @param {Array<{band,mode,freqKhz,label}>} [o.custom]  operator-added points
 * @returns {{points: object[], dropped: object[]}}  dropped = {band, mode, freqKhz, label, reason}
 */
function buildPlan(o = {}) {
  const bands = (o.bands || []).filter(b => BANDS.includes(b));
  const modes = (o.modes || MODES).filter(m => MODES.includes(m));
  const licenseClass = o.licenseClass || 'none';
  const margin = Number.isFinite(o.edgeMarginKhz) ? o.edgeMarginKhz : DEFAULTS.edgeMarginKhz;
  const dense = o.density === 'dense';
  const points = [], dropped = [];
  const add = (band, mode, khz, label) => {
    const v = pointAllowed(khz, mode, licenseClass, margin);
    if (!v.ok) { dropped.push({ band, mode, freqKhz: khz, label, reason: v.reason }); return; }
    points.push({ id: pointId(band, mode, khz), band, mode, freqKhz: khz, label: label || '', sliceMode: SLICE_MODE[mode] });
  };
  for (const band of bands) {
    const plan = NORMAL_PLAN[band] || { CW: [], DIGITAL: [], SSB: [] };
    for (const mode of modes) {
      if (mode === 'DIGITAL') for (const d of digitalDials(band)) add(band, mode, d.khz, d.label);
      else for (const khz of plan[mode] || []) add(band, mode, khz, '');
      if (dense) {
        const step = DENSE_STEP_KHZ[band] || 25;
        for (const [a, b] of segmentsFor(band, mode, licenseClass, margin)) {
          for (let k = Math.ceil(a / step) * step; k <= b; k += step) add(band, mode, k, 'step');
        }
      }
    }
  }
  for (const c of o.custom || []) {
    if (!c || !BANDS.includes(c.band) || !MODES.includes(c.mode) || !Number.isFinite(c.freqKhz)) continue;
    add(c.band, c.mode, c.freqKhz, c.label || 'custom');
  }
  // Merge points within MERGE_WITHIN_KHZ: a labelled dial wins over a step.
  points.sort((a, b) => a.freqKhz - b.freqKhz || MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
  const merged = [];
  for (const p of points) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.freqKhz - p.freqKhz) <= MERGE_WITHIN_KHZ) {
      if (prev.label === 'step' && p.label !== 'step') merged[merged.length - 1] = p;
      continue;
    }
    merged.push(p);
  }
  merged.sort((a, b) => BANDS.indexOf(a.band) - BANDS.indexOf(b.band) || a.freqKhz - b.freqKhz);
  return { points: merged, dropped };
}

// ─── Results ───────────────────────────────────────────────────────────────
const RESULTS = ['NATIVE', 'TUNED', 'RECALLED', 'MARGINAL', 'FAILED', 'SKIPPED', 'TIMEOUT'];
const RESULT_COLOUR = { NATIVE: 'green', TUNED: 'green', RECALLED: 'green', MARGINAL: 'amber', FAILED: 'red', SKIPPED: 'grey', TIMEOUT: 'red' };
const GREEN = new Set(['NATIVE', 'TUNED', 'RECALLED']);

/** The radio's atu status → sweeping | matched | failed | idle (lib/swr-guard.js has the same table). */
function atuKind(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'TUNE_IN_PROGRESS') return 'sweeping';
  if (s === 'TUNE_OK' || s === 'TUNE_SUCCESSFUL') return 'matched';
  if (s === 'TUNE_FAIL' || s === 'TUNE_FAIL_BYPASS' || s === 'TUNE_ABORTED') return 'failed';
  return 'idle';
}

/**
 * What a measured point means.
 * @param {object} m  {skipped, timeout, recalled, bypassSwr, tunedSwr, atuStatus}
 * @param {object} [s] thresholds (DEFAULTS)
 */
function classifyPoint(m, s = DEFAULTS) {
  const threshold = s.swrThreshold ?? DEFAULTS.swrThreshold;
  const nativeMax = s.nativeMax ?? DEFAULTS.nativeMax;
  const marginalMax = s.marginalMax ?? DEFAULTS.marginalMax;
  if (m.skipped) return 'SKIPPED';
  if (m.timeout) return 'TIMEOUT';
  const kind = atuKind(m.atuStatus);
  const tuned = Number.isFinite(m.tunedSwr) ? m.tunedSwr : null;
  const bypass = Number.isFinite(m.bypassSwr) ? m.bypassSwr : null;
  if (m.recalled) {
    if (tuned != null && tuned <= threshold) return 'RECALLED';
    if (tuned != null && tuned <= marginalMax) return 'MARGINAL';
    return 'FAILED';
  }
  // The radio leaves a 1.1:1 antenna in bypass and reports success — a pass.
  if (bypass != null && bypass <= nativeMax && (kind !== 'failed')) return 'NATIVE';
  if (kind === 'failed') return 'FAILED';
  if (tuned == null) return 'FAILED';
  if (tuned <= threshold) return 'TUNED';
  if (tuned <= marginalMax) return 'MARGINAL';
  return 'FAILED';
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function summarize(points) {
  const counts = {};
  for (const r of RESULTS) counts[r] = 0;
  for (const p of points) if (p.result) counts[p.result] = (counts[p.result] || 0) + 1;
  const done = points.filter(p => p.result).length;
  return { total: points.length, done, counts, green: points.filter(p => GREEN.has(p.result)).length, problems: points.filter(p => p.result && !GREEN.has(p.result) && p.result !== 'SKIPPED').length };
}

/** Rough run time: dwell + bypass read + tune + verify read + pause per point. */
function estimateRunMs(points, s = DEFAULTS) {
  const per = (s.dwellMs ?? DEFAULTS.dwellMs) + 1500 + 4000 + 1500 + (s.pauseMs ?? DEFAULTS.pauseMs);
  return points.length * per;
}

/** Points whose bypass SWR rose over `trendRise` since the previous run. */
function trendFlags(run, prev, rise = DEFAULTS.trendRise) {
  if (!run || !prev) return [];
  const before = new Map((prev.points || []).map(p => [p.id, p]));
  const out = [];
  for (const p of run.points || []) {
    const q = before.get(p.id);
    if (!q || !Number.isFinite(p.bypassSwr) || !Number.isFinite(q.bypassSwr)) continue;
    if (p.bypassSwr - q.bypassSwr > rise) out.push({ id: p.id, band: p.band, freqKhz: p.freqKhz, from: q.bypassSwr, to: p.bypassSwr });
  }
  return out;
}

/**
 * What a finished calibration says about each band (Casey 2026-10-31: "the
 * Flex's transmit table — which bands I can TX on and therefore which spots I
 * see — should be updated based on this"). A band with two or more measured
 * points that ALL failed has no match the tuner can reach: `noMatch`. A band
 * with any passing point is `matched`. Skipped points say nothing; a band
 * with fewer than two measurements is left alone.
 */
function bandVerdicts(points) {
  const byBand = {};
  for (const p of points || []) {
    if (!p.result || p.result === 'SKIPPED') continue;
    (byBand[p.band] = byBand[p.band] || []).push(p);
  }
  const noMatch = [], matched = [];
  for (const [band, pts] of Object.entries(byBand)) {
    if (pts.some(p => GREEN.has(p.result))) matched.push(band);
    else if (pts.length >= 2 && pts.every(p => p.result === 'FAILED' || p.result === 'TIMEOUT')) noMatch.push(band);
  }
  const order = (a, b) => BANDS.indexOf(a) - BANDS.indexOf(b);
  return { noMatch: noMatch.sort(order), matched: matched.sort(order) };
}

/** One sentence of advice for the problem points of a run. */
function adviceFor(points) {
  const bad = points.filter(p => p.result && !GREEN.has(p.result) && p.result !== 'SKIPPED');
  if (!bad.length) return '';
  const byBand = {};
  for (const p of points) if (p.result && p.result !== 'SKIPPED') (byBand[p.band] = byBand[p.band] || []).push(p);
  const wholeBands = Object.keys(byBand).filter(b => byBand[b].length >= 2 && byBand[b].every(p => !GREEN.has(p.result)));
  if (wholeBands.length) return `Every point on ${wholeBands.join(', ')} failed. On a resonant antenna (an end-fed half wave cut for 40 m, say) a band that is not one of its harmonics often has no match the tuner can reach, and that is the antenna, not a fault. If the band used to work, look at the feedline, a connector or the antenna itself there.`;
  return `${bad.length} point${bad.length === 1 ? '' : 's'} did not match. Re-run those points; a single bad spot is usually a busy frequency or a relay bounce.`;
}

function csvFor(run) {
  const esc = (v) => (v == null ? '' : String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [['band', 'mode', 'freq_khz', 'label', 'bypass_swr', 'tuned_swr', 'atu_status', 'result', 'duration_ms']];
  for (const p of run.points || []) rows.push([p.band, p.mode, p.freqKhz, p.label, p.bypassSwr ?? '', p.tunedSwr ?? '', p.atuStatus ?? '', p.result ?? '', p.durationMs ?? '']);
  return rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
}

// ─── The run ───────────────────────────────────────────────────────────────
/**
 * One calibration (or verification) run over a list of points.
 *
 * `radio` is whatever main.js hands in; the test uses a fake:
 *   setMemoriesEnabled(on), tune(freqKhz, sliceMode), bypass(), startTune(),
 *   keyTune(on), setTunePower(w), signalDbm() → number|null
 * Events arrive through the run's own methods, called by main's listeners:
 *   noteAtuStatus(kv)   kv = {status, atu_enabled, memories_enabled, using_mem}
 *   noteSwr(swr, fwdW)  one Flex meter frame
 *   noteInterlock(kv)   another client's PTT → pause
 *   noteSliceMoved(hz)  the slice moved under us → pause
 * `hooks`: log(line), onState(state), now() → ms, sleep(ms) → Promise.
 */
class AtuWizardRun {
  constructor(radio, points, settings, hooks = {}) {
    this.radio = radio;
    this.settings = { ...DEFAULTS, ...(settings || {}) };
    if (this.settings.dwellMs < MIN_DWELL_MS) this.settings.dwellMs = MIN_DWELL_MS;
    if (this.settings.tunePowerW > DEFAULTS.maxTunePowerW) this.settings.tunePowerW = DEFAULTS.maxTunePowerW;
    this.verify = !!(settings && settings.verify);
    // A verification run keeps the calibration's bypass readings: a point the
    // tuner never touched (NATIVE) has no memory to recall and is judged on them.
    this.points = points.map(p => ({ ...p, result: null, bypassSwr: this.verify && Number.isFinite(p.bypassSwr) ? p.bypassSwr : null, tunedSwr: null, atuStatus: null, usingMem: null, durationMs: null }));
    this.log = hooks.log || (() => {});
    this.onState = hooks.onState || (() => {});
    this.now = hooks.now || (() => Date.now());
    this.sleep = hooks.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this.phase = 'idle';          // idle | running | paused | done | stopped
    this.index = -1;
    this.stopReason = '';
    this.pauseReason = '';
    this.keyed = false;
    this._sweeping = false;       // between our `atu start` and its terminal status: the radio keys ITSELF
    this._retried = {};           // point index -> times redone after a pause interrupted it
    this._keyWatchdog = null;
    this._lastAtu = null;         // {kv, at}
    this._swrFrames = null;       // collecting while keyed
    this._skipRequested = false;
    this._busyAnswer = null;      // 'skip' | 'shift' | 'go' while asking
    this._busyPeak = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.memoriesConfirmed = null;
  }

  get active() { return this.phase === 'running' || this.phase === 'paused'; }

  state() {
    return {
      phase: this.phase, verify: this.verify, index: this.index, stopReason: this.stopReason, pauseReason: this.pauseReason,
      asking: this._busyAnswer === 'asking' ? { point: this.points[this.index], peakDbm: this._busyPeak } : null,
      keyed: this.keyed, startedAt: this.startedAt, finishedAt: this.finishedAt,
      memoriesConfirmed: this.memoriesConfirmed,
      points: this.points.map(p => ({ ...p })),
      summary: summarize(this.points),
      settings: this.settings,
    };
  }

  _push() { try { this.onState(this.state()); } catch { /* a closed window */ } }

  // Inputs from the radio (main's listeners call these).
  noteAtuStatus(kv) {
    if (!kv) return;
    this._lastAtu = { kv: { ...((this._lastAtu && this._lastAtu.kv) || {}), ...kv }, at: this.now() };
    if (kv.memories_enabled != null) this.memoriesConfirmed = String(kv.memories_enabled) === '1';
  }
  noteSwr(swr, fwdW) {
    if (!this._swrFrames) return;
    // Below 2 W the Flex bridge's ratio is noise (lib/swr-guard.js SWR_MIN_FWD_W).
    if (!Number.isFinite(swr) || !(fwdW >= 2)) return;
    this._swrFrames.push(swr);
  }
  noteInterlock(kv) {
    // Our own carrier (keyed) and our own ATU sweep (the radio keys itself for
    // `atu start`) both show up on the interlock; only a key-down we did not
    // ask for is another client. K3SBP's first run paused at every sweep.
    if (!this.active || this.keyed || this._sweeping) return;
    const st = String((kv && kv.state) || '').toUpperCase();
    if (st === 'PTT_REQUESTED' || st === 'TRANSMITTING') this.pause('another client keyed the radio');
  }
  noteSliceMoved(hz) {
    if (!this.active || this.phase === 'paused') return;
    const p = this.points[this.index];
    if (!p || this._moving) return;
    if (Math.abs(hz - p.freqKhz * 1000) > 500) this.pause(`the slice moved to ${(hz / 1e6).toFixed(4)} MHz from another client`);
  }

  // Operator controls.
  pause(reason) {
    if (this.phase !== 'running') return;
    this.phase = 'paused';
    this.pauseReason = reason || 'paused';
    this.log(`paused: ${this.pauseReason}`);
    this._unkey('pause');
    this._push();
  }
  resume() {
    if (this.phase !== 'paused') return;
    this.phase = 'running';
    this.pauseReason = '';
    this._push();
  }
  skip() { if (this.active) this._skipRequested = true; if (this._busyAnswer === 'asking') this._busyAnswer = 'skip'; }
  answerBusy(answer) { if (this._busyAnswer === 'asking') this._busyAnswer = answer === 'shift' ? 'shift' : answer === 'go' ? 'go' : 'skip'; }
  stop(reason) {
    if (!this.active && this.phase !== 'idle') return;
    this.phase = 'stopped';
    this.stopReason = reason || 'stopped by the operator';
    this.log(`stopped: ${this.stopReason}`);
    this._unkey('stop');
    this._push();
  }

  // ─── the loop ───
  async start() {
    if (this.phase !== 'idle') throw new Error('a run can only start once');
    this.phase = 'running';
    this.startedAt = this.now();
    this.log(`${this.verify ? 'verification' : 'calibration'} run started: ${this.points.length} points, ${this.settings.tunePowerW} W tune power`);
    this._push();
    try {
      if (!this.verify) {
        this.radio.setMemoriesEnabled(true);
        if (Number.isFinite(this.settings.tunePowerW)) this.radio.setTunePower(this.settings.tunePowerW);
        const kv = await this._waitAtu(() => this._lastAtu && this._lastAtu.kv.memories_enabled != null, this.settings.statusTimeoutMs);
        if (kv && String(kv.memories_enabled) !== '1') this.log('WARNING: the radio did not confirm memories_enabled=1');
      }
      for (let i = 0; i < this.points.length; i++) {
        if (!(await this._gate())) break;
        this.index = i;
        this._push();
        const t0 = this.now();
        try {
          if (this.verify) await this._verifyPoint(this.points[i]);
          else await this._calibratePoint(this.points[i]);
        } finally {
          this.points[i].durationMs = this.now() - t0;
          this._sweeping = false;
          this._unkey('point end');
        }
        if (!(await this._gate())) break;
        // A pause (another client keyed, the slice moved) interrupted this
        // point before it had a result: do it again once the run resumes,
        // instead of leaving a blank row — twice at most, then move on.
        if (!this.points[i].result && (this._retried[i] = (this._retried[i] || 0) + 1) <= 2) {
          this.log(`${(this.points[i].freqKhz / 1000).toFixed(4)} MHz was interrupted — measuring it again`);
          i--;
          continue;
        }
        if (i < this.points.length - 1) await this._sleepGated(this.settings.pauseMs);
      }
    } catch (err) {
      this.log(`run error: ${err && err.message}`);
      if (this.active) this.stop(`error: ${err && err.message}`);
    } finally {
      this._unkey('run end');
      if (this.phase === 'running') { this.phase = 'done'; this.log(`run complete: ${JSON.stringify(summarize(this.points).counts)}`); }
      this.finishedAt = this.now();
      this.index = -1;
      this._push();
    }
    return this.state();
  }

  /** Wait through a pause; false when the run was stopped. */
  async _gate() {
    while (this.phase === 'paused') await this.sleep(50);
    return this.phase === 'running';
  }
  async _sleepGated(ms) {
    const until = this.now() + ms;
    while (this.now() < until) {
      if (!(await this._gate())) return false;
      await this.sleep(Math.min(50, Math.max(1, until - this.now())));
    }
    return this.phase === 'running';
  }
  async _waitAtu(pred, timeoutMs) {
    const until = this.now() + timeoutMs;
    while (this.now() < until) {
      if (this.phase !== 'running') return null;
      if (this._lastAtu && pred(this._lastAtu)) return this._lastAtu.kv;
      await this.sleep(20);
    }
    return null;
  }

  async _qsy(p) {
    const before = this.now();
    this._moving = true;
    this.radio.tune(p.freqKhz, p.sliceMode, LISTEN_FILTER_HZ[p.mode] || 0);
    // The status that FOLLOWS the move, never the previous point's line still
    // in flight (it would read as this point's).
    const kv = await this._waitAtu((a) => a.at > before, this.settings.statusTimeoutMs);
    this._moving = false;
    return kv;
  }

  async _calibratePoint(p) {
    const s = this.settings;
    const kv = await this._qsy(p);
    if (this.phase !== 'running') return;
    if (kv) { p.atuStatus = kv.status || null; p.usingMem = String(kv.using_mem) === '1'; }
    // Listen before transmitting — every point, a recalled memory included
    // (its check keys the carrier too).
    const busy = await this._listen(p);
    if (this.phase !== 'running') return;
    if (busy === 'skip') { p.result = 'SKIPPED'; this.log(`${(p.freqKhz / 1000).toFixed(4)} MHz busy — skipped`); return; }
    if (busy === 'shift') {
      p.freqKhz += s.shiftKhz; p.label = (p.label ? p.label + ' ' : '') + `+${s.shiftKhz} kHz`;
      this.log(`${(p.freqKhz / 1000).toFixed(4)} MHz busy — shifted`);
      await this._qsy(p);
      if (this.phase !== 'running') return;
    }
    if (this._skipRequested) { this._skipRequested = false; p.result = 'SKIPPED'; return; }
    // A stored match already covers this frequency: measure it. Good = done;
    // poor = the memory is stale (antenna or feedline changed since), so fall
    // through and let the tuner find a fresh match, which replaces it.
    if (p.usingMem && atuKind(p.atuStatus) === 'matched') {
      const swr = await this._readSwr();
      if (this.phase !== 'running') return;
      p.tunedSwr = swr;
      if (swr != null && swr <= s.swrThreshold) {
        p.result = 'RECALLED';
        this.log(`${p.band} ${p.mode} ${(p.freqKhz / 1000).toFixed(4)} MHz: memory recalled, SWR ${fmt(swr)} → RECALLED`);
        return;
      }
      p.recalledSwr = swr;
      this.log(`${p.band} ${p.mode} ${(p.freqKhz / 1000).toFixed(4)} MHz: memory recalled but SWR ${fmt(swr)} — re-tuning to replace it`);
      await this.sleep(s.pauseMs > 500 ? 500 : s.pauseMs);
      if (this.phase !== 'running') return;
    }
    // Bypass SWR: what the antenna is on its own.
    this.radio.bypass();
    await this.sleep(150);
    p.bypassSwr = await this._readSwr();
    if (this.phase !== 'running') return;
    if (p.bypassSwr != null && p.bypassSwr <= s.nativeMax) {
      p.result = 'NATIVE';
      this.log(`${p.band} ${p.mode} ${(p.freqKhz / 1000).toFixed(4)} MHz: bypass SWR ${fmt(p.bypassSwr)} → NATIVE (no tuner needed)`);
      return;
    }
    // Tune: the radio keys itself for the sweep (so the interlock shows TX
    // that is ours — noteInterlock ignores it while _sweeping).
    const before = this.now();
    this._sweeping = true;
    this.radio.startTune();
    const done = await this._waitAtu((a) => a.at > before && atuKind(a.kv.status) !== 'sweeping' && atuKind(a.kv.status) !== 'idle', s.tuneTimeoutMs);
    this._sweeping = false;
    if (this.phase !== 'running') return;
    if (!done) {
      this.radio.keyTune(false);
      p.result = 'TIMEOUT';
      this.log(`${(p.freqKhz / 1000).toFixed(4)} MHz: no ATU result in ${s.tuneTimeoutMs / 1000} s → TIMEOUT`);
      return;
    }
    p.atuStatus = done.status;
    if (atuKind(done.status) === 'failed') {
      p.result = 'FAILED';
      this.log(`${p.band} ${p.mode} ${(p.freqKhz / 1000).toFixed(4)} MHz: bypass ${fmt(p.bypassSwr)}, ATU ${done.status} → FAILED`);
      return;
    }
    // Verify the match with a short carrier.
    await this.sleep(300);
    p.tunedSwr = await this._readSwr();
    if (this.phase !== 'running') return;
    p.result = classifyPoint({ bypassSwr: p.bypassSwr, tunedSwr: p.tunedSwr, atuStatus: p.atuStatus }, s);
    this.log(`${p.band} ${p.mode} ${(p.freqKhz / 1000).toFixed(4)} MHz: bypass ${fmt(p.bypassSwr)}, tuned ${fmt(p.tunedSwr)}, ${p.atuStatus} → ${p.result}`);
  }

  async _verifyPoint(p) {
    const kv = await this._qsy(p);
    if (this.phase !== 'running') return;
    p.atuStatus = kv ? kv.status || null : null;
    p.usingMem = kv ? String(kv.using_mem) === '1' : false;
    const bypassOk = Number.isFinite(p.bypassSwr) && p.bypassSwr <= this.settings.nativeMax;
    p.result = p.usingMem ? 'RECALLED' : bypassOk ? 'NATIVE' : 'FAILED';
    this.log(`verify ${p.band} ${(p.freqKhz / 1000).toFixed(4)} MHz: using_mem=${p.usingMem ? 1 : 0} → ${p.result}`);
  }

  /** Listen for the dwell; 'go' | 'skip' | 'shift'. */
  async _listen(p) {
    const s = this.settings;
    let peak = null;
    const until = this.now() + s.dwellMs;
    while (this.now() < until) {
      if (!(await this._gate())) return 'skip';
      const dbm = typeof this.radio.signalDbm === 'function' ? this.radio.signalDbm() : null;
      if (Number.isFinite(dbm) && (peak == null || dbm > peak)) peak = dbm;
      await this.sleep(Math.min(100, Math.max(1, until - this.now())));
    }
    this._busyPeak = peak;
    if (peak == null || peak < s.busyDbm) return 'go';
    if (s.busyAction === 'skip') return 'skip';
    if (s.busyAction === 'shift') return 'shift';
    // Ask the operator and wait for the answer.
    this._busyAnswer = 'asking';
    this._push();
    while (this._busyAnswer === 'asking') {
      if (this.phase !== 'running') { this._busyAnswer = null; return 'skip'; }
      await this.sleep(50);
    }
    const a = this._busyAnswer; this._busyAnswer = null; this._push();
    return a;
  }

  /** Key the tune carrier for sampleMs, return the median SWR (or null). */
  async _readSwr() {
    if (this.phase !== 'running') return null;
    this._swrFrames = [];
    this.keyed = true;
    this.radio.keyTune(true);
    this._armKeyWatchdog();
    this._push();
    await this._sleepGated(this.settings.sampleMs);
    const frames = this._swrFrames || [];
    this._unkey('read done');
    return median(frames);
  }
  _armKeyWatchdog() {
    if (this._keyWatchdog) clearTimeout(this._keyWatchdog);
    this._keyWatchdog = setTimeout(() => {
      if (this.keyed) { this.log(`WATCHDOG: carrier up for ${this.settings.keyedMaxMs} ms — unkeying`); this._unkey('watchdog'); this.stop('the carrier watchdog fired'); }
    }, this.settings.keyedMaxMs);
  }
  _unkey(why) {
    if (this._keyWatchdog) { clearTimeout(this._keyWatchdog); this._keyWatchdog = null; }
    this._swrFrames = null;
    if (!this.keyed) return;
    this.keyed = false;
    try { this.radio.keyTune(false); } catch { /* radio gone */ }
    void why;
  }
}

function fmt(v) { return Number.isFinite(v) ? `${v.toFixed(1)}:1` : '—'; }

module.exports = {
  DEFAULTS, MIN_DWELL_MS, BANDS, MODES, SLICE_MODE, LISTEN_FILTER_HZ, NORMAL_PLAN, DENSE_STEP_KHZ, JTTY_KHZ, RESULTS, RESULT_COLOUR, GREEN,
  digitalDials, buildPlan, pointAllowed, segmentsFor, classifyPoint, atuKind, median, summarize, estimateRunMs, trendFlags, adviceFor, csvFor, bandVerdicts,
  AtuWizardRun,
};
