'use strict';
/**
 * RigctldCodec — hamlib rigctld text protocol encoder/decoder.
 * Supports standard rigctld commands and Yaesu raw passthrough.
 *
 * When the rig model is Yaesu brand, commands that hamlib backends handle
 * poorly (NB, RF gain, TX power, ATU) are sent as raw Kenwood commands
 * via the 'w' passthrough. This replaces the old _yaesuRaw flag.
 */
const { EventEmitter } = require('events');
const { normalizeSteps, resolveStep, stepsFromDbList } = require('../rig-gain-steps');

function ssbSideband(freqHz) {
  // 60m (≈5.25–5.45 MHz) is USB by convention/regulation despite being below
  // 10 MHz — channelized band, USB mandated worldwide. Everything else: LSB
  // below 10 MHz, USB at/above.
  if (freqHz >= 5250000 && freqHz < 5450000) return 'USB';
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

// Map POTACAT mode names to rigctld mode tokens
const RIGCTLD_MODES = {
  'CW': 'CW', 'USB': 'USB', 'LSB': 'LSB', 'FM': 'FM', 'AM': 'AM',
  'DIGU': 'PKTUSB', 'DIGL': 'PKTLSB', 'PKTUSB': 'PKTUSB', 'PKTLSB': 'PKTLSB',
  'FT8': 'PKTUSB', 'FT4': 'PKTUSB', 'FT2': 'PKTUSB',
  'RTTY': 'RTTY',
};

// Sensible default passband (Hz) per rigctld mode token. Used when the user
// hasn't configured an explicit filter width in POTACAT Settings. Prevents
// the "rig defaults PKTUSB to 500 Hz" trap on some hamlib backends (Yaesu
// FT991 in particular). An explicit setFilterWidth call from the rig
// controller's tune pipeline overrides this.
function defaultPassbandFor(token) {
  switch (token) {
    case 'PKTUSB':
    case 'PKTLSB':  return 3000;  // FT8/FT4/JS8/PSK need wide
    case 'USB':
    case 'LSB':     return 2400;  // standard SSB
    case 'CW':
    case 'CWR':     return 500;
    case 'RTTY':
    case 'RTTYR':   return 500;
    // AM and FM: send 0 (backend default = wide) so Yaesu rigs don't drop
    // into narrow on every mode change. AB9AI 2026-05-04: switching to AM
    // via ECHOCAT picked the 6 kHz narrow filter (NAR indicator on FTdx3000)
    // because we were sending `M AM 6000`, and the renderer only knew about
    // `AM` so it never showed the PTT button when the rig reported `AMN`
    // back. FT-991/FTDX10/FTdx3000 wide AM is 9 kHz, wide FM is 25 kHz —
    // sending the narrow values forced narrow on every AM/FM tune. Backend
    // default lands the rig in whichever filter it last used or the rig's
    // natural wide bandwidth. Users who want narrow can configure it via
    // Settings → Filter Width or the rig itself.
    case 'AM':      return 0;
    case 'FM':      return 0;
    case 'FMN':     return 15000; // explicit narrow-FM token if mapped
    default:        return 0;     // fall back to backend default
  }
}

// hamlib RPRT code → human meaning. Codes are the negated values of the
// RIG_E* errno constants in include/hamlib/rig.h. Surfacing these as text
// turns "rigctld error: RPRT -20" (which means nothing to a user) into
// "Radio reports it's powered off" (which tells them what to do).
const RPRT_MEANINGS = {
  0: 'OK',
  '-1': 'Invalid argument',
  '-2': 'Configuration error',
  '-3': 'Out of memory',
  '-4': 'Function not implemented',
  '-5': 'Communication timed out — radio not responding (check cable / baud rate / power)',
  '-6': 'I/O error on serial port',
  '-7': 'Internal hamlib error',
  '-8': 'Protocol error — radio reply did not match expected format (wrong rig model?)',
  '-9': 'Command rejected by the radio',
  '-10': 'Reply truncated',
  '-11': 'Function not available on this radio',
  '-12': 'VFO not targetable',
  '-13': 'Bus error',
  '-14': 'Bus is busy',
  '-15': 'Bad argument value',
  '-16': 'VFO error',
  '-17': 'Argument out of range',
  '-18': 'Function deprecated',
  '-19': 'Security restriction',
  '-20': 'Radio reports it is powered off — turn the radio on (or use POTACAT Rig → Power On) and try again',
  '-21': 'Limit exceeded',
  '-22': 'Access denied',
};

function rprtMessage(line) {
  // line is e.g. "RPRT -20" or "RPRT 0"
  const m = (line || '').match(/RPRT\s+(-?\d+)/);
  if (!m) return null;
  return RPRT_MEANINGS[m[1]] || null;
}

// Command → the expectation it will satisfy. rigctld answers strictly in the
// order it received commands, and a query answers with RPRT only when it
// FAILS — so the queue of what we sent is the only way to know which pending
// read an incoming "RPRT -11" is cancelling. Anything not listed (setters,
// raw passthrough, dump_caps) is tracked as 'other': it still consumes a slot
// in the queue, it just clears no read expectation.
const RIGCTLD_QUERY_KINDS = { f: 'freq', m: 'mode', t: 'ptt', v: 'vfo', s: 'split' };
const RIGCTLD_LEVEL_KINDS = {
  STRENGTH: 'smeter', SWR: 'swr', ALC: 'alc', RF: 'rfgain', RFPOWER: 'rfpower',
  PREAMP: 'preamp', ATT: 'att', AGC: 'agc', NR: 'nrlevel', VOXGAIN: 'voxlevel',
  MONITOR_GAIN: 'monlevel', MICGAIN: 'micgain', COMP: 'complevel',
};
const RIGCTLD_FUNC_KINDS = { NB: 'nb', NR: 'nr', COMP: 'comp', VOX: 'vox', ANF: 'anf', TUNER: 'tuner', MON: 'mon', RIT: 'rit' };
// hamlib AGC levels vs app mode strings. wfview's IC-7300 mapping is
// 0/1/2/3 = OFF/FAST/MID/SLOW (GoNoGoTest verified the value range);
// hamlib proper also defines 5=MEDIUM and 6=AUTO — both tolerated on read.
const RIGCTLD_AGC_TO_MODE = { 0: 'off', 1: 'fast', 2: 'mid', 3: 'slow', 4: 'fast', 5: 'mid', 6: 'auto' };
const RIGCTLD_AGC_FROM_MODE = { off: 0, fast: 1, mid: 2, med: 2, slow: 3, auto: 6 };

// Numeric-reply shape acceptors, per query kind. rigctld answers strictly in
// COMMAND ORDER, so the oldest outstanding query whose acceptor matches a
// numeric line is the one it answers (#81: fixed-priority expect flags let
// NB steal SPLIT's 0/1 whenever both were in flight — wfview/IC-7300,
// GoNoGoTest). The acceptor only prunes IMPOSSIBLE pairings, so a lost
// reply degrades to a missed reading instead of a wrong one (the AB9AI
// desync tolerance, kept).
const _BARE01 = (v, line) => /^[01]$/.test(line);
const RIGCTLD_ACCEPTORS = {
  ptt: _BARE01, nb: _BARE01, split: _BARE01,
  nr: _BARE01, comp: _BARE01, vox: _BARE01, anf: _BARE01, tuner: _BARE01,
  mon: _BARE01, rit: _BARE01,
  smeter: (v) => v >= -200 && v <= 100,
  swr: (v) => v >= 0.5 && v <= 100,
  alc: (v) => v >= -0.01 && v <= 1.5,
  agc: (v, line) => /^\d$/.test(line) && v >= 0 && v <= 6,
  nrlevel: (v, line) => line.includes('.') && v >= 0 && v <= 1,
  voxlevel: (v, line) => line.includes('.') && v >= 0 && v <= 1,
  monlevel: (v, line) => line.includes('.') && v >= 0 && v <= 1,
  micgain: (v, line) => line.includes('.') && v >= 0 && v <= 1,
  complevel: (v, line) => line.includes('.') && v >= 0 && v <= 1,
  // hamlib prints float levels with decimals ("0.498039"); an integer 0/1
  // is never an RF/RFPOWER reply, so bare digits can't be stolen from the
  // toggle kinds above.
  rfgain: (v, line) => line.includes('.') && v >= 0 && v <= 1,
  rfpower: (v, line) => line.includes('.') && v >= 0 && v <= 1,
  // Preamp/ATT replies are integer dB ("0", "10", "20").
  preamp: (v, line) => /^\d+$/.test(line) && v >= 0 && v <= 40,
  att: (v, line) => /^\d+$/.test(line) && v >= 0 && v <= 60,
  freq: (v, line) => /^\d+(\.\d+)?$/.test(line) && v > 100000,
};
// Outstanding queries older than this are evicted before attribution — a
// backend that silently drops a reply must not poison the queue forever.
const RIGCTLD_PENDING_TTL_MS = 3000;
// Extended-state readback kinds (#82) — latched off per-connection when the
// backend RPRT-rejects them, so unsupported levels don't burn poll traffic.
const RIGCTLD_EXT_KINDS = new Set(['rfgain', 'rfpower', 'preamp', 'att', 'nr', 'comp', 'vox', 'anf', 'tuner',
  'agc', 'nrlevel', 'voxlevel', 'monlevel', 'micgain', 'complevel', 'mon', 'rit']);
// A poll cycle sends at most ~8 commands. Capping near that keeps any parser
// desync (an unrecognised reply nobody consumes) bounded to about one cycle
// instead of drifting for the life of the connection.
const RIGCTLD_PENDING_MAX = 12;

// Tokens hamlib returns that share the mode branch's shape but are never modes
// (VFO names from `v`/`s`, memory/current-VFO markers). A blocklist rather than
// a mode whitelist on purpose: rig mode vocabularies are open-ended across
// backends (PKTUSB, DATA-U, FREEDV-*, vendor names), so a whitelist would
// eventually refuse a legitimate mode — a worse failure than the one it guards.
const RIGCTLD_NEVER_MODES = /^(VFO[AB]?|MEM|MAIN|SUB|CURRVFO)$/i;

function rigctldPendingKind(line) {
  const parts = String(line || '').trim().split(/\s+/);
  const verb = parts[0];
  if (!verb) return null;
  if (verb === 'l') return RIGCTLD_LEVEL_KINDS[parts[1]] || 'other';
  if (verb === 'u') return RIGCTLD_FUNC_KINDS[parts[1]] || 'other';
  return RIGCTLD_QUERY_KINDS[verb] || 'other';
}

// ATU sequences for Yaesu raw passthrough
// Different Yaesu generations interpret the AC command differently — there's
// no one-size code. If a model's selected variant doesn't work, the user can
// trial-and-error via Settings > Rig > Custom Command and report back so we
// can add the right preset here.
const ATU_SEQUENCES = {
  'ft891': [{ cmd: 'w AC001;\n', delay: 0 }, { cmd: 'w AC002;\n', delay: 300 }],
  'ac002': [{ cmd: 'w AC002;\n', delay: 0 }],
  'ac003': [{ cmd: 'w AC003;\n', delay: 0 }], // FT-710 Tuner Activate — tunes from off or on (baumertjohn #55)
  'ac103': [{ cmd: 'w AC103;\n', delay: 0 }], // FTX-1 Optima (W9JL) — P1=1, P3=3
  'standard': [{ cmd: 'w AC011;\n', delay: 0 }],
};

class RigctldCodec extends EventEmitter {
  /**
   * @param {object} model — rig model entry
   * @param {function} writeFn — writes string to transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model;
    // Every write is recorded so an RPRT can be blamed on the command it
    // actually answers (see _pending / _notePending).
    this._pending = [];
    this._write = (line) => {
      this._notePending(line);
      return writeFn(line);
    };
    this._yaesuRaw = model.brand === 'Yaesu';
    this._atuCmd = model.atuCmd || 'standard';
    this._minPower = model.minPower || 5;
    this._maxPower = model.maxPower || 100;
    this._setPowerCmd = model.commands && model.commands.setPower;
    this._powerMap = model.powerMap || null;
    this._modes = Object.assign({}, RIGCTLD_MODES, model.modes || {});

    // Response parser state
    this._buf = '';
    this._expectPassband = false;
    this._expectNb = false;
    this._expectSmeter = false;
    this._expectPtt = false;
    this._nbUnsupported = false;
    this._pttUnsupported = false;
    this._expectVfo = false;
    this._expectSplit = false;
    this._expectSplitVfo = false;
    // Backends without get_vfo / get_split_vfo (IC-706MKIIG among them) reject
    // `v`/`s` on every poll. Latch them off so the useless traffic stops —
    // it's two of seven commands on a 19200 CI-V link that is already the
    // bottleneck (N4RDX 2026-08-04).
    this._vfoUnsupported = false;
    this._splitUnsupported = false;
    this._lastRprtCode = null;
    this._lastMode = null;
    this._lastFreqHz = 0;

    // Preamp/ATT are hamlib LEVELS in dB, and backends (icom.c at least)
    // require an EXACT match against the rig's caps list — a guessed dB is
    // rejected with RPRT -1. probeCaps() dump_caps-parses the real lists at
    // connect; these are the fallbacks if the probe never answers.
    this._preampDb = 0;      // 0 = unknown → setPreamp falls back to 10
    this._attDb = 0;         // 0 = unknown → setAttenuator falls back to 12
    // The FULL probed ladders. Keeping only the lowest step (which is all
    // _preampDb/_attDb hold) meant a hamlib rig could never reach its higher
    // preamp/ATT positions either — the same ceiling KB2UXB hit on serial
    // (2026-08-04). These feed caps.preampSteps/attSteps so clients can
    // offer the radio's real dB ladder.
    this._preampDbs = [];
    this._attDbs = [];
    this._dumpCapsUntil = 0; // parser is in dump_caps-swallow mode until this ms epoch
    // Last user-initiated command, for RPRT error attribution: a rejection
    // arriving within ~1.5s of a control click almost certainly answers it,
    // and naming the command turns "RPRT -11" into an actionable log line.
    // (K6RBJ spent weeks on controls that failed with no trace, 2026-08-03.)
    this._lastUserCmd = null; // { cmd, ts }
    // Extended readbacks this backend rejected (latched off per-connection).
    this._extUnsupported = new Set();
    // Last logged extended values — extended polls log on CHANGE only, or
    // eight more lines every five seconds would bury the session log.
    this._lastExt = {};
  }

  /**
   * Probe the rig's capability lists via \dump_caps. Called by the
   * controller at connect, BEFORE the safety `T 0` — rigctld answers
   * sequentially, so the `RPRT` that follows the dump (either dump_caps'
   * own terminator or the T 0 reply) deterministically ends swallow mode.
   * A 1.5s timeout backstops rigctld builds that answer neither.
   */
  probeCaps() {
    if (this._yaesuRaw) return; // Yaesu path uses raw passthrough, no levels needed
    this._dumpCapsUntil = Date.now() + 1500;
    this._write('\\dump_caps\n');
  }

  _noteUserCmd(cmd) {
    this._lastUserCmd = { cmd: cmd.trim(), ts: Date.now() };
  }

  // --- Command generation ---

  setFrequency(hz) {
    this._write(`F ${hz}\n`);
  }

  getFrequency() {
    this._write('f\n');
  }

  /**
   * Set mode. Returns the rigctld mode token used.
   *
   * rigctld's `M <mode> <passband>` second argument:
   *   0  = backend default passband
   *   -1 = no change
   *   >0 = explicit Hz
   *
   * We used to send 0 (backend default), but some rigs — notably the Yaesu
   * FT991 via hamlib — default PKTUSB/PKTLSB to 500 Hz, which is useless
   * for FT8/FT4 (needs ~3 kHz). Sending mode-appropriate defaults here
   * gives a sensible RX bandwidth on first mode switch, without forcing
   * users to configure SSB/CW/Digital Filter Width in POTACAT Settings.
   * Users who DO set a POTACAT filter width override this via setFilterWidth
   * after the mode change (the rig-controller tune pipeline calls filter
   * last, so the explicit value wins). (phsdv, FT991, issue #21)
   */
  setMode(modeName, freqHz) {
    let token = this.resolveMode(modeName, freqHz);
    // Preserve the operator's CW / RTTY SIDEBAND. CW-R (= CW-L on Yaesu) and
    // RTTY-R are the operator's choice, not something a spot should override.
    // When they ask for CW and the rig is already in CW-R, re-send CWR — not CW
    // — so the mode-after-freq band-recall resend can't yank the FTDX10 out of
    // CW-L back to CW-U on every CW spot tune (AE4XO 2026-07-24). Only when the
    // rig is currently in the reverse variant; a switch INTO CW from SSB still
    // uses plain CW, and the op flips to CW-R once if they want it.
    if (token === 'CW' && this._lastMode === 'CWR') token = 'CWR';
    else if (token === 'RTTY' && this._lastMode === 'RTTYR') token = 'RTTYR';
    if (token) {
      // Only attach a mode-appropriate passband when the rig actually
      // supports filter adjustment. Sending e.g. "M USB 2400" to an FT-857
      // via hamlib makes the backend reject the whole command with
      // RPRT -1 because that rig has only fixed filters and 2400 isn't in
      // the allowed list — the mode never changes. Falling back to 0
      // (backend default) is universally accepted. Rigs that DO support
      // filter (FT-991, etc.) keep getting the mode-appropriate passband
      // so FT8/FT4 still come up at ~3 kHz.
      const supportsFilter = !!(this._model.caps && this._model.caps.filter);
      const pb = supportsFilter ? defaultPassbandFor(token) : 0;
      this._write(`M ${token} ${pb}\n`);
      this._lastMode = token;
    }
    return token;
  }

  getMode() {
    this._write('m\n');
  }

  resolveMode(modeName, freqHz) {
    let m = (modeName || '').toUpperCase();
    if (m === 'SSB') m = ssbSideband(freqHz);
    return this._modes[m] || RIGCTLD_MODES[m] || null;
  }

  setTransmit(on) {
    const line = on ? 'T 1\n' : 'T 0\n';
    this.emit('log', `PTT write: ${JSON.stringify(line)}`);
    this._write(line);
  }

  /**
   * Query current PTT state. Hamlib returns "0" (RX) or "1" (TX). Used to
   * detect physical-mic / footswitch / external PTT so the SWR / ALC poll
   * (TX-only) can fire even when POTACAT itself didn't issue the keying.
   * AB9AI on FTdx3000 reported smeter still polling and SWR/ALC frozen
   * during physical-mic TX (2026-05-04).
   */
  getPtt() {
    if (this._pttUnsupported) return;
    this._expectPtt = true;
    this._write('t\n');
  }

  setNb(on) {
    if (this._yaesuRaw) {
      this._write(`w NB0${on ? 1 : 0};\n`);
    } else {
      const line = `U NB ${on ? 1 : 0}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  getNb() {
    if (this._nbUnsupported) return;
    this._expectNb = true;
    this._write('u NB\n');
  }

  // Speech processor / VOX — hamlib funcs (U COMP / U VOX). These never
  // existed here, so pre-1.9.22 the desktop comp toggle latched while
  // sending NOTHING to the radio; 1.9.22's loud-refusal then made the tab
  // look dead (N4RDX IC-706MK2G, 2026-08-03). A backend without the func
  // answers RPRT and _noteUserCmd names the failing command in the log.
  // No Yaesu-raw mapping yet (no tester) — return false so the controller
  // refuses loudly instead of latching a lie.
  setCompressor(on) {
    if (this._yaesuRaw) return false;
    const line = `U COMP ${on ? 1 : 0}\n`;
    this._noteUserCmd(line);
    this._write(line);
  }

  setVox(on) {
    if (this._yaesuRaw) return false;
    const line = `U VOX ${on ? 1 : 0}\n`;
    this._noteUserCmd(line);
    this._write(line);
  }

  getSmeter() {
    this._expectSmeter = true;
    this._write('l STRENGTH\n');
  }

  getSwr() {
    this._expectSwr = true;
    this._write('l SWR\n');
  }

  getAlc() {
    this._expectAlc = true;
    this._write('l ALC\n');
  }

  setRfGain(pct) {
    if (this._yaesuRaw) {
      const clamped = Math.max(0, Math.min(255, Math.round(pct * 255)));
      this._write(`w RG0${String(clamped).padStart(3, '0')};\n`);
    } else {
      // hamlib's RF-gain level token is `RF`, not `RFGAIN` — the old token
      // was rejected as an invalid level on every rigctld rig (K6RBJ asked
      // for working RF gain three times before this was diagnosed, 2026-08-03).
      const line = `L RF ${pct.toFixed(3)}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  setSquelch(pct) {
    // pct is a 0.0-1.0 fraction (dispatcher divides the app 0-100 by 100, as
    // for RF gain). Yaesu raw SQ is 000-100 (not 000-255 like RG).
    const frac = Math.max(0, Math.min(1, Number(pct) || 0));
    if (this._yaesuRaw) {
      const clamped = Math.round(frac * 100);
      this._write(`w SQ0${String(clamped).padStart(3, '0')};\n`);
    } else {
      this._write(`L SQL ${frac.toFixed(3)}\n`);
    }
  }

  setTxPower(fraction) {
    if (this._yaesuRaw) {
      const watts = Math.max(this._minPower, Math.min(this._maxPower, Math.round(fraction * this._maxPower)));
      const encoded = this._powerMap && this._powerMap[watts] != null ? this._powerMap[watts] : watts;
      const cmd = this._setPowerCmd
        ? this._setPowerCmd.replace('{val:pad3}', String(encoded).padStart(3, '0')).replace('{val}', String(encoded))
        : `PC${String(encoded).padStart(3, '0')};`;
      this._write(`w ${cmd}\n`);
    } else {
      this._write(`L RFPOWER ${fraction.toFixed(3)}\n`);
    }
  }

  // ── Extended-state readback (#82, GoNoGoTest) ──────────────────────────
  // wfview (and hamlib proper) answer all of these; before this, most rig
  // controls were write-only — a knob turned on the radio/backend never
  // reflected in POTACAT/ECHOCAT. Replies are numeric and attributed by
  // queue order (see RIGCTLD_ACCEPTORS). Each latches off per-connection on
  // an RPRT rejection, so unsupported backends cost one query, not a poll
  // stream. Yaesu-raw passthrough rigs have no hamlib levels — skipped.
  _getExt(kind, query) {
    if (this._yaesuRaw || this._extUnsupported.has(kind)) return;
    this._write(query);
  }

  getPower() { this._getExt('rfpower', 'l RFPOWER\n'); }
  getRfGain() { this._getExt('rfgain', 'l RF\n'); }
  getPreamp() { this._getExt('preamp', 'l PREAMP\n'); }
  getAtt() { this._getExt('att', 'l ATT\n'); }
  getDnrLevel() {
    this._getExt('nr', 'u NR\n');            // on/off -> 'nr'
    this._getExt('nrlevel', 'l NR\n');       // 0..1 level -> 'nrLevel' (round 3)
  }
  getCompressor() { this._getExt('comp', 'u COMP\n'); }
  getVox() { this._getExt('vox', 'u VOX\n'); }
  getAutoNotch() { this._getExt('anf', 'u ANF\n'); }
  // Round 3 (#82 retest): every remaining control GoNoGoTest verified
  // against wfview's rigctld backend — read and write both.
  getAgc() { this._getExt('agc', 'l AGC\n'); }
  getVoxLevel() { this._getExt('voxlevel', 'l VOXGAIN\n'); }
  getMonitor() { this._getExt('mon', 'u MON\n'); }
  getMonLevel() { this._getExt('monlevel', 'l MONITOR_GAIN\n'); }
  getMicGain() { this._getExt('micgain', 'l MICGAIN\n'); }
  getCompLevel() { this._getExt('complevel', 'l COMP\n'); }
  getRit() { this._getExt('rit', 'u RIT\n'); }
  getAtuEnabled() { this._getExt('tuner', 'u TUNER\n'); }

  _setUserLine(line) {
    this._noteUserCmd(line);
    this._write(line);
  }

  setAutoNotch(on) {
    if (this._yaesuRaw) return false;
    this._setUserLine(`U ANF ${on ? 1 : 0}\n`);
  }

  setAgc(mode) {
    if (this._yaesuRaw) return false;
    const v = RIGCTLD_AGC_FROM_MODE[String(mode || '').toLowerCase()];
    if (v == null) return false;
    this._setUserLine(`L AGC ${v}\n`);
  }

  setNrLevel(pct) {
    if (this._yaesuRaw) return false;
    const frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    this._setUserLine(`L NR ${frac.toFixed(3)}\n`);
  }

  setVoxLevel(pct) {
    if (this._yaesuRaw) return false;
    const frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    this._setUserLine(`L VOXGAIN ${frac.toFixed(3)}\n`);
  }

  setMonitor(on) {
    if (this._yaesuRaw) return false;
    this._setUserLine(`U MON ${on ? 1 : 0}\n`);
  }

  setMonLevel(pct) {
    if (this._yaesuRaw) return false;
    const frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    this._setUserLine(`L MONITOR_GAIN ${frac.toFixed(3)}\n`);
  }

  setMicGain(pct) {
    if (this._yaesuRaw) return false;
    const frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    this._setUserLine(`L MICGAIN ${frac.toFixed(3)}\n`);
  }

  setCompLevel(pct) {
    if (this._yaesuRaw) return false;
    const frac = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    this._setUserLine(`L COMP ${frac.toFixed(3)}\n`);
  }

  setRit(on) {
    if (this._yaesuRaw) return false;
    this._setUserLine(`U RIT ${on ? 1 : 0}\n`);
  }

  setFilterWidth(hz) {
    if (!hz) return;
    const mode = this._lastMode || 'USB';
    this._write(`M ${mode} ${hz}\n`);
  }

  setVfo(vfo) {
    this._write(`V VFO${(vfo || 'A').toUpperCase()}\n`);
  }

  /**
   * Poll active VFO + split state (`v` + `s`). hamlib's `f` already returns
   * the CURRENT VFO's frequency, so unlike the Kenwood path this is purely
   * for the indicator/state — the display was never wrong here, just blind.
   * `s` (get_split_vfo) answers TWO lines: split 0/1, then the TX VFO name —
   * both consumed via expect flags BEFORE the mode branch, or "VFOB" would
   * parse as a phantom mode (the ^[A-Z]{2,8}$ trap).
   */
  getVfoSplit() {
    if (!this._vfoUnsupported) {
      this._expectVfo = true;
      this._write('v\n');
    }
    if (!this._splitUnsupported) {
      this._expectSplit = true;
      this._write('s\n');
    }
  }

  swapVfo() {
    // rigctld doesn't have a direct swap — set opposite VFO
  }

  setSplit(on) {
    // rigctld split command: `S <on/off> <tx-vfo>`. VFO token is ignored when
    // disabling, but hamlib requires a placeholder.
    this._write(on ? 'S 1 VFOB\n' : 'S 0 VFOA\n');
  }

  setPowerState(on) {
    const line = `\\set_powerstat ${on ? 1 : 0}\n`;
    this._noteUserCmd(line);
    this._write(line);
  }

  /** Returns ATU sequence for the rig */
  getAtuStartSequence() {
    if (this._yaesuRaw) {
      return ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
    }
    return [{ cmd: 'U TUNER 1\n', delay: 0 }];
  }

  getAtuStopCmd() {
    return this._yaesuRaw ? 'w AC000;\n' : 'U TUNER 0\n';
  }

  startTune() {
    // For Yaesu, use the variant configured for this model rather than a
    // hardcoded AC011 (which doesn't work for FT-891-style or FTX-1-style
    // radios). For non-Yaesu, fall through to the standard rigctld TUNER fn.
    if (this._yaesuRaw) {
      const seq = ATU_SEQUENCES[this._atuCmd] || ATU_SEQUENCES['standard'];
      this.emit('log', `ATU start (variant=${this._atuCmd}): ${seq.map(s => s.cmd.trim()).join(' then ')}`);
      let delay = 0;
      for (const step of seq) {
        delay += step.delay || 0;
        if (delay === 0) this._write(step.cmd);
        else setTimeout(() => this._write(step.cmd), delay);
      }
    } else {
      // U TUNER 1 only ENABLES the inline tuner — it never starts a tune
      // cycle, which is why the one-shot "ATU Tune" did nothing on rigctld
      // rigs (GoNoGoTest, IC-7300/wfview #82 retest). The one-shot is
      // hamlib's vfo_op TUNE (`G TUNE`); enable first so the cycle sticks.
      this.emit('log', 'ATU start: U TUNER 1 + G TUNE (vfo_op tune cycle)');
      this._write('U TUNER 1\n');
      this._setUserLine('G TUNE\n');
    }
  }
  stopTune() {
    const line = this._yaesuRaw ? 'w AC000;\n' : 'U TUNER 0\n';
    this.emit('log', `ATU stop: ${line.trim()}`);
    this._write(line);
  }

  sendCwText(text) {
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-]/g, '');
    const line = `b ${clean}\n`;
    this.emit('log', `CW write: ${JSON.stringify(line)} (${clean.length} chars)`);
    this._write(line);
  }

  setCwSpeed(wpm) {
    const clamped = Math.max(5, Math.min(50, Math.round(wpm)));
    this._write(`L KEYSPD ${clamped}\n`);
  }

  // --- Extended controls ---

  setNbLevel(val) {
    if (this._yaesuRaw) this._write(`w NL0${String(val).padStart(3, '0')};\n`);
    // No standard rigctld equivalent for NB level
  }

  setAfGain(pct) {
    if (this._yaesuRaw) {
      const scaled = Math.max(0, Math.min(255, Math.round(pct * 255)));
      this._write(`w AG0${String(scaled).padStart(3, '0')};\n`);
    } else {
      this._write(`L AF ${pct.toFixed(3)}\n`);
    }
  }

  /**
   * Preamp. `level` is a dB value from the probed ladder (0 = off), or a
   * boolean from a legacy client — `true` means the lowest ON step, which
   * is the old behavior exactly.
   */
  setPreamp(level) {
    if (this._yaesuRaw) {
      // Raw Yaesu passthrough — same P2 ladder the Kenwood codec drives.
      const v = resolveStep(level, normalizeSteps(this._model.preampSteps));
      this._write(`w PA0${v};\n`);
    } else {
      // hamlib has no PREAMP *function* — preamp is a LEVEL in dB (0 = off),
      // and backends exact-match the dB against the rig's caps list, hence
      // the probeCaps() dump at connect. `U PREAMP` was silently rejected on
      // every rigctld rig (K6RBJ IC-7100, 2026-08-03).
      const steps = stepsFromDbList(this._preampDbs);
      const db = steps.length
        ? resolveStep(level, steps)
        : (level ? (this._preampDb || 10) : 0);
      const line = `L PREAMP ${db}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  /** Attenuator — same ladder contract as setPreamp above. */
  setAttenuator(level) {
    if (this._yaesuRaw) {
      const v = resolveStep(level, normalizeSteps(this._model.attSteps));
      this._write(`w RA0${v};\n`);
    } else {
      // Same story as preamp: ATT is a hamlib LEVEL in dB, not a function.
      const steps = stepsFromDbList(this._attDbs);
      const db = steps.length
        ? resolveStep(level, steps)
        : (level ? (this._attDb || 12) : 0);
      const line = `L ATT ${db}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  /**
   * Ladders discovered by probeCaps(), for caps.preampSteps/attSteps. Empty
   * arrays when the probe never answered — clients then fall back to the
   * plain on/off control.
   */
  getGainSteps() {
    return {
      preampSteps: stepsFromDbList(this._preampDbs),
      attSteps: stepsFromDbList(this._attDbs),
    };
  }

  setNoiseReduction(on) {
    if (this._yaesuRaw) {
      this._write(`w NR0${on ? 1 : 0};\n`); // same raw form the Kenwood codec's Yaesu path uses
    } else {
      // NR genuinely IS a hamlib function — it was simply never implemented
      // here, so the controller's typeof guard no-opped it (K6RBJ 2026-08-03).
      const line = `U NR ${on ? 1 : 0}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  setNrLevel(pct) {
    // pct is the app's 0-100 scale (see main.js set-nr-level).
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (this._yaesuRaw) {
      // Yaesu RL: 1..15 depth scale — mirror kenwood-codec's mapping.
      const v = Math.max(1, Math.min(15, Math.round((clamped / 100) * 15)));
      this._write(`w RL0${String(v).padStart(2, '0')};\n`);
    } else {
      const line = `L NR ${(clamped / 100).toFixed(3)}\n`;
      this._noteUserCmd(line);
      this._write(line);
    }
  }

  vfoCopyAB() {
    if (this._yaesuRaw) this._write('w AB;\n');
  }

  vfoCopyBA() {
    if (this._yaesuRaw) this._write('w BA;\n');
  }

  sendRaw(text) {
    const cmd = text.replace(/[\r\n]/g, '').trim();
    if (!cmd) return;
    // Detect space-separated hex bytes (e.g. "FE FE 80 E0 16 22 01 FD")
    // and convert to \x escape sequences for rigctld's w command
    const hexParts = cmd.split(/\s+/);
    const isHex = hexParts.length >= 2 && hexParts.every(p => /^[0-9a-fA-F]{2}$/.test(p));
    if (isHex) {
      const escaped = hexParts.map(h => '\\x' + h.toLowerCase()).join('');
      this._noteUserCmd(`w ${escaped}`);
      this._write(`w ${escaped}\n`);
    } else {
      this._noteUserCmd(`w ${cmd}`);
      this._write(`w ${cmd}\n`);
    }
  }

  // --- Response attribution ---

  /** Record a command so a later reply/RPRT can be attributed to it. */
  _notePending(line) {
    const kind = rigctldPendingKind(line);
    if (!kind) return;
    this._pending.push({ kind, ts: Date.now() });
    while (this._pending.length > RIGCTLD_PENDING_MAX) this._pending.shift();
  }

  /** A value answered this query — drop it from the queue. */
  _resolvePending(kind) {
    const i = this._pending.findIndex((e) => e.kind === kind);
    if (i !== -1) this._pending.splice(i, 1);
  }

  /** Log an extended-state reading only when its value changed. */
  _logExtChange(kind, msg) {
    if (this._lastExt[kind] === msg) return;
    this._lastExt[kind] = msg;
    this.emit('log', msg);
  }

  /** Emit the parsed value for a queue-attributed numeric reply. Mirrors the
   *  legacy expect-flag branches exactly (same scaling, same events) — both
   *  paths funnel here or stay behaviorally identical. */
  _dispatchNumeric(kind, line, v) {
    switch (kind) {
      case 'ptt':
        this._expectPtt = false;
        this.emit('ptt', line === '1');
        return;
      case 'nb':
        this._expectNb = false;
        this.emit('nb', line === '1');
        return;
      case 'split':
        this._expectSplit = false;
        this._expectSplitVfo = true; // TX VFO name follows
        this.emit('split', line === '1');
        return;
      case 'nr': this._logExtChange('nr', `rx: NR=${line}`); this.emit('nr', line === '1'); return;
      case 'comp': this._logExtChange('comp', `rx: COMP=${line}`); this.emit('comp', line === '1'); return;
      case 'vox': this._logExtChange('vox', `rx: VOX=${line}`); this.emit('vox', line === '1'); return;
      case 'anf': this._logExtChange('anf', `rx: ANF=${line}`); this.emit('anf', line === '1'); return;
      case 'tuner': this._logExtChange('tuner', `rx: TUNER=${line}`); this.emit('atu', line === '1'); return;
      case 'mon': this._logExtChange('mon', `rx: MON=${line}`); this.emit('mon', line === '1'); return;
      case 'rit': this._logExtChange('rit', `rx: RIT=${line}`); this.emit('rit', line === '1'); return;
      case 'agc': {
        const mode = RIGCTLD_AGC_TO_MODE[Math.round(v)];
        if (mode) { this._logExtChange('agc', `rx: AGC=${line} -> ${mode}`); this.emit('agc', mode); }
        return;
      }
      case 'nrlevel': {
        const pct = Math.round(v * 100);
        this._logExtChange('nrlevel', `rx: NR level=${pct}%`);
        this.emit('nrLevel', pct);
        return;
      }
      case 'voxlevel': {
        const pct = Math.round(v * 100);
        this._logExtChange('voxlevel', `rx: VOX gain=${pct}%`);
        this.emit('voxLevel', pct);
        return;
      }
      case 'monlevel': {
        const pct = Math.round(v * 100);
        this._logExtChange('monlevel', `rx: MON gain=${pct}%`);
        this.emit('monLevel', pct);
        return;
      }
      case 'micgain': {
        const pct = Math.round(v * 100);
        this._logExtChange('micgain', `rx: MIC gain=${pct}%`);
        this.emit('micGain', pct);
        return;
      }
      case 'complevel': {
        const pct = Math.round(v * 100);
        this._logExtChange('complevel', `rx: COMP level=${pct}%`);
        this.emit('compLevel', pct);
        return;
      }
      case 'smeter': {
        this._expectSmeter = false;
        const val = Math.round(v);
        const scaled = Math.max(0, Math.min(255, Math.round((val + 54) * 255 / 114)));
        this.emit('log', `rx: ${val} -> smeter=${scaled}`);
        this.emit('smeter', scaled);
        return;
      }
      case 'swr': {
        this._expectSwr = false;
        const scaled = Math.max(0, Math.min(255, Math.round((v - 1.0) * 60)));
        this.emit('log', `rx: ${v} -> swr=${scaled}`);
        this.emit('swr', scaled);
        return;
      }
      case 'alc': {
        this._expectAlc = false;
        const scaled = Math.max(0, Math.min(255, Math.round(v * 255)));
        this.emit('log', `rx: ${v} -> alc=${scaled}`);
        this.emit('alc', scaled);
        return;
      }
      case 'rfgain': {
        const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
        this._logExtChange('rfgain', `rx: ${line} -> rfgain=${pct}%`);
        this.emit('rfgain', pct);
        return;
      }
      case 'rfpower': {
        const watts = Math.max(0, Math.round(v * this._maxPower));
        this._logExtChange('rfpower', `rx: ${line} -> power=${watts}W`);
        this.emit('power', watts);
        return;
      }
      case 'preamp': {
        const db = Math.round(v);
        this._logExtChange('preamp', `rx: PREAMP=${db}dB`);
        this.emit('preamp', db > 0);
        this.emit('preampStep', db);
        return;
      }
      case 'att': {
        const db = Math.round(v);
        this._logExtChange('att', `rx: ATT=${db}dB`);
        this.emit('att', db > 0);
        this.emit('attStep', db);
        return;
      }
      case 'freq': {
        const hz = Math.round(v);
        if (hz !== this._lastFreqHz) {
          this.emit('log', `rx: ${hz} -> freq=${(hz / 1000).toFixed(1)}kHz`);
          this._lastFreqHz = hz;
        }
        this.emit('frequency', hz);
        return;
      }
    }
  }

  // --- Response parsing ---

  onData(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      this._parseLine(line);
    }
  }

  _parseLine(line) {
    // dump_caps swallow mode (see probeCaps): consume the capability dump so
    // its free-form lines can't misparse as freq/mode, keeping only the
    // Preamp/Attenuator dB lists. The first RPRT (dump terminator or the
    // T 0 reply queued behind the dump) ends the mode deterministically.
    if (this._dumpCapsUntil) {
      if (/^RPRT\s+-?\d+/.test(line) || Date.now() > this._dumpCapsUntil) {
        this._dumpCapsUntil = 0;
        // The dump's own lines never resolve anything, so the send queue can't
        // be trusted across it. Start attribution fresh — nothing is
        // outstanding at connect anyway.
        this._pending.length = 0;
        if (this._preampDb || this._attDb) {
          this.emit('log', `caps probe: preamp=${this._preampDb || 'n/a'}dB att=${this._attDb || 'n/a'}dB`);
        }
        return; // the RPRT itself belongs to the dump/safety-PTT — consume it
      }
      let m;
      if ((m = line.match(/^Preamp:\s*(.+)$/i))) {
        const dbs = [...m[1].matchAll(/(\d+)\s*dB/gi)].map((x) => parseInt(x[1], 10));
        if (dbs.length) {
          this._preampDb = dbs[0]; // lowest step = safe "on" value
          this._preampDbs = dbs.slice();
        }
      } else if ((m = line.match(/^Attenuator:\s*(.+)$/i))) {
        const dbs = [...m[1].matchAll(/(\d+)\s*dB/gi)].map((x) => parseInt(x[1], 10));
        if (dbs.length) {
          this._attDb = dbs[0];
          this._attDbs = dbs.slice();
        }
      }
      return;
    }

    // Passband after mode response — consume AND surface it (round 3:
    // external filter-width changes never reflected because this line was
    // swallowed), but validate it's actually a passband.
    if (this._expectPassband) {
      this._expectPassband = false;
      if (/^\d+$/.test(line) && parseInt(line, 10) <= 100000) {
        const hz = parseInt(line, 10);
        if (hz > 0) {
          this._logExtChange('passband', `rx: passband=${hz}Hz`);
          this.emit('passband', hz);
        }
        return; // genuine passband
      }
      // Fall through — not a passband (e.g. FLRig omits it)
    }

    // RPRT — the reply to ONE command, so it may clear only that command's
    // expectation. Cancelling every outstanding read (what this used to do)
    // meant a backend that rejects `v` also threw away the STRENGTH reply
    // still in flight behind it: N4RDX's IC-706MKIIG answered RPRT -11 to
    // get_vfo on every poll and his S-meter, SWR and ALC all went dead in
    // v1.9.23, the release that added the VFO/split readback.
    if (/^RPRT\s+-?\d+/.test(line)) {
      const code = parseInt(line.split(/\s+/)[1], 10);
      const entry = this._pending.shift();
      const blame = entry && entry.kind;
      const failed = code !== 0;
      // Extended-state readbacks a backend rejects get latched OFF so the
      // 5-cycle poll stops asking (same economy as the vfo/split latches).
      if (failed && RIGCTLD_EXT_KINDS.has(blame) && !this._extUnsupported.has(blame)) {
        this._extUnsupported.add(blame);
        this.emit('log', `rigctld: this backend has no ${blame} readback — that poll is now off`);
      }
      if (blame === 'nb') {
        this._expectNb = false;
        if (failed) this._nbUnsupported = true;
      } else if (blame === 'ptt') {
        this._expectPtt = false;
        if (failed) this._pttUnsupported = true;
      } else if (blame === 'vfo') {
        this._expectVfo = false;
        if (failed) this._vfoUnsupported = true;
      } else if (blame === 'split') {
        this._expectSplit = false;
        this._expectSplitVfo = false;
        if (failed) this._splitUnsupported = true;
      } else if (blame === 'smeter') {
        this._expectSmeter = false;
      } else if (blame === 'swr') {
        this._expectSwr = false;
      } else if (blame === 'alc') {
        this._expectAlc = false;
      } else if (blame === 'mode') {
        this._expectPassband = false;
      }
      if (failed && (blame === 'vfo' || blame === 'split')) {
        this.emit('log', `rigctld: this backend has no ${blame === 'vfo' ? 'active-VFO' : 'split'} readback — that poll is now off`);
      }
      if (code !== 0) {
        const meaning = RPRT_MEANINGS[String(code)] || 'command not supported or failed';
        // Attribution: a rejection within ~1.5s of a control click almost
        // certainly answers it. Always log those (even a repeated code) and
        // NAME the command — an anonymous "RPRT -11" told K6RBJ nothing for
        // weeks. Unattributed errors (poll noise) keep the on-change dedup.
        const u = this._lastUserCmd;
        if (u && Date.now() - u.ts < 1500) {
          this._lastUserCmd = null; // one attribution per action
          this.emit('log', `rx: ${line} (${meaning}) — likely rejecting "${u.cmd}"`);
        } else if (code !== this._lastRprtCode) {
          this.emit('log', `rx: ${line} (${meaning})`);
        }
      }
      this._lastRprtCode = code;
      return;
    }

    // ── Queue-order attribution for numeric replies (#81) ──────────────
    // rigctld answers strictly in command order, so the OLDEST outstanding
    // query whose shape accepts this value is the one it answers. The
    // fixed-priority expect-flag chain below remains only as the fallback
    // for an empty/evicted queue — it misattributed same-shaped replies
    // (SPLIT's 0/1 consumed as NB when both were in flight).
    if (/^-?\d+(\.\d+)?$/.test(line)) {
      const v = parseFloat(line);
      const now = Date.now();
      while (this._pending.length && now - this._pending[0].ts > RIGCTLD_PENDING_TTL_MS) this._pending.shift();
      for (let i = 0; i < this._pending.length; i++) {
        const kind = this._pending[i].kind;
        const accept = RIGCTLD_ACCEPTORS[kind];
        if (accept && accept(v, line)) {
          this._pending.splice(i, 1);
          this._dispatchNumeric(kind, line, v);
          return;
        }
      }
      // Nothing outstanding accepts it — legacy shape chain below.
    }

    // PTT response: "0" (RX) or "1" (TX) — check before NB since both consume
    // the same shape and polling order is PTT first. Must beat the frequency
    // path so "1" isn't parsed as 1 Hz.
    if (this._expectPtt && /^[01]$/.test(line)) {
      this._expectPtt = false;
      this._resolvePending('ptt');
      this.emit('ptt', line === '1');
      return;
    }

    // NB response: "0" or "1" — check BEFORE frequency to avoid "1" being parsed as 1 Hz
    if (this._expectNb && /^[01]$/.test(line)) {
      this._expectNb = false;
      this._resolvePending('nb');
      this.emit('nb', line === '1');
      return;
    }

    // Active-VFO response ("VFOA"/"VFOB", also "MEM" etc. on some backends) —
    // must be consumed here or it falls into the mode branch as a phantom
    // mode. Checked AFTER ptt/nb so their earlier-commanded 0/1 lines can't
    // be stolen, and order-of-send (v before s) keeps pairings straight.
    if (this._expectVfo && /^(VFO[AB]|MEM|Main|Sub|currVFO)$/i.test(line)) {
      this._expectVfo = false;
      this._resolvePending('vfo');
      const m = line.match(/^VFO([AB])$/i);
      if (m) this.emit('vfo', m[1].toUpperCase());
      return;
    }

    // Split response line 1: "0"/"1". Line 2 (the TX VFO name) follows and
    // must also be consumed so it can't misparse as a mode.
    if (this._expectSplit && /^[01]$/.test(line)) {
      this._expectSplit = false;
      this._resolvePending('split');
      this._expectSplitVfo = true;
      this.emit('split', line === '1');
      return;
    }
    if (this._expectSplitVfo && /^(VFO[AB]|MEM|Main|Sub|currVFO)$/i.test(line)) {
      this._expectSplitVfo = false;
      return; // TX VFO name — consumed, not surfaced
    }

    // S-meter response: hamlib `l STRENGTH` returns dB relative to S9
    // (S9=0, S0=-54, S9+20=+20, S9+60=+60). Map to 0-255 for UI.
    // AB9AI bug: when poll order is freq → mode → smeter, the freq response
    // (e.g. "14250000") arrives while _expectSmeter is true. We must NOT
    // clear the expectation just because this integer is out of S-meter
    // range — the actual S-meter response is still on its way. Just fall
    // through and let the frequency path consume large integers.
    // Decimal-tolerant: wfview (and other rigctld-compatible servers) format
    // numerics as floats ("-40.800000"); hamlib proper sends integers. #77
    if (this._expectSmeter && /^-?\d+(\.\d+)?$/.test(line)) {
      const val = Math.round(parseFloat(line));
      if (val >= -200 && val <= 100) {
        this._expectSmeter = false;
        this._resolvePending('smeter');
        // Map: -54 -> 0 (S0), 0 -> 120 (S9), +60 -> 255 (S9+60)
        const scaled = Math.max(0, Math.min(255, Math.round((val + 54) * 255 / 114)));
        this.emit('log', `rx: ${val} -> smeter=${scaled}`);
        this.emit('smeter', scaled);
        return;
      }
    }

    // SWR response: hamlib `l SWR` returns float ratio (1.0..10.0+).
    // UI expects a 0-255 scale where val/60 + 1 = ratio (val=60 -> 2.0,
    // val=120 -> 3.0). Same out-of-range tolerance as smeter so a freq
    // response in the same poll cycle doesn't strand the expectation.
    if (this._expectSwr && /^-?\d+(\.\d+)?$/.test(line)) {
      const ratio = parseFloat(line);
      if (ratio >= 0.5 && ratio <= 100) {
        this._expectSwr = false;
        this._resolvePending('swr');
        const scaled = Math.max(0, Math.min(255, Math.round((ratio - 1.0) * 60)));
        this.emit('log', `rx: ${ratio} -> swr=${scaled}`);
        this.emit('swr', scaled);
        return;
      }
    }

    // ALC response: hamlib `l ALC` returns float 0.0..1.0.
    // UI expects 0-255 (val/255 = fraction).
    if (this._expectAlc && /^-?\d+(\.\d+)?$/.test(line)) {
      const frac = parseFloat(line);
      if (frac >= -0.01 && frac <= 1.5) {
        this._expectAlc = false;
        this._resolvePending('alc');
        const scaled = Math.max(0, Math.min(255, Math.round(frac * 255)));
        this.emit('log', `rx: ${frac} -> alc=${scaled}`);
        this.emit('alc', scaled);
        return;
      }
    }

    // Frequency: plain number (must be > 100 kHz to be a real frequency).
    // Decimal-tolerant for wfview-style "14242000.000000" responses. #77
    if (/^\d+(\.\d+)?$/.test(line)) {
      const hz = Math.round(parseFloat(line));
      if (!isNaN(hz) && hz > 100000) {
        this._resolvePending('freq');
        if (hz !== this._lastFreqHz) {
          this.emit('log', `rx: ${hz} -> freq=${(hz / 1000).toFixed(1)}kHz`);
          this._lastFreqHz = hz;
        }
        this.emit('frequency', hz);
      }
      return;
    }

    // Mode: uppercase letters 2-8 chars. This pattern is a catch-all, so it is
    // the last line of defence for any uppercase token that fell past its own
    // handler — and a VFO name is exactly that shape. In v1.9.23 an RPRT
    // disarmed the VFO/split expectations and the orphaned `VFOA` landed here
    // as a phantom mode, every poll cycle: the phone's mode chip read "VFOA",
    // and because both clients gate PTT and HALT on a voice-mode whitelist,
    // those buttons vanished a few seconds after connecting while FT8 (which
    // doesn't cross that gate) kept working. LZ3AW IC-7300 on 1.9.23.
    // Attribution (_pending) is what actually fixed it; this refuses the token
    // outright so a future desync degrades to a missed reading rather than to
    // an operator with no PTT button.
    if (/^[A-Z]{2,8}$/.test(line) && !line.startsWith('RPRT')) {
      if (RIGCTLD_NEVER_MODES.test(line)) {
        this.emit('log', `rx: ${line} — VFO/memory name, not a mode; ignored`);
        return;
      }
      this._expectPassband = true;
      this._resolvePending('mode');
      this._lastMode = line;
      this.emit('mode', line);
      this.emit('log', `rx: ${line} -> mode=${line}`);
      return;
    }

    // NB response already handled above (before frequency check)
    // This catches any remaining single-digit responses
    if (this._expectNb && /^[01]$/.test(line)) {
      this._expectNb = false;
      this.emit('nb', line === '1');
      return;
    }
  }

  get lastMode() { return this._lastMode; }
  set lastMode(m) { this._lastMode = m; }

  /** Return the resolved command table for the Table tab UI */
  getCommandTable() {
    const y = this._yaesuRaw;
    const entries = [
      { key: 'getFreq', label: 'Get Frequency', value: 'f' },
      { key: 'setFreq', label: 'Set Frequency', value: 'F {freq}' },
      { key: 'getMode', label: 'Get Mode', value: 'm' },
      { key: 'setMode', label: 'Set Mode', value: 'M {mode} 0' },
      { key: 'setTransmitOn', label: 'PTT On', value: 'T 1' },
      { key: 'setTransmitOff', label: 'PTT Off', value: 'T 0' },
      { key: 'setNbOn', label: 'NB On', value: y ? 'w NB01;' : 'U NB 1' },
      { key: 'setNbOff', label: 'NB Off', value: y ? 'w NB00;' : 'U NB 0' },
      { key: 'getNb', label: 'Get NB', value: 'u NB' },
      { key: 'getSmeter', label: 'S-Meter', value: 'l STRENGTH' },
      { key: 'getSwr', label: 'SWR', value: 'l SWR' },
      { key: 'getAlc', label: 'ALC', value: 'l ALC' },
      { key: 'setRfGain', label: 'RF Gain', value: y ? 'w RG0{val};' : 'L RF {val}' },
      { key: 'setPower', label: 'TX Power', value: y ? 'w PC{val};' : 'L RFPOWER {val}' },
      { key: 'setFilter', label: 'Filter Width', value: 'M {mode} {hz}' },
      { key: 'setVfoA', label: 'VFO A', value: 'V VFOA' },
      { key: 'setVfoB', label: 'VFO B', value: 'V VFOB' },
      { key: 'setSplit', label: 'Split On', value: 'S 1 VFOB' },
      { key: 'setPowerOn', label: 'Power On', value: '\\set_powerstat 1' },
      { key: 'setPowerOff', label: 'Power Off', value: '\\set_powerstat 0' },
    ];
    // ATU
    const atuSeq = this.getAtuStartSequence();
    if (atuSeq && atuSeq.length > 0) {
      const atuStr = atuSeq.map(s => s.cmd.replace(/\n$/, '')).join(' -> ');
      entries.push({ key: 'atuTune', label: 'ATU Tune', value: atuStr });
    }
    // Extended Yaesu controls
    if (y) {
      entries.push({ key: 'setNbLevel', label: 'NB Level', value: 'w NL0{val};' });
      entries.push({ key: 'setAfGain', label: 'AF Gain', value: 'w AG0{val};' });
      entries.push({ key: 'setPreampOn', label: 'Preamp On', value: 'w PA01;' });
      entries.push({ key: 'setPreampOff', label: 'Preamp Off', value: 'w PA00;' });
      entries.push({ key: 'setAttenuatorOn', label: 'Atten On', value: 'w RA01;' });
      entries.push({ key: 'setAttenuatorOff', label: 'Atten Off', value: 'w RA00;' });
      entries.push({ key: 'setNrOn', label: 'NR On', value: 'w NR01;' });
      entries.push({ key: 'setNrOff', label: 'NR Off', value: 'w NR00;' });
      entries.push({ key: 'vfoCopyAB', label: 'VFO Copy A->B', value: 'w AB;' });
      entries.push({ key: 'vfoCopyBA', label: 'VFO Copy B->A', value: 'w BA;' });
    } else {
      const pre = this._preampDb || 10;
      const att = this._attDb || 12;
      entries.push({ key: 'setAfGain', label: 'AF Gain', value: 'L AF {val}' });
      entries.push({ key: 'setPreampOn', label: 'Preamp On', value: `L PREAMP ${pre}` });
      entries.push({ key: 'setPreampOff', label: 'Preamp Off', value: 'L PREAMP 0' });
      entries.push({ key: 'setAttenuatorOn', label: 'Atten On', value: `L ATT ${att}` });
      entries.push({ key: 'setAttenuatorOff', label: 'Atten Off', value: 'L ATT 0' });
      entries.push({ key: 'setNrOn', label: 'NR On', value: 'U NR 1' });
      entries.push({ key: 'setNrOff', label: 'NR Off', value: 'U NR 0' });
      entries.push({ key: 'setNrLevel', label: 'NR Level', value: 'L NR {val}' });
    }
    return entries;
  }
}

module.exports = { RigctldCodec, RPRT_MEANINGS, rprtMessage };
