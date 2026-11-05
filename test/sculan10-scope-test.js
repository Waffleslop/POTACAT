#!/usr/bin/env node
'use strict';
// Yaesu SCU-LAN10 band scope (experimental): frames built from the spec's
// own description (SPEC.md "Scope Channel"), decoded by lib/sculan10-scope.js.
// Nobody here owns a unit: these are the spec's rules, checked.
// Run: node test/sculan10-scope-test.js
const assert = require('assert');
const S = require('../lib/sculan10-scope');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// A spectrum line of n bins: noise around level 35 (raw ~220, the spec's
// typical floor 200-240) with a few signals.
function line(n, signals = {}) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = 30 + ((i * 13) % 11);
  for (const [bin, level] of Object.entries(signals)) a[Number(bin)] = level;
  return a;
}

test('a spec-shaped frame is 4096 bytes with the marker at twice the line length', () => {
  const f = S.buildSpecFrame(line(850));
  assert.strictEqual(f.length, 4096);
  assert.strictEqual(f[1700], 1, 'marker byte');
  assert.deepStrictEqual(S.findSpectrumEnd(f), { end: 1700, method: 'marker' });
});

test('the marker/2 rule: the usable line is the first marker/2 bytes, read from byte 0', () => {
  for (const n of [850, 900, 950]) {
    const levels = line(n, { 100: 200, 400: 250 });
    const d = S.decodeScopeFrame(S.buildSpecFrame(levels));
    assert.strictEqual(d.end, 2 * n);
    assert.strictEqual(d.usable, n, 'marker ' + 2 * n + ' gives ' + n + ' bins');
    assert.deepStrictEqual(Array.from(d.levels), Array.from(levels), 'every bin comes back');
  }
  // An odd marker position rounds down, as marker // 2 does.
  const raw = Buffer.alloc(4096, 220); raw[1901] = 1;
  assert.strictEqual(S.decodeScopeFrame(raw).usable, 950);
});

test('amplitude is inverted: raw 0 is the strongest, 255 the weakest; level = 255 - raw = 255 x (1 - raw/255)', () => {
  const raw = Buffer.alloc(4096, 220);
  raw[0] = 0; raw[1] = 255; raw[2] = 2; raw[3] = 127; raw[1700] = 1;
  const d = S.decodeScopeFrame(raw);
  assert.strictEqual(d.levels[0], 255);
  assert.strictEqual(d.levels[1], 0);
  assert.strictEqual(d.levels[2], 253);
  assert.strictEqual(d.levels[3], 128);
  for (const r of [0, 2, 127, 220, 255]) assert.strictEqual(255 - r, Math.round(255 * (1 - r / 255)));
});

test('a strong signal below byte 500 is not the marker (the search starts at 500)', () => {
  const levels = line(850, { 10: 255, 450: 254 });   // raw 0 and 1, both below 500
  // (The doubled half is kept quiet here: a copy of bin 10 would sit at byte
  // 860, above 500 — exactly the case MarkerTracker is for, tested below.)
  const d = S.decodeScopeFrame(S.buildSpecFrame(levels, { secondHalf: 'floor' }));
  assert.strictEqual(d.end, 1700);
  assert.strictEqual(d.levels[10], 255);
});

test('no marker: the reference block (64-byte average > 225) ends the line 100 bytes earlier', () => {
  const raw = Buffer.alloc(4096, 100);
  for (let i = 1204; i < 1700; i++) raw[i] = 240;   // first 64-byte block from 500 that is all reference: 1204
  assert.deepStrictEqual(S.findSpectrumEnd(raw), { end: 1104, method: 'reference' });
});

test('no marker and no reference block: the spec\'s default of 2000', () => {
  assert.deepStrictEqual(S.findSpectrumEnd(Buffer.alloc(4096, 100)), { end: 2000, method: 'default' });
  assert.deepStrictEqual(S.findSpectrumEnd(Buffer.alloc(1500, 100)), { end: 1500, method: 'default' });
});

test('past the marker nothing is decoded (the reference block and the region around 128 never reach the picture)', () => {
  const d = S.decodeScopeFrame(S.buildSpecFrame(line(850)));
  assert.strictEqual(d.levels.length, 850);
  assert.ok(d.levels.every((v) => v >= 30 && v <= 40), 'only the line');
});

test('the marker is locked after three frames, so a strong signal between 500 and the marker cannot cut the line short', () => {
  const t = new S.MarkerTracker();
  const clean = S.buildSpecFrame(line(850));
  for (let i = 0; i < 3; i++) t.find(clean);
  assert.strictEqual(t.locked, 1700);
  const strong = S.buildSpecFrame(line(850, { 600: 255 }));   // raw 0 at byte 600: the heuristic alone stops there
  assert.strictEqual(S.findSpectrumEnd(strong).end, 600, 'the spec heuristic alone is fooled');
  const d = S.decodeScopeFrame(strong, t);
  assert.strictEqual(d.end, 1700);
  assert.strictEqual(d.method, 'locked');
  assert.strictEqual(d.levels[600], 255, 'and the signal is drawn');
});

