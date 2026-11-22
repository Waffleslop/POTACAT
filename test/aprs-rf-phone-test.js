#!/usr/bin/env node
'use strict';
// ECHOCAT ask 2026-11-21 (ECHOCAT_TO_DESKTOP_HANDOFF_2026-11-21_APRS_RADIO_BEACON;
// Casey: "go on the APRS radio beacon handoff"): the owner's phone may ask for
// ONE beacon over the radio (aprs-beacon-rf). It is the window's run, gate and
// caps; the press counts as the window; with Listen off the desktop sets the
// radio up and puts it back. A Guest Pass never may.
// Run: node test/aprs-rf-phone-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Gate = require('../lib/aprs-rf-gate');
const Echo = require('../lib/aprs-echocat');
const { RemoteServer } = require('../lib/remote-server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const LIVE = {
  remote: false, windowOpen: false, askedFrom: 'phone', listenOn: true, listenState: 'listening', band: '2m',
  settingsCall: 'K3SBP', aprsHz: 144390000, dialHz: 144390000, radioOwner: 'none', pttKeyed: false,
  otherTx: '', swrTripped: false, txInterlock: '', modemFound: true, inFlight: false,
};

console.log('APRS radio beacon from the phone');

test('the press counts as the window; the window path still needs the window', () => {
  assert.deepStrictEqual(Gate.phoneReadiness(LIVE), { ready: true, setup: false });
  assert.strictEqual(Gate.readiness({ ...LIVE, askedFrom: 'window' }).reason, 'window');
  assert.strictEqual(Gate.readiness(LIVE), null, 'askedFrom phone passes the window check');
});

test('Listen off: ready, and the desktop sets the radio up (dial and listening judged after)', () => {
  const r = Gate.phoneReadiness({ ...LIVE, listenOn: false, listenState: 'off', dialHz: 7074000 });
  assert.deepStrictEqual(r, { ready: true, setup: true });
});

test('what setup cannot fix is refused in the window words', () => {
  const off = { ...LIVE, listenOn: false, listenState: 'off' };
  assert.strictEqual(Gate.phoneReadiness({ ...off, radioOwner: 'jtcat' }).sentence, 'JTCAT has the radio.');
  assert.strictEqual(Gate.phoneReadiness({ ...off, swrTripped: true }).reason, 'swr');
  assert.strictEqual(Gate.phoneReadiness({ ...off, otherTx: 'SSTV' }).sentence, 'SSTV is transmitting.');
  assert.strictEqual(Gate.phoneReadiness({ ...off, modemFound: false }).reason, 'no-modem');
  assert.strictEqual(Gate.phoneReadiness({ ...off, remote: true }).reason, 'remote');
  assert.strictEqual(Gate.phoneReadiness({ ...off, aprsHz: 0 }).reason, 'no-freq');
  assert.strictEqual(Gate.phoneReadiness({ ...LIVE, inFlight: true }).reason, 'busy');
  assert.strictEqual(Gate.phoneReadiness({ ...LIVE, dialHz: 144000000 }).reason, 'dial', 'listening: the full window check');
});

test('the key-down gate still holds with the phone as the asker', () => {
  assert.deepStrictEqual(Gate.mayKey({ ...LIVE, inFlight: true, radioOwner: 'aprs' }), { ok: true });
  assert.strictEqual(Gate.mayKey({ ...LIVE, askedFrom: 'window', inFlight: true, radioOwner: 'aprs' }).reason, 'window');
});

test('aprs-echocat: parses the request, owner only, and the state carries beacon.rf', () => {
  assert.deepStrictEqual(Echo.parseRequest({ type: 'aprs-beacon-rf', band: '30m' }), { type: 'aprs-beacon-rf', band: '30m' });
  assert.deepStrictEqual(Echo.parseRequest({ type: 'aprs-beacon-rf', band: '6m' }), { type: 'aprs-beacon-rf', band: '' });
  assert.ok(Echo.GUEST_REFUSED.has('aprs-beacon-rf'));
  const calls = [];
  const t = { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };
  const c = Echo.createController({ beaconRf: (r) => calls.push(r), timers: t });
  assert.strictEqual(c.handle('g1', { type: 'aprs-beacon-rf', band: '' }, { guest: true }), false, 'a guest is refused');
  assert.strictEqual(c.handle('o1', { type: 'aprs-beacon-rf', band: '2m' }, { guest: false }), true);
  assert.deepStrictEqual(calls, [{ clientId: 'o1', band: '2m' }]);
  const st = Echo.buildState({ beacon: { rf: { ready: true, band: '2m', mhz: '144.390', modeLabel: 'FM', powerW: 50, airSeconds: 1.2, lastResult: 'confirmed', junk: 1 } } });
  assert.deepStrictEqual(Object.keys(st.beacon.rf).sort(), ['airSeconds', 'band', 'lastAt', 'lastResult', 'lastSentence', 'mhz', 'modeLabel', 'powerW', 'ready', 'sending', 'sentence', 'setup']);
  assert.strictEqual(st.beacon.rf.powerW, 50);
  assert.strictEqual(Echo.buildState({}).beacon.rf, null);
});

