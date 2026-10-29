'use strict';
// Worker host for lib/rtltcp-demod.js (lib/rtltcp-audio.js starts it).
// Messages in:  {type:'config', inputRate, mode, offsetHz}  {type:'iq', buf}
// Messages out: {type:'audio', audio (Float32Array, transferred), sampleRate, powerDb}

const { parentPort } = require('worker_threads');
const { Demodulator } = require('./rtltcp-demod');

let demod = null;

parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'config') {
    if (!demod || demod.inputRate !== msg.inputRate) {
      demod = new Demodulator({ inputRate: msg.inputRate, mode: msg.mode, offsetHz: msg.offsetHz });
    } else {
      demod.setMode(msg.mode);
      demod.setOffset(msg.offsetHz);
    }
    return;
  }
  if (msg.type === 'iq' && demod) {
    const r = demod.processU8(new Uint8Array(msg.buf));
    if (r.audio.length) parentPort.postMessage({ type: 'audio', audio: r.audio, sampleRate: r.sampleRate, powerDb: r.powerDb }, [r.audio.buffer]);
  }
});
