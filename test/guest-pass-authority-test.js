#!/usr/bin/env node
'use strict';
// A Guest Pass is default-deny (adversarial review of 1.13.9, 2026-11-03;
// potacat-meta work/in-progress/guest-pass-authority-fixes.md, part A).
//   - lib/guest-pass-authority.js: the pure sets; every demux case label is in
//     exactly ONE of allowed / denied, every rig-control action likewise
//   - the demux: a guest's denied type is answered with `refused` and never
//     emitted; an allowed type is emitted; rig-control carries {guest}
//   - cloud-login / cloud-register never reach cloudBridge for a guest even
//     with the wall removed (their own refusal inside the case)
//   - main.js: the dispatcher refuses raw CAT a second time on meta.guest
//   - the web client shows `refused` instead of a dead control
// Run: node test/guest-pass-authority-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const A = require('../lib/guest-pass-authority');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const root = path.join(__dirname, '..');
const rsSrc = fs.readFileSync(path.join(root, 'lib', 'remote-server.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const webSrc = fs.readFileSync(path.join(root, 'renderer', 'remote.js'), 'utf8');

// Every `case '<type>':` label of the C2S demux (switch (msg.type) … the
// Guest Pass auth section that follows the handler).
function demuxCases() {
  const start = rsSrc.indexOf('switch (msg.type) {');
  const end = rsSrc.indexOf('setPassValidator(fn)', start);
  assert.ok(start > 0 && end > start, 'demux located');
  const body = rsSrc.slice(start, end);
  const out = new Set();
  for (const m of body.matchAll(/^      case '([^']+)':/gm)) out.add(m[1]);
  return out;
}
// Every `case '<action>':` of applyRigControl in main.js.
function dispatcherActions() {
  const start = mainSrc.indexOf('applyRigControl = function (data, source');
  const end = mainSrc.indexOf('\n  };', start);
  assert.ok(start > 0 && end > start, 'applyRigControl located');
  const body = mainSrc.slice(start, end);
  const out = new Set();
  for (const m of body.matchAll(/^      case '([^']+)':/gm)) out.add(m[1]);
  return out;
}

console.log('the sets');
test('every demux message type is classified exactly once (allowed or denied)', () => {
  const cases = demuxCases();
  assert.ok(cases.size > 200, 'found the demux (' + cases.size + ' cases)');
  const neither = [...cases].filter(t => !A.GUEST_TYPES.has(t) && !A.GUEST_DENIED_TYPES.has(t));
  assert.deepStrictEqual(neither, [], 'unclassified: ' + neither.join(', ') + ' — decide, in lib/guest-pass-authority.js');
  const both = [...A.GUEST_TYPES].filter(t => A.GUEST_DENIED_TYPES.has(t));
  assert.deepStrictEqual(both, [], 'in both sets: ' + both.join(', '));
  const stale = [...A.GUEST_TYPES, ...A.GUEST_DENIED_TYPES].filter(t => !cases.has(t));
  assert.deepStrictEqual(stale, [], 'not a demux case: ' + stale.join(', '));
});
test('every rig-control action is classified exactly once', () => {
  const actions = dispatcherActions();
  assert.ok(actions.size > 40, 'found the dispatcher (' + actions.size + ' actions)');
  const neither = [...actions].filter(a => !A.GUEST_RIG_ACTIONS.has(a) && !A.GUEST_DENIED_RIG_ACTIONS.has(a));
  assert.deepStrictEqual(neither, [], 'unclassified: ' + neither.join(', '));
  const both = [...A.GUEST_RIG_ACTIONS].filter(a => A.GUEST_DENIED_RIG_ACTIONS.has(a));
  assert.deepStrictEqual(both, [], 'in both: ' + both.join(', '));
  const stale = [...A.GUEST_RIG_ACTIONS, ...A.GUEST_DENIED_RIG_ACTIONS].filter(a => !actions.has(a));
  assert.deepStrictEqual(stale, [], 'not a dispatcher case: ' + stale.join(', '));
});
test('what the pass promises stays allowed: operate the station', () => {
  for (const t of ['tune', 'ptt', 'estop', 'set-mode', 'set-filter', 'set-txpower', 'set-tx-drive', 'set-rx-level',
    'log-qso', 'lookup-call', 'qrz-lookup', 'typed-call', 'search-parks', 'hide-spot', 'set-sources', 'set-echo-filters',
    'jtcat-start', 'jtcat-call-cq', 'jtcat-reply', 'jtcat-enable-tx', 'jtcat-halt-tx', 'jtcat-set-mode', 'jtcat-log-qso',
    'js8-start', 'js8-send', 'js8-thread-open', 'sstv-open', 'sstv-photo', 'sstv-get-gallery',
    'scope-subscribe', 'scope-span', 'paddle', 'cw-text', 'cw-key', 'voice-macro-play', 'freedv-start', 'freedv-set-tx',
    'signal', 'restart-audio', 'get-audio-devices', 'ping', 'rig-control', 'tx-eq-set', 'scan-control']) {
    assert.ok(A.isGuestAllowed(t), t + ' must be allowed');
  }
});
test('what the pass does not confer is denied: the owner\'s log, accounts, settings, station', () => {
  for (const t of ['get-all-qsos', 'update-qso', 'delete-qso', 'award-table-get', 'get-past-activations',
    'cloud-login', 'cloud-register', 'cloud-logout', 'cloud-sync-now', 'cloud-bulk-upload', 'cloud-stripe-checkout',
    'save-settings', 'save-custom-cat-buttons', 'save-cw-macros', 'save-echo-pref', 'watchlist-edit', 'set-cluster-node',
    'switch-rig', 'rig-reconnect', 'unpair-self', 'set-audio-device', 'set-atu', 'atu-tune', 'swr-guard-override',
    'set-enable-split', 'set-enable-atu', 'apply-rig-preset', 'rig-presets-update', 'vfo-profiles-update',
    'winlink-list', 'winlink-compose', 'winlink-connect', 'kiwi-connect', 'kiwi-tune', 'set-freedv',
    'voice-macro-sync', 'voice-macro-delete', 'request-diagnostic', 'clock-apply', 'set-activator-park', 'jtcat-set-pref']) {
    assert.strictEqual(A.isGuestAllowed(t), false, t + ' must be denied');
  }
  assert.strictEqual(A.isGuestAllowed('no-such-type'), false, 'unknown = denied');
  assert.strictEqual(A.isGuestAllowed(undefined), false);
  assert.strictEqual(A.isGuestAllowed(null), false);
});
test('rig-control: receiver, levels and the VFO yes; raw CAT, split, the other VFO, power, the tuner no', () => {
  for (const a of ['get-state', 'set-tx-power', 'set-vfo', 'swap-vfo', 'set-filter-width', 'set-preamp', 'set-att', 'set-nb',
    'set-nr', 'set-nr-level', 'set-anf', 'set-apf', 'set-nrl', 'set-nrl-level', 'set-nrs-level', 'set-rnn', 'set-nrf-level',
    'set-wnb', 'set-wnb-level', 'set-agc', 'set-rf-gain', 'set-rf-gain-db', 'set-af-gain', 'set-squelch', 'set-comp',
    'set-comp-level', 'set-vox', 'set-vox-level', 'set-mon', 'set-mon-level', 'set-rit', 'set-clar-rx', 'set-clar-tx',
    'set-clar-offset', 'set-mic-gain', 'set-dnr-level', 'set-break-in', 'set-break-in-delay', 'set-cw-sidetone']) {
    assert.ok(A.isGuestRigAction(a), a + ' must be allowed');
  }
  for (const a of ['send-custom-cat', 'set-split', 'set-freq-other', 'power-on', 'power-off', 'atu-tune', 'set-antenna-port', 'set-preamp-target', 'no-such', undefined]) {
    assert.strictEqual(A.isGuestRigAction(a), false, String(a) + ' must be denied');
  }
});

// ── the demux with a fake socket ──────────────────────────────────────
function fakeWs({ guest } = {}) {
  const ws = { readyState: WebSocket.OPEN, _authenticated: true, sent: [], _socket: { remoteAddress: '127.0.0.1' } };
  ws.send = (wire) => ws.sent.push(JSON.parse(wire));
  ws.close = () => { ws.readyState = WebSocket.CLOSED; };
  if (guest) ws._passSession = { code: 'otter-newt-mosaic-rooster', sessionId: 'x'.repeat(64) };
  return ws;
}
function serverWith(ws) {
  const rs = new RemoteServer();
  rs._client = ws;
  rs._clients.add(ws);
  rs.emitted = [];
  rs.logs = [];
  const emit = rs.emit.bind(rs);
  rs.emit = (ev, ...args) => { if (ev === 'log') rs.logs.push(args[0]); else rs.emitted.push({ ev, args }); return emit(ev, ...args); };
  return rs;
}

console.log('\nthe demux');
test('a guest\'s denied type is refused out loud and never emitted', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'get-all-qsos', reqId: 'r1' }, null);
  rs._handleMessage(ws, { type: 'cloud-sync-now' }, null);
  rs._handleMessage(ws, { type: 'save-settings', settings: { myCallsign: 'EVIL' } }, null);
  assert.deepStrictEqual(rs.emitted.map(e => e.ev), [], 'nothing emitted');
  assert.strictEqual(ws.sent.length, 3);
  assert.deepStrictEqual(ws.sent[0], { type: 'refused', reason: 'guest-pass', of: 'get-all-qsos', text: A.guestRefusedText('get-all-qsos'), reqId: 'r1' });
  assert.strictEqual(ws.sent[1].of, 'cloud-sync-now');
  assert.strictEqual(ws.sent[1].reqId, undefined, 'no reqId when the request carried none');
  assert.ok(protocol.validate(ws.sent[0], protocol.Dir.S2C).ok, 'refused is a registered S2C message');
  assert.deepStrictEqual(rs.logs.filter(l => /Guest Pass: .* refused/.test(l)).length, 3);
});
test('the log is rate-limited per type per socket; the device is told every time', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  for (let i = 0; i < 5; i++) rs._handleMessage(ws, { type: 'get-all-qsos' }, null);
  assert.strictEqual(ws.sent.length, 5);
  assert.strictEqual(rs.logs.filter(l => l === 'Guest Pass: get-all-qsos refused').length, 1);
});
test('a guest\'s allowed type is emitted as before', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'set-mode', mode: 'USB' }, null);
  rs._handleMessage(ws, { type: 'set-sources', sources: { pota: true } }, null);
  assert.deepStrictEqual(rs.emitted.map(e => e.ev), ['set-mode', 'set-sources']);
  assert.deepStrictEqual(ws.sent.filter(m => m.type === 'refused'), []);
});
test('the owner is untouched: a denied-for-guests type is emitted for an owner socket', () => {
  const ws = fakeWs();
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'set-mode', mode: 'USB' }, null);
  rs._handleMessage(ws, { type: 'set-refresh-interval', value: 60 }, null);
  rs._handleMessage(ws, { type: 'rig-control', data: { action: 'send-custom-cat', command: 'FA;' } }, null);
  assert.deepStrictEqual(rs.emitted.map(e => e.ev), ['set-mode', 'set-refresh-interval', 'rig-control']);
  assert.deepStrictEqual(rs.emitted[2].args[1], { guest: false });
  assert.deepStrictEqual(ws.sent.filter(m => m.type === 'refused'), []);
});
test('rig-control: a guest\'s raw CAT / split / other VFO / power are refused, the receiver controls go through with guest:true', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'rig-control', data: { action: 'send-custom-cat', command: 'TX1;' }, reqId: 'c1' }, null);
  rs._handleMessage(ws, { type: 'rig-control', action: 'set-split', value: true }, null);           // top-level shape too
  rs._handleMessage(ws, { type: 'rig-control', data: { action: 'set-freq-other', hz: 14200000 } }, null);
  rs._handleMessage(ws, { type: 'rig-control', data: { action: 'power-off' } }, null);
  rs._handleMessage(ws, { type: 'rig-control', data: { action: 'atu-tune' } }, null);
  assert.deepStrictEqual(rs.emitted, [], 'none reached main');
  assert.deepStrictEqual(ws.sent.map(m => m.of), ['rig-control:send-custom-cat', 'rig-control:set-split', 'rig-control:set-freq-other', 'rig-control:power-off', 'rig-control:atu-tune']);
  assert.strictEqual(ws.sent[0].reqId, 'c1');
  rs._handleMessage(ws, { type: 'rig-control', data: { action: 'set-agc', value: 'fast' } }, null);
  rs._handleMessage(ws, { type: 'rig-control', data: { action: 'set-tx-power', value: 100 } }, null);
  assert.strictEqual(rs.emitted.length, 2);
  assert.deepStrictEqual(rs.emitted[0].args, [{ action: 'set-agc', value: 'fast' }, { guest: true }]);
  assert.deepStrictEqual(rs.emitted[1].args[1], { guest: true });
});
test('the WS-level atu-tune type (which emits rig-control atu-tune) is refused to a guest too', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'atu-tune' }, null);
  rs._handleMessage(ws, { type: 'set-atu', on: true }, null);
  assert.deepStrictEqual(rs.emitted, []);
  assert.deepStrictEqual(ws.sent.map(m => m.of), ['atu-tune', 'set-atu']);
});
test('cloud-login / cloud-register refuse inside the case as well — a guest never reaches cloudBridge', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  // Bypass the wall on purpose: call the cases as a refactor that dropped it would.
  const real = A.isGuestAllowed;
  const seen = [];
  rs.on('cloud-login', (m) => seen.push('login'));
  rs.on('cloud-register', (m) => seen.push('register'));
  // With the wall
  rs._handleMessage(ws, { type: 'cloud-login', email: 'a@b.c', password: 'x' }, null);
  assert.deepStrictEqual(seen, []);
  // Without the wall: the case's own refusal
  const i = rsSrc.indexOf("case 'cloud-login':");
  const block = rsSrc.slice(i, rsSrc.indexOf("case 'cloud-logout':", i));
  assert.ok(/case 'cloud-login':\s*\n\s*if \(ws\._passSession\) \{ this\._sendTo\(ws, \{ type: 'cloud-login-result', error: 'guest_pass' \}\);/.test(block), 'cloud-login refuses a guest itself');
  assert.ok(/case 'cloud-register':\s*\n\s*if \(ws\._passSession\) \{ this\._sendTo\(ws, \{ type: 'cloud-register-result', error: 'guest_pass' \}\);/.test(block), 'cloud-register refuses a guest itself');
  assert.strictEqual(real, A.isGuestAllowed);
});
test('the wall sits between admission and the switch, once', () => {
  const i = rsSrc.indexOf("if (!ws._authenticated || !(ws === this._client || this._clients.has(ws))) return;");
  const j = rsSrc.indexOf('switch (msg.type) {', i);
  const between = rsSrc.slice(i, j);
  assert.ok(/if \(ws\._passSession && !isGuestAllowed\(msg\.type\)\) \{ this\._guestRefuse\(ws, msg\.type, msg\.reqId\); return; \}/.test(between), 'the one wall');
  assert.strictEqual((rsSrc.match(/!isGuestAllowed\(msg\.type\)/g) || []).length, 1);
  assert.ok(/if \(ws\._passSession && !isGuestRigAction\(payload\.action\)\) \{ this\._guestRefuse\(ws, 'rig-control:' \+ payload\.action, msg\.reqId\); break; \}/.test(rsSrc), 'the rig-control action wall');
  assert.ok(/this\.emit\('rig-control', payload, \{ guest: !!ws\._passSession \}\);/.test(rsSrc), 'rig-control carries the guest flag');
});

console.log('\nmain.js and the web client');
test('main.js hands the guest flag to the one dispatcher, which refuses raw CAT again', () => {
  assert.ok(/remoteServer\.on\('rig-control', \(data, meta\) => applyRigControl\(data, 'echocat', meta\)\);/.test(mainSrc), 'wiring passes meta');
  assert.ok(/applyRigControl = function \(data, source = 'desktop', meta = null\) \{/.test(mainSrc), 'dispatcher takes meta');
  const i = mainSrc.indexOf("case 'send-custom-cat': {");
  const block = mainSrc.slice(i, mainSrc.indexOf('\n      case ', i + 10));
  assert.ok(/if \(meta && meta\.guest\) \{ sendCatLog\('\[pass\] raw CAT refused for a guest'\); break; \}/.test(block), 'second layer in send-custom-cat');
  assert.ok(block.indexOf('meta.guest') < block.indexOf('cat.sendRaw(cmd)'), 'refused before the send');
});
test('the web client shows a refusal instead of a dead control', () => {
  assert.ok(/case 'refused':\s*\n\s*showToast\(msg\.text \|\|/.test(webSrc));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
