// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// A picture sent from ECHOCAT (the phone app or ECHOCAT Web), from the moment
// it arrives to the moment the radio keys (GitHub #357, NA4DQ 2026-11-11).
//
//   1. The picture is copied before it goes to the encoder. The encoder hands
//      its pixels to a worker thread, which empties the array it was given;
//      the copy shown in the SSTV window 1.5 s later was read from that empty
//      array and POTACAT closed with "detached ArrayBuffer".
//   2. A failure on the way is a status line, in the SSTV window and on the
//      phone (sstv-tx-status `error`), never a dialog box that holds the whole
//      app until someone clicks it at the shack.
//   3. The radio is tuned to the SSTV frequency before the picture is sent.
//      The SSTV window tuned it only after it opened, and the picture keyed
//      first, on the old Winlink frequency, and was refused.
//
// Pure decisions only; main.js holds the radio, the engine and the windows.
'use strict';

const { freqToBand } = require('./bands');
const { ssbSideband } = require('./ssb-sideband');
const RigBands = require('./rig-bands');
const SstvStartBand = require('./sstv-start-band');

// The SSTV channels on each band, as in the SSTV window's frequency list. The
// first one is where a picture goes when the radio is elsewhere on that band.
const CHANNELS_KHZ = {
  '80m': [3845, 3730],
  '40m': [7171, 7165],
  '20m': [14230, 14227, 14233],
  '17m': [18161],
  '15m': [21340],
  '12m': [24975],
  '10m': [28680],
  '6m': [50680],
};
// A radio this close to an SSTV channel (or to the one the phone chose) is
// taken to be on SSTV on purpose (14.240 when 14.230 is busy) and is not moved.
const NEAR_CHANNEL_HZ = 10000;

function khzText(khz) {
  return (Number(khz) / 1000).toFixed(3) + ' MHz';
}

function nearChannel(band, radioHz) {
  const list = CHANNELS_KHZ[band];
  if (!list || !(radioHz > 0)) return false;
  return list.some((k) => Math.abs(radioHz - k * 1000) <= NEAR_CHANNEL_HZ);
}

/**
 * Where the radio must be before a picture from ECHOCAT is sent.
 *   radioHz       the radio's dial now (0 = not known)
 *   requestedKhz  the SSTV frequency chosen on the phone, when it said one;
 *                 a radio within NEAR_CHANNEL_HZ of it stays where it is
 *   bands         the radio's bands (lib/rig-bands.js; null = not restricted)
 *   daytime       for a radio off every SSTV band: 20 m by day, 40 m by night
 *   split         split is on: the dial is not the transmit frequency
 * Returns { act: 'stay' } or { act: 'tune', freqKhz, mode }, and `why` (a log
 * line) when the radio stays somewhere a picture may be refused.
 */
function sendChannel({ radioHz = 0, requestedKhz, bands = null, daytime = true, split = false } = {}) {
  const hz = Number(radioHz) || 0;
  if (split) return { act: 'stay', why: 'split is on, so the radio was not tuned for the picture' };
  const req = Number(requestedKhz);
  if (Number.isFinite(req) && req > 0) {
    const band = freqToBand(req / 1000);
    if (band && !RigBands.allowed(bands, band)) {
      return { act: 'stay', why: `${khzText(req)} is on ${band}, and this radio is not set up for ${band}, so it was not tuned` };
    }
    if (hz > 0 && Math.abs(hz - req * 1000) <= NEAR_CHANNEL_HZ) return { act: 'stay' };
    return { act: 'tune', freqKhz: req, mode: ssbSideband(req * 1000) };
  }
  const band = hz > 0 ? freqToBand(hz / 1e6) : null;
  if (band && nearChannel(band, hz)) return { act: 'stay' };
  if (band && CHANNELS_KHZ[band] && RigBands.allowed(bands, band)) {
    const k = CHANNELS_KHZ[band][0];
    return { act: 'tune', freqKhz: k, mode: ssbSideband(k * 1000) };
  }
  const ch = SstvStartBand.autoChannel(bands, daytime);
  if (!ch) return { act: 'stay', why: SstvStartBand.NO_BAND_NOTE };
  return { act: 'tune', freqKhz: ch.freqKhz, mode: ch.mode };
}

/**
 * The picture's own copy of the pixels. The encoder transfers what it is given
 * to its worker thread, which leaves the given array empty (detached); the
 * caller keeps the original for the SSTV window.
 */
function ownCopy(pixels) {
  // An array already transferred to a worker reads as empty: nothing to copy.
  if (!pixels || !(pixels.length > 0)) throw new TypeError('the picture is empty');
  return new Uint8ClampedArray(pixels);
}

/** The status line for a failure: short, plain, one line. */
function failText(err, lead = 'Picture not sent') {
  const raw = err && err.message ? err.message : String(err || 'it failed');
  const one = raw.split(/\r?\n/)[0].trim().replace(/[.\s]+$/, '');
  return `${lead}: ${one.length > 160 ? one.slice(0, 157) + '...' : one}.`;
}

/**
 * Wrap a step of the send so a throw becomes onError(err) instead of an
 * uncaught exception (which closes POTACAT with a dialog box). Returns what fn
 * returns; undefined after a failure.
 */
function guard(fn, onError) {
  return function guarded(...args) {
    try {
      return fn.apply(this, args);
    } catch (err) {
      try { onError(err); } catch { /* the report must never throw */ }
      return undefined;
    }
  };
}

/** The sstv-tx-status a client gets after a picture was not sent. */
function notSentStatus({ autoActive = false, error } = {}) {
  const s = { state: autoActive ? 'auto-rx' : 'rx' };
  if (error) s.error = String(error);
  return s;
}

module.exports = { CHANNELS_KHZ, NEAR_CHANNEL_HZ, sendChannel, ownCopy, failText, guard, notSentStatus };
