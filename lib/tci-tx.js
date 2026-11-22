// SPDX-License-Identifier: Apache-2.0
'use strict';

// Transmitting through a TCI server (lib/tci-rig.js owns the socket; this
// module owns every key-down). Based on PR #632 by w5lee, tested on Zeus
// with a Hermes-Lite 2.
//
// How TCI transmits: the client sends `trx:0,true,tci;`, the server answers
// `trx:0,true;` and then asks for audio with header-only TX_CHRONO frames
// (stream type 3) naming how many samples it wants; each answer is a TX
// audio frame (type 2) of exactly that many 12 kHz mono float32 samples.
// The client never sends audio on its own clock.
//
// The rules, each one a case in test/tci-tx-safety-test.js:
//   1. No key-down except through startTx / startVoiceTx, and never on connect.
//   2. Every key-down ends: a deadline (the buffer's length plus 800 ms, or
//      the voice PTT timeout), a stall timer (no TX_CHRONO for 800 ms), and
//      for voice a mic timer (no phone audio for 800 ms).
//   3. A release is confirmed: `trx:0,false;` and then `trx:0,false;` back
//      within 500 ms, or a second TCI session sends the release (Zeus keeps
//      MOX on when the session that keyed it closes). A dropped socket goes
//      straight to that second session.
//   4. The drive cap (the rig's amplifier drive limit, in percent) is never
//      exceeded: setDrive clamps to it, and with a cap set no key-down goes
//      out until this session has set the drive (Zeus reports 50 % on every
//      new session until written).
//   5. Digital transmit needs DIGU (Zeus refuses digital audio in USB, #185);
//      voice needs USB or LSB. Split must be off and the TX dial the RX dial.
//   6. Thetis is receive-only until a Thetis owner has confirmed transmit.

const AUDIO_RATE = 12000;
const HEADER_BYTES = 64;
const STREAM_TX_AUDIO = 2;
const STREAM_TX_CHRONO = 3;
const KEY_DOWN = 'trx:0,true,tci;';
const RELEASE = 'trx:0,false;';
const STALL_MS = 800;
const DEADLINE_GRACE_MS = 800;
const RELEASE_CONFIRM_MS = 500;
const RECOVERY_TIMEOUT_MS = 1500;
const TAIL_MS = 150;
const MAX_SECONDS = 121; // a JTTY or PSK31 over, plus the lead
const VOICE_QUEUE = AUDIO_RATE / 4; // 250 ms of speech at most in flight

const THETIS_TX_REFUSAL = 'Transmitting through Thetis is off until a Thetis owner confirms it works. Receive and control work.';

/**
 * Why a key-down is refused, or '' when it may go.
 * @param {object} s  the rig's state: { ready, thetis, transmitting, busy,
 *   rxDial, txFrequency, txDialB, split, tciMode, driveKnown, drivePct }
 * @param {'digital'|'voice'} kind
 * @param {number} capPct  the drive cap in percent, 0 = none
 */
function txRefusal(s, kind, capPct) {
  if (s.thetis) return THETIS_TX_REFUSAL;
  if (!s.ready) return 'The TCI server is not connected';
  if (s.transmitting !== false || s.busy) return 'Wait for the radio to return to receive';
  if (!(s.rxDial > 0)) return 'Waiting for the radio to report its dial';
  const txDial = s.txFrequency || s.txDialB;
  if (s.split === true || (txDial && txDial !== s.rxDial)) return 'Turn split off so the radio transmits on its receive frequency';
  if (kind === 'digital' && s.tciMode !== 'DIGU') {
    return `The radio is in ${s.tciMode || 'an unknown mode'}. Digital transmit needs DIGU: pick the band in JTCAT, or set DIGU on the radio`;
  }
  if (kind === 'voice' && s.tciMode !== 'USB' && s.tciMode !== 'LSB') return 'Set the radio to USB or LSB before pressing PTT';
  if (capPct > 0) {
    if (!s.driveKnown) return `Set TX drive in POTACAT first (the amplifier limit is ${capPct}% drive)`;
    if (s.drivePct > capPct) return `TX drive ${s.drivePct}% is above the amplifier limit of ${capPct}%`;
  }
  return '';
}

