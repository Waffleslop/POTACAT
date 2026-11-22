#!/usr/bin/env node
'use strict';
// A Guest Pass guest never receives the station's secrets.
//   - lib/settings-secrets.js: an SDR receiver's inline station password
//     ("pw@host" / "user:pw@host") is a registered secret; stripForGuest is
//     what a guest's device may see of the station's settings
//   - lib/remote-server.js: auth-ok, settings-update (every push, per
//     device) and pass-resumed carry the guest view to a pass session and
//     the full view to the owner's paired devices
//   - lib/guest-sdr.js: a guest's pick from the stripped list still reaches
//     the owner's own entry, password and all, on the station side
//   - lib/pass-wording.js: every refusal is one plain sentence, never a
//     message or command name
// All passwords below are obvious fakes.
// Run: node test/guest-settings-secrets-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const S = require('../lib/settings-secrets');
const G = require('../lib/guest-sdr');
const A = require('../lib/guest-pass-authority');
const PassWording = require('../lib/pass-wording');
const { RemoteServer } = require('../lib/remote-server');
const { readSrc } = require('./_src');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const FAKE_PW = 'fake-secret-pw';
const FAKE_USER_PW = 'fakeuser:fake-pass-2';
// The settings blob main.js hands remote-server (updateRemoteSettings).
function remoteSettings() {
  return {
    myCallsign: 'K3SBP',
    kiwiSdrHost1: FAKE_PW + '@kiwi.example.org:8073',
    kiwiSdrHost2: 'https://' + FAKE_USER_PW + '@Club.Example.net:8074/',
    kiwiSdrHost3: 'sdr.local:1234',
    kiwiSdrLabel1: 'Hilltop Kiwi', kiwiSdrLabel2: 'Club Kiwi', kiwiSdrLabel3: 'Shack RTL',
    kiwiSdrList: [
      { label: 'Hilltop Kiwi', host: FAKE_PW + '@kiwi.example.org:8073', id: 'hilltop' },
      { label: 'Club Kiwi', host: 'https://' + FAKE_USER_PW + '@Club.Example.net:8074/' },
      { label: 'Shack RTL', host: 'sdr.local:1234' },
    ],
    watchlistGroups: [{ name: 'Friends', url: 'https://lists.example/private?key=fake-list-key', remoteEntries: ['W1AW'] }],
    sstvTemplates: [{ name: 'mine' }],
    watchlist: 'W1AW',
  };
}
const leaks = (obj) => {
  const j = JSON.stringify(obj);
  return [FAKE_PW, 'fake-pass-2', 'fakeuser', 'fake-list-key'].filter((s) => j.includes(s));
};

function fakeWs({ guest } = {}) {
  const ws = { readyState: WebSocket.OPEN, _authenticated: true, sent: [], _socket: { remoteAddress: '127.0.0.1' } };
  ws.send = (wire) => ws.sent.push(JSON.parse(wire));
  ws.close = () => { ws.readyState = WebSocket.CLOSED; };
  if (guest) ws._passSession = { code: 'otter-newt-mosaic-rooster', sessionId: 'x'.repeat(64), passProfile: { guest_callsign: 'W1AW', guest_verified: true } };
  return ws;
}
function serverWith(...clients) {
  const rs = new RemoteServer();
  rs._client = clients[0];
  for (const c of clients) rs._clients.add(c);
  rs.emitted = [];
  const emit = rs.emit.bind(rs);
  rs.emit = (ev, ...args) => { if (ev !== 'log') rs.emitted.push({ ev, args }); return emit(ev, ...args); };
  return rs;
}

