// #655: an FTX-1 left in transmit after a keyer-memory CW message. The stuck
// backstop sent TX0; alone, which a Yaesu playing its keyer memory ignores
// (#582), so the radio stayed keyed until the operator pressed Stop (KY00;).
// The backstop now sends the documented playback stop first on the models
// that have one: KY P1 P2 with P2 0 = STOP, FTX-1 CAT manual 2508-C p.18
// (PDF p.19); FT-710 CAT manual 2306-C p.14 (PDF p.15). Models without one
// (FTDX10, FTDX101, FT-991A, FT-891) keep TX0; alone, byte for byte.
//
// Run: node test/ftx1-cw-stuck-stop-test.js

'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ok ' + name); }
    catch (err) { failed++; console.log('  FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
  })());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(modelId) {
  const model = RIG_MODELS[modelId];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  const r = new RigController(model, transport, codec);
  r.connected = true;
  r._lastReadOkMs = Date.now();
  return { rig: r, codec, writes };
}

// Runs one message, then reports TX at every poll until the first receive
// command lands; returns the KY/TX bytes written after the message's own.
async function stuckAfterMessage(modelId) {
  const { rig: r, codec, writes } = rig(modelId);
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  const sent = writes.length;
  const polls = setInterval(() => { if (!writes.includes('TX0;')) codec.emit('ptt', true, 1); }, 200);
  await sleep(6500);
  clearInterval(polls);
  r.disconnect();
  return writes.slice(sent).filter((w) => /^KY|^TX/.test(w));
}

for (const id of ['FTX-1 Field', 'FTX-1 Optima', 'FT-710']) {
  test(`${id}: the stuck backstop sends KY00; then TX0; (#655)`, async () => {
    const after = await stuckAfterMessage(id);
    assert.deepStrictEqual(after, ['KY00;', 'TX0;'], JSON.stringify(after));
  });
}

for (const id of ['FTDX10', 'FTDX101D/MP', 'FT-991/991A']) {
  test(`${id}: no documented playback stop, so the backstop sends TX0; alone`, async () => {
    const after = await stuckAfterMessage(id);
    assert.deepStrictEqual(after, ['TX0;'], JSON.stringify(after));
  });
}

test('FTX-1: a radio that unkeys by itself gets no KY00; and no TX0;', async () => {
  const { rig: r, codec, writes } = rig('FTX-1 Field');
  r._cwWpm = 60;
  r._breakIn = true;
  r.sendCwText('E');
  const sent = writes.length;
  const polls = setInterval(() => codec.emit('ptt', false, 0), 200);
  await sleep(6500);
  clearInterval(polls);
  r.disconnect();
  const after = writes.slice(sent).filter((w) => /^KY|^TX/.test(w));
  assert.deepStrictEqual(after, [], JSON.stringify(after));
});

Promise.all(pending).then(() => {
  console.log(`\nFTX-1 CW stuck stop: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
