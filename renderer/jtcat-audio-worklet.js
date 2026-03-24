// JTCAT AudioWorklet processor — captures audio on the audio thread,
// downsamples to 12kHz, and posts 4096-sample buffers to the main thread.
class JtcatProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.dsRatio = (options.processorOptions && options.processorOptions.dsRatio) || 1;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    if (this.dsRatio > 1.01) {
      const outLen = Math.floor(input.length / this.dsRatio);
      for (let i = 0; i < outLen; i++) {
        this.buffer.push(input[Math.round(i * this.dsRatio)]);
      }
    } else {
      for (let i = 0; i < input.length; i++) {
        this.buffer.push(input[i]);
      }
    }
    if (this.buffer.length >= 4096) {
      this.port.postMessage(this.buffer.splice(0, 4096));
    }
    return true;
  }
}
registerProcessor('jtcat-processor', JtcatProcessor);