console.log('\nthe registry (lib/settings-secrets.js)');
test('an SDR string loses its userinfo and nothing else', () => {
  assert.strictEqual(S.stripSdrUserinfo('secret@host:8073'), 'host:8073');
  assert.strictEqual(S.stripSdrUserinfo('u:p@host'), 'host');
  assert.strictEqual(S.stripSdrUserinfo('https://u:p@Kiwi.example:8074/'), 'https://Kiwi.example:8074/');
  assert.strictEqual(S.stripSdrUserinfo('kiwi.example.org:8073'), 'kiwi.example.org:8073');
  assert.strictEqual(S.sdrUserinfo('u:p@host'), 'u:p');
  assert.strictEqual(S.sdrUserinfo('host:8073'), '');
});
test('stripSecrets (Settings > Export) drops the SDR passwords, keeps label, id and host:port', () => {
  const src = remoteSettings();
  const out = S.stripSecrets(src);
  assert.deepStrictEqual(leaks({ k: out.kiwiSdrHost1, k2: out.kiwiSdrHost2, l: out.kiwiSdrList }), []);
  assert.strictEqual(out.kiwiSdrHost1, 'kiwi.example.org:8073');
  assert.strictEqual(out.kiwiSdrHost2, 'https://Club.Example.net:8074/');
  assert.deepStrictEqual(out.kiwiSdrList[0], { label: 'Hilltop Kiwi', host: 'kiwi.example.org:8073', id: 'hilltop' });
  assert.strictEqual(src.kiwiSdrList[0].host, FAKE_PW + '@kiwi.example.org:8073', 'input not mutated');
});
test('restoreSecrets (Import) grafts the SDR password back onto the same host:port only', () => {
  const cur = remoteSettings();
  const imported = S.stripSecrets(cur);
  imported.kiwiSdrList.push({ label: 'New', host: 'other.example:8073' });
  S.restoreSecrets(imported, cur);
  assert.strictEqual(imported.kiwiSdrHost1, FAKE_PW + '@kiwi.example.org:8073');
  assert.strictEqual(imported.kiwiSdrHost2, 'https://' + FAKE_USER_PW + '@Club.Example.net:8074/');
  assert.strictEqual(imported.kiwiSdrList[0].host, FAKE_PW + '@kiwi.example.org:8073');
  assert.strictEqual(imported.kiwiSdrList[3].host, 'other.example:8073', 'no graft onto another receiver');
  const own = { kiwiSdrHost1: 'their-own@kiwi.example.org:8073' };
  S.restoreSecrets(own, cur);
  assert.strictEqual(own.kiwiSdrHost1, 'their-own@kiwi.example.org:8073', 'an imported password wins');
});
test('stripForGuest: no SDR password, no watchlist-group URL, every registered secret gone', () => {
  const src = { ...remoteSettings(), qrzPassword: 'fake-qrz', cloudAccessToken: 'fake.jwt', pairedDevices: [{ token: 'fake-tok' }] };
  const out = S.stripForGuest(src);
  assert.deepStrictEqual(leaks(out), []);
  for (const k of S.SECRET_KEYS) assert.ok(!(k in out), k);
  assert.ok(!('pairedDevices' in out));
  assert.deepStrictEqual(out.watchlistGroups[0], { name: 'Friends', remoteEntries: ['W1AW'] });
  assert.ok(src.watchlistGroups[0].url, 'input not mutated');
});

