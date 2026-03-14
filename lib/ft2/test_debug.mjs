/**
 * Debug test: isolate where FT2 decode fails.
 * Step 1: Verify encoder output has correct tone structure
 * Step 2: Test sync detection in isolation
 * Step 3: Test soft-bit extraction
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const encMod = await import('file://' + path.join(__dirname, 'wasm', 'ft2_encode.js').replace(/\\/g, '/'));
const Encoder = await encMod.default();
const ft2ExecEncode = Encoder.cwrap('ft2_exec_encode', 'number', ['string', 'number', 'number']);

const FT2_TX_SAMPLES = 30240;
const SPSYM = 288;
const NN = 105;

function encode(message, frequency) {
  const outPtr = Encoder._malloc(FT2_TX_SAMPLES * 4);
  const rc = ft2ExecEncode(message, frequency, outPtr);
  if (rc !== 0) { Encoder._free(outPtr); return null; }
  const samples = new Float32Array(FT2_TX_SAMPLES);
  samples.set(Encoder.HEAPF32.subarray(outPtr / 4, outPtr / 4 + FT2_TX_SAMPLES));
  Encoder._free(outPtr);
  return samples;
}

// Encode a test message
const signal = encode('CQ K3SBP FN20', 1500);
if (!signal) { console.log('Encode failed'); process.exit(1); }

console.log(`Encoded ${signal.length} samples`);
console.log(`Max amplitude: ${Math.max(...Array.from(signal).map(Math.abs)).toFixed(4)}`);

// Analyze the encoded signal: measure instantaneous frequency per symbol
// by looking at zero-crossing rate or phase progression
console.log('\n=== Symbol frequency analysis ===');
console.log('Measuring dominant tone per symbol by peak DFT bin...\n');

// For each symbol, do a DFT at the 4 possible tone frequencies relative to 1500 Hz
const baseFreq = 1500;
const baudRate = 12000 / SPSYM; // 41.667 Hz
const SR = 12000;

// Expected Costas arrays
const costas = [
  [0,1,3,2], // a at pos 1-4
  [1,0,2,3], // b at pos 34-37
  [2,3,1,0], // c at pos 67-70
  [3,2,0,1], // d at pos 100-103
];
const syncPos = [1, 34, 67, 100];

for (let sym = 0; sym < NN; sym++) {
  const start = sym * SPSYM;
  // DFT at 4 tone frequencies
  const mags = [];
  for (let tone = 0; tone < 4; tone++) {
    const freq = baseFreq + tone * baudRate;
    let sr = 0, si = 0;
    for (let j = 0; j < SPSYM; j++) {
      const angle = 2 * Math.PI * freq * j / SR;
      sr += signal[start + j] * Math.cos(angle);
      si += signal[start + j] * (-Math.sin(angle));
    }
    mags.push(Math.sqrt(sr*sr + si*si));
  }
  const bestTone = mags.indexOf(Math.max(...mags));

  // Determine what this symbol should be
  let expected = '?';
  let label = 'data';
  if (sym === 0 || sym === 104) { expected = '0'; label = 'ramp'; }
  for (let g = 0; g < 4; g++) {
    if (sym >= syncPos[g] && sym < syncPos[g] + 4) {
      expected = String(costas[g][sym - syncPos[g]]);
      label = `sync_${String.fromCharCode(97+g)}`;
    }
  }

  const match = bestTone === parseInt(expected) ? 'OK' : 'MISMATCH';
  if (label.startsWith('sync') || sym < 6 || sym > 102 || match === 'MISMATCH') {
    console.log(`  sym ${String(sym).padStart(3)}: tone=${bestTone} expected=${expected} (${label}) mags=[${mags.map(m=>m.toFixed(1)).join(',')}] ${match}`);
  }
}

// Now test what the decoder's downmix+DFT would see
console.log('\n=== Simulating decoder downmix (9:1 decimation) ===');
const DS_FACTOR = 9;
const DS_SPSYM = 32;
const dsLen = Math.floor(FT2_TX_SAMPLES / DS_FACTOR);

// Downmix to baseband at 1500 Hz
const dsI = new Float32Array(dsLen);
const dsQ = new Float32Array(dsLen);
let phase = 0;
const dphi = 2 * Math.PI * baseFreq / SR;

for (let k = 0; k < dsLen; k++) {
  let sumI = 0, sumQ = 0;
  const base = k * DS_FACTOR;
  for (let j = 0; j < DS_FACTOR && (base + j) < signal.length; j++) {
    const s = signal[base + j];
    const p = phase + dphi * j;
    sumI += s * Math.cos(p);
    sumQ += s * (-Math.sin(p));
  }
  dsI[k] = sumI / DS_FACTOR;
  dsQ[k] = sumQ / DS_FACTOR;
  phase += dphi * DS_FACTOR;
  phase = phase % (2 * Math.PI);
}

console.log(`Downsampled to ${dsLen} samples`);

// Now estimate tones from downsampled signal
console.log('\nSync symbol analysis from downsampled signal:');
for (let g = 0; g < 4; g++) {
  const gName = String.fromCharCode(97+g);
  for (let s = 0; s < 4; s++) {
    const symIdx = syncPos[g] + s;
    const sampleStart = symIdx * DS_SPSYM; // in downsampled domain

    // DFT at 4 tone frequencies (normalized to DS domain)
    const mags = [];
    for (let tone = 0; tone < 4; tone++) {
      const freqNorm = tone / DS_SPSYM;
      let sr = 0, si = 0;
      for (let j = 0; j < DS_SPSYM; j++) {
        const idx = sampleStart + j;
        if (idx >= dsLen) break;
        const angle = 2 * Math.PI * freqNorm * j;
        sr += dsI[idx] * Math.cos(angle) + dsQ[idx] * Math.sin(angle);
        si += dsQ[idx] * Math.cos(angle) - dsI[idx] * Math.sin(angle);
      }
      mags.push(Math.sqrt(sr*sr + si*si));
    }
    const bestTone = mags.indexOf(Math.max(...mags));
    const expected = costas[g][s];
    const match = bestTone === expected ? 'OK' : 'MISMATCH';
    console.log(`  costas_${gName}[${s}]: detected=${bestTone} expected=${expected} mags=[${mags.map(m=>m.toFixed(2)).join(',')}] ${match}`);
  }
}

// Check what offset the decoder would need
console.log(`\nFrame spans symbols 0-104 = samples 0-${NN*SPSYM} in original`);
console.log(`In downsampled domain: 0 to ${Math.floor(NN*SPSYM/DS_FACTOR)} samples`);
console.log(`DS frame = ${NN * DS_SPSYM} = ${NN * DS_SPSYM} samples`);
console.log(`Actual DS length = ${dsLen}`);
