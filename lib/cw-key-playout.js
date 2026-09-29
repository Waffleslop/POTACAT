'use strict';
// Replays a remote client's CW keying at the shack with the timing the
// operator HEARD, through a small jitter buffer.
//
// Why: ECHOCAT Web runs an iambic keyer in the browser for sidetone, and until
// 2026-09-29 the shack ran a SECOND keyer from the paddle contacts forwarded
// over the network. The two produce the same CW only if every contact edge
// arrives with the same spacing it was made with. Over the internet it does
// not: a dit tap whose release is delayed by jitter becomes two dits at the
// shack, an opposite-paddle press that arrives late misses the element it was
// meant to latch into — the operator hears perfect sidetone while the radio
// sends something else (LZ3AW TS-480, 400 km away: "errors ... especially
// with the dots"). Now the client's keyer is the only keyer: it sends each
// element with its ideal start time and length (`cw-key`), and this plays
// them out at exactly that spacing, a fixed delay behind.
//
// Timing model: a streak (keying with no gap longer than idleGapMs) is
// anchored when its first message arrives: shack time = client `at` + offset,
// offset = now + bufferMs - at. Every later message in the streak keeps the
// same offset, so network jitter up to bufferMs disappears. A message that
// arrives later than its slot is played at once, the offset slides by the
// lateness (so the REST of the streak keeps its spacing), and the buffer
// grows for later streaks. Elements are never shortened, merged or dropped.
//
// Safety: an iambic element carries its own length, so its key-up is
// scheduled when it arrives and cannot be lost. A straight-key down has no
// end until its up arrives: maxDownMs forces the key up (and the server's
// paddle watchdog, fed by hold keepalives, catches a dead client sooner).

class CwKeyPlayout {
  /**
   * @param {object} o
   * @param {(evt: {down: boolean, timestamp: number}) => void} o.output  keys the radio
   * @param {() => number} [o.now]
   * @param {(fn: Function, ms: number) => any} [o.setTimer]
   * @param {(h: any) => void} [o.clearTimer]
   * @param {number} [o.bufferMs]    starting jitter buffer
   * @param {number} [o.maxBufferMs]
   * @param {number} [o.idleGapMs]   a gap this long starts a new streak (re-anchor)
   * @param {number} [o.maxDownMs]   longest key-down a straight key may hold
   * @param {(line: string) => void} [o.log]
   */
  constructor(o) {
    this._output = o.output;
    this._now = o.now || (() => Date.now());
    this._setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = o.clearTimer || ((h) => clearTimeout(h));
    this._baseBufferMs = o.bufferMs != null ? o.bufferMs : 120;
    this._bufferMs = this._baseBufferMs;
    this._maxBufferMs = o.maxBufferMs != null ? o.maxBufferMs : 600;
    this._idleGapMs = o.idleGapMs != null ? o.idleGapMs : 1500;
    this._maxDownMs = o.maxDownMs != null ? o.maxDownMs : 3000;
    this._log = o.log || (() => {});
    this._offset = null;
    this._lastMsgAt = 0;       // shack time of the last message
    this._lastUpAt = 0;        // shack time of the last scheduled key-up
    this._events = [];         // { at, down, h }
    this._down = false;        // what the radio is being told right now
    this._straightDown = false; // a straight-key down is pending its up
    this._maxDownTimer = null;
    this._lateInStreak = 0;
    this._worstLateMs = 0;
  }

  get bufferMs() { return this._bufferMs; }
  /** A straight-key down is waiting for its up (the server watches these). */
  get straightDown() { return this._straightDown; }
  get busy() { return this._down || this._events.length > 0; }

