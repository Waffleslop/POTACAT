'use strict';
// {greeting} CW token (LZ3AW 2026-10-16 item 10): GM / GA / GE by the other
// station's local (solar) time, expanded once in main's sendCwTextToRadio so
// every surface agrees. Run: node test/cw-greeting-test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const G = require('../lib/cw-greeting');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const at = (h, m = 0) => Date.UTC(2026, 9, 19, h, m);

test('by the other station\'s solar time, not ours', () => {
  assert.strictEqual(G.greetingForLongitude(0, at(9)), 'GM');       // London 09Z
  assert.strictEqual(G.greetingForLongitude(0, at(13)), 'GA');
  assert.strictEqual(G.greetingForLongitude(0, at(20)), 'GE');
  assert.strictEqual(G.greetingForLongitude(25.08, at(9)), 'GM');   // Bulgaria 09Z ≈ 10:40
  assert.strictEqual(G.greetingForLongitude(25.08, at(11)), 'GA');  // ≈ 12:40
});
test('east and west of Greenwich, wrapping past midnight', () => {
  assert.strictEqual(G.greetingForLongitude(-91.87, at(14)), 'GM');  // US centre 14Z ≈ 07:52
  assert.strictEqual(G.greetingForLongitude(138.38, at(14)), 'GE');  // Japan 14Z ≈ 23:13
  assert.strictEqual(G.greetingForLongitude(132.33, at(1)), 'GM');   // Australia 01Z ≈ 09:49
  assert.strictEqual(G.greetingForLongitude(-75, at(2)), 'GE');      // 02Z at 75W ≈ 21:00 the day before
});
test('boundaries: 04:00 GM, 12:00 GA, 18:00 GE; unknown position = GD', () => {
  assert.strictEqual(G.greetingForLongitude(0, at(4)), 'GM');
  assert.strictEqual(G.greetingForLongitude(0, at(3, 59)), 'GE');
  assert.strictEqual(G.greetingForLongitude(0, at(12)), 'GA');
  assert.strictEqual(G.greetingForLongitude(0, at(18)), 'GE');
  assert.strictEqual(G.greetingForLongitude(null, at(9)), 'GD');
  assert.strictEqual(G.greetingForLongitude(NaN, at(9)), 'GD');
});
test('expandGreeting replaces every token, any case; hasGreeting keeps no state', () => {
  assert.strictEqual(G.expandGreeting('{greeting} OM {GREETING}', 0, at(9)), 'GM OM GM');
  assert.ok(G.hasGreeting('x {Greeting}') && !G.hasGreeting('{call} 599'));
  assert.ok(G.hasGreeting('{greeting}') && G.hasGreeting('{greeting}'), 'a global regex must not leak lastIndex');
});
test('main expands it once, in sendCwTextToRadio, from the worked call\'s position', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const at0 = main.indexOf('function sendCwTextToRadio(text, opts) {');
  assert.ok(/if \(text\) text = expandCwGreeting\(text\);/.test(main.slice(at0, at0 + 400)));
  const fn = main.slice(main.indexOf('function expandCwGreeting(text) {'), main.indexOf('function setTypedCall('));
  assert.ok(/typedCalls\.current\(\)/.test(fn), 'the same callsign rule as {call}');
  assert.ok(/gridToLatLon\(info\.grid\)/.test(fn) && /resolveCallsign\(/.test(fn), 'QRZ grid first, then cty.dat');
  assert.ok(!/await|qrz\.lookup\(/.test(fn), 'never waits on the network');
});
test('the token is documented where the CW variables are listed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(/\{greeting\} \(GM \/ GA \/ GE by their local time\)/.test(html));
});
console.log(`\nCW greeting: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
