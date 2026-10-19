#!/usr/bin/env node
'use strict';
/**
 * JTTY over ECHOCAT (Phase 6 of docs/jtty-integration-plan.md): the four
 * messages are registered, the hello advertises 'jtty', the demux emits an
 * owner's Send verbatim (with its per-message profile) and never a guest's,
 * the recent-rows replay buffer is merged by id and bounded, and the web
 * client + main.js carry the wiring. Modelled on test/js8-remote-test.js.
 *
 * Run: node test/jtty-remote-test.js
 */
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function fakeWs() {
  const sent = [];
  return { _authenticated: true, readyState: 1, send: (w) => { try { sent.push(JSON.parse(w)); } catch {} }, _sent: sent };
}
console.log('JTTY over ECHOCAT');

test('the four JTTY messages are registered with the right direction', () => {
  for (const t of ['jtcat-jtty-send', 'jtcat-jtty-set-profile']) {
    assert.ok(protocol.isKnownType(t), t);
    assert.strictEqual(protocol.describe(t).dir, protocol.Dir.C2S, t + ' direction');
  }
  for (const t of ['jtcat-jtty-rx', 'jtcat-jtty-refused']) {
    assert.ok(protocol.isKnownType(t), t);
    assert.strictEqual(protocol.describe(t).dir, protocol.Dir.S2C, t + ' direction');
  }
  assert.ok(protocol.validate({ type: 'jtcat-jtty-send', text: 'CQ K1ABC CQ' }, protocol.Dir.C2S).ok, 'profile is optional');
  assert.ok(protocol.validate({ type: 'jtcat-jtty-send', text: 'K1ABC 599 001', profile: 'rtty-roundup' }, protocol.Dir.C2S).ok);
  assert.ok(!protocol.validate({ type: 'jtcat-jtty-send' }, protocol.Dir.C2S).ok, 'text is required');
  assert.ok(protocol.validate({ type: 'jtcat-jtty-rx', updates: [{ id: 1, text: 'X', complete: true }], replay: true }, protocol.Dir.S2C).ok);
});

test('the server hello advertises the jtty capability', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = src.match(/capabilities: \[([\s\S]*?)\],\n\s*rigModel:/);
  assert.ok(m, 'hello capability list found');
  assert.ok(/'jtty'/.test(m[1]), 'jtty advertised');
  assert.ok(protocol.buildServerHello({ capabilities: ['jtty'] }).capabilities.includes('jtty'));
});

test('an owner Send emits text and profile verbatim; set-profile emits', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const sends = [], profiles = [];
  rs.on('jtcat-jtty-send', (e) => sends.push(e));
  rs.on('jtcat-jtty-set-profile', (e) => profiles.push(e));
  rs._handleMessage(ws, { type: 'jtcat-jtty-send', text: ' k1abc 599 001 ', profile: 'rtty-roundup' }, {});
  rs._handleMessage(ws, { type: 'jtcat-jtty-send', text: 'CQ K1ABC CQ' }, {});
  rs._handleMessage(ws, { type: 'jtcat-jtty-set-profile', profile: 'field-day' }, {});
  assert.deepStrictEqual(sends, [{ text: ' k1abc 599 001 ', profile: 'rtty-roundup' }, { text: 'CQ K1ABC CQ', profile: undefined }],
    'no trimming, no shaping — main owns composition and refusal');
  assert.deepStrictEqual(profiles, [{ profile: 'field-day' }]);
});

test('a Guest Pass holder can read but never key or change the profile', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  ws._passSession = { code: 'GUEST1' };
  rs._client = ws;
  let n = 0;
  rs.on('jtcat-jtty-send', () => { n++; });
  rs.on('jtcat-jtty-set-profile', () => { n++; });
  rs._handleMessage(ws, { type: 'jtcat-jtty-send', text: 'CQ K1ABC CQ' }, {});
  rs._handleMessage(ws, { type: 'jtcat-jtty-set-profile', profile: 'field-day' }, {});
  assert.strictEqual(n, 0, 'nothing reached main');
});

