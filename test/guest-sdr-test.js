#!/usr/bin/env node
'use strict';
// GitHub #543: a Guest Pass guest may switch to, tune and leave the SDRs the
// owner has already set up at the station; a receiver the guest names itself
// stays refused, nothing a guest sends edits the SDR list, and every refusal
// is plain words with no message names in it.
//   - lib/guest-sdr.js: the pure rule
//   - lib/remote-server.js demux: what reaches main, what the guest is told
// Run: node test/guest-sdr-test.js
const assert = require('assert');
const WebSocket = require('ws');
const G = require('../lib/guest-sdr');
const A = require('../lib/guest-pass-authority');
const PassWording = require('../lib/pass-wording');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

// What the station shares: the full list plus the legacy slot view.
const SETTINGS = {
  kiwiSdrList: [
    { label: 'Shack RTL', host: 'sdr.local:1234' },
    { label: 'Hilltop Kiwi', host: 'https://Kiwi.Example.org:8073/', id: 'hilltop' },
    { label: 'Club Kiwi', host: 'clubpw@club.example.net' },
  ],
  kiwiSdrHost1: 'sdr.local:1234', kiwiSdrLabel1: 'Shack RTL',
  kiwiSdrHost2: 'https://Kiwi.Example.org:8073/', kiwiSdrLabel2: 'Hilltop Kiwi',
  kiwiSdrHost3: 'clubpw@club.example.net', kiwiSdrLabel3: 'Club Kiwi',
};
const REFUSAL = PassWording.SDR_NOT_OWNERS;

console.log('the rule');
test('the words are plain: no message names, no "Ask the host"', () => {
  assert.strictEqual(REFUSAL, "On a Guest Pass you can use the station's own SDRs, not add a new one.");
  assert.ok(!/kiwi|connect|tune|settings|-/.test(REFUSAL), REFUSAL);
});
test('host normalising: scheme, slash, inline password and case are ignored; no port = 8073', () => {
  assert.strictEqual(G.normalizeSdrHost('https://pw@Host.Example:8074/').key, 'host.example:8074');
  assert.strictEqual(G.normalizeSdrHost('kiwi.example.org').key, 'kiwi.example.org:8073');
  assert.strictEqual(G.normalizeSdrHost('192.168.1.20:1234').key, '192.168.1.20:1234');
  assert.strictEqual(G.normalizeSdrHost(''), null);
  assert.strictEqual(G.normalizeSdrHost('host:99999'), null);
  assert.strictEqual(G.normalizeSdrHost('host:abc'), null);
});
test('the owner\'s entries: list first, slot view folded in, no duplicates', () => {
  const e = G.ownerSdrEntries(SETTINGS);
  assert.deepStrictEqual(e.map(x => x.key), ['sdr.local:1234', 'kiwi.example.org:8073', 'club.example.net:8073']);
  assert.strictEqual(e[1].id, 'hilltop');
  assert.deepStrictEqual(G.ownerSdrEntries({ kiwiSdrHost: 'old.example:8073' }).map(x => x.key), ['old.example:8073'], 'the oldest key counts');
  assert.deepStrictEqual(G.ownerSdrEntries(null), []);
});
test('a configured SDR is allowed: by exact host:port, by id, or no host (the first one)', () => {
  let r = G.resolveSdrConnect({ type: 'kiwi-connect', host: 'sdr.local:1234' }, SETTINGS, { pass: true });
  assert.deepStrictEqual(r, { ok: true, msg: { type: 'kiwi-connect', host: 'sdr.local:1234' } });
  r = G.resolveSdrConnect({ type: 'kiwi-connect', host: 'kiwi.example.org' }, SETTINGS, { pass: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.msg.host, 'https://Kiwi.Example.org:8073/', 'main gets the owner\'s own entry');
  r = G.resolveSdrConnect({ type: 'kiwi-connect', id: 'hilltop' }, SETTINGS, { pass: true });
  assert.strictEqual(r.msg.host, 'https://Kiwi.Example.org:8073/');
  r = G.resolveSdrConnect({ type: 'kiwi-connect' }, SETTINGS, { pass: true });
  assert.strictEqual(r.msg.host, 'sdr.local:1234');
  // the station password comes from the owner's entry, never the guest
  r = G.resolveSdrConnect({ type: 'kiwi-connect', host: 'club.example.net:8073', password: 'guess' }, SETTINGS, { pass: true });
  assert.deepStrictEqual(r.msg, { type: 'kiwi-connect', host: 'clubpw@club.example.net' });
});
test('a typed-in host is refused: another host, another port, a bad id, an id that disagrees with its host, no list', () => {
  for (const m of [
    { host: 'evil.example.com:8073' },
    { host: 'sdr.local:1235' },
    { host: 'sdr.local' },                 // 8073, not the configured 1234
    { host: 'sdr.local:1234.evil.com' },
    { id: 'nope' },
    { id: 'hilltop', host: 'evil.example.com' },
  ]) {
    const r = G.resolveSdrConnect({ type: 'kiwi-connect', ...m }, SETTINGS, { pass: true });
    assert.deepStrictEqual(r, { ok: false, text: REFUSAL }, JSON.stringify(m));
  }
  assert.strictEqual(G.resolveSdrConnect({ type: 'kiwi-connect' }, {}, { pass: true }).ok, false, 'no SDR configured');
});
test('a non-pass client is unchanged: whatever it sends goes through as sent', () => {
  const m = { type: 'kiwi-connect', host: 'anything.example:9999', password: 'pw' };
  assert.deepStrictEqual(G.resolveSdrConnect(m, SETTINGS), { ok: true, msg: m });
  assert.deepStrictEqual(G.resolveSdrConnect(m, SETTINGS, { pass: false }), { ok: true, msg: m });
});
test('an SDR settings write is recognised; other settings are not', () => {
  assert.ok(G.isSdrSettingsWrite({ kiwiSdrList: [{ label: 'x', host: 'evil:1' }] }));
  assert.ok(G.isSdrSettingsWrite({ kiwiSdrHost2: 'evil:1' }));
  assert.ok(G.isSdrSettingsWrite({ kiwiSdrLabel1: 'renamed' }));
  assert.strictEqual(G.isSdrSettingsWrite({ myCallsign: 'X' }), false);
  assert.strictEqual(G.isSdrSettingsWrite(null), false);
});
test('the three SDR types pass the Guest Pass wall; save-settings stays refused inside its case', () => {
  for (const t of G.GUEST_SDR_TYPES) {
    assert.ok(A.GUEST_TYPES.has(t), t);
    assert.ok(!A.GUEST_DENIED_TYPES.has(t), t);
  }
  assert.ok(A.GUEST_REFUSED_INSIDE.has('save-settings'));
});

// ── the demux ──────────────────────────────────────────────────────────
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
  rs._remoteSettings = SETTINGS;
  rs.emitted = [];
  const emit = rs.emit.bind(rs);
  rs.emit = (ev, ...args) => { if (ev !== 'log') rs.emitted.push({ ev, args }); return emit(ev, ...args); };
  return rs;
}

