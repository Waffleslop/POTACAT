'use strict';
// #1084: picking Xiegu X6100 as Radio Model switched the rig editor to
// "Serial CAT (Kenwood / Yaesu)", which the X6100 does not speak. It now keeps
// a connection the operator already chose that can reach the radio, or
// selects "FLRig (a shared radio)". The rule is data (preferredConnection in
// lib/rig-models.js) read by lib/rig-model-connection.js; other models are
// unchanged. No Hamlib mapping for the X6100 until an owner confirms its baud
// rate and power scale.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getModelList, RIG_MODELS } = require('../lib/rig-models');
const { connectionForModel } = require('../lib/rig-model-connection');
const { resolveSetupNotes } = require('../lib/rig-setup-notes');

const groups = getModelList();
const groupFor = (model) => groups.find((g) => g.models.includes(model));
const pick = (model, current) => connectionForModel({ model, group: groupFor(model), current });

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

// --- the data ---
test('X6100 prefers FLRig and has no Hamlib mapping', () => {
  assert.strictEqual(RIG_MODELS.X6100.preferredConnection, 'flrig');
  assert.strictEqual(RIG_MODELS.X6100.hamlib, undefined, 'no Hamlib 3087 until an owner confirms baud and power');
  const g = groupFor('X6100');
  assert.deepStrictEqual(g.preferred, { X6100: 'flrig' });
  assert.ok(!(g.hamlib && g.hamlib.X6100));
});

// --- X6100 ---
test('X6100 on a new rig (the editor opens on FlexRadio) selects FLRig', () => {
  assert.deepStrictEqual(pick('X6100', 'flex'), { type: 'flrig', keep: false });
  assert.deepStrictEqual(pick('X6100', 'none'), { type: 'flrig', keep: false });
});

test('X6100 with Serial CAT selected selects FLRig', () => {
  assert.deepStrictEqual(pick('X6100', 'serialcat'), { type: 'flrig', keep: false });
});

test('X6100 never selects Serial CAT, whatever is selected', () => {
  for (const current of ['none', 'flex', 'tci', 'tcpcat', 'k4network', 'serialcat', 'icom', 'civ-tcp', 'icom-network',
    'yaesu-lan', 'hamlib', 'rigctldnet', 'flrig', 'dxlab-commander', 'nocat']) {
    assert.notStrictEqual(pick('X6100', current).type, 'serialcat', current);
  }
});

test('X6100 keeps a connection the operator chose that can reach it', () => {
  for (const current of ['flrig', 'rigctldnet', 'hamlib', 'dxlab-commander', 'icom', 'civ-tcp', 'nocat']) {
    assert.deepStrictEqual(pick('X6100', current), { type: current, keep: true }, current);
  }
});

test('X6100 replaces vendor links that cannot reach it with FLRig', () => {
  for (const current of ['tci', 'tcpcat', 'k4network', 'icom-network', 'yaesu-lan']) {
    assert.strictEqual(pick('X6100', current).type, 'flrig', current);
  }
});

// --- other models, as before ---
test('FT-710 still selects Serial CAT, keeps shared links and the SCU-LAN10', () => {
  assert.deepStrictEqual(pick('FT-710', 'flex'), { type: 'serialcat', keep: false });
  assert.deepStrictEqual(pick('FT-710', 'serialcat'), { type: 'serialcat', keep: true });
  assert.deepStrictEqual(pick('FT-710', 'hamlib'), { type: 'serialcat', keep: false });
  assert.deepStrictEqual(pick('FT-710', 'flrig'), { type: 'flrig', keep: true });
  assert.deepStrictEqual(pick('FT-710', 'rigctldnet'), { type: 'rigctldnet', keep: true });
  assert.deepStrictEqual(pick('FT-710', 'yaesu-lan'), { type: 'yaesu-lan', keep: true });
});

test('G90 still selects Other Rig (Hamlib) 3088 at 19200, even from FLRig', () => {
  for (const current of ['flex', 'serialcat', 'flrig']) {
    const r = pick('G90', current);
    assert.strictEqual(r.type, 'hamlib', current);
    assert.deepStrictEqual(r.hamlib, { rigId: 3088, baudRate: 19200 });
  }
});

test('Icom, FlexRadio, No CAT and TCP CAT models are unchanged', () => {
  assert.strictEqual(pick('IC-7300', 'flex').type, 'icom');
  assert.strictEqual(pick('IC-7300', 'flrig').type, 'flrig');
  assert.strictEqual(pick('FLEX-6300', 'serialcat').type, 'flex');
  assert.strictEqual(pick('Pebble HF', 'flrig').type, 'nocat');
  const tcp = Object.keys(RIG_MODELS).find((m) => RIG_MODELS[m].catLink === 'tcpcat');
  assert.ok(tcp, 'a TCP CAT model exists');
  assert.strictEqual(pick(tcp, 'serialcat').type, 'tcpcat');
  const yaesu = Object.keys(RIG_MODELS).find((m) => RIG_MODELS[m].brand === 'Yaesu');
  assert.strictEqual(pick(yaesu, 'yaesu-lan').type, 'yaesu-lan');
  assert.strictEqual(pick('IC-7300', 'yaesu-lan').type, 'icom', 'only a Yaesu keeps the SCU-LAN10');
});

test('an unknown model or a missing group gives null', () => {
  assert.strictEqual(connectionForModel({ model: 'Nope', group: groupFor('X6100'), current: 'flex' }), null);
  assert.strictEqual(connectionForModel({ model: 'X6100', group: null, current: 'flex' }), null);
});

test('every preferredConnection names a rig-editor radio type', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const [name, m] of Object.entries(RIG_MODELS)) {
    if (!m.preferredConnection) continue;
    assert.ok(html.includes(`name="radio-type" value="${m.preferredConnection}"`), name + ': ' + m.preferredConnection);
  }
});

// --- the rig editor uses it ---
test('the rig editor asks lib/rig-model-connection.js, and the page loads it', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(/RigModelConnection\.connectionForModel\(/.test(app));
  assert.ok(!/else setRadioType\('serialcat'\);/.test(app), 'the old inline brand chain is gone');
  assert.ok(html.includes('<script src="../lib/rig-model-connection.js"></script>'));
});

// --- the setup note says why ---
test('the X6100 setup note shows on FLRig and Serial CAT only', () => {
  const info = RIG_MODELS.X6100;
  const ids = (radioType) => resolveSetupNotes({ model: 'X6100', modelInfo: info, radioType }).map((n) => n.id);
  assert.ok(ids('flrig').includes('x6100-through-flrig'));
  assert.ok(ids('serialcat').includes('x6100-through-flrig'));
  assert.ok(!ids('hamlib').includes('x6100-through-flrig'));
  assert.ok(!resolveSetupNotes({ model: 'G90', modelInfo: RIG_MODELS.G90, radioType: 'flrig' }).some((n) => n.id === 'x6100-through-flrig'));
});

console.log(`rig-model-connection-test: ${passed} passed`);
