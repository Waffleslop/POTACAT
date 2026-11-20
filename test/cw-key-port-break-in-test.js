// #745: CW through a CW Key Port (DTR/RTS) turns BK-IN on the same way the
// CAT text path does. An FTX-1 keyed on its KEY input with BK-IN off gave
// sidetone and stayed in receive (1.14.6); the CAT text path had turned
// BK-IN on since 1.13.9, the key-port path returned before that step.
//
// Run: node test/cw-key-port-break-in-test.js

'use strict';
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { cwKeysThroughBreakIn } = require('../lib/cw-break-in');

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
const bk = (writes) => writes.filter((w) => /^BI/.test(w));

// --- Same families, same commands as the CAT text path ----------------------

const covered = Object.keys(RIG_MODELS).filter((id) => cwKeysThroughBreakIn(RIG_MODELS[id]));

test('the families covered are the Yaesu KY models (FTX-1, FT-710, FT-891, FTDX10, FTDX101 among them)', () => {
  for (const id of ['FTX-1 Field', 'FTX-1 Optima', 'FT-710', 'FT-891', 'FTDX10', 'FTDX101D/MP', 'FT-991/991A']) {
    assert.ok(covered.includes(id), id + ' is covered');
  }
  for (const id of ['IC-7300', 'TS-590', 'X6100']) {
    if (RIG_MODELS[id]) assert.ok(!covered.includes(id), id + ' is not');
  }
});

for (const id of Object.keys(RIG_MODELS)) {
  test(`${id}: a Key Port message asks for BK-IN exactly as a CAT text message does`, () => {
    const cat = rig(id);
    cat.rig._breakIn = false;
    try { cat.rig.sendCwText('E'); } catch { /* a codec with no CW text: no BI either */ }
    const viaCat = bk(cat.writes);
    cat.rig.stopCwText(); cat.rig.disconnect();

    const key = rig(id);
    key.rig._breakIn = false;
    const handled = key.rig.cwKeyLineStarting('E', 20);
    const viaKey = bk(key.writes);
    key.rig.stopCwText(); key.rig.disconnect();

    assert.deepStrictEqual(viaKey, viaCat, 'BK-IN commands, key port vs CAT');
    assert.strictEqual(handled, viaCat.length > 0, 'handled only where the CAT path sends BK-IN');
  });
}

// --- The step itself --------------------------------------------------------

test('FTX-1, BK-IN off: BI1; before keying, BI0; once the message has ended', async () => {
  const { rig: r, writes, logs } = rig('FTX-1 Field');
  r._breakIn = false;
  assert.strictEqual(r.cwKeyLineStarting('E', 60), true);
  assert.deepStrictEqual(bk(writes), ['BI1;']);
  assert.ok(!writes.some((w) => /^KM|^KY|^TX/.test(w)), 'the link keys nothing itself: ' + JSON.stringify(writes));
  assert.ok(logs.some((l) => /turned BK-IN on/.test(l)));
  await sleep(1000);
  assert.ok(!writes.includes('BI0;'), 'not restored mid-message');
  await sleep(4200);
  assert.ok(writes.includes('BI0;'), 'put back: ' + JSON.stringify(writes));
  r.disconnect();
});

test('a long key-port message keeps BK-IN on until it ends, with no TX hold to go by (pyserial keyer)', async () => {
  const { rig: r, writes } = rig('FT-710');
  r._breakIn = false;
  r.cwKeyLineStarting('TEST TEST', 20); // about 5 s at 20 wpm
  await sleep(5000);                     // past the 3.5 s grace a CAT message would get
  assert.ok(!writes.includes('BI0;'), 'not restored while the key port is still keying: ' + JSON.stringify(writes));
  r.stopCwText();
  r.disconnect();
});

test('BK-IN unknown: asks, turns it on, restores what the radio said', async () => {
  const { rig: r, codec, writes } = rig('FTX-1 Optima');
  r.cwKeyLineStarting('E', 60);
  assert.deepStrictEqual(bk(writes), ['BI;', 'BI1;']);
  codec.emit('breakIn', false);
  await sleep(5200);
  assert.ok(writes.includes('BI0;'), 'put back off: ' + JSON.stringify(writes));
  r.disconnect();
});

test('BK-IN already on: no BK-IN commands, never turned off', async () => {
  const { rig: r, writes } = rig('FTX-1 Field');
  r._breakIn = true;
  assert.strictEqual(r.cwKeyLineStarting('E', 60), true);
  await sleep(4500);
  assert.deepStrictEqual(bk(writes), []);
  r.disconnect();
});

test('once per message run: back-to-back key-port sends turn BK-IN on once and say so once', async () => {
  const { rig: r, writes, logs } = rig('FTDX10');
  r._breakIn = false;
  r.cwKeyLineStarting('CQ', 60);
  r.cwKeyLineStarting('CQ', 60);
  r.cwKeyLineStarting('E', 60);
  assert.strictEqual(bk(writes).filter((w) => w === 'BI1;').length, 1, JSON.stringify(writes));
  assert.strictEqual(logs.filter((l) => /turned BK-IN on/.test(l)).length, 1);
  await sleep(5500);
  assert.strictEqual(writes.filter((w) => w === 'BI0;').length, 1, 'put back once: ' + JSON.stringify(writes));
  r.disconnect();
});

