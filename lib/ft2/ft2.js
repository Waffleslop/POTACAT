/**
 * FT2 WASM wrapper — exposes decode() and encode() with the same interface as ft8js.
 *
 * Usage (CommonJS, from worker thread):
 *   const ft2 = require('./ft2/ft2');
 *   await ft2.init();
 *   const results = await ft2.decode(float32Array);
 *   const samples = await ft2.encode('CQ K3SBP FN20', 1500);
 */

'use strict';

const path = require('path');

const FT2_TX_SAMPLES = 30240;   // 105 symbols * 288 samples/symbol
const FT2_INPUT_SAMPLES = 45000; // 3.75s at 12 kHz
const RESULT_BUF_SIZE = 4096;

let Decoder = null;
let Encoder = null;
let _initPromise = null;

// Wrapped C functions
let _ft2InitDecode = null;
let _ft2ExecDecode = null;
let _ft2ExecEncode = null;

/**
 * Initialize both WASM modules. Call once before decode/encode.
 */
async function init() {
  if (_initPromise) return _initPromise;
  _initPromise = _doInit();
  return _initPromise;
}

async function _doInit() {
  const fs = require('fs');
  const { pathToFileURL } = require('url');
  const wasmDir = path.join(__dirname, 'wasm');

  // The Emscripten-generated JS files use import.meta.url (ESM).
  // Patch them at load time to work in CommonJS by replacing import.meta.url
  // with the file's URL and removing the createRequire(import.meta.url) call.
  function loadWasmModule(jsFile) {
    const filePath = path.join(wasmDir, jsFile);
    let src = fs.readFileSync(filePath, 'utf8');
    const fileUrl = pathToFileURL(filePath).href;
    // Replace import.meta.url with the actual file URL
    src = src.replace(/import\.meta\.url/g, JSON.stringify(fileUrl));
    // Remove entire createRequire block (not needed in CJS — require already exists)
    src = src.replace(/const\s*\{\s*createRequire\s*\}\s*=\s*await\s+import\([^)]+\);/g, '');
    src = src.replace(/var\s+require\s*=\s*createRequire\([^)]+\);/g, '');
    // Replace 'export default' with module.exports assignment
    src = src.replace(/export\s+default\s+(\w+);/, 'module.exports = $1;');
    // Write to a temp file and require it (eval doesn't handle async top-level well)
    const tmpPath = filePath + '.cjs';
    fs.writeFileSync(tmpPath, src);
    const mod = require(tmpPath);
    try { fs.unlinkSync(tmpPath); } catch {}
    return mod;
  }

  const decFactory = loadWasmModule('ft2_decode.js');
  const encFactory = loadWasmModule('ft2_encode.js');
  Decoder = await decFactory();
  Encoder = await encFactory();

  _ft2InitDecode = Decoder.cwrap('ft2_init_decode', null, []);
  _ft2ExecDecode = Decoder.cwrap('ft2_exec_decode', null, ['number', 'number', 'number'], { async: true });
  _ft2ExecEncode = Encoder.cwrap('ft2_exec_encode', 'number', ['string', 'number', 'number'], { async: true });

  _ft2InitDecode();
}

/**
 * Decode FT2 audio samples.
 * @param {Float32Array} samples — mono audio at 12000 Hz, up to 45000 samples
 * @returns {Promise<Array<{db: number, dt: number, df: number, text: string}>>}
 */
async function decode(samples) {
  if (!Decoder) await init();

  const nSamples = Math.min(samples.length, FT2_INPUT_SAMPLES);

  // Allocate input buffer in WASM heap
  const inputPtr = Decoder._malloc(nSamples * 4);
  Decoder.HEAPF32.set(samples.subarray(0, nSamples), inputPtr / 4);

  // Allocate result buffer
  const resultPtr = Decoder._malloc(RESULT_BUF_SIZE);

  await _ft2ExecDecode(inputPtr, nSamples, resultPtr);

  // Read result string
  const resultBytes = new Uint8Array(Decoder.HEAPU8.buffer, resultPtr, RESULT_BUF_SIZE);
  let resultStr = '';
  for (let i = 0; i < RESULT_BUF_SIZE && resultBytes[i] !== 0; i++) {
    resultStr += String.fromCharCode(resultBytes[i]);
  }

  Decoder._free(inputPtr);
  Decoder._free(resultPtr);

  // Parse CSV: snr,dt,df,text
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

/**
 * Encode an FT2 message to audio samples.
 * @param {string} text — FT2/FT8 message (e.g. "CQ K3SBP FN20")
 * @param {number} frequency — audio frequency in Hz
 * @returns {Promise<Float32Array|null>}
 */
async function encode(text, frequency) {
  if (!Encoder) await init();

  const outputPtr = Encoder._malloc(FT2_TX_SAMPLES * 4);

  const rc = await _ft2ExecEncode(text, frequency, outputPtr);

  if (rc !== 0) {
    Encoder._free(outputPtr);
    return null;
  }

  const samples = new Float32Array(FT2_TX_SAMPLES);
  samples.set(Encoder.HEAPF32.subarray(outputPtr / 4, outputPtr / 4 + FT2_TX_SAMPLES));

  Encoder._free(outputPtr);
  return samples;
}

module.exports = { init, decode, encode, FT2_TX_SAMPLES, FT2_INPUT_SAMPLES };
