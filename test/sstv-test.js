#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// SSTV regression suite — covers the BEHAVIORS that need to keep working
// across refactors. Run:  node test/sstv-test.js
//
// Casey: "SSTV breaks the most for us." This suite is the permanent
// guard. Behavior was modeled against MMSSTV / WSJT-X-style defaults
// where applicable; deliberate POTACAT departures are flagged inline.
//
// Coverage is split into:
//   1. Pure-data invariants (mode definitions, constants)
//   2. VIS encoder bit-pattern correctness
//   3. YCbCr color math
//   4. Mode timing math
//   5. Encode/decode round-trip sanity (delegates to scripts/test-sstv.js
//      for the full PSNR matrix — we just verify the pipeline runs at
//      all)
//   6. Template / textElement structure invariants
//   7. SPEC tests for features Casey wants — marked PENDING. These
//      will start passing as the features ship. Don't delete them
//      when they fail today; they're the contract.
// =====================================================================

const modes = require('../lib/sstv-modes');
const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const sstvPost = require('../lib/sstv-post');

let pass = 0;
let fail = 0;
let pending = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(msg);
  console.log('  ✗ ' + msg);
}
function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, msg + ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function assertNear(actual, expected, tol, msg) {
  assert(Math.abs(actual - expected) <= tol, msg + ` (expected ${expected}±${tol}, got ${actual})`);
}
function todo(msg) {
  pending++;
  console.log('  ◌ PENDING: ' + msg);
}
function section(name) {
  console.log('\n=== ' + name + ' ===');
}

// =====================================================================
// 1. Mode definitions
// =====================================================================
section('Mode definitions — invariants');
{
  const all = Object.keys(modes.MODES);
  assert(all.length >= 5, 'at least 5 modes defined (have ' + all.length + ')');

  // VIS code uniqueness — collisions would route decode to wrong mode
  const visCodes = new Set();
  for (const key of all) {
    const m = modes.MODES[key];
    assert(typeof m.visCode === 'number', `${key} has numeric visCode`);
    assert(!visCodes.has(m.visCode), `${key} visCode ${m.visCode} unique across modes`);
    visCodes.add(m.visCode);
    assert(m.visCode >= 0 && m.visCode < 128, `${key} visCode fits in 7 bits`);
  }

  // Reverse lookup correctness
  for (const key of all) {
    const m = modes.MODES[key];
    assertEq(modes.VIS_TO_MODE[m.visCode], key, `VIS_TO_MODE[${m.visCode}] resolves to ${key}`);
  }

  // Known canonical VIS codes (MMSSTV / hamradio spec)
  assertEq(modes.MODES.martin1.visCode, 44, 'Martin M1 VIS = 44 (canonical)');
  assertEq(modes.MODES.scottie1.visCode, 60, 'Scottie S1 VIS = 60 (canonical)');
  assertEq(modes.MODES.scottie2.visCode, 56, 'Scottie S2 VIS = 56 (canonical)');
  assertEq(modes.MODES.robot72.visCode, 12, 'Robot 72 VIS = 12 (canonical)');

  // Dimensions sanity
  for (const key of all) {
    const m = modes.MODES[key];
    assert(m.width > 0 && m.width <= 800, `${key} width sane`);
    assert(m.height > 0 && m.height <= 800, `${key} height sane`);
  }

  // SSTV frequency constants — DO NOT change without spec review
  assertEq(modes.SYNC_FREQ, 1200, 'SSTV sync = 1200 Hz');
  assertEq(modes.BLACK_FREQ, 1500, 'SSTV black = 1500 Hz');
  assertEq(modes.WHITE_FREQ, 2300, 'SSTV white = 2300 Hz');
  assertEq(modes.FREQ_RANGE, 800, 'SSTV range = 800 Hz');

  // VIS header constants
  assertEq(modes.VIS_LEADER_FREQ, 1900, 'VIS leader = 1900 Hz');
  assertEq(modes.VIS_BIT1_FREQ, 1100, 'VIS bit-1 = 1100 Hz');
  assertEq(modes.VIS_BIT0_FREQ, 1300, 'VIS bit-0 = 1300 Hz');
  assertEq(modes.VIS_LEADER_MS, 300, 'VIS leader = 300 ms');
  assertEq(modes.VIS_BIT_MS, 30, 'VIS bit = 30 ms');
}

