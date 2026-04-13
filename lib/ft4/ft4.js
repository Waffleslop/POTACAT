/**
 * FT4 WASM wrapper — exposes decode() and encode() with the same interface as ft8js/ft2.
 *
 * Usage (CommonJS, from worker thread):
 *   const ft4 = require('./ft4/ft4');
 *   await ft4.init();
 *   const results = await ft4.decode(float32Array);
 *   const samples = await ft4.encode('CQ K3SBP FN20', 1500);
 */

'use strict';

const path = require('path');

const FT4_TX_SAMPLES = 60480;    // 105 symbols * 576 samples/symbol
const FT4_INPUT_SAMPLES = 90000; // 7.5s at 12 kHz
const RESULT_BUF_SIZE = 4096;

let Decoder = null;
let Encoder = null;
let _initPromise = null;

let _ft4InitDecode = null;
let _ft4ExecDecode = null;
let _ft4ExecEncode = null;

async function init() {
  if (_initPromise) return _initPromise;
  _initPromise = _doInit();
  return _initPromise;
}

async function _doInit() {
  const fs = require('fs');
  const { pathToFileURL } = require('url');
  const wasmDir = path.join(__dirname, 'wasm');

  // Patch Emscripten ESM files for CommonJS compatibility
  function loadWasmModule(jsFile) {
    const filePath = path.join(wasmDir, jsFile);
    let src = fs.readFileSync(filePath, 'utf8');
    const fileUrl = pathToFileURL(filePath).href;
    src = src.replace(/import\.meta\.url/g, JSON.stringify(fileUrl));
    src = src.replace(/const\s*\{\s*createRequire\s*\}\s*=\s*await\s+import\([^)]+\);/g, '');
    src = src.replace(/var\s+require\s*=\s*createRequire\([^)]+\);/g, '');
    src = src.replace(/export\s+default\s+(\w+);/, 'module.exports = $1;');
    // Write temp file outside asar (asar is read-only in packaged builds)
    const os = require('os');
    const tmpPath = path.join(os.tmpdir(), 'potacat-' + jsFile + '.cjs');
    fs.writeFileSync(tmpPath, src);
    const mod = require(tmpPath);
    try { fs.unlinkSync(tmpPath); } catch {}
    return mod;
  }

  const decFactory = loadWasmModule('ft4_decode.js');
  const encFactory = loadWasmModule('ft4_encode.js');
  Decoder = await decFactory();
  Encoder = await encFactory();

  _ft4InitDecode = Decoder.cwrap('ft4_init_decode', null, []);
  _ft4ExecDecode = Decoder.cwrap('ft4_exec_decode', null, ['number', 'number', 'number'], { async: true });
  _ft4ExecEncode = Encoder.cwrap('ft4_exec_encode', 'number', ['string', 'number', 'number'], { async: true });

  _ft4InitDecode();
}

async function decode(samples) {
  if (!Decoder) await init();

  const nSamples = Math.min(samples.length, FT4_INPUT_SAMPLES);

  const inputPtr = Decoder._malloc(nSamples * 4);
  Decoder.HEAPF32.set(samples.subarray(0, nSamples), inputPtr / 4);

  const resultPtr = Decoder._malloc(RESULT_BUF_SIZE);

  await _ft4ExecDecode(inputPtr, nSamples, resultPtr);

  const resultBytes = new Uint8Array(Decoder.HEAPU8.buffer, resultPtr, RESULT_BUF_SIZE);
  let resultStr = '';
  for (let i = 0; i < RESULT_BUF_SIZE && resultBytes[i] !== 0; i++) {
    resultStr += String.fromCharCode(resultBytes[i]);
  }

  Decoder._free(inputPtr);
  Decoder._free(resultPtr);

  const results = [];
  const lines = resultStr.split('\n').filter(l => l.length > 0);
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length >= 4) {
      results.push({
        db: Math.round(parseFloat(parts[0])),
        dt: parseFloat(parseFloat(parts[1]).toFixed(1)),
        df: Math.round(parseFloat(parts[2])),
        text: parts.slice(3).join(',').trim(),
      });
    }
  }
  return results;
}

async function encode(text, frequency) {
  if (!Encoder) await init();

  const outputPtr = Encoder._malloc(FT4_TX_SAMPLES * 4);

  const rc = await _ft4ExecEncode(text, frequency, outputPtr);

  if (rc !== 0) {
    Encoder._free(outputPtr);
    return null;
  }

  const samples = new Float32Array(FT4_TX_SAMPLES);
  samples.set(Encoder.HEAPF32.subarray(outputPtr / 4, outputPtr / 4 + FT4_TX_SAMPLES));

  Encoder._free(outputPtr);
  return samples;
}

module.exports = { init, decode, encode, FT4_TX_SAMPLES, FT4_INPUT_SAMPLES };
