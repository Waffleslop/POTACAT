// Modem audio bridge — capture side. Collects the radio's RX audio from the
// AudioContext (128-frame blocks at the context's native rate) into 20 ms
// batches and posts each batch to the page, which forwards it to main and on
// to lib/modem-audio-server.js (which resamples to the modem's 12 kHz). The
// batch keeps IPC at ~50 messages/s, the rate the ECHOCAT bridge sustains.
class ModemCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = Math.round(sampleRate * 0.02); // 20 ms at the native rate
    this.buf = new Float32Array(this.batch);
    this.fill = 0;
    this.peak = 0;
    this.blocks = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.buf[this.fill++] = v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.fill >= this.batch) {
        this.port.postMessage({ pcm: this.buf.slice(0, this.fill), sampleRate, peak: this.peak });
        this.fill = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}
registerProcessor('modem-capture', ModemCaptureProcessor);
