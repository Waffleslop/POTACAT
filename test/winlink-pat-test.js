// Unit tests for lib/winlink-pat.js — Pat launch decisions and wire parsers.
// Run: node test/winlink-pat-test.js
'use strict';

const assert = require('assert');
const W = require('../lib/winlink-pat');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('binary + paths');
test('binary name per platform', () => {
  assert.strictEqual(W.patBinaryName('win32'), 'pat.exe');
  assert.strictEqual(W.patBinaryName('linux'), 'pat');
});
test('override first, then bundled resources/bin, never the bare name', () => {
  const c = W.patPathCandidates({ settings: { winlinkPatPath: 'D:\\x\\pat.exe' }, isPackaged: true, resourcesPath: 'C:\\R', platform: 'win32' });
  assert.strictEqual(c[0], 'D:\\x\\pat.exe');
  assert.strictEqual(c[1], 'C:\\R\\bin\\pat.exe');
  assert.ok(!c.includes('pat.exe'));
  const dev = W.patPathCandidates({ appDir: '/app', platform: 'linux' });
  assert.strictEqual(dev[0], '/app/assets/pat/pat');
});

console.log('args');
test('always `http`, every path POTACAT\'s, never --listen or --send-only', () => {
  const a = W.buildPatArgs({ configPath: 'c.json', mboxDir: 'mb', logPath: 'p.log', eventLogPath: 'e.json', formsDir: 'f' });
  assert.deepStrictEqual(a, ['--config', 'c.json', '--mbox', 'mb', '--log', 'p.log', '--event-log', 'e.json', '--forms', 'f', 'http']);
  assert.ok(!a.some((x) => /listen|send-only|-l$|-s$/.test(x)));
});

console.log('config');
test('internet-only shape: loopback API, no rigs, no modems, no schedule, no listen', () => {
  const c = W.buildPatConfig({ mycall: 'k3sbp', password: 'secret1', grid: 'FN20jb12', httpPort: 8591 });
  assert.strictEqual(c.mycall, 'K3SBP');
  assert.strictEqual(c.locator, 'FN20jb');
  assert.strictEqual(c.http_addr, '127.0.0.1:8591');
  assert.deepStrictEqual(c.listen, []);
  assert.deepStrictEqual(c.schedule, {});
  assert.deepStrictEqual(c.hamlib_rigs, {});
  assert.ok(!c.ardop && !c.varahf);
  assert.strictEqual(c.auto_download_size_limit, -1);
  assert.strictEqual(c.gpsd.enable_http, false);
});
test('radio shape: every transport keys through the POTACAT shim', () => {
  const c = W.buildPatConfig({ mycall: 'K3SBP', httpPort: 8591, shimPort: 4541, transport: { ardopBw: 2000, varaAddr: '127.0.0.1:8300', varaBw: 2750 } });
  assert.deepStrictEqual(c.hamlib_rigs, { potacat: { address: '127.0.0.1:4541', network: 'tcp' } });
  assert.strictEqual(c.ardop.rig, 'potacat');
  assert.strictEqual(c.ardop.ptt_ctrl, true);
  assert.deepStrictEqual(c.ardop.arq_bandwidth, { Forced: false, Max: 2000 });
  assert.strictEqual(c.ardop.cwid_enabled, true);
  assert.strictEqual(c.varahf.rig, 'potacat');
  assert.strictEqual(c.varahf.ptt_ctrl, true);
  assert.strictEqual(c.varahf.bandwidth, 2750);
  assert.deepStrictEqual(c.listen, []);
});
test('a bandwidth outside the 2.8 kHz-legal set falls back', () => {
  const c = W.buildPatConfig({ mycall: 'K3SBP', httpPort: 1, shimPort: 2, transport: { ardopBw: 9999, varaBw: 4000 } });
  assert.strictEqual(c.ardop.arq_bandwidth.Max, 500);
  assert.strictEqual(c.varahf.bandwidth, 2300);
});
test('a bad grid gives no locator rather than a wrong one', () => {
  assert.strictEqual(W.patLocator('ZZ99'), '');
  assert.strictEqual(W.patLocator('fn20'), 'fn20');
});