test('before any lock, a full-scale signal copied into the doubled half is not taken for the marker: the reference block after it decides', () => {
  const strong = S.buildSpecFrame(line(850, { 10: 255 }));    // its copy is raw 0 at byte 860
  assert.strictEqual(S.findSpectrumEnd(strong).end, 860, 'the spec rule alone stops at the copy');
  assert.deepStrictEqual(S.findConfirmedMarker(strong), { end: 1700, method: 'marker+reference' });
  const t = new S.MarkerTracker();
  for (let i = 0; i < 3; i++) {
    const d = S.decodeScopeFrame(strong, t);
    assert.strictEqual(d.end, 1700);
    assert.strictEqual(d.usable, 850);
  }
  assert.strictEqual(t.locked, 1700, 'a steady carrier never locks the wrong place');
  assert.ok(/the spec's first-byte rule alone would stop at byte 860/.test(S.describeFrame(strong)), 'and the log says so');
});

test('no reference block after any candidate: a byte of exactly 1 is the marker', () => {
  const raw = Buffer.alloc(4096, 100); raw[1800] = 1;
  assert.deepStrictEqual(S.findConfirmedMarker(raw), { end: 1800, method: 'marker' });
  const d = S.decodeScopeFrame(raw, new S.MarkerTracker());
  assert.strictEqual(d.end, 1800);
  assert.strictEqual(d.method, 'marker');
});

test('only 0s, no 1 and no reference block: the first-byte rule from the spec, unchanged', () => {
  const raw = Buffer.alloc(4096, 100); raw[1750] = 0;
  assert.strictEqual(S.findConfirmedMarker(raw), null);
  assert.strictEqual(S.decodeScopeFrame(raw, new S.MarkerTracker()).end, 1750);
});

// Raw frames written byte by byte from the spec's value table, not with the
// module's own builder: 0 = strongest signal, 1 = reserved (the marker),
// 200-240 = the noise floor.
test('review: a full-scale signal (raw 0) above byte 500 followed by a noise floor near 230 is not the marker; the reserved 1 is', () => {
  const raw = Buffer.alloc(4096, 0);
  for (let i = 0; i < 1700; i++) raw[i] = 228 + (i % 5);      // noise floor 228-232: averages above 225
  raw[860] = 0;                                                // a full-scale signal in the doubled half
  raw[1700] = 1;                                               // the marker
  for (let i = 1701; i < 2101; i++) raw[i] = 233;               // the reference block the spec observed
  assert.strictEqual(S.findSpectrumEnd(raw).end, 860, 'the first-byte rule alone stops at the signal');
  const d = S.decodeScopeFrame(raw, new S.MarkerTracker());
  assert.strictEqual(d.end, 1700);
  assert.strictEqual(d.usable, 850);
  assert.strictEqual(d.levels[0], 255 - 228, 'inverted: noise reads low');
});

test('review: a reserved 1 beats an earlier 0 even with no reference block anywhere', () => {
  const raw = Buffer.alloc(4096, 210);
  raw[900] = 0; raw[1720] = 1;
  assert.deepStrictEqual(S.findConfirmedMarker(raw), { end: 1720, method: 'marker' });
  assert.strictEqual(S.decodeScopeFrame(raw, new S.MarkerTracker()).usable, 860);
});

test('a span change moves the marker: the old lock no longer reads <= 1 and the search runs again', () => {
  const t = new S.MarkerTracker();
  for (let i = 0; i < 3; i++) t.find(S.buildSpecFrame(line(850)));
  const wider = S.buildSpecFrame(line(950));
  const d = S.decodeScopeFrame(wider, t);
  assert.strictEqual(d.end, 1900);
  assert.strictEqual(t.locked, null, 'unlocked until it repeats');
  t.find(wider); t.find(wider);
  assert.strictEqual(t.locked, 1900);
});

test('the line becomes the 850 points every scope client draws, peak-held so a one-bin signal survives', () => {
  const same = S.toScopeFrame(line(850, { 425: 250 }));
  assert.strictEqual(same.wf1.length, 850);
  assert.strictEqual(same.wf1[425], 250);
  assert.strictEqual(same.aligned, true);
  const wide = line(950, { 777: 251 });
  const f = S.toScopeFrame(wide, { seq: 9 });
  assert.strictEqual(f.seq, 9);
  assert.strictEqual(Math.max(...f.wf1), 251, 'the spike is kept');
  assert.ok(Math.abs(f.wf1.indexOf(251) - Math.round((777 / 950) * 850)) <= 1, 'at the same place across the span');
  assert.strictEqual(S.toScopeFrame(new Uint8Array(0)).wf1.every((v) => v === 0), true);
});

test('bins map linearly across the span centred on the dial', () => {
  const c = 14074000, span = 100000, n = 850;
  const lo = S.binToHz(0, n, c, span), hi = S.binToHz(n - 1, n, c, span), mid = (S.binToHz(424, n, c, span) + S.binToHz(425, n, c, span)) / 2;
  assert.ok(lo > c - span / 2 && lo < c - span / 2 + span / n, String(lo));
  assert.ok(hi < c + span / 2 && hi > c + span / 2 - span / n, String(hi));
  assert.ok(Math.abs(mid - c) <= 1, 'the middle of the line is the dial: ' + mid);
  const step = S.binToHz(11, n, c, span) - S.binToHz(10, n, c, span);
  assert.ok(Math.abs(step - span / n) <= 1, 'equal steps');
  assert.strictEqual(S.binToHz(0, n, c, 0), null, 'no span read: no frequencies');
});

test('the first-frame log line says what a tester\'s frame looked like', () => {
  const s = S.describeFrame(S.buildSpecFrame(line(850)));
  assert.ok(/^4096 bytes; boundary marker at byte 1700 \(first byte <= 1 after 500 with the reference block after it\), 850 usable bins; raw min\/median\/max \d+\/\d+\/\d+; FT-710 USB tail FF 01 EE 01: no$/.test(s), s);
  const odd = Buffer.alloc(3000, 220);
  assert.ok(/3000 bytes \(the spec says 4096\)/.test(S.describeFrame(odd)));
});

console.log(`\nSCU-LAN10 scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
