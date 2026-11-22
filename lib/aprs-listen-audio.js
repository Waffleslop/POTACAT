// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS "Listen on my radio": one log line a minute about the audio Dire Wolf
// actually gets, so "no packets" can be told apart from "no audio" (on air
// 2026-11-20 an hour of 30 m listening said nothing either way).
//
// The numbers come from the modem audio lane (lib/modem-audio-lane.js): its
// stats message every 250 ms carries socketRxSamples (the samples written to
// Dire Wolf's audio socket, cumulative until a meter reset) and rxPeak (the
// largest absolute sample written since the last stats message,
// lib/modem-audio-server.js takeRxPeak). Frames are counted by main as
// Dire Wolf's AGW monitor hands them over.
//
// Pure: the caller feeds stats, frames and the clock.

'use strict';

const MINUTE_MS = 60000;
/** Below this the audio is silence: nothing is reaching Dire Wolf from the radio. */
const SILENT_DBFS = -90;

/** A linear peak (1.0 = full scale) in dBFS; -Infinity for none. */
function peakDbfs(peak) {
  const p = Number(peak);
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

function framesText(n) {
  const f = Number(n) || 0;
  return f + (f === 1 ? ' frame' : ' frames') + ' decoded this minute';
}

/**
 * The one line (aprsLog adds "[APRS] "):
 *   "listening on 10.1476 MHz: audio peak -23 dBFS, 4 frames decoded this minute"
 *   "listening on 10.1476 MHz: no audio reaching Dire Wolf (no samples this minute), 0 frames decoded this minute"
 *   "listening on 10.1476 MHz: no audio reaching Dire Wolf (peak below -90 dBFS), 0 frames decoded this minute"
 */
function audioLevelLine({ mhz = '', samples = 0, peak = 0, frames = 0 } = {}) {
  const head = 'listening on ' + (mhz ? mhz + ' MHz' : 'the APRS frequency') + ': ';
  if (!(Number(samples) > 0)) return head + 'no audio reaching Dire Wolf (no samples this minute), ' + framesText(frames);
  const db = peakDbfs(peak);
  if (!(db >= SILENT_DBFS)) return head + 'no audio reaching Dire Wolf (peak below ' + SILENT_DBFS + ' dBFS), ' + framesText(frames);
  return head + 'audio peak ' + Math.min(0, Math.round(db)) + ' dBFS, ' + framesText(frames);
}

/**
 * The minute's tally. start() when listening starts; noteStats() on every lane
 * stats message; noteFrame() for every frame Dire Wolf hands over; due() on a
 * timer: the line once a whole minute has passed, else ''.
 */
function createAudioMinute({ now = Date.now } = {}) {
  let startedAt = 0;
  let samples = 0;
  let peak = 0;
  let frames = 0;
  let lastCum = -1; // the lane's cumulative count at the last stats message (-1: none yet)

  function reset(t) { startedAt = t; samples = 0; peak = 0; frames = 0; }

  return {
    start() { reset(now()); lastCum = -1; },
    running() { return startedAt > 0; },
    stop() { startedAt = 0; },
    noteStats(d) {
      if (!d) return;
      const cum = Number(d.socketRxSamples);
      if (isFinite(cum) && cum >= 0) {
        // A meter reset (a Winlink session) or a new lane starts the count again.
        if (lastCum >= 0) samples += cum >= lastCum ? cum - lastCum : cum;
        lastCum = cum;
      }
      const p = Number(d.rxPeak);
      if (p > peak) peak = p;
    },
    noteFrame() { frames++; },
    due({ mhz = '' } = {}) {
      if (!startedAt) return '';
      const t = now();
      if (t - startedAt < MINUTE_MS) return '';
      const line = audioLevelLine({ mhz, samples, peak, frames });
      reset(t);
      return line;
    },
  };
}

module.exports = { MINUTE_MS, SILENT_DBFS, peakDbfs, audioLevelLine, createAudioMinute };
