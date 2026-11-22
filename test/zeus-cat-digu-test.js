#!/usr/bin/env node
'use strict';
// GitHub #185: Zeus (Hermes-Lite 2) through its TS-2000-style CAT port. A
// JTCAT band change for FT8 set USB (MD2; then DA1;), and Zeus transmits
// digital audio only in DIGU. The reporter (w5lee) tried both from a custom
// CAT button: MD9; switched Zeus from USB to DIGU, DA1; did nothing. The
// "Zeus SDR (TS-2000 CAT)" model sends MD9; for every upper data mode, keeps
// DIGL off it (plain LSB), and changes nothing for any other Kenwood.
// Run: node test/zeus-cat-digu-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { RIG_MODELS, getModel, getModelList } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { CatClient } = require('../lib/cat');

const ZEUS = 'Zeus SDR (TS-2000 CAT)';
let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { pass++; console.log('  ok  ' + name); },
        (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }));
      return;
    }
    pass++; console.log('  ok  ' + name);
  } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// CatClient (the TCP CAT path) set up the way main.js's tcp branch sets it up.
function client(model) {
  const c = new CatClient();
  const writes = [];
  c._write = (d) => writes.push(String(d));
  c.connected = true;
  c._faDigitsDetected = true;
  c._lastParsedMode = 'USB';
  c._target = { type: 'tcp', host: '127.0.0.1', port: 19090 };
  if (model) {
    if (model.digiMd != null) {
      c._digiMd = model.digiMd;
      if (model.digiMdLower != null) c._digiMdLower = model.digiMdLower;
    }
    const m = model.commands && model.commands.setDa && String(model.commands.setDa).match(/^([A-Za-z]+)\{val\}/);
    if (m) c._dataCmd = m[1].toUpperCase();
  }
  return { c, writes };
}
function tuned(model, hz, mode) {
  const { c, writes } = client(model);
  c.tune(hz, mode);
  return new Promise((resolve) => setTimeout(() => { c._stopPolling && c._stopPolling(); resolve(writes); }, 700));
}
const modeCmds = (w) => w.filter((x) => /^(MD|DA|DT)/.test(x));

test('the model exists and is a Kenwood with MD9 for data and no DA', () => {
  const m = getModel(ZEUS, null);
  assert.ok(m, 'model present');
  assert.strictEqual(m.brand, 'Kenwood');
  assert.strictEqual(m.protocol, 'kenwood');
  assert.strictEqual(m.digiMd, 9);
  assert.strictEqual(m.digiMdLower, 1);
  assert.strictEqual(m.commands.setDa, null);
});

test('the rig editor keeps IP Radio (TCP CAT) for it', () => {
  const g = getModelList().find((x) => x.models.includes(ZEUS));
  assert.ok(g && Array.isArray(g.tcpcat) && g.tcpcat.includes(ZEUS));
  for (const grp of getModelList()) {
    for (const name of grp.tcpcat || []) assert.strictEqual(name, ZEUS, 'only Zeus is a TCP CAT model');
  }
});

test('TCP: a JTCAT band change for FT8 sends MD9 and no DA (the #185 case)', async () => {
  const w = await tuned(RIG_MODELS[ZEUS], 7074000, 'DIGU');
  assert.deepStrictEqual(modeCmds(w), ['MD9;', 'MD9;']);
  assert.ok(w.includes('FA00007074000;'));
});

test('TCP: FT8 and FT4 by name go to DIGU too', async () => {
  assert.deepStrictEqual(modeCmds(await tuned(RIG_MODELS[ZEUS], 14074000, 'FT8')), ['MD9;', 'MD9;']);
  assert.deepStrictEqual(modeCmds(await tuned(RIG_MODELS[ZEUS], 14080000, 'FT4')), ['MD9;', 'MD9;']);
});

test('TCP: DIGL never goes out as DIGU on Zeus (plain LSB)', async () => {
  const w = await tuned(RIG_MODELS[ZEUS], 7074000, 'DIGL');
  assert.deepStrictEqual(modeCmds(w), ['MD1;', 'MD1;']);
});

test('TCP: voice and CW are unchanged on Zeus', async () => {
  const usb = modeCmds(await tuned(RIG_MODELS[ZEUS], 14250000, 'LSB'));
  assert.strictEqual(usb[0], 'MD1;');
  assert.ok(!usb.includes('MD9;'));
  const cw = modeCmds(await tuned(RIG_MODELS[ZEUS], 14030000, 'CW'));
  assert.ok(cw.includes('MD3;') && !cw.includes('MD9;'));
});

test('TCP: a Kenwood with no model still gets USB + DA1 for FT8 (only Zeus changes)', async () => {
  // Already in USB, so only DA1 goes out: what Zeus received before this fix.
  assert.deepStrictEqual(modeCmds(await tuned(null, 7074000, 'DIGU')), ['DA1;']);
  assert.deepStrictEqual(modeCmds(await tuned(RIG_MODELS['TS-2000'], 7074000, 'DIGU')), ['DA1;']);
});

test('TCP: the K4 keeps MD6 for both data sidebands, as before', async () => {
  const k4 = RIG_MODELS['K4/K4D'];
  assert.strictEqual(modeCmds(await tuned(k4, 7074000, 'DIGU'))[0], 'MD6;');
  assert.strictEqual(modeCmds(await tuned(k4, 7074000, 'DIGL'))[0], 'MD6;');
});

test('a Zeus MD9 answer reads back as DIGU, so the next FT8 tune sends no mode', async () => {
  const { c, writes } = client(RIG_MODELS[ZEUS]);
  c._lastParsedMode = 'DIGU';
  c.tune(7074000, 'FT8');
  await new Promise((r) => setTimeout(r, 700));
  assert.deepStrictEqual(modeCmds(writes), []);
});

test('serial codec: the same model sends MD9 for FT8, MD1 for DIGL, and never DA', () => {
  const writes = [];
  const codec = new KenwoodCodec(RIG_MODELS[ZEUS], (d) => writes.push(String(d)));
  codec.setMode('FT8', 7074000);
  codec.setMode('DIGL', 7074000);
  codec.setMode('USB', 14250000);
  assert.deepStrictEqual(writes.filter((x) => /^(MD|DA)/.test(x)), ['MD9;', 'MD1;', 'MD2;']);
  assert.strictEqual(codec.modeNameForMapping(codec.resolveMode('FT8', 7074000)), 'DIGU');
});

const main = readSrc(path.join(__dirname, '..', 'main.js'));
test('main.js: the TCP CatClient takes the model\'s lower data code', () => {
  const i = main.indexOf('cat._digiMd = rigModel.digiMd;');
  assert.ok(i > 0);
  assert.ok(/cat\._digiMdLower = rigModel\.digiMdLower;/.test(main.slice(i, i + 400)));
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