/** A TX audio frame answering one TX_CHRONO request. */
function txAudioFrame(samples) {
  const frame = Buffer.alloc(HEADER_BYTES + samples.length * 4);
  frame.writeUInt32LE(AUDIO_RATE, 4);
  frame.writeUInt32LE(3, 8); // float32
  frame.writeUInt32LE(samples.length, 20);
  frame.writeUInt32LE(STREAM_TX_AUDIO, 24);
  frame.writeUInt32LE(1, 28); // mono
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    frame.writeFloatLE(Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0, HEADER_BYTES + i * 4);
  }
  return frame;
}

/** The sample count a TX_CHRONO frame asks for, or 0 when it is not one we answer. */
function chronoRequest(frame) {
  if (!frame || frame.length !== HEADER_BYTES || frame.readUInt32LE(24) !== STREAM_TX_CHRONO) return 0;
  if (frame.readUInt32LE(0) !== 0 || frame.readUInt32LE(4) !== AUDIO_RATE) return 0;
  const count = frame.readUInt32LE(20);
  return count > 0 && count <= 4096 ? count : 0;
}

/**
 * @param {object} o
 * @param {(text: string) => boolean} o.sendKey   raw text send on the rig's socket (keying allowed)
 * @param {(buf: Buffer) => boolean} o.sendBinary
 * @param {() => object} o.state                  the rig's state for txRefusal
 * @param {() => number} [o.driveCapPct]          the drive cap in percent (0 = none)
 * @param {() => void} o.recover                  open a second session and send the release
 * @param {(line: string) => void} [o.log]
 */
