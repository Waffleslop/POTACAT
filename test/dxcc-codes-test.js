'use strict';
// lib/dxcc-codes.js + the logging path: every logged contact carries the ADIF
// DXCC entity number when its entity is known (#554). N3FJP and other loggers
// key on DXCC, so COUNTRY alone left the entity blank there.
// Run: node test/dxcc-codes-test.js
const assert = require('assert');
const path = require('path');
const { loadCtyDat, resolveOperatingCall } = require('../lib/cty');
const { dxccCodeForEntity, adifEntity, CTY_ALIASES, WAE_PARENT, NOT_DXCC } = require('../lib/dxcc-codes');
const { expandContact } = require('../lib/qso-expand');
const { buildAdifFields, buildAdifRecord } = require('../lib/adif-writer');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const db = loadCtyDat(path.join(__dirname, '..', 'assets', 'cty.dat'));

// What main.js logContact hands expandContact as entityFor (cty.dat only).
function entityFor(call) {
  const op = resolveOperatingCall(call, db);
  if (!op || !op.entity) return null;
  return { name: op.entity.name, away: op.away, cont: op.entity.continent || '', dxcc: dxccCodeForEntity(op.entity.name) || '' };
}
const ctx = (over = {}) => ({ entityFor, now: Date.UTC(2026, 10, 14, 15, 0), ...over });
const logged = (entry, over) => expandContact({ frequency: '14285', mode: 'SSB', band: '20m', ...entry }, ctx(over));

// --- the table ---

test('every entity name cty.dat can produce maps to a current ADIF code, or is a deliberate null', () => {
  const bad = [];
  for (const e of db.entities) {
    const code = dxccCodeForEntity(e.name);
    if (code == null) { if (!NOT_DXCC.includes(e.name)) bad.push(`${e.name}: no code`); continue; }
    const a = adifEntity(code);
    if (!a) bad.push(`${e.name}: ${code} is not in the ADIF table`);
    else if (a.deleted) bad.push(`${e.name}: ${code} (${a.name}) is a deleted entity`);
  }
  assert.deepStrictEqual(bad, []);
});

test('every alias and WAE parent names a current ADIF entity and a name cty.dat has', () => {
  const names = new Set(db.entities.map((e) => e.name));
  for (const [n, code] of Object.entries({ ...CTY_ALIASES, ...WAE_PARENT })) {
    assert.ok(names.has(n), `${n} is not a cty.dat entity name (stale alias?)`);
    const a = adifEntity(code);
    assert.ok(a && !a.deleted, `${n} -> ${code} is not a current ADIF entity`);
  }
});

test('the names that differ between cty.dat and ADIF', () => {
  assert.strictEqual(dxccCodeForEntity('United States'), 291);
  assert.strictEqual(dxccCodeForEntity('UNITED STATES OF AMERICA'), 291);
  assert.strictEqual(dxccCodeForEntity('European Russia'), 54);
  assert.strictEqual(dxccCodeForEntity('Asiatic Russia'), 15);
  assert.strictEqual(dxccCodeForEntity('Hawaii'), 110);
  assert.strictEqual(dxccCodeForEntity('Alaska'), 6);
  assert.strictEqual(dxccCodeForEntity('Easter Island'), 47);
  assert.strictEqual(dxccCodeForEntity('Fed. Rep. of Germany'), 230);
  assert.strictEqual(dxccCodeForEntity('Sicily'), 248);
  assert.strictEqual(dxccCodeForEntity('Atlantis'), null);
  assert.strictEqual(dxccCodeForEntity(''), null);
});

// --- the logging path ---

test('a US call gets 291', () => {
  const r = logged({ callsign: 'K3SBP' });
  assert.strictEqual(r[0].country, 'United States');
  assert.strictEqual(r[0].dxcc, '291');
});

test('KH6 gets 110', () => {
  assert.strictEqual(logged({ callsign: 'KH6ABC' })[0].dxcc, '110');
});

test('European Russia gets 54', () => {
  const r = logged({ callsign: 'UA3ABC' });
  assert.strictEqual(r[0].country, 'European Russia');
  assert.strictEqual(r[0].dxcc, '54');
});

test('Asiatic Russia gets 15', () => {
  const r = logged({ callsign: 'UA9ABC' });
  assert.strictEqual(r[0].country, 'Asiatic Russia');
  assert.strictEqual(r[0].dxcc, '15');
});

test('an unknown prefix leaves DXCC empty, and the writer leaves it out', () => {
  const r = logged({ callsign: 'Q1ZZZ' });
  assert.strictEqual(r[0].dxcc, '');
  assert.ok(!('DXCC' in buildAdifFields(r[0])));
});

test('an existing DXCC is kept (import, QRZ fill or caller)', () => {
  assert.strictEqual(logged({ callsign: 'K3SBP', dxcc: '6' })[0].dxcc, '6');
  assert.strictEqual(logged({ callsign: 'K3SBP', dxcc: 291 })[0].dxcc, '291');
});

test('a caller DXCC belongs to callsign 1 only; the others get their own', () => {
  const r = logged({ callsign: 'K3SBP,UA9ABC', dxcc: '291' });
  assert.strictEqual(r[0].dxcc, '291');
  assert.strictEqual(r[1].dxcc, '15');
});

test('an away call takes the entity it operates from', () => {
  const r = logged({ callsign: 'W1AW/KH6' });
  assert.strictEqual(r[0].dxcc, '110');
});

test("QRZ's DXCC goes with QRZ's country; an away call never takes it", () => {
  const callInfo = (c) => (c.startsWith('KG4') ? { country: 'Guantanamo Bay', dxcc: '105' } : null);
  assert.strictEqual(logged({ callsign: 'KG4AB' }, { callInfo })[0].dxcc, '105');
  const away = (c) => ({ name: 'Al', country: 'United States', dxcc: '291' });
  assert.strictEqual(logged({ callsign: 'KH6/K3SBP' }, { callInfo: away })[0].dxcc, '110');
});

test('a hunter POTA contact carries DXCC on every record', () => {
  const r = logged({ callsign: 'K3SBP', sig: 'POTA', sigInfo: 'US-0001,US-0002' });
  assert.strictEqual(r.length, 2);
  for (const rec of r) assert.strictEqual(rec.dxcc, '291');
});

// --- the writer ---

test('the ADIF writer emits <DXCC:3>291', () => {
  const r = logged({ callsign: 'K3SBP' });
  assert.ok(buildAdifRecord(r[0]).includes('<DXCC:3>291'), buildAdifRecord(r[0]));
  assert.ok(buildAdifRecord({ callsign: 'K3SBP', dxcc: 291 }).includes('<DXCC:3>291'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