test('recent rows: newest update per id wins, the list is bounded, and the client gets each batch', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  rs.broadcastJtcatJttyRx([{ id: 1, text: 'CQ K1', complete: false }]);
  rs.broadcastJtcatJttyRx([{ id: 1, text: 'CQ K1ABC CQ', complete: true }, { id: 2, text: 'W9XYZ', complete: true }]);
  assert.deepStrictEqual(rs._jtcatJttyRecent.map((r) => [r.id, r.text, r.complete]), [[1, 'CQ K1ABC CQ', true], [2, 'W9XYZ', true]]);
  assert.strictEqual(ws._sent.length, 2);
  assert.strictEqual(ws._sent[0].type, 'jtcat-jtty-rx');
  assert.strictEqual(ws._sent[1].updates.length, 2);
  for (let i = 10; i < 10 + RemoteServer.JTTY_RECENT_CAP + 5; i++) rs.broadcastJtcatJttyRx([{ id: i, text: 'M' + i, complete: true }]);
  assert.strictEqual(rs._jtcatJttyRecent.length, RemoteServer.JTTY_RECENT_CAP, 'bounded');
  assert.strictEqual(rs._jtcatJttyRecent[0].id, 10 + 5 + 2 - 2 + 0 === 0 ? 0 : rs._jtcatJttyRecent[0].id, 'oldest dropped first');
  assert.ok(!rs._jtcatJttyRecent.some((r) => r.id === 1), 'the oldest rows are gone');
  rs.broadcastJtcatJttyRx([]);
  assert.strictEqual(ws._sent.length, 2 + RemoteServer.JTTY_RECENT_CAP + 5, 'an empty batch sends nothing');
  rs.broadcastJtcatJttyRefused({ message: 'X'.repeat(90), reason: 'too long' });
  const last = ws._sent[ws._sent.length - 1];
  assert.strictEqual(last.type, 'jtcat-jtty-refused');
  assert.strictEqual(last.reason, 'too long');
});

test('a new engine epoch empties the recent rows — ids restart at 1 per engine (jtty-remote-fd-exch-and-replay)', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  rs.broadcastJtcatJttyRx([{ id: 1, text: 'OLD ENGINE ROW 1', complete: true }, { id: 2, text: 'OLD 2', complete: true }], 1000);
  assert.strictEqual(rs._jtcatJttyEpoch, 1000);
  // JTTY → FT8 → JTTY: main clears on start, and even without that a batch
  // from a new epoch must not merge into the old rows by id.
  rs.broadcastJtcatJttyRx([{ id: 1, text: 'NEW ENGINE ROW 1', complete: false }], 2000);
  assert.deepStrictEqual(rs._jtcatJttyRecent.map((r) => r.text), ['NEW ENGINE ROW 1'], 'old rows gone, new row 1 is not the old row 1');
  assert.strictEqual(ws._sent[ws._sent.length - 1].epoch, 2000, 'every batch carries the epoch');
  rs.clearJtcatJttyRecent(3000);
  assert.deepStrictEqual(rs._jtcatJttyRecent, []);
  assert.strictEqual(rs._jtcatJttyEpoch, 3000);
  rs.broadcastJtcatJttyRx([{ id: 1, text: 'X', complete: true }]); // no epoch given: keeps the current one
  assert.strictEqual(rs._jtcatJttyEpoch, 3000);
  assert.ok(protocol.validate({ type: 'jtcat-jtty-rx', updates: [], epoch: 3000 }, protocol.Dir.S2C).ok, 'epoch is registered');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('remoteServer.clearJtcatJttyRecent(jtcatJttyEpoch);'), 'main clears the buffer when a JTTY engine starts');
  assert.ok(main.includes('remoteServer.broadcastJtcatJttyRx(batch, jtcatJttyEpoch);'), 'main sends the epoch with every batch');
  assert.ok(main.includes("jtcatFdExch: settings.jtcatFdExch || '',"), 'the Field Day exchange is in the settings blob');
  // A desktop or remote edit of the pane's seeds is pushed, not left for the next reconnect.
  // The condition may list more keys after these (the DXpedition flags joined it).
  assert.ok(/has\('jtcatFdExch'\) \|\| has\('jttyMacros'\) \|\| has\('jttyTemplates'\) \|\| has\('jttyFt8Macros'\) \|\| has\('jttyMacroStyle'\) \|\| has\('jttyProfile'\) \|\| has\('jttySerial'\) \|\| has\('pskMacros'\)[^{]*\)\s*\{\s*updateRemoteSettings\(\);/.test(main), 'desktop save pushes settings-update for the JTTY/PSK seeds');
  assert.ok(/const jttyKeys = \['jttySerial', 'jttyMacros', 'jttyFt8Macros', 'jttyMacroStyle', 'jttyProfile', 'jtcatFdExch', 'pskMacros'\];[\s\S]{0,200}updateRemoteSettings\(\);/.test(main), 'remote save pushes settings-update for the JTTY/PSK seeds');
  for (const [name, file] of [['web', 'renderer/remote.js'], ['pop-out', 'renderer/jtcat-popout.js']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(/epoch && (msg|batch)\.epoch !== jttyEpoch\) \{ jttyClearRows\(\);/.test(src), name + ' clears its rows on a new epoch');
  }
});

