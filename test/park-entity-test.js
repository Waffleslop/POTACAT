#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// #662: two operators in one Cayman Islands park showed different entities:
// ZF2 as Cayman Islands (DX), the other, signing his US call with no prefix,
// as United States. A POTA spot and a POTA contact take the park's entity.
// Run: node test/park-entity-test.js
const assert = require('assert');
const path = require('path');
const PE = require('../lib/park-entity');
const { expandContact } = require('../lib/qso-expand');
const { dxccCodeForEntity } = require('../lib/dxcc-codes');
const { loadCtyDat, resolveCallsign } = require('../lib/cty');
const DxRule = require('../lib/dx-rule');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const cty = loadCtyDat(path.join(__dirname, '..', 'assets', 'cty.dat'));
const callEntity = (c) => (resolveCallsign(c, cty) || {}).name || '';

console.log('Park entity (#662)');

test('every entity in the data is a cty.dat entity with a DXCC code', () => {
  const names = new Set(cty.entities.map((e) => e.name));
  const all = [...Object.values(PE.DATA.programs), ...Object.values(PE.DATA.locations)];
  assert.ok(all.length > 1000, 'the data is loaded');
  for (const n of new Set(all)) {
    assert.ok(names.has(n), `${n} is not a cty.dat entity`);
    assert.ok(dxccCodeForEntity(n) != null, `${n} has no DXCC code`);
  }
});

test('Cayman Islands park: from its location, or from its reference alone', () => {
  assert.strictEqual(PE.potaParkEntity('KY-0001', 'KY-GT'), 'Cayman Islands');
  assert.strictEqual(PE.potaParkEntity('KY-0001', ''), 'Cayman Islands');
});

test('a program of several entities goes by the location; the reference alone is not enough', () => {
  assert.strictEqual(PE.potaParkEntity('US-1234', 'US-AK'), 'Alaska');
  assert.strictEqual(PE.potaParkEntity('US-1234', 'US-HI'), 'Hawaii');
  assert.strictEqual(PE.potaParkEntity('US-0001', 'US-ME'), 'United States');
  assert.strictEqual(PE.potaParkEntity('GB-0001', 'GB-ENG'), 'England');
  assert.strictEqual(PE.potaParkEntity('GB-1234', 'GB-SCT'), 'Scotland');
  assert.strictEqual(PE.potaParkEntity('US-1234', ''), '', 'US could be Alaska or Hawaii');
  assert.strictEqual(PE.potaParkEntity('GB-1234', ''), '');
});

test('a park across locations: one entity when they agree, unknown when not', () => {
  assert.strictEqual(PE.potaParkEntity('US-0002', 'US-WI,US-MI'), 'United States');
  assert.strictEqual(PE.potaParkEntity('US-9999', 'US-WA,US-AK'), '');
  assert.strictEqual(PE.potaParkEntity('XX-0001', 'XX-YY'), '', 'unknown location');
});

test('the override: only when the park is in another DXCC entity than the call', () => {
  const o = (call, park) => PE.parkEntityOverride(call, park, dxccCodeForEntity);
  assert.strictEqual(o('United States', 'Cayman Islands'), 'Cayman Islands');
  assert.strictEqual(o('Cayman Islands', 'Cayman Islands'), '');
  assert.strictEqual(o('United States', ''), '', 'unknown park keeps the call');
  assert.strictEqual(o('Sicily', 'Italy'), '', 'WAE name kept: Sicily is DXCC Italy');
  assert.strictEqual(o('Shetland Islands', 'Scotland'), '');
  assert.strictEqual(o('United States', 'Alaska'), 'Alaska');
  assert.strictEqual(o('', 'Cayman Islands'), 'Cayman Islands');
});

