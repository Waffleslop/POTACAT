#!/usr/bin/env node
'use strict';
//
// WebSdrClient tests.
//   node test/websdr-test.js                       (offline tests only)
//   WEBSDR_LIVE_HOST=na5b.com WEBSDR_LIVE_PORT=8902 node test/websdr-test.js
//                                                  (also runs the live smoke)
//

const assert = require('assert');
const { WebSdrClient, MULAW_LUT } = require('../lib/websdr');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (e) => { failed++; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
      );
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

// Tap into the parser without needing a real WebSocket. We rely on the fact
// that _onBinary / _parseTag / _decodeAdpcm don't touch this._ws.
function newClient() {
  return new WebSdrClient();
}
function emitsFromOnBinary(client, buf) {
  const audio = [];
  const smeter = [];
  const logs = [];
  const aListener = (pcm, sr) => audio.push({ pcm, sr });
  const sListener = (v) => smeter.push(v);
  const lListener = (m) => logs.push(m);
  client.on('audio', aListener);
  client.on('smeter', sListener);
  client.on('log', lListener);
  client._onBinary(buf);
  client.removeListener('audio', aListener);
  client.removeListener('smeter', sListener);
  client.removeListener('log', lListener);
  return { audio, smeter, logs };
}

console.log('\n=== µ-law LUT ===');

test('LUT has 256 entries', () => {
  assert.strictEqual(MULAW_LUT.length, 256);
});

test('LUT spans full int16 range', () => {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < 256; i++) {
    if (MULAW_LUT[i] < mn) mn = MULAW_LUT[i];
    if (MULAW_LUT[i] > mx) mx = MULAW_LUT[i];
  }
  // PA3FWM's table is bias-132 G.711, range ±32256.
  assert.strictEqual(mn, -32256);
  assert.strictEqual(mx, 32256);
});

test('LUT is sign-symmetric (i+128 → −Sa[i])', () => {
  for (let i = 0; i < 128; i++) {
    assert.strictEqual(MULAW_LUT[i + 128], -MULAW_LUT[i],
      `mismatch at i=${i}: positive=${MULAW_LUT[i+128]} negative=${MULAW_LUT[i]}`);
  }
});

test('LUT[0x7F] and LUT[0xFF] are smallest-magnitude codes', () => {
  // PA3FWM's table doesn't pre-invert the byte: 0x7F is smallest-magnitude
  // negative (-848), 0xFF is smallest-magnitude positive (+848). Both are
  // small relative to the ±32256 full-scale endpoints at index 42 / 170.
  assert.strictEqual(MULAW_LUT[0x7F], -848);
  assert.strictEqual(MULAW_LUT[0xFF], 848);
});

console.log('\n=== Parser — fixed-length tags ===');

test('0x80 decodes 128 µ-law samples', () => {
  const c = newClient();
  const buf = Buffer.alloc(1 + 128);
  buf[0] = 0x80;
  for (let i = 0; i < 128; i++) buf[1 + i] = i; // arbitrary µ-law bytes
  const { audio } = emitsFromOnBinary(c, buf);
  assert.strictEqual(audio.length, 1, 'one audio packet');
  assert.strictEqual(audio[0].pcm.length, 128, '128 samples');
  // First sample should be MULAW_LUT[0] / 32768
  assert.ok(Math.abs(audio[0].pcm[0] - MULAW_LUT[0] / 32768) < 1e-6);
  // Sample rate is the default until 0x81 changes it
  assert.strictEqual(audio[0].sr, 7350);
});

test('0x81 updates sample rate and emits info event', () => {
  const c = newClient();
  let info = null;
  c.on('info', (i) => { info = i; });
  // 0x81 + BE(11025) = 0x81, 0x2B, 0x11
  const buf = Buffer.from([0x81, 0x2B, 0x11]);
  emitsFromOnBinary(c, buf);
  assert.strictEqual(c._sampleRate, 11025);
  assert.deepStrictEqual(info, { sampleRate: 11025 });
});

test('0x84 emits 128 zero samples', () => {
  const c = newClient();
  const { audio } = emitsFromOnBinary(c, Buffer.from([0x84]));
  assert.strictEqual(audio.length, 1);
  assert.strictEqual(audio[0].pcm.length, 128);
  for (let i = 0; i < 128; i++) assert.strictEqual(audio[0].pcm[i], 0);
});

