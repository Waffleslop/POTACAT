#!/usr/bin/env node
'use strict';
// APRS: our own AFSK demodulator (lib/afsk-demod.js), with no radio and no
// network. The audio is generated here (test/afsk-gen.js): AX.25 UI frames,
// bit-stuffed, NRZI, phase-continuous AFSK, plus seeded white noise, so every
// run hears exactly the same thing.
//
// Covers: 1200 and 300 baud on tune; 300 baud 50, 70 and 100 Hz off tune
// either way; white noise at several SNRs with a locked floor per step (a
// regression fails); twist and clock error; a bad FCS never decoded; bit
// stuffing at its edges; an abort; flags only; a truncated frame; frames back
// to back; 12 and 48 kHz (and 44.1 kHz); copies from several decoders dropped;
// the three frames heard on 30 m on 2026-11-18; and the CPU cost per second
// of audio, printed.
// Run: node test/afsk-demod-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/afsk-demod');
const G = require('./afsk-gen');
const AprsParser = require('../lib/aprs-parser');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}

/** Decode a list of Float32 chunks; returns the frames. */
function decode(chunks, opts) {
  const d = A.createDemod(opts);
  const got = [];
  d.onFrame((f) => got.push(f));
  for (const c of chunks) d.push(c);
  return { got, stats: d.stats() };
}
function tones(tnc2List, gen, frameOpts) {
  return tnc2List.map((t) => G.afsk(G.bits(G.frame(t, frameOpts)), gen));
}
const numbered = (i) => `K${i % 10}ABC-${(i % 15) + 1}>APRS,WIDE2-1:!4140.${String(i % 60).padStart(2, '0')}N/07243.00W>frame ${i} of the test run`;

const PACKETS = [
  'W1AW-9>APRS:!4140.00N/07243.00W>30 m direct',
  'K3SBP-7>APDR16,KB1XYZ-1*,WIDE2-1:=3958.21N/07510.47W-30 m via a digipeater',
];

// Heard on 30 m by the FLEX-8600M on 2026-11-18, 20:15-20:17 UTC, as Dire Wolf
// printed them (ops report, 90-minute listen). The third line is the report's
// own text, which ends in "..." where it was shortened there.
const HEARD_2026_11_18 = [
  'W4TTU-10>APOT30:!3902.63N/07722.47W&RPi4',
  'VE2SIL-1>APU25N:=4530.50N\\07347.78W-aprs 10.1476 uhf {UIV32N}',
  'VE2SIL-1>APU25N:>182016zDX: WB8SKP-8 36.44.04N 88.07.80W 959.8 miles ...',
];

console.log('AFSK demodulator (lib/afsk-demod.js): generated audio, no radio');

// ── Pieces ───────────────────────────────────────────────────────────────
test('CRC-16/X.25 of "123456789" is 0x906E (the published check value)', () => {
  const b = Uint8Array.from('123456789', (c) => c.charCodeAt(0));
  assert.strictEqual(A.crc16x25(b), 0x906e);
  assert.strictEqual(A.crc16x25(b), G.fcs(b), 'the table and the bitwise CRC agree');
});

test('AX.25 address field to TNC2: SSIDs, digipeaters, the last repeated one starred', () => {
  // The generator sets the H bit on every digipeater up to the starred one;
  // TNC2 stars only the last of them.
  for (const t of [...PACKETS, ...HEARD_2026_11_18, 'N0CALL>APRS,WIDE1-1,WIDE2*,WIDE3-3:>status']) {
    const fr = G.frame(t);
    assert.ok(A.fcsOk(fr), 'FCS of ' + t);
    const u = A.ax25ToTnc2(fr.subarray(0, fr.length - 2));
    assert.strictEqual(u.tnc2, t);
    assert.strictEqual(u.pid, 0xf0);
  }
});

test('the address decoder refuses junk (lower case, a character after padding, no end bit)', () => {
  const good = G.frame('W1AW>APRS:x');
  const body = good.subarray(0, good.length - 2);
  assert.ok(A.ax25ToTnc2(body));
  const lower = body.slice(); lower[7] = 'w'.charCodeAt(0) << 1;
  assert.strictEqual(A.ax25ToTnc2(lower), null);
  const gap = body.slice(); gap[8] = 0x40; gap[9] = 'Z'.charCodeAt(0) << 1; // 'W', ' ', 'Z'
  assert.strictEqual(A.ax25ToTnc2(gap), null);
  const noEnd = body.slice(); noEnd[13] &= 0xfe; // the source no longer ends the field
  assert.strictEqual(A.ax25ToTnc2(noEnd), null);
});

