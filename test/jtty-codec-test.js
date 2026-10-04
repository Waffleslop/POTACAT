#!/usr/bin/env node
'use strict';
// JTTY encoder (lib/jtty), Phase 1 of docs/jtty-integration-plan.md: the
// grammar is checked against the normative golden vectors in WSJT-X
// lib/jtty/jtty_source_encoding.txt (v3.2.0-rc1), the frame counts against
// the tables in lib/jtty/jtty_design.md, the round trips against
// lib/jtty/jtty_msgs.txt, and the waveform against itself (every symbol
// recovered by a matched filter). The sjtty/rjtty cross-check is run by hand
// (see the plan), not here.
// Run: node test/jtty-codec-test.js
const assert = require('assert');
const J = require('../lib/jtty');
const C = J.codec;
const F = J.fec;
const W = J.waveform;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
console.log('JTTY codec (' + J.JTTY_SPEC_TAG + ')');

// ---- golden vectors --------------------------------------------------------
const GOLDEN = [
  ['CQ K1ABC CQ', C.callAtom(C.CALL.CQ, 'K1ABC'), true, '0x026F78D41', 'CQ K1ABC CQ'],
  ['EXCH_NUM full SERIAL 123, more', C.exchNumAtom(C.ROLE.FULL, C.NUM.SERIAL, 123), false, '0x20007B008', '599 123'],
  ['EXCH_NUM full SERIAL 123, EOM', C.exchNumAtom(C.ROLE.FULL, C.NUM.SERIAL, 123), true, '0x20007B009', '599 123'],
  ['EXCH_LOC full STATE CA', C.exchLocAtom(C.ROLE.FULL, C.LOC.STATE_PROVINCE, 'CA'), true, '0x2001BA019', '599 CA'],
  ['ZONE_LOC3 05 NWT', C.zoneLocAtom(5, 'NWT'), true, '0x00B790D29', '599 05 NWT'],
  ['CLASS_SECTION 1D EMA', C.classSectionAtom(1, 'D', C.sectionIndex('EMA')), true, '0x082C58029', '1D EMA'],
  ['EXCH_NUM_TIME full 156 1749', C.exchNumTimeAtom(C.ROLE.FULL, 156, 17 * 60 + 49), true, '0x204E42D39', '599 156 1749'],
  ['CONTROL AGN?', C.controlAtom(0), true, '0x000000049', 'AGN?'],
  ['GRID4 field-only FN42', C.grid4Atom(C.ROLE.FIELD_ONLY, 'FN42'), true, '0x04A198049', 'FN42'],
  ['TEXT5 HELLO', C.text5Atom('HELLO'), true, '0x11395558D', 'HELLO'],
];
for (const [name, a, eom, hex, text] of GOLDEN) {
  test('golden: ' + name + ' = ' + hex, () => {
    const f = C.packAtom(a, eom);
    assert.ok(f, 'did not pack');
    assert.strictEqual(C.frameHex(f), hex);
    const u = C.unpackAtom(f);
    assert.ok(u, 'did not unpack');
    assert.strictEqual(u.eom, eom);
    assert.strictEqual(C.renderAtom(u.atom), text);
  });
}

test('the spec says: an all-zero word and a set reserved bit are invalid', () => {
  assert.strictEqual(C.unpackAtom('0'.repeat(32) + '01'), null);
  const f = C.packAtom(C.controlAtom(0), true);
  assert.strictEqual(C.unpackAtom(f.slice(0, 32) + '11'), null);
});

