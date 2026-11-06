#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Review of the SCU-LAN10 / scope / UI work:
//  - The VFO window's speaker with LAN audio lit up and played the room mic
//    (only smartsdr/icom-network were direct playback) and main never sent
//    the LAN frames to the VFO window.
//  - A serial close that never reported finishing blamed POTACAT for another
//    program's "Access denied" for the rest of the run.
//  - Test Connection could not name an FT-710 (ID0800).
//  - The scope window and the Band Scope tooltip spoke only of USB.
//  - The LAN transport: one "early" window, the log line honest about audio,
//    and datagrams from anything but the unit ignored.
// Run: node test/lan-review-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const R = (f) => readSrc(path.join(__dirname, '..', f));
const main = R('main.js');

test('the VFO window plays LAN audio itself, and main sends it the frames', () => {
  assert.ok(/if \(s\.audioSource === 'smartsdr' \|\| s\.audioSource === 'icom-network' \|\| s\.audioSource === 'yaesu-lan'\) \{/.test(R('renderer/vfo-popout.html')));
  const sent = [];
  const fn = main.slice(main.indexOf('function handleYaesuLanAudioFrame('), main.indexOf('function handleK4AudioFrame('));
  const ctx = {
    settings: { audioSource: 'yaesu-lan' }, _yaesuLanAudioFrames: 0, require,
    _yaesuLanResamplers: { rate: 16000, to12k: { process: () => [] }, to24k: { process: () => [] }, to48k: { process: () => [] } },
    remoteAudioWin: null, win: null, jtcatPopoutWin: null, jtcatManager: null, sstvEngine: null, sstvPopoutWin: null, _sstvFeedPaused: false,
    vfoPopoutWin: { isDestroyed: () => false, webContents: 'vfo' },
    audioSafeSend: (wc, ch, d) => sent.push([wc, ch, d.sampleRate]),
    SstvFeedGate: { streamAudioDecision: () => ({ accept: false }) },
    sendCatLog: () => {}, peakFloat32: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.f = handleYaesuLanAudioFrame;', ctx);
  ctx.f({ pcm: new Float32Array(320), sampleRate: 16000 });
  assert.deepStrictEqual(sent, [['vfo', 'smartsdr-audio-frame', 16000]]);
});

test('a port that opened again is no longer "still closing" from POTACAT\'s side', () => {
  const src = R('lib/transport.js');
  const ctx = { Date, String, Map };
  vm.createContext(ctx);
  vm.runInContext(src.slice(src.indexOf('const _recentClose = new Map();'), src.indexOf('class SerialTransport')) + '\nthis.rc = _recentClose; this.recent = recentOwnClose; this.forget = forgetOwnClose;', ctx);
  ctx.rc.set('COM6', { at: Date.now() - 3600000, closed: false });   // an hour-old close that never finished
  assert.ok(ctx.recent('COM6'), 'blamed on POTACAT before');
  ctx.forget('com6');
  assert.strictEqual(ctx.recent('COM6'), null, 'cleared once the port opened');
  assert.ok(/port\.on\('open', \(\) => \{[\s\S]{0,900}forgetOwnClose\(port\.path \|\| \(this\._target && this\._target\.path\)\);/.test(src));
});

test('Test Connection names an FT-710 (ID0800)', () => {
  assert.ok(/'0800': 'FT-710'/.test(main));
});

test('the scope window and the Band Scope tooltip know the LAN', () => {
  assert.ok(/const onLan = settings\.catTarget && settings\.catTarget\.type === 'yaesu-lan';/.test(main));
  assert.ok(/Waiting for the radio\\'s scope over the LAN/.test(main));
  assert.ok(/id="view-scope-btn" title="The radio's own band scope: over its USB cable \(FT-710\), the network/.test(R('renderer/index.html')));
});

test('the LAN transport: one early window, an honest log line, only the unit\'s datagrams', () => {
  const src = R('lib/sculan10-transport.js');
  assert.ok(/earlyMs: opts\.earlyMs \|\| 60000,/.test(src));
  assert.ok(/const early = this\._now\(\) - s\.readyAt < this\._opts\.earlyMs;/.test(src));
  assert.ok(/this\._earlyLosses = 0; \}, o\.earlyMs\);/.test(src));
  assert.ok(/CAT \(and RX audio when selected\) streaming/.test(src));
  const { Sculan10Transport } = require('../lib/sculan10-transport');
  const t = new Sculan10Transport({});
  const logs = [];
  t._log = (l) => logs.push(l);
  t._sockets = {};
  t._session = { addr: '192.168.49.1', stats: { cat: { rxPk: 0, rxMin: 0, rxMax: 0, rxLast: 0 } } };
  t._onMessage('cat', Buffer.alloc(24), { address: '10.0.0.5' });
  assert.strictEqual(t._session.stats.cat.rxPk, 0, 'a stranger\'s datagram is not counted');
  assert.ok(logs.some((l) => /ignored a datagram from 10\.0\.0\.5/.test(l)));
});

console.log(`\nSCU-LAN10, scope and UI review: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