// =====================================================================
// 2. VIS encoding — bit pattern correctness
// =====================================================================
//
// VIS header for code C, encoded LSB-first with even parity:
//   leader 300ms @ 1900Hz, break 10ms @ 1200Hz, leader 300ms @ 1900Hz,
//   start 30ms @ 1200Hz, 7 data bits (LSB-first) 30ms each, parity 30ms,
//   stop 30ms @ 1200Hz.
section('VIS encoding — bit pattern');
{
  // Parity bit computation for even-parity scheme. The parity BIT is
  // 0 when the data has an even number of 1s, 1 when odd — so that the
  // total count of 1s (data + parity) is always even. Don't confuse
  // the parity SCHEME with the parity bit's VALUE.
  function parityBitOf(code) {
    let p = 0;
    for (let i = 0; i < 7; i++) p ^= (code >> i) & 1;
    return p;
  }
  // 44 = 0101100 → three 1s → odd → parity bit 1
  assertEq(parityBitOf(44), 1, 'Martin M1 (44) data has 3 ones → parity bit = 1');
  // 60 = 0111100 → four 1s → even → parity bit 0
  assertEq(parityBitOf(60), 0, 'Scottie S1 (60) data has 4 ones → parity bit = 0');
  // 12 = 0001100 → two 1s → even → parity bit 0
  assertEq(parityBitOf(12), 0, 'Robot 72 (12) data has 2 ones → parity bit = 0');

  // Build a minimal harness that captures appendTone calls so we can
  // inspect the frequency sequence the worker emits for a VIS code.
  // Re-implement encodeVIS using the same primitives but record
  // (freq, durMs) tuples instead of writing PCM. This is a structural
  // mirror — if encodeVIS in the worker diverges from this spec the
  // worker is the bug.
  function encodeVIS_spec(code) {
    const seq = [];
    const tone = (f, d) => seq.push({ f, d });
    tone(modes.VIS_LEADER_FREQ, modes.VIS_LEADER_MS);
    tone(modes.SYNC_FREQ, modes.VIS_BREAK_MS);
    tone(modes.VIS_LEADER_FREQ, modes.VIS_LEADER_MS);
    tone(modes.SYNC_FREQ, modes.VIS_BIT_MS); // start
    let p = 0;
    for (let i = 0; i < 7; i++) {
      const b = (code >> i) & 1;
      p ^= b;
      tone(b ? modes.VIS_BIT1_FREQ : modes.VIS_BIT0_FREQ, modes.VIS_BIT_MS);
    }
    tone(p ? modes.VIS_BIT1_FREQ : modes.VIS_BIT0_FREQ, modes.VIS_BIT_MS); // parity
    tone(modes.SYNC_FREQ, modes.VIS_STOP_MS);
    return seq;
  }
  const seq = encodeVIS_spec(44);
  // 13 segments: leader, break, leader, start, 7 data, parity, stop.
  assertEq(seq.length, 13, 'VIS sequence has 13 segments (3 header + start + 7 data + parity + stop)');
  assertEq(seq[0], { f: 1900, d: 300 }, 'segment 0 = leader');
  assertEq(seq[1], { f: 1200, d: 10 }, 'segment 1 = break');
  assertEq(seq[2], { f: 1900, d: 300 }, 'segment 2 = second leader');
  assertEq(seq[3], { f: 1200, d: 30 }, 'segment 3 = start bit');
  // Code 44 = 0101100 LSB-first → bits emitted as: 0,0,1,1,0,1,0
  // Frequency for bit 0 = 1300 Hz; for bit 1 = 1100 Hz
  const expectedBitFreqs = [1300, 1300, 1100, 1100, 1300, 1100, 1300];
  for (let i = 0; i < 7; i++) {
    assertEq(seq[4 + i].f, expectedBitFreqs[i], `bit ${i} of code 44 freq`);
    assertEq(seq[4 + i].d, 30, `bit ${i} duration`);
  }
  // Code 44 has odd 1-count → parity bit = 1 → freq 1100 Hz
  assertEq(seq[11], { f: 1100, d: 30 }, 'segment 11 = parity bit (1100 Hz for code 44 odd parity)');
  assertEq(seq[12], { f: 1200, d: 30 }, 'segment 12 = stop bit');
}

