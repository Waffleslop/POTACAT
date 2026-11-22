// test/dxcc-entity-prefix-test.js — #522: Alaska and American Samoa logged as
// United States, DX logged as USA, 6W/IK2HKT logged as Italy or as IK2HKT.
// The entity is cty.dat's, slash-aware, exact calls first; QRZ's country
// never overrides it, and the logged CALL is kept exactly as worked.
'use strict';
const assert = require('assert');
const path = require('path');
const { loadCtyDat, resolveCallsign, resolveOperatingCall } = require('../lib/cty');
const { expandContact } = require('../lib/qso-expand');
const { dxccCodeForEntity } = require('../lib/dxcc-codes');
const db = loadCtyDat(path.join(__dirname, '..', 'assets', 'cty.dat'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const op = (c) => ((resolveOperatingCall(c, db) || {}).entity || {}).name;
// What main.js's logContact hands expandContact (entityFor), minus zones.
const entityFor = (c) => {
  const o = resolveOperatingCall(c, db);
  return o && o.entity
    ? { name: o.entity.name, away: o.away, cont: o.entity.continent, dxcc: dxccCodeForEntity(o.entity.name) || '' }
    : null;
};
const base = { mode: 'SSB', frequency: '14250', band: '20m', qsoDate: '20261114', timeOn: '1200' };
const log = (call, qrz) => expandContact({ ...base, callsign: call }, { entityFor, callInfo: () => qrz || null })[0];

console.log('DXCC entity (#522):');
t('KL7XX is Alaska, KH8XX American Samoa', () => {
  assert.strictEqual(op('KL7XX'), 'Alaska');
  assert.strictEqual(op('KH8XX'), 'American Samoa');
  for (const c of ['AL7QZQ', 'NL7QZQ', 'WL7QZQ']) assert.strictEqual(op(c), 'Alaska', c);
  for (const c of ['AH8QZQ', 'NH8QZQ', 'WH8QZQ']) assert.strictEqual(op(c), 'American Samoa', c);
});
t('a prefix before the slash decides: 6W/IK2HKT is Senegal', () => {
  assert.strictEqual(op('6W/IK2HKT'), 'Senegal');
  assert.strictEqual(resolveOperatingCall('6W/IK2HKT', db).away, true);
  assert.strictEqual(op('6W/IK2HKT/P'), 'Senegal');
});
t('operating suffixes do not: IK2HKT/P, /M, /QRP, /MM, /AM are Italy', () => {
  for (const s of ['P', 'M', 'QRP', 'MM', 'AM']) assert.strictEqual(op('IK2HKT/' + s), 'Italy', s);
  assert.strictEqual(op('KL7XX/P'), 'Alaska');
});
t('a call-area digit changes the area, not the entity', () => {
  assert.strictEqual(op('W1AW/7'), 'United States');
  assert.strictEqual(op('KL7XX/7'), 'Alaska');
  assert.strictEqual(op('KH6XX/1'), 'Hawaii', 'never Baker Howland (KH1)');
  assert.strictEqual(op('JA1ABC/0'), 'Japan');
  assert.strictEqual(op('VE3ABC/2'), 'Canada');
});
t('except where cty.dat gives the area its own entity', () => {
  assert.strictEqual(op('UA3ABC/9'), 'Asiatic Russia');
  assert.strictEqual(op('UA9ABC/3'), 'European Russia');
});
t('exact calls in cty.dat win over prefixes', () => {
  // =AL7AB is listed under United States, =KG7ITH under American Samoa.
  assert.strictEqual(resolveCallsign('AL7AB', db).name, 'United States');
  assert.strictEqual(op('AL7AB'), 'United States');
  assert.strictEqual(op('AL7AB/P'), 'United States');
  assert.strictEqual(op('KG7ITH'), 'American Samoa');
});
t('KG4 cases unchanged (#342)', () => {
  for (const c of ['KG4OLE', 'KG4ABC', 'KG4A', 'KG4OLE/P', 'KG4OLE/4', 'W1/KG4AB']) assert.strictEqual(op(c), 'United States', c);
  assert.strictEqual(op('KG4AB'), 'Guantanamo Bay');
  assert.strictEqual(op('KG4AB/P'), 'Guantanamo Bay');
});
t('the log record keeps CALL whole and takes the entity from the call', () => {
  const r = log('6W/IK2HKT', { name: 'Mario', country: 'Italy', grid: 'JN45' });
  assert.strictEqual(r.callsign, '6W/IK2HKT');
  assert.strictEqual(r.country, 'Senegal');
  assert.strictEqual(r.cont, 'AF');
  assert.strictEqual(log('IK2HKT/P').callsign, 'IK2HKT/P');
  assert.strictEqual(log('IK2HKT/P').country, 'Italy');
  assert.strictEqual(log('W1AW/7').country, 'United States');
});
t('a QRZ country (mailing address) never overrides the cty.dat entity', () => {
  const usMail = { name: 'Op', country: 'United States', state: 'AK', grid: 'BP51' };
  assert.strictEqual(log('KL7XX', usMail).country, 'Alaska');
  assert.strictEqual(log('KH8XX', { ...usMail, state: 'AS' }).country, 'American Samoa');
  assert.strictEqual(log('IK2HKT', usMail).country, 'Italy', 'a DX call with a US mailing address');
  assert.strictEqual(log('6W/IK2HKT', usMail).country, 'Senegal');
  // The rest of QRZ's record still fills a home call.
  const kl7 = log('KL7XX', usMail);
  assert.deepStrictEqual([kl7.name, kl7.state, kl7.gridsquare], ['Op', 'AK', 'BP51']);
});
t('the DXCC number follows the same entity: KL7 6, KH8 9, 6W/IK2HKT 456 (#554)', () => {
  const usMail = { name: 'Op', country: 'United States', dxcc: '291' };
  assert.strictEqual(log('KL7XX', usMail).dxcc, '6');
  assert.strictEqual(log('KH8XX', usMail).dxcc, '9');
  const r = log('6W/IK2HKT', { name: 'Mario', country: 'Italy', dxcc: '248' });
  assert.deepStrictEqual([r.callsign, r.country, r.dxcc], ['6W/IK2HKT', 'Senegal', '456']);
  assert.strictEqual(log('IK2HKT/P').dxcc, '248');
  assert.strictEqual(log('W1AW/7').dxcc, '291');
});
t('QRZ names the country only where cty.dat cannot resolve the call', () => {
  const r = expandContact({ ...base, callsign: 'XX9ZZ' }, { entityFor: () => null, callInfo: () => ({ country: 'Somewhere' }) })[0];
  assert.strictEqual(r.country, 'Somewhere');
  // What the operator typed is still theirs.
  const typed = expandContact({ ...base, callsign: 'KL7XX', country: 'Alaska' }, { entityFor, callInfo: () => ({ country: 'United States' }) })[0];
  assert.strictEqual(typed.country, 'Alaska');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
