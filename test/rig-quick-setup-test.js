#!/usr/bin/env node
'use strict';
// The first run's "which radio" step (lib/rig-quick-setup.js): find the model,
// fill in the rest from it, offer the port that is plainly the radio's, and
// save it as the radio in use. Run: node test/rig-quick-setup-test.js
const assert = require('assert');
const Q = require('../lib/rig-quick-setup');
const { getModelList, RIG_MODELS } = require('../lib/rig-models');
const RMC = require('../lib/rig-model-connection');

const groups = getModelList();
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.stack || e)); }
}
console.log('Which radio: model first, the rest filled in');

t('search: the number alone finds the radio, best match first', () => {
  const r = Q.searchModels(groups, '7300');
  assert.deepStrictEqual(r.slice(0, 2).map((x) => x.model), ['IC-7300', 'IC-7300 MK II']);
  assert.strictEqual(Q.searchModels(groups, 'ic 7300')[0].model, 'IC-7300');
  assert.strictEqual(Q.searchModels(groups, 'IC-705')[0].model, 'IC-705');
  assert.strictEqual(Q.searchModels(groups, 'ft710')[0].model, 'FT-710');
  assert.ok(Q.searchModels(groups, 'yaesu 710').some((x) => x.model === 'FT-710'), 'maker and number');
  assert.ok(Q.searchModels(groups, 'flex').every((x) => x.brand === 'FlexRadio'));
  assert.strictEqual(Q.searchModels(groups, 'flex').length, 7);
  assert.deepStrictEqual(Q.searchModels(groups, ''), [], 'nothing typed, nothing listed');
  assert.deepStrictEqual(Q.searchModels(groups, 'zzzz'), []);
  assert.ok(Q.searchModels(groups, 'ft', 5).length <= 5, 'a short list');
});

t('every model the app knows gets a plan, by the Settings editor\'s own rule', () => {
  for (const g of groups) {
    for (const m of g.models) {
      const plan = Q.planForModel(groups, m);
      assert.ok(plan, m);
      assert.strictEqual(plan.radioType, RMC.connectionForModel({ model: m, group: g, current: 'none' }).type, m);
      assert.ok(plan.how && !/undefined|null/.test(plan.how), m + ' says what it set: ' + plan.how);
    }
  }
  assert.strictEqual(Q.planForModel(groups, 'Not A Radio'), null);
});

t('IC-7300 over USB: Icom CI-V, 115200 baud, CI-V address 94h from the model, needs the port', () => {
  const p = Q.planForModel(groups, 'IC-7300');
  assert.strictEqual(p.radioType, 'icom');
  assert.strictEqual(p.baudRate, 115200);
  assert.strictEqual(p.civAddress, RIG_MODELS['IC-7300'].civAddr);
  assert.strictEqual(p.civAddress, 0x94);
  assert.ok(p.needsPort && p.quick && !p.chooseBaud);
  assert.strictEqual(p.audioSource, 'dax');
  assert.ok(/CI-V address 94h/.test(p.how));
  assert.ok(p.networkAlt, 'an Icom can also be reached over the network, in Settings');
  for (const m of ['IC-705', 'IC-7610', 'IC-9700']) assert.strictEqual(Q.planForModel(groups, m).civAddress, RIG_MODELS[m].civAddr, m);
});

t('a Yaesu over USB: Serial CAT, the editor\'s baud list with its 9600 default, never "Serial CAT or CI-V" to choose', () => {
  const p = Q.planForModel(groups, 'FT-710');
  assert.strictEqual(p.radioType, 'serialcat');
  assert.ok(p.chooseBaud && p.needsPort);
  assert.strictEqual(p.baudRate, 9600);
  assert.deepStrictEqual(Q.BAUD_CHOICES, [4800, 9600, 19200, 38400, 57600, 115200]);
  assert.ok(p.networkAlt, 'SCU-LAN10 in Settings');
  assert.ok(!Q.planForModel(groups, 'FT-891').networkAlt);
});

