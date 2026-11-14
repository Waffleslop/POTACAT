'use strict';
// WSPR beacon RF power — GitHub #268.
//
// An IC-7100 on 2 m, over rigctld, beaconing at 50 %: the beacon forced 1 W
// (1 % of Hamlib's 100 W scale) before every frame. The radio keyed, ALC
// moved, and its wattmeter read 0 W through three frames; at 5 W it made
// 2-3 W. When the operator raised the power, the next frame and the next arm
// put 1 W back over it ("my power settings changed by themselves"). And the
// rigctld link never passed the radio's power or wattmeter to POTACAT, so the
// JTCAT window and the log said 100 W while the radio sat at 1 W.
//
// These tests pin: the beacon's level (1 W, or what the operator set while it
// was armed, per rig), which sources count as the operator, the one-line
// wattmeter verdict after a frame, and the main.js wiring.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const M = require('../lib/wspr-power-memory');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

console.log('beaconWatts');
t('nothing saved = 1 W, the default', () => {
  assert.strictEqual(M.beaconWatts(undefined, 'r1'), 1);
  assert.strictEqual(M.beaconWatts(null, 'r1'), 1);
  assert.strictEqual(M.BEACON_DEFAULT_WATTS, 1);
});
t('a level saved for this rig is used', () => {
  assert.strictEqual(M.beaconWatts({ watts: 5, rigId: 'r1' }, 'r1'), 5);
});
t('a level saved for another rig is not (a 2 m beacon level is not an HF one)', () => {
  assert.strictEqual(M.beaconWatts({ watts: 5, rigId: 'other' }, 'r1'), 1);
});
t('single-rig installs with no ids keep their level', () => {
  assert.strictEqual(M.beaconWatts({ watts: 5 }, 'r1'), 5);
  assert.strictEqual(M.beaconWatts({ watts: 5, rigId: 'r1' }, null), 5);
});
t('garbage falls back to 1 W', () => {
  assert.strictEqual(M.beaconWatts({ watts: 0 }, 'r1'), 1);
  assert.strictEqual(M.beaconWatts({ watts: 'x' }, 'r1'), 1);
  assert.strictEqual(M.beaconWatts({ watts: -3 }, 'r1'), 1);
});

console.log('operatorBeaconLevel');
t('a set while armed, from the operator, becomes the beacon level', () => {
  for (const source of ['desktop', 'echocat']) {
    assert.deepStrictEqual(M.operatorBeaconLevel({ armed: true, source, watts: 5, rigId: 'r1' }), { watts: 5, rigId: 'r1' });
  }
});
t('not armed = not a beacon level (the existing pre-beacon logic handles it)', () => {
  assert.strictEqual(M.operatorBeaconLevel({ armed: false, source: 'desktop', watts: 5 }), null);
});
t('Station Setup and a logger pushing its power field are not the operator', () => {
  assert.strictEqual(M.operatorBeaconLevel({ armed: true, source: 'setup', watts: 5 }), null);
  assert.strictEqual(M.operatorBeaconLevel({ armed: true, source: 'logger-cat', watts: 5 }), null);
});
t('0 W or garbage is ignored', () => {
  assert.strictEqual(M.operatorBeaconLevel({ armed: true, source: 'desktop', watts: 0 }), null);
  assert.strictEqual(M.operatorBeaconLevel({ armed: true, source: 'desktop', watts: NaN }), null);
});

console.log('frameRfVerdict');
t('no wattmeter readings during the frame = say nothing', () => {
  assert.strictEqual(M.frameRfVerdict({ meterFrames: 0, peakW: 0, setW: 1 }), null);
});
t('0 W for the whole frame says so, with the setting and what to do', () => {
  const line = M.frameRfVerdict({ meterFrames: 330, peakW: 0, setW: 1 });
  assert.ok(/read 0 W for the whole frame/.test(line), line);
  assert.ok(/RF power set to 1 W/.test(line), line);
  assert.ok(/Raise TX Pwr in the JTCAT window/.test(line), line);
});
t('a measured frame reports its peak', () => {
  assert.strictEqual(M.frameRfVerdict({ meterFrames: 300, peakW: 2.6, setW: 5 }), '[JTCAT] WSPR frame: peak 2.6 W measured (RF power set to 5 W).');
  assert.strictEqual(M.frameRfVerdict({ meterFrames: 300, peakW: 48.4, setW: 50 }), '[JTCAT] WSPR frame: peak 48 W measured (RF power set to 50 W).');
});

console.log('main.js wiring (source-text guards)');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
function fnBody(sig) {
  const i = main.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return main.slice(i, main.indexOf('\n}\n', i));
}
t('both rigctld connections pass the radio\'s power and wattmeter on (they passed neither)', () => {
  for (const start of ["Connecting to rigctld on 127.0.0.1", 'Connecting to remote rigctld on']) {
    const end = main.indexOf(start);
    assert.ok(end > 0, start);
    const block = main.slice(main.lastIndexOf('cat = new RigController(model, transport, codec);', end), end);
    assert.ok(block.includes("cat.on('power', sendCatPower);"), `${start}: power readback not wired`);
    assert.ok(block.includes("cat.on('powerMeter', sendCatFwdPower);"), `${start}: wattmeter not wired`);
  }
});
t('the beacon commands its level, not a fixed 1 W, and says it', () => {
  const body = fnBody('function wsprForcePowerCap()');
  assert.ok(body.includes('const beaconW = wsprBeaconWatts();'));
  assert.ok(body.includes('smartSdr.setTxPower(beaconW)'));
  assert.ok(body.includes('_currentTxPower = beaconW'), 'TX Pwr and the TX start line must show the level set');
});
t('a power set while armed, from rig-control and from ECHOCAT, becomes the beacon level', () => {
  assert.ok(main.includes('else wsprNoteOperatorPower(value, source);'));
  assert.ok(main.includes("else wsprNoteOperatorPower(value, 'echocat');"));
});
t('the pre-beacon memory compares against the beacon level, not a fixed 1 W', () => {
  for (const sig of ['function wsprRememberPreCapPower()', 'function wsprRestorePreCapPower(', 'function wsprReconcilePreCapPower(']) {
    const body = fnBody(sig);
    assert.ok(body.includes('cap: wsprBeaconWatts()'), sig);
  }
});
t('wsprBeaconWatts is a GLOBAL_KEY (it describes this machine\'s radio)', () => {
  assert.ok(/^\s*'wsprBeaconWatts',/m.test(main));
});
t('every beacon frame ends with the wattmeter line', () => {
  assert.ok(main.includes('_wsprFrameRf = { meterFrames: 0, peakW: 0, setW: wsprBeaconWatts() };'));
  assert.ok(fnBody('function sendCatFwdPower(watts)').includes('_wsprFrameRf.meterFrames++'));
  assert.ok(/ft8Engine\.on\('tx-end', \(\) => \{[\s\S]{0,400}wsprFrameRfEnd\(\);/.test(main), 'tx-end does not close the frame');
});

console.log(`\nWSPR beacon power: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