test('0xF? + 1 byte emits s-meter', () => {
  const c = newClient();
  // 0xF3, 0x42 → smeter = (0x03 << 8) | 0x42 = 0x0342 = 834
  // Emitted as 10*smeter = 8340
  const { smeter } = emitsFromOnBinary(c, Buffer.from([0xF3, 0x42]));
  assert.strictEqual(smeter.length, 1);
  assert.strictEqual(smeter[0], 8340);
});

test('0x82 stores ADPCM step-size', () => {
  const c = newClient();
  emitsFromOnBinary(c, Buffer.from([0x82, 0x12, 0x34]));
  assert.strictEqual(c._stepSize, 0x1234);
});

test('0x83 stores mode/filter flags', () => {
  const c = newClient();
  emitsFromOnBinary(c, Buffer.from([0x83, 0x1A]));
  assert.strictEqual(c._modeFlags, 0x1A);
});

test('0x86 (resync) advances exactly 1 byte', () => {
  const c = newClient();
  // 0x86 followed by a 0x84 silence — silence should still produce audio
  const { audio } = emitsFromOnBinary(c, Buffer.from([0x86, 0x84]));
  assert.strictEqual(audio.length, 1);
});

test('0x85 / 0x87 (6-byte payloads) advance correctly', () => {
  const c = newClient();
  // 0x85 + 6 bytes + 0x84 silence
  const buf = Buffer.from([0x85, 0, 0, 0, 0, 0, 0, 0x84]);
  const { audio } = emitsFromOnBinary(c, buf);
  assert.strictEqual(audio.length, 1, '0x84 reached after 7 bytes of 0x85 frame');
});

console.log('\n=== Parser — partial / streaming ===');

test('split 0x80 frame across two buffers', () => {
  const c = newClient();
  const full = Buffer.alloc(1 + 128);
  full[0] = 0x80;
  for (let i = 0; i < 128; i++) full[1 + i] = (i * 7) & 0xFF;
  // First chunk: only 50 bytes of the 129-byte frame
  let r = emitsFromOnBinary(c, full.slice(0, 50));
  assert.strictEqual(r.audio.length, 0, 'no audio yet — frame incomplete');
  // Second chunk: the remaining 79 bytes
  r = emitsFromOnBinary(c, full.slice(50));
  assert.strictEqual(r.audio.length, 1, 'audio emitted once buffer is complete');
  assert.strictEqual(r.audio[0].pcm.length, 128);
});

test('multiple audio tags in one buffer batch into one emit', () => {
  const c = newClient();
  const muLaw = Buffer.alloc(129); muLaw[0] = 0x80;
  const silence = Buffer.from([0x84]);
  const smeter = Buffer.from([0xF7, 0x55]);
  const buf = Buffer.concat([silence, muLaw, smeter, silence]);
  const r = emitsFromOnBinary(c, buf);
  // _parse() batches all decoded samples from one buffer pass into a single
  // audio event (saves IPC). 0x84 + 0x80 + 0x84 → 128 + 128 + 128 = 384 samples.
  assert.strictEqual(r.audio.length, 1, 'one batched audio emit');
  assert.strictEqual(r.audio[0].pcm.length, 384, '128+128+128 samples');
  assert.strictEqual(r.smeter.length, 1);
  assert.strictEqual(r.smeter[0], (0x07 * 256 + 0x55) * 10);
});

test('rate change mid-stream affects subsequent audio', () => {
  const c = newClient();
  const rateChange = Buffer.from([0x81, 0x2B, 0x11]); // 11025
  const silence = Buffer.from([0x84]);
  const r = emitsFromOnBinary(c, Buffer.concat([rateChange, silence]));
  assert.strictEqual(r.audio.length, 1);
  assert.strictEqual(r.audio[0].sr, 11025);
});

test('truly-unknown tag (0xE0) skips and parser keeps going', () => {
  const c = newClient();
  // 0xE0 (unknown) followed by 0x84 silence — silence should still come out
  const r = emitsFromOnBinary(c, Buffer.from([0xE0, 0x84]));
  assert.strictEqual(r.audio.length, 1);
});