test('the core is Hermes-safe: no require, Buffer, process, WebAssembly or SharedArrayBuffer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'afsk-demod.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const bad of ['require(', 'Buffer', 'process.', 'WebAssembly', 'SharedArrayBuffer', 'Atomics']) {
    assert.ok(!src.includes(bad), bad);
  }
  assert.ok(/root\.AfskDemod = api/.test(src), 'window.AfskDemod in a page');
});

// ── Clean audio ──────────────────────────────────────────────────────────
const HUNDRED = Array.from({ length: 100 }, (_, i) => numbered(i));

test('1200 baud at 12 kHz: 100 frames in, 100 out, text exact', () => {
  const { got } = decode(tones(HUNDRED, { mode: '1200', rate: 12000 }), { sampleRate: 12000, mode: '1200' });
  assert.deepStrictEqual(got.map((f) => f.tnc2), HUNDRED);
});

test('300 baud at 12 kHz on tune: 100 frames in, 100 out, text exact', () => {
  const { got } = decode(tones(HUNDRED, { mode: '300', rate: 12000 }), { sampleRate: 12000, mode: '300' });
  assert.deepStrictEqual(got.map((f) => f.tnc2), HUNDRED);
});

for (const rate of [48000, 44100]) {
  test(`${rate / 1000} kHz input (decimated inside): both modes decode`, () => {
    for (const mode of ['1200', '300']) {
      const { got, stats } = decode(tones(PACKETS, { mode, rate }), { sampleRate: rate, mode });
      assert.deepStrictEqual(got.map((f) => f.tnc2), PACKETS, mode);
      assert.ok(stats.workRate >= 12000 && stats.workRate <= 15000, 'working rate ' + stats.workRate);
    }
  });
}

for (const shift of [50, -50, 70, -70, 100, -100]) {
  test(`300 baud ${shift > 0 ? '+' : ''}${shift} Hz off tune: 10 frames, all decoded (7 decoders at 30 Hz)`, () => {
    const list = HUNDRED.slice(0, 10);
    const { got, stats } = decode(tones(list, { mode: '300', rate: 12000, shiftHz: shift }), { sampleRate: 12000, mode: '300' });
    assert.deepStrictEqual(got.map((f) => f.tnc2), list);
    assert.deepStrictEqual(stats.offsetsHz, [-90, -60, -30, 0, 30, 60, 90]);
  });
}

test('300 baud 200 Hz off tune: nothing with the default span, decoded with 15 decoders (the most allowed)', () => {
  const a = tones(PACKETS, { mode: '300', rate: 12000, shiftHz: 200 });
  assert.strictEqual(decode(a, { sampleRate: 12000, mode: '300' }).got.length, 0);
  assert.strictEqual(decode(a, { sampleRate: 12000, mode: '300', span: { decoders: 15, stepHz: 30 } }).got.length, 2);
});

test('1200 baud with FM twist, mark +6 dB and -6 dB: decoded (the weighted slicers)', () => {
  for (const tw of [6, -6, 9, -9]) {
    const { got } = decode(tones(HUNDRED.slice(0, 10), { mode: '1200', rate: 12000, twistDb: tw }), { sampleRate: 12000, mode: '1200' });
    assert.strictEqual(got.length, 10, 'twist ' + tw + ' dB');
  }
});

test('the sender\'s clock 1% fast or slow: decoded at both baud rates', () => {
  for (const mode of ['1200', '300']) for (const clock of [1.01, 0.99]) {
    const { got } = decode(tones(HUNDRED.slice(0, 10), { mode, rate: 12000, clock }), { sampleRate: 12000, mode });
    assert.strictEqual(got.length, 10, `${mode} baud, clock x${clock}`);
  }
});

test('any chunk size gives the same frames (1, 7, 333 and 4096 samples a push)', () => {
  const audio = G.join(tones(PACKETS, { mode: '1200', rate: 12000 }));
  for (const size of [1, 7, 333, 4096]) {
    const d = A.createDemod({ sampleRate: 12000, mode: '1200' });
    const got = [];
    d.onFrame((f) => got.push(f.tnc2));
    for (let i = 0; i < audio.length; i += size) d.push(audio.subarray(i, i + size));
    assert.deepStrictEqual(got, PACKETS, 'chunk ' + size);
  }
});

