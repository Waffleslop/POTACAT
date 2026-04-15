// SSTV AudioWorklet processor — captures audio at native sample rate (48kHz)
// and posts buffers to the main thread. NO downsampling — SSTV needs full
// bandwidth (1100-2300 Hz) unlike FT8 which downsamples to 12kHz.

class SstvProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buffer.push(input[i]);
    }

    // Post 4096-sample buffers (~85ms at 48kHz)
    if (this.buffer.length >= 4096) {
      this.port.postMessage(this.buffer.splice(0, 4096));
    }
    return true;
  }
}
registerProcessor('sstv-processor', SstvProcessor);
