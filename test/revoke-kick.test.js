// Revoke must actively disconnect the live session (revoke-kick-desktop).
// Verifies: revoking the connected device sends {type:'revoked'} then
// closes with 4004 AUTH_REVOKED and kills CAT control immediately;
// revoking a non-connected device leaves the live client alone; a
// reconnect with the revoked token gets auth-fail and never re-auths.
// In the npm-test chain since 2026-11-23, in SERIAL (fixed port 17310, real-time waits).
// Run: node test/revoke-kick.test.js

'use strict';

const { RemoteServer } = require('../lib/remote-server');
const WebSocket = require('ws');

const PORT = 17310;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function assert(cond, label) {
  if (!cond) throw new Error('assert failed: ' + label);
  console.log('  ✓ ' + label);
}

// Dial the server as a paired device: hello → auth{token}. Resolves with
// the socket once auth-ok OR auth-fail arrives (caller inspects `events`).
function connectDevice(port, token, label, events) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://127.0.0.1:' + port, { rejectUnauthorized: false });
    const timer = setTimeout(() => reject(new Error(label + ': no auth response in 5s')), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 'test', clientPlatform: 'test' }));
      ws.send(JSON.stringify({ type: 'auth', token }));
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      events.push([label, m.type, m.reason || '']);
      if (m.type === 'auth-ok' || m.type === 'auth-fail') { clearTimeout(timer); resolve(ws); }
    });
    ws.on('close', code => events.push([label, 'CLOSE', code]));
    ws.on('error', () => {});
  });
}

(async () => {
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  const devA = rs.mintPairedDevice({ deviceName: 'PhoneA', devicePlatform: 'ios-test' });
  const devB = rs.mintPairedDevice({ deviceName: 'PhoneB', devicePlatform: 'ios-test' });
  rs.start(PORT, null, { requireToken: true });
  await sleep(500);

  let tunes = 0;
  rs.on('tune', () => tunes++);

  const events = [];
  const wsA = await connectDevice(rs._port, devA.token, 'A', events);
  assert(events.some(e => e[0] === 'A' && e[1] === 'auth-ok'), 'device A authenticates');

  wsA.send(JSON.stringify({ type: 'tune', freqKhz: '14074' }));
  await sleep(300);
  assert(tunes === 1, 'QSY works before revoke');

  // Revoke a paired-but-not-connected device: no crash, A untouched.
  assert(rs.revokeDevice(devB.id) === true, 'revoking idle device B returns true');
  await sleep(300);
  assert(wsA.readyState === WebSocket.OPEN, 'A stays connected when B is revoked');

  // Revoke the live device: revoked message + close 4004 within ~1s.
  assert(rs.revokeDevice(devA.id) === true, 'revoking live device A returns true');
  await sleep(800);
  assert(events.some(e => e[0] === 'A' && e[1] === 'revoked'), 'A received {type:revoked} before close');
  const closeEvt = events.find(e => e[0] === 'A' && e[1] === 'CLOSE');
  assert(closeEvt && closeEvt[2] === 4004, 'A socket closed with 4004 AUTH_REVOKED (got ' + JSON.stringify(closeEvt) + ')');

  tunes = 0;
  try { wsA.send(JSON.stringify({ type: 'tune', freqKhz: '7074' })); } catch {}
  await sleep(300);
  assert(tunes === 0, 'QSY after revoke never reaches the rig');

  // Reconnect with the revoked token: auth-fail, never auth-ok.
  const events2 = [];
  await connectDevice(rs._port, devA.token, 'A2', events2);
  assert(events2.some(e => e[1] === 'auth-fail'), 'reconnect with revoked token gets auth-fail');
  assert(!events2.some(e => e[1] === 'auth-ok'), 'revoked token never re-authenticates');

  // Desktop-as-client: RemoteClient must surface 'revoked' and stop
  // reconnecting (the device token is gone; a redial would only hit a
  // terminal auth-fail).
  const { RemoteClient } = require('../lib/remote-client');
  const crypto = require('crypto');
  const devC = rs.mintPairedDevice({ deviceName: 'LaptopC', devicePlatform: 'desktop-test' });
  const fp = (new crypto.X509Certificate(rs._tlsCertPem)).fingerprint256;
  const cEvents = [];
  const rc = new RemoteClient(
    { id: devC.id, name: 'Test shack', deviceToken: devC.token, lanHost: 'wss://127.0.0.1:' + rs._port, fingerprint: fp },
    { clientVersion: 'test', clientPlatform: 'desktop-test' }
  );
  rc.on('connecting', () => cEvents.push('connecting'));
  rc.on('connected', () => cEvents.push('connected'));
  rc.on('revoked', () => cEvents.push('revoked'));
  rc.connect();
  await sleep(1500);
  assert(cEvents.includes('connected'), 'RemoteClient connects as device C');

  const dialsBefore = cEvents.filter(e => e === 'connecting').length;
  rs.revokeDevice(devC.id);
  await sleep(1500);
  assert(cEvents.includes('revoked'), 'RemoteClient emits revoked');
  assert(cEvents.filter(e => e === 'connecting').length === dialsBefore,
    'RemoteClient does not redial after revoked');
  rc.close();

  rs.stop();
  await sleep(100);
  console.log('PASS: revoke kicks the live session, spares others, blocks re-auth');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