function createTciTransmitter(o) {
  const log = o.log || (() => {});
  const cap = () => { const c = Number(o.driveCapPct ? o.driveCapPct() : 0); return c > 0 ? Math.min(100, c) : 0; };
  let active = null;       // { kind, samples, offset, voice?, done, timers..., peakW }
  let releaseTimer = null; // waiting for the server to confirm RX

  function clearTimers(a) {
    for (const k of ['deadline', 'stall', 'tail', 'mic']) if (a[k]) clearTimeout(a[k]);
  }

  function finish(reason, { released = false, lostSocket = false } = {}) {
    const a = active;
    if (!a) return;
    active = null;
    clearTimers(a);
    if (lostSocket) o.recover();
    else if (!released) {
      o.sendKey(RELEASE);
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        log('the radio did not confirm the release: sending it on a second TCI session');
        o.recover();
      }, RELEASE_CONFIRM_MS);
    }
    try { a.done(reason, a.peakW); } catch { /* the caller's problem */ }
  }

  function keyDown(kind, samples, timeoutMs, done, extra) {
    const why = txRefusal({ ...o.state(), busy: !!active || !!releaseTimer }, kind, cap());
    if (why) return why;
    active = { kind, samples, offset: 0, peakW: 0, done, ...extra };
    active.deadline = setTimeout(() => finish(kind === 'voice' ? 'voice PTT timeout' : 'TX deadline'), timeoutMs);
    active.stall = setTimeout(() => finish('no TX_CHRONO from the server'), STALL_MS);
    if (kind === 'voice') active.mic = setTimeout(() => finish('phone microphone audio stopped'), STALL_MS);
    if (!o.sendKey(KEY_DOWN)) { finish('the TCI socket is closed', { released: true }); return 'The TCI server is not connected'; }
    return '';
  }

  return {
    get active() { return !!active; },
    get voiceActive() { return !!(active && active.kind === 'voice'); },
    get digitalActive() { return !!(active && active.kind === 'digital'); },
    get busy() { return !!active || !!releaseTimer; },

    /** A digital over: 12 kHz float32, already led with its PTT settle. '' or the refusal. */
    startTx(samples, done) {
      if (!(samples instanceof Float32Array) || !samples.length || samples.length > AUDIO_RATE * MAX_SECONDS) return 'Invalid TCI transmit buffer';
      const ms = Math.ceil(samples.length * 1000 / AUDIO_RATE) + DEADLINE_GRACE_MS;
      return keyDown('digital', samples, ms, done, {});
    },

    /** Voice from the phone, fed by pushVoiceAudio. '' or the refusal. */
    startVoiceTx(timeoutMs, done) {
      if (!(timeoutMs > 0)) return 'Invalid PTT timeout';
      return keyDown('voice', new Float32Array(VOICE_QUEUE), timeoutMs, done, { voice: { length: 0 } });
    },

    pushVoiceAudio(pcm) {
      const v = active && active.voice;
      if (!v || !(pcm instanceof Float32Array) || !pcm.length) return;
      const q = active.samples;
      const add = pcm.subarray(Math.max(0, pcm.length - q.length));
      const drop = Math.max(0, v.length + add.length - q.length); // oldest out: speech latency stays bounded
      q.copyWithin(0, drop, v.length);
      v.length -= drop;
      q.set(add, v.length);
      v.length += add.length;
      active.mic.refresh();
    },

    stopTx(reason = 'cancelled') { if (active && active.kind === 'digital') finish(reason); },
    stopVoiceTx(reason = 'cancelled') { if (active && active.kind === 'voice') finish(reason); },
    stopAll(reason = 'cancelled') { finish(reason); },

    /** A binary frame from the server; true when it was TX pacing. */
    onBinary(frame, transmitting) {
      if (!frame || frame.length < HEADER_BYTES || frame.readUInt32LE(24) !== STREAM_TX_CHRONO) return false;
      const a = active;
      if (!a || transmitting !== true || a.tail) return true;
      const count = chronoRequest(frame);
      if (!count) { finish('the server asked for audio in a form POTACAT does not send'); return true; }
      clearTimeout(a.stall);
      let out;
      if (a.voice) {
        const n = Math.min(count, a.voice.length);
        out = new Float32Array(count); // short delivery: silence fills the gap
        out.set(a.samples.subarray(0, n));
        a.samples.copyWithin(0, n, a.voice.length);
        a.voice.length -= n;
      } else {
        out = new Float32Array(count);
        const n = Math.min(count, a.samples.length - a.offset);
        out.set(a.samples.subarray(a.offset, a.offset + n));
        a.offset += n;
      }
      o.sendBinary(txAudioFrame(out));
      if (!a.voice && a.offset >= a.samples.length) a.tail = setTimeout(() => finish('complete'), TAIL_MS);
      else a.stall = setTimeout(() => finish('no TX_CHRONO from the server'), STALL_MS);
      return true;
    },

    /** The server's trx state. */
    onTrx(transmitting) {
      if (transmitting) return;
      clearTimeout(releaseTimer);
      releaseTimer = null;
      if (active && active.offset > 0) finish('the radio returned to receive', { released: true });
    },

    /** Forward watts during our own over (for the log). */
    onForwardWatts(w) { if (active && active.offset > 0 && w > active.peakW) active.peakW = w; },

    /** The socket closed: whatever we keyed is released from a second session. */
    onClose() {
      if (active) finish('the TCI connection dropped', { lostSocket: true });
      else if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; o.recover(); }
    },

    /** The drive to send for an asked percent: the cap applied. */
    clampDrive(pct) { const c = cap(); return c > 0 ? Math.min(pct, c) : pct; },
  };
}

module.exports = {
  createTciTransmitter, txRefusal, txAudioFrame, chronoRequest,
  KEY_DOWN, RELEASE, STALL_MS, RELEASE_CONFIRM_MS, THETIS_TX_REFUSAL, AUDIO_RATE,
};
