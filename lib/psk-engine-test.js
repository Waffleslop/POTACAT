'use strict';
/**
 * psk-engine unit tests — varicode round-trip, full TX->RX loopback,
 * AFC pull-in, noise tolerance, squelch, and the Ft8Engine-contract
 * surface. Pure JS, no audio hardware, deterministic (seeded PRNG).
 *
 * Run: node lib/psk-engine-test.js
 */

const {
  PskEngine,
  SAMPLE_RATE,
  BAUD,
  VARICODE,
  varicodeEncode,
  varicodeDecodeBits,
  modulatePsk31,
} = require('./psk-engine');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// Deterministic PRNG (mulberry32) + Box-Muller gaussian for noise tests
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Feed a buffer to an engine in chunks, collecting decoded text. */
function rxCollect(eng, buf, chunkSize) {
  let text = '';
  let lastFreq = null;
  const onText = (d) => { text += d.chars; lastFreq = d.freqHz; };
  eng.on('psk-text', onText);
  for (let i = 0; i < buf.length; i += chunkSize) {
    eng.feedAudio(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
  }
  // Flush: matched filter + differential detector need ~2 symbols of tail.
  eng.feedAudio(new Float32Array(SAMPLE_RATE)); // 1 s of silence
  eng.removeListener('psk-text', onText);
  return { text, lastFreq };
}

function makeRx(centerHz) {
  const eng = new PskEngine();
  eng.start();
  eng.setRxFreq(centerHz);
  return eng;
}

// ---------------------------------------------------------------------------

function testVaricodeTable() {
  console.log('\n--- Test: varicode table sanity + round-trip ---');
  // Known published G3PLX codes (spot checks against the spec)
  assert(VARICODE[32] === '1', 'space = 1');
  assert(VARICODE[101] === '11', 'e = 11');
  assert(VARICODE[116] === '101', 't = 101');
  assert(VARICODE[111] === '111', 'o = 111');
  assert(VARICODE[65] === '1111101', 'A = 1111101');
  assert(VARICODE[48] === '10110111', '0 = 10110111');
  assert(VARICODE[63] === '1010101111', '? = 1010101111');

  // Full printable-ASCII round-trip
  let all = '';
  for (let c = 32; c < 127; c++) all += String.fromCharCode(c);
  assert(varicodeDecodeBits(varicodeEncode(all)) === all, 'full printable set round-trips');

  const exch = 'K3SBP de W1AW UR 599 599 QTH CT CT BTU K3SBP de W1AW kn';
  assert(varicodeDecodeBits(varicodeEncode(exch)) === exch, 'QSO exchange round-trips');
  assert(varicodeDecodeBits(varicodeEncode('café')) === 'caf?', 'non-ASCII becomes ?');
}

async function testLoopbackClean() {
  console.log('\n--- Test: clean loopback @1000 Hz ---');
  const msg = 'CQ CQ DE K3SBP K3SBP PSE K';
  const tx = new PskEngine();
  tx.setTxFreq(1000);
  const buf = await tx.renderMessage(msg);
  assert(buf instanceof Float32Array && buf.length > 0, 'renderMessage returns samples');

  // Amplitude convention: peak 1.0 (main.js aborts TX under peak 0.01)
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  assert(peak > 0.98 && peak <= 1.0, `TX peak ~1.0 (got ${peak.toFixed(3)})`);

  const rx = makeRx(1000);
  const { text } = rxCollect(rx, buf, 4096);
  assert(text.includes(msg), `decoded text contains message (got: "${text}")`);
  rx.stop();
}

async function testChunkSizeInvariance() {
  console.log('\n--- Test: chunk-size invariance ---');
  const msg = 'the quick brown fox 599';
  const tx = new PskEngine();
  const buf = await tx.renderMessage(msg, 1500);

  const a = rxCollect(makeRx(1500), buf, 4096).text;
  const b = rxCollect(makeRx(1500), buf, 160).text; // VITA-49-ish small frames
  const c = rxCollect(makeRx(1500), buf, 1).text;   // pathological
  assert(a.includes(msg), `4096-chunk decodes (got: "${a}")`);
  assert(a === b, '160-sample chunks produce identical text');
  assert(a === c, '1-sample chunks produce identical text');
}

async function testFrequencyOffset() {
  console.log('\n--- Test: AFC pull-in at ±8 Hz offset ---');
  const msg = 'AFC test de K3SBP';
  const tx = new PskEngine();
  for (const off of [8, -8]) {
    const buf = await tx.renderMessage(msg, 1000 + off);
    const rx = makeRx(1000);
    const { text, lastFreq } = rxCollect(rx, buf, 4096);
    assert(text.includes(msg), `decodes at ${off > 0 ? '+' : ''}${off} Hz (got: "${text}")`);
    assert(lastFreq !== null && Math.abs(lastFreq - (1000 + off)) <= 1.5,
      `reported freq within 1.5 Hz of truth (got ${lastFreq})`);
    rx.stop();
  }
}

async function testNoise() {
  console.log('\n--- Test: noisy channel ---');
  const msg = 'CQ CQ DE K3SBP K3SBP K';
  const tx = new PskEngine();
  const clean = await tx.renderMessage(msg, 1200);

  // PSK31 signal power: cosine-keyed sine, peak 1.0 -> avg power ~0.35.
  // Noise sigma 0.5 across the full 6 kHz Nyquist band puts roughly
  // 0.25 * (31.25/6000) ~ 1e-3 of noise power in the signal bandwidth:
  // ~25 dB in-band SNR — a solid copy for PSK31, while still burying the
  // waveform visually (broadband SNR ~1.4 dB).
  const rand = mulberry32(0xC0FFEE);
  const noisy = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) noisy[i] = clean[i] + 0.5 * gaussian(rand);

  const rx = makeRx(1200);
  const { text } = rxCollect(rx, noisy, 4096);
  // Score character accuracy against the message
  let hits = 0;
  if (text.includes(msg)) hits = msg.length;
  else {
    // longest common substring length as a proxy
    for (let len = msg.length; len >= 1 && !hits; len--) {
      for (let s = 0; s + len <= msg.length; s++) {
        if (text.includes(msg.slice(s, s + len))) { hits = len; break; }
      }
    }
  }
  assert(hits >= Math.ceil(msg.length * 0.95),
    `>=95% of message recovered through noise (${hits}/${msg.length}, got: "${text}")`);
  rx.stop();
}