console.log('\n=== ADPCM ===');

test('ADPCM block decodes 128 samples and resets predictor', () => {
  const c = newClient();
  // Set step-size so the ADPCM decoder produces non-trivial deltas.
  emitsFromOnBinary(c, Buffer.from([0x82, 0x10, 0x00])); // step-size = 4096
  // Construct an ADPCM block: tag 0xA0 (G = 14 - 0xA = 4), then 400 bytes of
  // arbitrary data. We don't verify *correctness* here (no captured-frame
  // reference yet), only that the decoder produces 128 samples without
  // throwing or reading off the buffer end.
  const block = Buffer.alloc(401);
  block[0] = 0xA0;
  for (let i = 1; i < block.length; i++) block[i] = (i * 13 + 7) & 0x7F; // keep <0x80 to avoid retag
  const r = emitsFromOnBinary(c, block);
  assert.ok(r.audio.length >= 1, 'at least one audio frame emitted');
  // First emit should be 128 samples (the ADPCM block).
  assert.strictEqual(r.audio[0].pcm.length, 128);
});

test('ADPCM is deterministic — same input → same output', () => {
  const block = Buffer.alloc(401);
  block[0] = 0xA0;
  for (let i = 1; i < block.length; i++) block[i] = (i * 13 + 7) & 0x7F;
  const c1 = newClient(); c1._stepSize = 4096;
  const c2 = newClient(); c2._stepSize = 4096;
  const r1 = emitsFromOnBinary(c1, block);
  const r2 = emitsFromOnBinary(c2, block);
  assert.strictEqual(r1.audio.length, r2.audio.length);
  for (let i = 0; i < r1.audio[0].pcm.length; i++) {
    assert.strictEqual(r1.audio[0].pcm[i], r2.audio[0].pcm[i],
      `divergence at sample ${i}`);
  }
});

test('ADPCM defers until enough bytes buffered', () => {
  const c = newClient();
  c._stepSize = 4096;
  const head = Buffer.alloc(100);
  head[0] = 0xA0; // ADPCM tag, but only 100 bytes — below ADPCM_MIN_BYTES
  for (let i = 1; i < 100; i++) head[i] = i & 0x7F;
  const r1 = emitsFromOnBinary(c, head);
  assert.strictEqual(r1.audio.length, 0, 'no decode yet — buffered');
  // Provide more data
  const tail = Buffer.alloc(400);
  for (let i = 0; i < 400; i++) tail[i] = (i * 11) & 0x7F;
  const r2 = emitsFromOnBinary(c, tail);
  assert.strictEqual(r2.audio.length, 1, 'decoded once buffer is large enough');
});

test('µ-law block resets predictor state', () => {
  const c = newClient();
  // Pollute predictor state
  for (let i = 0; i < 20; i++) { c._taps[i] = 1234; c._history[i] = 5678; }
  c._dither = 99;
  const muLaw = Buffer.alloc(129); muLaw[0] = 0x80;
  emitsFromOnBinary(c, muLaw);
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(c._taps[i], 0);
    assert.strictEqual(c._history[i], 0);
  }
  assert.strictEqual(c._dither, 0);
});

console.log('\n=== Tune URL ===');

test('tune URL has all required params with USB defaults', () => {
  const c = newClient();
  c._desiredFreqKhz = 14074;
  c._desiredMode = 'usb';
  c._callsign = 'K3SBP';
  c._band = 0;
  let sent = null;
  c._ws = { readyState: 1, send: (s) => { sent = s; } }; // mock
  // Override OPEN constant lookup
  const ws = require('ws');
  c._ws.readyState = ws.OPEN;
  c._sendTune();
  assert.ok(sent.startsWith('GET /~~param?'));
  assert.ok(sent.includes('f=14074'));
  assert.ok(sent.includes('mode=USB'));
  assert.ok(sent.includes('lo=300'));
  assert.ok(sent.includes('hi=2700'));
  assert.ok(sent.includes('band=0'));
  assert.ok(sent.includes('name=POTACAT_K3SBP'));
});

test('LSB sets negative passband', () => {
  const c = newClient();
  c._desiredFreqKhz = 7200;
  c._desiredMode = 'lsb';
  let sent = null;
  const ws = require('ws');
  c._ws = { readyState: ws.OPEN, send: (s) => { sent = s; } };
  c._sendTune();
  assert.ok(sent.includes('lo=-2700'));
  assert.ok(sent.includes('hi=-300'));
});

