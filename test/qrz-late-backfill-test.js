#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Review of the merged 1.13.11 chain (MEDIUM, logging): past QRZ's 2.5 s cap a
// contact was saved with no name, state, grid or county and the late answer
// only warmed the cache: a permanent hole where a name and grid used to be.
// Now the late answer fills the fields those records left EMPTY, through the
// log module (mutateLog), never over a value the operator typed.
// Runs main's own qrzBackfillLate with the real expansion, ADIF builder and log.
// Run: node test/qrz-late-backfill-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const QsoExpand = require('../lib/qso-expand');
const QsoLog = require('../lib/qso-log');
const { buildAdifFields } = require('../lib/adif-writer');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js'));

function setup(entryExtra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrzlate-'));
  const log = path.join(dir, 'log.adi');
  fs.writeFileSync(log, '');
  const entry = Object.assign({ callsign: 'K1ABC', frequency: '14074', band: '20m', mode: 'FT8', qsoDate: '20261106', timeOn: '120000', rstSent: '-10', rstRcvd: '-12' }, entryExtra || {});
  const opts = (info) => ({ myRefs: [], callInfo: () => info, entityFor: () => null, parkInfo: () => null });
  const written = QsoExpand.expandContact(entry, opts(null));
  for (const q of written) { q.uuid = require('crypto').randomUUID(); q.bookOf = 'K3SBP'; }
  QsoLog.appendRecords(log, written.map((q) => buildAdifFields(q)), { existing: [] });
  const logs = [];
  const ctx = {
    buildAdifFields, logs, qsoPopoutWin: null, Object, String, Set, Map,
    sendCatLog: (l) => logs.push(l),
    mutateQsoLog: (fn) => QsoLog.mutateLog(log, fn),
  };
  vm.createContext(ctx);
  vm.runInContext(main.slice(main.indexOf('function qrzBackfillLate('), main.indexOf('async function saveQsoRecord(')) + '\nthis.fill = qrzBackfillLate;', ctx);
  return { ctx, log, entry, opts, written };
}
const info = { name: 'Ann Smith', country: 'United States', state: 'CT', county: 'Hartford', grid: 'FN31pr', qth: 'Newington', cqz: '5', ituz: '8' };

test('the late answer fills the name, state and grid the saved record left empty', () => {
  const { ctx, log, entry, opts, written } = setup();
  assert.ok(!QsoLog.readLog(log)[0].NAME, 'saved without QRZ');
  const n = ctx.fill('K1ABC', QsoExpand.expandContact(entry, opts(info)), written, 'K3SBP');
  assert.strictEqual(n, 1);
  const rec = QsoLog.readLog(log)[0];
  assert.strictEqual(rec.NAME, 'Ann Smith');
  assert.strictEqual(rec.GRIDSQUARE, 'FN31pr');
  assert.strictEqual(rec.STATE, 'CT');
  assert.ok(ctx.logs.some((l) => /\[QRZ\] K1ABC answered late: added .*NAME/.test(l)));
});

test('a value the operator typed is never overwritten', () => {
  const { ctx, log, entry, opts, written } = setup({ state: 'NY', name: 'Typed Name' });
  ctx.fill('K1ABC', QsoExpand.expandContact(entry, opts(info)), written, 'K3SBP');
  const rec = QsoLog.readLog(log)[0];
  assert.strictEqual(rec.STATE, 'NY');
  assert.strictEqual(rec.NAME, 'Typed Name');
  assert.strictEqual(rec.GRIDSQUARE, 'FN31pr', 'the empty grid is still filled');
});

test('a record logged into another operator\'s book is left alone', () => {
  const { ctx, log, entry, opts, written } = setup();
  for (const q of written) q.bookOf = 'W9XYZ';
  assert.strictEqual(ctx.fill('K1ABC', QsoExpand.expandContact(entry, opts(info)), written, 'K3SBP'), 0);
  assert.ok(!QsoLog.readLog(log)[0].NAME);
});

test('logContact keeps the timed-out lookup and runs the backfill when it answers', () => {
  const lc = main.slice(main.indexOf('async function logContact(entry, opts) {'), main.indexOf('function qrzBackfillLate('));
  assert.ok(/late\.set\(c, lookup\);/.test(lc));
  assert.ok(/lookup\.then\(\(info\) => \{\s*if \(!info\) return;\s*infos\.set\(c, info\);\s*qrzBackfillLate\(c, QsoExpand\.expandContact\(e, expandOpts\(true\)\), written, activeCall\);/.test(lc));
});

console.log(`\nA late QRZ answer fills the saved record: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
