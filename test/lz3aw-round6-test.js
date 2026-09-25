// LZ3AW round 6 (his retest of 1.10.19, 2026-09-21/22) — TS-480 on serial,
// TinyMidi paddle, the web client in a desktop browser and on a phone.
//
//   1  web SPOTS banner "worked history too large ... today only" never left
//      -> test/worked-qsos-chunk-test.js (hydrated-before-hello cases)
//   2  TX power: desktop bar "not moving"; a stale SM power query turned the
//      next S-meter reply into watts; the 75-80 W reading needs his numbers
//   3  TinyMidi paddle still cut after a few seconds; local sidetone wrong
//   4  custom slider in the VFO pane: radio moved, slider did not
//   5  web Spots menu: second tap threw, then every filter was dead
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

function rig480() {
  const TS480 = RIG_MODELS['TS-480'];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const codec = new KenwoodCodec(TS480, () => {});
  const rig = new RigController(TS480, transport, codec);
  rig.connected = true;
  rig._target = { path: 'COM9' };
  rig._lastReadOkMs = Date.now();
  return { rig, codec };
}

console.log('=== #2 power meter ===');

test('an SM power query nobody answered does not turn the next S-meter reply into watts', () => {
  const { codec } = rig480();
  const watts = [], smeter = [];
  codec.on('powerMeter', (w) => watts.push(w));
  codec.on('smeter', (v) => smeter.push(v));
  codec.getPowerMeter();                       // asked during a CW over
  codec._smWantPowerAt = Date.now() - 5000;    // ...and the radio never answered
  codec.onData('SM00005;');                    // the next reply is an S reading
  assert.deepStrictEqual(watts, [], 'an S5 reading was reported as watts');
  assert.strictEqual(smeter.length, 1);
});

test('a prompt power reply is still watts, and its raw value is logged for calibration', () => {
  const { codec } = rig480();
  const watts = [], logs = [];
  codec.on('powerMeter', (w) => watts.push(w));
  codec.on('log', (m) => logs.push(m));
  codec.getPowerMeter();
  codec.onData('SM00016;');
  assert.deepStrictEqual(watts, [80]);
  assert.ok(logs.some(l => /power meter raw SM=16 of 20 -> 80 W/.test(l)), logs.join('\n'));
});

test('the VFO pop-out power bar scales to the power SETTING, not the first reading', () => {
  const vfo = R('renderer/vfo-popout.html');
  const h = vfo.slice(vfo.indexOf('window.api.onFwdPower'), vfo.indexOf('window.api.onFwdPower') + 900);
  assert.ok(/const fullScale = \(Number\(currentTxPower\) > 0\)/.test(h));
  assert.ok(/w \/ fullScale/.test(h));
});

console.log('=== #3 paddle and sidetone ===');

function remoteWithKeyer(settings) {
  const rs = new RemoteServer();
  rs.setRemoteSettings(settings);
  rs._initCwKeyer();
  return rs;
}

test('the server keyer follows the desktop paddle swap and iambic mode', () => {
  const rs = remoteWithKeyer({ cwSwapPaddles: true, cwKeyerMode: 'iambicA' });
  assert.strictEqual(rs._cwKeyer._swapPaddles, true);
  assert.strictEqual(rs._cwMode, 'iambicA');
  // A later settings push reaches a keyer that already exists.
  rs.setRemoteSettings({ cwSwapPaddles: false, cwKeyerMode: 'iambicB' });
  assert.strictEqual(rs._cwKeyer._swapPaddles, false);
  assert.strictEqual(rs._cwMode, 'iambicB');
  rs._destroyCwKeyer();
});

test('"this client repeats a held contact" ends with that client', () => {
  const rs = remoteWithKeyer({});
  rs._cwPaddleHoldAware = true;
  rs._onClientDisconnected();
  assert.strictEqual(rs._cwPaddleHoldAware, false);
  rs._destroyCwKeyer();
});

test('the hold keepalive runs on a worker timer (hidden windows clamp page timers)', () => {
  const js = R('renderer/remote.js');
  assert.ok(/new Worker\(URL\.createObjectURL\(new Blob\(/.test(js));
  const send = js.slice(js.indexOf('function sendPaddle('), js.indexOf('function sendPaddle(') + 1500);
  assert.ok(/_stopPaddleHold\(contact\);\s*if \(state\) _startPaddleHold\(contact\);/.test(send));
});

console.log('=== #4 custom slider ===');

test('the value this device sent survives a settings push, and a desktop change still wins', () => {
  const js = R('renderer/remote.js');
  const load = js.slice(js.indexOf('function loadCustomCatButtons('), js.indexOf('function loadCustomCatButtons(') + 2600);
  assert.ok(/customSliderSent\[idx\] = \+self\.value/.test(js), 'a sent value is remembered');
  assert.ok(/if \(e && !deskMoved && sig\(before\[i\]\) === sig\(e\)\) e\.value = customSliderSent\[i\];/.test(load));
  assert.ok(/const deskMoved = customSliderDesk\[i\] !== undefined && incoming !== customSliderDesk\[i\];/.test(load));
  assert.ok(/if \(view\(before\) === view\(customCatData\)[^\n]*\) return;/.test(load), 'no rebuild when nothing changed (it replaced the slider mid-drag)');
});

console.log('=== #5 web Spots menu ===');

test('no reader looks for a dropdown panel inside its toolbar (the panel lives on <body> while open)', () => {
  const js = R('renderer/remote.js');
  assert.ok(/function ddPanel\(container\)/.test(js));
  for (const bad of [
    /\bcontainer\.querySelector\('input\[value="all"\]'\)/,
    /\bcontainer\.querySelectorAll\('input:not/,
    /\bel\.querySelector\('input\[value="all"\]'\)/,
    /spotsDropdown\.querySelector\('\.rc-spots-panel'\)/,
    /spotsDropdown\.querySelector\('\.rc-(new-only|hide-worked)-row'\)/,
    /spotsDropdown\.querySelectorAll\('\[data-src\]'\)/,
    /spotsDropdown\.querySelector\(`input\[data-src=/,
  ]) {
    assert.ok(!bad.test(js), 'still reads through the toolbar: ' + bad);
  }
});

console.log(`\nLZ3AW round 6: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
