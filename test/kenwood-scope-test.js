#!/usr/bin/env node
'use strict';
// lib/kenwood-scope.js: the Kenwood TS-890S bandscope over USB/COM (#397).
// Every line here is built from Kenwood's TS-890S PC Control Command
// Reference Guide (2018-08-30), DD0 p.17, DD2 p.18, DD4 p.19, AI p.3. No
// owner capture yet; when one exists it goes under test/fixtures/kenwood-scope/.
// Run: node test/kenwood-scope-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const K = require('../lib/kenwood-scope');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { getModel } = require('../lib/rig-models');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const pad11 = (n) => String(n).padStart(11, '0');
const hex = (v) => v.toString(16).toUpperCase().padStart(2, '0');
/** Piece 00: DD4 00 P2 P3(11) P4(11) P5; */
const header = (mode, a, b, oor = 0) => `DD400${mode}${pad11(a)}${pad11(b)}${oor};`;
/** Pieces 01-32 (DD4) or 00-31 (DD2): 20 points as 40 hex digits. */
const piece = (cmd, n, pts) => `${cmd}${String(n).padStart(2, '0')}${pts.map(hex).join('')};`;
/** A whole DD4 sweep: 640 points, lower edge first. */
function dd4Sweep(points, { mode = 0, a = 50000, b = 14074000, oor = 0 } = {}) {
  const lines = [header(mode, a, b, oor)];
  for (let p = 1; p <= 32; p++) lines.push(piece('DD4', p, points.slice((p - 1) * 20, p * 20)));
  return lines;
}
const flat = (v) => new Array(640).fill(v);

console.log('Lines, as Kenwood prints them');
t('piece 00 carries the mode, the two range numbers and the out-of-range flag', () => {
  const line = header(0, 50000, 14074000);
  assert.strictEqual(line.length, 30, 'Answer 1 is 29 characters and the ;');
  assert.deepStrictEqual(K.parseDdLine(line), { cmd: 'DD4', piece: 0, header: { mode: 0, modeName: 'CENTER', a: 50000, b: 14074000, outOfRange: false } });
  assert.strictEqual(K.parseDdLine(header(1, 14000000, 14350000, 1)).header.modeName, 'FIXED');
  assert.strictEqual(K.parseDdLine(header(2, 14000000, 14100000)).header.modeName, 'AUTO SCROLL');
  assert.strictEqual(K.parseDdLine(header(1, 14000000, 14350000, 1)).header.outOfRange, true);
});
t('pieces 01-32 carry 20 points each in 40 hex digits', () => {
  const pts = Array.from({ length: 20 }, (_, i) => i * 7);
  const line = piece('DD4', 1, pts);
  assert.strictEqual(line.length, 46, 'Answer 2 is 45 characters and the ;');
  const p = K.parseDdLine(line);
  assert.strictEqual(p.piece, 1);
  assert.deepStrictEqual(Array.from(p.points), pts);
});
t('DD2 pieces 00-31 parse the same way (the AI-linked form)', () => {
  const p = K.parseDdLine(piece('DD2', 31, flat(0x8c).slice(0, 20)));
  assert.strictEqual(p.cmd, 'DD2');
  assert.strictEqual(p.piece, 31);
});
t('values above 8Ch (-100 dB) are held at 8Ch', () => {
  assert.strictEqual(K.parseDdLine(piece('DD4', 2, flat(0xff).slice(0, 20))).points[0], 0x8c);
});
t('anything else is not a scope line', () => {
  for (const s of ['FA00014074000;', 'DD05;', 'DD433' + '0'.repeat(40) + ';', 'DD232' + '0'.repeat(40) + ';', 'DD401XYZ;', '']) {
    assert.strictEqual(K.parseDdLine(s), null, s);
  }
  assert.ok(K.isDdStream('DD401' + '0'.repeat(40)));
  assert.ok(!K.isDdStream('DD05'));
});