console.log('\nwhat reaches a device (lib/remote-server.js)');
test('a pass client\'s auth-ok/settings view never carries "secret@host" or "u:p@host"', () => {
  const guest = fakeWs({ guest: true });
  const rs = serverWith(guest);
  rs._remoteSettings = remoteSettings();
  const view = rs._settingsFor(guest);
  assert.deepStrictEqual(leaks(view), []);
  assert.strictEqual(view.kiwiSdrHost1, 'kiwi.example.org:8073');
  assert.deepStrictEqual(view.kiwiSdrList.map((e) => e.host), ['kiwi.example.org:8073', 'https://Club.Example.net:8074/', 'sdr.local:1234']);
  assert.strictEqual(view.kiwiSdrList[0].id, 'hilltop');
  assert.strictEqual(view.kiwiSdrList[0].label, 'Hilltop Kiwi');
  assert.strictEqual(view.myCallsign, 'W1AW', 'the on-air call, as before');
  assert.ok(!('sstvTemplates' in view) && !('watchlist' in view), 'the earlier guest rules still hold');
});
test('an owner\'s paired device gets exactly what it gets today', () => {
  const owner = fakeWs();
  const rs = serverWith(owner);
  const s = remoteSettings();
  rs._remoteSettings = s;
  assert.strictEqual(rs._settingsFor(owner), s);
  assert.strictEqual(rs._ownerAuthOk(owner).settings, s);
});
test('settings-update goes to each device in its own view: owner full, guest stripped', () => {
  const owner = fakeWs();
  const guest = fakeWs({ guest: true });
  const rs = serverWith(owner, guest); // the owner is this._client
  rs.setRemoteSettings(remoteSettings());
  const o = owner.sent.find((m) => m.type === 'settings-update');
  const g = guest.sent.find((m) => m.type === 'settings-update');
  assert.ok(o && g, 'both told');
  assert.strictEqual(o.settings.kiwiSdrHost1, FAKE_PW + '@kiwi.example.org:8073');
  assert.strictEqual(o.settings.myCallsign, 'K3SBP');
  assert.deepStrictEqual(leaks(g.settings), []);
  assert.strictEqual(g.settings.myCallsign, 'W1AW');
  // and the other way round: the guest as this._client never gives the owner a stripped view
  const owner2 = fakeWs();
  const guest2 = fakeWs({ guest: true });
  const rs2 = serverWith(guest2, owner2);
  rs2.setRemoteSettings(remoteSettings());
  assert.strictEqual(owner2.sent.find((m) => m.type === 'settings-update').settings.kiwiSdrList[0].host, FAKE_PW + '@kiwi.example.org:8073');
  assert.deepStrictEqual(leaks(guest2.sent.find((m) => m.type === 'settings-update').settings), []);
});
test('a guest\'s refused save-settings echoes the stripped view', () => {
  const guest = fakeWs({ guest: true });
  const rs = serverWith(guest);
  rs._remoteSettings = remoteSettings();
  rs._handleMessage(guest, { type: 'save-settings', settings: { myCallsign: 'EVIL' } }, null);
  assert.deepStrictEqual(leaks(guest.sent), []);
});
test('every guest-bound settings push goes through _settingsFor (no raw _remoteSettings to a pass)', () => {
  const src = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  // the auth-ok sent to a pass session, pass-resumed, and the save-settings echo
  assert.ok(/type: 'auth-ok',\s*\n\s*colorblindMode: !!this\._colorblindMode,\s*\n\s*settings: this\._settingsFor\(ws\)/.test(src), 'pass auth-ok');
  assert.ok(/type: 'pass-resumed', settings: this\._settingsFor\(c\)/.test(src), 'pass-resumed');
  assert.ok(!/_sendToAll\(\{ type: 'settings-update'/.test(src), 'settings-update is never one object for every device');
  assert.ok(/return stripForGuest\(rest\)/.test(src), '_settingsFor strips through the registry');
});

console.log('\nthe guest still reaches the owner\'s SDR (lib/guest-sdr.js)');
test('a connect by id or by the stripped host reaches the owner\'s real entry, password included', () => {
  const station = remoteSettings();
  const view = S.stripForGuest(station);
  // by id
  let r = G.resolveSdrConnect({ type: 'kiwi-connect', id: 'hilltop' }, station, { pass: true });
  assert.deepStrictEqual(r, { ok: true, msg: { type: 'kiwi-connect', host: FAKE_PW + '@kiwi.example.org:8073' } });
  // by each host string the guest was given
  for (let i = 0; i < view.kiwiSdrList.length; i++) {
    r = G.resolveSdrConnect({ type: 'kiwi-connect', host: view.kiwiSdrList[i].host }, station, { pass: true });
    assert.ok(r.ok, view.kiwiSdrList[i].host);
    assert.strictEqual(r.msg.host, station.kiwiSdrList[i].host);
  }
  r = G.resolveSdrConnect({ type: 'kiwi-connect', host: view.kiwiSdrHost2 }, station, { pass: true });
  assert.strictEqual(r.msg.host, 'https://' + FAKE_USER_PW + '@Club.Example.net:8074/');
});
test('through the demux: the guest\'s pick goes to main as the owner\'s entry', () => {
  const guest = fakeWs({ guest: true });
  const rs = serverWith(guest);
  rs._remoteSettings = remoteSettings();
  const shown = rs._settingsFor(guest).kiwiSdrList[1].host;
  rs._handleMessage(guest, { type: 'kiwi-connect', host: shown }, null);
  assert.deepStrictEqual(rs.emitted.map((e) => e.ev), ['kiwi-connect']);
  assert.strictEqual(rs.emitted[0].args[0].host, 'https://' + FAKE_USER_PW + '@Club.Example.net:8074/');
  assert.deepStrictEqual(leaks(guest.sent), [], 'nothing sent back to the guest names the password');
});
test('main splits an inline password off before host:port and never logs it', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const i = main.indexOf("remoteServer.on('kiwi-connect'");
  const block = main.slice(i, i + 1600);
  assert.ok(/const inlinePw = sdrUserinfo\(clean\)/.test(block));
  assert.ok(/sendCatLog\(`\[WebSDR\] ECHOCAT connect: "\$\{hostPort\}"`\)/.test(block));
  assert.ok(/password: msg\.password \|\| inlinePw/.test(block));
});

console.log('\nrefusals in plain words (lib/pass-wording.js)');
test('every denied type and rig action has a plain sentence, never its own name', () => {
  const all = [...A.GUEST_DENIED_TYPES, ...A.GUEST_REFUSED_INSIDE, ...[...A.GUEST_DENIED_RIG_ACTIONS].map((a) => 'rig-control:' + a)];
  for (const t of all) {
    const text = A.guestRefusedText(t);
    assert.ok(text && /^[A-Z].*\.$/.test(text), t + ': ' + text);
    assert.ok(!text.includes(t) && !/rig-control|[a-z]+-[a-z]+/.test(text), t + ' leaks a name: ' + text);
    assert.ok(!/Ask the host/.test(text), text);
  }
  for (const t of A.GUEST_DENIED_TYPES) assert.notStrictEqual(A.guestRefusedText(t), PassWording.REFUSAL_FALLBACK, t + ' has its own sentence');
  for (const a of A.GUEST_DENIED_RIG_ACTIONS) {
    assert.notStrictEqual(A.guestRefusedText('rig-control:' + a), PassWording.REFUSAL_FALLBACK, a);
  }
});
test('anything else gets the plain fallback', () => {
  assert.strictEqual(PassWording.REFUSAL_FALLBACK, 'That is not available on a Guest Pass.');
  assert.strictEqual(A.guestRefusedText('some-future-type'), PassWording.REFUSAL_FALLBACK);
  assert.strictEqual(A.guestRefusedText(''), PassWording.REFUSAL_FALLBACK);
  assert.strictEqual(A.guestRefusedText('rig-control:some-future-action'), PassWording.REFUSAL_WORDS.radio);
});
test('the demux sends the sentence; the web client never falls back to msg.of', () => {
  const guest = fakeWs({ guest: true });
  const rs = serverWith(guest);
  rs._handleMessage(guest, { type: 'delete-qso', id: 1 }, null);
  rs._handleMessage(guest, { type: 'rig-control', data: { action: 'send-custom-cat', cmd: 'FA;' } }, null);
  const refused = guest.sent.filter((m) => m.type === 'refused');
  assert.strictEqual(refused[0].text, PassWording.REFUSAL_WORDS.logbook);
  assert.strictEqual(refused.length, 2);
  assert.strictEqual(refused[1].text, PassWording.REFUSAL_WORDS.commands);
  assert.ok(refused.every((m) => !/delete-qso|send-custom-cat/.test(m.text)));
  const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
  assert.ok(!/'Not available on a Guest Pass: ' \+/.test(web), 'no fallback naming the message type');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
