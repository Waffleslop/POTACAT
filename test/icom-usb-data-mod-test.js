#!/usr/bin/env node
'use strict';
// Sweep 1a (Casey 2026-11-21): over USB CI-V, DATA MOD is set to USB while
// POTACAT has the radio in a DATA mode, and put back afterwards. Items and
// values from the makers' documents (ops manuals): IC-7300 00 67 (USB 03),
// IC-7300 MK II 00 85 (USB 01), IC-7100 00 91 (USB 03), IC-7610 DATA1/2/3
// MOD 00 92/93/94 (USB 03). See lib/icom-usb-data-mod.js for the pages.
// Run: node test/icom-usb-data-mod-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/icom-usb-data-mod');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { getModel } = require('../lib/rig-models');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  const done = (e) => { if (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); } else { pass++; console.log('  ok  ' + name); } };
  try { const r = fn(); if (r && r.then) pending.push(r.then(() => done(), done)); else done(); } catch (e) { done(e); }
}

/** A radio's set-mode items, read and written as the guard's deps would. */
function fakeRadio(model, items, { enabled = true } = {}) {
  const radio = { items: Object.assign({}, items), writes: [], logs: [], notices: [] };
  const guard = M.createGuard({
    model,
    enabled: () => enabled,
    read: async (id) => (id in radio.items ? radio.items[id] : null),
    write: (id, v) => { radio.writes.push([id, v]); radio.items[id] = v; },
    log: (l) => radio.logs.push(l),
    notice: (m) => radio.notices.push(m),
  });
  return { radio, guard };
}

console.log('Icom DATA MOD to USB for a data session (sweep 1a)');

test('the verified items and USB values per radio', () => {
  assert.deepStrictEqual([M.itemFor(M.specFor('IC-7300'), 1).settingId, M.specFor('IC-7300').usbValue], [0x0067, 0x03]);
  assert.deepStrictEqual([M.itemFor(M.specFor('IC-7300 MK II'), 1).settingId, M.specFor('IC-7300 MK II').usbValue], [0x0085, 0x01]);
  assert.deepStrictEqual([M.itemFor(M.specFor('IC-7100'), 1).settingId, M.specFor('IC-7100').usbValue], [0x0091, 0x03]);
  const s = M.specFor('IC-7610');
  assert.deepStrictEqual([1, 2, 3].map((n) => M.itemFor(s, n).settingId), [0x0092, 0x0093, 0x0094]);
  assert.strictEqual(s.usbValue, 0x03);
  assert.strictEqual(M.specFor('IC-705'), null, 'any other radio is left alone');
  assert.strictEqual(M.specFor('FT-891'), null);
});

test('IC-7300 on its factory ACC: DATA on sets USB, DATA off puts ACC back, the operator is told', async () => {
  const { radio, guard } = fakeRadio('IC-7300', { 0x0067: 0x01 });
  const r = await guard.onDataSet({ on: true, data: 1 });
  assert.strictEqual(r.action, 'set');
  assert.deepStrictEqual(radio.writes, [[0x0067, 0x03]]);
  assert.ok(/from ACC to USB/.test(radio.notices[0]) && /SignaLink/.test(radio.notices[0]));
  await guard.onDataSet({ on: true, data: 1 }); // a second FT8 tune: nothing more
  assert.strictEqual(radio.writes.length, 1);
  await guard.onDataSet({ on: false, data: 0 });
  assert.deepStrictEqual(radio.writes, [[0x0067, 0x03], [0x0067, 0x01]]);
  assert.ok(radio.logs.some((l) => /put back to ACC \(0x01\)/.test(l)));
});

test('the MK II uses its own byte for USB (01), and its LAN or MIC+USB is left alone', async () => {
  const a = fakeRadio('IC-7300 MK II', { 0x0085: 0x02 }); // ACC
  await a.guard.onDataSet({ on: true, data: 1 });
  assert.deepStrictEqual(a.radio.writes, [[0x0085, 0x01]]);
  const b = fakeRadio('IC-7300 MK II', { 0x0085: 0x03 }); // MIC+USB
  assert.strictEqual((await b.guard.onDataSet({ on: true, data: 1 })).action, 'already');
  assert.deepStrictEqual(b.radio.writes, []);
});

