#!/usr/bin/env node
'use strict';
// Startup says why it does not connect, the tune refusal names the real cause,
// Test Connection honours WSJT-X Mode, and a COM port Windows does not list is
// opened before it is called missing (#407, FTDX10 behind Win4Yaesu).
// Run: node test/cat-connect-gate-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const G = require('../lib/cat-connect-gate');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js'));
const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));

test('WSJT-X Mode holds the radio only when it is on', () => {
  assert.strictEqual(G.wsjtxHoldsRadio({ enableWsjtx: true }), true);
  assert.strictEqual(G.wsjtxHoldsRadio({ enableWsjtx: false }), false);
  assert.strictEqual(G.wsjtxHoldsRadio({}), false);
  assert.strictEqual(G.wsjtxHoldsRadio(null), false);
});

test('the wording names the setting by its real labels', () => {
  assert.ok(/> WSJT-X Mode\s*</.test(html), 'the CAT menu checkbox is labelled WSJT-X Mode');
  assert.ok(/> WSJT-X Integration</.test(html), 'Settings labels it WSJT-X Integration');
  assert.ok(G.wsjtxDeclineLine().includes('WSJT-X Mode') && G.wsjtxDeclineLine().includes('WSJT-X Integration'));
  assert.ok(G.wsjtxDeclineLine().startsWith('[CAT] Not connecting'));
  assert.ok(!/My Rigs/.test(G.wsjtxDeclineLine()), 'My Rigs is not where WSJT-X Mode lives');
});

test('after Test Connection: reconnect, leave it to WSJT-X, or nothing to connect', () => {
  const rig = { type: 'serial', path: 'COM9' };
  assert.strictEqual(G.afterCatTest({ catTarget: rig }), 'reconnect');
  assert.strictEqual(G.afterCatTest({ rigs: [{ catTarget: rig }] }), 'reconnect');
  assert.strictEqual(G.afterCatTest({ catTarget: rig, enableWsjtx: true }), 'wsjtx');
  assert.strictEqual(G.afterCatTest({ rigs: [] }), 'none');
  assert.strictEqual(G.afterCatTest({ enableWsjtx: true }), 'none');
  assert.ok(G.wsjtxTestNote().includes('WSJT-X Mode is on'));
});

test('tune refusal: WSJT-X Mode, None and a missing port each name the cause; otherwise unchanged', () => {
  const plain = G.tuneRefusal({});
  assert.strictEqual(plain.log, 'tune refused — no radio connected. Check Settings -> My Rigs.');
  assert.strictEqual(plain.toast, 'Radio not connected — check the USB/serial link (Settings > My Rigs)');
  assert.strictEqual(G.tuneRefusal({ verb: 'ignored' }).log, 'tune ignored — no radio connected. Check Settings -> My Rigs.');
  const w = G.tuneRefusal({ wsjtxMode: true, waitingPort: 'COM9' });
  assert.ok(/WSJT-X Mode is on/.test(w.log) && /WSJT-X Mode/.test(w.toast), 'WSJT-X Mode wins: it is why nothing opened the port');
  assert.ok(!/My Rigs/.test(w.log + w.toast));
  const n = G.tuneRefusal({ catNone: true });
  assert.ok(/None/.test(n.log) && /pick one/i.test(n.toast));
  const p = G.tuneRefusal({ waitingPort: 'COM9' });
  assert.ok(/COM9 is not there/.test(p.log) && /COM9/.test(p.toast));
});

