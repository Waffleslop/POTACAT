#!/usr/bin/env node
'use strict';
// Desktop-to-desktop Phase B: the JTCAT pop-out drives the SHACK's FT8 engine
// through lib/remote-bridge.js. The table is the whole contract; this test
// keeps it complete (every pop-out channel mapped or deliberately local),
// honest (every wire type is in the registry) and behaving.
// Run: node test/remote-bridge-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('../lib/remote-bridge');
const { MESSAGES } = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const preload = R('preload-jtcat-popout.js');
const main = R('main.js');
const popout = R('renderer/jtcat-popout.js');
const outgoing = [...new Set([...preload.matchAll(/ipcRenderer\.(?:send|invoke)\('([a-z0-9:-]+)'/g)].map(m => m[1]))];
const incoming = new Set([...preload.matchAll(/ipcRenderer\.on\('([a-z0-9:-]+)'/g)].map(m => m[1]));
const js8Preload = R('preload-js8call-popout.js');
const js8Out = [...new Set([...js8Preload.matchAll(/ipcRenderer\.(?:send|invoke)\('([a-z0-9:-]+)'/g)].map(m => m[1]))];
for (const m of js8Preload.matchAll(/ipcRenderer\.on\('([a-z0-9:-]+)'/g)) incoming.add(m[1]);
const sstvPreload = R('preload-sstv-popout.js');
const sstvOut = [...new Set([...sstvPreload.matchAll(/ipcRenderer\.(?:send|invoke)\('([a-z0-9:-]+)'/g)].map(m => m[1]))];
for (const m of sstvPreload.matchAll(/ipcRenderer\.on\('([a-z0-9:-]+)'/g)) incoming.add(m[1]);

console.log('JTCAT remote bridge');

test('every channel the pop-out sends is bridged or deliberately local', () => {
  const missing = outgoing.filter(ch => !B.OUT[ch] && !B.LOCAL_ONLY[ch]);
  assert.deepStrictEqual(missing, [], 'add a row to OUT or LOCAL_ONLY (with the reason)');
});

test('every bridged channel is one the pop-out really sends', () => {
  const stale = Object.keys(B.OUT).filter(ch => !outgoing.includes(ch) && !js8Out.includes(ch) && !sstvOut.includes(ch));
  assert.deepStrictEqual(stale, []);
});

test('every wire message the bridge sends is a C2S in the registry', () => {
  const st = { holdTx: false, fullAuto: true, tune: true };
  for (const [ch, rule] of Object.entries(B.OUT)) {
    const r = rule(['x', true], st) || {};
    for (const m of r.send || []) {
      assert.ok(MESSAGES[m.type], `${ch} → ${m.type} is registered`);
      assert.ok(MESSAGES[m.type].dir === 'c2s' || MESSAGES[m.type].dir === 'both', `${m.type} is C2S`);
      for (const k of Object.keys(m)) {
        if (k === 'type') continue;
        assert.ok(MESSAGES[m.type].fields && k in MESSAGES[m.type].fields, `${m.type}.${k} is declared`);
      }
    }
  }
});

test('every shack frame the bridge maps is an S2C in the registry, onto a channel the pop-out hears', () => {
  for (const [type, rule] of Object.entries(B.IN)) {
    assert.ok(MESSAGES[type] && (MESSAGES[type].dir === 's2c' || MESSAGES[type].dir === 'both'), type);
    const sample = { type, entries: [{}], bins: [1, 2], value: 0.5, enabled: true, fullAutoCq: true, ultracat: true };
    for (const [ch] of rule(sample)) assert.ok(incoming.has(ch), `${type} → ${ch}: the pop-out listens on it`);
  }
});

test('the relayed channels have a handler of that name on the shack', () => {
  for (const ch of B.RELAY_CHANNELS) assert.ok(main.includes(`ipcMain.on('${ch}'`), ch);
});

test('every preference the bridge forwards is one the pop-out saves', () => {
  for (const key of Object.keys(B.JTCAT_PREFS)) assert.ok(popout.includes(key), key);
});

test('every channel the JS8 window sends or invokes is bridged, answered, or deliberately local', () => {
  const missing = js8Out.filter(ch => !B.JS8_OUT[ch] && !B.JS8_INVOKES.includes(ch) && !B.JS8_LOCAL_ONLY[ch]);
  assert.deepStrictEqual(missing, []);
  for (const ch of B.JS8_INVOKES) assert.ok(js8Out.includes(ch), ch + ' is a real JS8 invoke');
  const inv = main.slice(main.indexOf('async function bridgeInvokeToShack('), main.indexOf('async function bridgeInvokeToShack(') + 7000);
  for (const ch of B.JS8_INVOKES) assert.ok(inv.includes(`case '${ch}':`), ch + ' answered');
  assert.ok(/ipcMain\.handle = \(channel, fn\) => _ipcHandle\(channel, \(RemoteBridge\.JS8_INVOKES\.includes\(channel\) \|\| RemoteBridge\.SSTV_INVOKES\.includes\(channel\)\)/.test(main), 'invokes are wrapped');
  for (const m of inv.matchAll(/type: '(js8-[a-z-]+)'/g)) assert.ok(MESSAGES[m[1]], m[1] + ' is registered');
});

test('JS8: the window is filled from the shack, open starts there, close stops there', () => {
  const at = main.indexOf("js8PopoutWin.webContents.on('did-finish-load', () => {");
  const open = main.slice(at, at + 1800);
  assert.ok(/if \(isRemoteMode\(\)\) \{[\s\S]*bridgeInvokeToShack\('js8-start', \[\]\)[\s\S]*return;\n\s+\}/.test(open), 'no local startJtcat in remote mode');
  const cAt = main.indexOf("js8PopoutWin.on('closed', () => {");
  assert.ok(/type: 'js8-stop'/.test(main.slice(cAt, cAt + 900)));
  assert.deepStrictEqual(B.IN['js8-state']({ type: 'js8-state', running: true, tx: false }), [['js8call-status', { running: true, tx: false, connected: true }]]);
  assert.deepStrictEqual(B.IN['js8-heard']({ list: [{ call: 'K1ABC' }] }), [['js8call-heard', [{ call: 'K1ABC' }]]]);
  assert.ok(/_autoRxDeferLogged = false;\n\s+\/\/ Driving a remote shack: idle receive is the shack's own setting\.\n\s+if \(isRemoteMode\(\)\) return;/.test(main), "this PC's idle receive never drives the shack");
  const srv = R('lib/remote-server.js');
  assert.ok(/_js8ActivityGuestSafe/.test(srv) && /case 'js8-set-offset':\n\s+if \(ws\._passSession\)/.test(srv), 'guest privacy and owner-only controls');
  assert.ok(/ft8Engine\._audioBuffer \|\| ft8Engine\._specBuffer/.test(main), "the shack's spectrum loop reads a JS8 engine too");
});

test('every channel the SSTV window sends or invokes is bridged, answered, or deliberately local', () => {
  const missing = sstvOut.filter(ch => !B.SSTV_OUT[ch] && !B.SSTV_INVOKES.includes(ch) && !B.SSTV_LOCAL_ONLY[ch]);
  assert.deepStrictEqual(missing, []);
  const inv = main.slice(main.indexOf('async function bridgeInvokeToShack('), main.indexOf('async function bridgeInvokeToShack(') + 7000);
  for (const ch of B.SSTV_INVOKES) assert.ok(inv.includes(`case '${ch}':`), ch + ' answered');
});

test('SSTV: the picture goes as a PNG, comes back decoded and saved here, the window captures nothing', () => {
  assert.deepStrictEqual(B.OUT['sstv-encode']([{}]), { photo: true });
  const br = main.slice(main.indexOf('function bridgeIpcToShack('), main.indexOf('function bridgeIpcToShack(') + 4000);
  assert.ok(/nativeImage\.createFromBitmap\(bgra, \{ width: w, height: h \}\)\.toPNG\(\)/.test(br) && /type: 'sstv-photo', image: 'data:image\/png;base64,'/.test(br));
  assert.ok(/sstv-tx-status', \{ state: 'rx', error: REMOTE_NOT_LINKED_MSG \}/.test(br), 'never left on Encoding... when the link is down');
  const inb = main.slice(main.indexOf('function remoteSstvInbound(msg) {'), main.indexOf('function remoteSstvInbound(msg) {') + 3000);
  assert.ok(/if \(ts && ts === _remoteSstvLastTs\) return true;/.test(inb), 'the connect replay is not shown twice');
  assert.ok(/if \(msg\.filename && saveSstvImageRef\)/.test(inb), 'saved here when the shack saved it');
  assert.deepStrictEqual(B.IN['sstv-tx-status']({ state: 'tx', durationSec: 114 })[0], ['sstv-tx-audio', { samples: [], durationSec: 114, daxTx: true, directTxLabel: 'the shack' }]);
  assert.deepStrictEqual(B.IN['sstv-decoder-state']({ running: true }), [['sstv-status', { state: 'running' }]]);
  const pop = R('renderer/sstv-popout.js');
  assert.ok(/async function startRxAudio\(\) \{\n(\s*\/\/.*\n)*\s+if \(settings\.remoteShack\) return;/.test(pop), 'no capture for a remote shack');
  assert.ok(/onSstvRemoteWfBins/.test(pop) && /onSstvRemoteWfBins/.test(sstvPreload));
  const open = main.slice(main.indexOf("// Start SSTV engine when popout opens"), main.indexOf("// Start SSTV engine when popout opens") + 400);
  assert.ok(/if \(isRemoteMode\(\)\) \{\n\s+if \(isRemoteLinked\(\)\) remoteClient\.sendRaw\(\{ type: 'sstv-open' \}\);/.test(open), 'opens the shack\'s decoder, not a local one');
  assert.strictEqual(require('../lib/remote-features').check('sstv').ok, true);
});

console.log('\nbehaviour');

test('an automatic TX-frequency follow is dropped while Hold TX is on; an operator move is not', () => {
  assert.deepStrictEqual(B.OUT['jtcat-set-tx-freq']([1200, false], { holdTx: true }), { drop: true });
  assert.deepStrictEqual(B.OUT['jtcat-set-tx-freq']([1200, true], { holdTx: true }).send, [{ type: 'jtcat-set-tx-freq', hz: 1200 }]);
  assert.deepStrictEqual(B.OUT['jtcat-set-tx-freq']([1200, false], { holdTx: false }).send, [{ type: 'jtcat-set-tx-freq', hz: 1200 }]);
});

test('Halt also stops Full Auto CQ and a tune the shack\'s halt would leave running', () => {
  assert.deepStrictEqual(B.OUT['jtcat-halt-tx']([], { fullAuto: false, tune: false }).send.map(m => m.type), ['jtcat-halt-tx']);
  assert.deepStrictEqual(B.OUT['jtcat-halt-tx']([], { fullAuto: true, tune: true }).send.map(m => m.type), ['jtcat-halt-tx', 'jtcat-full-auto-cq', 'jtcat-tune-toggle']);
});

test('the pop-out\'s own audio never leaves this PC; multi-slice is refused with a reason', () => {
  for (const ch of ['jtcat-audio', 'jtcat-slice-audio', 'jtcat-spectrum', 'jtcat-quiet-freq', 'jtcat-tx-complete']) {
    assert.deepStrictEqual(B.OUT[ch]([]), { drop: true }, ch);
  }
  assert.ok(/shack PC/.test(B.OUT['jtcat-start-multi']([]).refuse));
});

test('a reply carries exactly the wire\'s fields; no call, nothing sent', () => {
  const r = B.OUT['jtcat-popout-reply']([{ call: 'K1ABC', text: 'CQ K1ABC FN42', df: 1234, snr: -10, slot: 'odd', junk: 1 }]).send[0];
  assert.deepStrictEqual(r, { type: 'jtcat-reply', call: 'K1ABC', df: 1234, text: 'CQ K1ABC FN42', snr: -10, slot: 'odd' });
  assert.deepStrictEqual(B.OUT['jtcat-popout-reply']([{}]), { drop: true });
});

test('inbound: stopped is normalized, the replay unpacks, Full Auto reads as this window\'s', () => {
  assert.deepStrictEqual(B.IN['jtcat-status']({ type: 'jtcat-status', running: false }), [['jtcat-status', { state: 'stopped' }]]);
  assert.deepStrictEqual(B.IN['jtcat-status']({ type: 'jtcat-status', state: 'running', mode: 'FT4' }), [['jtcat-status', { state: 'running', mode: 'FT4' }]]);
  assert.strictEqual(B.IN['jtcat-decode-batch']({ entries: [{ a: 1 }, { a: 2 }] }).length, 2);
  const u = B.IN['jtcat-ultracat-state']({ fullAutoCq: true, owner: 'remote', ultracat: true });
  assert.deepStrictEqual(u[0], ['jtcat-full-auto-cq-state', { active: true, owner: 'popout', reason: '' }]);
  assert.deepStrictEqual(u[1], ['jtcat-ultracat', true]);
  const st = {};
  B.trackState(st, { type: 'jtcat-hold-tx-state', enabled: true });
  B.trackState(st, { type: 'jtcat-tune-state', active: true });
  assert.ok(st.holdTx && st.tune);
});

test('preferences: only the allowlist, only the right type, bounded', () => {
  assert.deepStrictEqual(B.prefMessages({ jtcatMaxQsoAttempts: 8, jtcatFdMode: 'yes', myCallsign: 'X' }), [{ type: 'jtcat-set-pref', key: 'jtcatMaxQsoAttempts', value: 8 }]);
  assert.strictEqual(B.acceptPref('jtcatFdMode', true), true);
  assert.strictEqual(B.acceptPref('jtcatFdMode', 'true'), undefined);
  assert.strictEqual(B.acceptPref('myCallsign', 'K1ABC'), undefined);
  assert.strictEqual(B.acceptPref('jtcatFdExch', 'x'.repeat(200)).length, 64);
});

test('a hand-over with the shack\'s own JTCAT window is said in this window', () => {
  const back = B.IN['jtcat-owner']({ owner: 'shack', message: 'The shack took it' });
  assert.deepStrictEqual(back.map(x => x[0]), ['jtcat-qso-state', 'jtcat-status']);
  assert.strictEqual(back[1][1].state, 'stopped');
  assert.deepStrictEqual(B.IN['jtcat-owner']({ owner: 'you', message: 'You took it' }), [['jtcat-qso-notice', { message: 'You took it' }]]);
  assert.ok(/type: 'jtcat-owner', owner: 'you'/.test(main) && /type: 'jtcat-owner', owner: 'shack'/.test(main), 'the shack says it both ways');
});

console.log('\nwiring');

test('main intercepts at the IPC layer before any handler registers', () => {
  const at = main.indexOf('ipcMain.on = (channel, fn) => _ipcOn(channel, RemoteBridge.OUT[channel]');
  assert.ok(at > 0, 'the wrapper exists');
  const firstHandler = main.indexOf("ipcMain.on('");
  assert.ok(at < firstHandler, 'installed before the first ipcMain.on handler');
  const fn = main.slice(main.indexOf('function bridgeIpcToShack('), main.indexOf('function bridgeInboundFromShack('));
  assert.ok(/if \(!isRemoteMode\(\)\) return false;/.test(fn), 'a local rig is untouched');
  assert.ok(/if \(!isRemoteLinked\(\)\) \{/.test(fn), 'a down link refuses out loud');
  assert.ok(/remoteJtcatSubscribeSpectrum\(true\)/.test(fn), 'the waterfall subscription follows an engine (re)start');
  const msg = main.slice(main.indexOf("remoteClient.on('message', (msg) => {"), main.indexOf("remoteClient.on('message', (msg) => {") + 200);
  assert.ok(/if \(bridgeInboundFromShack\(msg\)\) return;/.test(msg));
  assert.ok(/'jtcat-set-band', band: freqToBand\(khz \/ 1000\)/.test(main), 'a JTCAT band pick moves the shack\'s pre-TX anchor');
  assert.ok(/remoteShack: isRemoteMode\(\)/.test(main), 'the pop-out learns it drives a shack');
});

test('the pop-out captures nothing for a remote shack and draws the shack\'s spectrum', () => {
  assert.ok(/if \(!remoteShackMode\) startPopoutAudio\(s\.remoteAudioInput \|\| '', s\.audioSource\);/.test(popout));
  assert.ok(/if \(remoteShackMode\) return;\n\s+console\.log\('\[JTCAT popout\] Silence watchdog/.test(popout));
  assert.ok(/if \(!remoteShackMode && popoutQuietFreqFrame % 30 === 0\)/.test(popout));
  assert.ok(/if \(!remoteShackMode && popoutSpectrumFrame % 6 === 0\)/.test(popout));
  assert.ok(/onJtcatRemoteSpectrum\(function\(bins\)/.test(popout) && /onJtcatRemoteSpectrum/.test(preload));
  assert.ok(/jtcatModeHop: \(opts\) => ipcRenderer\.send\('jtcat-mode-hop', opts\)/.test(preload), 'the mode-hop toggle had no preload method');
  assert.strictEqual(require('../lib/remote-features').check('jtcat').ok, true);
});

test('the shack side: jtcat-set-pref and jtcat-relay, Guest Pass held off', () => {
  const srv = R('lib/remote-server.js');
  assert.ok(/case 'jtcat-set-pref':\n\s+if \(ws\._passSession\) break;/.test(srv));
  assert.ok(/case 'jtcat-relay':\n\s+if \(ws\._passSession && msg\.channel !== 'jtcat-set-tx-msg'\) break;/.test(srv));
  assert.ok(/RemoteBridge\.acceptPref\(key, value\)/.test(main));
  assert.ok(/if \(!RemoteBridge\.RELAY_CHANNELS\.includes\(channel\)\) return;/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