console.log('connect URLs');
test('telnet is the alias', () => assert.strictEqual(W.connectUrl({ mode: 'telnet' }), 'telnet'));
test('ARDOP carries the DIAL in kHz', () => {
  assert.strictEqual(W.connectUrl({ mode: 'ardop', gateway: 'w1aw-10', dialKhz: 7101.5 }), 'ardop:///W1AW-10?freq=7101.5');
});
test('Mercury and VARA both go out on Pat\'s varahf transport', () => {
  assert.strictEqual(W.connectUrl({ mode: 'mercury', gateway: 'K7EK-10', dialKhz: 14105, bw: 2300 }), 'varahf:///K7EK-10?bw=2300&freq=14105');
  assert.strictEqual(W.connectUrl({ mode: 'vara', gateway: 'K7EK-10' }), 'varahf:///K7EK-10');
});
test('a gateway that is not a callsign is refused', () => {
  assert.strictEqual(W.connectUrl({ mode: 'ardop', gateway: 'x?freq=1' }), null);
  assert.strictEqual(W.connectUrl({ mode: 'pactor', gateway: 'W1AW' }), null);
});

test('a list row URL is used when it names the same gateway and transport (keeps bw=2000MAX)', () => {
  assert.strictEqual(W.sessionUrl({ mode: 'ardop', gateway: 'KG4OCM', dialKhz: 7102.1, rowUrl: 'ardop:///KG4OCM?bw=2000MAX&freq=7102.1' }), 'ardop:///KG4OCM?bw=2000MAX&freq=7102.1');
  assert.strictEqual(W.sessionUrl({ mode: 'mercury', gateway: 'K7EK-10', dialKhz: 14105, rowUrl: 'varahf:///K7EK-10?bw=2300&freq=14105' }), 'varahf:///K7EK-10?bw=2300&freq=14105');
});
test('a row URL for another gateway, another transport or a host is ignored', () => {
  const built = 'ardop:///KG4OCM?freq=7102.1';
  assert.strictEqual(W.sessionUrl({ mode: 'ardop', gateway: 'KG4OCM', dialKhz: 7102.1, rowUrl: 'ardop:///W1AW-10?bw=2000MAX&freq=7101' }), built);
  assert.strictEqual(W.sessionUrl({ mode: 'ardop', gateway: 'KG4OCM', dialKhz: 7102.1, rowUrl: 'varahf:///KG4OCM?freq=7102.1' }), built);
  assert.strictEqual(W.sessionUrl({ mode: 'ardop', gateway: 'KG4OCM', dialKhz: 7102.1, rowUrl: 'telnet://evil.example.com:8772/wl2k' }), built);
  assert.strictEqual(W.sessionUrl({ mode: 'telnet', rowUrl: 'ardop:///KG4OCM' }), 'telnet');
});

console.log('rmslist');
const RMS = [
  { callsign: 'W1AW-10', gridsquare: 'FN31', distance: 120.4, azimuth: 45.6, modes: 'ARDOP 2000', freq: { hz: 7103000, khz: 7103 }, dial: { hz: 7101500, khz: 7101.5 }, url: 'ardop:///W1AW-10?freq=7101.5', prediction: { link_quality: 72 } },
  { callsign: 'N0XYZ-10', gridsquare: 'EM29', distance: 1500, azimuth: 270, modes: 'ARDOP 500', freq: { hz: 14108500 }, dial: { hz: 14107000 }, url: 'ardop:///N0XYZ-10?freq=14107' },
  { gridsquare: 'junk' },
];
test('rows keep Pat\'s order and carry the dial', () => {
  const r = W.normalizeRmslist(RMS);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].call, 'W1AW-10');
  assert.strictEqual(r[0].dialKhz, 7101.5);
  assert.strictEqual(r[0].band, '40m');
  assert.strictEqual(r[0].quality, 72);
  assert.strictEqual(r[0].distKm, 120);
});
test('band filter is by the dial\'s band', () => {
  assert.deepStrictEqual(W.normalizeRmslist(RMS, { band: '20m' }).map((x) => x.call), ['N0XYZ-10']);
});

