// JTCAT AudioWorklet processor — captures audio on the audio thread,
// downsamples to 12kHz with proper anti-alias filtering, and posts
// 4096-sample buffers to the main thread.

// Generate windowed sinc low-pass FIR filter coefficients
function designLowPass(cutoffRatio, numTaps) {
  const coeffs = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const n = i - mid;
    // Sinc function
    let h;
    if (Math.abs(n) < 1e-6) {
      h = 2 * cutoffRatio;
    } else {
      h = Math.sin(2 * Math.PI * cutoffRatio * n) / (Math.PI * n);
    }
    // Blackman window
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (numTaps - 1))
            + 0.08 * Math.cos(4 * Math.PI * i / (numTaps - 1));
    coeffs[i] = h * w;
    sum += coeffs[i];
  }
  // Normalize
  for (let i = 0; i < numTaps; i++) coeffs[i] /= sum;
  return coeffs;
}

class JtcatProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.dsRatio = (options.processorOptions && options.processorOptions.dsRatio) || 1;

    if (this.dsRatio > 1.01) {
      // Design anti-alias low-pass filter
      // Cutoff at 0.45 * (1/dsRatio) of Nyquist to prevent aliasing
      // (slightly below 6kHz for 48kHz->12kHz to leave transition band)
      const cutoffRatio = 0.45 / this.dsRatio;
      const numTaps = Math.max(31, Math.round(this.dsRatio * 16) | 1); // odd number
      this.filterCoeffs = designLowPass(cutoffRatio, numTaps);
      this.filterHistory = new Float32Array(numTaps);
      this.filterIdx = 0;
      this.decimateCounter = 0;
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    if (this.dsRatio > 1.01) {
      const coeffs = this.filterCoeffs;
      const history = this.filterHistory;
      const numTaps = coeffs.length;
      const ratio = Math.round(this.dsRatio);

      for (let i = 0; i < input.length; i++) {
        // Feed sample into FIR filter ring buffer
        history[this.filterIdx] = input[i];
        this.filterIdx = (this.filterIdx + 1) % numTaps;
        this.decimateCounter++;

        // Output one sample every dsRatio input samples
        if (this.decimateCounter >= ratio) {
          this.decimateCounter = 0;
          // Convolve: compute filtered output
          let sum = 0;
          let idx = this.filterIdx; // oldest sample
          for (let t = 0; t < numTaps; t++) {
            sum += history[idx] * coeffs[t];
            idx = (idx + 1) % numTaps;
          }
          this.buffer.push(sum);
        }
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
