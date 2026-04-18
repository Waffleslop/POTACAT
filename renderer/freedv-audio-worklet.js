/**
 * FreeDV AudioWorklet Processor — downsamples 48kHz to 8kHz with
 * FIR anti-alias filter and converts Float32 to Int16.
 *
 * Same pattern as jtcat-audio-worklet.js but targeting 8kHz output.
 * Sends 640-sample Int16 chunks (one FreeDV 700E frame = 80ms).
 */
class FreedvProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const dsRatio = (options.processorOptions && options.processorOptions.dsRatio) || 6;
    this.ratio = Math.round(dsRatio);
    this.buffer = [];
    this.chunkSize = 640; // one 700E frame at 8kHz

    // Design windowed-sinc low-pass FIR filter
    if (this.ratio > 1) {
      const cutoff = 0.45 / this.ratio;
      const numTaps = Math.max(31, (this.ratio * 16) | 1);
      if (numTaps % 2 === 0) numTaps++;
      this.filterCoeffs = new Float32Array(numTaps);
      this.filterHistory = new Float32Array(numTaps);
      this.filterIdx = 0;
      this.decimateCounter = 0;

      const mid = (numTaps - 1) / 2;
      let sum = 0;
      for (let i = 0; i < numTaps; i++) {
        const n = i - mid;
        let h;
        if (Math.abs(n) < 1e-6) {
          h = 2 * cutoff;
        } else {
          h = Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
        }
        // Blackman window
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (numTaps - 1))
                + 0.08 * Math.cos(4 * Math.PI * i / (numTaps - 1));
        this.filterCoeffs[i] = h * w;
        sum += this.filterCoeffs[i];
      }
      for (let i = 0; i < numTaps; i++) this.filterCoeffs[i] /= sum;
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    if (this.ratio > 1) {
      const coeffs = this.filterCoeffs;
      const history = this.filterHistory;
      const numTaps = coeffs.length;

      for (let i = 0; i < input.length; i++) {
        history[this.filterIdx] = input[i];
        this.filterIdx = (this.filterIdx + 1) % numTaps;
        this.decimateCounter++;

        if (this.decimateCounter >= this.ratio) {
          this.decimateCounter = 0;
          // Convolve
          let val = 0;
          let idx = this.filterIdx;
          for (let t = 0; t < numTaps; t++) {
            val += history[idx] * coeffs[t];
            idx = (idx + 1) % numTaps;
          }
          // Float32 -> Int16 (clamp to ±32767)
          this.buffer.push(Math.max(-32767, Math.min(32767, Math.round(val * 32767))));
        }
      }
    } else {
      for (let i = 0; i < input.length; i++) {
        this.buffer.push(Math.max(-32767, Math.min(32767, Math.round(input[i] * 32767))));
      }
    }

    // Send chunks matching FreeDV frame size
    while (this.buffer.length >= this.chunkSize) {
      const chunk = new Int16Array(this.buffer.splice(0, this.chunkSize));
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}

registerProcessor('freedv-processor', FreedvProcessor);