console.log('\nthe demux');
test('a guest connects to and tunes a configured SDR, and leaves it', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'kiwi-connect', host: 'sdr.local:1234' }, null);
  rs._handleMessage(ws, { type: 'kiwi-tune', freqKhz: '14074', mode: 'usb' }, null);
  rs._handleMessage(ws, { type: 'kiwi-connect', host: 'kiwi.example.org:8073' }, null); // switch
  rs._handleMessage(ws, { type: 'kiwi-disconnect' }, null);
  assert.deepStrictEqual(rs.emitted.map(e => e.ev), ['kiwi-connect', 'kiwi-tune', 'kiwi-connect', 'kiwi-disconnect']);
  assert.deepStrictEqual(rs.emitted[0].args[0], { type: 'kiwi-connect', host: 'sdr.local:1234' });
  assert.deepStrictEqual(rs.emitted[1].args[0], { freqKhz: '14074', mode: 'usb' });
  assert.strictEqual(rs.emitted[2].args[0].host, 'https://Kiwi.Example.org:8073/');
  assert.deepStrictEqual(ws.sent.filter(m => m.type === 'refused'), []);
});
test('a guest\'s typed-in host is refused in words and never reaches main', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'kiwi-connect', host: 'evil.example.com:8073', reqId: 'k1' }, null);
  assert.deepStrictEqual(rs.emitted, []);
  assert.deepStrictEqual(ws.sent, [{ type: 'refused', reason: 'guest-pass', of: 'kiwi-connect', text: REFUSAL, reqId: 'k1' }]);
});
test('a guest\'s SDR settings write is refused: nothing saved, the screen snaps back, the words say why', () => {
  const ws = fakeWs({ guest: true });
  const rs = serverWith(ws);
  rs._handleMessage(ws, { type: 'save-settings', settings: { kiwiSdrList: [{ label: 'Mine', host: 'evil.example.com:1234' }], kiwiSdrHost1: 'evil.example.com:1234' } }, null);
  assert.deepStrictEqual(rs.emitted, [], 'nothing reached main');
  assert.deepStrictEqual(ws.sent.map(m => m.type), ['settings-update', 'refused']);
  assert.strictEqual(ws.sent[1].text, REFUSAL);
  // any other settings write keeps its old answer, no refusal toast
  const ws2 = fakeWs({ guest: true });
  const rs2 = serverWith(ws2);
  rs2._handleMessage(ws2, { type: 'save-settings', settings: { myCallsign: 'EVIL' } }, null);
  assert.deepStrictEqual(ws2.sent.map(m => m.type), ['settings-update']);
});
test('the owner is unchanged: any host goes to main as sent, settings are saved', () => {
  const ws = fakeWs();
  const rs = serverWith(ws);
  const m = { type: 'kiwi-connect', host: 'brand-new.example:8073', password: 'pw' };
  rs._handleMessage(ws, m, null);
  rs._handleMessage(ws, { type: 'save-settings', settings: { kiwiSdrHost1: 'brand-new.example:8073' } }, null);
  assert.deepStrictEqual(rs.emitted.map(e => e.ev), ['kiwi-connect', 'save-settings']);
  assert.deepStrictEqual(rs.emitted[0].args[0], m);
  assert.deepStrictEqual(ws.sent.filter(x => x.type === 'refused'), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
