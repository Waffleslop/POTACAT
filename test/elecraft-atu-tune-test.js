#!/usr/bin/env node
'use strict';
/**
 * Elecraft ATU tune. Elecraft's Programmer's Reference (K3S/K3/KX3/KX2, rev G5)
 * has no AC command (Table 1, p. 2): the tuner is started by tapping its switch
 * with SWT (pp. 25-26). K3/K3S "ATU Tune" = SWT19 (Table 7); KX3 "ATU TUNE" =
 * SWT44 (Table 8); KX2 "ATU" = SWT20 (Table 8A). OM; tells a KX2 (reply ends 01)
 * from a KX3 (02), p. 21. POTACAT sent AC011;, so the KX2's ATU button did
 * nothing (2026-11-15 report).
 *
 * Run: node test/elecraft-atu-tune-test.js
 */
const assert = require('assert');
const { RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigController } = require('../lib/rig-controller');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function codecFor(model) {
  const out = [];
  const c = new KenwoodCodec(RIG_MODELS[model], (d) => out.push(String(d)));
  return { c, out };
}

test('K3/K3S tunes with SWT19;, never AC', () => {
  const { c } = codecFor('K3/K3S');
  assert.deepStrictEqual(c.getAtuStartSequence(), [{ cmd: 'SWT19;', delay: 0 }]);
  assert.strictEqual(c.getAtuStopCmd(), null);
});

test('KX2: tune asks OM; first, then sends SWT20; when the reply ends 01', () => {
  const { c, out } = codecFor('KX2/KX3');
  assert.strictEqual(c.getAtuStartSequence(), null, 'unknown radio: the codec runs the tune itself');
  c.startTune();
  assert.deepStrictEqual(out, ['OM;']);
  c.onData('OM AP-----B--01;');
  assert.deepStrictEqual(out, ['OM;', 'SWT20;']);
  c.startTune();
  assert.deepStrictEqual(out, ['OM;', 'SWT20;', 'SWT20;'], 'known now: no second OM;');
  assert.deepStrictEqual(c.getAtuStartSequence(), [{ cmd: 'SWT20;', delay: 0 }]);
});

test('KX3: the reply ending 02 tunes with SWT44;', () => {
  const { c, out } = codecFor('KX2/KX3');
  c.startTune();
  c.onData('OM APF---TBXI02;');
  assert.deepStrictEqual(out, ['OM;', 'SWT44;']);
});

test('an OM; reply with no tune pending only records the radio', () => {
  const { c, out } = codecFor('KX2/KX3');
  c.onData('OM ---------01;');
  assert.deepStrictEqual(out, []);
  assert.deepStrictEqual(c.getAtuStartSequence(), [{ cmd: 'SWT20;', delay: 0 }]);
});

test('Elecraft stop sends nothing (no tuner-off command); Yaesu and Kenwood unchanged', () => {
  for (const m of ['K3/K3S', 'KX2/KX3']) {
    const { c, out } = codecFor(m);
    c.stopTune();
    assert.deepStrictEqual(out, [], m);
    assert.strictEqual(c.getAtuStopCmd(), null, m);
  }
  const k = codecFor('TS-590S/SG');
  assert.deepStrictEqual(k.c.getAtuStartSequence(), [{ cmd: 'AC011;', delay: 0 }]);
  assert.strictEqual(k.c.getAtuStopCmd(), 'AC000;');
  const y = codecFor('FT-710');
  assert.deepStrictEqual(y.c.getAtuStartSequence(), [{ cmd: 'AC003;', delay: 0 }]);
});

test('RigController on a KX2 reaches the codec (OM; then SWT20;)', () => {
  const writes = [];
  const transport = { write: (d) => writes.push(String(d)), on() {}, connected: true };
  const model = RIG_MODELS['KX2/KX3'];
  const codec = new KenwoodCodec(model, (d) => transport.write(d));
  const rc = new RigController(model, transport, codec);
  Object.defineProperty(rc, 'connected', { get: () => true });
  rc.startTune();
  assert.deepStrictEqual(writes, ['OM;']);
  codec.onData('OM AP-----B--01;');
  assert.deepStrictEqual(writes, ['OM;', 'SWT20;']);
  rc.stopTune();
  assert.deepStrictEqual(writes, ['OM;', 'SWT20;'], 'no AC000; to an Elecraft');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
