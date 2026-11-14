'use strict';
// DXCC tracker wording says what is counted (GitHub #382): an ADIF log is
// every QSO, so "worked" and no "DXCC!"; a Log4OM SQLite log is read
// confirmed-only, so "confirmed". Run: node test/dxcc-progress-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const DP = require('../lib/dxcc-progress');
const AT = require('../lib/award-tables');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n    ' + e.message); }
}

test('worked basis: labels say worked, no DXCC! award', () => {
  const t = DP.dxccProgressText(42, 'worked', 7);
  assert.strictEqual(t.count, '42 / 100 worked');
  assert.strictEqual(t.award, '');
  assert.strictEqual(t.challenge, 'Challenge: 7 worked');
  assert.strictEqual(DP.dxccProgressText(120, 'worked').award, '100 entities worked');
});

test('confirmed basis keeps DXCC! at 100', () => {
  const t = DP.dxccProgressText(100, 'confirmed', 3);
  assert.strictEqual(t.count, '100 / 100 confirmed');
  assert.strictEqual(t.award, 'DXCC!');
  assert.strictEqual(t.challenge, 'Challenge: 3 confirmed');
});

test('unknown basis reads as worked; no challenge when null', () => {
  for (const b of [undefined, null, '', 'lotw']) {
    const t = DP.dxccProgressText(150, b, null);
    assert.strictEqual(t.basis, 'worked');
    assert.strictEqual(t.award, '100 entities worked');
    assert.strictEqual(t.challenge, '');
  }
});

test('ECHOCAT table summary uses the same award line and basis', () => {
  const ents = [];
  for (let i = 0; i < 100; i++) ents.push({ name: 'E' + i, prefix: 'P' + i, continent: 'EU', confirmed: { '20m': ['CW'] } });
  const w = AT.buildDxccTable({ entities: ents }, AT.DXCC_BANDS, {});
  assert.strictEqual(w.summary.award, '100 entities worked');
  assert.strictEqual(w.summary.basis, 'worked');
  const c = AT.buildDxccTable({ entities: ents, basis: 'confirmed' }, AT.DXCC_BANDS, {});
  assert.strictEqual(c.summary.award, 'DXCC!');
  assert.strictEqual(c.summary.basis, 'confirmed');
});

test('main window and main.js use the module, no hard-coded DXCC! or bare X / 100', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const main = readSrc(path.join(root, 'main.js'));
  assert.ok(!app.includes("'DXCC!'"), 'app.js must not hard-code DXCC!');
  assert.ok(app.includes('DxccProgress.dxccProgressText('), 'app.js uses DxccProgress');
  assert.ok(html.includes('<script src="../lib/dxcc-progress.js"></script>'));
  assert.ok(html.includes('<span id="dxcc-count">0 / 100 worked</span>'));
  assert.ok(!/count as confirmed in the DXCC Tracker/.test(html), 'settings help no longer claims confirmed');
  assert.ok(/basis: sqlite \? 'confirmed' : 'worked'/.test(main), 'buildDxccData reports its basis');
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('dxcc-progress: all passed');
