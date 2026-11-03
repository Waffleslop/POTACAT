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
check("the guest's verified account callsign wins", () => {
  assert.strictEqual(onAirCallFor({ guest_callsign: 'k3sbp', station_callsign: 'W7RTA' }, 'W7RTA'), 'K3SBP');
});
check('an older pass: the station call its issuer wrote', () => {
  assert.strictEqual(onAirCallFor({ station_callsign: 'k3sbp' }, 'W7RTA'), 'K3SBP');
});
check('a live pass with no call is listen-only, never the host call', () => {
  assert.strictEqual(onAirCallFor({ station_callsign: '' }, 'w7rta'), '');
  assert.strictEqual(onAirCallFor({}, 'W7RTA'), '');
});
check('no session = the host call', () => {
  assert.strictEqual(onAirCallFor(null, 'w7rta'), 'W7RTA');
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
check("a pass with no verified call tells the guest no call (listen only), never the host's", () => {
  const rs = fakeServer();
  const ws = { _passSession: { passProfile: {} } };
  assert.strictEqual(rs._settingsFor(ws).myCallsign, '');
});
check('the guest account callsign from validate-session wins', () => {
  const rs = fakeServer();
  const ws = { _passSession: { passProfile: { guest_callsign: 'K3SBP', station_callsign: 'W7RTA' } } };
  assert.strictEqual(rs._settingsFor(ws).myCallsign, 'K3SBP');
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
  assert.ok(/stationCallsign:\s*String\(this\._passOnAirCall\(ws\) \|\| ''\)/.test(body), "auth-ok stationCallsign must be _passOnAirCall(ws), '' when listen-only (never null)");
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
  // Both forward sites: a guest's (passGuestLogContact, which also queues it
  // for the guest's logbook) and an owner device's.
  let i = -1, n = 0;
  while ((i = main.indexOf("type: 'qso-attributed', qso: qsoData", i + 1)) > 0) {
    n++;
    assert.ok(/qsoData\.stationCallsign = onAirCall\(\)/.test(main.slice(i - 1500, i)), 'site ' + n);
  }
  assert.ok(n >= 2, 'both forward sites found');
});
check('a pass change begins and ends the lease, which re-arms AP and tells the JTCAT window', () => {
  const i = main.indexOf("passEnforcement.on('state-change'");
  const b = main.slice(i, i + 900);
  assert.ok(/passLeaseBegin\(\)/.test(b) && /passLeaseEnd\(\)/.test(b));
  const t = fnBody('passLeaseTellWindows');
  assert.ok(/setApContext\(\{ myCall: call \}\)/.test(t));
  assert.ok(/'jtcat-on-air-call'/.test(t));
});

console.log('the lease (phase B):');
check('no verified call refuses every transmit', () => {
  const e = enf('active', { code: 'ABC', privilege_class: 'us_extra', allowed_modes: [], max_power_w: 100 });
  e._expiresAtMs = Date.now() + 60000;
  const r = e.interceptCatCommand({ type: 'tx_enable', freqHz: 14074000, mode: 'CW' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'no_callsign');
  assert.strictEqual(e.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000 }).reason, 'no_callsign');
  assert.strictEqual(e.interceptCatCommand({ type: 'tune', freqHz: 14074000 }).allowed, true, 'listening is fine');
});
check('the validated session carries the guest call into PassEnforcement', () => {
  const e = enf('active', { code: 'ABC', station_callsign: 'W7RTA' });
  e.adoptSession({ guest_callsign: 'K3SBP', guest_user_id: 'u1' });
  assert.strictEqual(e.onAirCallsign('W7RTA'), 'K3SBP');
  assert.strictEqual(e.getSessionStatus().onAirCallsign, 'K3SBP');
  const pe = fs.readFileSync(path.join(ROOT, 'lib/pass-enforcement.js'), 'utf8');
  assert.ok(/async loadPass\(code, session\)/.test(pe) && /this\.adoptSession\(session\);/.test(pe));
  assert.ok(/loadPass\(code, session\)/.test(main), 'main hands the validated session over');
  const rsrc = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
  assert.ok(/this\._onPassAuth\(profile\.code, msg\.sessionId, profile\)/.test(rsrc));
});
check('everything that identifies or reports the station reads onAirCall()', () => {
  const needles = [
    /callsign: \(node\.loginCall && node\.loginCall\.trim\(\)\) \|\| onAirCall\(\)/,
    /callsign: onAirCall\(\), \/\/ "where am I heard"/,
    /const myCall = onAirCall\(\); \/\/ "where am I heard"/,
    /\{ call: onAirCall\(\), grid: settings\.grid \}/,
    /eng\.setStation\(\{ call: onAirCall\(\), grid: settings\.grid \}\)/,
    /mercuryClient\.myCall\(onAirCall\(\)\)/,
    /sanitizeSstvFilenamePart\(onAirCall\(\), ''\)/,
  ];
  for (const re of needles) assert.ok(re.test(main), 'missing ' + re);
  assert.strictEqual((main.match(/spotter: onAirCall\(\),/g) || []).length, 3, 'POTA, WWFF and WWBOTA re-spots');
  assert.ok(!/spotter: settings\.myCallsign/.test(main));
  for (const name of ['wsprBeaconTick', 'pskrFlush']) assert.ok(!/settings\.myCallsign/.test(fnBody(name)), name);
});
check('the lease parks the owner: heartbeat off, own JS8 threads, no APRS gate, no activation refs', () => {
  const b = fnBody('passLeaseBegin');
  assert.ok(/js8SetHeartbeat\(false\)/.test(b));
  assert.ok(/js8Threads = new Js8Threads/.test(b));
  assert.ok(/disconnectAprsGate\(\)/.test(b));
  assert.ok(/passLeaseReconnectReporters\(\)/.test(b));
  const e = fnBody('passLeaseEnd');
  assert.ok(/js8Threads = was\.js8Threads/.test(e) && /connectAprsGate\(\)/.test(e));
  assert.ok(!/js8SetHeartbeat\(true\)/.test(e), 'an automatic transmitter is never restarted unattended');
  assert.ok(/if \(passLease\) return \[\];/.test(fnBody('liveActivationMyRefs')));
});
check('a forwarded guest QSO names the guest as operator and keeps the licensee privately', () => {
  const i = main.indexOf("type: 'qso-attributed', qso: qsoData");
  const b = main.slice(i - 900, i);
  assert.ok(/qsoData\.operator = onAirCall\(\)/.test(b));
  assert.ok(/qsoData\.stationLicensee = /.test(b));
});
check('Share My Rig asks one callsign question, and no box is pre-filled with the owner', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert.ok(/Who is this pass for\?/.test(html));
  assert.ok(/id="share-rig-for"/.test(html));
  for (const id of ['share-rig-station', 'share-rig-operator', 'share-rig-control']) assert.ok(!html.includes('id="' + id + '"'), id);
  assert.ok(!/_shareRigPrefillCallsigns/.test(app));
  assert.ok(/can listen and log but not transmit/.test(html), 'the anonymous option says what it costs');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