// ---- frame counts (jtty_design.md tables) -----------------------------------
const COUNTS = [
  ['CQ K1ABC CQ', 1], ['CQ KA1ABC CQ', 1], ['WB9XYZ', 1], ['WB9XYZ TU CQ KA1ABC CQ', 2],
  ['WB9XYZ 599 123', 2], ['599 123', 1], ['599 MA', 1], ['599 FN42', 1], ['1D EMA', 1],
  ['599 001', 2], ['599 05', 2], ['599 BRUCE', 2],
  ['TU NOW JA6DEF 599 102', 2], ['JA6DEF AGN?', 1], ['TU KA1ABC CQ', 1], ['599 057', 2], ['WB9XYZ 599 101', 2],
  ['CQ K1ABC CQ CQ K1ABC CQ', 2], ['HI WB9XYZ', 2], ['TEST WB9XYZ', 2], ['K1ABC HELLO', 2],
];
test('frame counts match the design document (Unknown profile), and round-trip', () => {
  for (const [m, want] of COUNTS) {
    const p = J.pack(m);
    assert.ok(p.ok, m + ': ' + p.error);
    assert.strictEqual(p.nframes, want, m + ' frames');
    assert.strictEqual(J.decodeFrames(p.frames).text, C.normalizeMessage(m), m + ' round trip');
    assert.strictEqual(J.decodeFrames(p.frames).eom, true, m + ' EOM on the last frame');
    for (const f of p.frames.slice(0, -1)) assert.strictEqual(f[33], '0', m + ' EOM only on the last frame');
  }
});

test('RTTY Roundup profile: serial normalization and typed atoms', () => {
  const cases = [['599 001', '599 001', 1, [C.NUM.SERIAL]], ['K1ABC 599 001', 'K1ABC 599 001', 2, null],
    ['599 05', '599 005', 1, [C.NUM.SERIAL]], ['599 0123', '599 123', 1, [C.NUM.SERIAL]],
    ['599 123', '599 123', 1, [C.NUM.SERIAL]], ['001', '001', 1, null]];
  for (const [m, text, want, kinds] of cases) {
    const p = J.pack(m, 'rtty-roundup');
    assert.ok(p.ok, m);
    assert.strictEqual(p.text, text, m + ' canonical text');
    assert.strictEqual(p.nframes, want, m + ' frames');
    assert.strictEqual(J.decodeFrames(p.frames).text, text, m + ' round trip');
    if (kinds) {
      const a = C.unpackAtom(p.frames[0]).atom;
      assert.strictEqual(a.kind, C.ATOM.EXCH_NUM); assert.strictEqual(a.subtype, kinds[0]);
    }
  }
  // 599 MA is STATE_PROVINCE under RTTY, QTH otherwise
  assert.strictEqual(C.unpackAtom(J.pack('599 MA', 'rtty-roundup').frames[0]).atom.subtype, C.LOC.STATE_PROVINCE);
  assert.strictEqual(C.unpackAtom(J.pack('599 MA').frames[0]).atom.subtype, C.LOC.QTH);
  // a bare number is never a serial; an unsupported token keeps its spelling
  assert.strictEqual(J.pack('599 1234567', 'rtty-roundup').text, '599 1234567');
  assert.strictEqual(J.profileOf('nonsense'), -1);
  assert.strictEqual(J.pack('599 001', 'nonsense').ok, false);
});

test('every message in jtty_msgs.txt packs and round-trips', () => {
  const msgs = ['CQ KA1ABC CQ', 'WB9XYZ', 'TU KA1ABC CQ', 'WB9XYZ TU', 'WB9XYZ AGN?', 'WB9XYZ TU CQ KA1ABC CQ',
    'TU NOW JA6DEF 599 123', 'WB9XYZ 599 0123', 'WB9XYZ NR?', '599 1234', '599 MA', '599 FN42', '599 BRUCE',
    'PJ4/KA1ABC', 'CQ KA1ABC', 'CQ PJ4/KA1ABC CQ', 'PJ4/KA1ABC 599 124',
    'THE QUICK BROWN FOX JUMPED OVER THE LAZY DOG.', C.ALPHABET];
  for (const m of msgs) {
    const p = J.pack(m);
    assert.ok(p.ok, m + ': ' + p.error);
    assert.strictEqual(J.decodeFrames(p.frames).text, C.normalizeMessage(m), m);
  }
  assert.strictEqual(J.pack(C.ALPHABET).nframes, 13, 'the 64-symbol alphabet is 13 TEXT5 frames');
  assert.strictEqual(J.pack('PJ4/KA1ABC').nframes, 2, 'a compound call is text, never a call atom');
});

// ---- normalization and limits ---------------------------------------------
test('normalization: upper-case, alphabet fold to #, ~ and runs of spaces', () => {
  assert.strictEqual(C.normalizeMessage('  cq   k1abc~cq  '), 'CQ K1ABC CQ');
  assert.strictEqual(C.normalizeMessage('héllo @ 599'), 'H#LLO # 599');
  assert.strictEqual(C.normalizeMessage('a'.repeat(100)).length, 80, 'input is 80 characters, as the reference');
  assert.strictEqual(J.pack('').nframes, 0);
});

