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
  assert.deepStrictEqual(writes.filter((w) => !/^BI/.test(w)), ['KM5' + 'A'.repeat(50) + ';', 'KYA;'], 'only the first memory now');
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

test('BK-IN read as off: turned on once for back-to-back messages, and said once', async () => {
  const { rig: r, codec, writes, logs } = rig('FTX-1 Field');
  codec.emit('breakIn', false);
  r.sendCwText('E');
  r.sendCwText('E');
  assert.strictEqual(logs.filter((l) => /turned BK-IN on/.test(l)).length, 1);
  assert.strictEqual(writes.filter((w) => w === 'BI1;').length, 1, JSON.stringify(writes));
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

// --- BK-IN and the stuck-transmit backstop (2026-11-01) --------------------
// With BK-IN off the radio plays the text in the sidetone only (W2XYZ FTX-1F
// on 1.13.8: "unable to send any CW"); a radio left keyed after a message
// stayed on the air until Stop (kc9hekbrian FTDX10). BI; was never even read.

test('FTDX10: keyer memory 5 played with KYA, like the FTDX101', async () => {
  const { rig: r, writes } = rig('FTDX10');
  r._breakIn = true;
  r.sendCwText('TEST');
  assert.deepStrictEqual(writes.slice(-2), ['KM5TEST;', 'KYA;']);
  r.disconnect();
});

test('BK-IN known off: turned on before the text, back off after the message', async () => {
  const { rig: r, writes, logs } = rig('FT-710');
  r._cwWpm = 60;
  r._breakIn = false;
  r.sendCwText('E');
  const bi1 = writes.indexOf('BI1;'), km = writes.findIndex((w) => /^KM/.test(w));
  assert.ok(bi1 >= 0 && bi1 < km, 'BI1; before the text: ' + JSON.stringify(writes));
  assert.ok(!writes.includes('BI0;'), 'not restored mid-message');
  await sleep(5200);
  assert.ok(writes.includes('BI0;'), 'BK-IN put back: ' + JSON.stringify(writes));
  assert.ok(logs.some((l) => /BK-IN back off/.test(l)));
  r.disconnect();
});

test('BK-IN unknown: asks, turns it on, and restores what the radio said', async () => {
  const { rig: r, codec, writes } = rig('FTX-1 Field');
  r._cwWpm = 60;
  r.sendCwText('E');
  assert.ok(writes.indexOf('BI;') >= 0 && writes.indexOf('BI;') < writes.indexOf('BI1;'), 'query, then on: ' + JSON.stringify(writes));
  codec.emit('breakIn', false); // the reply to BI;: it was off
  assert.strictEqual(r._breakIn, true, 'on now');
  await sleep(5200);
  assert.ok(writes.includes('BI0;'), 'put back off');
  r.disconnect();
});

test('BK-IN unknown but the radio says it was on: left on', async () => {
  const { rig: r, codec, writes } = rig('FTX-1 Field');
  r._cwWpm = 60;
  r.sendCwText('E');
  codec.emit('breakIn', true);
  await sleep(5200);
  assert.ok(!writes.includes('BI0;'), 'never turned off: ' + JSON.stringify(writes));
  r.disconnect();
});

test('BK-IN already on: no BI commands at all', async () => {
  const { rig: r, writes } = rig('FT-710');
  r._breakIn = true;
  r.sendCwText('TEST');
  assert.ok(!writes.some((w) => /^BI/.test(w)), JSON.stringify(writes));
  r.disconnect();
});

test('a radio still in transmit 4 s after the message is sent to receive, and the operator is told', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  const notices = [];
  r.on('notice', (m) => notices.push(m));
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true); // the radio reports TX during the message
  await sleep(6000);
  assert.ok(writes.includes('TX0;'), 'RX sent: ' + JSON.stringify(writes));
  assert.ok(notices.some((m) => /stayed in transmit after the CW message/.test(m)));
  assert.strictEqual(r._transmitting, false);
  r.disconnect();
});

test('the backstop leaves a PTT POTACAT itself is holding alone', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true);
  r._pttCommanded = true; // e.g. the phone's PTT pressed right after the macro
  await sleep(6000);
  assert.ok(!writes.includes('TX0;'), JSON.stringify(writes));
  r.disconnect();
});

test('the radio returning to receive by itself cancels the backstop', async () => {
  const { rig: r, codec, writes } = rig('FTDX10');
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  codec.emit('ptt', true);
  await sleep(1500);
  codec.emit('ptt', false);
  await sleep(4500);
  assert.ok(!writes.includes('TX0;'), JSON.stringify(writes));
  r.disconnect();
});

test('main shows the controller notice on screen and on the phone', async () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/controller\.on\('notice', \(msg\) => \{[\s\S]{0,400}send\('app-notice'[\s\S]{0,300}type: 'tune-blocked', reason: msg/.test(main));
});

Promise.all(pending).then(() => {
  console.log(`\nYaesu CW text: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