test('remote-server: routes it, mayBeaconRf only for an owner with rf ready, refusals to one device', () => {
  const src = read('lib/remote-server.js');
  assert.ok(/case 'aprs-beacon-is':\r?\n\s*case 'aprs-beacon-rf': \{/.test(src));
  const rs = new RemoteServer();
  const sent = [];
  rs._sendTo = (ws, m) => sent.push([ws.tag, m]);
  rs._hasCap = () => true;
  const owner = { tag: 'owner' }, guest = { tag: 'guest', _passSession: {} };
  rs._openClients = () => [owner, guest];
  rs._scopeClientId = (ws) => ws.tag;
  rs.broadcastAprsState({ beacon: { rf: { ready: true } } });
  assert.deepStrictEqual(sent.map(([t, m]) => [t, m.mayBeaconRf]), [['owner', true], ['guest', false]]);
  sent.length = 0;
  rs.broadcastAprsState({ beacon: { rf: { ready: false } } });
  assert.strictEqual(sent[0][1].mayBeaconRf, false);
  sent.length = 0;
  assert.strictEqual(rs.sendAprsTo('owner', { type: 'refused', of: 'aprs-beacon-rf', reason: 'busy', text: 'x' }), 1);
  assert.deepStrictEqual(sent.map(([t]) => t), ['owner']);
});

test('the guest wall and the protocol registry know it', () => {
  assert.ok(/'aprs-beacon-is', 'aprs-igate', 'aprs-beacon-rf',/.test(read('lib/guest-pass-authority.js')));
  assert.ok(/callsign: \['aprs-beacon-is', 'aprs-igate', 'aprs-beacon-rf'\]/.test(read('lib/pass-wording.js')));
  const p = read('lib/echocat-protocol.js');
  assert.ok(/'aprs-beacon-rf': \{ dir: Dir\.C2S, feature: 'aprs', fields: \{ band: f\.optString \} \}/.test(p));
  assert.ok(/mayBeaconRf: f\.optBoolean/.test(p));
});

test('main: the press counts as the window, sets up and puts back, refuses to that device only', () => {
  const m = read('main.js');
  assert.ok(/askedFrom: _aprsRfPhoneAsk \? 'phone' : 'window',/.test(m));
  const at = m.indexOf('async function aprsRfSendFromPhone(');
  const fn = m.slice(at, m.indexOf('\n}\n', at));
  assert.ok(/if \(!aprsListen\.on\) \{[\s\S]*aprsListenSet\(true\);[\s\S]*aprsRfPhoneWaitListening\(\)/.test(fn), 'Listen off: set up first');
  assert.ok(/await aprsRfSend\(\);/.test(fn), 'the window run');
  assert.ok(/finally \{\s*_aprsRfPhoneAsk = false;\s*if \(startedListen\) aprsListenSet\(false\);/.test(fn), 'the radio goes back on every way out');
  assert.ok(/remoteServer\.sendAprsTo\(clientId, \{ type: 'refused', of: 'aprs-beacon-rf', reason, text \}\)/.test(fn));
  assert.ok(/rf: aprsRfPhoneState\(\),/.test(m), 'aprs-state.beacon.rf');
  assert.ok(/aprsRfUi\.lastResult = res\.ok \? \(res\.confirmed \? 'confirmed' : 'unconfirmed'\) : 'not-sent';/.test(m));
  assert.ok(/beaconRf: \(req\) => aprsRfSendFromPhone\(req\)/.test(m));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
