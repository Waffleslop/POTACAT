#!/usr/bin/env node
'use strict';
// ECHOCAT WebSocket size limits (lib/ws-limits.js, 2026-11-23):
//   1. every frame larger than WS_MAX_PAYLOAD (16 MiB) is refused by ws with
//      close 1009, on every socket;
//   2. until a socket has signed in, a frame larger than PRE_AUTH_MAX_FRAME
//      (64 KiB) closes it (1009, "Frame too large before sign-in") before it
//      is parsed; hello and auth are far under it; a LAN auto-authenticated
//      socket is signed in from its first frame;
//   3. an sstv-photo image over SSTV_IMAGE_MAX (4 MiB) is refused with
//      sstv-tx-status {state, error} to the sender and never reaches the
//      encoder (main's 'sstv-photo' listener);
//   4. signed-in sockets still carry the largest real frames: a 640x496 PNG
//      picture (1.7 MB) and a voice clip just under 4 MiB.
// Real RemoteServer on 127.0.0.1 with a token, raw ws clients. Nothing transmits.
// Run: node test/ws-limits-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { readSrc } = require('./_src');
const L = require('../lib/ws-limits');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' - ' + String(e.message).split('\n')[0]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const MiB = 1024 * 1024;

// ── pure rules ─────────────────────────────────────────────────────
console.log('lib/ws-limits.js');
t('the limits, largest first, with headroom over the measured frames', () => {
  assert.strictEqual(L.WS_MAX_PAYLOAD, 16 * MiB);
  assert.strictEqual(L.PRE_AUTH_MAX_FRAME, 64 * 1024);
  assert.strictEqual(L.SSTV_IMAGE_MAX, 4 * MiB);
  assert.strictEqual(L.VOICE_PLAY_AUDIO_MAX, 4 * MiB);
  // The biggest real frame is a voice clip at its cap or a settings save with
  // every SSTV template at the sync limits (about 4.3 MiB).
  assert.ok(L.WS_MAX_PAYLOAD >= 3 * Math.max(L.SSTV_IMAGE_MAX, L.VOICE_PLAY_AUDIO_MAX, 24 * (150 + 32) * 1024));
  // The largest picture: a 640x496 RGBA PNG of noise is 1.69 MB as a data URL.
  assert.ok(L.SSTV_IMAGE_MAX >= 2 * 1694302);
  assert.strictEqual(L.CLOSE_TOO_BIG, 1009);
  assert.ok(Buffer.byteLength(L.PRE_AUTH_CLOSE_REASON) <= 123, 'a close reason fits in a control frame');
});
t('frameBytes counts every ws payload shape', () => {
  assert.strictEqual(L.frameBytes(Buffer.alloc(10)), 10);
  assert.strictEqual(L.frameBytes([Buffer.alloc(3), Buffer.alloc(4)]), 7);
  assert.strictEqual(L.frameBytes(new ArrayBuffer(5)), 5);
  assert.strictEqual(L.frameBytes('abé'), 4);
  assert.strictEqual(L.frameBytes(null), 0);
});
t('preAuthFrameTooBig: only an unauthenticated socket, only over the limit', () => {
  const at = Buffer.alloc(L.PRE_AUTH_MAX_FRAME), over = Buffer.alloc(L.PRE_AUTH_MAX_FRAME + 1);
  assert.strictEqual(L.preAuthFrameTooBig(at, false), false);
  assert.strictEqual(L.preAuthFrameTooBig(over, false), true);
  assert.strictEqual(L.preAuthFrameTooBig(over, true), false);
});
t('checkSstvImage', () => {
  assert.deepStrictEqual(L.checkSstvImage('data:image/jpeg;base64,AAAA'), { ok: true });
  assert.deepStrictEqual(L.checkSstvImage('x'.repeat(L.SSTV_IMAGE_MAX)), { ok: true });
  assert.deepStrictEqual(L.checkSstvImage('x'.repeat(L.SSTV_IMAGE_MAX + 1)), { ok: false, error: L.SSTV_TOO_LARGE_ERROR });
  assert.strictEqual(L.checkSstvImage('').ok, false);
  assert.strictEqual(L.checkSstvImage({ length: 1 }).ok, false);
  assert.ok(/^Picture not sent: /.test(L.SSTV_TOO_LARGE_ERROR), 'the sstv-tx-status error wording');
});
t('remote-server uses the shared limits (no second copy)', () => {
  const src = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
  assert.ok(/maxPayload:\s*WsLimits\.WS_MAX_PAYLOAD/.test(src), 'the WebSocketServer has maxPayload');
  assert.ok(!/const VOICE_PLAY_AUDIO_MAX\s*=/.test(src), 'VOICE_PLAY_AUDIO_MAX lives in lib/ws-limits.js');
  // Every ws server in lib/ and main.js sets maxPayload.
  for (const f of fs.readdirSync(path.join(ROOT, 'lib')).filter((n) => n.endsWith('.js')).map((n) => path.join('lib', n)).concat(['main.js'])) {
    const s = readSrc(path.join(ROOT, f));
    const servers = s.match(/new\s+(?:WebSocket\.Server|WebSocketServer)\s*\(/g) || [];
    if (!servers.length) continue;
    assert.ok((s.match(/maxPayload\s*:/g) || []).length >= servers.length, f + ' creates a ws server without maxPayload');
  }
});

// ── a real shack ───────────────────────────────────────────────────
const TOKEN = 'ws-limits-test-token-0123456789';

// Count JSON.parse calls on large input, to prove a frame was never parsed.
const realParse = JSON.parse;
let bigParses = 0;
JSON.parse = function (text, reviver) {
  const n = text == null ? 0 : (typeof text === 'string' ? text.length : (text.length || 0));
  if (n > L.PRE_AUTH_MAX_FRAME) bigParses++;
  return realParse.call(JSON, text, reviver);
};

async function shack(port, token, opts) {
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  const ev = { sstv: [], voice: [], logs: [] };
  rs._handlePtt = () => {};
  rs.on('log', (m) => ev.logs.push(String(m)));
  rs.on('sstv-photo', (d) => ev.sstv.push(d));
  rs.on('voice-macro-play-audio', (d) => ev.voice.push(d));
  rs.on('error', () => {});
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-limits-'));
  rs.start(port, token, Object.assign({ certDir, host: '127.0.0.1', mdns: false }, opts || {}));
  await sleep(700);
  return { rs, ev, port: rs._port };
}

// Opens a socket, sends hello (and auth when a token is given), resolves at
// auth-ok, at auth-mode token without one, or at close.
function open(port, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const r = { ws, got: [], closed: null };
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(r); } };
    ws.on('message', (d) => {
      let m; try { m = realParse(String(d)); } catch { return; }
      r.got.push(m);
      if (m.type === 'auth-mode' && token) ws.send(JSON.stringify({ type: 'auth', token }));
      if (m.type === 'auth-ok' || m.type === 'auth-fail') finish();
      if (m.type === 'auth-mode' && m.mode !== 'none' && !token) finish();
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 'test', clientPlatform: 'test' })));
    ws.on('close', (code, reason) => { r.closed = { code, reason: String(reason || '') }; finish(); });
    ws.on('error', () => {});
    setTimeout(finish, 4000);
  });
}
const authed = (r) => r.got.some((m) => m.type === 'auth-ok');
function waitClose(r, ms) {
  return new Promise((resolve) => {
    if (r.closed) return resolve(r.closed);
    const timer = setTimeout(() => resolve(null), ms);
    r.ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason || '') }); });
  });
}
function waitFor(pred, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { if (pred()) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(tick, 25); };
    tick();
  });
}
// A base64 data URL of `chars` characters that does not compress.
function dataUrl(chars, mime) {
  const head = `data:${mime};base64,`;
  const n = Math.max(0, chars - head.length);
  return head + crypto.randomBytes(Math.ceil(n * 3 / 4) + 3).toString('base64').slice(0, n);
}

