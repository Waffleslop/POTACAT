#!/usr/bin/env node
'use strict';
// WAS / DXCC tables for ECHOCAT, built with the desktop views' own rules
// (Casey 2026-10-24, phone parity). Run: node test/award-tables-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AT = require('../lib/award-tables');
const WR = require('../lib/worked-roster');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const list = (src) => src.split(',').map((x) => x.trim().replace(/^'|'$/g, ''));

test('the constants are the desktop views\' own', () => {
  const app = R('renderer/app.js'), was = R('renderer/was-view.js');
  assert.deepStrictEqual(AT.DXCC_BANDS, list(app.match(/const DXCC_BANDS = \[(.*?)\]/)[1]), 'DXCC_BANDS');
  assert.deepStrictEqual(AT.DXCC_CHALLENGE_BANDS, list(app.match(/const DXCC_CHALLENGE_BANDS = \[(.*?)\]/)[1]), 'DXCC_CHALLENGE_BANDS');
  for (const g of ['phone', 'cw', 'digital']) {
    const m = app.match(new RegExp(`${g}:\\s*new Set\\(\\[(.*?)\\]\\)`));
    assert.deepStrictEqual(AT.DXCC_MODE_GROUPS[g], list(m[1]), 'DXCC_MODE_GROUPS.' + g);
  }
  const fn = was.slice(was.indexOf('function scopeFor(modeValue)'), was.indexOf('function render('));
  for (const v of ['all', 'phone', 'cw', 'digital', 'FT8']) {
    const desktop = new Function(fn + '; return scopeFor;')()(v);
    assert.deepStrictEqual(AT.wasScopeFor(v), desktop, 'scopeFor ' + v);
  }
});

test('WAS: worked vs confirmed counts, the award line, rows in state order', () => {
  const roster = WR.build([
    ['W1AW', [{ band: '20m', mode: 'SSB', state: 'CT', confirmed: true }]],
    ['K1ABC', [{ band: '40m', mode: 'FT8', state: 'MA' }]],
  ], () => 'United States');
  const all = AT.buildWasTable(roster, { mode: 'all' });
  assert.strictEqual(all.rows.length, WR.US_STATES.length);
  assert.deepStrictEqual(all.bands, WR.BANDS);
  const ct = all.rows.find((r) => r.code === 'CT'), ma = all.rows.find((r) => r.code === 'MA');
  assert.strictEqual(ct.cells['20m'], 'confirmed');
  assert.strictEqual(ma.cells['40m'], 'worked');
  assert.deepStrictEqual([all.summary.worked, all.summary.confirmed, all.summary.shown], [2, 1, 2]);
  const conf = AT.buildWasTable(roster, { mode: 'all', count: 'confirmed' });
  assert.strictEqual(conf.summary.shown, 1);
  assert.ok(!conf.rows.find((r) => r.code === 'MA').done);
  const cw = AT.buildWasTable(roster, { mode: 'cw' });
  assert.strictEqual(cw.summary.worked, 0, 'family filter');
  const digi = AT.buildWasTable(roster, { mode: 'digital' });
  assert.strictEqual(digi.summary.worked, 1);
});

test('DXCC: mode and band filters, X / 100, the Challenge count, worked not confirmed', () => {
  const data = { entities: [
    { name: 'Canada', prefix: 'VE', continent: 'NA', confirmed: { '20m': ['SSB'], '60m': ['FT8'] } },
    { name: 'Japan', prefix: 'JA', continent: 'AS', confirmed: { '40m': ['CW'] } },
    { name: 'Chad', prefix: 'TT', continent: 'AF', confirmed: {} },
  ] };
  const t = AT.buildDxccTable(data, AT.DXCC_BANDS, { mode: 'all', band: 'all' });
  assert.strictEqual(t.summary.count, 2);
  assert.strictEqual(t.summary.challenge, 2, '60 m is not a Challenge band');
  assert.strictEqual(t.rows.find((r) => r.name === 'Canada').cells['20m'], 'worked');
  assert.ok(!JSON.stringify(t).includes('confirmed"'), 'never claims a confirmation the data does not hold');
  assert.strictEqual(AT.buildDxccTable(data, AT.DXCC_BANDS, { mode: 'cw' }).summary.count, 1);
  const b = AT.buildDxccTable(data, AT.DXCC_BANDS, { band: '20m' });
  assert.deepStrictEqual(b.bands, ['20m']);
  assert.strictEqual(b.summary.challenge, null);
  assert.strictEqual(AT.buildDxccTable(null, AT.DXCC_BANDS, {}).summary.empty, true);
});

test('wiring: demux refuses a Guest Pass, main answers the asker, registry + capability', () => {
  const rs = R('lib/remote-server.js'), main = R('main.js');
  assert.ok(/case 'award-table-get':\n\s*\/\/[^\n]*\n\s*if \(ws\._passSession\) \{ this\._sendTo\(ws, \{ type: 'award-table-refused'/.test(rs));
  assert.ok(rs.includes("'award-tables'") && rs.includes('sendAwardTable(ws, payload)'));
  assert.ok(/remoteServer\.on\('award-table-get', async \(\{ ws, table, mode, band, count, reqId \}\) => \{/.test(main));
  assert.ok(/AwardTables\.buildDxccTable\(await buildDxccData\(\), AwardTables\.DXCC_BANDS/.test(main) && /AwardTables\.buildWasTable\(workedRoster/.test(main));
  const M = require('../lib/echocat-protocol');
  const reg = M.MESSAGES || M;
  for (const t of ['award-table-get', 'award-table', 'award-table-refused']) assert.ok(reg[t], t);
});

console.log(`\nAward tables: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
