// Simpler pairing (2026-11-25), on a real ECHOCAT server (fixed port 17366):
//   - a pairing-screen token mints a trusted device and tells main it was
//     used, so the screen replaces it at once (a used or failed code is never
//     left on screen);
//   - a revoked token (screen closed) no longer pairs;
//   - tap-to-pair carries the six-digit number, a pairv 2 phone must send a
//     long requestId, and NOTHING pairs without the Approve click, even while
//     the pairing screen is open;
//   - "Allow tap-to-pair from the local network" off still refuses;
//   - the mDNS advert is republished when the pairing screen opens or closes.
// Run: node test/pairing-server-test.js
'use strict';

const https = require('https');
const { RemoteServer } = require('../lib/remote-server');
const PairingSession = require('../lib/pairing-session');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', () => resolve({ status: -1, json: null }));
    req.end(body);
  });
}

(async () => {
  console.log('=== simpler pairing on the server ===');
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  const popups = [];
  const redeemed = [];
  rs.on('pair-request', (p) => popups.push(p));
  rs.on('pairing-token-redeemed', (e) => redeemed.push(e));
  rs.start(17366, null, { requireToken: true, mdns: false });
  await sleep(500);
  const port = rs._port;
  const fp = rs._certFingerprint();

  // 1. A pairing-screen token: trusted device, and main hears it was used.
  {
    const tok = rs.createPairingToken({ ttlMs: PairingSession.TOKEN_TTL_MS, trusted: true });
    const r = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Pixel 8', devicePlatform: 'android' });
    check(r.status === 200 && r.json && r.json.deviceToken, 'screen token pairs');
    const dev = rs._pairedDevices.find((d) => d.id === (r.json && r.json.deviceId));
    check(dev && dev.trusted === true && dev.expiresAt === null, 'the operator\'s own phone is a trusted, no-expiry device');
    check(redeemed.length === 1 && redeemed[0].token === tok && redeemed[0].deviceId === dev.id,
      'pairing-token-redeemed tells the screen which code was used (it is replaced at once)');
    const again = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Copy' });
    check(again.status === 401, 'still single-use');
  }

  // 2. The older QR token keeps today's guest-tier device.
  {
    const tok = rs.createPairingToken({});
    const r = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Old QR' });
    const dev = rs._pairedDevices.find((d) => d.id === (r.json && r.json.deviceId));
    check(dev && dev.trusted === false && typeof dev.expiresAt === 'number', 'older QR path unchanged (sliding-expiry device)');
  }

  // 3. Screen closed: its codes are revoked and no longer pair.
  {
    const tok = rs.createPairingToken({ trusted: true });
    check(rs.hasPairingToken(tok), 'hasPairingToken sees a live code');
    rs.revokePairingToken(tok);
    check(!rs.hasPairingToken(tok), 'revoked');
    const r = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Late' });
    check(r.status === 401, 'a code from a closed screen does not pair');
  }

  // 4. Tap-to-pair with the pairing screen open: number shown, no auto-approve.
  rs.setAdvertState({ pairingOpen: true });
  {
    const short = await post(port, '/api/pair-request', { deviceName: 'iPhone', requestId: 'short', pairv: 2 });
    check(short.status === 400 && short.json && short.json.error === 'request_id_too_short', 'pairv 2 phone with a short requestId is refused');
    const rid = 'rid-' + 'a'.repeat(28);
    const devicesBefore = rs._pairedDevices.length;
    const held = post(port, '/api/pair-request', { deviceName: 'iPhone', devicePlatform: 'ios', requestId: rid, pairv: 2 });
    await sleep(400);
    check(popups.length === 1, 'the Approve window is raised');
    check(popups[0] && popups[0].code === PairingSession.pairCode(fp, rid) && /^\d{6}$/.test(popups[0].code), 'it carries the six-digit number both screens compute');
    check(popups[0] && popups[0].phoneShowsCode === true, 'a pairv 2 phone shows the number too');
    check(rs._pairedDevices.length === devicesBefore, 'open pairing screen + request: NOTHING is paired without the click');
    rs.approvePairRequest(rid);
    const r = await held;
    check(r.status === 200 && r.json && r.json.deviceToken, 'the Approve click pairs');
  }
  {
    popups.length = 0;
    const rid = 'old-phone-request';
    const held = post(port, '/api/pair-request', { deviceName: 'Old iPhone', requestId: rid });
    await sleep(300);
    check(popups[0] && popups[0].phoneShowsCode === false, 'an older phone: the window says it shows no number');
    rs.denyPairRequest(rid);
    const r = await held;
    check(r.status === 403, 'Deny still refuses');
  }

  // 5. "Allow tap-to-pair" off refuses, pairing screen open or not.
  {
    rs.setAllowPairRequests(false);
    const r = await post(port, '/api/pair-request', { deviceName: 'X', requestId: 'z'.repeat(20), pairv: 2 });
    check(r.status === 403 && r.json && r.json.error === 'pair_requests_disabled', 'tap-to-pair off: refused even with the pairing screen open');
    rs.setAllowPairRequests(true);
  }

  // 6. The advert is republished when the pairing screen opens or closes.
  {
    let republished = 0;
    const orig = rs._startMdns.bind(rs);
    rs._startMdns = (c) => { republished++; return orig(c); };
    rs.setAdvertState({ pairingOpen: false });
    check(republished === 1, 'closing the screen republishes the advert');
    rs.setAdvertState({ pairingOpen: false });
    check(republished === 1, 'no change, no republish');
    rs.setAdvertState({ pairingOpen: true, cloudDeviceId: 'abc' });
    check(republished === 2, 'opening it republishes');
  }

  // 7. Two-step pairing: a failed fingerprint check
  //    on the Cloud leg must not use up the code.
  {
    redeemed.length = 0;
    const devicesBefore = rs._pairedDevices.length;
    const tok = rs.createPairingToken({ trusted: true });
    const r = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Cloud phone', confirm: 1 });
    check(r.status === 200 && r.json && r.json.confirmRequired === true && r.json.deviceToken, 'confirm:1 gets credentials marked confirmRequired');
    check(rs._pairedDevices.length === devicesBefore && redeemed.length === 0, 'held: no device saved, the screen is not told the code was used');
    const thief = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Someone else' });
    check(thief.status === 401, 'held: nobody else can use the code meanwhile');
    check(rs.hasPairingToken(tok), 'held: the screen still counts the code as alive (no renewal mid-check)');
    const no = await post(port, '/api/pair-confirm', { deviceToken: r.json.deviceToken, ok: false });
    check(no.status === 200 && no.json && no.json.released === true, 'ok:false releases');
    check(rs._pairedDevices.length === devicesBefore, 'released: nothing saved');
    const retry = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Cloud phone', confirm: 1 });
    check(retry.status === 200 && retry.json && retry.json.confirmRequired, 'released: the SAME code pairs again (it was not used up)');
    const late = await post(port, '/api/pair-confirm', { deviceToken: r.json.deviceToken, ok: true });
    check(late.status === 404, 'the released credentials cannot be confirmed later');
    const yes = await post(port, '/api/pair-confirm', { deviceToken: retry.json.deviceToken, ok: true });
    check(yes.status === 200 && yes.json && yes.json.committed === true, 'ok:true commits');
    check(rs._pairedDevices.some((d) => d.token === retry.json.deviceToken), 'committed: device saved');
    check(redeemed.length === 1 && redeemed[0].token === tok, 'committed: the screen replaces the code');
    check(!rs.hasPairingToken(tok), 'committed: the code is used up');
    const bad = await post(port, '/api/pair-confirm', { deviceToken: 'nope', ok: true });
    check(bad.status === 404, 'unknown deviceToken: 404');
    const junk = await post(port, '/api/pair-confirm', { deviceToken: 'x' });
    check(junk.status === 400, 'no ok flag: 400');
  }
  {
    // Lost confirm: connecting with the token is the confirmation.
    const tok = rs.createPairingToken({});
    const r = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Lost confirm', confirm: 1 });
    const d = rs._findDeviceByToken(r.json.deviceToken);
    check(d && rs._pairedDevices.includes(d), 'a WebSocket auth with a held token commits it');
  }
  {
    // Screen closed while held: the code does not come back.
    const tok = rs.createPairingToken({ trusted: true });
    const r = await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Closed', confirm: 1 });
    rs.revokePairingToken(tok);
    await post(port, '/api/pair-confirm', { deviceToken: r.json.deviceToken, ok: false });
    check(!rs.hasPairingToken(tok), 'a code revoked while held is not restored on release');
  }
  {
    // No answer: released after the hold time.
    rs._heldPairs.holdMs = 200;
    const tok = rs.createPairingToken({});
    const before = rs._pairedDevices.length;
    await post(port, '/api/pair', { pairingToken: tok, deviceName: 'Silent', confirm: 1 });
    await sleep(400);
    check(rs._pairedDevices.length === before && rs._pairingTokens.has(tok), 'no confirm in time: released, code valid again');
    rs._heldPairs.holdMs = 60000;
  }
  {
    // Share links get the same protection.
    const link = rs.createPairLink({ ttlMs: 3600000, trust: 'owned' });
    const r = await post(port, '/api/pair', { pairingToken: link.token, deviceName: 'Laptop', confirm: 1 });
    check(r.json && r.json.confirmRequired, 'share link: held too');
    await post(port, '/api/pair-confirm', { deviceToken: r.json.deviceToken, ok: false });
    const row = rs.listPendingPairLinks().find((l) => l.token === link.token);
    check(row && !row.used, 'share link: released, not marked used');
    const r2 = await post(port, '/api/pair', { pairingToken: link.token, deviceName: 'Laptop' });
    check(r2.status === 200, 'share link: an old client (no confirm) still pairs in one step');
  }

  rs.stop();
  await sleep(100);
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
