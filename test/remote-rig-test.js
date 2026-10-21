#!/usr/bin/env node
'use strict';
// Desktop-to-desktop, Phase A1/A2 (docs/remote-desktop-parity-spec.md).
// A laptop driving a remote shack showed every rig control dark: the shack's
// status snapshot carries the whole radio, the laptop read five fields of it
// (Ride1226 2026-10-21). lib/remote-rig.js keeps the snapshot; main.js mirrors
// it into the rig state every surface reads and returns the shack's caps.
// Run: node test/remote-rig-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteRigState, STATUS_TO_RIG_STATE, FRAME_TO_STATUS } = require('../lib/remote-rig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
function fnBody(src, header) {
  const a = src.indexOf(header);
  assert.ok(a >= 0, 'found ' + header);
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
}
function handlerBody(src, header) {
  const a = src.indexOf(header);
  assert.ok(a >= 0, 'found ' + header);
  return src.slice(a, src.indexOf('\n  });\n', a));
}

console.log('RemoteRigState');

test('a snapshot is merged, never replaced (an omitted field holds)', () => {
  const r = new RemoteRigState();
  assert.strictEqual(r.seen, false);
  r.applyStatus({ type: 'status', freq: 14074000, nb: true, txpower: 50 });
  const changed = r.applyStatus({ type: 'status', freq: undefined, nb: false });
  assert.deepStrictEqual(changed, ['nb']);
  assert.strictEqual(r.get('freq'), 14074000);
  assert.strictEqual(r.get('txpower'), 50);
  assert.strictEqual(r.get('nb'), false);
  assert.strictEqual(r.seen, true);
});

test('changed lists only fields that moved; objects compare by value', () => {
  const r = new RemoteRigState();
  r.applyStatus({ capabilities: { nb: true, atu: false }, smeter: 3 });
  assert.deepStrictEqual(r.applyStatus({ capabilities: { nb: true, atu: false }, smeter: 3 }), []);
  assert.deepStrictEqual(r.applyStatus({ capabilities: { nb: true, atu: true }, smeter: 4 }), ['capabilities', 'smeter']);
});

test('capabilities are the shack\'s, copied, {} until seen', () => {
  const r = new RemoteRigState();
  assert.deepStrictEqual(r.capabilities(), {});
  r.applyStatus({ capabilities: { nb: true, preampSteps: [0, 1, 2] } });
  const c = r.capabilities();
  c.nb = false;
  assert.strictEqual(r.capabilities().nb, true, 'a caller cannot mutate the stored caps');
});

test('discrete frames update their field; unknown or non-numeric frames are ignored', () => {
  const r = new RemoteRigState();
  assert.strictEqual(r.applyFrame({ type: 'smeter', value: 7 }), 'smeter');
  assert.strictEqual(r.get('smeter'), 7);
  assert.strictEqual(r.applyFrame({ type: 'power', value: 25 }), 'txpower', 'power frame is the RF power SETTING');
  assert.strictEqual(r.applyFrame({ type: 'fwd-power', value: 4.5 }), 'fwdPower');
  assert.strictEqual(r.applyFrame({ type: 'swr-ratio', value: 1.4 }), 'swrRatio');
  assert.strictEqual(r.applyFrame({ type: 'jtcat-decode', value: 1 }), null);
  assert.strictEqual(r.applyFrame({ type: 'smeter', value: 'x' }), null);
});

test('reset forgets the session', () => {
  const r = new RemoteRigState();
  r.applyStatus({ nb: true, catConnected: true, txState: true });
  assert.ok(r.catConnected() && r.transmitting());
  r.reset();
  assert.strictEqual(r.seen, false);
  assert.strictEqual(r.catConnected(), false);
  assert.strictEqual(r.get('nb'), undefined);
});

console.log('\nmain.js contract');

test('every mapped snapshot field is a field the shack actually sends', () => {
  const shack = fnBody(main, 'function broadcastRemoteRadioStatus() {');
  for (const from of Object.keys(STATUS_TO_RIG_STATE)) {
    assert.ok(new RegExp('\\n\\s+' + from + '[:,]').test(shack), `shack status snapshot sends ${from}`);
  }
  for (const f of Object.values(FRAME_TO_STATUS)) {
    if (f === 'fwdPower') continue; // frame-only
    assert.ok(new RegExp('\\n\\s+' + f + '[:,]').test(shack), `frame field ${f} also rides the snapshot`);
  }
});

