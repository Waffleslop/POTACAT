'use strict';
/**
 * A Flex's own status lines → the rig-state fields every surface shows
 * (Casey 2026-10-28, via the phone session: on Flex Direct only frequency,
 * mode, AGC, power and WNB came from the radio; every other control showed
 * what POTACAT last SENT, so a change on the radio, in SmartSDR, or made
 * before POTACAT started read blank or wrong).
 *
 * Pure. Each function takes the MERGED key=value picture of one status object
 * (a status line can be partial: filter_lo without filter_hi) and returns only
 * the fields it can state. Key names are the FLEX-8600 v4's, from a live
 * capture (test/fixtures/flex-pan/8600-status.txt) — e.g. the transmit block
 * reports the SSB monitor as sb_monitor / mon_gain_sb, not mon / mon_gain.
 */

const bool = (v) => (v === '1' ? true : v === '0' ? false : undefined);
const int = (v) => {
  if (v == null || v === '') return undefined;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : undefined;
};
const pct = (v) => { const n = int(v); return n === undefined ? undefined : Math.max(0, Math.min(100, n)); };

function put(out, key, v) { if (v !== undefined) out[key] = v; }

/** Our slice: `slice N nb=0 nb_level=50 ...`. */
function sliceReadback(kv) {
  const k = kv || {};
  const out = {};
  put(out, 'nb', bool(k.nb));
  put(out, 'nbLevel', pct(k.nb_level));
  put(out, 'nr', bool(k.nr));
  put(out, 'nrLevel', pct(k.nr_level));
  put(out, 'anf', bool(k.anf));
  put(out, 'apf', bool(k.apf));
  put(out, 'nrl', bool(k.nrl));
  put(out, 'nrlLevel', pct(k.nrl_level));
  put(out, 'nrs', bool(k.nrs));
  put(out, 'nrsLevel', pct(k.nrs_level));
  put(out, 'nrf', bool(k.nrf));
  put(out, 'nrfLevel', pct(k.nrf_level));
  put(out, 'rnn', bool(k.rnn));
  put(out, 'rit', bool(k.rit_on));
  put(out, 'afGain', pct(k.audio_level));
  // Width is the passband whatever the mode: LSB reports -2800..-100.
  const lo = int(k.filter_lo), hi = int(k.filter_hi);
  if (lo !== undefined && hi !== undefined && hi > lo) out.filterWidth = hi - lo;
  // The squelch slider is one number: its level while armed, 0 while off.
  const sq = bool(k.squelch);
  if (sq === false) out.squelch = 0;
  else if (sq === true) put(out, 'squelch', pct(k.squelch_level));
  // POTACAT's antenna port is 1 or 2; RX_A / XVTA have no place on it.
  const ant = /^ANT([12])$/.exec(String(k.rxant || ''));
  if (ant) out.antennaPort = Number(ant[1]);
  return out;
}

/** The transmit block: `transmit compander=0 vox_enable=1 sb_monitor=0 ...`. */
function transmitReadback(kv) {
  const k = kv || {};
  const out = {};
  put(out, 'comp', bool(k.compander));
  put(out, 'compLevel', pct(k.compander_level));
  put(out, 'vox', bool(k.vox_enable));
  put(out, 'voxLevel', pct(k.vox_level));
  put(out, 'mon', bool(k.sb_monitor));
  put(out, 'monLevel', pct(k.mon_gain_sb));
  put(out, 'micGain', pct(k.mic_level));
  return out;
}

/** Our pan: `display pan 0x... rfgain=8 pre=+8dB`. The RF gain slider is the
 *  dispatcher's 0-100 over -10..+20 dB (dB = value * 0.3 - 10). */
function panReadback(kv) {
  const k = kv || {};
  const out = {};
  const db = int(k.rfgain);
  if (db !== undefined) {
    out.rfgainDb = db;
    out.rfGain = Math.max(0, Math.min(100, Math.round((db + 10) / 0.3)));
  }
  return out;
}

/** `atu status=TUNE_SUCCESSFUL atu_enabled=1`: the tuner is IN LINE when it
 *  holds a match, out when bypassed, failed or switched off; mid-tune says
 *  nothing. atu_enabled alone is only the option being present. */
const ATU_IN = new Set(['TUNE_SUCCESSFUL', 'TUNE_OK']);
const ATU_OUT = /BYPASS|ABORTED|NOT_STARTED|FAIL/;
function atuReadback(kv) {
  const k = kv || {};
  if (k.atu_enabled === '0') return { atuActive: false };
  const s = String(k.status || '');
  if (ATU_IN.has(s)) return { atuActive: true };
  if (s && ATU_OUT.test(s)) return { atuActive: false };
  return {};
}

module.exports = { sliceReadback, transmitReadback, panReadback, atuReadback };