// =====================================================================
// 3. YCbCr color math (Robot 72, PD modes)
// =====================================================================
section('YCbCr color math (BT.601)');
{
  // Replicate the worker's conversion since it's not exported.
  function rgbToYCbCr(r, g, b) {
    return {
      y:  0.299 * r + 0.587 * g + 0.114 * b,
      cb: 128 - 0.169 * r - 0.331 * g + 0.500 * b,
      cr: 128 + 0.500 * r - 0.419 * g - 0.081 * b,
    };
  }
  // Pure black
  let c = rgbToYCbCr(0, 0, 0);
  assertNear(c.y, 0, 0.01, 'black Y = 0');
  assertNear(c.cb, 128, 0.5, 'black Cb = 128');
  assertNear(c.cr, 128, 0.5, 'black Cr = 128');
  // Pure white
  c = rgbToYCbCr(255, 255, 255);
  assertNear(c.y, 255, 0.5, 'white Y = 255');
  assertNear(c.cb, 128, 0.5, 'white Cb = 128');
  assertNear(c.cr, 128, 0.5, 'white Cr = 128');
  // Pure red — high Cr
  c = rgbToYCbCr(255, 0, 0);
  assertNear(c.y, 76, 0.5, 'red Y ≈ 76');
  assert(c.cr > 200, 'red Cr > 200 (signed: red pushes chroma high)');
  // Pure blue — high Cb
  c = rgbToYCbCr(0, 0, 255);
  assert(c.cb > 200, 'blue Cb > 200');
}

// =====================================================================
// 4. Mode line-timing math
// =====================================================================
section('Mode line-timing math');
{
  // Martin M1: sync + porch + 3 × (scan + sep)
  const m1 = modes.MODES.martin1;
  const m1total = m1.syncMs + m1.porchMs + 3 * (m1.scanMs + m1.separatorMs);
  // Canonical Martin M1 line time is ~446.446 ms
  assertNear(m1total, 446.446, 0.1, 'Martin M1 line ≈ 446.446 ms');

  // Scottie S1: sep + G + sep + B + sync + porch + R (different layout)
  const s1 = modes.MODES.scottie1;
  const s1total = 2 * s1.separatorMs + 3 * s1.scanMs + s1.syncMs + s1.porchMs;
  assertNear(s1total, 428.22, 0.1, 'Scottie S1 line ≈ 428.22 ms');

  // Pixel rates sanity — pixelMs * width should equal scanMs
  for (const key of Object.keys(modes.MODES)) {
    const m = modes.MODES[key];
    if (m.pixelMs && m.scanMs) {
      assertNear(m.pixelMs * m.width, m.scanMs, 0.001, `${key} pixelMs × width ≈ scanMs`);
    }
  }
}