function testSquelchOnNoise() {
  console.log('\n--- Test: squelch stays closed on pure noise ---');
  const rx = makeRx(1500);
  let events = 0;
  rx.on('psk-text', () => { events++; });
  const rand = mulberry32(0xDEADBEEF);
  const chunk = new Float32Array(4096);
  const total = 5 * SAMPLE_RATE;
  for (let fed = 0; fed < total; fed += chunk.length) {
    for (let i = 0; i < chunk.length; i++) chunk[i] = 0.3 * gaussian(rand);
    rx.feedAudio(chunk);
  }
  assert(events === 0, `no psk-text on 5 s of pure noise (got ${events} events)`);
  rx.stop();
}

function testSquelchOnCarrier() {
  console.log('\n--- Test: steady carrier + noise decodes NOTHING (first on-air bug) ---');
  // K3SBP 2026-07-14: any birdie/tune-up carrier near the audio center
  // produces endless 1-bits; the original all-ones instant-DCD force-opened
  // the squelch permanently and carrier+noise streamed short-code garbage
  // (e t o i n …) for hours. A plain carrier must never open the squelch.
  const rx = makeRx(1000);
  let chars = '';
  rx.on('psk-text', (d) => { chars += d.chars; });
  const rand = mulberry32(0x81D1E5); // "birdies"
  const chunk = new Float32Array(4096);
  const w = (2 * Math.PI * 1000) / SAMPLE_RATE;
  let n = 0;
  const total = 10 * SAMPLE_RATE;
  for (let fed = 0; fed < total; fed += chunk.length) {
    for (let i = 0; i < chunk.length; i++, n++) {
      chunk[i] = 0.8 * Math.sin(w * n) + 0.25 * gaussian(rand);
    }
    rx.feedAudio(chunk);
  }
  assert(chars.length === 0, `no chars from 10 s of carrier+noise (got ${chars.length}: "${chars.slice(0, 40)}")`);
  rx.stop();
}

