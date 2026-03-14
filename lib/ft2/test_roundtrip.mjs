/**
 * FT2 round-trip test: encode → decode in Node.js
 *
 * Tests:
 *  1. Basic round-trip: encode "CQ K3SBP FN20" at 1500 Hz, decode, verify match
 *  2. Random offset: place signal at random position in 45000-sample buffer
 *  3. Multi-frequency: encode 3 signals at different frequencies, decode all
 *  4. SNR sweep: add white noise at various levels, measure decode success
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Load WASM modules
const encMod = await import(
  'file://' + path.join(__dirname, 'wasm', 'ft2_encode.js').replace(/\\/g, '/')
);
const decMod = await import(
  'file://' + path.join(__dirname, 'wasm', 'ft2_decode.js').replace(/\\/g, '/')
);

const Encoder = await encMod.default();
const Decoder = await decMod.default();

const ft2ExecEncode = Encoder.cwrap('ft2_exec_encode', 'number', ['string', 'number', 'number']);
const ft2InitDecode = Decoder.cwrap('ft2_init_decode', null, []);
const ft2ExecDecode = Decoder.cwrap('ft2_exec_decode', null, ['number', 'number', 'number']);

ft2InitDecode();

const FT2_TX_SAMPLES = 30240;
const FT2_INPUT_SAMPLES = 45000;

function encode(message, frequency) {
  const outPtr = Encoder._malloc(FT2_TX_SAMPLES * 4);
  const rc = ft2ExecEncode(message, frequency, outPtr);
  if (rc !== 0) {
    Encoder._free(outPtr);
    return null;
  }
  const samples = new Float32Array(FT2_TX_SAMPLES);
  samples.set(Encoder.HEAPF32.subarray(outPtr / 4, outPtr / 4 + FT2_TX_SAMPLES));
  Encoder._free(outPtr);
  return samples;
}

function decode(signal) {
  const nSamples = signal.length;
  const inPtr = Decoder._malloc(nSamples * 4);
  Decoder.HEAPF32.set(signal, inPtr / 4);
  const resPtr = Decoder._malloc(4096);

  ft2ExecDecode(inPtr, nSamples, resPtr);

  const resBytes = new Uint8Array(Decoder.HEAPU8.buffer, resPtr, 4096);
  let resStr = '';
  for (let i = 0; i < 4096 && resBytes[i] !== 0; i++) {
    resStr += String.fromCharCode(resBytes[i]);
  }
  Decoder._free(inPtr);
  Decoder._free(resPtr);

  const results = [];
  for (const line of resStr.split('\n').filter(l => l.length > 0)) {
    const parts = line.split(',');
    if (parts.length >= 4) {
      results.push({
        snr: parseFloat(parts[0]),
        dt: parseFloat(parts[1]),
        df: parseFloat(parts[2]),
        text: parts.slice(3).join(',').trim(),
      });
    }
  }
  return results;
}

function addNoise(signal, snrDb) {
  // Compute signal power
  let sigPow = 0;
  for (let i = 0; i < signal.length; i++) sigPow += signal[i] * signal[i];
  sigPow /= signal.length;

  const noisePow = sigPow / Math.pow(10, snrDb / 10);
  const noiseAmp = Math.sqrt(noisePow);

  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    // Box-Muller transform for Gaussian noise
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = signal[i] + noiseAmp * z;
  }
  return out;
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

// ===== Test 1: Basic encode =====
console.log('\n=== Test 1: Encode ===');
const msg1 = 'CQ K3SBP FN20';
const encoded1 = encode(msg1, 1500);
assert(encoded1 !== null, 'Encode returns samples');
assert(encoded1.length === FT2_TX_SAMPLES, `Output length = ${FT2_TX_SAMPLES} (got ${encoded1?.length})`);

// Check signal is not all zeros
let maxAmp = 0;
if (encoded1) {
  for (let i = 0; i < encoded1.length; i++) {
    const a = Math.abs(encoded1[i]);
    if (a > maxAmp) maxAmp = a;
  }
}
assert(maxAmp > 0.1, `Signal has amplitude (max=${maxAmp.toFixed(3)})`);

// ===== Test 2: Basic round-trip (signal at start of buffer) =====
console.log('\n=== Test 2: Round-trip (signal at start) ===');
const buf2 = new Float32Array(FT2_INPUT_SAMPLES);
if (encoded1) buf2.set(encoded1, 0);
const results2 = decode(buf2);
console.log(`  Decoded ${results2.length} message(s):`);
results2.forEach(r => console.log(`    snr=${r.snr.toFixed(1)} dt=${r.dt.toFixed(2)} df=${r.df.toFixed(0)} "${r.text}"`));
const found2 = results2.some(r => r.text.includes('K3SBP'));
assert(found2, `Decoded message contains "K3SBP"`);

// ===== Test 3: Round-trip with random offset =====
console.log('\n=== Test 3: Round-trip (random offset) ===');
const offset3 = Math.floor(Math.random() * (FT2_INPUT_SAMPLES - FT2_TX_SAMPLES));
const buf3 = new Float32Array(FT2_INPUT_SAMPLES);
if (encoded1) buf3.set(encoded1, offset3);
const results3 = decode(buf3);
console.log(`  Offset: ${offset3} samples (${(offset3 / 12000).toFixed(3)}s)`);
console.log(`  Decoded ${results3.length} message(s):`);
results3.forEach(r => console.log(`    snr=${r.snr.toFixed(1)} dt=${r.dt.toFixed(2)} df=${r.df.toFixed(0)} "${r.text}"`));
const found3 = results3.some(r => r.text.includes('K3SBP'));
assert(found3, `Decoded at offset ${offset3}`);

// ===== Test 4: Different message =====
console.log('\n=== Test 4: Different message ===');
const msg4 = 'W1AW K3SBP -05';
const encoded4 = encode(msg4, 1000);
assert(encoded4 !== null, `Encode "${msg4}" succeeds`);
const buf4 = new Float32Array(FT2_INPUT_SAMPLES);
if (encoded4) buf4.set(encoded4, 2000);
const results4 = decode(buf4);
console.log(`  Decoded ${results4.length} message(s):`);
results4.forEach(r => console.log(`    snr=${r.snr.toFixed(1)} dt=${r.dt.toFixed(2)} df=${r.df.toFixed(0)} "${r.text}"`));
const found4 = results4.some(r => r.text.includes('K3SBP') && r.text.includes('W1AW'));
assert(found4, `Decoded "${msg4}"`);

// ===== Test 5: Multi-frequency =====
console.log('\n=== Test 5: Multi-frequency (3 signals) ===');
const signals = [
  { msg: 'CQ K3SBP FN20', freq: 800 },
  { msg: 'CQ W1AW FN31', freq: 1500 },
  { msg: 'CQ N0CALL DM79', freq: 2200 },
];
const buf5 = new Float32Array(FT2_INPUT_SAMPLES);
for (const s of signals) {
  const enc = encode(s.msg, s.freq);
  if (enc) {
    for (let i = 0; i < enc.length && i < FT2_INPUT_SAMPLES; i++) {
      buf5[i] += enc[i];
    }
  }
}
const results5 = decode(buf5);
console.log(`  Decoded ${results5.length} message(s):`);
results5.forEach(r => console.log(`    snr=${r.snr.toFixed(1)} dt=${r.dt.toFixed(2)} df=${r.df.toFixed(0)} "${r.text}"`));
const found5a = results5.some(r => r.text.includes('K3SBP'));
const found5b = results5.some(r => r.text.includes('W1AW'));
const found5c = results5.some(r => r.text.includes('N0CALL'));
assert(found5a, 'Decoded signal 1 (K3SBP @ 800 Hz)');
assert(found5b, 'Decoded signal 2 (W1AW @ 1500 Hz)');
assert(found5c, 'Decoded signal 3 (N0CALL @ 2200 Hz)');

// ===== Test 6: SNR sweep =====
console.log('\n=== Test 6: SNR sweep ===');
const snrLevels = [20, 10, 5, 0, -3, -6, -9, -12, -15];
for (const snr of snrLevels) {
  const buf6 = new Float32Array(FT2_INPUT_SAMPLES);
  if (encoded1) buf6.set(encoded1, 0);
  const noisy = addNoise(buf6, snr);
  const results6 = decode(noisy);
  const ok = results6.some(r => r.text.includes('K3SBP'));
  console.log(`  SNR ${snr >= 0 ? '+' : ''}${snr} dB: ${ok ? 'DECODED' : 'missed'} (${results6.length} result${results6.length !== 1 ? 's' : ''})`);
}

// ===== Test 7: Invalid message =====
console.log('\n=== Test 7: Invalid message ===');
const encoded7 = encode('THIS IS WAY TOO LONG TO ENCODE AS FT8 MESSAGE PAYLOAD', 1500);
assert(encoded7 === null, 'Invalid message returns null');

// ===== Summary =====
console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