test('applyRemoteRigSnapshot assigns each field to the variable broadcastRigState reads', () => {
  const bcast = fnBody(main, 'function broadcastRigState() {');
  const localOf = {};
  for (const m of bcast.matchAll(/(\w+): (_\w+),/g)) localOf[m[1]] = m[2];
  const apply = fnBody(main, 'function applyRemoteRigSnapshot(s) {');
  const reset = fnBody(main, 'function resetRemoteMirroredRigState() {');
  for (const [from, to] of Object.entries(STATUS_TO_RIG_STATE)) {
    if (from === 'mode') continue; // the status handler mirrors mode (skips an empty one)
    const v = localOf[to];
    assert.ok(v, `broadcastRigState carries ${to}`);
    assert.ok(apply.includes(`if (s.${from} !== undefined) ${v} = s.${from};`), `${from} → ${v}`);
    assert.ok(new RegExp('\\n  ' + v + ' = ').test(reset), `${v} is reset when leaving remote mode`);
  }
});

test('the status handler mirrors, broadcasts on a non-meter change, and sends the power SETTING', () => {
  const h = handlerBody(main, "remoteClient.on('status', (snap) => {");
  assert.ok(/const changed = remoteRig\.applyStatus\(snap\);\n\s+applyRemoteRigSnapshot\(snap\);/.test(h));
  assert.ok(/changed\.some\(k => !REMOTE_METER_FIELDS\.has\(k\)\)\) broadcastRigState\(\)/.test(h));
  assert.ok(/sendCatPower\(snap\.txpower\)/.test(h), 'txpower, the setting');
  assert.ok(!/sendCatPower\(snap\.power\)/.test(h), 'never the wattmeter on the setting channel');
});

test('caps come from the shack in remote mode', () => {
  const g = fnBody(main, 'function getRigCapabilities(rigType) {');
  assert.ok(/if \(isRemoteMode\(\) && remoteRig\.seen\) return remoteRig\.capabilities\(\);/.test(g));
});

