// Modem audio bridge — playback side. The modem's TX audio arrives from main
// as 24 kHz Float32 chunks (lib/modem-audio-server.js 'tx' events) and lands
// in a ring buffer; process() drains it with linear interpolation to the
// AudioContext's native rate. Same shape as jtcat-vita49-source-worklet.js
// (one node, fed forever), with a shorter window: a modem's TX timing is the
// radio's, so 300 ms of backlog is dropped rather than played late.
class ModemPlayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = opts.sourceRate || 24000;
    this.targetRate = sampleRate;
    this.step = this.sourceRate / this.targetRate;
    this.bufSize = Math.ceil(this.sourceRate * 0.3);
    this.buf = new Float32Array(this.bufSize);
    this.bufRead = 0; this.bufWrite = 0; this.bufAvailable = 0;
    this.fracPos = 0;
    this.underruns = 0; this.overflows = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.cmd === 'reset') { this.bufRead = this.bufWrite = this.bufAvailable = 0; this.fracPos = 0; return; }
      if (msg && msg.cmd === 'stats') { this.port.postMessage({ stats: { underruns: this.underruns, overflows: this.overflows, queued: this.bufAvailable } }); return; }
      const pcm = msg;
      if (!pcm || !pcm.length) return;
      if (this.bufAvailable + pcm.length > this.bufSize) {
        const drop = (this.bufAvailable + pcm.length) - Math.floor(this.bufSize * 0.5);
        this.bufRead = (this.bufRead + drop) % this.bufSize;
        this.bufAvailable -= drop;
        this.overflows++;
      }
      for (let i = 0; i < pcm.length; i++) {
        this.buf[this.bufWrite] = pcm[i];
        this.bufWrite = (this.bufWrite + 1) % this.bufSize;
      }
      this.bufAvailable += pcm.length;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      if (this.bufAvailable < 2) { out[i] = 0; if (this.bufAvailable === 0) this.underruns++; continue; }
      const i0 = this.bufRead, i1 = (this.bufRead + 1) % this.bufSize;
      out[i] = this.buf[i0] + (this.buf[i1] - this.buf[i0]) * this.fracPos;
      this.fracPos += this.step;
      while (this.fracPos >= 1 && this.bufAvailable > 1) {
        this.fracPos -= 1;
        this.bufRead = (this.bufRead + 1) % this.bufSize;
        this.bufAvailable--;
      }
    }
    return true;
  }
}
registerProcessor('modem-play', ModemPlayProcessor);