  /**
   * One cw-key message.
   * @param {{at: number, down: boolean, ms?: number, cancel?: boolean}} msg
   *   at: the client's time for this edge (ms, any monotonic origin)
   *   down + ms: an iambic element of that length starting at `at`
   *   down, no ms: a straight-key press; its up arrives separately
   *   !down: key up at `at`; with cancel, also drop anything scheduled after it
   */
  push(msg) {
    const at = Number(msg && msg.at);
    if (!Number.isFinite(at)) return;
    const now = this._now();
    if (this._offset == null || (!this.busy && now - this._lastMsgAt > this._idleGapMs)) {
      this._startStreak(now, at);
    }
    this._lastMsgAt = now;
    let playAt = at + this._offset;
    if (playAt < now) {
      const late = now - playAt;
      this._offset += late;
      playAt = now;
      this._lateInStreak++;
      if (late > this._worstLateMs) this._worstLateMs = late;
      this._bufferMs = Math.min(this._maxBufferMs, Math.max(this._bufferMs, this._baseBufferMs + late + 20));
    }

    if (msg.down) {
      // Never overlap the previous element: the client spaced them, but a
      // slid offset or a clock hiccup must not merge two into one long one.
      const downAt = Math.max(playAt, this._lastUpAt + 2);
      const ms = Number(msg.ms);
      if (Number.isFinite(ms) && ms > 0) {
        const len = Math.max(5, Math.min(1000, ms));
        this._schedule(downAt, true);
        this._schedule(downAt + len, false);
        this._lastUpAt = downAt + len;
      } else {
        this._straightDown = true;
        this._schedule(downAt, true);
        this._lastUpAt = downAt;
        this._armMaxDown(downAt);
      }
      return;
    }

    // Key up.
    if (msg.cancel) this._dropAfter(playAt);
    const upAt = Math.max(playAt, this._lastUpAt);
    this._straightDown = false;
    this._clearMaxDown();
    this._schedule(upAt, false);
    this._lastUpAt = upAt;
  }

  /** Stop at once: drop everything scheduled and key the radio up. */
  stop() {
    for (const e of this._events) this._clearTimer(e.h);
    this._events = [];
    this._clearMaxDown();
    this._straightDown = false;
    this._offset = null;
    this._lastUpAt = 0;
    this._key(false);
  }

  _startStreak(now, at) {
    if (this._lateInStreak) {
      this._log(`[CW] paddle stream: ${this._lateInStreak} element(s) arrived late over the network (worst ${Math.round(this._worstLateMs)} ms); keying delay now ${Math.round(this._bufferMs)} ms`);
    }
    this._lateInStreak = 0;
    this._worstLateMs = 0;
    // A quiet network earns the buffer back slowly, one streak at a time.
    this._bufferMs = Math.max(this._baseBufferMs, this._bufferMs - 10);
    this._offset = now + this._bufferMs - at;
    this._lastUpAt = 0;
  }

  _schedule(at, down) {
    const ev = { at, down, h: null };
    ev.h = this._setTimer(() => {
      const i = this._events.indexOf(ev);
      if (i >= 0) this._events.splice(i, 1);
      this._key(down);
    }, Math.max(0, at - this._now()));
    this._events.push(ev);
  }

  _dropAfter(t) {
    this._events = this._events.filter((e) => {
      if (e.at > t) { this._clearTimer(e.h); return false; }
      return true;
    });
    if (this._lastUpAt > t) this._lastUpAt = t;
  }

  _armMaxDown(downAt) {
    this._clearMaxDown();
    this._maxDownTimer = this._setTimer(() => {
      this._maxDownTimer = null;
      if (!this._straightDown) return;
      this._log(`[CW] paddle stream: a key-down lasted ${this._maxDownMs} ms with no key-up; keyed up`);
      this._straightDown = false;
      this._dropAfter(this._now());
      this._key(false);
    }, Math.max(0, downAt + this._maxDownMs - this._now()));
  }

  _clearMaxDown() {
    if (this._maxDownTimer) { this._clearTimer(this._maxDownTimer); this._maxDownTimer = null; }
  }

  _key(down) {
    if (down === this._down) return;
    this._down = down;
    this._output({ down, timestamp: this._now() });
  }
}

module.exports = { CwKeyPlayout };
