/**
 * FreeDV Worker Thread — continuous streaming encode/decode.
 *
 * Unlike the FT8 worker (batch decode per cycle), FreeDV processes
 * audio frame-by-frame in real time. The worker maintains an internal
 * ring buffer and calls freedv_rx() whenever freedv_nin() samples
 * are available.
 *
 * Messages IN:
 *   { type: 'init', mode: 'MODE_700E' }
 *   { type: 'rx-audio', samples: Int16Array }
 *   { type: 'tx-audio', samples: Int16Array }
 *   { type: 'set-mode', mode: string }
 *   { type: 'set-squelch', enabled: bool, threshold: float }
 *   { type: 'stop' }
 *
 * Messages OUT:
 *   { type: 'ready', info: {...} }
 *   { type: 'rx-speech', samples: Int16Array }
 *   { type: 'rx-stats', sync: int, snr: float }
 *   { type: 'tx-modem', samples: Int16Array }
 *   { type: 'error', message: string }
 */

const { parentPort } = require('worker_threads');
const path = require('path');

let freedv = null;
let handle = null;
let info = null;
let rxBuffer = [];       // accumulates incoming demod samples
let statsCounter = 0;
const STATS_INTERVAL = 5; // emit stats every N rx frames (~10Hz at 80ms/frame)

function modeConstant(modeName) {
  if (!freedv) return 13; // default MODE_700E
  const modes = {
    'MODE_1600': freedv.MODE_1600,
    'MODE_700C': freedv.MODE_700C,
    'MODE_700D': freedv.MODE_700D,
    'MODE_700E': freedv.MODE_700E,
    '1600': freedv.MODE_1600,
    '700C': freedv.MODE_700C,
    '700D': freedv.MODE_700D,
    '700E': freedv.MODE_700E,
  };
  return modes[modeName] != null ? modes[modeName] : freedv.MODE_700E;
}

function initCodec(modeName) {
  try {
    if (!freedv) {
      freedv = require(path.join(__dirname, 'freedv_native', 'build', 'Release', 'freedv_native.node'));
      console.log('[FreeDV Worker] Native addon loaded');
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: 'Failed to load freedv_native: ' + err.message });
    return;
  }

  // Close existing handle
  if (handle != null) {
    try { freedv.close(handle); } catch {}
    handle = null;
  }

  const mode = modeConstant(modeName);
  handle = freedv.open(mode);
  if (handle == null) {
    parentPort.postMessage({ type: 'error', message: 'freedv_open failed for mode ' + modeName });
    return;
  }

  info = freedv.getInfo(handle);
  rxBuffer = [];
  statsCounter = 0;

  console.log(`[FreeDV Worker] Codec opened: mode=${modeName} speechRate=${info.speechRate} nSpeech=${info.nSpeech} nNomModem=${info.nNomModem}`);
  parentPort.postMessage({ type: 'ready', info });
}

function processRx(newSamples) {
  if (handle == null || !freedv) return;

  // Append to buffer
  for (let i = 0; i < newSamples.length; i++) rxBuffer.push(newSamples[i]);

  // Process frames as long as we have enough samples
  while (true) {
    const nin = freedv.getNin(handle);
    if (rxBuffer.length < nin) break;

    // Extract exactly nin samples
    const chunk = new Int16Array(nin);
    for (let i = 0; i < nin; i++) chunk[i] = rxBuffer[i];
    rxBuffer.splice(0, nin);

    // Decode
    const result = freedv.rx(handle, chunk);

    // Emit decoded speech if we have output and sync
    if (result.nout > 0) {
      const speech = result.speech;
      // Transfer ownership for efficiency
      parentPort.postMessage(
        { type: 'rx-speech', samples: speech },
        [speech.buffer]
      );
    }

    // Emit stats periodically (~10Hz)
    if (++statsCounter >= STATS_INTERVAL) {
      statsCounter = 0;
      parentPort.postMessage({
        type: 'rx-stats',
        sync: result.sync,
        snr: result.snr,
      });
    }
  }
}

function processTx(speechSamples) {
  if (handle == null || !freedv) return;

  // Process in frame-sized chunks
  const frameSize = info.nSpeech;
  for (let offset = 0; offset + frameSize <= speechSamples.length; offset += frameSize) {
    const frame = speechSamples.slice(offset, offset + frameSize);
    const modem = freedv.tx(handle, frame);
    parentPort.postMessage(
      { type: 'tx-modem', samples: modem },
      [modem.buffer]
    );
  }
}

// Message handler
parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'init':
        initCodec(msg.mode || 'MODE_700E');
        break;

      case 'rx-audio': {
        const samples = msg.samples instanceof Int16Array
          ? msg.samples
          : new Int16Array(msg.samples);
        processRx(samples);
        break;
      }

      case 'tx-audio': {
        const samples = msg.samples instanceof Int16Array
          ? msg.samples
          : new Int16Array(msg.samples);
        processTx(samples);
        break;
      }

      case 'set-mode':
        initCodec(msg.mode || 'MODE_700E');
        break;

      case 'set-squelch':
        // Squelch is handled at the engine level (mute speech when not synced)
        break;

      case 'stop':
        if (handle != null && freedv) {
          try { freedv.close(handle); } catch {}
          handle = null;
        }
        break;
    }
  } catch (err) {
    console.error('[FreeDV Worker] Error:', err.message);
    parentPort.postMessage({ type: 'error', message: err.message });
  }
});