t('FlexRadio: network, Flex Direct audio, no port; X6100 through flrig (#1084); G90 through Hamlib; Pebble without CAT', () => {
  const f = Q.planForModel(groups, 'FLEX-6600/6600M');
  assert.strictEqual(f.radioType, 'flex');
  assert.ok(!f.needsPort);
  assert.strictEqual(f.audioSource, 'smartsdr');
  const x = Q.planForModel(groups, 'X6100');
  assert.strictEqual(x.radioType, 'flrig', 'preferredConnection: never Serial CAT');
  assert.deepStrictEqual([x.flrigHost, x.flrigPort], ['127.0.0.1', 12345]);
  const g = Q.planForModel(groups, 'G90');
  assert.deepStrictEqual([g.radioType, g.hamlibRigId, g.baudRate], ['hamlib', 3088, 19200]);
  assert.ok(g.needsPort);
  const n = Q.planForModel(groups, 'Pebble HF');
  assert.strictEqual(n.radioType, 'nocat');
  assert.ok(!n.needsPort);
  const z = Q.planForModel(groups, 'Zeus SDR (TS-2000 CAT)');
  assert.ok(!z.quick, 'a network-only connection is set up in Settings > Radio');
  assert.strictEqual(Q.buildRig(z, {}), null);
});

t('ports: only what the system listed, without duplicate names', () => {
  const mac = [
    { path: '/dev/tty.usbserial-1', friendlyName: '/dev/tty.usbserial-1' },
    { path: '/dev/cu.usbserial-1', friendlyName: '/dev/cu.usbserial-1' },
    { path: '/dev/tty.Bluetooth-Incoming-Port', friendlyName: 'x' },
  ];
  assert.deepStrictEqual(Q.radioPorts(mac).map((p) => p.path), ['/dev/cu.usbserial-1', '/dev/tty.Bluetooth-Incoming-Port']);
  const linux = [
    { path: '/dev/ttyUSB0', friendlyName: '/dev/ttyUSB0' },
    { path: '/dev/serial/by-id/usb-Icom_IC-7300-if00', manufacturer: 'Stable by-id alias', friendlyName: 'usb-Icom_IC-7300-if00 (ttyUSB0)' },
  ];
  assert.deepStrictEqual(Q.radioPorts(linux).map((p) => p.path), ['/dev/serial/by-id/usb-Icom_IC-7300-if00']);
  const win = [{ path: 'COM3', friendlyName: 'Silicon Labs CP210x USB to UART Bridge (COM3)' }];
  assert.deepStrictEqual(Q.radioPorts(win), win);
  assert.deepStrictEqual(Q.radioPorts(null), []);
});

t('the port offered: the only one; the one named for the radio; else none, and the screen explains', () => {
  const icom = Q.planForModel(groups, 'IC-7300');
  const yaesu = Q.planForModel(groups, 'FT-710');
  assert.deepStrictEqual(Q.suggestPort([], icom), { path: '', reason: 'none' });
  assert.deepStrictEqual(Q.suggestPort([{ path: 'COM3', friendlyName: 'Silicon Labs CP210x USB to UART Bridge (COM3)' }], icom), { path: 'COM3', reason: 'only' });
  // Bluetooth links never count as the radio's cable.
  assert.deepStrictEqual(Q.suggestPort([
    { path: 'COM3', friendlyName: 'Silicon Labs CP210x USB to UART Bridge (COM3)' },
    { path: 'COM9', friendlyName: 'Standard Serial over Bluetooth link (COM9)' },
  ], icom), { path: 'COM3', reason: 'only' });
  // Yaesu dual CP2105: CAT is the Enhanced port (lib/rig-setup-notes.js FT-991A, FT-710, FTX-1).
  assert.deepStrictEqual(Q.suggestPort([
    { path: 'COM5', friendlyName: 'Silicon Labs Dual CP2105 USB to UART Bridge: Enhanced COM Port (COM5)' },
    { path: 'COM6', friendlyName: 'Silicon Labs Dual CP2105 USB to UART Bridge: Standard COM Port (COM6)' },
  ], yaesu), { path: 'COM5', reason: 'match' });
  // Linux by-id names carry the model.
  assert.deepStrictEqual(Q.suggestPort([
    { path: '/dev/ttyACM0', friendlyName: '/dev/ttyACM0' },
    { path: '/dev/ttyUSB1', friendlyName: '/dev/ttyUSB1' },
    { path: '/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_IC-7300_03001234-if00-port0', manufacturer: 'Stable by-id alias', friendlyName: 'usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_IC-7300_03001234-if00-port0 (ttyUSB1)' },
  ], icom).path, '/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_IC-7300_03001234-if00-port0');
  // Two that look alike: no guess.
  assert.deepStrictEqual(Q.suggestPort([
    { path: 'COM3', friendlyName: 'USB Serial Port (COM3)' },
    { path: 'COM4', friendlyName: 'USB Serial Port (COM4)' },
  ], icom), { path: '', reason: 'several' });
});

