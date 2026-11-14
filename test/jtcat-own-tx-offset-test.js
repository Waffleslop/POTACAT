'use strict';
// #503: our own TX rows in JTCAT's Activity lists show the audio offset that
// transmission went out on (as WSJT-X does), not "--". The offset is the
// txFreq of the state:'tx' jtcat-tx-status, stamped at key-down, so a slider
// moved since does not rewrite the row. Every surface builds the row through
// DecodeRow.txRowInner: the desktop JTCAT window and ECHOCAT Web.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const DecodeRow = require('../lib/decode-row.js');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}
const dfCell = (html, p) => {
  const m = html.match(new RegExp('<span class="' + p + '-df">([^<]*)</span>'));
  return m ? m[1] : null;
};

test('the TX row shows its offset in whole Hz in the df cell', () => {
  assert.strictEqual(dfCell(DecodeRow.txRowInner('W2XYZ K1ABC -12', 'jp', 1523), 'jp'), '1523');
  assert.strictEqual(dfCell(DecodeRow.txRowInner('W2XYZ K1ABC -12', 'ft8', 1499.6), 'ft8'), '1500');
  assert.strictEqual(dfCell(DecodeRow.txRowInner('CQ K1ABC FN42', 'ft8', '2100'), 'ft8'), '2100');
});

test('an unknown offset shows the caller\'s placeholder, never 0 or NaN', () => {
  for (const v of [undefined, null, 0, '', 'x', NaN]) {
    assert.strictEqual(dfCell(DecodeRow.txRowInner('CQ K1ABC FN42', 'jp', v, '--'), 'jp'), '--', String(v));
    assert.strictEqual(dfCell(DecodeRow.txRowInner('CQ K1ABC FN42', 'ft8', v), 'ft8'), '', String(v));
  }
});

test('the row keeps TX in the dB cell, an empty dt cell and the escaped message', () => {
  const h = DecodeRow.txRowInner('<b>', 'ft8', 1000);
  assert.ok(h.startsWith('<span class="ft8-db">TX</span><span class="ft8-dt"></span><span class="ft8-df">1000</span>'), h);
  assert.ok(h.includes('<span class="ft8-msg">&lt;b&gt;</span>'), h);
});

test('the JTCAT window passes the offset that slot keyed on (data.txFreq), not the slider', () => {
  const pop = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.js'));
  assert.ok(/DecodeRow\.txRowInner\(data\.message, 'jp', data\.txFreq, '--'\)/.test(pop), 'popout TX row carries data.txFreq');
  assert.ok(!/txRowInner\([^)]*jpTxFreqHz/.test(pop), 'never the current TX frequency');
});

test('ECHOCAT Web keeps the offset with the pending TX message and draws it', () => {
  const web = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
  assert.ok(/ft8PendingTxMsg = ft8TxMsg;\n\s*\/\/[^\n]*\n\s*ft8PendingTxHz = msg\.txFreq \|\| 0;/.test(web), 'stamped from the tx status');
  assert.ok(/DecodeRow\.txRowInner\(ft8PendingTxMsg, 'ft8', ft8PendingTxHz\)/.test(web), 'cycle TX row');
  assert.ok(/DecodeRow\.txRowInner\(message, 'ft8', txHz\)/.test(web), 'live TX row');
  assert.ok(!/txRowInner\([^)]*ft8TxFreqHz/.test(web), 'never the current TX frequency');
});

test('the shack sends txFreq on every state:tx status to the JTCAT window and ECHOCAT', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  const pop = main.match(/jtcatPopoutWin\.webContents\.send\('jtcat-tx-status', \{ state: 'tx'[^\n]*/g) || [];
  const web = main.match(/remoteServer\.broadcastJtcatTxStatus\(\{ state: 'tx'[^\n]*/g) || [];
  assert.ok(pop.length >= 2 && web.length >= 2, 'tx statuses found');
  for (const l of pop.concat(web)) assert.ok(/txFreq: /.test(l), l);
});

test('the layout fixture exercises the offset cell', () => {
  const fx = require('./layout/fixtures.js');
  const tx = fx.DECODES.find(f => f.tx);
  assert.ok(tx && tx.txHz > 0, 'TX fixture has an offset');
  const harness = readSrc(path.join(__dirname, 'layout', 'harness.js'));
  assert.strictEqual((harness.match(/txRowInner\(f\.text, '(ft8|jp)', f\.txHz/g) || []).length, 2, 'both TX rows render f.txHz');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
