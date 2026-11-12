// Modem audio bridge — capture side. Collects the radio's RX audio from the
// AudioContext (128-frame blocks at the context's native rate) into 20 ms
// batches and posts each batch to the page (main's meter and VARA's cable)
// and, when it has one, straight to the modem audio lane (#187,
// lib/modem-audio-lane.js) on its own MessagePort, so the modem's receive
// audio never waits on the main process.
//
// Each lane batch carries `skipped`: render quanta the audio thread never ran
// (currentFrame jumped), i.e. audio the device produced that never reached
// the modem. Loss is counted in samples, not against any clock.
class ModemCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = Math.round(sampleRate * 0.02); // 20 ms at the native rate
    this.buf = new Float32Array(this.batch);
    this.fill = 0;
    this.peak = 0;
    this.blocks = 0;
    this.lane = null;
    this.nextFrame = -1;
    this.skipped = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'lane' && e.ports && e.ports[0]) { this.lane = e.ports[0]; this.nextFrame = -1; this.skipped = 0; }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (typeof currentFrame === 'number') {
      if (this.nextFrame >= 0 && currentFrame > this.nextFrame) this.skipped += currentFrame - this.nextFrame;
      this.nextFrame = currentFrame + 128;
    }
    if (!ch || !ch.length) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.buf[this.fill++] = v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.fill >= this.batch) {
        const pcm = this.buf.slice(0, this.fill);
        if (this.lane) {
          try { this.lane.postMessage({ pcm, sampleRate, skipped: this.skipped }); } catch (e) { /* lane gone */ }
          this.skipped = 0;
        }
        this.port.postMessage({ pcm, sampleRate, peak: this.peak });
        this.fill = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}
registerProcessor('modem-capture', ModemCaptureProcessor);
