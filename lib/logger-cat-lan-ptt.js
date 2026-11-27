'use strict';
/**
 * Logger CAT keying on the Yaesu SCU-LAN10 route (#770).
 *
 * An outside program (WSJT-X, fldigi, JS8Call, GTTY through Hamlib's TS-2000)
 * sends TX;/RX; to Logger CAT. On the SCU-LAN10 its transmit audio has one way
 * to the radio: the VFO window's PTT microphone (a virtual cable). So a
 * key-down here is never a key-down of its own; it presses the VFO window's
 * PTT, and everything that stops that button stops this.
 *
 * The rules (Casey, #770):
 *  1. Same path as the VFO button: `press(on)` is the window's pttStart /
 *     pttStop. This module never keys the radio itself.
 *  2. Hard transmit timeout: `maxMs()` after the key-down it releases and logs
 *     why. Further key-downs from that program are refused until it sends PTT
 *     off, so a program stuck in TX cannot key straight back.
 *  3. Release on disconnect: when the connection that keyed closes, release
 *     at once (another program's connection closing does not).
 *  4. Off by default: unless `enabled()` is true, every key-down is refused.
 *
 * hooks: enabled() → bool; press(on) → false when there is no VFO window to
 * press (a key-down is then refused; a release must still reach the radio);
 * log(line); maxMs() → ms; setTimer/clearTimer for tests.
 */
class LoggerCatLanPtt {
  constructor(hooks) {
    this.h = { setTimer: setTimeout, clearTimer: clearTimeout, ...hooks };
    this.owner = null;      // the connection that keyed
    this.timer = null;
    this.timedOut = null;   // the connection whose key-down hit the limit, until it sends PTT off
  }

  get keyed() { return this.owner !== null; }

  /** TX;/RX; from `client`. Returns whether the radio is keyed for it now. */
  key(on, client) {
    if (!on) {
      if (this.timedOut === client) this.timedOut = null;
      if (this.owner === null) return false;
      if (this.owner !== client) {
        this.h.log('[PTT] logger CAT: PTT off from another program ignored — the program that keyed still holds PTT');
        return false;
      }
      this._release(null);
      return false;
    }
    if (!this.h.enabled()) {
      this.h.log('[PTT] logger CAT TX refused — keying by an outside program on the Yaesu LAN is off. Turn it on in Settings > Logger CAT');
      return false;
    }
    if (this.timedOut === client) {
      this.h.log('[PTT] logger CAT TX refused — this program hit the transmit time limit and has not sent PTT off yet');
      return false;
    }
    if (this.owner !== null) {
      if (this.owner === client) return true;          // a repeated key-down
      this.h.log('[PTT] logger CAT TX refused — another program is transmitting');
      return false;
    }
    if (this.h.press(true) === false) {
      this.h.log('[PTT] logger CAT TX refused — open the VFO window: on the Yaesu LAN it sends its PTT microphone, and that is the only way the program\'s audio reaches the radio');
      return false;
    }
    this.owner = client;
    const ms = this.h.maxMs();
    this.timer = this.h.setTimer(() => {
      this.timer = null;
      const who = this.owner;
      this._release(`on air longer than ${Math.round(ms / 1000)} s (PTT Safety Timeout) — PTT released`);
      this.timedOut = who;
    }, ms);
    return true;
  }

  /** A Logger CAT connection closed. */
  disconnect(client) {
    if (this.timedOut === client) this.timedOut = null;
    if (this.owner === client) this._release('the program disconnected while transmitting — PTT released');
  }

  /** Logger CAT stopped, the VFO window closed, the app quits. */
  stop(why) {
    this.timedOut = null;
    if (this.owner !== null) this._release(`${why} — PTT released`);
  }

  _release(why) {
    if (this.timer) { this.h.clearTimer(this.timer); this.timer = null; }
    this.owner = null;
    if (why) this.h.log(`[PTT] logger CAT: ${why}`);
    try { this.h.press(false); } catch {}
  }
}

module.exports = { LoggerCatLanPtt };
