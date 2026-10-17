#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// Per-activation LoTW upload. Run: node test/lotw-split-test.js
//
// Activations are signed in TQSL's QTH update mode with no Station Location,
// so the home location's grid, state and county never reach a park contact
// (lib/lotw-split.js). Shapes below are K3SBP's log, 2026-10-17.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { splitForLotw, activationRef, needsState, buildActivationTqslArgs, batchAdif } = require('../lib/lotw-split');
const { parseRecord } = require('../lib/adif');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const PARKS = {
  'US-1352': { MY_GRIDSQUARE: 'FN20jc', MY_STATE: 'PA' },
  'US-2023': { MY_GRIDSQUARE: 'FN12rk', MY_STATE: 'NY' },
  'US-9999': { MY_GRIDSQUARE: 'EN52aa' }, // two-state park: no state
};
const fill = (q) => PARKS[q.MY_POTA_REF || q.MY_SIG_INFO] || {};

const homeQ = (call, extra = {}) => ({ CALL: call, QSO_DATE: '20260301', TIME_ON: '1200', STATION_CALLSIGN: 'K3SBP', ...extra });
const actQ = (call, ref, date, extra = {}) => ({ CALL: call, QSO_DATE: date, TIME_ON: '1400', STATION_CALLSIGN: 'K3SBP', MY_SIG: 'POTA', MY_SIG_INFO: ref, MY_POTA_REF: ref, ...extra });

check('home QSOs stay home, portable ones with no program too', () => {
  const s = splitForLotw([homeQ('W1AW'), homeQ('KG1A', { MY_GRIDSQUARE: 'FN12qm' })], { fill });
  assert.strictEqual(s.home.length, 2);
  assert.strictEqual(s.activations.length, 0);
});

check('one batch per park, grid and state', () => {
  const s = splitForLotw([
    actQ('K1A', 'US-2023', '20261010', { MY_GRIDSQUARE: 'FN12rk', MY_STATE: 'NY' }),
    actQ('K1B', 'US-2023', '20261015', { MY_GRIDSQUARE: 'FN12rk', MY_STATE: 'NY' }),
    actQ('K1C', 'US-1352', '20260301', { MY_GRIDSQUARE: 'FN20jc', MY_STATE: 'PA' }),
    homeQ('W1AW'),
  ], { fill });
  assert.strictEqual(s.home.length, 1);
  assert.strictEqual(s.activations.length, 2);
  const ny = s.activations.find((b) => b.ref === 'US-2023');
  assert.strictEqual(ny.records.length, 2);
  assert.strictEqual(ny.label, 'US-2023 FN12RK NY (2026-10-10 to 2026-10-15)');
  assert.strictEqual(ny.skip, null);
  assert.strictEqual(s.activations[0].ref, 'US-1352', 'sorted by date');
});

check('an activation logged in the home grid still goes on its own', () => {
  const s = splitForLotw([actQ('K1A', 'US-1352', '20260710', { MY_GRIDSQUARE: 'FN20jb' })], { fill });
  assert.strictEqual(s.home.length, 0);
  assert.strictEqual(s.activations[0].grid, 'FN20JB', 'the logged grid wins over the park list');
  assert.strictEqual(s.activations[0].state, 'PA', 'blank state filled from the park list');
});

check('blank grid and state are filled from the park list, on a copy', () => {
  const q = actQ('K1A', 'US-1352', '20260226');
  const s = splitForLotw([q], { fill });
  const b = s.activations[0];
  assert.strictEqual(b.grid, 'FN20JC');
  assert.strictEqual(b.state, 'PA');
  assert.strictEqual(b.filled, 1);
  assert.strictEqual(q.MY_GRIDSQUARE, undefined, 'the log record is not changed');
});

check('a US park with no state is held back, never uploaded with a guess', () => {
  const s = splitForLotw([actQ('K1A', 'US-9999', '20260709')], { fill });
  assert.match(s.activations[0].skip, /no state for US-9999/);
});

check('an unknown park with no grid is held back', () => {
  const s = splitForLotw([actQ('K1A', 'US-0001', '20260709')], { fill });
  assert.match(s.activations[0].skip, /no grid for US-0001/);
});

check('a non-US reference does not need a state', () => {
  const s = splitForLotw([actQ('K1A', 'G-0001', '20260709', { MY_POTA_REF: '', MY_GRIDSQUARE: 'IO91wm' })], { fill });
  assert.strictEqual(s.activations[0].skip, null);
  assert.ok(needsState('US-1352') && needsState('K-0001') && !needsState('KFF-0001') && !needsState('G-0001'));
});

check('reference precedence: POTA ref, then SIG_INFO, SOTA, WWFF', () => {
  assert.strictEqual(activationRef({ MY_SOTA_REF: 'W3/PD-001' }), 'W3/PD-001');
  assert.strictEqual(activationRef({ MY_POTA_REF: 'US-1352', MY_WWFF_REF: 'KFF-1352' }), 'US-1352');
  assert.strictEqual(activationRef({ MY_SIG: 'POTA' }), '');
});

check('station callsign falls back to OPERATOR, then the setting', () => {
  const s = splitForLotw([actQ('K1A', 'US-1352', '20260301', { STATION_CALLSIGN: '', OPERATOR: '' })], { fill, myCallsign: 'k3sbp' });
  assert.strictEqual(s.activations[0].call, 'K3SBP');
});

check('activation TQSL args: empty location, the cert call, QTH update mode', () => {
  const args = buildActivationTqslArgs({ call: 'K3SBP', adifPath: 'x.adi', password: 'pw' });
  assert.deepStrictEqual(args, ['-q', '-x', '-d', '-u', '-a', 'compliant', '-l', '', '-c', 'K3SBP', '-f', 'update', '-p', 'pw', 'x.adi']);
});

check('batch ADIF round-trips the filled fields', () => {
  const s = splitForLotw([actQ('K1A', 'US-1352', '20260226')], { fill });
  const text = batchAdif(s.activations[0].records);
  const body = text.slice(text.toUpperCase().indexOf('<EOH>') + 5).split(/<eor>/i).filter((r) => r.trim());
  assert.strictEqual(body.length, 1);
  const rec = parseRecord(body[0]);
  assert.strictEqual(rec.MY_GRIDSQUARE, 'FN20jc');
  assert.strictEqual(rec.MY_STATE, 'PA');
  assert.strictEqual(rec.CALL, 'K1A');
});

check('main signs each activation with its own args and never the home location', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const h = main.slice(main.indexOf("ipcMain.handle('lotw-upload'"), main.indexOf('function runLotwBatch('));
  assert.ok(h.includes('splitForLotw(allQsos'), 'handler splits the log');
  assert.ok(h.includes('buildActivationTqslArgs({ call: b.call'), 'activations use the update-mode args');
  assert.ok(/if \(b\.skip\) continue;/.test(h), 'held-back batches are not run');
  assert.ok(!main.includes("fs.copyFileSync(logPath, snap)"), 'no whole-log snapshot upload left');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
