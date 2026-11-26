#!/usr/bin/env node
'use strict';
// The first run's "which radio" and "radio check" screens
// (renderer/first-run-radio.js): no port is opened to look for a radio, the
// Flex search only listens, and nothing transmits.
//
//   - The file calls only the window.api functions in ALLOWED. None of them
//     opens a serial port, sends to the network to find a radio, tunes,
//     changes a mode or keys the radio.
//   - listPorts is the system's list (SerialPort.list), nothing opened.
//   - discoverFlex binds UDP 4992 and only listens for the radio's broadcast.
//   - The CAT link is started once, by Save, after the radio is saved (the
//     operator's own choice of radio), never while choosing.
//   - The check runs only lib/radio-check.js ACTIONS; the transmit steps stay
//     in Station Setup behind its confirmation.
// Run: node test/first-run-radio-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = (f) => readSrc(path.join(__dirname, '..', f));
const src = R('renderer/first-run-radio.js');
const code = src.replace(/^\s*\/\/.*$/gm, ''); // the code, without its comments
const main = R('main.js');
const preload = R('preload.js');
const cat = R('lib/cat.js');
const html = R('renderer/index.html');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.stack || e)); }
}
console.log('First run, which radio and radio check: no probing, no transmit');

const ALLOWED = ['getRigModels', 'listPorts', 'discoverFlex', 'getRigSetupNotes', 'getSettings', 'saveSettings', 'connectCat', 'stationSetupGet', 'stationSetupReport'];

t('the screens call only the allowed window.api functions', () => {
  const used = [...new Set([...code.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]))].sort();
  for (const u of used) assert.ok(ALLOWED.includes(u), 'window.api.' + u + ' is not on the list');
  assert.ok(used.includes('listPorts') && used.includes('discoverFlex') && used.includes('stationSetupGet'));
  assert.ok(!/window\.api\[/.test(code), 'no computed window.api calls');
});

t('nothing that opens a port, tests a connection, tunes, keys or transmits', () => {
  for (const re of [/stationSetupAction/, /test(Serialcat|Icom|Hamlib|Flrig|Connection|Cat)/i, /SerialPort/, /\btune\w*\(/i, /\bptt\w*\(/i, /setTransmit/, /jtcat/i,
    /'tx-test'|'tx-test-current-power'|'tune-tone'|'voice-test'|'tx-device-test'|'tx-test-confirm'/, /openStationSetup/]) {
    assert.ok(!re.test(code), 'found ' + re);
  }
});

t('the port list is the system\'s list: no port is opened to make it', () => {
  assert.ok(/listPorts: \(\) => ipcRenderer\.invoke\('list-ports'\)/.test(preload));
  const h = main.slice(main.indexOf("ipcMain.handle('list-ports'"), main.indexOf("ipcMain.handle('list-rigs'"));
  assert.ok(/return listSerialPorts\(\);/.test(h) && h.split('\n').length < 6, 'the handler only lists');
  const fn = cat.slice(cat.indexOf('async function listSerialPorts()'), cat.indexOf('// --- rigctld (Hamlib) client ---'));
  assert.ok(/await SerialPort\.list\(\)/.test(fn));
  assert.ok(!/new SerialPort|\.open\(|openSync/.test(fn), 'listSerialPorts opens nothing');
});

t('Find my radio only listens for the FlexRadio\'s own broadcast', () => {
  assert.ok(/discoverFlex: \(\) => ipcRenderer\.invoke\('discover-flex'\)/.test(preload));
  assert.ok(/ipcMain\.handle\('discover-flex', \(\) => discoverFlexRadios\(\)\);/.test(main));
  const a = main.indexOf('function discoverFlexRadios(');
  const fn = main.slice(a, main.indexOf('\n}\n', a));
  assert.ok(/sock\.bind\(4992/.test(fn) && /sock\.on\('message'/.test(fn));
  assert.ok(!/\.send\(/.test(fn), 'nothing is sent');
});

t('the CAT link starts once, from Save, after the radio is saved', () => {
  const calls = code.match(/window\.api\.connectCat\(/g) || [];
  assert.strictEqual(calls.length, 1);
  const save = code.slice(code.indexOf("saveBtn.addEventListener('click'"), code.indexOf("$('wfr-back')"));
  const saved = save.indexOf('await window.api.saveSettings(Q.activationPatch(s.rigs, rig));');
  const connect = save.indexOf('window.api.connectCat(rig.catTarget);');
  assert.ok(saved > 0 && connect > saved, 'saved first, then connected');
});

t('the check runs only the read-and-listen actions', () => {
  const run = code.slice(code.indexOf('function runCheckAction('), code.indexOf('async function setupAudioRow('));
  assert.ok(/if \(!RC\.ACTIONS\.includes\(id\)\) return;/.test(run));
  const RC = require('../lib/radio-check');
  assert.deepStrictEqual(RC.ACTIONS, ['recheck', 'rx-test', 'open-rig-editor']);
  assert.ok(/RC\.inlineSteps\(payload\)/.test(code), 'steps come only through inlineSteps');
});

t('the listen is Station Setup\'s own; the transmit tests stay behind its confirmation', () => {
  const ss = R('renderer/station-setup.js');
  assert.ok(/window\.StationSetupChecks = \{ listenTest \};/.test(ss), 'only the listen is shared');
  assert.ok(/window\.StationSetupChecks\.listenTest\(/.test(code));
  assert.ok(/case 'tx-test':\n\s*case 'tx-test-current-power':\n\s*case 'tune-tone':\n\s*case 'voice-test':\n\s*confirmTx = \{ step: st\.id, action: a\.id \};/.test(ss), 'Station Setup asks first');
  assert.ok(/Nothing is sent on the air\./.test(html));
  assert.ok(/Sending audio and a short test transmission are in Station Setup \(More menu\), when you want them\./.test(html));
});

t('the radio menu settings shown come from the rig notes, never typed into the screen', () => {
  assert.ok(/window\.api\.getRigSetupNotes\(\{ model: plan\.model, radioType: plan\.radioType \}\)/.test(code));
  assert.ok(!/MENU|CAT RATE|CI-V Address/.test(code), 'no menu path written here');
});

t('the screens are in the Welcome dialog and load after Station Setup', () => {
  assert.ok(/<section class="welcome-screen hidden" id="welcome-screen-radio" data-step="radio">/.test(html));
  assert.ok(/<section class="welcome-screen hidden" id="welcome-screen-check" data-step="check">/.test(html));
  const ss = html.indexOf('<script src="station-setup.js"></script>');
  const fr = html.indexOf('<script src="first-run-radio.js"></script>');
  assert.ok(ss > 0 && fr > ss);
  for (const lib of ['rig-record', 'rig-quick-setup', 'radio-check']) {
    const i = html.indexOf('<script src="../lib/' + lib + '.js"></script>');
    assert.ok(i > 0 && i > html.indexOf('<script src="../lib/rig-model-connection.js"></script>') && i < html.indexOf('<script src="app.js"></script>'), lib);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