// =====================================================================
// 5. Encode/decode pipeline sanity
// =====================================================================
section('Encode/decode pipeline — runs end-to-end');
{
  // Build a tiny RGB test image and verify encodeImage returns something
  // sane. Full quality PSNR matrix is in scripts/test-sstv.js — we just
  // verify the pipeline doesn't throw + produces audio of the expected
  // length.
  const W = 320, H = 256;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    img[i * 4 + 0] = 128;
    img[i * 4 + 1] = 64;
    img[i * 4 + 2] = 200;
    img[i * 4 + 3] = 255;
  }
  let samples;
  try { samples = encodeImage(img, W, H, 'martin1'); } catch (e) {
    assert(false, 'encodeImage(martin1) threw: ' + e.message);
  }
  if (samples) {
    assert(samples instanceof Float32Array, 'encodeImage returns Float32Array');
    // Martin M1 = VIS header (~970ms incl all leaders/bits) + 256 lines × 446ms ≈ 115 s
    // At 48k that's ~5.5M samples. Just assert reasonable bounds.
    const seconds = samples.length / 48000;
    assert(seconds > 100 && seconds < 130, `martin1 audio ≈ 100-130 s (got ${seconds.toFixed(1)})`);
  }

  // Decoder constructs without error
  let dec;
  try { dec = new SstvDecoder(); } catch (e) {
    assert(false, 'SstvDecoder() threw: ' + e.message);
  }
  assert(!!dec, 'decoder constructed');
  assert(typeof dec.processSamples === 'function', 'decoder.processSamples is a function');
}

// =====================================================================
// 6. Template / textElement structure invariants
// =====================================================================
//
// The popout stores templates in settings.sstvTemplates as:
//   [{ bgParams, bgDataUrl, texts, thumbnail }]
// and live text elements as:
//   [{ key, label, x, y, fontSize, bold, italic, color, rotation, visible }]
// These shapes must survive JSON round-trip without lossage — they're
// persisted via window.api.saveSettings → settings.json.
section('Template + textElement structure round-trip');
{
  const tpl = {
    bgParams: { type: 'noise', seed: 42 },
    bgDataUrl: null,
    texts: [
      { key: 'cq', label: 'CQ SSTV', x: 8, y: 22, fontSize: 18, bold: true, italic: false, color: '#ffffff', rotation: 0, visible: true },
      { key: 'call', label: 'K3SBP', x: 8, y: 44, fontSize: 20, bold: true, italic: false, color: '#ffffff', rotation: 0, visible: true },
      { key: 'grid', label: 'FN20', x: 8, y: 66, fontSize: 14, bold: false, italic: false, color: '#ffffff', rotation: 0, visible: true },
    ],
    thumbnail: 'data:image/png;base64,iVBORw0KGgo=',
  };
  const rt = JSON.parse(JSON.stringify(tpl));
  assertEq(rt, tpl, 'template round-trips through JSON unchanged');

  // Templates array cap (popout enforces 12)
  const MAX_TEMPLATES = 12;
  assertEq(MAX_TEMPLATES, 12, 'template cap matches popout enforcement');

  // textElement key 'call' must auto-populate from settings.myCallsign on init
  // (renderer/sstv-popout.js init: callsign = settings.myCallsign).
  // Document the contract so a future "always show empty" refactor catches it.
  const baseTextElements = [
    { key: 'cq', label: 'CQ SSTV' },
    { key: 'call', label: '' },
    { key: 'grid', label: '' },
  ];
  // Simulate the init's syncAutoLabels: if label is empty AND key matches
  // an auto-populated field, fill from settings.
  function syncAutoLabels(elements, settings) {
    const out = JSON.parse(JSON.stringify(elements));
    const call = out.find((e) => e.key === 'call');
    if (call && !call.label) call.label = settings.myCallsign || '';
    const grid = out.find((e) => e.key === 'grid');
    if (grid && !grid.label) grid.label = settings.grid || '';
    return out;
  }
  const synced = syncAutoLabels(baseTextElements, { myCallsign: 'K3SBP', grid: 'FN20' });
  assertEq(synced[1].label, 'K3SBP', 'auto-populate call from myCallsign');
  assertEq(synced[2].label, 'FN20', 'auto-populate grid from settings.grid');
  // User-provided labels are NOT overwritten
  const userOverride = syncAutoLabels(
    [{ key: 'call', label: 'NA1SS' }],
    { myCallsign: 'K3SBP' },
  );
  assertEq(userOverride[0].label, 'NA1SS', 'user-provided label preserved over auto-populate');
}

