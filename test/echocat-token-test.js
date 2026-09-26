// ECHOCAT Web shared token (lib/echocat-token.js): no look-alike characters
// in new tokens, forgiving comparison for typed ones, and no token by default
// on a fresh install (Casey 2026-09-25: "a user ... thought the 5 was an S").
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/echocat-token');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}

test('new tokens never contain a character with a look-alike', () => {
  for (const c of '0O1IL2Z5S8B') assert.ok(!T.ALPHABET.includes(c), c + ' is in the alphabet');
  for (let i = 0; i < 2000; i++) {
    const t = T.generateToken();
    assert.strictEqual(t.length, T.LENGTH);
    assert.ok(/^[ACDEFGHJKMNPQRTUVWXY34679]+$/.test(t), t);
  }
});

test('a typed token forgives case, spaces, dashes and the usual look-alikes', () => {
  assert.ok(T.sameToken('ac3-d4e', 'AC3D4E'));
  assert.ok(T.sameToken(' AC3 D4E ', 'AC3D4E'));
  // Old hex tokens: the reported mistake, S for 5, and its cousins.
  assert.ok(T.sameToken('7S0B1F', '750B1F'));   // S read for 5
  assert.ok(T.sameToken('75OB1F', '750B1F'));   // O for 0
  assert.ok(T.sameToken('750BIF', '750B1F'));   // I for 1
  assert.ok(T.sameToken('7508lF', '750B1F'));   // 8 for B, l for 1
});

test('a wrong or empty token still fails', () => {
  assert.ok(!T.sameToken('AC3D4F', 'AC3D4E'));
  assert.ok(!T.sameToken('AC3D4', 'AC3D4E'));
  assert.ok(!T.sameToken('', 'AC3D4E'));
  assert.ok(!T.sameToken('AC3D4E', ''));
  assert.ok(!T.sameToken(null, null));
});

test('the server uses the forgiving compare on both token paths', () => {
  const rs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  assert.ok(/if \(!EchocatToken\.sameToken\(qToken, this\._token\)\)/.test(rs), 'PTT REST endpoint');
  assert.ok(/msg\.token && this\._token && EchocatToken\.sameToken\(msg\.token, this\._token\)/.test(rs), 'WS auth');
  assert.ok(/return EchocatToken\.generateToken\(\);/.test(rs));
});

test('a fresh install needs no token: unset means off in Settings, as in the server', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(!/remoteRequireToken !== false/.test(app), 'Settings still reads unset as "required"');
  assert.strictEqual((app.match(/remoteRequireToken === true/g) || []).length, 4);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/const requireToken = settings\.remoteRequireToken === true;/.test(main));
});

console.log(`\nECHOCAT token: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
