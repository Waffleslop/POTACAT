// Yaesu CW text keys through BK-IN, never TX1; first (W2XYZ FTX-1, W3MDT
// FT-710, 2026-10-28: TX1; alone in CW keys a steady carrier, BK-IN on or
// off). Hamlib's newcat_send_morse does the same: KM1 text, then play, no PTT.
//
// Run: node test/yaesu-cw-text-test.js

'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
  })());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(modelId, Codec = KenwoodCodec) {
  const model = RIG_MODELS[modelId];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new Codec(model, (d) => writes.push(String(d)));
  const r = new RigController(model, transport, codec);
  r.connected = true;
  r._lastReadOkMs = Date.now();
  const logs = [];
  r.on('log', (m) => logs.push(m));
  return { rig: r, codec, writes, logs };
}

for (const id of ['FTX-1 Field', 'FTX-1 Optima', 'FTDX101D/MP', 'FT-710', 'FTDX10', 'FT-991/991A']) {
  test(`${id}: CW text never sends TX1; and holds TX for the message`, async () => {
    const { rig: r, writes } = rig(id);
    r.sendCwText('CQ POTA DE W2XYZ K');
    await sleep(80);
    assert.ok(!writes.some((w) => /^TX1;/.test(w)), 'no TX1; — it keyed a carrier: ' + JSON.stringify(writes));
    assert.ok(writes.some((w) => /^KM|^KY/.test(w)), 'the text went to the radio: ' + JSON.stringify(writes));
    assert.strictEqual(r._transmitting, true, 'held as transmitting for the envelope');
    r.disconnect();
  });
}

test('FT-710 without a key port: keyer memory 1, played with KY01; (W3MDT)', async () => {
  const { rig: r, writes } = rig('FT-710');
  r.sendCwText('TEST');
  assert.deepStrictEqual(writes.slice(-2), ['KM1TEST;', 'KY01;']);
  r.disconnect();
});

test('FTX-1: KM5 then KYA; a long message waits for each memory to play', async () => {
  const { rig: r, writes } = rig('FTX-1 Field');
  r.setCwSpeed(60); // 200 ms per character keeps the test short
  writes.length = 0;
  const text = 'A'.repeat(50) + 'B';
  r.sendCwText(text);
  assert.deepStrictEqual(writes, ['KM5' + 'A'.repeat(50) + ';', 'KYA;'], 'only the first memory now');
  assert.strictEqual(r._cwKmTimers.length, 1, 'the second chunk waits');
  r.stopCwText();
  assert.strictEqual(r._cwKmTimers.length, 0, 'stop drops the waiting chunk');
  r.disconnect();
});

test('rigctld on an FTX-1 (W2XYZ): "b text" with no "T 1" before it', async () => {
  const { rig: r, writes } = rig('FTX-1 Field', RigctldCodec);
  r.sendCwText('TU 73 DE W2XYZ');
  await sleep(80);
  assert.ok(!writes.some((w) => /^T 1/.test(w)), JSON.stringify(writes));
  assert.ok(writes.some((w) => /^b TU 73 DE W2XYZ/.test(w)), JSON.stringify(writes));
  r.disconnect();
});

test('BK-IN read as off: says once that the message goes to the sidetone only', async () => {
  const { rig: r, codec, logs } = rig('FTX-1 Field');
  codec.emit('breakIn', false);
  r.sendCwText('E');
  r.sendCwText('E');
  assert.strictEqual(logs.filter((l) => /BK-IN off/.test(l)).length, 1);
  r.disconnect();
});

test('a non-Yaesu ky1 rig keeps its old path (X6100 still keys first)', async () => {
  const { rig: r, writes } = rig('X6100');
  r.sendCwText('E');
  assert.ok(writes.some((w) => /^TX1;|^TX;/.test(w)), JSON.stringify(writes));
  r.disconnect();
});

test('macOS cannot nap POTACAT while it times CW itself: the key port and the paddle keyer hold it awake (N8JMS)', async () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/function cwKeyingAwake\(ms\)[\s\S]{0,300}powerSaveBlocker\.start\('prevent-app-suspension'\)/.test(main));
  const dtr = main.indexOf('function sendCwTextViaDtrKey(');
  assert.ok(main.slice(dtr, dtr + 4000).includes('cwKeyingAwake(t + 2000)'), 'the key-port text path');
  assert.ok(/keyer\.on\('key', \(\{ down \}\) => \{\s*\/\/[^\n]*\n\s*cwKeyingAwake\(3000\);/.test(main), 'the paddle keyer');
});

Promise.all(pending).then(() => {
  console.log(`\nYaesu CW text: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