test('remote MODE guards the local rig; sends need the LINK and refuse out loud', () => {
  assert.ok(!/isRemoteActive/.test(main), 'the old authed-only predicate is gone');
  const mode = fnBody(main, 'function isRemoteMode() {');
  assert.ok(/activeTargetId/.test(mode) && !/authed/.test(mode), 'mode is the operator\'s choice, not the socket');
  const ccAt = main.indexOf('async function connectCat() {');
  const cc = main.slice(ccAt, main.indexOf("_connectCatSkipLogged = '';", ccAt));
  assert.ok(/if \(isRemoteMode\(\)\) \{/.test(cc), 'connectCat refuses while a shack is the target, linked or not');
  const tune = handlerBody(main, "ipcMain.on('tune', (_e, { frequency, mode, bearing, slicePort, origin }) => {");
  assert.ok(/if \(isRemoteMode\(\)\) \{\n\s+if \(!isRemoteLinked\(\)\) \{ refuseRemoteNotLinked\(_e\.sender\); return; \}/.test(tune), 'tune');
  const rc = main.slice(main.indexOf("ipcMain.handle('rig-control', (_e, data) => {"), main.indexOf("return applyRigControl(data, 'desktop');"));
  assert.ok(/isRemoteMode\(\) && !\(data && data\.action === 'get-state'\)/.test(rc), 'get-state answers from the mirror');
  assert.ok(/refuseRemoteNotLinked\(_e\.sender\); return \{ ok: false, error: REMOTE_NOT_LINKED_MSG \}/.test(rc));
  assert.ok(/sendRaw\(\{ type: 'rig-control', data \}\)/.test(rc), 'canonical nested rig-control');
  const lock = handlerBody(main, "ipcMain.on('vfo-set-lock', (_e, locked) => {");
  assert.ok(/remoteClient\.sendRaw\(\{ type: 'vfo-set-lock', locked: !!locked \}\)/.test(lock), 'the lock lives on the shack');
});

test('every PTT source keys the shack in remote mode; the shack\'s release reaches the buttons', () => {
  const ptt = fnBody(main, 'function handleRemotePtt(state, opts = {}) {');
  const firstLines = ptt.split('\n').slice(0, 8).join('\n');
  assert.ok(/if \(isRemoteMode\(\)\) \{ keyRemoteShack\(state\); return; \}/.test(firstLines), 'before any local-rig logic');
  const key = fnBody(main, 'function keyRemoteShack(on) {');
  assert.ok(/if \(on && !isRemoteLinked\(\)\)/.test(key) && /remote-client-ptt-released/.test(key), 'refused key-down releases the button');
  assert.ok(/'rac-ptt', on/.test(key) && /remoteClient\.sendPtt\(on\)/.test(key));
  const msg = handlerBody(main, "remoteClient.on('message', (msg) => {");
  assert.ok(/case 'ptt-timeout':\n\s+case 'ptt-force-rx':/.test(msg) && /remote-client-ptt-released/.test(msg));
  assert.ok(/case 'vfo-lock-state':/.test(msg));
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const vfoPreload = fs.readFileSync(path.join(__dirname, '..', 'preload-vfo-popout.js'), 'utf8');
  assert.ok(/onRemoteClientPttReleased/.test(preload) && /onRemotePttReleased/.test(vfoPreload));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/onRemoteClientPttReleased\(\(\) => \{ ptt\.up\(\); \}\)/.test(app));
  const vfo = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'), 'utf8');
  assert.ok(/onRemotePttReleased\(\(info\) => \{\n\s+pttStop\(\);/.test(vfo));
});

test('leaving remote mode resets the mirror and redraws', () => {
  const t = fnBody(main, 'function tearDownRemoteClient() {');
  assert.ok(/resetRemoteMirroredRigState\(\);/.test(t) && /broadcastRigState\(\);\n\}/.test(t));
});

console.log('\nshack rigs, round trip, gating, own clients');

test('the shack\'s rig list and round trip reach the chip and the CAT popover', () => {
  const msg = handlerBody(main, "remoteClient.on('message', (msg) => {");
  assert.ok(/case 'rigs': \{[\s\S]*pushRemoteShackInfo\(\);/.test(msg));
  assert.ok(/case 'tx-drive-state':/.test(msg), 'the shack\'s TX drive echo');
  const sw = main.slice(main.indexOf("ipcMain.handle('remote-shack-switch-rig'"));
  assert.ok(/remoteClient\.sendRaw\(\{ type: 'switch-rig', rigId: String\(rigId\) \}\)/.test(sw.slice(0, 600)));
  const rc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-client.js'), 'utf8');
  assert.ok(/this\.emit\('rtt', rtt\)/.test(rc) && /rttMs: this\._rttMs/.test(rc));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/if \(remoteShack && remoteShack\.remote\) \{\n\s+renderRemoteShackRigs\(remoteShack\);/.test(app), 'CAT popover lists the shack\'s rigs');
  assert.ok(/window\.api\.remoteShackSwitchRig\(rig\.id\)/.test(app));
  assert.ok(/connectionTargetsActivate\(null\)/.test(app.slice(app.indexOf('function renderRemoteShackRigs'))), 'a way back to this PC\'s radio');
});

test('round trip: RemoteClient measures the pong it already gets', () => {
  const { RemoteClient } = require('../lib/remote-client');
  const c = new RemoteClient({ id: 't', name: 'shack' });
  let got = null;
  c.on('rtt', (ms) => { got = ms; });
  c._handleMessage(JSON.stringify({ type: 'pong', ts: Date.now() - 42 }));
  assert.ok(got >= 42 && got < 1000, 'rtt ' + got);
  assert.strictEqual(c.state().rttMs, got);
  c._handleMessage(JSON.stringify({ type: 'pong' })); // an old shack: no ts, no figure, no throw
});

test('TX drive in remote mode is the shack\'s, never this PC\'s rig setting', () => {
  const h = handlerBody(main, "ipcMain.on('tx-drive-set', (_e, value) => {");
  const remote = h.slice(0, h.indexOf('settings.txDrive = v;'));
  assert.ok(/if \(isRemoteMode\(\)\) \{[\s\S]*type: 'set-tx-drive', value: v[\s\S]*return;\n\s+\}/.test(remote));
});

test('remote-features: every unavailable entry point exists and has a reason', () => {
  const RF = require('../lib/remote-features');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const { id, reason, name } of RF.unavailableElements()) {
    assert.ok(html.includes(`id="${id}"`), `${name}: #${id} is in index.html`);
    assert.ok(reason && reason.length > 20, `${name} has a reason`);
  }
  for (const [name, f] of Object.entries(RF.FEATURES)) {
    assert.ok(['shack', 'here', 'unavailable'].includes(f.where), name);
    if (f.where === 'unavailable') assert.ok(f.reason, name + ' reason');
  }
  assert.deepStrictEqual(RF.check('nope'), { ok: true });
  assert.ok(/<script src="\.\.\/lib\/remote-features\.js"><\/script>/.test(html));
});

test('main refuses an unavailable feature with the same text, at its entry IPC', () => {
  const refuse = fnBody(main, 'function refuseRemoteFeature(feature) {');
  assert.ok(/RemoteFeatures\.check\(feature\)/.test(refuse) && /app-notice/.test(refuse));
  const guards = {
    jtcat: ["ipcMain.on('jtcat-popout-open', (_e, mode) => {\n    if (refuseRemoteFeature('jtcat')) return;",
            "ipcMain.on('jtcat-start', (_e, mode) => { if (!refuseRemoteFeature('jtcat')) startJtcat(mode); });"],
    js8: ["if (!refuseRemoteFeature('js8')) openJs8Popout();"],
    mercury: ["if (!refuseRemoteFeature('mercury')) openMercuryPopout();"],
    scope: ["if (!refuseRemoteFeature('scope')) openScopePopout();"],
    sstv: ["if (!refuseRemoteFeature('sstv')) openSstvPopout();"],
    voiceMacros: ["if (state && refuseRemoteFeature('voiceMacros')) return;"],
    cw: ["ipcMain.on('send-cw-text', (_e, text, opts) => {\n    if (refuseRemoteFeature('cw')) return;"],
  };
  const RF = require('../lib/remote-features');
  for (const [name, needles] of Object.entries(guards)) {
    if (RF.FEATURES[name].where !== 'unavailable') continue; // bridged: that guard is gone by design
    for (const n of needles) assert.ok(main.includes(n), `${name}: ${n.slice(0, 50)}`);
  }
  const ss = fnBody(main, 'function stationSetupPayload(rigId) {');
  assert.ok(/if \(isRemoteMode\(\)\) \{[\s\S]*remote: true, reason: c\.reason/.test(ss), 'no checklist for a radio that is not here');
});

test('the renderer greys unavailable entry points and answers a click with the reason', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const g = app.slice(app.indexOf('function applyRemoteFeatureGating(on) {'), app.indexOf('// Remote mode: the radios on offer are the SHACK\'s.'));
  assert.ok(/RemoteFeatures\.unavailableElements\(\)/.test(g) && /data-remote-unavailable/.test(g));
  assert.ok(/e\.stopImmediatePropagation\(\);\n\s+showLogToast\(el\.getAttribute\('data-remote-unavailable'\)/.test(g));
  assert.ok(/onRemoteShackInfo\(\(info\) => applyRemoteFeatureGating\(!!\(info && info\.remote\)\)\)/.test(app));
});

test('shack audio: chosen devices are applied, refused out loud, never swapped', () => {
  const ans = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote-audio-answerer.js'), 'utf8');
  assert.ok(/if \(this\._micDeviceId\) audio\.deviceId = \{ exact: this\._micDeviceId \};/.test(ans), 'exact mic, no fallback');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote-audio-client.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/catch \(e\) \{\n\s+el\.muted = true;\n\s+window\.api\.state\(\{ sinkError:/.test(shell), 'an output that will not open mutes, it does not fall back');
  assert.ok(/a\.setMicDeviceId\(cfg\.inputId\); a\.start\(\);/.test(shell), 'the mic is chosen before capture');
  assert.ok(/peak > 1e-4/.test(shell) && /now - silentSince > 10000/.test(shell), 'digital silence for 10 s is reported');
  const h = main.slice(main.indexOf("ipcMain.on('rac-state', (_e, s) => {"));
  assert.ok(/if \(s\.sinkError\)/.test(h.slice(0, 2500)) && /if \(typeof s\.rxSilent === 'boolean'\)/.test(h.slice(0, 2500)));
  const start = fnBody(main, 'async function startRemoteClientAudio() {');
  assert.ok(start.indexOf("send('rac-config'") > 0 && start.indexOf("send('rac-config'") < start.lastIndexOf("send('rac-start')"), 'config before start');
  assert.ok(/'remoteShackAudio',/.test(main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf('const GLOBAL_KEYS') + 3000)), 'machine-scoped');
});

test('hold-a-key PTT: off by default, never while typing, released on keyup and blur', () => {
  const prefs = fnBody(main, 'function remoteShackAudioPrefs() {');
  assert.ok(/pttKey: REMOTE_SHACK_PTT_KEYS\.includes\(a\.pttKey\) \? a\.pttKey : ''/.test(prefs));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/e\.repeat \|\| e\.ctrlKey \|\| e\.altKey \|\| e\.metaKey\) return;\n\s+if \(typingIn\(document\.activeElement\)\) return;/.test(app));
  assert.ok(/window\.addEventListener\('blur', \(\) => \{ if \(_pttKeyHeld\) \{ _pttKeyHeld = false; ptt\.up\(\); \} \}\);/.test(app));
});

test('pairing: the shack\'s expiry and trust are written back; a link\'s TTL never is', () => {
  const redeem = main.slice(main.indexOf('async function redeemPairLinkUrl'), main.indexOf('async function redeemPairLinkUrl') + 4000);
  assert.ok(!/expiresAt: expHint \? Number\(expHint\) : null/.test(redeem), 'the link exp is not the pairing expiry');
  const conn = handlerBody(main, "remoteClient.on('connected', (info) => {");
  assert.ok(/target\.expiresAt = \(typeof info\.expiresAt === 'number' && info\.expiresAt > 0\) \? info\.expiresAt : null;/.test(conn));
  assert.ok(/target\.trusted = !!info\.trusted;/.test(conn));
  assert.ok(/passSession: info\.passSession \|\| null/.test(conn), 'the Guest Pass profile reaches the renderer');
  assert.ok(/target\.tsCertPublic = info\.tsCertPublic/.test(conn));
});

test('Tailscale leg: a public certificate is checked by its CA, not the LAN pin', () => {
  const { RemoteClient } = require('../lib/remote-client');
  const pinned = new RemoteClient({ id: 'a', tsHost: 'shack.tail1.ts.net', fingerprint: 'AB:CD' })._candidates();
  assert.strictEqual(pinned[0].pin, 'AB:CD');
  const pub = new RemoteClient({ id: 'b', tsHost: 'shack.tail1.ts.net', fingerprint: 'AB:CD', tsCertPublic: true })._candidates();
  assert.strictEqual(pub[0].pin, '');
});

test('Remove unpairs at the shack when linked, and gives the radio back to this PC', () => {
  const rm = handlerBody(main, "ipcMain.handle('connection-targets-remove', (_e, id) => {");
  assert.ok(/if \(isRemoteLinked\(\)\) \{ remoteClient\.sendRaw\(\{ type: 'unpair-self' \}\); unpairedAtShack = true; \}/.test(rm));
  assert.ok(/connectCatSafe\('remote shack removed'\)/.test(rm));
  const { MESSAGES } = require('../lib/echocat-protocol');
  assert.ok(MESSAGES['unpair-self'] && MESSAGES['unpair-self'].dir === 'c2s');
  const { RemoteServer } = require('../lib/remote-server');
  const rs = new RemoteServer();
  let revoked = null;
  rs.revokeDevice = (id) => { revoked = id; return true; };
  const ws = { readyState: 1, _authenticated: true, _pairedDevice: { id: 'dev-7', name: 'laptop' } };
  rs._client = ws;
  const srv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  assert.ok(/case 'unpair-self': \{\n\s+const dev = ws\._pairedDevice;[\s\S]{0,300}this\.revokeDevice\(dev\.id\);/.test(srv.replace(/\r\n/g, '\n')));
});

test('Re-pair: one click for an account-linked shack, a clear instruction otherwise', () => {
  const rp = handlerBody(main, "ipcMain.handle('connection-targets-repair', async (_e, id) => {");
  assert.ok(/needsLink: true/.test(rp) && /cloudPairShackById\(match\.device_id \|\| match\.deviceId\)/.test(rp));
  assert.ok(/norm\(s\.fingerprint\) === norm\(old\.fingerprint\)/.test(rp), 'the same shack, by fingerprint first');
  const st = handlerBody(main, "ipcMain.handle('connection-targets-get-status', () => {");
  assert.ok(/state: 'auth-fail'/.test(st), 'a refused pairing survives a list refresh');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/data-act="rr-repair"/.test(app) && /act === 'rr-repair'\) return _remoteRadiosRepair\(id, btn\)/.test(app));
  assert.ok(!/Pair another desktop/.test(app), 'the copy names the real button');
});

test('CW: text, cancel, speed and the paddle key the SHACK, gated on its Remote CW switch', () => {
  const send = handlerBody(main, "ipcMain.on('send-cw-text', (_e, text, opts) => {");
  assert.ok(/if \(isRemoteMode\(\)\) \{ sendRemoteCwText\(text, opts\); return; \}/.test(send));
  const txt = fnBody(main, 'function sendRemoteCwText(text, opts) {');
  assert.ok(/remoteCwRefusal\(false\)/.test(txt) && /type: 'cw-text', text: String\(text \|\| ''\), wpm: settings\.cwWpm \|\| undefined, live: !!\(opts && opts\.live\)/.test(txt));
  const cancel = handlerBody(main, "ipcMain.on('cw-cancel', () => {");
  assert.ok(/type: 'cw-stop'/.test(cancel));
  const wpm = handlerBody(main, "ipcMain.on('cw-set-wpm', (e, wpm) => {");
  assert.ok(/type: 'cw-config', wpm: v/.test(wpm));
  const key = main.slice(main.indexOf("keyer.on('key', ({ down }) => {"), main.indexOf("keyer.on('key', ({ down }) => {") + 500);
  assert.ok(/if \(isRemoteMode\(\)\) \{\n\s+remotePaddleEdge\(down\);/.test(key), 'before the local rig router');
  const edge = fnBody(main, 'function remotePaddleEdge(down) {');
  assert.ok(/type: 'cw-key', at, down: !!down/.test(edge) && /type: 'cw-key', hold: true/.test(edge) && /, 400\)/.test(edge));
  assert.ok(/if \(down\) return;/.test(edge), 'a refused press never keys; a release always goes');
  const conn = handlerBody(main, "remoteClient.on('connected', (info) => {");
  assert.ok(/remoteShackCw = \{ enabled: !!info\.cwAvailable, paddle: !!info\.cwPaddleAvailable/.test(conn));
  const rc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-client.js'), 'utf8');
  assert.ok(/cwAvailable: !!msg\.cwAvailable/.test(rc) && /vfoLocked: !!msg\.vfoLocked/.test(rc));
});

test('voice macros: the shack\'s, played into its radio', () => {
  const msg = handlerBody(main, "remoteClient.on('message', (msg) => {");
  assert.ok(/case 'voice-macro-sync':/.test(msg) && /case 'voice-macro-labels':/.test(msg));
  const play = main.slice(main.indexOf("ipcMain.handle('remote-voice-macro-play'"), main.indexOf("ipcMain.handle('remote-voice-macro-play'") + 700);
  assert.ok(/type: 'voice-macro-play', idx: i/.test(play));
  const list = handlerBody(main, "ipcMain.handle('voice-macro-list', () => {");
  assert.ok(/if \(isRemoteMode\(\)\) return remoteShackVoice\.filled/.test(list));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/if \(remoteShack && remoteShack\.remote\) \{ window\.api\.remoteVoiceMacroPlay\(idx\); return; \}/.test(app));
  const RF = require('../lib/remote-features');
  assert.strictEqual(RF.check('cw').ok, true);
  assert.strictEqual(RF.check('voiceMacros').ok, true);
});

test('band scope: the shack\'s, subscribed while watched, resubscribed after a reconnect', () => {
  const start = fnBody(main, 'function startYaesuScope() {');
  assert.ok(/^function startYaesuScope\(\) \{\n(\s*\/\/.*\n)*\s+if \(isRemoteMode\(\)\) \{ remoteShackScopeSubscribe\(true\); return; \}/.test(start), 'first, before any local source');
  const stop = fnBody(main, 'function stopYaesuScope(why) {');
  assert.ok(/if \(isRemoteMode\(\)\) \{ remoteShackScopeSubscribe\(false\); return; \}/.test(stop));
  const sub = fnBody(main, 'function remoteShackScopeSubscribe(on) {');
  assert.ok(/type: 'scope-subscribe', on: !!on/.test(sub));
  const msg = handlerBody(main, "remoteClient.on('message', (msg) => {");
  assert.ok(/case 'scope-frame':[\s\S]{0,400}scopePopoutWin\.webContents\.send\('scope-frame', f\)/.test(msg));
  assert.ok(/case 'scope-state':/.test(msg));
  const conn = handlerBody(main, "remoteClient.on('connected', (info) => {");
  assert.ok(/if \(_remoteScopeWanted\) remoteClient\.sendRaw\(\{ type: 'scope-subscribe', on: true \}\);/.test(conn));
  assert.ok(/type: 'scope-enable-radio'/.test(handlerBody(main, "ipcMain.on('scope-enable-on-radio', () => {")));
  assert.strictEqual(require('../lib/remote-features').check('scope').ok, true);
});

test('an activation on the laptop is the shack\'s too (its engines log with the refs), and can end', () => {
  const push = fnBody(main, 'function pushActivationToRemoteShack() {');
  assert.ok(/type: 'set-activator-park',\n\s+end: !active,/.test(push) && /parkRef: first \? first\.ref : ''/.test(push) && /onAirCallsign: settings\.activatorOnAirCallsign/.test(push));
  assert.ok(/pushActivatorStateToPhone\(\);\n\s+pushActivationToRemoteShack\(\);/.test(main), 'on every activator change');
  const conn = handlerBody(main, "remoteClient.on('connected', (info) => {");
  assert.ok(/pushActivationToRemoteShack\(\)/.test(conn), 'and at connect');
  const shack = main.slice(main.indexOf("remoteServer.on('set-activator-park', async ("), main.indexOf("remoteServer.on('set-activator-park', async (") + 400);
  assert.ok(/settings\.appMode = end \? 'hunter' : 'activator';/.test(shack), 'a client can end an activation it started');
  const { MESSAGES } = require('../lib/echocat-protocol');
  assert.ok(MESSAGES['set-activator-park'].fields.end && MESSAGES['set-activator-park'].fields.parkRef);
});

const asyncTests = [];
asyncTests.push(['a desktop driving a shack refuses its own ECHOCAT devices', async () => {
  const cc = main.slice(main.indexOf("remoteServer.on('client-connected', ({ deviceId, profileCallsign } = {}) => {"));
  assert.ok(/^[^\n]*\n[\s\S]{0,400}if \(isRemoteMode\(\)\) \{[\s\S]{0,200}remoteServer\.refuseCurrentClient\(REMOTE_NO_RADIO_TO_SHARE_MSG\);\n\s+return;/.test(cc));
  const ens = fnBody(main, 'function ensureRemoteClient() {');
  assert.ok(/remoteServer\.hasClient\(\)\) \{[\s\S]{0,200}refuseCurrentClient/.test(ens), 'a phone already attached is told too');
  const { RemoteServer } = require('../lib/remote-server');
  const rs = new RemoteServer();
  const sent = [];
  let closed = null;
  rs._client = { readyState: 1, close: (code) => { closed = code; } };
  rs._sendTo = (ws, m) => sent.push(m);
  assert.strictEqual(rs.refuseCurrentClient('no radio'), true);
  assert.deepStrictEqual(sent, [{ type: 'rig-blocked', reason: 'no radio' }]);
  await new Promise((r) => setTimeout(r, 900));
  assert.strictEqual(closed, 1008);
}]);

asyncTests.push(['a dial that fails says which leg failed and why, in one line', async () => {
  const { RemoteClient } = require('../lib/remote-client');
  const c = new RemoteClient({ id: 'x', name: 'x', lanHost: 'wss://127.0.0.1:1', fingerprint: 'AB' });
  const logs = [];
  c.on('log', (l) => logs.push(l));
  c.on('error', () => {});
  c.connect();
  await new Promise((r) => setTimeout(r, 1500));
  c.close();
  assert.ok(logs.some(l => /could not reach the shack: lan refused/.test(l)), logs.join('\n'));
}]);

(async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
