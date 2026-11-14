'use strict';
// #509: a QSO logged as a hunter before Start Activation, then given its park
// in the Logbook's My Park cell, must land in Past Activations. The cell used
// to write MY_SIG_INFO only; Past groups by MY_SIG + MY_SIG_INFO + date.
//
// Run: node test/qso-edit-test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { applyQsoEdit, myParkEditFields, activationSigOf } = require('../lib/qso-edit');

const hunterQso = () => ({ CALL: 'K1ABC', QSO_DATE: '20261114', TIME_ON: '141500', SIG: 'POTA', SIG_INFO: 'US-0001' });

test('My Park on a hunter QSO sets MY_SIG and the writer mirror', () => {
  const rec = hunterQso();
  const r = applyQsoEdit(rec, { MY_SIG_INFO: 'us-1234 ' });
  assert.equal(rec.MY_SIG_INFO, 'US-1234');
  assert.equal(rec.MY_SIG, 'POTA');
  assert.equal(rec.MY_POTA_REF, 'US-1234');
  assert.equal(rec.SIG_INFO, 'US-0001', 'their park is untouched');
  assert.deepEqual(r.fields, { MY_SIG_INFO: 'US-1234', MY_SIG: 'POTA', MY_POTA_REF: 'US-1234' });
  assert.equal(activationSigOf(rec), 'POTA');
});

test('program follows the ref shape: SOTA, WWFF, WWBOTA', () => {
  assert.equal(myParkEditFields({}, 'W4C/CM-001').fields.MY_SIG, 'SOTA');
  assert.equal(myParkEditFields({}, 'W4C/CM-001').fields.MY_SOTA_REF, 'W4C/CM-001');
  assert.equal(myParkEditFields({}, 'KFF-1234').fields.MY_SIG, 'WWFF');
  assert.equal(myParkEditFields({}, 'B/US-1234').fields.MY_SIG, 'WWBOTA');
});

test('an LLOTA record keeps LLOTA when the ref is corrected (same shape)', () => {
  const rec = { MY_SIG: 'LLOTA', MY_SIG_INFO: 'US-0010', MY_LLOTA_REF: 'US-0010' };
  applyQsoEdit(rec, { MY_SIG_INFO: 'US-0011' });
  assert.equal(rec.MY_SIG, 'LLOTA');
  assert.equal(rec.MY_LLOTA_REF, 'US-0011');
  assert.equal(rec.MY_POTA_REF, undefined);
});

test('moving a POTA record to a summit drops the stale POTA mirror', () => {
  const rec = { MY_SIG: 'POTA', MY_SIG_INFO: 'US-1234', MY_POTA_REF: 'US-1234' };
  applyQsoEdit(rec, { MY_SIG_INFO: 'W4C/CM-001' });
  assert.equal(rec.MY_SIG, 'SOTA');
  assert.equal(rec.MY_SOTA_REF, 'W4C/CM-001');
  assert.equal('MY_POTA_REF' in rec, false);
});

test('clearing My Park clears MY_SIG and the mirror; a non-park MY_SIG stays', () => {
  const rec = { MY_SIG: 'POTA', MY_SIG_INFO: 'US-1234', MY_POTA_REF: 'US-1234' };
  const r = applyQsoEdit(rec, { MY_SIG_INFO: '' });
  assert.equal('MY_SIG' in rec || 'MY_SIG_INFO' in rec || 'MY_POTA_REF' in rec, false);
  assert.deepEqual(r.fields, { MY_SIG_INFO: '', MY_SIG: '', MY_POTA_REF: '' });
  const other = { MY_SIG: 'IOTA', MY_SIG_INFO: 'EU-005' };
  applyQsoEdit(other, { MY_SIG_INFO: '' });
  assert.equal(other.MY_SIG, 'IOTA');
});

test('a list of parks is refused and the record is untouched', () => {
  const rec = hunterQso();
  const r = applyQsoEdit(rec, { MY_SIG_INFO: 'US-1234, US-5678' });
  assert.match(r.error, /one reference/);
  assert.deepEqual(rec, hunterQso());
});

test('other cells are plain field writes', () => {
  const rec = hunterQso();
  assert.deepEqual(applyQsoEdit(rec, { RST_SENT: '57' }).fields, { RST_SENT: '57' });
  assert.equal(rec.MY_SIG, undefined);
});

test('Past files a ref-shaped MY_SIG_INFO without MY_SIG under its program, nothing else', () => {
  assert.equal(activationSigOf({ MY_SIG_INFO: 'US-1234' }), 'POTA');
  assert.equal(activationSigOf({ MY_SIG_INFO: 'W4C/CM-001' }), 'SOTA');
  assert.equal(activationSigOf({ MY_SIG: 'wwff', MY_SIG_INFO: 'KFF-1234' }), 'WWFF');
  assert.equal(activationSigOf({ MY_SIG_INFO: 'home' }), '');
  assert.equal(activationSigOf({ MY_SIG: 'POTA' }), '');
  assert.equal(activationSigOf(hunterQso()), '');
});

test('main.js: both update-qso paths and Past Activations use lib/qso-edit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const ipc = src.slice(src.indexOf("ipcMain.handle('update-qso'"), src.indexOf("ipcMain.handle('expand-qso-multipark'"));
  assert.match(ipc, /applyQsoEdit\(qsos\[idx\], edit\)/);
  assert.doesNotMatch(ipc, /Object\.assign\(qsos\[idx\]/);
  const remote = src.slice(src.indexOf("remoteServer.on('update-qso'"), src.indexOf("remoteServer.on('delete-qso'"));
  assert.match(remote, /applyQsoEdit\(qsos\[idx\], edit\)/);
  assert.doesNotMatch(remote, /Object\.assign\(qsos\[idx\]/);
  const past = src.slice(src.indexOf('function getPastActivations()'), src.indexOf("ipcMain.handle('get-past-activations'"));
  assert.match(past, /activationSigOf\(q\)/);
});
