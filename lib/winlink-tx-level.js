// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink's own transmit audio level, and what a session's audio levels were
// (GitHub #300).
//
// Before: the modem's transmit audio on a sound-card rig went out at JTCAT's
// "Drive" slider (settings.jtcatTxGain), which nobody would look for from the
// Winlink window, and the per-over log line said "peak 0 dBFS" every time:
// that is measured before the level is applied, so it could not tell an
// over-driven radio from a quiet one. An IC-7100 on 2 m packet had the
// gateway answer our short frames and reject the long ones, every over
// "peak 0 dBFS".
//
// Now: Winlink has a "TX level" of its own (settings.winlinkTxGain), in the
// same square-curve domain as every audio slider (gain = (pct/100)^2). An
// operator who never set it keeps exactly what Winlink used before: the
// JTCAT drive at the moment of upgrade. The session summary says what left
// POTACAT for the radio after that level, and says in plain words when it
// was at full scale.
//
// Pure: no Electron, no I/O.

'use strict';

const FULL_SCALE_DBFS = -0.5;   // at or above this, an over left POTACAT at full scale
const SETTING_LABEL = 'TX level';
const SETTING_WHERE = 'the Winlink window (next to Power)';

function _clamp01(v) { return Math.max(0, Math.min(1, v)); }
function _num(v) { return typeof v === 'number' && Number.isFinite(v); }
function _r1(v) { return Math.round(v * 10) / 10; }

/** Slider percent (0-100) to gain, the square curve every audio slider uses. */
function gainFromPct(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  return p * p;
}
/** Gain to slider percent. */
function pctFromGain(gain) {
  return Math.round(Math.sqrt(_clamp01(Number(gain) || 0)) * 100);
}
/** Linear peak (0-1) to dBFS, or null for silence. */
function dbfs(peak) {
  return peak > 0 ? _r1(20 * Math.log10(peak)) : null;
}

/**
 * The Winlink transmit gain in force: its own setting; for an operator who
 * never set it, the JTCAT drive (what Winlink used before #300); else `fallback`.
 */
function resolveTxGain(settings, fallback = 1) {
  const s = settings || {};
  if (_num(s.winlinkTxGain)) return _clamp01(s.winlinkTxGain);
  if (_num(s.jtcatTxGain)) return _clamp01(s.jtcatTxGain);
  return _clamp01(_num(fallback) ? fallback : 1);
}

/**
 * Once, at load: an operator with no Winlink level of their own gets the one
 * Winlink used until now, written down, so a later JTCAT Drive change no
 * longer moves Winlink. True when the setting was written.
 */
function seedTxGain(settings, fallback = 1) {
  if (!settings || _num(settings.winlinkTxGain)) return false;
  settings.winlinkTxGain = resolveTxGain(settings, fallback);
  return true;
}

/**
 * What one over sent towards the radio, in dBFS. `peakDbfs` is the modem's
 * own peak (lib/modem-tx-burst.js), `gainDb` the transmit leveler's trim
 * (which never goes past full scale), `txGain` the Winlink TX level. On Flex
 * Direct and Icom Network (`soundCard` false) the TX level is not applied:
 * full scale there IS the set RF power.
 */
function overOutDbfs({ peakDbfs, gainDb = 0, txGain = 1, soundCard = true } = {}) {
  if (!_num(peakDbfs)) return null;
  let d = Math.min(0, peakDbfs + (_num(gainDb) ? gainDb : 0));
  if (soundCard) {
    const g = _clamp01(_num(txGain) ? txGain : 1);
    if (!(g > 0)) return null; // silent
    d += 20 * Math.log10(g);
  }
  return _r1(d);
}

/**
 * The session's levels, for its summary line: the loudest the radio was into
 * the modem (outside our own overs), and what our overs sent to the radio.
 */
class SessionLevels {
  constructor() { this.reset(); }

  reset() {
    this.rxPeak = 0;
    this.overs = 0;
    this.fullScale = 0;
    this.outMax = null;
    this.txGain = null;
    this.soundCard = true;
  }

  /** A block of the radio's receive audio: its linear peak (0-1). */
  noteRx(peak) {
    const p = Number(peak);
    if (p > this.rxPeak) this.rxPeak = p;
  }

  /** One finished over: the burst summary's numbers and the level it went out at. */
  noteOver({ peakDbfs, gainDb, txGain, soundCard = true } = {}) {
    const out = overOutDbfs({ peakDbfs, gainDb, txGain, soundCard });
    this.soundCard = !!soundCard;
    if (_num(txGain)) this.txGain = _clamp01(txGain);
    if (out == null) return;
    this.overs++;
    if (out >= FULL_SCALE_DBFS) this.fullScale++;
    if (this.outMax == null || out > this.outMax) this.outMax = out;
  }

  /** "levels: ..." for the summary line, always present for a radio session. */
  text() {
    const rx = dbfs(this.rxPeak);
    const parts = [`radio to modem peak ${rx == null ? 'silent (no audio heard)' : `${rx} dBFS${rx >= FULL_SCALE_DBFS ? ' (clipped)' : ''}`}`];
    if (!this.overs) parts.push('modem to radio: no over measured');
    else if (!this.soundCard) parts.push(`modem to radio peak ${this.outMax} dBFS over ${this.overs} over${this.overs === 1 ? '' : 's'} (network audio: full scale is the set RF power)`);
    else {
      const lvl = this.txGain != null ? ` at ${SETTING_LABEL} ${pctFromGain(this.txGain)}%` : '';
      parts.push(`modem to radio peak ${this.outMax} dBFS${lvl} over ${this.overs} over${this.overs === 1 ? '' : 's'}`);
    }
    return parts.join(', ');
  }

  /**
   * The plain-words warning when our transmit audio reached full scale on a
   * sound card, naming the setting to turn down; '' otherwise.
   */
  advice() {
    if (!this.soundCard || !this.fullScale) return '';
    return `our transmit audio reached full scale (0 dBFS) on ${this.fullScale} of ${this.overs} over${this.overs === 1 ? '' : 's'}, which can over-drive the radio and garble long frames: turn down "${SETTING_LABEL}" in ${SETTING_WHERE} to about 50% and watch the radio's ALC`;
  }
}

module.exports = { FULL_SCALE_DBFS, SETTING_LABEL, SETTING_WHERE, gainFromPct, pctFromGain, dbfs, resolveTxGain, seedTxGain, overOutDbfs, SessionLevels };