function testSetSquelch() {
  console.log('\n--- Test: setSquelch contract ---');
  const eng = new PskEngine();
  eng.setSquelch(70);
  assert(eng._sqlOpen === 70 && eng._sqlClose === 55, 'level 70 -> open 70 / close 55');
  eng.setSquelch(5);
  assert(eng._sqlOpen === 10, 'clamps low to 10');
  eng.setSquelch(500);
  assert(eng._sqlOpen === 90, 'clamps high to 90');
  eng.setSquelch('garbage');
  assert(eng._sqlOpen === 50, 'non-numeric falls back to default');
}

async function testTxContract() {
  console.log('\n--- Test: TX contract (requestTx guards, safety timer, stop) ---');
  const eng = new PskEngine();

  assert(eng.requestTx() === false, 'requestTx false when not running');
  eng.start();
  assert(eng.requestTx() === false, 'requestTx false when TX not enabled');
  eng._txEnabled = true;
  assert(eng.requestTx() === false, 'requestTx false with no message');

  await eng.setTxMessage('test de K3SBP');
  assert(eng._txSamples instanceof Float32Array, 'setTxMessage pre-renders samples');

  // Stale render guard: mutate the message directly (bypassing setTxMessage)
  eng._txMessage = 'different';
  assert(eng.requestTx() === false, 'requestTx false when render is stale');
  await eng.setTxMessage('test de K3SBP');

  let txStart = null;
  let txEnds = 0;
  eng.on('tx-start', (d) => { txStart = d; });
  eng.on('tx-end', () => { txEnds++; });

  assert(eng.requestTx() === true, 'requestTx fires when armed');
  assert(eng._txActive === true, '_txActive set');
  assert(txStart && txStart.samples === eng._txSamples && txStart.slot === '--'
    && txStart.offsetMs === 0, 'tx-start payload matches FT2-immediate shape');
  assert(eng.requestTx() === false, 'requestTx false while TX active');

  eng.txComplete();
  assert(txEnds === 1 && eng._txActive === false, 'txComplete emits tx-end and clears state');
  assert(eng._txEndTimer === null, 'safety timer cleared by txComplete');

  // stop() during active TX emits tx-end
  eng.requestTx();
  eng.stop();
  assert(txEnds === 2 && eng._txActive === false, 'stop() during TX emits tx-end');

  // setTxFreq invalidation: render follows the new frequency
  const eng2 = new PskEngine();
  eng2.start();
  eng2._txEnabled = true;
  await eng2.setTxMessage('freq move');
  const before = eng2._txSamples;
  eng2.setTxFreq(800);
  assert(eng2._txSamples !== before && eng2._txRenderedFreq === 800,
    'setTxFreq re-renders pending message at new center');
  assert(eng2._rxFreq === 800, 'RX center tracks TX (transceive)');
  eng2.stop();
}

async function testTxDurationCap() {
  console.log('\n--- Test: TX duration cap ---');
  const eng = new PskEngine();
  // Worst-case airtime density: uppercase + punctuation, 500 chars
  await eng.setTxMessage('W9XYZ '.repeat(84));
  const durSec = eng._txSamples.length / SAMPLE_RATE;
  assert(durSec <= 120.5, `long message trimmed to <=120 s (got ${durSec.toFixed(1)} s)`);
  assert(eng._txMessage.length < 500, 'message text reflects the trim');
}

function testFeedGuards() {
  console.log('\n--- Test: feedAudio guards ---');
  const eng = new PskEngine();
  eng.feedAudio(new Float32Array(1000)); // not running — must not throw
  eng.start();
  eng.feedAudio(null);
  eng.feedAudio(new Float32Array(0));
  eng._txActive = true;
  let events = 0;
  eng.on('psk-text', () => { events++; });
  eng.feedAudio(new Float32Array(4096));
  assert(events === 0, 'feedAudio is a no-op during TX');
  eng._txActive = false;
  eng.stop();
  passed++; console.log('  PASS: feedAudio guards never throw');
}

// ---------------------------------------------------------------------------

(async () => {
  console.log('PSK31 engine tests');
  const t0 = Date.now();
  testVaricodeTable();
  await testLoopbackClean();
  await testChunkSizeInvariance();
  await testFrequencyOffset();
  await testNoise();
  testSquelchOnNoise();
  testSquelchOnCarrier();
  testSetSquelch();
  await testTxContract();
  await testTxDurationCap();
  testFeedGuards();
  console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(failed ? 1 : 0);
})();
