'use strict';
// ECHOCAT asks 2026-10-19: log-ok records name whose logbook each copy went
// into; status carries rigPowered from real evidence; parkState per park.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parkStateFor, expandContact } = require('../lib/qso-expand');
const RigController = require('../lib/rig-controller').RigController || require('../lib/rig-controller');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

test('parkState: bare, US-NJ token and per-park forms', () => {
  assert.strictEqual(parkStateFor('NJ', 'US-0001'), 'NJ');
  assert.strictEqual(parkStateFor('us-nj', 'US-0001'), 'NJ');
  assert.strictEqual(parkStateFor('US-0001:NJ,US-0002:PA', 'US-0002'), 'PA');
  assert.strictEqual(parkStateFor('US-0001:US-NJ', 'US-0001'), 'NJ');
  assert.strictEqual(parkStateFor('US-0001:NJ', 'US-0009'), '');
  assert.strictEqual(parkStateFor('', 'US-0001'), '');
});
test('n-fer: a pick never overwrites another park\'s single state', () => {
  const parks = { 'US-0001': { states: ['NJ', 'PA'], grid: 'FN20' }, 'US-0002': { states: ['NY'], grid: 'FN30' } };
  const recs = expandContact(
    { callsign: 'K1ABC', sig: 'POTA', sigInfo: 'US-0001,US-0002', parkState: 'PA', mode: 'SSB', frequency: '14250' },
    { parkInfo: (r) => parks[r] || null, now: Date.UTC(2026, 9, 19, 12) });
  assert.deepStrictEqual(recs.map((r) => [r.sigInfo, r.state]), [['US-0001', 'PA'], ['US-0002', 'NY']]);
  const per = expandContact(
    { callsign: 'K1ABC', sig: 'POTA', sigInfo: 'US-0001,US-0002', parkState: 'US-0001:NJ', mode: 'SSB', frequency: '14250' },
    { parkInfo: (r) => parks[r] || null, now: Date.UTC(2026, 9, 19, 12) });
  assert.strictEqual(per[0].state, 'NJ');
});
test('rigPowered evidence: answers = on, silence after answering = off, otherwise unknown', () => {
  const rc = Object.create(RigController.prototype);
  const now = Date.now();
  Object.assign(rc, { _pollStaleMs: 10000, _transmitting: false, connected: true, _pollTimer: {}, _pollRunSinceMs: now - 60000 });
  rc._lastAnswerMs = now - 1000;
  assert.strictEqual(rc.radioPowerEvidence(false), true);
  rc._lastAnswerMs = now - 30000;
  assert.strictEqual(rc.radioPowerEvidence(false), false, 'answered this session, silent now');
  rc._lastAnswerMs = 0;
  assert.strictEqual(rc.radioPowerEvidence(false), null, 'never answered: off and misconfigured look the same');
  assert.strictEqual(rc.radioPowerEvidence(true), false, 'Station Setup says this link worked before');
  rc._pollTimer = null;
  assert.strictEqual(rc.radioPowerEvidence(true), null, 'polling paused (idle): cannot tell');
  rc._pollTimer = {}; rc._pollRunSinceMs = now - 2000;
  assert.strictEqual(rc.radioPowerEvidence(true), null, 'polls only just resumed');
  rc._pollRunSinceMs = now - 60000; rc._transmitting = true;
  assert.strictEqual(rc.radioPowerEvidence(true), null, 'TX: some rigs mute CAT');
});
test('wired: records carry operator, status carries rigPowered, log-qso passes parkState', () => {
  const main = R('main.js');
  assert.ok(/operator: r\.bookOf \|\| ''/.test(main));
  assert.ok(/LogAs\.splitForOperators\(rec, targets\)/.test(main.slice(main.indexOf('async function logContact'), main.indexOf('async function saveQsoRecord'))));
  assert.ok(/rigPowered: rigPoweredForStatus\(\),/.test(main));
  assert.ok(/entry\.parkState = data\.parkState/.test(main));
  const rc = R('lib/rig-controller.js');
  assert.strictEqual((rc.match(/_noteReadOk\(false\)/g) || []).length, 2, 'synthetic TX refreshes are not answers');
});

console.log(`\nECHOCAT 10/19 asks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
