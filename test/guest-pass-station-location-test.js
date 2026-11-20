#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * A Guest Pass contact carries the LENDING station's location (#822): the
 * radio is at the owner's QTH, so MY_GRIDSQUARE, MY_STATE and MY_CNTY are the
 * station's, stamped by the station, and the guest's POTACAT never fills them
 * from the guest's own home (on save or at LoTW upload).
 */
const assert = require('assert');
const path = require('path');
const SC = require('../lib/station-county');
const { buildAdifFields } = require('../lib/adif-writer');
const { splitForLotw, buildActivationTqslArgs } = require('../lib/lotw-split');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// The station that lends the radio (host) and the guest, each with a home.
const HOST = { state: 'PA', county: 'Bucks', grid: 'FN20jc' };
const GUEST = { state: 'VA', county: 'Fairfax', grid: 'FM18lv' };
const HOST_PARKS = { 'US-1352': { state: 'PA', county: 'Bucks' } };

// main.js stationLocationFillFor, minus the park list: the guard, then the
// operator's own state and county (lib/station-county.js).
function fillFor(home, parks = {}) {
  return (rec) => {
    if (!rec) return {};
    if (!SC.ownStationFillApplies(rec)) return {};
    return SC.stationLocationFor(rec, { home, parkCounty: (r) => parks[r] || null });
  };
}
const hostStamp = (rec) => SC.guestPassStationFor(rec, { grid: HOST.grid, fill: fillFor(HOST, HOST_PARKS) });
// The guest's saveQsoRecord: Object.assign(qsoData, stationLocationFillFor(qsoData, ops)).
const guestSave = (rec) => Object.assign({}, rec, fillFor(GUEST)(rec));

console.log('The lending station stamps its own location');
check('a guest contact carries the station grid, state and county', () => {
  const q = { callsign: 'W1AW', frequency: '14074', mode: 'FT8' };
  Object.assign(q, hostStamp(q));
  assert.deepStrictEqual([q.myGridsquare, q.myState, q.myCounty], ['FN20jc', 'PA', 'PA,Bucks']);
  const f = buildAdifFields({ ...q, guestPass: true });
  assert.strictEqual(f.MY_GRIDSQUARE, 'FN20jc');
  assert.strictEqual(f.MY_STATE, 'PA');
  assert.strictEqual(f.MY_CNTY, 'PA,Bucks', 'the guest\'s cloud logbook record (pass outbox) has them too');
});
check('the same values the station logs for its own contacts', () => {
  const own = fillFor(HOST, HOST_PARKS)({ callsign: 'W1AW' });
  const g = hostStamp({ callsign: 'W1AW' });
  assert.strictEqual(g.myState, own.myState);
  assert.strictEqual(g.myCounty, own.myCounty);
});
check('a grid, state or county the guest\'s device sent is replaced: it is where the guest is', () => {
  const g = hostStamp({ callsign: 'W1AW', myGridsquare: 'FM18lv', myState: 'VA', myCounty: 'VA,Fairfax' });
  assert.deepStrictEqual(g, { myGridsquare: 'FN20jc', myState: 'PA', myCounty: 'PA,Bucks' });
});
check('an activation takes the park\'s location, blanks only', () => {
  assert.deepStrictEqual(hostStamp({ mySigInfo: 'US-1352' }), { myState: 'PA', myCounty: 'PA,Bucks' });
  assert.deepStrictEqual(hostStamp({ mySigInfo: 'US-1352', myState: 'NJ' }), {}, 'a supplied state is kept; no county across states');
});
check('a station with no grid or home set stamps nothing it does not know', () => {
  const g = SC.guestPassStationFor({ callsign: 'W1AW' }, { grid: '', fill: fillFor({}) });
  assert.deepStrictEqual(g, { myGridsquare: '', myState: '', myCounty: '' });
  assert.strictEqual(SC.guestPassStationFor({}, { grid: 'nonsense', fill: fillFor({}) }).myGridsquare, '');
});

console.log('The guest\'s POTACAT keeps them');
check('save: the station\'s fields stay, the guest\'s home never goes in', () => {
  const fromHost = { callsign: 'W1AW', guestPass: true, ...hostStamp({ callsign: 'W1AW' }) };
  const saved = guestSave(fromHost);
  assert.deepStrictEqual([saved.myGridsquare, saved.myState, saved.myCounty], ['FN20jc', 'PA', 'PA,Bucks']);
});
check('save: a station that sent a state but no county gets no county from the guest\'s home', () => {
  const saved = guestSave({ callsign: 'W1AW', guestPass: true, myGridsquare: 'FM18ab', myState: 'VA' });
  assert.ok(!saved.myCounty, 'same grid square and state as the guest\'s home: still not the guest\'s county');
});
check('LoTW: the fill leaves a Guest Pass record alone (APP_POTACAT_GUEST_PASS)', () => {
  assert.deepStrictEqual(fillFor(GUEST)({ myGridsquare: 'FN20jc', myState: 'PA', guestPass: '1' }), {});
});
check('LoTW: Guest Pass contacts are their own batch, signed from the records, never with the guest\'s Station Location', () => {
  const recs = [
    { CALL: 'W1AW', QSO_DATE: '20261120', STATION_CALLSIGN: 'W7RTA', MY_GRIDSQUARE: 'FN20jc', MY_STATE: 'PA', MY_CNTY: 'PA,Bucks', APP_POTACAT_GUEST_PASS: '1' },
    { CALL: 'W1AX', QSO_DATE: '20261120', STATION_CALLSIGN: 'W7RTA' },
  ];
  const calls = [];
  const { home, activations } = splitForLotw(recs, { myCallsign: 'W7RTA', fill: (q) => { calls.push(q.CALL); return { MY_STATE: 'VA', MY_CNTY: 'VA,Fairfax' }; } });
  assert.deepStrictEqual(home.map((q) => q.CALL), ['W1AX'], 'the guest\'s own contact stays in the home batch');
  assert.strictEqual(activations.length, 1);
  const b = activations[0];
  assert.ok(b.guestPass && !b.skip);
  assert.deepStrictEqual([b.call, b.grid, b.state, b.county], ['W7RTA', 'FN20JC', 'PA', 'PA,Bucks'], 'what the fill offered never replaces the station\'s fields');
  assert.strictEqual(b.records[0].MY_CNTY, 'PA,Bucks');
  assert.ok(/^Guest Pass FN20JC PA, Bucks/.test(b.label), b.label);
  const args = buildActivationTqslArgs({ call: b.call, adifPath: 'x.adi' });
  assert.strictEqual(args[args.indexOf('-l') + 1], '', 'no Station Location');
});