test('a frame carries its bytes, FCS, decoder, slicer and time; the parser reads its TNC2', () => {
  const { got } = decode(tones([PACKETS[1]], { mode: '1200', rate: 12000, lead: 1 }), { sampleRate: 12000, mode: '1200' });
  const f = got[0];
  assert.strictEqual(f.from, 'K3SBP-7');
  assert.deepStrictEqual(f.path, ['KB1XYZ-1*', 'WIDE2-1']);
  const fr = G.frame(PACKETS[1]);
  assert.deepStrictEqual(Array.from(f.bytes), Array.from(fr.subarray(0, fr.length - 2)));
  assert.strictEqual(f.fcs, fr[fr.length - 2] | (fr[fr.length - 1] << 8));
  assert.ok(f.time > 1.5 && f.time < 1.8, 'time ' + f.time); // 1 s lead + 24 flags + the frame
  const p = AprsParser.parse(f.tnc2);
  assert.strictEqual(p.type, 'position');
  assert.ok(Math.abs(p.lat - 39.97) < 0.01);
});

// ── What must never come out ─────────────────────────────────────────────
test('a bad FCS is never delivered, at either baud rate, and is counted', () => {
  for (const mode of ['1200', '300']) {
    const audio = [
      ...tones([PACKETS[0]], { mode, rate: 12000 }, { badFcs: true }),
      ...tones([PACKETS[1]], { mode, rate: 12000 }),
    ];
    const { got, stats } = decode(audio, { sampleRate: 12000, mode });
    assert.deepStrictEqual(got.map((f) => f.tnc2), [PACKETS[1]], mode);
    assert.ok(stats.fcsFail >= 1, 'fcsFail ' + stats.fcsFail);
  }
});

test('flags only, silence and noise alone: nothing', () => {
  const flags = [];
  for (let i = 0; i < 400; i++) for (let k = 0; k < 8; k++) flags.push((0x7e >> k) & 1);
  assert.strictEqual(decode([G.afsk(flags, { mode: '1200', rate: 12000 })], { sampleRate: 12000, mode: '1200' }).got.length, 0);
  assert.strictEqual(decode([new Float32Array(12000 * 5)], { sampleRate: 12000, mode: '300' }).got.length, 0);
  const n = G.addNoise(new Float32Array(12000 * 60), { snrDb: 0, rate: 12000, seed: 99 });
  assert.strictEqual(decode([n], { sampleRate: 12000, mode: '1200' }).got.length, 0, '60 s of noise, 1200');
  assert.strictEqual(decode([n], { sampleRate: 12000, mode: '300' }).got.length, 0, '60 s of noise, 300');
});

test('a truncated frame (cut mid-way, then flags) is dropped; the next one is not', () => {
  const fr = G.frame(PACKETS[1]);
  const bitsCut = [];
  for (let i = 0; i < 24; i++) for (let k = 0; k < 8; k++) bitsCut.push((0x7e >> k) & 1);
  G.stuffed(fr.subarray(0, 30), bitsCut);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) bitsCut.push((0x7e >> k) & 1);
  const audio = [G.afsk(bitsCut, { mode: '1200', rate: 12000 }), ...tones([PACKETS[0]], { mode: '1200', rate: 12000 })];
  assert.deepStrictEqual(decode(audio, { sampleRate: 12000, mode: '1200' }).got.map((f) => f.tnc2), [PACKETS[0]]);
});

test('an abort (seven 1s) in the middle of a frame drops it; the next frame decodes', () => {
  const b = [];
  for (let i = 0; i < 24; i++) for (let k = 0; k < 8; k++) b.push((0x7e >> k) & 1);
  G.stuffed(G.frame(PACKETS[1]).subarray(0, 40), b);
  for (let i = 0; i < 9; i++) b.push(1);
  const audio = [G.afsk(b, { mode: '1200', rate: 12000 }), ...tones([PACKETS[0]], { mode: '1200', rate: 12000 })];
  assert.deepStrictEqual(decode(audio, { sampleRate: 12000, mode: '1200' }).got.map((f) => f.tnc2), [PACKETS[0]]);
});

test('HDLC alone: shortest frame (18 bytes) kept, 17 bytes dropped, 331 bytes dropped', () => {
  const run = (bytes) => {
    const out = [];
    const h = A.createHdlc((f) => out.push(f));
    const push = (bitList) => bitList.forEach((x) => h.bit(x));
    const flag = [0, 1, 1, 1, 1, 1, 1, 0];
    push(flag); push(G.stuffed(bytes)); push(flag);
    return out;
  };
  const withFcs = (body) => { const c = G.fcs(body); return Uint8Array.from([...body, c & 0xff, c >> 8]); };
  assert.strictEqual(run(withFcs(new Uint8Array(16).fill(0x41))).length, 1);
  assert.strictEqual(run(withFcs(new Uint8Array(15).fill(0x41))).length, 0);
  assert.strictEqual(run(withFcs(new Uint8Array(329).fill(0x41))).length, 0);
  assert.strictEqual(run(withFcs(new Uint8Array(328).fill(0x41))).length, 1);
});

