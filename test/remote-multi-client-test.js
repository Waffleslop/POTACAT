#!/usr/bin/env node
'use strict';
// More than one of the owner's devices at a time (desktop-to-desktop Phase C,
// docs/remote-desktop-parity-spec.md). Real RemoteServer, real RemoteClients
// over loopback WSS:
//   - off (the default): the newest device displaces the other, as always
//   - on: both stay; broadcasts reach both; presence names both
//   - PTT is held by whoever keyed: a second press is refused, a second
//     release cannot cut the first device's over, a disconnect releases it
//   - a reply goes to the device that asked; a forwarded QSO to the device
//     that operated (sent to all, it was logged once per device)
//   - the audio link goes to the device that asked last; the other is told
//   - a Guest Pass is never shared (exclusive either way)
// Run: node test/remote-multi-client-test.js
const { X509Certificate } = require('crypto');
const { RemoteServer } = require('../lib/remote-server');
const { RemoteClient } = require('../lib/remote-client');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function collect(rc) {
  const got = [];
  rc.on('message', (m) => got.push(m));
  rc.on('kicked', (m) => got.push({ type: 'kicked', ...m }));
  rc.on('spots', (d) => got.push({ type: 'spots', data: d }));
  rc.on('signal', (d) => got.push({ type: 'signal', data: d }));
  rc.on('qso-attributed', (q) => got.push({ type: 'qso-attributed', qso: q }));
  return got;
}
function client(port, fp, token, name) {
  const rc = new RemoteClient({ id: name, name, lanHost: `wss://127.0.0.1:${port}`, fingerprint: fp, deviceToken: token },
    { clientVersion: 'test', clientPlatform: name.startsWith('phone') ? 'ios' : 'desktop-test' });
  rc.on('log', () => {}); rc.on('error', () => {});
  return rc;
}
async function connected(rc) {
  await new Promise((resolve) => { rc.once('connected', resolve); rc.connect(); setTimeout(resolve, 6000); });
  await sleep(150);
}