test('limits: more than 16 frames is refused; RTTY normalization past 80 characters is refused', () => {
  assert.strictEqual(J.pack('X'.repeat(80) + 'Y').ok, true, '80 TEXT5 characters = 16 frames exactly');
  assert.strictEqual(J.pack('X'.repeat(80)).nframes, 16);
  // TEXT5 carries spaces too: 17 two-letter words are 50 characters, 10 frames.
  assert.strictEqual(J.pack('XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX').nframes, 10);
  const long = ('599 5 ').repeat(13) + 'ABCDEFGHIJKLM'; // 13 serials grow by two chars each
  assert.strictEqual(C.normalizeMessage(long).length <= 80, true);
  assert.strictEqual(J.pack(long, 'rtty-roundup').ok, false, 'normalization expanded it past 80');
});

// ---- callsigns ----------------------------------------------------------------
test('standard calls are exactly what FT8\'s 28-bit field carries', () => {
  for (const c of ['K1ABC', 'KA1ABC', 'W1A', 'JA6DEF', 'WB9XYZ', '1A2BC', 'VK2ABC', 'A61A']) assert.ok(C.isStandardCall(c), c);
  // K12ABC IS standard: a two-character prefix may hold a digit (4U1ITU).
  assert.ok(C.isStandardCall('K12ABC'));
  for (const c of ['PJ4/KA1ABC', 'K1ABC/P', 'QU1RK', 'Q1AB', '3DA0AB', 'K1ABCD', 'KA1', '12ABC', 'AB', 'K1ABC1', 'k1abc', '']) {
    assert.ok(!C.isStandardCall(c), c + ' must not be standard');
  }
  for (const c of ['K1ABC', 'KA1ABC', 'W1A', '1A2BC']) assert.strictEqual(C.unpack28(C.pack28(c)), c, c + ' round trip');
});

// ---- sections ------------------------------------------------------------------
test('the ARRL section table is rc1\'s 86 entries (GH, NS, TER; PE and NB), not FT8\'s 84', () => {
  assert.strictEqual(C.ARRL_SECTIONS.length, 86);
  assert.strictEqual(C.ARRL_SECTIONS[15], 'GH');
  assert.strictEqual(C.ARRL_SECTIONS[24], 'NS');
  assert.strictEqual(C.ARRL_SECTIONS[43], 'TER');
  assert.deepStrictEqual(C.ARRL_SECTIONS.slice(83), ['DX', 'PE', 'NB']);
  assert.strictEqual(C.sectionIndex('EMA'), 11);
  assert.strictEqual(C.sectionIndex('NB'), 86);
  assert.strictEqual(C.sectionIndex('XYZ'), -1);
  assert.strictEqual(J.pack('1D NB').nframes, 1);
  assert.strictEqual(J.pack('1D XYZ').nframes, 2, 'an unknown section is text');
});

// ---- channel coding ------------------------------------------------------------
test('CRC-12 matches an independent polynomial division (x^12 + 0x80F)', () => {
  const GEN = 0x180Fn;
  for (let trial = 0; trial < 200; trial++) {
    const bitsArr = Array.from({ length: 34 }, () => (Math.random() < 0.5 ? 1 : 0));
    let v = 0n;
    for (const b of bitsArr) v = (v << 1n) | BigInt(b);
    v <<= 12n;
    for (let i = 45; i >= 12; i--) if ((v >> BigInt(i)) & 1n) v ^= GEN << BigInt(i - 12);
    const want = Array.from({ length: 12 }, (_, i) => Number((v >> BigInt(11 - i)) & 1n));
    assert.deepStrictEqual(F.crc12(bitsArr), want);
  }
});

