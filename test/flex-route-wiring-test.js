#!/usr/bin/env node
'use strict';
/**
 * The route choice on a Flex, wired: lib/smartsdr.js holds still while the
 * radio is ECHOCAT's and never rides along with the mobile device while taking
 * it back; lib/remote-server.js answers flex-release / flex-reclaim, sends
 * flex-route after auth-ok and on a change, lists flex-handback only when main
 * says so, and refuses rig commands while released; main.js gates every
 * reconnect path and keeps the release order (stop, restore, then close).
 *
 * Run: node test/flex-route-wiring-test.js
 */
require('./ws-stub-if-missing');
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { SmartSdrClient } = require('../lib/smartsdr');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');
const FR = require('../lib/flex-route');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const rsSrc = readSrc(path.join(root, 'lib', 'remote-server.js'));

/** The body of `function name(` in main.js, up to the next top-level function. */
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} not found`);
  const j = src.indexOf('\nfunction ', i + 10);
  const k = src.indexOf('\nasync function ', i + 10);
  const end = Math.min(j < 0 ? src.length : j, k < 0 ? src.length : k);
  return src.slice(i, end);
}

console.log('SmartSdrClient: held for ECHOCAT');

test('a held client does not connect, reconnect, probe or self-host', () => {
  const c = new SmartSdrClient();
  let dials = 0;
  c._doConnect = () => { dials++; };
  c.setRouteHold(true);
  c.connect('192.168.1.60');
  assert.strictEqual(dials, 0, 'connect() refused');
  c._host = '192.168.1.60';
  c._scheduleReconnect();
  assert.strictEqual(c._reconnectTimer, null);
  assert.strictEqual(c._probeTimer, null);
  c.connected = true;
  const sent = [];
  c._send = (cmd) => { sent.push(cmd); return 1; };
  c._promoteOrBind();
  assert.deepStrictEqual(sent, [], 'no client gui while held');
  assert.strictEqual(c.mode, 'none');
  c.setRouteHold(false);
  c.connect('192.168.1.60');
  assert.strictEqual(dials, 1, 'released from the hold, it connects again');
  c.disconnect();
});
test('a held client does not chase a bound host that left', () => {
  const c = new SmartSdrClient();
  c._guiMode = 'bound';
  c._guiClientHandle = '4E1DDC50';
  let left = 0;
  c.on('gui-client-left', () => left++);
  c.setRouteHold(true);
  c._parseStatusMessage('S1|client 0x4E1DDC50 disconnected');
  assert.strictEqual(left, 0);
  c.setRouteHold(false);
  c._parseStatusMessage('S1|client 0x4E1DDC50 disconnected');
  assert.strictEqual(left, 1);
});

console.log('SmartSdrClient: taking the radio back');

function reclaimer(external) {
  const c = new SmartSdrClient();
  c.connected = true;
  c.setPersistentId('11111111-2222-3333-4444-555555555555');
  c._discoveredGuiClients = external ? ['PHONE-SMARTLINK-ID'] : [];
  const sent = [];
  c._send = (cmd) => { sent.push(cmd); return 7; };
  return { c, sent };
}
test('reclaiming asks for our own slot even with the mobile device on the radio', () => {
  const { c, sent } = reclaimer(true);
  c.setReclaimOnly(true);
  c._promoteOrBind();
  assert.ok(sent.includes('client gui 11111111-2222-3333-4444-555555555555'), sent.join(' / '));
  assert.strictEqual(c.mode, 'self');
});
test('without the reclaim flag the same radio is ridden along with (today\'s behaviour, unchanged)', () => {
  const { c, sent } = reclaimer(true);
  c.setMultiflex(false);
  c._promoteOrBind();
  assert.ok(!sent.some((s) => s.startsWith('client gui')));
  assert.strictEqual(c.mode, 'bound');
});
test('F3000001 while reclaiming is reported, never turned into bound mode', () => {
  const { c } = reclaimer(true);
  c.setReclaimOnly(true);
  c._promoteOrBind();
  const got = [];
  let bound = 0;
  c.on('gui-rejected', (e) => got.push(e));
  c.on('gui-mode', (m) => { if (m === 'bound') bound++; });
  c._handleLine('R7|F3000001|The maximum number of connected clients has been reached');
  assert.deepStrictEqual(got, [{ status: 0xF3000001 }]);
  assert.strictEqual(bound, 0);
  assert.strictEqual(c.mode, 'none');
});
test('an accepted client gui while reclaiming is gui-ready as always', () => {
  const { c } = reclaimer(false);
  c.setReclaimOnly(true);
  c._promoteOrBind();
  let ready = null;
  c.on('gui-ready', (e) => { ready = e; });
  c._armSelfSlice = () => {};
  c._handleLine('R7|0|11111111-2222-3333-4444-555555555555');
  assert.deepStrictEqual(ready, { clientId: '11111111-2222-3333-4444-555555555555' });
  assert.strictEqual(c.guiReady, true);
});

console.log('RemoteServer');

function rig() {
  const rs = new RemoteServer();
  const out = [];
  const ws = { _authenticated: true, readyState: 1, send: (s) => out.push(JSON.parse(s)) };
  rs._client = ws;
  return { rs, ws, out, send: (m) => rs._handleMessage(ws, m, {}) };
}
test('flex-release goes to main with the device and its reason; the answer is flex-released', () => {
  const { rs, out, send } = rig();
  const seen = [];
  rs.on('flex-release', (req, reply) => { seen.push(req); reply({ ok: false, error: FR.TEXT.guest }); });
  send({ type: 'flex-release', reason: 'Use FlexRadio SmartLink' });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].reason, 'Use FlexRadio SmartLink');
  assert.ok(typeof seen[0].device === 'string');
  const ans = out.filter((m) => m.type === 'flex-released');
  assert.deepStrictEqual(ans, [{ type: 'flex-released', ok: false, error: 'A guest has the radio.' }]);
  assert.ok(protocol.validate(ans[0], protocol.Dir.S2C).ok);
});
test('flex-reclaim answers flex-reclaimed; ok carries no error', () => {
  const { rs, out, send } = rig();
  rs.on('flex-reclaim', (_req, reply) => reply({ ok: true }));
  send({ type: 'flex-reclaim' });
  assert.deepStrictEqual(out.filter((m) => m.type === 'flex-reclaimed'), [{ type: 'flex-reclaimed', ok: true }]);
});
test('while released, a tune is refused in one sentence and never reaches main', () => {
  const { rs, out, send } = rig();
  let tunes = 0;
  rs.on('tune', () => tunes++);
  rs.setFlexRoute({ state: 'released', since: 1, holder: 'Pixel' });
  send({ type: 'tune', freqKhz: 14074 });
  assert.strictEqual(tunes, 0);
  const r = out.filter((m) => m.type === 'refused');
  assert.deepStrictEqual(r, [{ type: 'refused', reason: 'flex-released', of: 'tune', text: 'The radio is on FlexRadio SmartLink with your mobile device.' }]);
  assert.ok(protocol.validate(r[0], protocol.Dir.S2C).ok);
});
test('while released, logging still works and an estop still goes through', () => {
  const { rs, send } = rig();
  let logs = 0, ptts = 0;
  rs.on('log-qso', () => logs++);
  rs.setFlexRoute({ state: 'released', since: 1 });
  rs._handlePtt = () => { ptts++; };
  send({ type: 'log-qso', data: { callsign: 'K3SBP', frequency: '14074', mode: 'FT8' } });
  send({ type: 'estop' });
  assert.strictEqual(logs, 1, 'log-qso reached main');
  assert.strictEqual(ptts, 1);
});
test('back to pc: rig commands flow again', () => {
  const { rs, send } = rig();
  let tunes = 0;
  rs.on('tune', () => tunes++);
  rs.setFlexRoute({ state: 'released', since: 1 });
  rs.setFlexRoute({ state: 'pc', since: 2 });
  send({ type: 'tune', freqKhz: 7074 });
  assert.strictEqual(tunes, 1);
});
test('flex-route goes to owner devices on a change (not to a guest), once per change', () => {
  const { rs, out } = rig();
  const guestOut = [];
  const guest = { _authenticated: true, readyState: 1, _passSession: {}, send: (s) => guestOut.push(JSON.parse(s)) };
  rs._clients.add(guest);
  rs.setFlexRoute({ state: 'releasing', since: 5, holder: 'Pixel' });
  rs.setFlexRoute({ state: 'releasing', since: 5, holder: 'Pixel' });
  const sent = out.filter((m) => m.type === 'flex-route');
  assert.deepStrictEqual(sent, [{ type: 'flex-route', state: 'releasing', since: 5, holder: 'Pixel' }]);
  assert.ok(protocol.validate(sent[0], protocol.Dir.S2C).ok);
  assert.strictEqual(guestOut.filter((m) => m.type === 'flex-route').length, 0);
});
test('flex-route is sent at hydrate (after auth-ok) when the shack has the route', () => {
  const { rs, ws, out } = rig();
  rs.setFlexRoute({ state: 'released', since: 9 });
  out.length = 0;
  rs._hydrateClient(ws);
  assert.strictEqual(out[0].type, 'flex-route');
  assert.strictEqual(out[0].state, 'released');
});
test('the capability is conditional on main', () => {
  assert.ok(rsSrc.includes('this._sendTo(ws, this._withFlexHandback(protocol.buildServerHello({'));
  const rs = new RemoteServer();
  assert.deepStrictEqual(rs._withFlexHandback({ capabilities: ['a'] }).capabilities, ['a']);
  rs.setFlexHandback(true);
  assert.deepStrictEqual(rs._withFlexHandback({ capabilities: ['a'] }).capabilities, ['a', 'flex-handback']);
  rs.setFlexHandback(false);
  assert.strictEqual(rs._flexHandback, false, 'off until main says Flex Direct');
  rs.setFlexHandback(true);
  assert.strictEqual(rs._flexHandback, true);
});
test('a Guest Pass may not move the radio', () => {
  const { isGuestAllowed } = require('../lib/guest-pass-authority');
  assert.strictEqual(isGuestAllowed('flex-release'), false);
  assert.strictEqual(isGuestAllowed('flex-reclaim'), false);
});

console.log('main.js');

test('connectSmartSdr is the one gate: held, it only starts the watch', () => {
  const b = fnBody(main, 'connectSmartSdr');
  const gate = b.indexOf("if (detectRigType() === 'flex' && flexRouteHeld()) { flexRouteStartWatch(); return; }");
  assert.ok(gate > 0, 'gate present');
  assert.ok(gate < b.indexOf('smartSdr = new SmartSdrClient()'), 'gate before any client exists');
  assert.ok(/smartSdr\.setReclaimOnly\(flexRouteState\(\)\.state === 'reclaiming'\)/.test(b));
});
test('the other reconnect paths are held too', () => {
  assert.ok(/function reclaimFlexRadio\(reason\) \{\n  if \(flexRouteHeld\(\)\) return;/.test(main));
  assert.ok(/_lastCatUpForHandoff = catUp;\n  if \(flexRouteHeld\(\)\) return;/.test(main));
});
test('release order: refuse/ask, stop automation, restore TX source, wait, hold, close GUI + audio, persist, watch', () => {
  const b = fnBody(main, 'flexRouteRelease');
  const order = ['FlexRouteLib.decideRelease(', 'flexRouteAskDesk(', 'fr.beginRelease(', 'flexRouteStopAutomation()',
    'restoreFlexTxDax()', 'await sleepMs(', 'smartSdr.setRouteHold(true)', 'disconnectSmartSdr()',
    'fr.finishRelease(true)', 'flexRoutePersist()', 'flexRouteStartWatch()'];
  let at = -1;
  for (const k of order) {
    const i = b.indexOf(k, at + 1);
    assert.ok(i > at, `${k} out of order or missing`);
    at = i;
  }
  assert.ok(!/setSliceAudioLevel|audio_level/.test(b.replace(/\/\/.*$/gm, '')), 'the slice audio_level is never touched on release');
});
test('disconnectSmartSdr closes the audio client too (DAX goes with the GUI client)', () => {
  assert.ok(/stopSmartSdrAudio\(\);\n\}/.test(fnBody(main, 'disconnectSmartSdr')));
});
test('reclaim: client gui, retried on refusal, then DAX comes back through gui-ready', () => {
  const b = fnBody(main, 'flexRouteReclaim');
  assert.ok(b.includes('fr.beginReclaim()') && b.includes('flexRouteTryGui()') && b.includes('FlexRouteLib.reclaimNext('));
  assert.ok(b.includes('flexRouteStopWatch()'));
  const tg = fnBody(main, 'flexRouteTryGui');
  assert.ok(tg.includes("'gui-ready'") && tg.includes("'gui-rejected'"));
  assert.ok(/smartSdr\.on\('gui-ready', \(\{ clientId \}\) => \{[\s\S]*?startSmartSdrAudio\(\);[\s\S]*?flexRoutePublish\(\);/.test(main));
});
test('the flex-release / flex-reclaim listeners are attached inside onRemoteServer', () => {
  assert.ok(/onRemoteServer\(\(rs\) => \{\n  rs\.on\('flex-release',[\s\S]*?rs\.on\('flex-reclaim',/.test(main));
  assert.ok(!/remoteServer\.on\('flex-(release|reclaim)'/.test(main));
});
test('the 60 s rule runs on a timer while released and logs why', () => {
  const b = fnBody(main, 'flexRouteTick');
  assert.ok(b.includes('fr.autoReclaimDue()') && b.includes('no GUI client for 60 s'));
});
test('a window never writes flexRoute back (one writer)', () => {
  assert.ok(/delete newSettings\.flexRoute;/.test(main));
});
test('the transmitting check covers every key-down source', () => {
  const b = fnBody(main, 'flexRouteTransmitting');
  for (const k of ['_isEffectivelyTransmitting()', 'cat._transmitting', 'jtcatAnyTxActive()', 'jtcatTuneState.active', '_externalAtuActive', 'interlockState']) {
    assert.ok(b.includes(k), k);
  }
});
test('the watch is stopped on quit', () => {
  assert.ok(/try \{ disconnectSmartSdr\(\); \} catch \{\}\n  try \{ flexRouteStopWatch\(\); \} catch \{\}/.test(main));
});
test('the banner loads in the main window and the VFO window, warns in-window, never confirm()', () => {
  const idx = readSrc(path.join(root, 'renderer', 'index.html'));
  const vfo = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
  for (const h of [idx, vfo]) {
    assert.ok(h.includes('flex-route-banner.js') && h.includes('flex-route-banner.css'));
  }
  const js = readSrc(path.join(root, 'renderer', 'flex-route-banner.js'));
  assert.ok(!/\bconfirm\(|\balert\(|innerHTML/.test(js), 'no browser dialog, no innerHTML');
  const css = readSrc(path.join(root, 'renderer', 'flex-route-banner.css'));
  const colours = css.replace(/var\(--ds-[a-z-]+,\s*[^)]*\)/g, '').match(/#[0-9a-f]{3,6}\b|rgba?\(/gi);
  assert.strictEqual(colours, null, 'every colour is a theme token (fallbacks inside var() only)');
  for (const p of ['preload.js', 'preload-vfo-popout.js']) {
    const s = readSrc(path.join(root, p));
    for (const k of ['onFlexRoute', 'onFlexRouteAsk', 'onFlexRouteAskDone', 'flexRouteGet', 'flexRouteTakeBack', 'flexRouteAnswer']) assert.ok(s.includes(k + ':'), `${p} ${k}`);
  }
});
test('a handover is not reported as a lost radio link (no "check the USB" alarm)', () => {
  const i = main.indexOf('if (!linkUp && flexRouteHeld())');
  assert.ok(i > 0, 'the handover branch comes first');
  const j = main.indexOf('} else if (!linkUp) {', i);
  assert.ok(j > i, 'the lost-link alarm is the else branch');
  assert.ok(!main.slice(i, j).includes('app-notice'), 'no notice on a handover');
});
test('the wire is documented', () => {
  const doc = readSrc(path.join(root, 'docs', 'echocat-protocol.md'));
  for (const t of ['flex-release', 'flex-released', 'flex-reclaim', 'flex-reclaimed', 'flex-route', 'flex-handback']) {
    assert.ok(doc.includes('`' + t + '`'), t);
  }
  for (const t of ['flex-release', 'flex-released', 'flex-reclaim', 'flex-reclaimed', 'flex-route']) assert.ok(protocol.MESSAGES[t], t);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