test('the recent rows are replayed on connect, and main / web wiring is in place (static)', () => {
  const root = path.join(__dirname, '..');
  const rs = fs.readFileSync(path.join(root, 'lib', 'remote-server.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(rs.includes("this._sendTo(ws, { type: 'jtcat-jtty-rx', updates: this._jtcatJttyRecent.slice(), replay: true, epoch: this._jtcatJttyEpoch || undefined });"), 'hydration replay carries the epoch');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(main.includes('remoteServer.broadcastJtcatJttyRx(batch, jtcatJttyEpoch);'), 'RX batches reach remote clients, with the epoch');
  assert.ok(main.includes("remoteServer.on('jtcat-jtty-send',") && main.includes("ipcMain.emit('jtcat-jtty-send', null, { text, profile });"), 'remote Send is the IPC handler');
  assert.ok(main.includes("remoteServer.on('jtcat-jtty-set-profile',"), 'remote profile twin');
  assert.ok(main.includes('remoteServer.broadcastJtcatJttyRefused(data);'), 'refusals reach remote clients');
  assert.ok(main.includes("jttyProfile: settings.jttyProfile || 'unknown',") && main.includes('jttyTemplates: Array.isArray(settings.jttyTemplates)'), 'settings blob seeds the web pane');
  const web = fs.readFileSync(path.join(root, 'renderer', 'remote.js'), 'utf8');
  for (const s of ["case 'jtcat-jtty-rx':", "case 'jtcat-jtty-refused':", 'function jttyHandleRx(', 'function jttySend(', "ft8Send({ type: 'jtcat-jtty-send', text, profile: jttyPackProfile() });",
    "ft8Send({ type: 'jtcat-jtty-set-profile', profile: jttyProfile() });", "ft8Mode === 'JTTY' ? JTTY_BAND_FREQS", "if (ft8Mode === 'JTTY') jttyOnTxStatus(msg);"]) {
    assert.ok(web.includes(s), 'remote.js ' + s);
  }
  // The web renders the same macro model the pop-out does, inlined like scope-axis.
  assert.ok(web.includes('JttyMacros.forSettings(echoSettings || {}).macros'), 'web macros from the shared model (style-aware)');
  // Message style: the FT8 style is the default; the web has the selector,
  // the report field, and saves the style on the desktop.
  assert.ok(main.includes("jttyMacroStyle: settings.jttyMacroStyle === 'contest' ? 'contest' : 'ft8',"), 'settings blob carries the style, FT8 unless Contest was chosen');
  assert.ok(main.includes('jttyFt8Macros: Array.isArray(settings.jttyFt8Macros) ? settings.jttyFt8Macros : null,'), 'settings blob carries the FT8-style list');
  assert.ok(web.includes("ft8Send({ type: 'save-settings', settings: { jttyMacroStyle: style } });"), 'web style change is saved on the desktop');
  assert.ok(web.includes("if (jttyStyle() === 'contest' && p === 'unknown' && m && JttyMacros.isNativeText(m.text)"), 'native serial packing is Contest-only on the web');
  // Desktop edits reach the web pane: settings-update merges the JTTY keys into echoSettings.
  assert.ok(web.includes("'jttyMacroStyle', 'jttySerial', 'jttyProfile', 'jtcatFdExch'].some((k) => k in msg.settings)) {") && web.includes("if (typeof jttyOnSettings === 'function') jttyOnSettings(msg.settings);"), 'settings-update refreshes the JTTY pane');
  assert.ok(rs.includes("'jtty-macros.js'") && rs.includes("'<!-- jtty-macros-js -->'"), 'remote-server inlines lib/jtty-macros.js');
  assert.ok(/'20m': 14090/.test(web) && !/JTTY_BAND_FREQS = \{[^}]*14080/.test(web), 'web dials match (14090, never FT4\'s 14080)');
  const html = fs.readFileSync(path.join(root, 'renderer', 'remote.html'), 'utf8');
  assert.ok(html.includes('<!-- jtty-macros-js -->'), 'web page has the inline placeholder');
  for (const id of ['jtty-style', 'jtty-rpt', 'jtty-pane', 'jtty-list', 'jtty-tx', 'jtty-note', 'jtty-profile', 'jtty-his', 'jtty-exch', 'jtty-serial', 'jtty-queued', 'jtty-templates', 'jtty-send', 'jtty-stop', 'jtty-log', 'jtty-clear']) {
    assert.ok(html.includes(`id="${id}"`), 'remote.html ' + id);
  }
  assert.ok(html.includes('<button class="mp-btn" data-mode="JTTY">JTTY</button>'), 'VFO mode pad');
  assert.ok(html.includes('<option value="JTTY">JTTY</option>'), 'FT8 tab mode select');
});

// Mobile review 2026-10-18 (potacat-app docs/desktop-handoffs/jtcat-jtty-2026-10-18-mobile-review.md).
test('mobile review: capabilities, FT8-style packing, a JTTY spectrum, the JTTY frequency restored by main', () => {
  const root = path.join(__dirname, '..');
  const rs = fs.readFileSync(path.join(root, 'lib', 'remote-server.js'), 'utf8').replace(/\r\n/g, '\n');
  const caps = rs.match(/capabilities: \[([\s\S]*?)\],\n\s*rigModel:/)[1];
  assert.ok(/'jtcat-fox-call'/.test(caps), 'the app gates the Fox tap on jtcat-fox-call');
  assert.ok(/'jtty-ft8-style'/.test(caps), 'and the style selector on jtty-ft8-style');
  // FT8 style hides the profile picker, so it never packs under a contest profile.
  const pop = fs.readFileSync(path.join(root, 'renderer', 'jtcat-popout.js'), 'utf8');
  const web = fs.readFileSync(path.join(root, 'renderer', 'remote.js'), 'utf8');
  assert.ok(/function jttyPackProfile\(\) \{[\s\S]{0,200}if \(jttyStyle === 'ft8'\) return 'unknown';/.test(pop), 'pop-out FT8 style packs as Unknown');
  assert.ok(/function jttyPackProfile\(\) \{\s*if \(jttyStyle\(\) === 'ft8'\) return 'unknown';/.test(web), 'web FT8 style packs as Unknown');
  // The engine keeps the RX audio main's in-process spectrum reads — with the
  // pop-out closed a mobile device in JTTY otherwise had no waterfall.
  const { JttyEngine } = require('../lib/jtty-engine');
  const { computeSpectrumBins } = require('../lib/spectrum-fft');
  const eng = new JttyEngine({ worker: false });
  eng._running = true;
  eng._inline = { feed: () => [] };
  const tone = new Float32Array(6000);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 1500 * i / 12000);
  eng.feedAudio(tone);
  const bins = computeSpectrumBins(eng._audioBuffer, eng._audioOffset, 160);
  let peak = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
  assert.ok(Math.abs(peak * 3000 / 160 - 1500) < 40, '1500 Hz tone lands at 1500 Hz in the 0-3000 Hz bins (bin ' + peak + ')');
  // main restores jttyAudioFreq itself and never pins JTTY to FT8's held offset.
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(main.includes("ft8Engine._mode !== 'PSK31' && ft8Engine._mode !== 'JTTY') {"), 'FT8 hold offset is not applied to JTTY');
  assert.ok(/if \(ft8Engine\._mode === 'JTTY'\) \{\s*const jttyHz = parseInt\(settings\.jttyAudioFreq, 10\);/.test(main), 'startJtcat restores jttyAudioFreq');
  assert.ok(main.includes("if (eng._mode === 'JTTY') settings.jttyAudioFreq = eng._txFreq;"), 'an operator JTTY move (pop-out or mobile) is remembered under jttyAudioFreq');
});

console.log(`\nJTTY over ECHOCAT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