test('bit stuffing at its edges: 0x7E, 0xFF, 0x1F/0xF8 runs across bytes, a 256-byte info field', () => {
  const infos = [
    '~~~~~~~~',                                   // 0x7E, a flag's pattern, as data
    '\xff\xff\xff\xff',                           // every bit a 1: a stuffed 0 every five
    '\x1f\xf8\x1f\xf8\x3e\x7c\xf8\x01',           // runs of five and six 1s across byte boundaries
    '\x7f\xfe\xbf\xfd',
    'x'.repeat(10) + '\xff'.repeat(5) + '~'.repeat(5) + '|>',
    Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join(''), // every byte value
  ];
  for (const mode of ['1200', '300']) {
    const list = infos.map((s) => 'N0CALL-1>APRS:' + s);
    const { got } = decode(tones(list, { mode, rate: 12000 }), { sampleRate: 12000, mode });
    assert.deepStrictEqual(got.map((f) => f.info), infos, mode);
  }
});

test('frames back to back, one shared flag between them: all five decoded, in order', () => {
  for (const mode of ['1200', '300']) {
    const list = HUNDRED.slice(20, 25);
    const b = G.bitsMany(list.map((t) => G.frame(t)), { between: 1 });
    const { got } = decode([G.afsk(b, { mode, rate: 12000 })], { sampleRate: 12000, mode });
    assert.deepStrictEqual(got.map((f) => f.tnc2), list, mode);
  }
});

test('copies from several decoders are one frame; a second, different copy is not a duplicate', () => {
  const { got, stats } = decode(tones([PACKETS[0]], { mode: '300', rate: 12000 }), { sampleRate: 12000, mode: '300' });
  assert.strictEqual(got.length, 1);
  assert.ok(stats.dupes >= 1, 'several decoders heard it: dupes ' + stats.dupes);
  // The same packet digipeated (H bit set) is a different frame and comes through.
  const two = decode(tones([PACKETS[0].replace('>APRS:', '>APRS,W3XYZ-1*:'), PACKETS[0]], { mode: '1200', rate: 12000 }), { sampleRate: 12000, mode: '1200' });
  assert.strictEqual(two.got.length, 2);
});

test('the same frame again after the dedupe window is delivered again', () => {
  const gap = new Float32Array(12000 * 1.5);
  const a = tones([PACKETS[0]], { mode: '1200', rate: 12000 });
  assert.strictEqual(decode([a[0], gap, a[0]], { sampleRate: 12000, mode: '1200' }).got.length, 2);
  assert.strictEqual(decode([a[0], a[0]], { sampleRate: 12000, mode: '1200' }).got.length, 1, 'within 1 s: one');
});

test('onFrame returns an unsubscribe; a throwing listener does not stop the others', () => {
  const d = A.createDemod({ sampleRate: 12000, mode: '1200' });
  const seen = [];
  d.onFrame(() => { throw new Error('listener fault'); });
  const off = d.onFrame((f) => seen.push('a:' + f.from));
  d.onFrame((f) => seen.push('b:' + f.from));
  d.push(tones([PACKETS[0]], { mode: '1200', rate: 12000 })[0]);
  off();
  d.push(tones([PACKETS[1]], { mode: '1200', rate: 12000 })[0]);
  assert.deepStrictEqual(seen, ['a:W1AW-9', 'b:W1AW-9', 'b:K3SBP-7']);
});

test('bad options are refused; odd input is harmless', () => {
  assert.throws(() => A.createDemod({ sampleRate: 12000, mode: '9600' }), /1200 or 300/);
  assert.throws(() => A.createDemod({ sampleRate: 1000, mode: '1200' }), /out of range/);
  const d = A.createDemod({ sampleRate: 12000, mode: 300 });
  d.push(null); d.push(new Float32Array(0)); d.push(Float32Array.from([NaN, Infinity, -Infinity, 1e30]));
  d.push([0.1, -0.1, 0.2]); // a plain array works too
  assert.strictEqual(d.stats().frames, 0);
});

