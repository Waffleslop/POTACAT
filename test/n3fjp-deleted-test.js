#!/usr/bin/env node
'use strict';
// The daily N3FJP re-read re-imported contacts the operator had deleted in
// POTACAT (review of the 1.13.11 chain). A delete of an N3FJP-imported contact
// is now remembered (lib/n3fjp-deleted.js, from the log sink every delete
// passes through) and the pull leaves those contacts out. An empty reply no
// longer counts as the day's re-read.
// Run: node test/n3fjp-deleted-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QsoLog = require('../lib/qso-log');
const D = require('../lib/n3fjp-deleted');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const n3 = (call, extra) => Object.assign({ CALL: call, QSO_DATE: '20261025', TIME_ON: '120000', BAND: '20m', MODE: 'FT8', APP_POTACAT_IMPORTED_FROM: 'N3FJP' }, extra || {});

test('a deleted N3FJP import is remembered from a real log delete, and the next pull leaves it out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n3del-'));
  const log = path.join(dir, 'log.adi');
  fs.writeFileSync(log, '');
  QsoLog.appendRecords(log, [n3('K1AAA'), n3('K1BBB'), Object.assign(n3('K1CCC'), { APP_POTACAT_IMPORTED_FROM: '' })]);
  let list = [];
  QsoLog.mutateLog(log, (qsos) => qsos.filter((q) => q.CALL === 'K1BBB'), {
    sink: (changes) => { const next = D.noteDeleted(list, changes); if (next) list = next; },
  });
  assert.deepStrictEqual(list, ['K1AAA|20261025|1200|20m'], 'only the N3FJP import, not the operator\'s own contact');
  const pulled = [n3('K1AAA', { TIME_ON: '1200' }), n3('K1BBB'), n3('K1DDD')];
  const { records, left } = D.withoutDeleted(pulled, list);
  assert.deepStrictEqual(records.map((r) => r.CALL), ['K1BBB', 'K1DDD']);
  assert.strictEqual(left, 1);
});

test('the list is bounded, and a change with no N3FJP delete changes nothing', () => {
  assert.strictEqual(D.noteDeleted([], [{ action: 'update', fields: n3('K1AAA') }]), null);
  const many = Array.from({ length: D.MAX_KEYS }, (_, i) => `K${i}|20260101|0000|20m`);
  const next = D.noteDeleted(many, [{ action: 'delete', fields: n3('K9ZZZ') }]);
  assert.strictEqual(next.length, D.MAX_KEYS);
  assert.strictEqual(next[next.length - 1], 'K9ZZZ|20261025|1200|20m');
});

test('main records deletes from the log sink and filters the pull; an empty reply is not the day\'s re-read', () => {
  const sink = main.slice(main.indexOf('function qsoLogSink(changes) {'), main.indexOf('function qsoLogSink(changes) {') + 600);
  assert.ok(/N3fjpDeleted\.noteDeleted\(settings\.n3fjpDeletedKeys, changes\)/.test(sink));
  const pull = main.slice(main.indexOf('async function n3fjpPull('), main.indexOf('async function n3fjpPull(') + 4000);
  assert.ok(/N3fjpDeleted\.withoutDeleted\(records, settings\.n3fjpDeletedKeys\)/.test(pull));
  assert.ok(/importQsoRecords\(wanted\)/.test(pull));
  assert.ok(/if \(\(full \|\| daily\) && records\.length\) \{ settings\.n3fjpPullConfirmAt = Date\.now\(\);/.test(pull));
  assert.ok(!/if \(full \|\| daily\) \{ settings\.n3fjpPullConfirmAt/.test(pull));
});

console.log(`\nN3FJP deleted contacts stay deleted: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