(async () => {
  const PORT = 17391;
  const TOKEN = 'multi-client-token-xyz';
  const certDir = require('os').tmpdir();

  // ── off: the old exclusive behaviour ─────────────────────────────
  console.log('multi-client OFF (default)');
  {
    const rs = new RemoteServer();
    rs.start(PORT, TOKEN, { requireToken: true, certDir });
    await sleep(600);
    const fp = new X509Certificate(rs._tlsCertPem).fingerprint256;
    const a = client(PORT, fp, TOKEN, 'laptop'); const ga = collect(a);
    await connected(a);
    const b = client(PORT, fp, TOKEN, 'phone'); collect(b);
    await connected(b);
    await sleep(300);
    check(ga.some(m => m.type === 'kicked'), 'the first device is displaced by the second');
    check(rs._openClients().length === 1, 'one client connected');
    a.close(); b.close(); rs.stop(); await sleep(300);
  }

  // ── on ───────────────────────────────────────────────────────────
  console.log('\nmulti-client ON');
  const rs = new RemoteServer();
  rs.setMultiClient(true);
  const ptts = [];
  rs.on('ptt', (p) => ptts.push(p.state));
  rs.start(PORT + 1, TOKEN, { requireToken: true, certDir });
  await sleep(600);
  const fp = new X509Certificate(rs._tlsCertPem).fingerprint256;
  const a = client(PORT + 1, fp, TOKEN, 'laptop'); const ga = collect(a);
  await connected(a);
  const b = client(PORT + 1, fp, TOKEN, 'phone'); const gb = collect(b);
  await connected(b);
  await sleep(300);
  check(!ga.some(m => m.type === 'kicked'), 'the first device is NOT displaced');
  check(rs._openClients().length === 2, 'both connected');
  const listA = ga.filter(m => m.type === 'clients-list').pop();
  check(listA && listA.clients.length === 2 && listA.clients.filter(c => c.you).length === 1 && listA.multi === true, 'presence: two rows, one marked as the receiver');

  ga.length = 0; gb.length = 0;
  rs.broadcastSpots([{ callsign: 'W1AW', frequency: '7035.0', mode: 'CW', source: 'POTA', reference: 'US-0001' }]);
  await sleep(300);
  check(ga.some(m => m.type === 'spots') && gb.some(m => m.type === 'spots'), 'a broadcast reaches both');

  // attribution
  ga.length = 0; gb.length = 0;
  a.sendTune({ frequency: 14074000, mode: 'USB' });
  await sleep(300);
  const note = gb.find(m => m.type === 'client-action');
  check(note && note.action === 'tune' && note.freqKhz === '14074.000' && note.by && note.by.name, 'the other device is told who tuned where');
  check(!ga.some(m => m.type === 'client-action'), 'the device that tuned is not told about itself');

  // PTT ownership
  ga.length = 0; gb.length = 0;
  a.sendPtt(true);
  await sleep(200);
  b.sendPtt(true);
  await sleep(200);
  check(ptts.filter(Boolean).length === 1, 'only the first press keyed');
  check(gb.some(m => m.type === 'ptt-refused' && /transmitting/.test(m.message)), 'the second press is refused out loud');
  b.sendPtt(false);
  await sleep(200);
  check(rs._pttActive === true, 'the second device\'s release does not cut the first one\'s over');
  const keyedRow = ga.filter(m => m.type === 'clients-list').pop();
  check(keyedRow && keyedRow.clients.some(c => c.keyed && c.you), 'presence shows who holds PTT');
  a.close();
  await sleep(400);
  check(rs._pttActive === false && ptts[ptts.length - 1] === false, 'the transmitting device leaving releases PTT');
  check(rs._openClients().length === 1, 'the other device stays connected');

  // one transmitter across devices: CW / FT8 / SSTV from another device are refused while one keys
  const b2 = b; const gb2 = gb;
  const a1 = client(PORT + 1, fp, TOKEN, 'laptopX'); const ga1 = collect(a1);
  await connected(a1);
  gb2.length = 0;
  a1.sendPtt(true);
  await sleep(200);
  const cwSeen = [];
  rs.on('cw-text', (m) => cwSeen.push(m));
  b2.sendRaw({ type: 'cw-text', text: 'CQ' });
  b2.sendRaw({ type: 'cw-key', at: 1, down: true });
  b2.sendRaw({ type: 'jtcat-call-cq', modifier: '' });
  await sleep(250);
  check(cwSeen.length === 0 && gb2.filter(m => m.type === 'ptt-refused').length === 3, 'CW text, a paddle element and an FT8 CQ are refused while another device holds PTT');
  // a forced unkey updates presence
  ga1.length = 0;
  rs.forcePttRelease();
  await sleep(200);
  const afterForce = ga1.filter(m => m.type === 'clients-list').pop();
  check(afterForce && !afterForce.clients.some(c => c.keyed), 'a forced unkey clears keyed in presence');
  b2.sendRaw({ type: 'cw-text', text: 'CQ' });
  await sleep(200);
  check(cwSeen.length === 1, 'after the unkey the other device may send');
  a1.close();
  await sleep(300);

  // reconnect A; replies and forwarded QSOs
  const a2 = client(PORT + 1, fp, TOKEN, 'laptop2'); const ga2 = collect(a2);
  await connected(a2);
  ga2.length = 0; gb.length = 0;
  b.sendRaw({ type: 'set-mode', mode: 'CW' });      // phone operated last
  await sleep(200);
  rs.sendToActor({ type: 'qso-attributed', qso: { callsign: 'K1ABC' } });
  await sleep(200);
  check(gb.some(m => m.type === 'qso-attributed') && !ga2.some(m => m.type === 'qso-attributed'), 'a forwarded QSO goes only to the device that operated');
  const ctx = rs.activeClientContext();
  check(ctx && ctx.platform === 'ios', 'activeClientContext is the operating device');
  b.sendRaw({ type: 'get-all-qsos' });
  await sleep(100);
  ga2.length = 0; gb.length = 0;
  rs.sendAllQsos([{ callsign: 'W1AW' }]);
  await sleep(200);
  check(gb.some(m => m.type === 'all-qsos') && !ga2.some(m => m.type === 'all-qsos'), 'a reply goes to the device that asked');

  // audio
  ga2.length = 0; gb.length = 0;
  a2.sendStartAudio();
  await sleep(150);
  b.sendStartAudio();
  await sleep(200);
  check(ga2.some(m => m.type === 'audio-moved'), 'the device that had the audio is told it moved');
  rs.relaySignalToClient({ type: 'sdp', sdp: 'x' });
  await sleep(200);
  check(gb.some(m => m.type === 'signal') && !ga2.some(m => m.type === 'signal'), 'audio signalling goes to the device that asked last');
  const audioRow = ga2.filter(m => m.type === 'clients-list').pop();
  check(audioRow && audioRow.clients.filter(c => c.audio).length === 1 && !audioRow.clients.find(c => c.you).audio, 'presence says which device has the audio');

  // auth-ok says who has the audio, so a newcomer need not take it
  {
    const c3 = client(PORT + 1, fp, TOKEN, 'tablet');
    const info = await new Promise((resolve) => { c3.once('connected', resolve); c3.connect(); setTimeout(() => resolve(null), 6000); });
    check(info && info.audioHeldBy && info.audioHeldBy.platform === 'ios', 'auth-ok carries audioHeldBy (the device holding the bridge)');
    c3.close();
    await sleep(200);
    const srv = rs;
    const self = { readyState: 1, _pairedDevice: { id: 'same' } };
    srv._audioWs = { readyState: 1, _pairedDevice: { id: 'same' } };
    check(srv._audioHeldByFor(self) === null, 'null when the holder is this same device reconnecting');
    srv._audioWs = { readyState: 1, _passSession: { code: 'g' } };
    check(srv._audioHeldByFor(self) === null, 'null when the holder is a Guest Pass');
    srv._audioWs = b._ws ? [...srv._clients].find(c => c._clientPlatform === 'ios') : null;
  }

  // jtcat-owner 'shack' goes to the device that ran FT8, not to everyone
  ga2.length = 0; gb.length = 0;
  a2.sendRaw({ type: 'jtcat-start', mode: 'FT8' });
  await sleep(150);
  b.sendRaw({ type: 'set-mode', mode: 'USB' }); // the phone operates something else
  await sleep(150);
  rs.sendToJtcatOwner({ type: 'jtcat-owner', owner: 'shack', message: 'x' });
  await sleep(200);
  check(ga2.some(m => m.type === 'jtcat-owner') && !gb.some(m => m.type === 'jtcat-owner'), 'only the device that ran FT8 hears the shack took it back');

  a2.close(); b.close(); rs.stop();
  await sleep(300);

  // A Guest Pass is never shared, whichever side arrives first.
  console.log('\nGuest Pass stays exclusive');
  {
    const srv = new RemoteServer();
    srv.setMultiClient(true);
    const fake = (extra) => {
      const ws = { readyState: 1, _authenticated: true, sent: [], closed: false, close() { this.closed = true; this.readyState = 3; }, ...extra };
      return ws;
    };
    srv._sendTo = (ws, m) => { if (ws && ws.sent) ws.sent.push(m); };
    const owner = fake({ _pairedDevice: { id: 'p1' } });
    srv._admitClient(owner, null);
    const guest = fake({ _passSession: { code: 'abc' } });
    srv._admitClient(guest, null);
    // Lend my rig (2026-10-27): the owner's devices are not kicked; they leave
    // the shared set and wait for Take over (pass-guest-waiting).
    check(!owner.closed && owner._ownerWaiting && !srv._clients.has(owner) && owner.sent.some(m => m.type === 'pass-guest-waiting'),
      'a guest arriving moves the owner\'s devices to waiting, never sharing the rig');
    // _admitClient is the primitive; an owner device reaching it while a guest
    // holds the rig has already passed the wait gate (_ownerMustWait), i.e.
    // the rig is paused or the guest is gone, so the guest socket goes.
    const owner2 = fake({ _pairedDevice: { id: 'p2' } });
    srv._admitClient(owner2, null);
    check(guest.closed, 'an owner device admitted past the gate displaces the guest');
    const sameAgain = fake({ _pairedDevice: { id: 'p2' } });
    srv._admitClient(sameAgain, null);
    check(owner2.closed && !sameAgain.closed, 'the same device reconnecting replaces its own stale socket');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