test('the two Cayman activators now show the same entity, and both are DX to a US hunter', () => {
  const spots = [{ call: 'ZF2AB', ref: 'KY-0001', loc: 'KY-GT' }, { call: 'W1AW', ref: 'KY-0001', loc: 'KY-GT' }];
  const shown = spots.map((s) => PE.parkEntityOverride(callEntity(s.call), PE.potaParkEntity(s.ref, s.loc), dxccCodeForEntity) || callEntity(s.call));
  assert.deepStrictEqual(shown, ['Cayman Islands', 'Cayman Islands']);
  for (const theirEntity of shown) assert.strictEqual(DxRule.isDx({ myEntity: 'United States', theirEntity, freqKhz: 14285 }), true);
});

test('logging: a home call hunted in a Cayman park is logged as Cayman Islands', () => {
  const ky = { name: 'Cayman Islands', dxcc: 69, cont: 'NA', cqz: 8, ituz: 11 };
  const ctx = {
    callInfo: () => ({ name: 'Hiram', country: 'United States', state: 'CT', grid: 'FN31' }),
    entityFor: () => ({ name: 'United States', cont: 'NA', cqz: '5', ituz: '8', dxcc: 291 }),
    parkInfo: (r) => (r === 'KY-0001' ? { states: [], grid: 'EK99ig', entity: ky } : null),
    now: Date.UTC(2026, 10, 16, 15, 0),
  };
  const r = expandContact({ callsign: 'W1AW', sig: 'POTA', sigInfo: 'KY-0001', frequency: '14285', mode: 'SSB', band: '20m' }, ctx);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].country, 'Cayman Islands');
  assert.strictEqual(r[0].dxcc, '69');
  assert.strictEqual(r[0].cqz, '8');
  assert.strictEqual(r[0].ituz, '11');
  assert.strictEqual(r[0].gridsquare, 'EK99ig');
  assert.strictEqual(r[0].state, '', 'not his home state');
  // Not at a park: the call's entity, as before.
  const home = expandContact({ callsign: 'W1AW', frequency: '14285', mode: 'SSB', band: '20m' }, ctx);
  assert.strictEqual(home[0].country, 'United States');
  assert.strictEqual(home[0].dxcc, '291');
  // A country the operator gave stands.
  const typed = expandContact({ callsign: 'W1AW', sig: 'POTA', sigInfo: 'KY-0001', country: 'United States', frequency: '14285', mode: 'SSB', band: '20m' }, ctx);
  assert.strictEqual(typed[0].country, 'United States');
  // A park in the call's own entity changes nothing.
  const same = expandContact({ callsign: 'W1AW', sig: 'POTA', sigInfo: 'KY-0001', frequency: '14285', mode: 'SSB', band: '20m' },
    { ...ctx, parkInfo: () => ({ states: ['CT'], grid: 'FN31', entity: { name: 'United States', dxcc: 291, cont: 'NA', cqz: 5, ituz: 8 } }) });
  assert.strictEqual(same[0].country, 'United States');
  assert.strictEqual(same[0].cqz, '5');
  // Only POTA: a WWFF reference keeps the call's entity.
  const wwff = expandContact({ callsign: 'W1AW', sig: 'WWFF', sigInfo: 'KY-0001', frequency: '14285', mode: 'SSB', band: '20m' }, ctx);
  assert.strictEqual(wwff[0].country, 'United States');
});

test('main.js: POTA spots, the DX flag, zones and logging use the park entity', () => {
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/parkEntity = ParkEntity\.parkEntityOverride\(/.test(src), 'processPotaSpots sets parkEntity');
  assert.ok(/const theirEntity = sp\.parkEntity \|\| dxEntityOf\(sp\.callsign\)/.test(src), 'stampSpotDx uses it');
  assert.ok(/stampParkEntityZones\(merged\)/.test(src), 'zones follow it');
  assert.ok(/if \(s\.parkEntity && !survivor\.parkEntity\) survivor\.parkEntity = s\.parkEntity/.test(src), 'a deduped survivor keeps it');
  assert.ok(/ParkEntity\.potaParkEntity\(ref, p && p\.locationDesc\)/.test(src), 'logContact gives qso-expand the park entity');
});

console.log(`\nPark entity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
