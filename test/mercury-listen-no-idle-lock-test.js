// SPDX-License-Identifier: Apache-2.0
'use strict';
// #919 (gm1ymi, FTDX10, 1.14.7): with Mercury Listen on, Mercury took the
// radio lock as soon as LISTEN started and held it while idle, so FT8 was
// refused and Station Setup's Transmit Test returned "Something else is
// transmitting" with no session.log line, which looked like broken CAT.
//   - LISTEN takes no lock; a session takes it in lib/mercury-radio-bridge.js.
//   - The Transmit Test names whoever holds the radio, on screen and in one
//     session.log line, and holds the radio itself while it runs.
// Run: node test/mercury-listen-no-idle-lock-test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readSrc } = require('./_src');
const RadioOwner = require('../lib/radio-owner');

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));

function fnBody(src, header) {
  const at = src.indexOf(header);
  assert.ok(at !== -1, 'missing: ' + header);
  const open = src.indexOf('{', at + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('unbalanced: ' + header);
}

test('LISTEN on Mercury start takes no radio lock', () => {
  const b = fnBody(MAIN, 'function onMercuryReady() {');
  assert.match(b, /mercuryClient\.listen\('ON'\)/);
  assert.doesNotMatch(b, /acquireRadio\(/, 'an idle listener must not hold the radio');
});

test('the Listen toggle takes and drops no radio lock', () => {
  const b = fnBody(MAIN, "ipcMain.on('mercury-cmd-listen', (_e, on) => {");
  assert.match(b, /mercuryClient\.listen\('ON'\)/);
  assert.doesNotMatch(b, /acquireRadio\(/);
  assert.doesNotMatch(b, /releaseRadio\(/, 'turning Listen off must not drop a live session\'s lock');
});

test('the bridge acquire yields to a tune in progress', () => {
  const at = MAIN.indexOf('attachMercuryRadioBridge(mercuryClient, {');
  assert.ok(at !== -1);
  const hooks = MAIN.slice(at, MAIN.indexOf('\n  });', at));
  assert.match(hooks, /acquire: \(\) => \{\s*if \(jtcatTuneState\.active\)[^\n]*return false; \}\s*return acquireRadio\('mercury'\);/);
});

test('the Transmit Test names the holder in session.log and on screen, then holds the radio', () => {
  const b = fnBody(MAIN, 'async function _runStationSetupTxTest(rigId, { keepPower = false, voice = false } = {}) {');
  assert.doesNotMatch(b, /Something else is transmitting/, 'the vague message is gone');
  const refusal = b.indexOf("radioOwnerLib.txTestRefusal(radioOwner, { tuneActive: jtcatTuneState.active })");
  assert.ok(refusal !== -1, 'asks lib/radio-owner.js who holds the radio, tune included');
  assert.match(b, /if \(heldBy\) \{ sendCatLog\(heldBy\.log\); return done\(\{ result: 'error', message: heldBy\.message \}\); \}/);
  const take = b.indexOf("acquireRadio('setup-test')");
  assert.ok(take > refusal, 'takes the radio after the holder check');
  assert.ok(take < b.indexOf('startJtcatTune('), 'and before keying');
  const wrap = fnBody(MAIN, 'async function runStationSetupTxTest(rigId, opts) {');
  assert.match(wrap, /finally \{[^}]*releaseRadio\('setup-test'\)/, 'released on every way out');
});

test('JTCAT\'s refusal uses the same wording', () => {
  const at = MAIN.indexOf("ft8Engine.on('tx-start', (data) => {");
  const b = MAIN.slice(at, at + 1500);
  assert.match(b, /radioOwnerLib\.describeRadioHolder\(radioOwner\)/);
});

test('txTestRefusal: one log line and a plain message per holder', () => {
  assert.equal(RadioOwner.txTestRefusal('none'), null);
  assert.equal(RadioOwner.txTestRefusal('bogus'), null);
  const m = RadioOwner.txTestRefusal('mercury');
  assert.equal(m.log, '[Setup] test transmit refused: Mercury (HF data) holds the radio');
  assert.match(m.message, /^Mercury \(HF data\) is in a session\. .+, then test again\.$/);
  const j = RadioOwner.txTestRefusal('jtcat');
  assert.equal(j.log, '[Setup] test transmit refused: FT8 holds the radio');
  assert.match(j.message, /^FT8 is transmitting\./);
  const t = RadioOwner.txTestRefusal('none', { tuneActive: true });
  assert.equal(t.log, '[Setup] test transmit refused: a tune holds the radio');
  assert.match(t.message, /^A tune is in progress\./);
  for (const o of RadioOwner.OWNERS) {
    if (o === 'none') continue;
    const r = RadioOwner.txTestRefusal(o);
    assert.ok(r && r.log && r.message, 'every owner has wording: ' + o);
    assert.doesNotMatch(r.message, /undefined/);
  }
});

test('setup-test is a radio owner: Mercury cannot take the radio during the test', () => {
  assert.ok(RadioOwner.OWNERS.includes('setup-test'));
  assert.equal(RadioOwner.decideAcquire('setup-test', 'mercury').ok, false);
  assert.equal(RadioOwner.decideRelease('setup-test', 'setup-test').owner, 'none');
});