console.log('A station on an older POTACAT (no location sent)');
check('save: nothing from the guest\'s home on a contact not made from home', () => {
  assert.deepStrictEqual(fillFor(GUEST)({ callsign: 'W1AW', guestPass: true }), {});
  const saved = guestSave({ callsign: 'W1AW', guestPass: true });
  assert.ok(!saved.myState && !saved.myCounty);
});
check('save: an activation still takes the park\'s location, never the home one', () => {
  const parks = { 'US-0001': { state: 'MD', county: 'Frederick' } };
  assert.deepStrictEqual(fillFor(GUEST, parks)({ guestPass: true, mySigInfo: 'US-0001' }), { myState: 'MD', myCounty: 'MD,Frederick' });
});
check('LoTW: held back, not signed with the guest\'s home', () => {
  const { home, activations } = splitForLotw([{ CALL: 'W1AW', QSO_DATE: '20261120', STATION_CALLSIGN: 'W7RTA', APP_POTACAT_GUEST_PASS: '1' }], { myCallsign: 'W7RTA' });
  assert.strictEqual(home.length, 0);
  assert.strictEqual(activations.length, 1);
  assert.ok(/Guest Pass/.test(activations[0].skip), activations[0].skip);
});

console.log('Everything else is as it was');
check('the operator\'s own contacts fill from home as before', () => {
  assert.strictEqual(SC.ownStationFillApplies({ callsign: 'W1AW' }), true);
  assert.strictEqual(SC.ownStationFillApplies({ callsign: 'W1AW', guestPass: false, myGridsquare: 'FM18' }), true);
  assert.deepStrictEqual(fillFor(GUEST)({ callsign: 'W1AW' }), { myState: 'VA', myCounty: 'VA,Fairfax' });
  assert.deepStrictEqual(fillFor(GUEST)({ callsign: 'W1AW', myGridsquare: 'EM73' }), {}, 'portable: nothing, as before');
});
check('the operator\'s own LoTW home batch is unchanged', () => {
  const { home, activations } = splitForLotw([{ CALL: 'W1AW', MY_STATE: 'VA', MY_CNTY: 'VA,Fairfax', APP_POTACAT_GUEST_PASS: '' }], { myCallsign: 'K3SBP' });
  assert.strictEqual(home.length, 1);
  assert.strictEqual(activations.length, 0);
});

console.log('Wiring');
const main = readSrc(path.join(ROOT, 'main.js'));
check('the station stamps before the record goes to the guest\'s logbook and device', () => {
  const start = main.indexOf('function passGuestLogContact(');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  const stamp = body.indexOf('StationCounty.guestPassStationFor(qsoData, { grid: settings.grid, fill: (r) => stationLocationFillFor(r, settings) })');
  assert.ok(stamp > 0, 'stamped with the station\'s own fill');
  assert.ok(stamp < body.indexOf('buildAdifFields(qsoData)'), 'before the cloud logbook record');
  assert.ok(stamp < body.indexOf("type: 'qso-attributed'"), 'before the device copy');
  assert.ok(stamp < body.indexOf('qsoData.guestPass = true'), 'before the mark, so the station\'s own fill runs');
  assert.ok(!/myRig/.test(body), 'MY_RIG untouched here');
});
check('the guest\'s fill (save and LoTW) skips a Guest Pass record', () => {
  const fn = main.slice(main.indexOf('function stationLocationFillFor('), main.indexOf('function stationLocationFillFor(') + 300);
  assert.ok(/if \(!StationCounty\.ownStationFillApplies\(rec\)\) return \{\};/.test(fn));
  assert.ok(/guestPass: q\.APP_POTACAT_GUEST_PASS,/.test(main), 'the LoTW fill knows the mark');
  const recv = main.slice(main.indexOf("remoteClient.on('qso-attributed'"), main.indexOf("remoteClient.on('qso-attributed'") + 500);
  assert.ok(/saveQsoRecord\(enriched, \{ origin: 'forwarded-from-host' \}\)/.test(recv), 'the forwarded record is saved as sent (guestPass kept)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