console.log('messages');
const PATMSG = {
  MID: 'ABC123XYZ', Date: '2026-10-22T14:00:00Z', From: { Proto: '', Addr: 'W1AW' },
  To: [{ Proto: 'SMTP', Addr: 'friend@example.com' }, { Proto: '', Addr: 'K3SBP' }], Cc: null,
  Subject: 'Hi', Files: [{ Name: 'map.jpg', Size: 2048 }], P2POnly: false, Unread: true,
};
test('a Pat message becomes POTACAT\'s shape; unread only counts in the inbox', () => {
  const m = W.normalizeMessage(PATMSG, 'in');
  assert.strictEqual(m.mid, 'ABC123XYZ');
  assert.strictEqual(m.from, 'W1AW');
  assert.deepStrictEqual(m.to, ['friend@example.com', 'K3SBP']);
  assert.deepStrictEqual(m.attachments, [{ name: 'map.jpg', size: 2048 }]);
  assert.strictEqual(m.read, false);
  assert.ok(!('body' in m), 'list form has no body');
  assert.strictEqual(W.normalizeMessage(PATMSG, 'sent').read, true);
  assert.strictEqual(W.normalizeMessage({ ...PATMSG, Body: 'text' }, 'in').body, 'text');
});

console.log('compose');
test('recipients split on commas, semicolons and spaces; RFC3339 date; CRLF body', () => {
  const r = W.composeFields({ to: 'W1AW, friend@example.com; K3SBP', subject: 'Test', body: 'a\nb', date: '2026-10-22T14:00:00.123Z' });
  assert.ok(r.ok);
  assert.strictEqual(r.fields.to, 'W1AW,friend@example.com,K3SBP');
  assert.strictEqual(r.fields.date, '2026-10-22T14:00:00Z');
  assert.strictEqual(r.fields.body, 'a\r\nb');
  assert.ok(!('p2ponly' in r.fields));
});
test('no recipient / no subject / a junk address are refused with a reason', () => {
  assert.match(W.composeFields({ subject: 's' }).error, /recipient/);
  assert.match(W.composeFields({ to: 'W1AW' }).error, /subject/);
  assert.match(W.composeFields({ to: 'not@valid', subject: 's' }).error, /not a callsign/);
});

console.log('websocket events');
test('Pat frames classify by their one key', () => {
  assert.strictEqual(W.classifyPatEvent({ Ping: true }).kind, 'ping');
  assert.strictEqual(W.classifyPatEvent({ MyCall: 'K3SBP' }).mycall, 'K3SBP');
  const s = W.classifyPatEvent({ Status: { connected: true, dialing: false, remote_addr: 'W1AW-10' } });
  assert.strictEqual(s.kind, 'status'); assert.strictEqual(s.connected, true);
  const p = W.classifyPatEvent({ Progress: { bytes_transferred: 50, bytes_total: 200, mid: 'M', subject: 'S', sending: true, done: false } });
  assert.deepStrictEqual([p.kind, p.direction, p.pct], ['progress', 'sending', 25]);
  assert.strictEqual(W.classifyPatEvent({ Prompt: { id: '7', kind: 'busy-channel', message: 'Waiting' } }).prompt, 'busy-channel');
  assert.strictEqual(W.classifyPatEvent({ PromptAbort: { id: '7' } }).kind, 'prompt-abort');
  assert.strictEqual(W.classifyPatEvent({ UpdateMailbox: true }).kind, 'mailbox-changed');
  assert.strictEqual(W.classifyPatEvent({ Whatever: 1 }).kind, 'unknown');
});
test('log lines that need an operator are named', () => {
  assert.strictEqual(W.classifyPatLine('*** Secure login failed, account password does not match'), 'login-failed');
  assert.strictEqual(W.classifyPatLine('Waiting for clear channel...'), 'busy');
  assert.strictEqual(W.classifyPatLine('dial tcp 127.0.0.1:8515: connectex: No connection could be made because the target machine actively refused it.'), 'transport-down');
  assert.strictEqual(W.classifyPatLine('Connecting to W1AW-10 (ardop)...'), 'log');
});
test('POTACAT answers the password prompt from the profile, never the busy channel', () => {
  assert.strictEqual(W.autoPromptAnswer({ kind: 'prompt', prompt: 'password' }, { password: 'pw1234' }), 'pw1234');
  assert.strictEqual(W.autoPromptAnswer({ kind: 'prompt', prompt: 'password' }, {}), null);
  assert.strictEqual(W.autoPromptAnswer({ kind: 'prompt', prompt: 'busy-channel' }, { password: 'x' }), null);
  assert.strictEqual(W.autoPromptAnswer({ kind: 'prompt', prompt: 'multi-select', options: [{ value: 'a' }, { value: 'b' }] }), 'a,b');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