test('IC-7100: MIC,ACC becomes USB (03) and goes back', async () => {
  const { radio, guard } = fakeRadio('IC-7100', { 0x0091: 0x02 });
  await guard.onDataSet({ on: true, data: 1 });
  guard.restore('disconnect');
  assert.deepStrictEqual(radio.writes, [[0x0091, 0x03], [0x0091, 0x02]]);
});

test('IC-7610 on DATA2: DATA2 MOD is the one set; moving to DATA1 puts DATA2 back first', async () => {
  const { radio, guard } = fakeRadio('IC-7610', { 0x0092: 0x01, 0x0093: 0x01, 0x0094: 0x04 });
  await guard.onDataSet({ on: true, data: 2 });
  assert.deepStrictEqual(radio.writes, [[0x0093, 0x03]]);
  await guard.onDataSet({ on: true, data: 1 });
  assert.deepStrictEqual(radio.writes, [[0x0093, 0x03], [0x0093, 0x01], [0x0092, 0x03]]);
  await guard.onDataSet({ on: true, data: 3 }); // DATA3 is MIC+USB already: DATA1 back, nothing set
  assert.deepStrictEqual(radio.writes.slice(3), [[0x0092, 0x01]]);
  assert.strictEqual(guard.held, null);
});

test('already USB: never written', async () => {
  const { radio, guard } = fakeRadio('IC-7300', { 0x0067: 0x03 });
  assert.strictEqual((await guard.onDataSet({ on: true, data: 1 })).action, 'already');
  await guard.onDataSet({ on: false });
  assert.deepStrictEqual(radio.writes, []);
});

test('an item that does not answer is never written (no restore guess)', async () => {
  const { radio, guard } = fakeRadio('IC-7300', {});
  assert.strictEqual((await guard.onDataSet({ on: true, data: 1 })).action, 'unread');
  assert.deepStrictEqual(radio.writes, []);
});

test('the rig editor box off (an interface on the ACC socket): never touched', async () => {
  const { radio, guard } = fakeRadio('IC-7300', { 0x0067: 0x01 }, { enabled: false });
  assert.strictEqual((await guard.onDataSet({ on: true, data: 1 })).action, 'off');
  assert.deepStrictEqual(radio.writes, []);
});

test('restore at disconnect is immediate, and nothing is set after it', async () => {
  const { radio, guard } = fakeRadio('IC-7300', { 0x0067: 0x01 });
  await guard.onDataSet({ on: true, data: 1 });
  const r = guard.restore('app quit');
  assert.strictEqual(r.action, 'restored');
  assert.deepStrictEqual(radio.writes[1], [0x0067, 0x01]);
  await guard.onDataSet({ on: true, data: 1 });
  assert.strictEqual(radio.writes.length, 2, 'a link that is closing gets no new set');
});

test('the CI-V codec says when POTACAT\'s own mode set turns DATA on or off', () => {
  const codec = new CivCodec(getModel('IC-7300'), () => {});
  const got = [];
  codec.on('data-set', (e) => got.push(e));
  codec.setMode('FT8', 14074000);
  codec.setMode('USB', 14250000);
  assert.deepStrictEqual(got, [{ on: true, data: 1 }, { on: false, data: 0 }]);
});

test('main attaches it on the serial Icom path and puts it back on every disconnect', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const icomSerial = main.slice(main.indexOf("} else if (target.type === 'icom') {"), main.indexOf("} else if (target.type === 'icom') {") + 1200);
  assert.ok(/icomUsbDataModAttach\(cat, codec\)/.test(icomSerial));
  const restoreNet = main.slice(main.indexOf('async function restoreIcomNetworkDataMod('), main.indexOf('async function restoreIcomNetworkDataMod(') + 300);
  assert.ok(/restoreIcomUsbDataMod\(reason\)/.test(restoreNet), 'the one function every disconnect path already calls');
  assert.ok(/!\(r && r\.icomUsbDataModOff\)/.test(main), 'the per-rig box');
});

test('the rig editor shows the box only for these radios and keeps the choice', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(html.includes('id="set-icom-usb-data-mod" checked'));
  assert.ok(html.includes('<script src="../lib/icom-usb-data-mod.js"></script>'));
  assert.ok(/IcomUsbDataMod\.hasChoice/.test(app));
  assert.ok(/rig\.icomUsbDataModOff = true; else delete rig\.icomUsbDataModOff/.test(app));
  assert.strictEqual(M.hasChoice('IC-7300'), true);
  assert.strictEqual(M.hasChoice('IC-9700'), false);
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