(async () => {
  try {
    console.log('\nShack with a token (sockets start unauthenticated)');
    const A = await shack(17641, TOKEN, { requireToken: true });

    // A normal hello before sign-in is read, and auth with the token works.
    {
      const r = await open(A.port, TOKEN);
      check(authed(r), 'a normal-size hello and auth before sign-in still sign in');
      r.ws.close();
    }

    // An over-limit frame before sign-in closes the socket, unparsed.
    {
      const r = await open(A.port, null);
      check(!authed(r) && !r.closed, 'without auth the socket waits, unauthenticated');
      const before = bigParses;
      r.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, pad: 'x'.repeat(L.PRE_AUTH_MAX_FRAME + 10) }));
      const c = await waitClose(r, 3000);
      check(!!c && c.code === 1009, 'an over-64 KiB frame before sign-in closes the socket with 1009 (' + JSON.stringify(c) + ')');
      check(!!c && c.reason === L.PRE_AUTH_CLOSE_REASON, 'the close reason says why');
      check(bigParses === before, 'the frame was never JSON-parsed');
      check(A.ev.logs.some((l) => l.includes('before sign-in')), 'one log line says what happened');
    }

    // Just under the limit before sign-in: read (and ignored, as before).
    {
      const r = await open(A.port, null);
      r.ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(L.PRE_AUTH_MAX_FRAME - 100) }));
      const c = await waitClose(r, 600);
      check(c === null, 'a frame just under 64 KiB before sign-in does not close the socket');
      r.ws.close();
    }

    // Signed in: the largest real frames get through.
    {
      const r = await open(A.port, TOKEN);
      check(authed(r), 'signed in with the token');
      const pic = dataUrl(1694302, 'image/png');   // a 640x496 RGBA PNG of noise
      r.ws.send(JSON.stringify({ type: 'sstv-photo', image: pic, mode: 'pd180' }));
      const gotPic = await waitFor(() => A.ev.sstv.length === 1, 3000);
      check(gotPic && A.ev.sstv[0].image === pic, 'a signed-in socket sends a 1.7 MB SSTV picture (640x496 PNG) to the encoder');

      const audio = crypto.randomBytes(3 * MiB - 64).toString('base64');   // just under 4 MiB of base64
      check(audio.length < L.VOICE_PLAY_AUDIO_MAX && audio.length > L.VOICE_PLAY_AUDIO_MAX - 1024, 'the voice clip is just under 4 MiB');
      r.ws.send(JSON.stringify({ type: 'voice-macro-play-audio', audio, label: 'CQ' }));
      const gotVoice = await waitFor(() => A.ev.voice.length === 1, 3000);
      check(gotVoice && A.ev.voice[0].audio === audio, 'a signed-in socket plays a voice clip near 4 MiB');

      // sstv-photo over the cap: refused to the sender, never encoded.
      const n = r.got.length;
      r.ws.send(JSON.stringify({ type: 'sstv-photo', image: dataUrl(L.SSTV_IMAGE_MAX + 1, 'image/jpeg'), mode: 'martin1' }));
      const gotRefusal = await waitFor(() => r.got.slice(n).some((m) => m.type === 'sstv-tx-status' && m.error), 3000);
      const refusal = r.got.slice(n).find((m) => m.type === 'sstv-tx-status' && m.error);
      check(gotRefusal && refusal.error === L.SSTV_TOO_LARGE_ERROR && (refusal.state === 'rx' || refusal.state === 'auto-rx'),
        'an sstv-photo over 4 MiB is answered with sstv-tx-status {state: rx, error: "' + L.SSTV_TOO_LARGE_ERROR + '"}');
      await sleep(200);
      check(A.ev.sstv.length === 1, 'and never reaches the encoder');
      check(!r.closed, 'the socket stays open');

      // Over maxPayload: ws refuses the frame with 1009.
      const big = 'x'.repeat(L.WS_MAX_PAYLOAD + 1);
      r.ws.send(big);
      const c = await waitClose(r, 5000);
      check(!!c && c.code === 1009, 'a frame over 16 MiB closes even a signed-in socket with 1009 (' + JSON.stringify(c && c.code) + ')');
    }
    A.rs.stop();
    await sleep(200);

    console.log('\nLAN shack, no token (auto-authenticated)');
    const B = await shack(17642, null, {});
    {
      const r = await open(B.port, null);
      check(authed(r), 'auto-authenticated');
      r.ws.send(JSON.stringify({ type: 'sstv-photo', image: dataUrl(200 * 1024, 'image/jpeg'), mode: 'martin1' }));
      const got = await waitFor(() => B.ev.sstv.length === 1, 3000);
      check(got && !r.closed, 'an auto-authenticated LAN socket is signed in from its first frame (200 kB picture accepted)');
      r.ws.close();
    }
    B.rs.stop();
    await sleep(200);
  } catch (e) {
    failed++;
    console.log('  FAIL unexpected error: ' + (e && e.stack || e));
  } finally {
    JSON.parse = realParse;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
