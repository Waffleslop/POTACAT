// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Casey Stanton
//
// WSPR decode bridge — the Apache-2.0 side of the WSPR feature.
//
// LICENSE FIREWALL: The actual WSPR decoder (`wsprd`, GPLv3, by K1JT/K9AN and
// the WSJT Development Group) is NOT linked into POTACAT. It ships as a separate
// standalone executable under third_party/wsprd/ and is invoked here over a
// child process — captured audio goes in as a temp .wav, decode lines come back
// on stdout. That process boundary is "mere aggregation" under the GPL: POTACAT
// stays Apache-2.0; wsprd stays GPLv3; the two coexist without either touching
// the other's license. Do NOT replace this with a native addon / require() of
// wsprd code — that would link GPLv3 into POTACAT and relicense the whole app.
//
// wsprd reads a 2-minute, 12 kHz, mono recording (the same rate the JTCAT engine
// already captures) and prints one line per decode:
//
//   HHMM  SNR  DT   FREQ(MHz)  DRIFT  CALL GRID DBM   [trailing diagnostics...]
//
// e.g.  2148  -7  0.3   7.040030  0  G4ABC IO80 37
//
// parseWsprdOutput() is the pure, testable heart; decodeWspr() does the I/O.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SAMPLE_RATE = 12000;

// Maidenhead 4-char grid: field A-R, field A-R, square 0-9, square 0-9.
const GRID4_RE = /^[A-R][A-R][0-9][0-9]$/;

/**
 * Parse wsprd's stdout into structured spots. PURE — no I/O, fully unit-tested.
 *
 * Each decode line begins with five fixed numeric columns
 *   [0] time HHMM   [1] SNR dB   [2] DT s   [3] freq MHz   [4] drift Hz/min
 * followed by the message. For a standard type-1 message that's
 *   CALL  GRID4  DBM
 * We anchor on the GRID4 token so trailing diagnostic columns (which some wsprd
 * builds append) don't confuse the parse. Compound/hashed (type 2/3) messages
 * have no plain GRID4 — we keep call+raw and leave grid/dBm null.
 *
 * @param {string} stdout  raw wsprd stdout
 * @returns {Array<{timeUtc,snr,dt,freqMHz,drift,call,grid,dBm,message,raw}>}
 */
function parseWsprdOutput(stdout) {
  if (!stdout) return [];
  const spots = [];
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    if (tok.length < 6) continue;

    // Column 1 is a UTC time HHMM when the wav is named YYMMDD_HHMM, but it's
    // the FILENAME STEM when it isn't (e.g. "/dbg", "rx") — so we do NOT key
    // off it. Instead anchor on the 4-char grid and index the fixed columns
    // relative to it:  <t> <snr> <dt> <freq> <drift> <CALL> <GRID> <dBm> [diag]
    const gi = tok.findIndex((t) => GRID4_RE.test(t));
    let call = null, grid = null, dBm = null;
    let snr, dt, freqMHz, drift, time;

    if (gi >= 6 && /^-?\d{1,3}$/.test(tok[gi + 1] || '')) {
      // Standard type-1 message anchored on the grid.
      const d = Number(tok[gi + 1]);
      call = tok[gi - 1];
      grid = tok[gi];
      dBm = (d >= 0 && d <= 60) ? d : null; // valid WSPR dBm range
      snr = Number(tok[gi - 5]);
      dt = Number(tok[gi - 4]);
      freqMHz = Number(tok[gi - 3]);
      drift = Number(tok[gi - 2]);
      time = tok[gi - 6];
    } else {
      // No standard grid (hashed/compound type-2/3) — fall back to the fixed
      // leading 5 numeric columns and keep the lead message token.
      snr = Number(tok[1]); dt = Number(tok[2]);
      freqMHz = Number(tok[3]); drift = Number(tok[4]);
      time = tok[0];
      call = tok[5] || null;
      if (![snr, dt, freqMHz, drift].every(Number.isFinite)) continue;
    }

    if (![snr, dt, freqMHz, drift].every(Number.isFinite)) continue;
    if (freqMHz <= 0 || freqMHz > 30000) continue; // sane HF/VHF MHz guard

    const message = call && grid && dBm != null
      ? `${call} ${grid} ${dBm}`
      : tok.slice(Number.isFinite(Number(tok[0])) ? 5 : 1).join(' ');

    spots.push({
      // timeUtc is a real HHMM only when the wav was timestamp-named; otherwise
      // it's the filename stem and callers should use the cycle clock instead.
      timeUtc: /^\d{3,4}$/.test(time) ? time : null,
      snr, dt, freqMHz, drift, call, grid, dBm, message,
      raw: line,
    });
  }
  return spots;
}

