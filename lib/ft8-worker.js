/**
 * FT8/FT2 decode/encode worker thread.
 * Runs ft8js and ft2 (ESM/WASM) in an isolated thread to avoid blocking the main process.
 *
 * Messages IN:
 *   { type: 'decode', id, samples: Float32Array }
 *   { type: 'encode', id, text: string, frequency: number }
 *   { type: 'ft2-decode', id, samples: Float32Array }
 *   { type: 'ft2-encode', id, text: string, frequency: number }
 *
 * Messages OUT:
 *   { type: 'decode-result', id, results: [{db, dt, df, text}] }
 *   { type: 'encode-result', id, samples: Float32Array | null }
 *   { type: 'error', id, message: string }
 *   { type: 'ready' }
 */

const { parentPort } = require('worker_threads');
const path = require('path');

let decode, encode;
let ft2Decode, ft2Encode;
let ft4Decode, ft4Encode;
let nativeDecode = null; // Native C ft8_lib decoder (much faster than WASM)

// --- SNR estimation from raw audio ---
// ft8js returns fake SNR (sync_score * 0.5). We replace it with a proper
// estimate using Goertzel DFT on the raw audio samples.

const SAMPLE_RATE = 12000;
const FT8_TONE_SPACING = 6.25;  // Hz
const FT8_NUM_TONES = 8;
const FT8_SIGNAL_BW = FT8_TONE_SPACING * FT8_NUM_TONES; // 50 Hz
const SNR_REF_BW = 2500; // WSJT-X reference bandwidth
// Correction: per-bin SNR -> SNR in 2500 Hz BW
const BW_CORRECTION = 10 * Math.log10(FT8_SIGNAL_BW / SNR_REF_BW); // -17.0 dB

function goertzelPower(samples, freqHz, N) {
  const k = freqHz * N / SAMPLE_RATE;
  const w = 2 * Math.PI * k / N;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (N * N);
}


function computeNoiseFloor(samples) {
  const N = samples.length;
  const noiseVals = [];
  for (let f = 200; f < 3000; f += 50) {
    noiseVals.push(goertzelPower(samples, f, N));
  }
  noiseVals.sort((a, b) => a - b);
  return noiseVals[Math.floor(noiseVals.length / 2)];
}

function estimateSNRWithNoise(samples, df, noisePower) {
  const N = samples.length;
  let sigPower = 0;
  for (let t = 0; t < FT8_NUM_TONES; t++) {
    sigPower += goertzelPower(samples, df + t * FT8_TONE_SPACING, N);
  }
  sigPower /= FT8_NUM_TONES;
  if (noisePower <= 0) return 0;
  return Math.round(10 * Math.log10(sigPower / noisePower) + BW_CORRECTION);
}

function fixSNR(results, samples) {
  if (!samples || !results || results.length === 0) return results;
  const noisePower = computeNoiseFloor(samples);
  return results.map(r => ({
    ...r,
    db: estimateSNRWithNoise(samples, r.df, noisePower),
  }));
}

