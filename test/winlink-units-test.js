// Unit tests for the Winlink support modules: lib/winlink-state.js,
// lib/rigctld-server.js (incl. a real loopback socket), lib/ardop-process.js,
// lib/winlink-modes.js, and lib/winlink-client.js against a fake Pat
// (HTTP + /ws — ping/pong and prompt answers).
// Run: node test/winlink-units-test.js
'use strict';

const assert = require('assert');
const net = require('net');
const http = require('http');
const { WebSocketServer } = require('ws');
const { WinlinkState } = require('../lib/winlink-state');
const R = require('../lib/rigctld-server');
const A = require('../lib/ardop-process');
const M = require('../lib/winlink-modes');
const { WinlinkClient } = require('../lib/winlink-client');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

(async () => {
  console.log('winlink-state');
  await test('unread counts the inbox only; markRead and remove', () => {
    const s = new WinlinkState();
    s.applyMailbox('in', [{ mid: 'a', read: false }, { mid: 'b', read: true }, { mid: 'c', read: false }]);
    s.applyMailbox('sent', [{ mid: 'x', read: true }]);
    assert.strictEqual(s.totalUnread, 2);
    assert.ok(s.markRead('a'));
    assert.ok(!s.markRead('a'), 'already read');
    assert.strictEqual(s.totalUnread, 1);
    assert.ok(s.remove('in', 'c'));
    assert.deepStrictEqual(s.counts(), { in: 2, out: 0, sent: 1, archive: 0 });
    assert.ok(!s.applyMailbox('spam', []));
  });
  await test('a session starts fresh, rejects unknown states, counts finished transfers', () => {
    const s = new WinlinkState();
    s.setSession({ state: 'connected', sent: 9 });
    s.setSession({ state: 'starting', mode: 'ardop', gateway: 'W1AW-10', capSec: 1800 });
    assert.strictEqual(s.session.sent, 0);
    assert.ok(!s.setSession({ state: 'exploded' }));
    s.setSession({ state: 'connected' });
    s.applyProgress({ direction: 'sending', bytes: 100, total: 100, pct: 100, done: true });
    s.applyProgress({ direction: 'receiving', bytes: 10, total: 40, pct: 25, done: false });
    assert.strictEqual(s.session.sent, 1);
    assert.strictEqual(s.session.received, 0);
    assert.strictEqual(s.session.pct, 25);
    const rem = s.remainingSec(s.session.startedAt + 60000);
    assert.strictEqual(rem, 1740);
  });
  await test('a folder list is capped at the newest 500; total and counts say how many exist', () => {
    const s = new WinlinkState();
    const many = Array.from({ length: 620 }, (_, i) => ({ mid: 'M' + i, read: true }));
    s.applyMailbox('archive', many);
    assert.strictEqual(s.list('archive').length, 500);
    assert.strictEqual(s.list('archive')[0].mid, 'M0', 'newest first, as Pat lists');
    assert.strictEqual(s.total('archive'), 620);
    assert.strictEqual(s.counts().archive, 620);
    s.remove('archive', 'M0');
    assert.strictEqual(s.total('archive'), 619);
  });
  await test('the snapshot carries no message bodies and a stable shape', () => {
    const s = new WinlinkState();
    s.applyMailbox('in', [{ mid: 'a', read: false, body: 'secret' }]);
    const snap = s.snapshot({ enabled: true });
    assert.ok(!JSON.stringify(snap).includes('secret'));
    for (const k of ['enabled', 'patReady', 'modes', 'unread', 'counts', 'session', 'autoCheck']) assert.ok(k in snap, k);
  });

  console.log('rigctld shim');
  await test('Pat\'s six commands, and the one-letter forms', () => {
    const hooks = { getFreqHz: () => 7101500, setFreqHz: () => true, getPtt: () => true, setPtt: () => true };
    const r = (l) => R.rigctldReply(R.parseRigctldLine(l), hooks);
    assert.deepStrictEqual(r('dump_caps'), ['Model name:\tPOTACAT']);
    assert.deepStrictEqual(r('\\chk_vfo'), ['CHKVFO 0']);
    assert.deepStrictEqual(r('\\get_freq'), ['7101500']);
    assert.deepStrictEqual(r('f'), ['7101500']);
    assert.deepStrictEqual(r('\\set_freq 7101500'), ['RPRT 0']);
    assert.deepStrictEqual(r('\\set_freq VFOA 7101500'), ['RPRT 0']);
    assert.deepStrictEqual(r('t'), ['1']);
    assert.deepStrictEqual(r('\\set_ptt 1'), ['RPRT 0']);
    assert.deepStrictEqual(r('\\set_ptt 3'), ['RPRT 0']);
    assert.deepStrictEqual(r('T 0'), ['RPRT 0']);
    assert.deepStrictEqual(r('\\set_level RFPOWER 1'), ['RPRT -11']);
  });
  await test('every reply is ONE line (Pat reads one line per command)', () => {
    const hooks = { getFreqHz: () => 1, setFreqHz: () => true, getPtt: () => false, setPtt: () => true };
    for (const l of ['dump_caps', '\\chk_vfo', '\\get_freq', '\\set_freq 1', 't', '\\set_ptt 0', 'zz']) {
      assert.strictEqual(R.rigctldReply(R.parseRigctldLine(l), hooks).length, 1, l);
    }
  });
  await test('a refused action answers RPRT -1; nonsense values are refused before any hook', () => {
    let called = 0;
    const hooks = { setFreqHz: () => { called++; return false; }, setPtt: () => { called++; return false; } };
    assert.deepStrictEqual(R.rigctldReply(R.parseRigctldLine('\\set_ptt 1'), hooks), ['RPRT -1']);
    assert.deepStrictEqual(R.rigctldReply(R.parseRigctldLine('\\set_freq 7101500'), hooks), ['RPRT -1']);
    assert.strictEqual(called, 2);
    assert.deepStrictEqual(R.rigctldReply(R.parseRigctldLine('\\set_freq abc'), hooks), ['RPRT -1']);
    assert.deepStrictEqual(R.rigctldReply(R.parseRigctldLine('\\set_ptt 9'), hooks), ['RPRT -1']);
    assert.strictEqual(called, 2);
  });
  await test('binds loopback only', () => {
    assert.throws(() => R.createRigctldServer({}, { host: '0.0.0.0' }), /loopback only/);
    assert.throws(() => R.createRigctldServer({}, { host: '192.168.1.5' }), /loopback only/);
  });
  await test('a real socket, Pat-style CRLF exchange, one reply per line', async () => {
    const log = [];
    let ptt = false;
    const srv = R.createRigctldServer({ getFreqHz: () => 14105000, setFreqHz: (hz) => { log.push(['F', hz]); return true; }, getPtt: () => ptt, setPtt: (on) => { ptt = on; log.push(['T', on]); return true; } });
    const port = await srv.listen(0);
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const lines = [];
    let buf = '';
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    const ask = async (cmd, n) => { sock.write(cmd + '\r\n'); for (let k = 0; k < 50 && lines.length < n; k++) await new Promise((r) => setTimeout(r, 10)); };
    await ask('dump_caps', 1);
    await ask('\\chk_vfo', 2);
    await ask('\\get_freq', 3);
    await ask('\\set_freq 7101500', 4);
    await ask('\\set_ptt 1', 5);
    await ask('t', 6);
    assert.deepStrictEqual(lines, ['Model name:\tPOTACAT', 'CHKVFO 0', '14105000', 'RPRT 0', 'RPRT 0', '1']);
    assert.deepStrictEqual(log, [['F', 7101500], ['T', true]]);
    sock.destroy();
    await srv.close();
  });

  console.log('ardopcf');
  await test('never a PTT or CAT flag; host commands carry MYCALL and the drive level', () => {
    const a = A.buildArdopArgs({ port: 8515, capture: '2', playback: '3', logDir: 'L', driveLevel: 85, mycall: 'k3sbp' });
    assert.deepStrictEqual(a, ['--logdir', 'L', '--hostcommands', 'MYCALL K3SBP;DRIVELEVEL 85', '8515', '2', '3']);
    for (const f of A.FORBIDDEN_FLAGS) assert.ok(!a.includes(f), f);
    assert.ok(A.buildArdopArgs({ driveLevel: 500 }).includes('DRIVELEVEL 100'));
  });
  await test('Windows listing: indexes and names, the not-found error ignored', () => {
    const out = 'ardopcf Version 1.0.4.1.3\nCapture Devices\n0 Microphone (Realtek(R) Audio)\n1 Microphone (USB Audio CODEC )\nPlayback Devices\n0 Speakers (Realtek(R) Audio)\n1 Speakers (USB Audio CODEC )\nERROR: playbackdevice = \'POTACAT-LIST-DEVICES\' not found.\n';
    const d = A.parseArdopDeviceList(out);
    assert.deepStrictEqual(d.capture, [{ id: '0', name: 'Microphone (Realtek(R) Audio)' }, { id: '1', name: 'Microphone (USB Audio CODEC )' }]);
    assert.strictEqual(d.playback[1].id, '1');
  });
  await test('Linux listing: plughw ids with the card name', () => {
    const out = 'Playback Devices\nCard 1, ID `CODEC\', name `USB Audio CODEC\'\n  Device hw:1,0 ID `USB Audio\', name `USB Audio\', 1 subdevices (1 available)\nCapture Devices\nCard 1, ID `CODEC\', name `USB Audio CODEC\'\n  Device hw:1,0 ID `USB Audio\', name `USB Audio\', 1 subdevices (1 available)\n';
    const d = A.parseArdopDeviceList(out);
    assert.deepStrictEqual(d.capture, [{ id: 'plughw:1,0', name: 'USB Audio (USB Audio CODEC)' }]);
    assert.strictEqual(d.playback.length, 1);
  });
  await test('Chromium labels resolve to the CURRENT index; a missing device is named', () => {
    const devices = { capture: [{ id: '0', name: 'Microphone (Realtek(R) Audio)' }, { id: '3', name: 'Microphone (USB Audio CODEC )' }], playback: [{ id: '0', name: 'Speakers (Realtek(R) Audio)' }, { id: '2', name: 'Speakers (USB Audio CODEC )' }] };
    const r = A.resolveArdopDevices({ captureLabel: 'Microphone (USB Audio CODEC ) (08bb:2902)', playbackLabel: 'Speakers (USB Audio CODEC ) (08bb:2902)', devices });
    assert.ok(r.ok);
    assert.strictEqual(r.capture, '3');
    assert.strictEqual(r.playback, '2');
    const miss = A.resolveArdopDevices({ captureLabel: 'Line (DAX Audio RX 1)', playbackLabel: 'Speakers (USB Audio CODEC )', devices });
    assert.ok(!miss.ok);
    assert.match(miss.missing[0], /DAX Audio RX 1/);
  });
  await test('a real Windows listing (31-char names): each DAX channel resolves to ITS index', () => {
    const fs = require('fs');
    const d = A.parseArdopDeviceList(fs.readFileSync(require('path').join(__dirname, 'fixtures/winlink/ardopcf-list-windows.txt'), 'utf8'));
    assert.ok(d.capture.length >= 20 && d.playback.length >= 10, `${d.capture.length} capture, ${d.playback.length} playback`);
    const byName = (n) => d.capture.find((x) => x.name.startsWith(n)).id;
    assert.strictEqual(A.matchArdopDevice('DAX Audio RX 1 (FlexRadio Systems DAX Audio)', d.capture).id, byName('DAX Audio RX 1 '));
    assert.strictEqual(A.matchArdopDevice('DAX Audio RX 2 (FlexRadio Systems DAX Audio)', d.capture).id, byName('DAX Audio RX 2 '));
    assert.strictEqual(A.matchArdopDevice('Default - Mic In (Elgato Wave:3) (0fd9:0070)', d.capture).id, '0');
    // A name picked from the list itself (what Settings saves) is an exact match.
    assert.strictEqual(A.matchArdopDevice(d.capture[22].name, d.capture).id, d.capture[22].id);
    assert.strictEqual(A.matchArdopDevice('DAX Audio TX (FlexRadio Systems DAX TX)', d.playback), null, 'not in this list → refused, never a guess');
  });
  await test('two equally good matches are refused, never guessed', () => {
    const devices = { capture: [{ id: '1', name: 'USB Audio CODEC' }, { id: '2', name: 'USB Audio CODEC' }], playback: [] };
    assert.strictEqual(A.matchArdopDevice('Microphone (USB Audio CODEC)', devices.capture), null);
  });
  await test('stdout lines that need action are named', () => {
    assert.strictEqual(A.classifyArdopLine("ERROR: capturedevice = 'X' not found.  Try using one of the names"), 'device-error');
    assert.strictEqual(A.classifyArdopLine('bind failed: Address already in use'), 'port-busy');
    assert.strictEqual(A.ardopSupported('darwin'), false);
  });

  console.log('winlink-modes');
  await test('telnet everywhere; radio modes need CAT, a sound device, and the right OS', () => {
    const base = { rigFamily: 'serial', audioSource: 'dax', platform: 'win32', mercuryEnabled: true, mercuryPort: 8300, varaPort: 8301, ardopFound: true, showVara: true };
    const ok = M.winlinkModesFor(base);
    assert.deepStrictEqual(ok.map((m) => [m.id, m.available]), [['telnet', true], ['ardop', true], ['mercury', true], ['vara', true]]);
    const flex = M.winlinkModesFor({ ...base, rigFamily: 'flex', audioSource: 'smartsdr' });
    assert.ok(flex.filter((m) => m.id !== 'telnet').every((m) => !m.available && /Flex Direct/.test(m.reason)));
    const icom = M.winlinkModesFor({ ...base, rigFamily: 'icom-network', audioSource: 'icom-network' });
    assert.ok(/Icom Network/.test(icom[1].reason));
    const mac = M.winlinkModesFor({ ...base, platform: 'darwin' });
    assert.ok(!mac[1].available && /macOS/.test(mac[1].reason));
    assert.ok(!mac[3].available && /Windows/.test(mac[3].reason));
    assert.ok(mac[2].available, 'Mercury runs on macOS');
    const noCat = M.winlinkModesFor({ ...base, rigFamily: 'none' });
    assert.ok(noCat.slice(1).every((m) => !m.available));
    const remote = M.winlinkModesFor({ ...base, remote: true });
    assert.ok(remote.slice(1).every((m) => /shack/.test(m.reason)));
  });
  await test('VARA on Mercury\'s port is refused with the reason; Mercury off is named', () => {
    const clash = M.winlinkModesFor({ rigFamily: 'serial', audioSource: 'dax', platform: 'win32', mercuryEnabled: true, mercuryPort: 8300, varaPort: 8300, ardopFound: true, showVara: true });
    assert.ok(!clash[3].available && /same port/.test(clash[3].reason));
    const off = M.winlinkModesFor({ rigFamily: 'serial', audioSource: 'dax', platform: 'win32', mercuryEnabled: false, ardopFound: true });
    assert.ok(!off[2].available && /Mercury/.test(off[2].reason));
  });
  await test('VARA is not offered unless the hidden switch is on', () => {
    const m = M.winlinkModesFor({ rigFamily: 'serial', audioSource: 'dax', platform: 'win32', ardopFound: true });
    assert.deepStrictEqual(m.map((x) => x.id), ['telnet', 'ardop', 'mercury']);
  });
  await test('pickWinlinkMode falls back to telnet', () => {
    const modes = [{ id: 'telnet', available: true }, { id: 'ardop', available: false }];
    assert.strictEqual(M.pickWinlinkMode(modes, 'ardop'), 'telnet');
    assert.strictEqual(M.pickWinlinkMode(modes, 'telnet'), 'telnet');
    assert.ok(M.isRadioMode('mercury') && !M.isRadioMode('telnet'));
  });

  console.log('winlink-client against a fake Pat');
  await test('HTTP shapes, multipart send, Pong to a Ping, prompt answered on the socket', async () => {
    const seen = { posted: null, pong: false, promptResp: null, connectUrl: null };
    const server = http.createServer((req, res) => {
      let body = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        body = Buffer.concat(body).toString('latin1');
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/mailbox/in') { res.end(JSON.stringify([{ MID: 'M1', From: { Addr: 'W1AW' }, To: [{ Addr: 'K3SBP' }], Subject: 'Hi', Unread: true, Files: [] }])); return; }
        if (u.pathname === '/api/mailbox/out' && req.method === 'POST') { seen.posted = body; res.statusCode = 201; res.end('Message posted (1 kB)'); return; }
        if (u.pathname === '/api/mailbox/in/M1/read' && req.method === 'POST') { seen.readBody = body; res.end(''); return; }
        if (u.pathname === '/api/connect') { seen.connectUrl = u.searchParams.get('url'); res.end(JSON.stringify({ NumReceived: 2 })); return; }
        if (u.pathname === '/api/rmslist') { res.end(JSON.stringify([{ callsign: 'W1AW-10', freq: { hz: 7103000 }, dial: { hz: 7101500 }, modes: 'ARDOP 2000', url: 'ardop:///W1AW-10?freq=7101.5' }])); return; }
        res.statusCode = 404; res.end('nope');
      });
    });
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ MyCall: 'K3SBP' }));
      ws.on('message', (d) => {
        const v = JSON.parse(String(d));
        if (v.Pong) seen.pong = true;
        if (v.prompt_response) seen.promptResp = v.prompt_response;
      });
      setTimeout(() => { ws.send(JSON.stringify({ Ping: true })); ws.send(JSON.stringify({ Prompt: { id: 'p1', kind: 'busy-channel', message: 'Waiting for clear channel...' } })); }, 30);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const c = new WinlinkClient({ port: server.address().port, timeoutMs: 3000 });
    const events = [];
    c.on('event', (ev) => {
      events.push(ev.kind);
      if (ev.kind === 'prompt') c.respondPrompt(ev.id, 'abort');
    });
    c.openEvents();
    const inbox = await c.mailbox('in');
    assert.strictEqual(inbox[0].mid, 'M1');
    assert.strictEqual(inbox[0].read, false);
    await c.send({ to: 'W1AW', subject: 'S', body: 'B', date: '2026-10-22T14:00:00Z' }, [{ name: 'a.txt', data: Buffer.from('hello') }]);
    assert.ok(/name="to"\r\n\r\nW1AW/.test(seen.posted));
    assert.ok(/name="files"; filename="a.txt"/.test(seen.posted));
    await c.markRead('in', 'M1');
    assert.deepStrictEqual(JSON.parse(seen.readBody), { Read: true }, 'Pat decodes {"Read": bool}; an empty body is an EOF 400');
    assert.strictEqual(await c.connect('ardop:///W1AW-10?freq=7101.5'), 2);
    assert.strictEqual(seen.connectUrl, 'ardop:///W1AW-10?freq=7101.5');
    const gw = await c.rmslist({ mode: 'ardop', band: '40m' });
    assert.strictEqual(gw[0].dialKhz, 7101.5);
    for (let k = 0; k < 50 && !(seen.pong && seen.promptResp); k++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen.pong, 'answered Ping with Pong');
    assert.deepStrictEqual(seen.promptResp, { id: 'p1', value: 'abort' });
    assert.ok(events.includes('hello') && events.includes('prompt') && !events.includes('ping'));
    await assert.rejects(() => c.message('in', 'nope'), /HTTP 404/);
    c.close();
    wss.close();
    await new Promise((r) => server.close(r));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