t('Save waits for what the radio needs, and says what is missing', () => {
  const icom = Q.planForModel(groups, 'IC-7300');
  assert.strictEqual(Q.missing(icom, {}), 'Choose the port the radio is on.');
  assert.strictEqual(Q.missing(icom, { port: 'COM3' }), '');
  const flex = Q.planForModel(groups, 'FLEX-6400/6400M');
  assert.ok(/Find the radio/.test(Q.missing(flex, {})));
  assert.strictEqual(Q.missing(flex, { flexHost: '192.168.1.50' }), '');
  assert.strictEqual(Q.missing(Q.planForModel(groups, 'Pebble HF'), {}), '');
  assert.ok(Q.missing(null, {}));
});

t('the saved radio is the radio in use, with the CAT menu switch\'s keys; saving again replaces it', () => {
  const plan = Q.planForModel(groups, 'IC-7300');
  const rig = Q.buildRig(plan, { port: 'COM3', now: 42 });
  assert.strictEqual(rig.id, 'rig_42');
  assert.strictEqual(rig.name, 'IC-7300');
  assert.deepStrictEqual(rig.catTarget, { type: 'icom', path: 'COM3', baudRate: 115200, civAddress: 0x94, civModel: 'IC-7300', civPace: 'auto' });
  const other = { id: 'rig_1', name: 'FT-891', catTarget: { type: 'serial' } };
  const p = Q.activationPatch([other], rig);
  assert.deepStrictEqual(Object.keys(p), ['rigs', 'activeRigId', 'catTarget', 'remoteAudioInput', 'remoteAudioOutput', 'cwKeyPort', 'audioSource']);
  assert.deepStrictEqual(p.rigs.map((r) => r.id), ['rig_1', 'rig_42'], 'the other radios are kept');
  assert.strictEqual(p.activeRigId, 'rig_42');
  assert.deepStrictEqual(p.catTarget, rig.catTarget);
  const again = Q.buildRig(plan, { id: 'rig_42', port: 'COM4' });
  const p2 = Q.activationPatch(p.rigs, again);
  assert.deepStrictEqual(p2.rigs.map((r) => r.id), ['rig_1', 'rig_42'], 'Back and Save again: no second copy');
  assert.strictEqual(p2.rigs[1].catTarget.path, 'COM4');
  // The CAT menu's switch sends the same keys (renderer/app.js).
  const app = require('./_src').readSrc(require('path').join(__dirname, '..', 'renderer', 'app.js'));
  const sw = app.slice(app.indexOf('window.api.connectCat(rig.catTarget);\n      await window.api.saveSettings({'), app.indexOf('activeRigName = rig.name || \'\';'));
  for (const k of ['activeRigId', 'catTarget', 'remoteAudioInput', 'remoteAudioOutput', 'cwKeyPort', 'audioSource']) assert.ok(sw.includes(k + ':'), 'switch sends ' + k);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