async function init() {
  // Try native C decoder first (10-50x faster than WASM)
  try {
    const native = require(path.join(__dirname, 'ft8_native', 'build', 'Release', 'ft8_native.node'));
    nativeDecode = native.decode;
    console.log('[FT8 Worker] Native C decoder loaded (ft8_lib)');
  } catch (err) {
    console.log('[FT8 Worker] Native decoder not available, using WASM fallback:', err.message);
  }

  // WASM decoder (fallback for decode, always used for encode)
  try {
    const ft8 = await import('ft8js');
    decode = ft8.decode;
    encode = ft8.encode;
  } catch (err) {
    console.error('[FT8 Worker] Failed to load ft8js:', err.message);
  }

  try {
    const ft2 = require(path.join(__dirname, 'ft2', 'ft2.js'));
    await ft2.init();
    ft2Decode = ft2.decode;
    ft2Encode = ft2.encode;
  } catch (err) {
    console.error('[FT8 Worker] Failed to load ft2:', err.message);
  }

  try {
    const ft4 = require(path.join(__dirname, 'ft4', 'ft4.js'));
    await ft4.init();
    ft4Decode = ft4.decode;
    ft4Encode = ft4.encode;
  } catch (err) {
    console.error('[FT8 Worker] Failed to load ft4:', err.message);
  }

  parentPort.postMessage({ type: 'ready', native: !!nativeDecode });
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'decode') {
      const samples = new Float32Array(msg.samples);
      const t0 = Date.now();

      let results;
      if (nativeDecode) {
        // Native C decoder (ft8_lib) — ~10-50x faster than WASM
        const rawResults = nativeDecode(samples, 'FT8');
        results = fixSNR(rawResults, samples);
        console.log(`[FT8 Worker] NATIVE decode: ${results.length} decodes in ${Date.now() - t0}ms`);
      } else if (decode) {
        // WASM fallback
        const rawResults = await decode(samples);
        results = fixSNR(rawResults, samples);
        console.log(`[FT8 Worker] WASM decode: ${results.length} decodes in ${Date.now() - t0}ms`);
      } else {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'No decoder available' });
        return;
      }

      parentPort.postMessage({ type: 'decode-result', id: msg.id, results });

    } else if (msg.type === 'encode') {
      if (!encode) {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'ft8js not loaded yet' });
        return;
      }
      const samples = await encode(msg.text, msg.frequency);
      if (samples) {
        // Copy samples — WASM memory may use SharedArrayBuffer (Electron 39+/Chromium 134+)
        // which can't be transferred via postMessage. Copying to a fresh Float32Array
        // gives us a plain ArrayBuffer that CAN be transferred.
        const copy = new Float32Array(samples);
        const buf = copy.buffer;
        parentPort.postMessage(
          { type: 'encode-result', id: msg.id, samples: copy },
          [buf]
        );
      } else {
        parentPort.postMessage({ type: 'encode-result', id: msg.id, samples: null });
      }

    } else if (msg.type === 'ft2-decode') {
      if (!ft2Decode) {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'ft2 not loaded yet' });
        return;
      }
      const samples = new Float32Array(msg.samples);
      const results = await ft2Decode(samples);
      parentPort.postMessage({ type: 'decode-result', id: msg.id, results });

    } else if (msg.type === 'ft4-decode') {
      const samples = new Float32Array(msg.samples);
      const t0 = Date.now();
      let results;
      if (nativeDecode) {
        // Native C decoder supports FT4 too
        results = nativeDecode(samples, 'FT4');
        console.log(`[FT8 Worker] NATIVE FT4 decode: ${results.length} decodes in ${Date.now() - t0}ms`);
      } else if (ft4Decode) {
        results = await ft4Decode(samples);
      } else {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'No FT4 decoder available' });
        return;
      }
      parentPort.postMessage({ type: 'decode-result', id: msg.id, results });

    } else if (msg.type === 'ft4-encode') {
      if (!ft4Encode) {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'ft4 not loaded yet' });
        return;
      }
      const samples = await ft4Encode(msg.text, msg.frequency);
      if (samples) {
        const copy = new Float32Array(samples);
        const buf = copy.buffer;
        parentPort.postMessage(
          { type: 'encode-result', id: msg.id, samples: copy },
          [buf]
        );
      } else {
        parentPort.postMessage({ type: 'encode-result', id: msg.id, samples: null });
      }

    } else if (msg.type === 'ft2-encode') {
      if (!ft2Encode) {
        parentPort.postMessage({ type: 'error', id: msg.id, message: 'ft2 not loaded yet' });
        return;
      }
      const samples = await ft2Encode(msg.text, msg.frequency);
      if (samples) {
        const copy = new Float32Array(samples);
        const buf = copy.buffer;
        parentPort.postMessage(
          { type: 'encode-result', id: msg.id, samples: copy },
          [buf]
        );
      } else {
        parentPort.postMessage({ type: 'encode-result', id: msg.id, samples: null });
      }
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: err.message });
  }
});

init();