console.log('Sweeps');
t('33 DD4 lines in order make one sweep of 640 points, lower edge first', () => {
  const asm = new K.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  const pts = Array.from({ length: 640 }, (_, i) => i % 141);
  for (const l of dd4Sweep(pts)) asm.feed(K.parseDdLine(l));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].points.length, 640);
  assert.deepStrictEqual(Array.from(got[0].points), pts.map((v) => Math.min(v, 0x8c)));
  assert.strictEqual(got[0].header.b, 14074000);
});
t('a sweep with a missing piece is dropped, never drawn half-old, and the next one is whole', () => {
  const asm = new K.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  const lines = dd4Sweep(flat(0x40));
  lines.splice(10, 1);                                     // piece 10 lost
  for (const l of lines) asm.feed(K.parseDdLine(l));
  assert.strictEqual(got.length, 0);
  assert.ok(asm.dropped >= 1);
  for (const l of dd4Sweep(flat(0x40))) asm.feed(K.parseDdLine(l));
  assert.strictEqual(got.length, 1);
});
t('pieces before the first header (joining mid-sweep) are ignored', () => {
  const asm = new K.SweepAssembler();
  let n = 0;
  asm.on('sweep', () => n++);
  const lines = dd4Sweep(flat(0x40));
  for (const l of lines.slice(20)) asm.feed(K.parseDdLine(l));
  for (const l of lines) asm.feed(K.parseDdLine(l));
  assert.strictEqual(n, 1);
});
t('32 DD2 pieces make a sweep with no header', () => {
  const asm = new K.SweepAssembler();
  const got = [];
  asm.on('sweep', (s) => got.push(s));
  for (let p = 0; p < 32; p++) asm.feed(K.parseDdLine(piece('DD2', p, flat(0x20).slice(0, 20))));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].header, null);
});

console.log('Axis from the radio\'s own numbers');
t('Center mode: P3 is the span and P4 the centre', () => {
  assert.deepStrictEqual(K.axisFor({ mode: 0, modeName: 'CENTER', a: 50000, b: 14074000 }),
    { anchor: 'fixed', centerHz: 14074000, spanHz: 50000, modeLabel: 'CENTER' });
});
t('Fixed and Auto scroll: P3 and P4 are the edges', () => {
  assert.deepStrictEqual(K.axisFor({ mode: 1, modeName: 'FIXED', a: 14000000, b: 14350000 }),
    { anchor: 'fixed', centerHz: 14175000, spanHz: 350000, modeLabel: 'FIXED' });
  assert.strictEqual(K.axisFor({ mode: 2, modeName: 'AUTO SCROLL', a: 7000000, b: 7100000 }).centerHz, 7050000);
});
t('a range with no width, or no header (DD2), gives no axis', () => {
  assert.strictEqual(K.axisFor({ mode: 1, a: 14000000, b: 14000000 }), null);
  assert.strictEqual(K.axisFor(null), null);
});
t('the axis is known, so click-to-tune works', () => {
  const ax = K.axisFor({ mode: 0, modeName: 'CENTER', a: 50000, b: 14074000 });
  const a = require('../lib/scope-axis').scopeAxis(ax);
  assert.strictEqual(a.known, true);
  assert.strictEqual(a.startHz, 14049000);
});

console.log('Levels');
t('00h (0 dB, top) is 255 and 8Ch (-100 dB) is 0; 640 points become 850', () => {
  assert.ok(K.toScopeFrame(flat(0x00)).wf1.every((v) => v === 255));
  assert.ok(K.toScopeFrame(flat(0x8c)).wf1.every((v) => v === 0));
  const f = K.toScopeFrame(flat(0x46), { seq: 9 });
  assert.strictEqual(f.wf1.length, 850);
  assert.strictEqual(f.wf1[0], 128);
  assert.strictEqual(f.seq, 9);
  assert.strictEqual(f.aligned, true);
});
t('a one-point signal survives and lands where it is', () => {
  const pts = flat(0x78);
  pts[400] = 0x10;
  const f = K.toScopeFrame(pts);
  const at = f.wf1.indexOf(Math.max(...f.wf1));
  assert.ok(Math.abs(at - Math.round(400 * 850 / 640)) <= 2, 'at ' + at);
});
t('the level scale is the radio\'s dB (0 to -100), never dBm', () => {
  assert.deepStrictEqual(K.LEVEL_SCALE, { unit: 'radio', min: -100, max: 0 });
});

console.log('What POTACAT writes, and what it puts back');
t('AI off: only DD05; at close DD0 goes back to what it was', () => {
  const p = K.startPlan({ ai: '0', dd0: '0' });
  assert.deepStrictEqual(p.writes, ['DD05;']);
  assert.deepStrictEqual(p.restore, ['DD00;']);
});
t('AI on (AI4 kept, AI2 not kept): AI0 first, and the same AI back at close', () => {
  assert.deepStrictEqual(K.startPlan({ ai: '4', dd0: '0' }), {
    ok: true, writes: ['AI0;', 'DD05;'], restore: ['DD00;', 'AI4;'], log: K.startPlan({ ai: '4', dd0: '0' }).log });
  assert.deepStrictEqual(K.startPlan({ ai: '2', dd0: '1' }).restore, ['DD01;', 'AI2;']);
});
t('no answer to AI;: nothing is written', () => {
  const p = K.startPlan({ ai: null, dd0: null });
  assert.strictEqual(p.ok, false);
  assert.deepStrictEqual(p.writes, []);
});
t('a radio already on DD05 (POTACAT\'s own, from a crash) is put back to no output', () => {
  assert.deepStrictEqual(K.startPlan({ ai: '0', dd0: '5' }).restore, ['DD00;']);
});
t('replies are read: AI4; -> 4, DD05; -> 5', () => {
  assert.strictEqual(K.parseAi('AI4;'), '4');
  assert.strictEqual(K.parseDd0('DD05;'), '5');
  assert.strictEqual(K.parseAi('?;'), null);
});
t('only 115200 baud carries it, and the card names the radio\'s menu items', () => {
  assert.ok(K.baudOk({ type: 'serial', baudRate: 115200 }));
  assert.ok(!K.baudOk({ type: 'serial', baudRate: 38400 }));
  assert.ok(!K.baudOk({ type: 'serial' }));
  const d = K.diag('baud', { baud: 38400 });
  assert.strictEqual(d.severity, 'blocker');
  assert.match(d.action, /0-07-01/);
  assert.match(d.detail, /38400/);
});
t('no card is keyed plain "silent" (that key shows the SCU-LAN10 Enable button)', () => {
  for (const k of ['baud', 'no-ai', 'silent', 'refused']) assert.match(K.diag(k).key, /^kenwood-/);
});