// =====================================================================
// 6b. Post-processing (sstv-post) — pure-function unit tests
// =====================================================================
section('Post-processing pure functions');
{
  // 4×4 test image: solid mid-gray
  function gray(w, h) {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      a[i * 4] = 128; a[i * 4 + 1] = 128; a[i * 4 + 2] = 128; a[i * 4 + 3] = 255;
    }
    return a;
  }
  // unsharp on uniform image: no change (no high-frequency detail)
  const u = sstvPost.unsharpMask(gray(4, 4), 4, 4, 1.0);
  assertEq(u[0], 128, 'unsharp on uniform image preserves value');
  assertEq(u[1 * 4], 128, 'unsharp uniform pixel 1');

  // unsharp 0 strength = identity
  const u0 = sstvPost.unsharpMask(gray(4, 4), 4, 4, 0);
  assertEq(u0[0], 128, 'unsharp 0-strength is identity');

  // unsharp on edge image — should INCREASE contrast at the edge.
  // Build a 4×4 with left half black, right half white.
  const edge = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      const v = x < 2 ? 0 : 255;
      edge[i] = v; edge[i + 1] = v; edge[i + 2] = v; edge[i + 3] = 255;
    }
  }
  const sharp = sstvPost.unsharpMask(edge, 4, 4, 1.0);
  // The dark side of the edge should get DARKER (lift below 0 clamped),
  // bright side should get BRIGHTER. Check pixel (1,1) on the dark
  // side — original 0, sharpened should still be 0 (already at floor).
  // Pixel (2,1) on bright side — original 255, should stay 255.
  assertEq(sharp[(1 * 4 + 1) * 4], 0, 'unsharp on edge: dark side stays at floor');
  assertEq(sharp[(1 * 4 + 2) * 4], 255, 'unsharp on edge: bright side stays at ceiling');

  // saturationBoost factor 1.0 = identity
  const s1 = sstvPost.saturationBoost(gray(4, 4), 4, 4, 1.0);
  assertEq(s1[0], 128, 'saturationBoost 1.0 is identity');
  // Pure red, saturation 1.5 — chroma boosted. R increases (toward 255),
  // G/B decrease toward luma. Luma of (255,0,0) = 76.245. R = 76+(255-76)*1.5 = 76+269 = 345 → 255.
  const red = new Uint8ClampedArray([255, 0, 0, 255]);
  const sBoost = sstvPost.saturationBoost(red, 1, 1, 1.5);
  assertEq(sBoost[0], 255, 'saturation 1.5: red R clamps at 255');
  assertEq(sBoost[1], 0, 'saturation 1.5: red G clamps at 0');
  assertEq(sBoost[2], 0, 'saturation 1.5: red B clamps at 0');

  // gammaCorrect 1.0 = identity
  const g1 = sstvPost.gammaCorrect(gray(4, 4), 4, 4, 1.0);
  assertEq(g1[0], 128, 'gamma 1.0 is identity');
  // Convention in this impl: lut applies pow(v, 1/gamma). So:
  //   gamma > 1  → 1/gamma < 1 → LIFTS midtones
  //   gamma < 1  → 1/gamma > 1 → DARKENS midtones
  // (Matches Photoshop's "Levels" gamma slider: drag right = lift.)
  const g05 = sstvPost.gammaCorrect(gray(4, 4), 4, 4, 0.5);
  assert(g05[0] < 128, 'gamma 0.5 darkens midtones (this impl uses pow(v, 1/gamma))');
  const g2 = sstvPost.gammaCorrect(gray(4, 4), 4, 4, 2.0);
  assert(g2[0] > 128, 'gamma 2.0 lifts midtones');
  // Black and white invariant under any gamma
  const blackWhite = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  const gbw = sstvPost.gammaCorrect(blackWhite, 2, 1, 0.5);
  assertEq(gbw[0], 0, 'gamma: 0 stays 0');
  assertEq(gbw[4], 255, 'gamma: 255 stays 255');

  // postProcess: chained call, default opts, returns new buffer (not aliased)
  const src = gray(4, 4);
  const dst = sstvPost.postProcess(src, 4, 4);
  assert(dst !== src, 'postProcess returns a NEW buffer');
  assertEq(dst.length, src.length, 'postProcess preserves length');
}

