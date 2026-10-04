'use strict';
// JTTY decoder worker. The receiver (lib/jtty/decoder.js) spends ~120 ms of
// CPU on every quarter-frame step (0.472 s of audio), which is fine for a
// thread of its own and far too much to run inline in the Electron main
// process the way the sub-millisecond PSK31 chain does. This worker owns one
// JttyDecoder; lib/jtty-engine.js feeds it audio and relays its updates.
//
// Messages in:  { type:'reset', qsoFreq }          new decoder state
//               { type:'qso-freq', qsoFreq }       move the QSO window
//               { type:'feed', samples }           Float32Array, 12 kHz mono
// Messages out: { type:'ready' }
//               { type:'updates', updates:[...] }  decoder.feed()'s result
//               { type:'error', message }

const { parentPort } = require('worker_threads');
const { JttyDecoder } = require('./decoder');

let decoder = new JttyDecoder();

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'reset':
        decoder = new JttyDecoder({ qsoFreq: msg.qsoFreq == null ? 1500 : msg.qsoFreq, qsoTol: 50 });
        break;
      case 'qso-freq':
        decoder.setQsoFreq(msg.qsoFreq);
        break;
      case 'feed': {
        const samples = msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples);
        const updates = decoder.feed(samples);
        if (updates.length) parentPort.postMessage({ type: 'updates', updates });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
});

parentPort.postMessage({ type: 'ready' });
