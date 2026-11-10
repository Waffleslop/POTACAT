// CW text on a link with no CW text command (djrev, 1.14.2, rig type
// "FLRig (a shared radio)"): RigController keyed PTT, then called
// codec.sendCwText inside a 50 ms timer. FlrigCodec has no such method, so the
// timer threw an uncaught TypeError and POTACAT closed. Pinned here: the send
// is refused before anything is keyed, said once in the log, and nothing
// throws later.
//
// Run: node test/cw-text-unsupported-link-test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { FlrigCodec, flrigModel } = require('../lib/codecs/flrig-codec');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function fakeTransport() {
  const t = new EventEmitter();
  t.connect = () => {}; t.disconnect = () => {}; t.write = () => {};
  return t;
}

function flrigRig() {
  const model = flrigModel(RIG_MODELS['TS-480']);
  const codec = new FlrigCodec(model, () => {});
  const tx = [];
  codec.setTransmit = (on) => { tx.push(on); return true; };
  const rig = new RigController(model, fakeTransport(), codec);
  rig.connected = true;
  const logs = [];
  rig.on('log', (m) => logs.push(String(m)));
  return { rig, codec, tx, logs };
}

test('FLRig has no CW text command (the condition the guard covers)', () => {
  const { codec } = flrigRig();
  assert.strictEqual(typeof codec.sendCwText, 'undefined');
});

test('CW text over FLRig is refused before PTT is keyed, and nothing throws later', async () => {
  const { rig, tx, logs } = flrigRig();
  const uncaught = [];
  const onErr = (e) => uncaught.push(e);
  process.on('uncaughtException', onErr);
  try {
    assert.strictEqual(rig.sendCwText('CQ POTA K3SBP'), false);
    assert.deepStrictEqual(tx, [], 'PTT never keyed');
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(uncaught, [], 'no timer threw');
  } finally {
    process.removeListener('uncaughtException', onErr);
    for (const t of [rig._cwTextDropTimer]) if (t) clearTimeout(t);
  }
  assert.ok(logs.some((m) => /CW text is not supported over this link/.test(m)), 'says why');
});

test('the refusal is logged once, not per keystroke', () => {
  const { rig, logs } = flrigRig();
  for (const ch of 'CQ CQ') rig.sendCwText(ch, { live: true });
  assert.strictEqual(logs.filter((m) => /CW text is not supported/.test(m)).length, 1);
});

test('a link that has the command still sends (Kenwood KY)', async () => {
  const model = RIG_MODELS['TS-480'];
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  const rig = new RigController(model, fakeTransport(), codec);
  rig.connected = true;
  rig.on('log', () => {});
  rig.sendCwText('TEST');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(writes.some((w) => /^KY/.test(w)), 'KY went out: ' + writes.join(' '));
  if (rig._cwTextDropTimer) clearTimeout(rig._cwTextDropTimer);
  for (const k of Object.keys(rig)) { const v = rig[k]; if (v && typeof v === 'object' && v.unref) v.unref(); }
});

(async () => {
  console.log('CW text on a link without a CW text command');
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
