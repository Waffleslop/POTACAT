#!/usr/bin/env node
'use strict';
/**
 * #909: on a Guest Pass to another station, a contact logged from the guest
 * desktop's OWN log forms is saved on the guest's PC. It carried the guest's
 * home MY_STATE and MY_CNTY. The station now sends its location
 * (settings.stationLocation, auth-ok and settings-update), and the guest's
 * save stamps it with the same rule the station uses for the contacts it logs
 * for a guest (#822, StationCounty.guestPassStationFor), plus the Guest Pass
 * mark. Off a pass, or with a station that sends nothing, nothing changes.
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const SC = require('../lib/station-county');
const SG = require('../lib/shack-grid');
const { buildAdifFields } = require('../lib/adif-writer');
const { splitForLotw } = require('../lib/lotw-split');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const HOST = { state: 'PA', county: 'Bucks', grid: 'FN20jc' };
const GUEST = { state: 'VA', county: 'Fairfax', grid: 'FM18lv' };
const GUEST_PARKS = { 'US-0001': { state: 'MD', county: 'Frederick' } };

// main.js stationLocationFillFor, minus the park DB (as in guest-pass-station-location-test.js).
function fillFor(home, parks = {}) {
  return (rec) => {
    if (!rec || !SC.ownStationFillApplies(rec)) return {};
    return SC.stationLocationFor(rec, { home, parkCounty: (r) => parks[r] || null });
  };
}
const hostFill = fillFor(HOST);
const guestFill = fillFor(GUEST, GUEST_PARKS);

// The station's side: what rides settings.stationLocation, through the wire.
const wire = () => JSON.parse(JSON.stringify({ grid: HOST.grid, stationLocation: SC.stationLocationForGuests(HOST.grid, hostFill) }));
// The guest's saveQsoRecord: the #909 stamp, then its own fill.
function guestSave(rec, shack) {
  const q = { ...rec };
  Object.assign(q, SC.guestDeskStationFor(q, { shack, fill: guestFill }));
  Object.assign(q, guestFill(q));
  return q;
}

console.log('The station sends where it is');
check('settings.stationLocation is the grid, state and county it stamps on a guest contact', () => {
  assert.deepStrictEqual(wire().stationLocation, { grid: 'FN20jc', state: 'PA', county: 'PA,Bucks' });
  const g = SC.guestPassStationFor({ callsign: 'W1AW' }, { grid: HOST.grid, fill: hostFill });
  assert.deepStrictEqual(SC.stationLocationForGuests(HOST.grid, hostFill), { grid: g.myGridsquare, state: g.myState, county: g.myCounty });
});
check('a station with no grid sends blanks, never a guess', () => {
  assert.deepStrictEqual(SC.stationLocationForGuests('', fillFor({})), { grid: '', state: '', county: '' });
});
check('the guest reads it from the settings blob; an older station sends none: null', () => {
  assert.deepStrictEqual(SG.shackLocationFrom(wire()), { grid: 'FN20JC', state: 'PA', county: 'PA,Bucks' });
  assert.strictEqual(SG.shackLocationFrom({ grid: 'FN20jc' }), null);
  assert.strictEqual(SG.shackLocationFrom(null), null);
  assert.strictEqual(SG.shackLocationFrom({ stationLocation: 'PA' }), null);
});

console.log('The guest\'s own log form, on a pass');
const shack = SG.shackLocationFrom(wire());
check('a contact from the main window\'s log form carries the station\'s grid, state and county, not the guest\'s home', () => {
  const saved = guestSave({ callsign: 'W1AW', frequency: '14250', mode: 'SSB' }, shack);
  assert.deepStrictEqual([saved.myGridsquare, saved.myState, saved.myCounty], ['FN20JC', 'PA', 'PA,Bucks']);
  assert.strictEqual(saved.guestPass, true);
  const f = buildAdifFields(saved);
  assert.strictEqual(f.MY_STATE, 'PA');
  assert.strictEqual(f.MY_CNTY, 'PA,Bucks');
  assert.strictEqual(f.APP_POTACAT_GUEST_PASS, '1');
});
check('a grid, state or county the form pre-filled from the guest\'s home is replaced', () => {
  const saved = guestSave({ callsign: 'W1AW', myGridsquare: GUEST.grid, myState: 'VA', myCounty: 'VA,Fairfax' }, shack);
  assert.deepStrictEqual([saved.myGridsquare, saved.myState, saved.myCounty], ['FN20JC', 'PA', 'PA,Bucks']);
});
check('LoTW: a Guest Pass batch signed from the record, never the guest\'s Station Location', () => {
  const saved = guestSave({ callsign: 'W1AW' }, shack);
  const f = buildAdifFields({ ...saved, qsoDate: '20261122', stationCallsign: 'W7RTA' });
  const { home, activations } = splitForLotw([{ ...f, CALL: 'W1AW', QSO_DATE: '20261122', STATION_CALLSIGN: 'W7RTA' }], { myCallsign: 'W7RTA' });
  assert.strictEqual(home.length, 0);
  assert.strictEqual(activations.length, 1);
  assert.ok(activations[0].guestPass && !activations[0].skip);
  assert.deepStrictEqual([activations[0].state, activations[0].county], ['PA', 'PA,Bucks']);
});
check('an activation takes the park\'s location from the park list, never the guest\'s home', () => {
  const saved = guestSave({ callsign: 'W1AW', mySigInfo: 'US-0001' }, shack);
  assert.deepStrictEqual([saved.myGridsquare, saved.myState, saved.myCounty], ['', 'MD', 'MD,Frederick']);
});
check('a station with no grid set: nothing from the guest\'s home either', () => {
  const saved = guestSave({ callsign: 'W1AW' }, { grid: '', state: '', county: '' });
  assert.ok(!saved.myGridsquare && !saved.myState && !saved.myCounty);
  assert.strictEqual(saved.guestPass, true);
});
check('a record the station already marked (forwarded from the shack) is left as sent', () => {
  assert.deepStrictEqual(SC.guestDeskStationFor({ guestPass: true, myGridsquare: 'FN20jc', myState: 'PA' }, { shack, fill: guestFill }), {});
});

console.log('Everything else is as it was');
check('not on a pass (shack null): the guest\'s home fill as before, no mark', () => {
  const saved = guestSave({ callsign: 'W1AW' }, null);
  assert.deepStrictEqual([saved.myState, saved.myCounty, saved.guestPass], ['VA', 'VA,Fairfax', undefined]);
});
check('a station on an older POTACAT (no stationLocation): unchanged', () => {
  const saved = guestSave({ callsign: 'W1AW' }, SG.shackLocationFrom({ grid: 'FN20jc' }));
  assert.ok(!('guestPass' in saved));
  assert.strictEqual(saved.myState, 'VA');
});

console.log('Wiring');
const main = readSrc(path.join(ROOT, 'main.js'));
check('the station puts stationLocation in its settings blob with its own fill', () => {
  const i = main.indexOf('function updateRemoteSettings() {');
  const body = main.slice(i, i + 1200);
  assert.ok(body.includes('stationLocation: StationCounty.stationLocationForGuests(settings.grid, (r) => stationLocationFillFor(r, settings)),'));
});
check('the guest keeps it from auth-ok and settings-update, and forgets it on teardown', () => {
  const i = main.indexOf("remoteClient.on('connected', (info) => {");
  const block = main.slice(i, main.indexOf("remoteClient.on('disconnected'", i));
  assert.ok(block.includes('remoteShackLocation = ShackGrid.shackLocationFrom(info.settings);'));
  assert.ok(main.includes("if (msg.type === 'settings-update' && msg.settings && msg.settings.stationLocation) remoteShackLocation = ShackGrid.shackLocationFrom(msg.settings);"));
  const t = main.indexOf('function tearDownRemoteClient() {');
  assert.ok(main.slice(t, t + 800).includes('remoteShackLocation = null;'));
});
check('only on a Guest Pass target', () => {
  const i = main.indexOf('function guestPassShackLocation() {');
  assert.ok(i > 0);
  assert.ok(/t\.kind === 'pass' \? remoteShackLocation : null/.test(main.slice(i, i + 300)));
});
check('saveQsoRecord stamps before its own fill, never on a record forwarded from the shack', () => {
  const s = main.indexOf('async function saveQsoRecord(');
  const body = main.slice(s, main.indexOf('\n}\n', s));
  const stamp = body.indexOf('StationCounty.guestDeskStationFor(qsoData, { shack: guestPassShackLocation(), fill: (r) => stationLocationFillFor(r, ops) })');
  assert.ok(stamp > 0, 'stamped');
  assert.ok(stamp < body.indexOf('Object.assign(qsoData, stationLocationFillFor(qsoData, ops));'), 'before the guest\'s own fill');
  assert.ok(/if \(origin !== 'forwarded-from-host'\) \{\n\s+Object\.assign\(qsoData, StationCounty\.guestDeskStationFor/.test(body));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