console.log('Which radios');
t('the TS-890S has it; the TS-990S, TS-590SG and TS-480 do not', () => {
  assert.ok(K.modelHasScope(getModel('TS-890S', null)));
  for (const m of ['TS-990S', 'TS-590S/SG', 'TS-480']) assert.ok(!K.modelHasScope(getModel(m, null)), m);
});

console.log('The CAT link is not disturbed');
(async () => {
  await ta('scope lines interleaved with poll replies: the frequency still lands and a raw read still resolves', async () => {
    const codec = new KenwoodCodec(getModel('TS-890S', null), () => {});
    const lines = [];
    const freqs = [];
    codec.on('kenwood-scope', (l) => lines.push(l));
    codec.on('frequency', (hz) => freqs.push(hz));
    const read = codec.queryRaw('AI;', { prefix: 'AI', timeoutMs: 500 });
    const sweep = dd4Sweep(flat(0x50));
    const stream = sweep.slice(0, 5).join('') + 'FA00014074000;' + sweep.slice(5, 9).join('') + 'AI4;' + sweep.slice(9).join('');
    // Fed in awkward chunks, the way a serial port delivers.
    for (let i = 0; i < stream.length; i += 37) codec.onData(Buffer.from(stream.slice(i, i + 37)));
    assert.strictEqual(await read, 'AI4;');
    assert.deepStrictEqual(freqs, [14074000]);
    assert.strictEqual(lines.length, 33);
    const asm = new K.SweepAssembler();
    let n = 0;
    asm.on('sweep', () => n++);
    for (const l of lines) asm.feed(K.parseDdLine(l));
    assert.strictEqual(n, 1);
  });
  await ta('a DD line never answers a raw read for another command', async () => {
    const codec = new KenwoodCodec(getModel('TS-890S', null), () => {});
    const read = codec.queryRaw('DD0;', { prefix: 'DD0', timeoutMs: 300 });
    codec.onData(Buffer.from(dd4Sweep(flat(0x50)).join('') + 'DD05;'));
    assert.strictEqual(await read, 'DD05;');
  });

  console.log('Wiring');
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const rc = readSrc(path.join(__dirname, '..', 'lib', 'rig-controller.js'));
  t('RigController hands the stream on; main offers it only for the model and only on the radio\'s own serial port', () => {
    assert.ok(rc.includes("this._codec.on('kenwood-scope', (line) => this.emit('kenwood-scope', line));"));
    assert.ok(main.includes("if (!target || target.type !== 'serial') return null;"));
    assert.ok(main.includes('return KenwoodScope.modelHasScope(info) ? { name: model } : null;'));
    assert.ok(main.includes("if (!caps.nativeScope && kenwoodScopeModel()) caps.nativeScope = 'kenwood';"));
    assert.ok(main.includes("if (kind === 'kenwood') { startKenwoodScope(); return; }"));
    assert.ok(main.includes('if (kenwoodScopeOn) { stopKenwoodScope(why); return; }'));
  });
  t('main checks the baud before sending anything, confirms DD05 by reading it back, and puts the radio back', () => {
    const start = main.slice(main.indexOf('function startKenwoodScope'), main.indexOf('function stopKenwoodScope'));
    assert.ok(start.indexOf('KenwoodScope.baudOk(target)') < start.indexOf('kenwoodScopeSetup()'));
    assert.ok(main.includes("const now = KenwoodScope.parseDd0(await ask('DD0;', 'DD0'));"));
    assert.ok(main.includes('for (const w of kenwoodScopeRestore) cat.sendRaw(w);'));
  });

  console.log(`\nKenwood scope: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