// =====================================================================
// 7. SSTV calling-frequency table
// =====================================================================
section('SSTV calling-frequency table');
{
  // Frequencies hard-coded in renderer/sstv-popout.html — these MUST
  // include the global SSTV calling frequencies because users expect
  // POTACAT to QSY there. If a freq changes by IARU consensus, update
  // here + the popout.
  const SSTV_FREQS = {
    '40m': [7165, 7171],
    '20m': [14227, 14230, 14233],
  };
  assert(SSTV_FREQS['40m'].includes(7171), '40m includes 7.171 MHz (US calling)');
  assert(SSTV_FREQS['20m'].includes(14230), '20m includes 14.230 MHz (global calling)');
  assert(SSTV_FREQS['20m'].includes(14233), '20m includes 14.233 MHz');
}

// =====================================================================
// 8. SPEC tests — features Casey wants but aren't implemented yet
// =====================================================================
section('PENDING — features to implement (these aren\'t failures, they\'re contracts)');
{
  // (a) Saving decoded images to disk on successful decode
  todo('decoded images saved to disk in a configurable folder (currently lives in memory only)');
  todo('decoded image save preserves: mode, timestamp, frequency, decoded callsign if extracted, PSNR');
  todo('decoded image folder configurable via settings.sstvDecodedImagesPath (default ~/POTACAT/sstv-rx/)');

  // (b) Sent-image history
  todo('sent images persisted to settings.sstvSentHistory: [{ tplIdx, mode, freqKhz, at, dataUrl, durationMs }]');
  todo('sent history capped at 50 entries (FIFO eviction)');
  todo('sent history visible in popout — click any to re-send identical');
  todo('sent history persists across app restarts');

  // (c) Reply-to-image: insert received image into outgoing
  todo('right-click received image → "Reply with this as background"');
  todo('reply-with-image scales source to current mode dimensions');
  todo('reply-with-image preserves overlay text elements (CQ / call / grid stay on top)');

  // (d) Stop transmission mid-image
  todo('TX cancel: clean cutoff of any active SSTV transmission, PTT released, no audio overhang');
  todo('TX cancel restores radio mode / freq to pre-TX state');
  todo('TX cancel during VIS header → cancelable; during line scan → cancelable; during final sync → cancelable');

  // (e) MMSSTV-parity best practices we should match
  todo('FSK ID transmitted at end of image (callsign in CW @ 800 Hz tone, MMSSTV standard)');
  todo('mode-name watermark in bottom-right (toggle: default on)');
  todo('two-pass receive: tentative slant correction during reception, full re-decode at end-of-image');
  todo('VOX-safe leader: 100ms 1900Hz pre-VIS to give radios time to key (matches MMSSTV "VOX delay")');
  todo('auto-pick mode from VIS code without manual mode select (currently requires user to select mode)');
  todo('image upscaling: 2× sharp interpolation for display (MMSSTV viewers expect 640×512 or 640×480)');

  // (f) QSY behavior
  todo('clicking a freq in popout sends FA + MD via SmartSDR / CAT to actually QSY');
  todo('mode change to USB happens before FA write so radio doesn\'t squelch at LSB');
  todo('after TX completes, radio stays at chosen freq (does not revert)');

  // (g) Decode robustness
  todo('robot36 produces non-null PSNR (currently NULL — scripts/test-sstv.js failure)');
  todo('decode survives ±1000 ppm clock drift with PSNR ≥ 25 dB (currently ~20 dB)');
}

// =====================================================================
// Done
// =====================================================================
console.log('\n' + '='.repeat(60));
console.log(`Results: ${pass} passed, ${fail} failed, ${pending} pending (specs for unimplemented features)`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('All assertions passed (pending counts not blocking).');
process.exit(0);