test('an open error decides whether an unlisted port exists', () => {
  assert.strictEqual(G.classifyOpenResult(null), 'opened');
  assert.strictEqual(G.classifyOpenResult(new Error('Opening COM9: File not found')), 'absent');
  assert.strictEqual(G.classifyOpenResult(new Error('Opening COM9: Unknown error code 3')), 'absent');
  assert.strictEqual(G.classifyOpenResult(new Error('Error: No such file or directory, cannot open /dev/ttyUSB9')), 'absent');
  assert.strictEqual(G.classifyOpenResult(new Error('Opening COM9: Access denied')), 'busy', 'held by our own link or another program: it is there');
  assert.strictEqual(G.classifyOpenResult(new Error('Opening COM9: Unknown error code 31')), 'busy');
  assert.strictEqual(G.classifyOpenResult(new Error('Opening COM9: Unknown error code 121')), 'busy', 'not mistaken for code 2/3');
  assert.ok(/COM9 is not in Windows' lists/.test(G.unlistedPortLine('COM9', 'opened')) && /Win4Yaesu/.test(G.unlistedPortLine('COM9', 'opened')));
  assert.ok(/another program may hold it/.test(G.unlistedPortLine('COM9', 'busy')));
});

test('wiring: startup logs the WSJT-X decline; the delayed Icom start does too', () => {
  assert.ok(/if \(!settings\.enableWsjtx\) connectCatWithStartupDelay\(\);\n\s*else logConnectCatSkip\(CatGate\.wsjtxDeclineLine\(\)\);/.test(main));
  const fn = main.slice(main.indexOf('function connectCatWithStartupDelay('), main.indexOf('function connectCatSafe('));
  assert.ok(/\} else \{\n\s*logConnectCatSkip\(CatGate\.wsjtxDeclineLine\(\)\);/.test(fn));
});

test('wiring: Test Connection honours WSJT-X Mode and says so', () => {
  const w = main.slice(main.indexOf('const handleCatTest = '), main.indexOf("handleCatTest('test-serial-cat'"));
  assert.ok(/const next = CatGate\.afterCatTest\(settings\);\n\s*if \(next === 'reconnect'\) connectCatSafe\(label \+ ' finished'\);/.test(w));
  assert.ok(/else if \(next === 'wsjtx'\) sendCatLog\(/.test(w));
  assert.ok(/return withWsjtxTestNote\(await fn\(e, config\)\);/.test(w));
  assert.ok(/return withWsjtxTestNote\(\{ success: true, frequency: freq \}\);/.test(main), 'the Hamlib test says it too');
  assert.ok(/function rigTestWsjtxNote\(result\)/.test(app));
  assert.ok((app.match(/rigTestWsjtxNote\((result|r)\)/g) || []).length >= 6, 'every rig-editor test shows the note');
});

test('wiring: both tune refusals use the shared wording', () => {
  assert.ok(!main.includes("sendCatLog('tune refused — no radio connected. Check Settings -> My Rigs.');"));
  assert.ok(!main.includes("sendCatLog('tune ignored — no radio connected. Check Settings -> My Rigs.');"));
  assert.ok(/const why = CatGate\.tuneRefusal\(\{ verb: 'refused'/.test(main));
  assert.ok(/_e\.sender\.send\('tune-blocked', why\.toast\);/.test(main));
  assert.ok(/CatGate\.tuneRefusal\(\{ verb: 'ignored'/.test(main));
});

test('wiring: a Windows port in neither list is opened, with DTR/RTS low, before it is called missing', () => {
  const fn = main.slice(main.indexOf('async function serialPortPresent('), main.indexOf('function windowsSerialCommPorts('));
  const reg = fn.indexOf('await windowsSerialCommPorts()');
  const probe = fn.indexOf('CatGate.classifyOpenResult(await openSerialPortOnce(port))');
  assert.ok(reg > 0 && probe > reg, 'the open comes after both lists');
  assert.ok(/if \(how === 'absent'\) return false;/.test(fn));
  assert.ok(/sendCatLog\(CatGate\.unlistedPortLine\(port, how\)\)/.test(fn) && /_catUnlistedPortNoted\.has\(key\)/.test(fn), 'logged once per port');
  assert.ok(/hupcl: false, rtscts: false/.test(fn), 'the probe never raises DTR or RTS');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