test('TBCC: K=10 generators 1167/1545, tail-biting, Gray tones, linear', () => {
  assert.strictEqual(F.G0, 0x277); assert.strictEqual(F.G1, 0x365);
  assert.deepStrictEqual(F.SYNC, [0, 2, 2, 3, 0, 0, 3, 2, 1, 3, 1, 2, 0]);
  const toBits = (tones) => tones.flatMap((t) => [[0, 0], [0, 1], [1, 1], [1, 0]][t]);
  const rnd = () => Array.from({ length: 46 }, () => (Math.random() < 0.5 ? 1 : 0));
  for (let trial = 0; trial < 100; trial++) {
    const a = rnd(), b = rnd();
    const ab = a.map((x, i) => x ^ b[i]);
    const ea = toBits(F.tbccEncodeInfo(a)), eb = toBits(F.tbccEncodeInfo(b)), eab = toBits(F.tbccEncodeInfo(ab));
    assert.deepStrictEqual(eab, ea.map((x, i) => x ^ eb[i]), 'a convolutional code is linear over GF(2)');
  }
  assert.deepStrictEqual(F.tbccEncodeInfo(new Array(46).fill(0)), new Array(46).fill(0), 'all-zero codeword');
  // Tail-biting: the state after the whole frame equals the starting state.
  const info = rnd();
  let state = 0;
  for (let t = 0; t < 9; t++) state = ((state << 1) | info[37 + t]) & 511;
  const start = state;
  for (let t = 0; t < 46; t++) state = ((state << 1) | info[t]) & 511;
  assert.strictEqual(state, start);
  const tones = F.framesToTones(J.pack('CQ K1ABC CQ').frames);
  assert.strictEqual(tones.length, 59);
  // The 59 channel symbols WSJT-X's own sjtty (v3.2.0-rc1, built from source)
  // prints for this message: sync + CRC-12 + TBCC + Gray map, end to end.
  assert.strictEqual(tones.join(' '), '0 2 2 3 0 0 3 2 1 3 1 2 0 2 0 3 2 0 3 3 0 2 3 2 2 3 1 0 0 1 2 2 3 0 0 3 0 0 3 3 3 3 3 3 2 0 1 3 0 0 3 1 0 2 1 3 2 2 3', 'differs from sjtty');
  assert.deepStrictEqual(tones.slice(0, 13), F.SYNC);
  assert.ok(tones.every((t) => t >= 0 && t <= 3));
});

// ---- waveform -------------------------------------------------------------------
test('waveform: 384 samples per symbol at 12 kHz, peak 1.0, ramped ends, every symbol recoverable', () => {
  const e = J.encode('TU NOW JA6DEF 599 102', { f0: 1500 });
  assert.ok(e.ok);
  assert.strictEqual(e.nframes, 2);
  assert.strictEqual(e.tones.length, 118);
  assert.strictEqual(e.pcm.length, 118 * 384);
  assert.strictEqual(e.durationSec, 2 * 59 / 31.25);
  let peak = 0; for (const v of e.pcm) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1.0 && peak > 0.99, 'peak ' + peak);
  assert.strictEqual(e.pcm[0], 0, 'ramp starts at zero');
  assert.ok(Math.abs(e.pcm[e.pcm.length - 1]) < 0.02, 'ramp ends near zero');
  const fs = 12000, nsps = 384;
  let wrong = 0;
  for (let s = 0; s < e.tones.length; s++) {
    let best = -1, bestE = -1;
    for (let t = 0; t < 4; t++) {
      const f = 1500 + t * 31.25; let re = 0, im = 0;
      for (let i = 0; i < nsps; i++) {
        const ph = 2 * Math.PI * f * (s * nsps + i) / fs;
        re += e.pcm[s * nsps + i] * Math.cos(ph); im += e.pcm[s * nsps + i] * Math.sin(ph);
      }
      const en = re * re + im * im; if (en > bestE) { bestE = en; best = t; }
    }
    if (best !== e.tones[s]) wrong++;
  }
  assert.strictEqual(wrong, 0, wrong + ' symbols misread from our own waveform');
  assert.throws(() => W.generateWaveform([0], { sampleRate: 44100 }), /multiple of 31.25/);
  assert.ok(Math.abs(W.gfskPulse(2, 0) - 0.99996) < 1e-4, 'the GFSK pulse is ~1 at its centre for BT=2');
  assert.ok(Math.abs(W.erf(0.5) - 0.5204999) < 1e-6);
});

console.log(`\nJTTY codec: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
