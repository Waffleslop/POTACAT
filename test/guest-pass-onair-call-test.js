'use strict';
/**
 * Guest Pass: the pass decides the on-air call (Casey 2026-10-27).
 *
 * K3SBP redeemed W7RTA's pass and FT8 went out as W7RTA: JTCAT always encoded
 * the desktop's myCallsign, and the pass's station_callsign reached the guest
 * but never the transmitter. The rule: during a session the on-air call is the
 * pass's station_callsign when set, else the host's call. Both issuing forms
 * default that field to the issuer's call, so an ordinary pass is unchanged.
 *
 * The pure rule, the session states it applies in, what the guest's device is
 * told, and source guards that every transmit path reads onAirCall().
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PassEnforcement, onAirCallFor } = require('../lib/pass-enforcement');
const { RemoteServer } = require('../lib/remote-server');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + e.message); }
}

console.log('rule:');
check('the pass station call wins', () => {
  assert.strictEqual(onAirCallFor({ station_callsign: 'k3sbp' }, 'W7RTA'), 'K3SBP');
});
check('no station call on the pass = the host call', () => {
  assert.strictEqual(onAirCallFor({ station_callsign: '' }, 'w7rta'), 'W7RTA');
  assert.strictEqual(onAirCallFor({}, 'W7RTA'), 'W7RTA');
  assert.strictEqual(onAirCallFor(null, 'W7RTA'), 'W7RTA');
});
check('only callsign characters survive', () => {
  assert.strictEqual(onAirCallFor({ station_callsign: ' KH6/k3sbp ' }, 'W7RTA'), 'KH6/K3SBP');
});

console.log('session states:');
function enf(state, pass) {
  const e = new PassEnforcement({ log: () => {} });
  e._state = state;
  e._pass = pass;
  return e;
}
const pass = { code: 'ABC', station_callsign: 'K3SBP' };
check('active and expiring transmit the pass call', () => {
  assert.strictEqual(enf('active', pass).onAirCallsign('W7RTA'), 'K3SBP');
  assert.strictEqual(enf('expiring', pass).onAirCallsign('W7RTA'), 'K3SBP');
});
check('idle, pending and ended transmit the host call', () => {
  assert.strictEqual(enf('idle', null).onAirCallsign('W7RTA'), 'W7RTA');
  assert.strictEqual(enf('pending', null).onAirCallsign('W7RTA'), 'W7RTA');
  // ended keeps _pass until the settle to idle; the call is the host's at once
  assert.strictEqual(enf('ended', pass).onAirCallsign('W7RTA'), 'W7RTA');
});

console.log('what the guest is told:');
function fakeServer() {
  const rs = Object.create(RemoteServer.prototype);
  rs._remoteSettings = { myCallsign: 'W7RTA', grid: 'DN13', watchlist: 'X', hideOutOfBand: true };
  return rs;
}
check('a guest gets the pass call as settings.myCallsign', () => {
  const rs = fakeServer();
  const ws = { _passSession: { passProfile: { station_callsign: 'K3SBP' } } };
  assert.strictEqual(rs._settingsFor(ws).myCallsign, 'K3SBP');
  assert.strictEqual(rs._passOnAirCall(ws), 'K3SBP');
});
check('a pass naming no station call keeps the host call', () => {
  const rs = fakeServer();
  const ws = { _passSession: { passProfile: {} } };
  assert.strictEqual(rs._settingsFor(ws).myCallsign, 'W7RTA');
});
check('the owner\'s own devices are untouched', () => {
  const rs = fakeServer();
  assert.strictEqual(rs._settingsFor({}).myCallsign, 'W7RTA');
  assert.strictEqual(rs._remoteSettings.myCallsign, 'W7RTA', 'the shared blob is never mutated');
});
check('pass auth-ok carries the on-air call at the top level', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
  const i = src.indexOf('async _authenticatePass(');
  const body = src.slice(i, src.indexOf('passSession: {', i));
  assert.ok(/stationCallsign:\s*this\._passOnAirCall\(ws\)/.test(body), 'auth-ok stationCallsign must be _passOnAirCall(ws)');
  assert.ok(/settings:\s*this\._settingsFor\(ws\)/.test(body), 'auth-ok settings must be _settingsFor(ws)');
});

console.log('main.js transmit paths:');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
function fnBody(name) {
  const re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\(');
  const m = re.exec(main);
  assert.ok(m, name + ' not found');
  let depth = 0, j = main.indexOf('{', m.index);
  for (let k = j; k < main.length; k++) {
    if (main[k] === '{') depth++;
    else if (main[k] === '}' && --depth === 0) return main.slice(m.index, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
check('onAirCall() asks PassEnforcement', () => {
  assert.ok(/passEnforcement\.onAirCallsign\(/.test(fnBody('onAirCall')));
});
for (const name of ['remoteJtcatMyCall', 'jtcatBuildCqQso', 'jtcatRunWorkableCount', 'jtcatHuntCqFallbackTick']) {
  check(name + ' uses onAirCall(), not settings.myCallsign', () => {
    const b = fnBody(name);
    assert.ok(/onAirCall\(\)/.test(b), 'no onAirCall()');
    assert.ok(!/settings\.myCallsign/.test(b), 'still reads settings.myCallsign');
  });
}
check('the engine, AP context and decode stamp use onAirCall()', () => {
  assert.ok(/startSlice\(\{[\s\S]{0,400}myCall:\s*onAirCall\(\)/.test(main), 'startSlice myCall');
  assert.ok(/const apCall = onAirCall\(\);/.test(main), 'AP context at start');
  assert.ok(/data\.myCall = onAirCall\(\);/.test(main), 'decode batch stamp');
  assert.ok(!/setApContext\(\{[^}]*myCall:\s*settings\.myCallsign/.test(main), 'an AP context still reads settings.myCallsign');
});
check('CW {MYCALL}, SSTV CW ID and the SSTV call follow onAirCall()', () => {
  assert.ok(/\{MYCALL\\\}\/gi, onAirCall\(\)\)/.test(main), 'CW {MYCALL}');
  assert.ok(/generateMorseSamples\(onAirCall\(\)/.test(main), 'SSTV CW ID');
  const i = main.indexOf("ipcMain.handle('sstv-context'");
  assert.ok(/myCall:\s*onAirCall\(\)/.test(main.slice(i, i + 800)), 'sstv-context myCall');
});
check('a forwarded guest QSO is stamped with the on-air call', () => {
  const i = main.indexOf("type: 'qso-attributed', qso: qsoData");
  assert.ok(i > 0);
  assert.ok(/qsoData\.stationCallsign = onAirCall\(\)/.test(main.slice(i - 600, i)));
});
check('a pass change re-arms AP and tells the JTCAT window', () => {
  const i = main.indexOf("passEnforcement.on('state-change'");
  const b = main.slice(i, i + 1500);
  assert.ok(/setApContext\(\{ myCall: nowCall \}\)/.test(b));
  assert.ok(/'jtcat-on-air-call'/.test(b));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