/** wsprd input filename — YYMMDD_HHMM.wav when a capture date is known. */
function wavName(captureDate) {
  if (captureDate instanceof Date && !isNaN(captureDate)) {
    const p2 = (n) => String(n).padStart(2, '0');
    const yy = p2(captureDate.getUTCFullYear() % 100);
    return `${yy}${p2(captureDate.getUTCMonth() + 1)}${p2(captureDate.getUTCDate())}_` +
      `${p2(captureDate.getUTCHours())}${p2(captureDate.getUTCMinutes())}.wav`;
  }
  return 'rx.wav';
}

/** Locate the bundled (or dev-built) wsprd executable. */
function resolveWsprdPath() {
  const exe = process.platform === 'win32' ? 'wsprd.exe' : 'wsprd';
  const candidates = [];
  // Packaged: electron-builder extraResources → resources/bin/wsprd
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', exe));
  }
  // Dev: built in place under third_party/wsprd/
  candidates.push(path.join(__dirname, '..', 'third_party', 'wsprd', 'build', exe));
  candidates.push(path.join(__dirname, '..', 'third_party', 'wsprd', exe));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return null;
}

/** Write mono Float32 samples (−1..1) as a 16-bit PCM WAV at 12 kHz. */
function writeWav(samples, filePath, sampleRate = SAMPLE_RATE) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);           // audio format = PCM
  buf.writeUInt16LE(1, 22);           // channels = 1
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

/**
 * Decode one 2-minute WSPR window. Spawns the bundled GPLv3 wsprd as a separate
 * process (mere aggregation — see file header).
 *
 * @param {Float32Array} samples       ~120 s of 12 kHz mono audio
 * @param {object}   opts
 * @param {number}   opts.dialFreqMHz  USB dial frequency (e.g. 14.0956)
 * @param {Date}    [opts.captureDate] cycle UTC time — names the wav
 *                                     YYMMDD_HHMM so wsprd reports a real time
 * @param {string}  [opts.wsprdPath]   override the resolved binary (tests)
 * @returns {{ok:boolean, spots:Array, error?:string}}
 */
function decodeWspr(samples, opts = {}) {
  const wsprd = opts.wsprdPath || resolveWsprdPath();
  if (!wsprd) {
    return { ok: false, spots: [], error: 'wsprd binary not found (WSPR decoder not installed)' };
  }
  const dial = Number(opts.dialFreqMHz);
  if (!Number.isFinite(dial) || dial <= 0) {
    return { ok: false, spots: [], error: 'invalid dial frequency' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-wspr-'));
  // wsprd derives the reported UTC time from a YYMMDD_HHMM filename; name it so
  // when we have the cycle time, else a plain name (parser handles both).
  const wavPath = path.join(tmpDir, wavName(opts.captureDate));
  try {
    writeWav(samples, wavPath);
    // -f dial(MHz): tells wsprd the band so it reports absolute frequencies.
    // Run in tmpDir so wsprd's ALL_WSPR.TXT/hashtable side-files land there.
    const res = spawnSync(wsprd, ['-f', String(dial), wavPath], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.error) {
      return { ok: false, spots: [], error: `wsprd spawn failed: ${res.error.message}` };
    }
    const spots = parseWsprdOutput(res.stdout || '');
    return { ok: true, spots };
  } catch (e) {
    return { ok: false, spots: [], error: String(e && e.message || e) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { parseWsprdOutput, decodeWspr, resolveWsprdPath, writeWav, SAMPLE_RATE };