test('tune() resets predictor', () => {
  const c = newClient();
  for (let i = 0; i < 20; i++) { c._taps[i] = 100; c._history[i] = 200; }
  c._dither = 50;
  const ws = require('ws');
  c._ws = { readyState: ws.OPEN, send: () => {} };
  c.tune(14000, 'cw');
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(c._taps[i], 0);
    assert.strictEqual(c._history[i], 0);
  }
  assert.strictEqual(c._dither, 0);
  assert.strictEqual(c._desiredFreqKhz, 14000);
  assert.strictEqual(c._desiredMode, 'cw');
});

console.log('\n=== Diagnostic ===');

test('first 3 frames produce diag log lines, rest are silent', () => {
  const c = newClient();
  const logs = [];
  c.on('log', (m) => { if (m.startsWith('frame#')) logs.push(m); });
  // Five 0x84 silence frames → five emit('audio') calls → first 3 logged
  emitsFromOnBinary(c, Buffer.from([0x84, 0x84, 0x84, 0x84, 0x84]));
  // Each silence emits its own audio packet, but they merge into one emit per
  // _parse() call. Need separate calls to test the diag counter.
  for (let i = 0; i < 5; i++) emitsFromOnBinary(c, Buffer.from([0x84]));
  assert.strictEqual(logs.length, 3, `expected 3 frame# logs, got ${logs.length}`);
});

// =============================================================================
// Live smoke test — only runs if WEBSDR_LIVE_HOST is set.
// =============================================================================

const liveHost = process.env.WEBSDR_LIVE_HOST;
const livePort = parseInt(process.env.WEBSDR_LIVE_PORT || '8901', 10);
const liveCall = process.env.WEBSDR_LIVE_CALL || 'POTACAT';

async function liveTest() {
  console.log(`\n=== Live smoke test → ${liveHost}:${livePort} ===`);

  await new Promise((resolve, reject) => {
    const c = new WebSdrClient();
    let gotAudio = false;
    let gotRate = false;
    let gotConnect = false;
    let frameSummaries = [];
    let timeout;

    const finish = (err) => {
      clearTimeout(timeout);
      try { c.disconnect(); } catch {}
      err ? reject(err) : resolve();
    };

    c.on('connected', () => { gotConnect = true; });
    c.on('error', (e) => finish(new Error(`client error: ${e}`)));
    c.on('info', (i) => { if (i.sampleRate) gotRate = true; });
    c.on('log', (m) => { if (m.startsWith('frame#')) frameSummaries.push(m); });
    c.on('audio', (pcm) => {
      if (gotAudio) return;
      gotAudio = true;
      // Don't finish immediately — let the diag frames accumulate.
      setTimeout(() => {
        try {
          assert.ok(gotConnect, 'connected event fired');
          assert.ok(gotRate, 'sample rate received');
          assert.ok(frameSummaries.length >= 1,
            `at least one frame# diag (got ${frameSummaries.length})`);
          // meanAbs should be a real-audio value, not 0 and not pegged at 0.5.
          const m = frameSummaries[0].match(/meanAbs=([\d.]+)/);
          assert.ok(m, 'meanAbs in diag string');
          const meanAbs = parseFloat(m[1]);
          assert.ok(meanAbs >= 0 && meanAbs < 0.6,
            `meanAbs ${meanAbs} should be < 0.6 (≈0.5 = byte-swap bug)`);
          console.log('  live diag:', frameSummaries.slice(0, 3).join(' | '));
          finish();
        } catch (e) {
          finish(e);
        }
      }, 1500);
    });

    timeout = setTimeout(() => {
      finish(new Error(`no audio after 10s (gotConnect=${gotConnect}, gotRate=${gotRate})`));
    }, 10000);

    c.connect(liveHost, livePort, 7200, 'usb', { callsign: liveCall });
  });
}

(async () => {
  if (liveHost) {
    await test('live smoke: connect → tune → first audio', liveTest);
  } else {
    console.log('\n=== Live smoke test SKIPPED (set WEBSDR_LIVE_HOST to enable) ===');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
