#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
// #747: a receive-only WSPR band hop does not run "Auto-tune ATU on band
// change". Run: node test/wspr-hop-atu-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('../lib/wspr/bandhop');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

check('set to transmit = armed with a TX % above 0', () => {
  assert.strictEqual(B.beaconWillTransmit({ armed: true, txPct: 20 }), true);
  assert.strictEqual(B.beaconWillTransmit({ armed: true, txPct: 100 }), true);
  assert.strictEqual(B.beaconWillTransmit({ armed: true, txPct: 0 }), false);
  assert.strictEqual(B.beaconWillTransmit({ armed: false, txPct: 20 }), false);
  assert.strictEqual(B.beaconWillTransmit({}), false);
});

check('receive-only hop to a new band: no tune, band owed', () => {
  const d = B.bandChangeAtu({ enableAtu: true, band: '40m', lastBand: '20m', wsprHop: true, beaconTx: false });
  assert.deepStrictEqual(d, { action: 'skip', lastBand: '40m', owedBand: '40m' });
});

check('transmit-enabled hop to a new band: tunes as today', () => {
  const d = B.bandChangeAtu({ enableAtu: true, band: '40m', lastBand: '20m', wsprHop: true, beaconTx: true });
  assert.deepStrictEqual(d, { action: 'tune', lastBand: '40m', owedBand: null });
});

check('operator band change: tunes as today, beacon state does not matter', () => {
  for (const beaconTx of [false, true]) {
    const d = B.bandChangeAtu({ enableAtu: true, band: '15m', lastBand: '20m', wsprHop: false, beaconTx });
    assert.deepStrictEqual(d, { action: 'tune', lastBand: '15m', owedBand: null });
  }
  // The first tune of a session tunes too (today's code did; its "record only" branch was unreachable).
  assert.strictEqual(B.bandChangeAtu({ enableAtu: true, band: '20m', lastBand: null }).action, 'tune');
});

check('setting off, same band or no band: nothing, last band kept', () => {
  assert.deepStrictEqual(B.bandChangeAtu({ enableAtu: false, band: '40m', lastBand: '20m', wsprHop: true }),
    { action: 'none', lastBand: '20m', owedBand: null });
  assert.strictEqual(B.bandChangeAtu({ enableAtu: true, band: '20m', lastBand: '20m' }).action, 'none');
  assert.strictEqual(B.bandChangeAtu({ enableAtu: true, band: null, lastBand: '20m' }).action, 'none');
});

check('the transmit setting changing between hops: each hop follows the setting at that hop', () => {
  // A small model of the glue: lastBand and the owed band carry over.
  let lastBand = '20m', owed = null;
  const tuned = [];
  function hop(band, beaconTx) {
    const d = B.bandChangeAtu({ enableAtu: true, band, lastBand, wsprHop: true, beaconTx });
    if (d.action === 'none') return;
    lastBand = d.lastBand; owed = d.owedBand;
    if (d.action === 'tune') tuned.push(band);
  }
  hop('40m', false);                 // receive only
  assert.deepStrictEqual(tuned, []);
  assert.strictEqual(owed, '40m');
  // The operator arms the beacon here: the owed 40 m tune runs before the first frame.
  assert.strictEqual(B.owedTuneDue({ owedBand: owed, currentBand: lastBand, beaconTx: true, enableAtu: true }), true);
  hop('15m', true);                  // next hop, now set to transmit
  assert.deepStrictEqual(tuned, ['15m']);
  assert.strictEqual(owed, null);
  hop('20m', false);                 // turned back to listen only
  assert.deepStrictEqual(tuned, ['15m']);
  assert.strictEqual(owed, '20m');
  hop('40m', true);
  assert.deepStrictEqual(tuned, ['15m', '40m']);
});

check('owed tune: only on that band, only when set to transmit, only with the setting on', () => {
  assert.strictEqual(B.owedTuneDue({ owedBand: '40m', currentBand: '40m', beaconTx: true, enableAtu: true }), true);
  assert.strictEqual(B.owedTuneDue({ owedBand: '40m', currentBand: '20m', beaconTx: true, enableAtu: true }), false);
  assert.strictEqual(B.owedTuneDue({ owedBand: '40m', currentBand: '40m', beaconTx: false, enableAtu: true }), false);
  assert.strictEqual(B.owedTuneDue({ owedBand: '40m', currentBand: '40m', beaconTx: true, enableAtu: false }), false);
  assert.strictEqual(B.owedTuneDue({ owedBand: null, currentBand: '40m', beaconTx: true, enableAtu: true }), false);
  assert.ok(B.OWED_TUNE_TX_HOLD_MS >= 5000 && B.OWED_TUNE_TX_HOLD_MS < B.SLOT_MS);
});

// Glue: main.js must route every band-change tune through the rule, and the
// hop must say it is a hop.
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

check('the WSPR hop tunes with purpose wspr-hop', () => {
  const fn = main.slice(main.indexOf('function maybeHopBand()'), main.indexOf('function wsprDbmAuto()'));
  assert.ok(fn.length > 0, 'maybeHopBand not found');
  assert.ok(/tuneRadio\([^;]*\{\s*purpose:\s*'wspr-hop'\s*\}\)/.test(fn), 'maybeHopBand must pass { purpose: \'wspr-hop\' } to tuneRadio');
});

check('every tuneRadio path decides the band-change tune through bandChangeAtuTune', () => {
  const start = main.indexOf('function tuneRadio(');
  const end = main.indexOf('function bandChangeAtuTune(');
  assert.ok(start > 0 && end > start, 'tuneRadio / bandChangeAtuTune not found');
  const body = main.slice(start, end);
  const calls = body.match(/bandChangeAtuTune\(/g) || [];
  assert.strictEqual(calls.length, 3, 'three tune paths (WSJT-X+SmartSDR, Flex API, CAT)');
  assert.ok(!/_lastTuneBand\s*=/.test(body), 'tuneRadio must not set _lastTuneBand itself');
  assert.ok(/wsprBandhop\.bandChangeAtu\(/.test(main), 'bandChangeAtuTune uses lib/wspr/bandhop.js');
});

check('the beacon runs an owed tune when set to transmit, and holds its frame for it', () => {
  const arm = main.slice(main.indexOf('function setWsprBeacon('), main.indexOf('function applyWsprBeaconControl('));
  assert.ok(/wsprRunOwedAtuTune\(\)/.test(arm), 'arming runs the owed tune');
  const ctl = main.slice(main.indexOf('function applyWsprBeaconControl('), main.indexOf('function remoteJtcatMyCall('));
  assert.ok(/wsprRunOwedAtuTune\(\)/.test(ctl), 'raising TX % runs the owed tune');
  const tick = main.slice(main.indexOf('function wsprBeaconTick('), main.indexOf('function setWsprBeacon('));
  assert.ok(/_wsprOwedTuneHoldUntil/.test(tick), 'the tick holds the frame while the owed tune runs');
  assert.ok(tick.indexOf('_wsprOwedTuneHoldUntil') < tick.indexOf('decideSlot('), 'held before the slot is drawn');
});

check('no atu clear is sent by this path', () => {
  const fn = main.slice(main.indexOf('function bandChangeAtuTune('), main.indexOf('// --- potacat:// protocol handler ---'));
  assert.ok(!/atu clear/i.test(fn));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