// ── The three frames heard on 30 m, 2026-11-18 ───────────────────────────
test('the three frames heard on 30 m on 2026-11-18: encoded, then decoded, exact (12 and 48 kHz)', () => {
  for (const rate of [12000, 48000]) {
    const { got } = decode(tones(HEARD_2026_11_18, { mode: '300', rate, shiftHz: 20 }), { sampleRate: rate, mode: '300' });
    assert.deepStrictEqual(got.map((f) => f.tnc2), HEARD_2026_11_18, rate + ' Hz');
    const p = got.map((f) => AprsParser.parse(f.tnc2));
    assert.strictEqual(p[0].type, 'position');
    assert.ok(Math.abs(p[0].lat - 39.0438) < 0.001 && Math.abs(p[0].lon + 77.3745) < 0.001);
    assert.strictEqual(p[1].type, 'position');
    assert.ok(Math.abs(p[1].lat - 45.5083) < 0.001 && Math.abs(p[1].lon + 73.7963) < 0.001);
    assert.strictEqual(p[2].type, 'status');
  }
});

test('the same three frames in noise (300 baud, 4 dB SNR in 3 kHz, 60 Hz off): all decoded', () => {
  const a = tones(HEARD_2026_11_18, { mode: '300', rate: 12000, shiftHz: -60, lead: 0.5, tail: 0.5 });
  a.forEach((x, i) => G.addNoise(x, { snrDb: 4, rate: 12000, seed: 1118 + i }));
  assert.strictEqual(decode(a, { sampleRate: 12000, mode: '300' }).got.length, 3);
});

// ── White noise: decode rate per SNR, with locked floors ─────────────────
// SNR is in a 3 kHz bandwidth. 40 frames per step, fixed seeds, so the counts
// are the same every run; each floor sits a few frames under the measured
// count (measured 2026-11-18, printed below) so a regression fails.
const NOISE = {
  1200: { snr: [12, 10, 8, 7, 6, 5], floor: [40, 40, 38, 33, 22, 5] },
  300: { snr: [8, 6, 4, 2, 1, 0], floor: [40, 40, 40, 38, 33, 30] },
};
const noiseRates = {};
for (const mode of ['1200', '300']) {
  test(`${mode} baud in white noise: decode rate per SNR at or above the floor`, () => {
    const cfg = NOISE[mode];
    const rows = [];
    cfg.snr.forEach((snr, k) => {
      const list = Array.from({ length: 40 }, (_, i) => numbered(i + 200));
      const a = tones(list, { mode, rate: 12000, lead: 0.3, tail: 0.3 });
      a.forEach((x, i) => G.addNoise(x, { snrDb: snr, rate: 12000, seed: 7000 + i + 97 * snr + (mode === '300' ? 50000 : 0) }));
      const { got } = decode(a, { sampleRate: 12000, mode });
      const ok = got.filter((f) => list.includes(f.tnc2)).length;
      assert.strictEqual(got.length, ok, 'a frame that was never sent came out');
      rows.push([snr, ok, cfg.floor[k]]);
    });
    noiseRates[mode] = rows;
    for (const [snr, ok, floor] of rows) assert.ok(ok >= floor, `${snr} dB: ${ok}/40, floor ${floor}`);
  });
}

// ── CPU ──────────────────────────────────────────────────────────────────
const cpu = [];
test('CPU per second of audio, each mode, 12 and 48 kHz (printed; under 100 ms each)', () => {
  for (const mode of ['1200', '300']) for (const rate of [12000, 48000]) {
    const audio = G.join(tones(HUNDRED.slice(0, mode === '1200' ? 60 : 15), { mode, rate }));
    G.addNoise(audio, { snrDb: 10, rate, seed: 5 });
    const d = A.createDemod({ sampleRate: rate, mode });
    const step = rate / 50; // 20 ms pushes, as audio arrives
    for (let i = 0; i < rate; i += step) d.push(audio.subarray(i, i + step)); // warm up the JIT
    const d2 = A.createDemod({ sampleRate: rate, mode });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < audio.length; i += step) d2.push(audio.subarray(i, i + step));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const perSec = ms / (audio.length / rate);
    cpu.push(`${mode} baud @ ${rate / 1000} kHz: ${perSec.toFixed(1)} ms per s of audio (${d2.stats().decoders} decoder(s) x ${d2.stats().slicers} slicer(s))`);
    assert.ok(perSec < 100, cpu[cpu.length - 1]);
  }
});

console.log('\n  decode rate in white noise (40 frames a step, SNR in 3 kHz):');
for (const mode of Object.keys(noiseRates)) {
  console.log(`    ${mode} baud: ` + noiseRates[mode].map(([s, ok]) => `${s} dB ${ok}/40`).join(', '));
}
console.log('  CPU on this machine:');
for (const line of cpu) console.log('    ' + line);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
