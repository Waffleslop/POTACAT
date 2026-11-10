// POTACAT's hosted VOACAP is checked once per Winlink start (#278): when it
// is not there, Pat is not pointed at it (it asked once per gateway: 1256
// failed requests and 34 s for one VARA HF list) and the log says why.
// Run: node test/winlink-voacap-probe-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const W = require('../lib/winlink-pat');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? i + 3000 : j);
}

console.log('winlink VOACAP service check (#278)');

test('only a 200 from <base>/version counts as there', () => {
  assert.deepStrictEqual(W.voacapServiceVerdict({ status: 200 }), { use: true, why: '' });
  assert.deepStrictEqual(W.voacapServiceVerdict({ status: 404 }), { use: false, why: 'it answered HTTP 404' });
  assert.strictEqual(W.voacapServiceVerdict({ status: 0, error: 'getaddrinfo ENOTFOUND' }).use, false);
  assert.ok(/could not be reached/.test(W.voacapServiceVerdict({ error: 'ECONNREFUSED' }).why));
  assert.strictEqual(W.voacapServiceVerdict({}).why, 'it did not answer');
});

test('a service checked and not there is left out of Pat\'s config; unchecked or up is used as before', () => {
  assert.deepStrictEqual(W.predictionConfig({ serviceUp: false }), { engine: 'disabled' });
  assert.strictEqual(W.predictionConfig({ serviceUp: null }).engine, 'voacap-api', 'not yet checked: unchanged');
  assert.strictEqual(W.predictionConfig({ serviceUp: true }).engine, 'voacap-api');
  assert.strictEqual(W.predictionConfig({ localVoacap: true, serviceUp: false }).engine, 'voacap', 'an own install does not need our service');
  assert.strictEqual(W.predictionConfig({ enabled: false, serviceUp: true }).engine, 'disabled');
});

test('main checks once per Winlink start, before Pat\'s config is written, with a 5 s limit', () => {
  const c = fnBody(main, 'connectWinlink');
  const chk = c.indexOf('await winlinkCheckVoacapService();');
  assert.ok(chk > 0 && chk < c.indexOf('writePatConfig()'), 'checked before the config is written');
  const f = main.slice(main.indexOf('async function winlinkCheckVoacapService('), main.indexOf('async function winlinkCheckVoacapService(') + 900);
  assert.ok(/\$\{base\}\/version/.test(f) && /AbortSignal\.timeout\(5000\)/.test(f));
  assert.ok(/settings\.winlinkPrediction === false\) return;/.test(f), 'ranking turned off: no request at all');
  assert.ok(/serviceUp: _voacapService\.up/.test(fnBody(main, 'winlinkPredictionConfig')));
});

test('the log and the gateway line say the service is not available, and why', () => {
  assert.ok(/nearest first this run — POTACAT's VOACAP service is not available \(\$\{_voacapService\.why\}\)/.test(main));
  assert.ok(/_voacapService\.up === false \? ` — POTACAT's VOACAP service is not available/.test(main));
  assert.ok(!/VOACAP service unreachable\?/.test(main), 'no more guessing in the log');
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-voacap-probe-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