test('a CAT message and a key-port message share the one restore', async () => {
  const { rig: r, writes } = rig('FT-710');
  r._breakIn = false;
  r._cwWpm = 60;
  r.sendCwText('E');
  r.cwKeyLineStarting('E', 60);
  await sleep(5500);
  assert.strictEqual(writes.filter((w) => w === 'BI1;').length, 1, JSON.stringify(writes));
  assert.strictEqual(writes.filter((w) => w === 'BI0;').length, 1, JSON.stringify(writes));
  r.disconnect();
});

test('rigctld link to an FTX-1: the key port sends exactly what the CAT path sends for BK-IN (rigctld has no BK-IN command here: nothing)', () => {
  const cat = rig('FTX-1 Field', RigctldCodec);
  cat.rig._breakIn = false;
  cat.rig.sendCwText('E');
  const key = rig('FTX-1 Field', RigctldCodec);
  key.rig._breakIn = false;
  key.rig.cwKeyLineStarting('E', 20);
  const isBk = (w) => /BKIN|BI/i.test(w);
  assert.deepStrictEqual(key.writes.filter(isBk), cat.writes.filter(isBk));
  cat.rig.stopCwText(); cat.rig.disconnect();
  key.rig.stopCwText(); key.rig.disconnect();
});

test('link down: nothing sent, not handled', () => {
  const { rig: r, writes } = rig('FTX-1 Field');
  r._breakIn = false;
  r.connected = false;
  assert.strictEqual(r.cwKeyLineStarting('E', 20), false);
  assert.deepStrictEqual(writes, []);
});

test('a radio outside the rule (Icom, Kenwood): nothing sent', () => {
  for (const id of ['IC-7300', 'TS-590']) {
    if (!RIG_MODELS[id]) continue;
    const { rig: r, writes } = rig(id);
    r._breakIn = false;
    assert.strictEqual(r.cwKeyLineStarting('E', 20), false, id);
    assert.deepStrictEqual(writes, [], id);
    r.disconnect();
  }
});

// --- main.js: the key-port text path calls it; no CAT keys exactly as before -

const main = readSrc(path.join(__dirname, '..', 'main.js'));
const start = main.indexOf('function keyCwTextOnKeyPort(');
const end = main.indexOf('\n}\n', start);
const fnSrc = main.slice(start, end + 2);

function loadKeyPortFn(env) {
  // eslint-disable-next-line no-new-func
  const make = new Function('env', `
    let cat = env.cat, cwKeyPort = env.cwKeyPort, _cwKeyPortPathForPython = env.pythonPath;
    const cwPersistentText = env.cwPersistentText, sendCwTextViaPython = env.sendCwTextViaPython,
      sendCwTextViaDtrKey = env.sendCwTextViaDtrKey;
    ${fnSrc}
    return keyCwTextOnKeyPort;`);
  return make(env);
}

test('main.js: the key-port text path asks the rig link for BK-IN before it keys', () => {
  assert.ok(start > 0 && end > start, 'keyCwTextOnKeyPort found');
  const ask = fnSrc.indexOf('cat.cwKeyLineStarting(');
  assert.ok(ask > 0, 'calls cwKeyLineStarting');
  assert.ok(ask < fnSrc.indexOf('cwPersistentText(') && ask < fnSrc.indexOf('sendCwTextViaDtrKey('), 'before any keying');
  const order = [];
  const fn = loadKeyPortFn({
    cat: { connected: true, cwKeyLineStarting: (t, w) => { order.push(`bk ${t} ${w}`); return true; } },
    cwKeyPort: { isOpen: true },
    pythonPath: null,
    sendCwTextViaDtrKey: (t) => { order.push(`key ${t}`); return true; },
  });
  assert.strictEqual(fn('CQ', 22, { dtr: true }, false), 'DTR keyer');
  assert.deepStrictEqual(order, ['bk CQ 22', 'key CQ']);
});

test('main.js: no CAT link, the legacy CatClient, or a link that throws: keys exactly as before', () => {
  for (const cat of [null, { connected: false, cwKeyLineStarting: () => { throw new Error('must not be asked'); } },
    { connected: true } /* legacy CatClient: no method */,
    { connected: true, cwKeyLineStarting: () => { throw new Error('link going down'); } }]) {
    const keyed = [];
    const fn = loadKeyPortFn({
      cat, cwKeyPort: { isOpen: true }, pythonPath: null,
      sendCwTextViaDtrKey: (t) => { keyed.push(t); return true; },
    });
    assert.strictEqual(fn('TEST', 20, { rts: true }, false), 'RTS keyer');
    assert.deepStrictEqual(keyed, ['TEST']);
  }
});

test('main.js: a key port not ready yet asks for nothing (the retry asks when it keys)', () => {
  let asked = 0;
  const fn = loadKeyPortFn({
    cat: { connected: true, cwKeyLineStarting: () => { asked++; return true; } },
    cwKeyPort: null, pythonPath: null,
    sendCwTextViaDtrKey: () => true,
  });
  assert.strictEqual(fn('E', 20, { dtr: true }, false), false);
  assert.strictEqual(asked, 0);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
