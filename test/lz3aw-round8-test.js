#!/usr/bin/env node
'use strict';
// LZ3AW round 8 (on 1.10.24): "big paddle improvement, but quite a few
// mistakes". The ECHOCAT hold keepalive (a held contact re-sent every 400 ms)
// reached the keyer as a fresh press; mid-element that set the latch and the
// radio sent one element more than the operator did — while the browser's own
// keyer, which never sees keepalives, sounded the right thing.
// Run: node test/lz3aw-round8-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { IambicKeyer } = require('../lib/keyer');

let passed = 0, failed = 0;
// Sequential: the cases are timing-sensitive, so never run two keyers at once.
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

function keyerAt(wpm) {
  const k = new IambicKeyer();
  k.setWpm(wpm);
  const downs = [];
  k.on('key', (e) => { if (e.down) downs.push(Date.now()); });
  return { k, downs };
}

console.log('LZ3AW round 8');

test('a repeated press of a held dit (keepalive) mid-element adds no element', async () => {
  // 20 WPM: dit 60 ms. Press, repeat the press 20 ms in (inside the first
  // dit), release at 100 ms (inside the gap). Operator sent ONE dit.
  const { k, downs } = keyerAt(20);
  k.paddleDit(true);
  await sleep(20);
  k.paddleDit(true); // the keepalive
  await sleep(80);
  k.paddleDit(false);
  await sleep(400);
  k.stop();
  assert.strictEqual(downs.length, 1, `expected one dit, keyer sent ${downs.length}`);
});

test('a repeated press of a held dah adds no element either', async () => {
  const { k, downs } = keyerAt(20); // dah 180 ms
  k.paddleDah(true);
  await sleep(100);
  k.paddleDah(true);
  await sleep(100); // release at 200 ms, inside the gap (180-240 ms)
  k.paddleDah(false);
  await sleep(500);
  k.stop();
  assert.strictEqual(downs.length, 1, `expected one dah, keyer sent ${downs.length}`);
});

test('a real second press still latches (the fix is edge-only, not latch-off)', async () => {
  const { k, downs } = keyerAt(20);
  k.paddleDit(true);
  await sleep(20);
  k.paddleDit(false);
  await sleep(10);
  k.paddleDit(true); // a genuine new press inside the first dit
  await sleep(25);
  k.paddleDit(false);
  await sleep(400);
  k.stop();
  assert.strictEqual(downs.length, 2, `a real second press is a second dit (got ${downs.length})`);
});

test('the server sends keepalives to the watchdog only, never to the keyer', () => {
  const rs = R('lib/remote-server.js');
  const at = rs.indexOf("case 'paddle':");
  const block = rs.slice(at, rs.indexOf("case 'cw-config'", at));
  const hold = block.indexOf('if (msg.hold) {');
  const keyer = block.indexOf('this._cwKeyer.paddleDit(');
  assert.ok(hold > 0 && keyer > hold, 'the hold branch comes before the keyer call');
  assert.ok(/if \(msg\.hold\) \{[\s\S]{0,120}this\._armCwPaddleWatchdog\(\);\s*break;/.test(block), 'hold re-arms the watchdog and stops');
});

// "Something like an echo of the side tone, or a second side tone" on the web,
// radio sidetone OFF, gone after reconnecting audio. The desktop mixed its own
// morse into the RX WebRTC stream for every CW text send while the web page
// played its own local copy of the same text.
test('the desktop does not mix a second sidetone for a client that plays its own', () => {
  const main = R('main.js');
  const fn = main.slice(main.indexOf('function sendCwTextToRadio('), main.indexOf("'cw-sidetone-play'") + 40);
  assert.ok(/_clientHasOwnSidetone = !!\(_cwClient && _cwClient\.capabilities\.includes\('local-cw-sidetone'\)\)/.test(fn));
  assert.ok(/!_clientHasOwnSidetone\) \{\s*remoteAudioWin\.webContents\.send\('cw-sidetone-play'/.test(fn), 'the bridge copy is gated');
  assert.ok(/opts\.fromRemote/.test(fn), 'only for text the client itself sent (a desktop macro still reaches the listener)');
  assert.ok(/sendCwTextToRadio\(text, \{ live: !!live, fromRemote: true \}\)/.test(main), 'the ECHOCAT cw-text path marks its origin');
  const web = R('renderer/remote.js');
  assert.ok(/capabilities: \[[^\]]*'local-cw-sidetone'/.test(web), 'ECHOCAT Web declares it in hello');
});

test('restarting ECHOCAT audio tears down the old sidetone mix graph', () => {
  const html = R('renderer/remote-audio.html');
  const start = html.slice(html.indexOf('window.api.onStartAudio('), html.indexOf('// Capture radio\'s USB audio output'));
  assert.ok(/tearDownLocalMixGraph\(\);/.test(start), 'onStartAudio resets the mix graph built on the previous stream');
});

// TX meter "still not reaching 100 W, shows 70-75 W ... not so dynamic as on
// the radio". One instantaneous CAT sample per 2 s, drawn as-is, against a
// peak-reading radio bar.
test('wattmeter peak-hold: jumps up, holds, decays toward the live value, never below it', () => {
  const { createPeakHold } = require('../lib/meter-peak-hold');
  const h = createPeakHold({ holdMs: 1000, decayPerSec: 0.5 });
  assert.strictEqual(h.sample(95, 0), 95, 'a new peak shows at once');
  assert.strictEqual(h.sample(30, 500), 95, 'held for the hold time (CW sample between elements)');
  assert.strictEqual(h.sample(30, 2000), 47.5, 'then decays 50 % per second');
  assert.strictEqual(h.sample(80, 2100), 80, 'a higher live value wins immediately');
  assert.strictEqual(h.sample(0, 9000), 1.3, 'decays toward zero (80 W peak, 5.9 s past its hold)');
  h.reset();
  assert.strictEqual(h.sample(10, 9100), 10, 'reset forgets the old peak');
});

test('every wattmeter surface gets the held value, and the TX poll samples it every cycle', () => {
  const main = R('main.js');
  const fn = main.slice(main.indexOf('function sendCatFwdPower('), main.indexOf('function sendCatPower('));
  assert.ok(/push\(_fwdPowerHold\.sample\(w\)\)/.test(fn), 'the one fan-out holds the peak');
  assert.ok(/_fwdPowerHold\.reset\(\); push\(0\)/.test(fn), 'the silence reset clears it');
  assert.ok(/peakW = w/.test(fn), 'Station Setup still measures the raw sample');
  const rc = R('lib/rig-controller.js');
  // Round 10 (9/29): direct serial reads it on its own 300 ms timer; the
  // main tick still asks every cycle when that timer is off (rigctld).
  assert.ok(/if \(txMeters && !this\._fastTxMeter\) this\._askPowerMeter\(\);/.test(rc), 'power meter is not behind the every-2nd-cycle gate');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (e.stack || e.message)); }
  }
  console.log(`\nLZ3AW round 8: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
