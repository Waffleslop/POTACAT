'use strict';
/**
 * FreeDV lines for the session log (#717), so Report a Bug shows whether audio
 * reached the decoder and whether it synced. Diagnostics only: it watches,
 * it changes nothing.
 *
 * - The first RX audio block, with its peak level (all-zero flagged).
 * - Sync gained and sync lost, with the SNR. A flapping decoder is held to one
 *   line per SYNC_LINE_MS; the flaps in between are counted in the next summary.
 * - A summary every SUMMARY_MS while running: audio blocks in, decoded speech
 *   blocks out, sync yes/no, the SNR and the input peak.
 *
 * Every method returns the line to log, or null. Pure: the caller passes the
 * clock and does the logging (main.js sendCatLog).
 */

const SUMMARY_MS = 30000;
const SYNC_LINE_MS = 5000;

function peakOf(samples) {
  let peak = 0;
  if (!samples) return 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

const fmtSnr = (snr) => (typeof snr === 'number' && isFinite(snr) ? snr.toFixed(1) + ' dB' : 'n/a');
const fmtPeak = (peak) => (peak / 32768 * 100).toFixed(1) + '%';

class FreedvDiag {
  constructor(now) {
    this.reset(now);
  }

  reset(now) {
    this._started = now || 0;
    this._lastSummary = now || 0;
    this._audioIn = 0;
    this._audioTotal = 0;
    this._peak = 0;
    this._speechOut = 0;
    this._sync = false;
    this._snr = null;
    this._everSynced = false;
    this._lastSyncLineAt = -Infinity;
    this._loggedSync = false;  // the sync state the log last said
    this._flaps = 0;
  }

  /** An RX audio block reached the engine. */
  audio(samples) {
    this._audioIn++;
    this._audioTotal++;
    const peak = peakOf(samples);
    if (peak > this._peak) this._peak = peak;
    if (this._audioTotal === 1) {
      const n = samples ? samples.length : 0;
      return peak === 0
        ? `[FreeDV] First RX audio: ${n} samples, ALL ZERO (no signal from the input device)`
        : `[FreeDV] First RX audio: ${n} samples, peak ${fmtPeak(peak)}`;
    }
    return null;
  }

  /** The engine passed a block of decoded speech on to the speaker. */
  speech() { this._speechOut++; }

  /** A sync/SNR report from the engine (about 10 a second). */
  sync(data, now) {
    const synced = !!(data && data.sync);
    this._snr = data ? data.snr : null;
    const changed = synced !== this._sync;
    this._sync = synced;
    if (synced === this._loggedSync) return null; // nothing new, or a flap back before the line went out
    // Too soon after the last line: count the flap; the reports keep coming,
    // so a state that holds is logged once the window has passed.
    if (now - this._lastSyncLineAt < SYNC_LINE_MS) { if (changed) this._flaps++; return null; }
    this._lastSyncLineAt = now;
    this._loggedSync = synced;
    if (synced) {
      const first = !this._everSynced;
      this._everSynced = true;
      return `[FreeDV] Sync ${first ? 'achieved' : 'regained'}, SNR ${fmtSnr(this._snr)}`;
    }
    return `[FreeDV] Sync lost, SNR ${fmtSnr(this._snr)}`;
  }

  /** The 30-second summary when it is due, else null. */
  tick(now) {
    if (now - this._lastSummary < SUMMARY_MS) return null;
    const secs = Math.round((now - this._lastSummary) / 1000);
    const flaps = this._flaps ? `, sync changed ${this._flaps} more times` : '';
    const level = this._audioIn === 0 ? 'no input' : this._peak === 0 ? 'input ALL ZERO' : `input peak ${fmtPeak(this._peak)}`;
    const line = `[FreeDV] Last ${secs} s: ${this._audioIn} audio blocks in (${level}), ${this._speechOut} speech blocks out, sync ${this._sync ? 'yes' : 'no'}, SNR ${fmtSnr(this._snr)}${flaps}`;
    this._lastSummary = now;
    this._audioIn = 0;
    this._speechOut = 0;
    this._peak = 0;
    this._flaps = 0;
    return line;
  }
}

module.exports = { FreedvDiag, peakOf, SUMMARY_MS, SYNC_LINE_MS };
