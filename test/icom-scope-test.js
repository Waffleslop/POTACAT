#!/usr/bin/env node
'use strict';
/**
 * An Icom's own band scope over CI-V (docs/icom-band-scope-plan.md), step 1:
 * the parser, the codec events, and the 30 s recording an owner sends us.
 * Frames here are built from Icom's CI-V references and Hamlib's parser; a
 * real radio's capture replaces them when one arrives.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/icom-scope');
const { CivCodec } = require('../lib/codecs/civ-codec');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
// A whole CI-V frame from the radio (0x94) to the controller (0xE0).
const civ = (cmd, body) => Buffer.from([0xFE, 0xFE, 0xE0, 0x94, cmd, ...body, 0xFD]);
// The pieces of one sweep, as the radio sends them over USB (11) or the network (1).
function sweepPayloads({ mode = 0, a = 14074000, b = 25000, points = 475, divisions = 11, level = (i) => (i === 237 ? 160 : 20), oor = false } = {}) {
  const data = Array.from({ length: points }, (_, i) => level(i));
  const head = [0x00, bcd(1), bcd(divisions), mode, ...S.freqBcd(a), ...S.freqBcd(b), oor ? 0x01 : 0x00];
  if (divisions === 1) return [[0x00, ...head.slice(1), ...(oor ? [] : data)]];
  const out = [head];
  const per = Math.ceil(points / (divisions - 1));
  for (let d = 2; d <= divisions; d++) out.push([0x00, bcd(d), bcd(divisions), ...data.slice((d - 2) * per, (d - 1) * per)]);
  return out;
}
const toFrames = (payloads) => payloads.map((p) => civ(0x27, [0x00, ...p]));

console.log('BCD');
check('5-byte frequency both ways, least significant byte first', () => {
  assert.deepStrictEqual(S.freqBcd(14074000), [0x00, 0x40, 0x07, 0x14, 0x00]);
  assert.strictEqual(S.bcdFreq(S.freqBcd(14074000)), 14074000);
  assert.strictEqual(S.bcdFreq(S.freqBcd(1296000000)), 1296000000);
  assert.strictEqual(S.bcdByte(0x11), 11);
});
check('the IC-7300 marks a negative lower edge with an F nibble', () => {
  assert.strictEqual(S.bcdFreq([0x00, 0x50, 0x02, 0x00, 0xF0]), -25000);
});

console.log('A sweep');
check('over USB: 11 frames, a header then 50 points each, make one 475-point sweep', () => {
  const asm = new S.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  for (const p of sweepPayloads()) asm.feed(S.parseScopeFrame(Buffer.from(p)));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].levels.length, 475);
  assert.strictEqual(got[0].levels[237], 160);
  assert.strictEqual(got[0].header.modeName, 'center');
});
check('Center mode: centre and HALF the span (Hamlib doubles it)', () => {
  const f = S.parseScopeFrame(Buffer.from(sweepPayloads({ a: 7074000, b: 50000 })[0]));
  assert.strictEqual(f.header.centerHz, 7074000);
  assert.strictEqual(f.header.spanHz, 100000);
  assert.strictEqual(f.header.lowHz, 7024000);
  assert.deepStrictEqual(S.axisFor(f.header), { anchor: 'center', centerHz: 7074000, spanHz: 100000 });
});
check('Fixed mode: the two edges, and the axis is still known', () => {
  const f = S.parseScopeFrame(Buffer.from(sweepPayloads({ mode: 1, a: 14000000, b: 14350000 })[0]));
  assert.strictEqual(f.header.modeName, 'fixed');
  assert.strictEqual(f.header.spanHz, 350000);
  assert.deepStrictEqual(S.axisFor(f.header), { anchor: 'fixed', centerHz: 14175000, spanHz: 350000 });
});
check('over the network: one frame is the whole sweep (689 points on a 7610)', () => {
  const asm = new S.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  asm.feed(S.parseScopeFrame(Buffer.from(sweepPayloads({ divisions: 1, points: 689 })[0])));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].levels.length, 689);
});
check('out of range: a sweep with no data, marked empty', () => {
  const asm = new S.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  asm.feed(S.parseScopeFrame(Buffer.from(sweepPayloads({ divisions: 1, oor: true })[0])));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].empty, true);
});
check('a sweep cut short is dropped, and the next one still assembles', () => {
  const asm = new S.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  const p = sweepPayloads();
  for (const x of p.slice(0, 5)) asm.feed(S.parseScopeFrame(Buffer.from(x)));
  for (const x of p) asm.feed(S.parseScopeFrame(Buffer.from(x)));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(asm.dropped, 1);
  // A piece arriving with no header before it is ignored.
  asm.feed(S.parseScopeFrame(Buffer.from(p[3])));
  assert.strictEqual(got.length, 1);
});

console.log('To the scope frame every source produces');
check('475 points to 850 levels: a one-point carrier keeps its full height and its place', () => {
  const levels = new Uint8Array(475).fill(20);
  levels[237] = 160;
  const f = S.toScopeFrame(levels, { levelMax: 160 });
  assert.strictEqual(f.wf1.length, 850);
  assert.strictEqual(f.aligned, true);
  const peak = f.wf1.indexOf(Math.max(...f.wf1));
  assert.ok(Math.abs(peak - Math.round(237 * 849 / 474)) <= 1, 'peak at ' + peak);
  assert.strictEqual(Math.max(...f.wf1), 255);
  assert.strictEqual(f.wf1[0], Math.round(20 * 255 / 160));
});
check('a 7610 level of 200 is full scale too', () => {
  assert.strictEqual(S.toScopeFrame(Uint8Array.from([200, 200]), { levelMax: 200 }).wf1[425], 255);
});
check('the models: 475/160 for the 7300 family, 689/200 for the 7610 and 7851; the 7760 marked unverified', () => {
  assert.strictEqual(S.scopeModelFor('IC-7300').points, 475);
  assert.strictEqual(S.scopeModelFor('IC-705').levelMax, 160);
  assert.strictEqual(S.scopeModelFor('IC-7610').points, 689);
  assert.strictEqual(S.scopeModelFor('IC-7760').unverified, true);
  assert.strictEqual(S.scopeModelFor('IC-7100'), null, 'no scope');
  const models = require('../lib/rig-models');
  const list = models.RIG_MODELS || models;
  for (const name of Object.keys(S.MODELS)) if (name !== 'IC-905') assert.ok(list[name], name + ' is a POTACAT rig model');
});

console.log('The writes');
check('scope on, output on, mode and span, byte for byte; the span is sent as half', () => {
  assert.deepStrictEqual(S.write.scopeOn(true), [0x10, 0x01]);
  assert.deepStrictEqual(S.write.output(false), [0x11, 0x00]);
  assert.deepStrictEqual(S.write.mode(0), [0x14, 0x00, 0x00]);
  assert.deepStrictEqual(S.write.span(100000), [0x15, 0x00, ...S.freqBcd(50000)]);
  assert.deepStrictEqual(S.read.span(), [0x15, 0x00]);
});
check('replies: on/off, mode, span (doubled back to the full width)', () => {
  assert.deepStrictEqual(S.parseScopeStatus(Buffer.from([0x11, 0x01])), { sub: 0x11, on: true });
  assert.strictEqual(S.parseScopeStatus(Buffer.from([0x14, 0x00, 0x01])).modeName, 'fixed');
  assert.strictEqual(S.parseScopeStatus(Buffer.from([0x15, 0x00, ...S.freqBcd(25000)])).spanHz, 50000);
});
check('POTACAT never writes the waveform (27 00) or the operator\'s fixed edges (27 1E)', () => {
  for (const [k, fn] of Object.entries(S.write)) {
    const sub = fn(true)[0];
    assert.ok(sub !== 0x00 && sub !== 0x1E, k);
  }
});

console.log('The CI-V codec');
function codec() {
  const sent = [];
  const c = new CivCodec({ civAddr: 0x94 }, (b) => sent.push(Buffer.from(b)));
  const ev = { data: [], status: [], nak: [], log: [] };
  c.on('scope-data', (p, f) => ev.data.push({ p, f }));
  c.on('scope-status', (p) => ev.status.push(p));
  c.on('scope-nak', (s) => ev.nak.push(s));
  c.on('log', (m) => ev.log.push(m));
  return { c, sent, ev };
}
check('a USB sweep arriving in one burst comes out as 11 scope-data events, none logged as unhandled', () => {
  const { c, ev } = codec();
  c.onData(Buffer.concat(toFrames(sweepPayloads())));
  assert.strictEqual(ev.data.length, 11);
  assert.strictEqual(ev.data[0].p[1], 0x01, 'the payload starts at the scope id');
  assert.ok(!ev.log.some((m) => /unhandled/.test(m)), ev.log.join(' | '));
  const asm = new S.SweepAssembler();
  let n = 0;
  asm.on('sweep', () => n++);
  for (const d of ev.data) asm.feed(S.parseScopeFrame(d.p));
  assert.strictEqual(n, 1);
});
check('a frame split across reads still lands whole', () => {
  const { c, ev } = codec();
  const all = Buffer.concat(toFrames(sweepPayloads({ divisions: 1 })));
  c.onData(all.subarray(0, 100));
  c.onData(all.subarray(100));
  assert.strictEqual(ev.data.length, 1);
  assert.strictEqual(ev.data[0].p.length, 3 + 12 + 475);
});
check('sendScope writes FE FE 94 E0 27 <sub> <data> FD; a NAK after it is a scope NAK, not a CI-V fault', () => {
  const { c, sent, ev } = codec();
  c.sendScope(S.write.output(true));
  assert.strictEqual(sent[0].toString('hex'), 'fefe94e02711' + '01fd');
  c.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0xFA, 0xFD]));
  assert.deepStrictEqual(ev.nak, [0x11]);
  c.sendScope(S.read.mode());
  c.onData(civ(0x27, [0x14, 0x00, 0x01]));
  assert.strictEqual(ev.status.length, 1);
  assert.strictEqual(S.parseScopeStatus(ev.status[0]).modeName, 'fixed');
});

console.log('The recording');
check('a capture line reads back as the same frame', () => {
  const f = toFrames(sweepPayloads({ divisions: 1 }))[0];
  const back = S.parseCapture(S.captureLine('rx', f, new Date(0)));
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].dir, 'rx');
  assert.ok(back[0].frame.equals(f));
});
check('the summary names sweeps, points, the level reached, mode and span', () => {
  const asm = new S.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  for (const p of sweepPayloads()) asm.feed(S.parseScopeFrame(Buffer.from(p)));
  const s = S.summarizeSweeps(got);
  assert.deepStrictEqual([s.sweeps, s.points[0], s.maxLevel, s.mode, s.spanHz], [1, 475, 160, 'center', 50000]);
});

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const rc = fs.readFileSync(path.join(ROOT, 'lib/rig-controller.js'), 'utf8');
check('RigController passes the scope events on, and a waveform frame counts as a live read', () => {
  assert.ok(/this\._codec\.on\('scope-data', \(payload, frame\) => \{ this\._noteReadOk\(\); this\.emit\('scope-data', payload, frame\); \}\);/.test(rc));
  assert.ok(/this\._codec\.on\('scope-nak'/.test(rc) && /sendScope\(bytes\) \{/.test(rc));
});
check('the recording: Icom CI-V links only, puts back what it turned on, in a finally', () => {
  const i = main.indexOf('async function icomScopeCapture(');
  const fn = main.slice(i, i + 6000);
  assert.ok(/ICOM_SCOPE_CIV_TYPES\.includes\(target\.type\)/.test(fn));
  assert.ok(/\} finally \{[\s\S]*if \(!outputWas \|\| !outputWas\.on\) send\(IcomScope\.write\.output\(false\)\);[\s\S]*if \(scopeWas && !scopeWas\.on\) send\(IcomScope\.write\.scopeOn\(false\)\);/.test(fn));
  assert.ok(/ipcMain\.handle\('icom-scope-capture', \(\) => icomScopeCapture\(30\)\);/.test(main));
});
check('Settings > My Rigs shows the button for the three CI-V connection types', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert.ok(/id="icom-scope-capture-btn"[^>]*>Record band scope data \(30 s\)</.test(html));
  assert.ok(/\['icom', 'civ-tcp', 'icom-network'\]\.includes\(getSelectedRadioType\(\)\)/.test(app));
});

// Real radios (test/fixtures/icom-scope/), recorded with the 1.13.6 button.
const RECORDINGS = [
  { file: 'kw4fm-ic7300-center-7063-200k.txt', who: 'KW4FM IC-7300', sweeps: 118, centerHz: 7063000, spanHz: 200000, frames: 1307, maxLevel: 121 },
  { file: 'ic7300-center-14252-100k.txt', who: 'IC-7300 on 20 m', sweeps: 122, centerHz: 14252000, spanHz: 100000, frames: 1347, maxLevel: 79 },
];
for (const r of RECORDINGS) {
  check(`${r.who} recording: ${r.sweeps} whole sweeps, Center ${r.centerHz / 1e6} MHz, +/-${r.spanHz / 2000} kHz, nothing dropped`, () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures/icom-scope', r.file), 'utf8');
    const asm = new S.SweepAssembler();
    const sweeps = [];
    asm.on('sweep', (s) => sweeps.push(s));
    for (const c of S.parseCapture(text)) {
      const f = c.frame;
      if (c.dir === 'rx' && f[4] === 0x27 && f[5] === 0x00) asm.feed(S.parseScopeFrame(f.subarray(6, f.length - 1)));
    }
    const sum = S.summarizeSweeps(sweeps);
    assert.strictEqual(sum.sweeps, r.sweeps);
    assert.deepStrictEqual(sum.points, [475]);
    assert.strictEqual(sum.mode, 'center');
    assert.strictEqual(sum.centerHz, r.centerHz);
    assert.strictEqual(sum.spanHz, r.spanHz);
    assert.strictEqual(sum.maxLevel, r.maxLevel);
    assert.ok(sum.maxLevel <= 160, 'levels stay on the 0..160 scale');
    assert.strictEqual(asm.dropped, 0);
    assert.deepStrictEqual(S.axisFor(sweeps[0].header), { anchor: 'center', centerHz: r.centerHz, spanHz: r.spanHz });
    // The capture's own summary line agrees with what the parser reads back.
    assert.ok(text.includes(`# result: ${r.frames} data frames, ${r.sweeps} sweeps, points=475 maxLevel=${r.maxLevel} dropped=0`));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
