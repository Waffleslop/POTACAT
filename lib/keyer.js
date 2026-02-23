// Iambic CW Keyer — state machine for MIDI paddle input
// Modes: iambicA, iambicB, straight
// Emits 'key' events with { down: bool, timestamp: number (16-bit ms) }

const { EventEmitter } = require('events');

const IDLE = 0;
const TONE_PLAYING = 1;
const IES = 2; // inter-element space

class IambicKeyer extends EventEmitter {
  constructor() {
    super();
    this._wpm = 20;
    this._mode = 'iambicB'; // 'iambicA', 'iambicB', 'straight'
    this._swapPaddles = false;
    this._state = IDLE;
    this._toneTimer = null;
    this._iesTimer = null;
    this._safetyTimer = null;

    // Paddle states (live)
    this._ditPressed = false;
    this._dahPressed = false;

    // Latches — set when opposite paddle pressed during element
    this._ditLatch = false;
    this._dahLatch = false;

    // What element is currently playing (true = dit, false = dah)
    this._currentIsDit = false;

    // Both-held-at-start flag for Mode B squeeze detection
    this._bothAtStart = false;

    // Timestamp tracking — accumulated from sequence start for jitter-free timing
    this._sequenceStart = 0;
    this._elapsedMs = 0;
  }

  get ditMs() { return Math.round(1200 / this._wpm); }
  get dahMs() { return this.ditMs * 3; }

  setWpm(wpm) {
    this._wpm = Math.max(5, Math.min(50, wpm));
  }

  setMode(mode) {
    if (['iambicA', 'iambicB', 'straight'].includes(mode)) {
      this._mode = mode;
      if (this._state !== IDLE) this.stop();
    }
  }

  setSwapPaddles(swap) {
    this._swapPaddles = !!swap;
  }

  // --- Paddle input from IPC ---

  paddleDit(pressed) {
    if (this._swapPaddles) {
      this._handleDah(pressed);
    } else {
      this._handleDit(pressed);
    }
  }

  paddleDah(pressed) {
    if (this._swapPaddles) {
      this._handleDit(pressed);
    } else {
      this._handleDah(pressed);
    }
  }

  _handleDit(pressed) {
    this._ditPressed = pressed;
    if (this._mode === 'straight') {
      // Straight key: raw passthrough, no element generation
      this._emitKey(pressed);
      return;
    }
    if (pressed) {
      if (this._state === IDLE) {
        this._sequenceStart = Date.now();
        this._elapsedMs = 0;
        this._startElement(true);
      } else {
        // Latch dit for pickup after current element
        this._ditLatch = true;
      }
    }
  }

  _handleDah(pressed) {
    this._dahPressed = pressed;
    if (this._mode === 'straight') {
      // In straight mode, dah paddle does nothing (or could be secondary key)
      return;
    }
    if (pressed) {
      if (this._state === IDLE) {
        this._sequenceStart = Date.now();
        this._elapsedMs = 0;
        this._startElement(false);
      } else {
        // Latch dah for pickup after current element
        this._dahLatch = true;
      }
    }
  }

  // --- Element generation ---

  _startElement(isDit) {
    this._state = TONE_PLAYING;
    this._currentIsDit = isDit;
    this._bothAtStart = this._ditPressed && this._dahPressed;

    // Clear latches at start of new element
    this._ditLatch = false;
    this._dahLatch = false;

    const duration = isDit ? this.ditMs : this.dahMs;

    // Key down
    this._emitKey(true);

    // Schedule tone end
    this._clearTimers();
    this._toneTimer = setTimeout(() => this._onToneEnd(), duration);
    this._startSafety();
  }

  _onToneEnd() {
    this._toneTimer = null;
    // Key up
    const duration = this._currentIsDit ? this.ditMs : this.dahMs;
    this._elapsedMs += duration;
    this._emitKey(false);

    // Inter-element space
    this._state = IES;
    this._iesTimer = setTimeout(() => this._onIesEnd(), this.ditMs);
  }

  _onIesEnd() {
    this._iesTimer = null;
    this._elapsedMs += this.ditMs;

    // Decide next element by priority:
    const oppositeLatch = this._currentIsDit ? this._dahLatch : this._ditLatch;
    const oppositePressed = this._currentIsDit ? this._dahPressed : this._ditPressed;
    const sameLatch = this._currentIsDit ? this._ditLatch : this._dahLatch;
    const samePressed = this._currentIsDit ? this._ditPressed : this._dahPressed;

    // 1. Alternation: opposite paddle latched or currently pressed
    if (oppositeLatch || oppositePressed) {
      this._startElement(!this._currentIsDit);
      return;
    }

    // 2. Repetition: same paddle still pressed
    if (sameLatch || samePressed) {
      this._startElement(this._currentIsDit);
      return;
    }

    // 3. Mode B squeeze: both paddles were held at element start, both now released
    if (this._mode === 'iambicB' && this._bothAtStart &&
        !this._ditPressed && !this._dahPressed) {
      // Send one more alternating element
      this._bothAtStart = false; // prevent infinite loop
      this._startElement(!this._currentIsDit);
      return;
    }

    // 4. Nothing pending — return to idle
    this._state = IDLE;
    this._clearSafety();
  }

  // --- Key event emission ---

  _emitKey(down) {
    // 16-bit ms timestamp for SmartSDR (wraps at 0xFFFF)
    const timestamp = (this._sequenceStart + this._elapsedMs) & 0xFFFF;
    this.emit('key', { down, timestamp });
  }

  // --- Stop / cleanup ---

  stop() {
    this._clearTimers();
    this._clearSafety();
    this._ditPressed = false;
    this._dahPressed = false;
    this._ditLatch = false;
    this._dahLatch = false;
    if (this._state !== IDLE) {
      this._state = IDLE;
      // Ensure key up
      this._emitKey(false);
    }
  }

  _clearTimers() {
    if (this._toneTimer) { clearTimeout(this._toneTimer); this._toneTimer = null; }
    if (this._iesTimer) { clearTimeout(this._iesTimer); this._iesTimer = null; }
  }

  _startSafety() {
    this._clearSafety();
    this._safetyTimer = setTimeout(() => {
      if (this._state !== IDLE) {
        this.stop();
      }
    }, 1000);
  }

  _clearSafety() {
    if (this._safetyTimer) { clearTimeout(this._safetyTimer); this._safetyTimer = null; }
  }
}

module.exports = { IambicKeyer };
