'use strict';
/**
 * RigController — facade composing transport + codec + model.
 *
 * Owns: polling, tune sequencing, CW keying routing, ATU sequences.
 * Emits: 'frequency', 'mode', 'power', 'nb', 'status', 'log'
 *
 * Replaces CatClient / RigctldClient / CivClient as the unified rig interface.
 */
const { EventEmitter } = require('events');

class RigController extends EventEmitter {
  /**
   * @param {object} model — rig model entry from rig-models.js
   * @param {object} transport — TcpTransport or SerialTransport instance
   * @param {object} codec — KenwoodCodec, RigctldCodec, or CivCodec instance
   */
  constructor(model, transport, codec) {
    super();
    this._model = model;
    this._transport = transport;
    this._codec = codec;

    // State
    this.connected = false;
    this._target = null;
    this._pollTimer = null;
    this._pollCount = 0;
    this._pendingTimers = [];
    this._lastParsedMode = null;
    this._lastFreqHz = 0;
    this._debug = false;

    // Tune state
    this._requestedMd = null; // for post-reconnect mode enforcement

    // CW TX/RX PTT holdoff — prevent relay clicking on every dit/dah element
    this._cwPttActive = false;
    this._cwPttTimer = null;
    this._cwPttHoldoff = 1500; // ms to hold PTT after last key event

    // CW state
    this._cwTaActive = false;
    this._cwTaSavedMode = null;

    // CW text-send TX0 drop timer (Yaesu ky1 path) and last WPM for duration estimate
    this._cwTextDropTimer = null;
    this._cwWpm = 20;

    // Throttle state
    this._lastRgTime = 0;
    this._lastPcTime = 0;

    // TX state — used to gate meter polling. S-meter is meaningless during TX,
    // SWR+ALC are meaningless during RX. Flipped by setTransmit() below; foot-
    // switch/mic PTT won't toggle it, but today's behaviour in that case is
    // just "poll garbage" too, so this is no regression.
    this._transmitting = false;

    // Last split state we sent to the rig. null = unknown; first tune sends
    // the appropriate on/off and caches it. Only re-sent when the desired
    // state changes, so we don't re-assert split on every tune (which was
    // forcing TS-2000 into split each time the user clicked a spot, per
    // Mike's report).
    this._lastSplit = null;

    // Poll-staleness watchdog (K6RBJ 2026-08-03): a dead radio behind a LIVE
    // transport — rigctld keeps its socket up and answers every poll with an
    // RPRT error when the rig's USB vanishes — used to leave `connected` true
    // and the freq readout silently stale for weeks. Track the last successful
    // rig READ; if polls go unanswered too long, declare the link down (loud
    // log + status:false → UI banner + explicit catConnected:false on the
    // wire) and refuse tunes until a poll answers again.
    this._lastReadOkMs = 0;
    this._linkStale = false;

    // Mode-silence watchdog (KQ4DX 2026-08-10). The staleness watchdog above
    // only catches a rig that answers NOTHING. A rig that answers freq and
    // meters but never a mode is invisible to it — and mode is the one read
    // whose absence removes controls: every client gates PTT/HALT on a voice-
    // mode whitelist, so an empty mode reads to the operator as "the buttons
    // disappeared", with a CAT log full of healthy traffic. Causes seen: the
    // model's getMode is the wrong dialect for the rig (a Yaesu sent Kenwood
    // `MD;` never replies), or the connection type doesn't match the radio.
    // Codecs log the value they COULDN'T parse; this logs the reply that
    // never came at all.
    this._pollStartedMs = 0;
    this._modeSilenceLogged = false;

    // Wire transport events
    this._transport.on('connect', () => {
      this.connected = true;
      this._linkStale = false;
      this._lastReadOkMs = Date.now();
      // Fresh session: re-arm the mode-silence watchdog. Swapping rigs or
      // recovering a cable must get its own verdict, not the last one's.
      this._pollStartedMs = 0;
      this._modeSilenceLogged = false;
      this._target = this._transport._target;
      this.emit('status', { connected: true, target: this._target });
      this._log('Connected');

      // Probe capability lists (preamp/ATT dB steps) BEFORE the safety T 0 —
      // rigctld answers sequentially, so the dump is fully delivered before
      // T 0's RPRT, which deterministically ends the codec's swallow mode.
      if (typeof this._codec.probeCaps === 'function') this._codec.probeCaps();

      // Safety: ALWAYS force PTT off on connect — prevents stuck TX from:
      // - serial drop during TX (Digirig/FT-891)
      // - switching rig profiles leaving radio in TX
      // - CI-V frame collisions from multiple concurrent connections
      this._codec.setTransmit(false);
      this._log(this._hasConnectedBefore ? 'post-reconnect safety: PTT off' : 'initial connect safety: PTT off');
      this._hasConnectedBefore = true;

      // Start polling after connect delay
      setTimeout(() => {
        if (this.connected) {
          this._startPolling();
          // Post-reconnect mode enforcement
          this._enforceRequestedMode();
        }
      }, model.connectDelay || 300);
    });

    this._transport.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this._linkStale = false; // real transport loss supersedes the watchdog
      this._stopPolling();
      if (was) {
        this.emit('status', { connected: false, target: this._target });
        this._log('Disconnected');
      }
    });

    this._transport.on('error', (err) => {
      this._log(`Transport error: ${err.message}`);
    });

    // Forward transport-layer diagnostic messages (e.g. DTR/RTS SetControlLineState
    // ack/failure) to the same CAT log panel the rig commands use. Helps
    // diagnose "radio keys on CW switch" bugs where the question is whether
    // the kernel driver honored the pin-deassert request.
    this._transport.on('log', (msg) => this._log(msg));

    this._transport.on('data', (chunk) => {
      this._codec.onData(chunk);
    });

    // Wire codec events
    this._codec.on('frequency', (hz) => {
      this._noteReadOk();
      // Log the radio's REPORTED frequency on change. The UI mirrors this value
      // verbatim when CAT is connected (no optimistic readout), so a "freq
      // display reverts to a stale value even though the radio moved" symptom
      // (K6RBJ, IC-7100) is only diagnosable if we can SEE what the rig reports
      // back vs what we commanded. On-change only — silent while parked, so it
      // doesn't flood the CAT log during normal operation.
      if (hz !== this._lastFreqHz) this._log(`rig reports freq: ${(hz / 1e6).toFixed(6)} MHz`);
      this._lastFreqHz = hz;
      this.emit('frequency', hz);
    });
    this._codec.on('mode', (mode) => {
      this._noteReadOk();
      if (mode !== this._lastParsedMode) this._log(`rig reports mode: ${mode}`);
      this._lastParsedMode = mode;
      this.emit('mode', mode);
    });
    this._codec.on('log', (m) => this._log(m)); // codec diagnostics (e.g. raw CI-V freq frame)
    this._codec.on('power', (w) => { this._noteReadOk(); this.emit('power', w); });
    this._codec.on('nb', (on) => { this._noteReadOk(); this.emit('nb', on); });
    this._codec.on('rfgain', (val) => this.emit('rfgain', val));
    this._codec.on('nbLevel', (val) => this.emit('nbLevel', val));
    this._codec.on('nr', (on) => this.emit('nr', on));
    this._codec.on('nrLevel', (val) => this.emit('nrLevel', val));
    this._codec.on('dnrLevel', (val) => this.emit('dnrLevel', val));
    this._codec.on('comp', (on) => this.emit('comp', on));
    this._codec.on('compLevel', (val) => this.emit('compLevel', val));
    this._codec.on('agc', (mode) => this.emit('agc', mode));
    this._codec.on('anf', (on) => this.emit('anf', on));
    this._codec.on('vox', (on) => this.emit('vox', on));
    this._codec.on('voxLevel', (val) => this.emit('voxLevel', val));
    this._codec.on('mon', (on) => this.emit('mon', on));
    this._codec.on('monLevel', (val) => this.emit('monLevel', val));
    this._codec.on('micGain', (val) => this.emit('micGain', val));
    this._codec.on('breakIn', (on) => this.emit('breakIn', on));
    this._codec.on('antennaPort', (val) => this.emit('antennaPort', val));
    // Preamp/ATT readback (#82): step (dB) + boolean, matching the wire's
    // preampStep/attStep + preamp/att fields.
    this._codec.on('preampStep', (db) => this.emit('preampStep', db));
    this._codec.on('attStep', (db) => this.emit('attStep', db));
    this._codec.on('atu', (on) => this.emit('atu', on));
    // Round 3 readbacks (#82 retest): RIT state + passband width.
    this._codec.on('rit', (on) => this.emit('rit', on));
    this._codec.on('passband', (hz) => this.emit('passband', hz));
    // Active VFO + split readback — these also count as successful rig reads
    // for the poll-staleness watchdog (they're polled every cycle).
    this._codec.on('frequencyOther', (hz) => { this._noteReadOk(); this.emit('frequencyOther', hz); });
    this._codec.on('vfo', (v) => { this._noteReadOk(); this.emit('vfo', v); });
    this._codec.on('split', (on) => { this._noteReadOk(); this.emit('split', on); });
    this._codec.on('smeter', (val) => { this._noteReadOk(); this.emit('smeter', val); });
    this._codec.on('swr', (val) => { this._noteReadOk(); this.emit('swr', val); });
    this._codec.on('alc', (val) => { this._noteReadOk(); this.emit('alc', val); });
    // CAT-observed PTT state (physical mic / footswitch / external keying).
    // Update _transmitting so the polling loop swaps to TX-only meters.
    this._codec.on('ptt', (on) => {
      this._noteReadOk();
      if (this._transmitting !== !!on) {
        this._transmitting = !!on;
        this.emit('ptt', !!on);
      }
    });
    this._codec.on('da', (on) => this.emit('da', on));
    this._codec.on('error', (e) => this._log(e.message || 'codec error'));
  }

  // --- Lifecycle ---

  connect(target) {
    this._target = target;
    this._transport.connect(target);
  }

  disconnect() {
    this._stopPolling();
    this._cwPttRelease();
    if (this._cwTextDropTimer) { clearTimeout(this._cwTextDropTimer); this._cwTextDropTimer = null; }
    for (const t of this._pendingTimers) clearTimeout(t);
    this._pendingTimers = [];
    this._transport.disconnect();
    this.connected = false;
  }

  // --- Logging ---

  _log(msg) {
    if (this._debug) this.emit('log', msg);
  }

  // --- Polling ---

  _startPolling() {
    this._stopPolling();
    this._pollCount = 0;
    // Fresh staleness basis — a pause (tune sequence, WSJT-X handoff) must
    // not count toward the no-reply window.
    this._lastReadOkMs = Date.now();
    const caps = this._model.caps || {};
    const interval = this._model.protocol === 'rigctld' ? 500 : 1000;

    // Only on the FIRST run of a connection. _startPolling() re-runs after every
    // tune sequence's pause/resume, and restarting the clock there would mean a
    // station tuning more often than MODE_SILENCE_MS never reaches the check.
    if (!this._pollStartedMs) this._pollStartedMs = Date.now();

    this._pollTimer = setInterval(() => {
      this._checkPollStaleness();
      this._checkModeSilence();
      let polledPower = false;
      if (this._codec.getFrequency) this._codec.getFrequency();
      if (this._codec.getMode) this._codec.getMode();

      // Poll TX state so meters track physical-mic / footswitch / external
      // PTT, not just POTACAT-initiated TX. (AB9AI 2026-05-04: keyed up via
      // mic on FTdx3000, smeter kept polling and SWR/ALC stayed frozen
      // because _transmitting only flipped on POTACAT's own setTransmit.)
      if (this._codec.getPtt) this._codec.getPtt();

      // Active VFO + split readback (Kenwood IF; / rigctld v+s). Every cycle
      // so a front-panel A/B press or a custom-CAT VFO switch shows within
      // ~1s — the whole LZ3AW complaint was state that never followed the
      // radio. Codecs without the method (CI-V for now) skip it.
      if (this._codec.getVfoSplit) this._codec.getVfoSplit();

      // S-meter only during RX; SWR+ALC only during TX (every 2nd cycle).
      // Polling the wrong meter for the current state returns garbage and
      // wastes CAT bandwidth.
      if (!this._transmitting && this._codec.getSmeter) this._codec.getSmeter();
      if ((this._transmitting || this._model.pollTxMetersAlways) && this._pollCount % 2 === 0) {
        if (this._codec.getSwr && !this._model.noSwr) this._codec.getSwr();
        if (this._codec.getAlc && !this._model.noSwr) this._codec.getAlc();
      }
      // Poll power and NB every 5th cycle (they change rarely)
      if (this._pollCount++ % 5 === 0) {
        if (caps.txpower && this._codec.getPower) {
          this._codec.getPower();
          polledPower = true;
        }
        if (caps.nb && this._codec.getNb) this._codec.getNb();
        if (caps.rfgain && this._codec.getRfGain) this._codec.getRfGain();
        if (caps.agc && this._codec.getAgc) this._codec.getAgc();
        if (caps.anf && this._codec.getAutoNotch) this._codec.getAutoNotch();
        if (caps.vox && this._codec.getVox) this._codec.getVox();
        if (caps.voxLevel && this._codec.getVoxLevel) this._codec.getVoxLevel();
        if (caps.nr && this._codec.getDnrLevel) this._codec.getDnrLevel();
        if (caps.comp && this._codec.getCompressor) this._codec.getCompressor();
        if (caps.compLevel && this._codec.getCompLevel) this._codec.getCompLevel();
        if (caps.mon && this._codec.getMonitor) this._codec.getMonitor();
        if (caps.micGain && this._codec.getMicGain) this._codec.getMicGain();
        if (caps.breakIn && this._codec.getBreakIn) this._codec.getBreakIn();
        if (caps.antennaPort && this._codec.getAntennaPort) this._codec.getAntennaPort();
        // Preamp/ATT readback (#82) — radio-side ladder changes reflect in
        // POTACAT instead of the state being latch-on-command only.
        if (caps.preamp && this._codec.getPreamp) this._codec.getPreamp();
        if (caps.att && this._codec.getAtt) this._codec.getAtt();
        // Round 3 (#82 retest): monitor gain, RIT state, ATU inline state.
        if (caps.monLevel && this._codec.getMonLevel) this._codec.getMonLevel();
        if (caps.rit && this._codec.getRit) this._codec.getRit();
        if (caps.atu && this._codec.getAtuEnabled) this._codec.getAtuEnabled();
      }
      if (this._model.powerPollEvery && this._pollCount % this._model.powerPollEvery === 0) {
        if (!polledPower && caps.txpower && this._codec.getPower) this._codec.getPower();
      }
    }, interval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // --- Poll-staleness watchdog ---

  /** How long polls may go unanswered before the link is declared down.
   *  Polls fire every 0.5-1s with freq+mode+ptt each cycle, so a healthy
   *  link produces several reads per second — 10s of silence is decisive. */
  static get POLL_STALE_MS() { return 10000; }

  _checkPollStaleness() {
    const now = Date.now();
    // Rigs may legitimately mute CAT during TX (TS-480 stops answering the
    // freq poll — the W9SOX case), so TX never counts toward staleness. This
    // also means a link that dies MID-TX is only flagged once _transmitting
    // clears; POTACAT-keyed TX always clears it, and that trade is safer
    // than false "radio gone" banners during long voice transmissions.
    if (this._transmitting) { this._lastReadOkMs = now; return; }
    if (this._linkStale || !this._lastReadOkMs) return;
    const silentMs = now - this._lastReadOkMs;
    if (silentMs > RigController.POLL_STALE_MS) {
      this._linkStale = true;
      this.connected = false; // tunes/PTT refuse while the rig is unreachable
      this.emit('log', `no reply to any poll for ${Math.round(silentMs / 1000)}s — treating the radio link as DOWN (the ${this._model.protocol === 'rigctld' ? 'rigctld connection' : 'port'} is still open, but the radio behind it is not answering)`);
      this.emit('status', { connected: false, target: this._target, stale: true });
    }
  }

  /** How long the rig may answer other reads without ever answering a mode
   *  read before we say so. Generous: a rig that answers at all answers mode
   *  within a cycle or two, and a false positive here would be a scary log
   *  line on a healthy station. */
  static get MODE_SILENCE_MS() { return 20000; }

  /**
   * The rig is talking to us, but has never once told us its mode.
   * Fires at most once per polling run — resumePolling() after a tune
   * sequence restarts the clock, so a rig that HAS reported a mode can
   * never trip it (the _lastParsedMode guard short-circuits first).
   */
  _checkModeSilence() {
    if (this._modeSilenceLogged || this._lastParsedMode) return;
    // Nothing is answering at all — that's the staleness watchdog's report to
    // make, and it names a different fix. Don't pile a second theory on top.
    if (this._linkStale || !this._lastReadOkMs) return;
    if (!this._pollStartedMs) return;
    if (Date.now() - this._pollStartedMs < RigController.MODE_SILENCE_MS) return;
    this._modeSilenceLogged = true;
    const cmd = (this._codec && this._codec._cmds && this._codec._cmds.getMode) || null;
    this.emit('log',
      `radio is answering polls but has never reported its MODE${cmd ? ` (we ask with "${cmd}")` : ''} — ` +
      `mode stays unknown, which HIDES the PTT and HALT buttons on ECHOCAT and the VFO window. ` +
      `Usually the rig model or the CAT connection type in Settings > My Rigs does not match the radio ` +
      `(e.g. an Icom on "Serial CAT (Kenwood/Yaesu)", or a Yaesu whose model was never selected).`);
  }

  /** A successful rig read arrived — refresh the watchdog, recover if stale. */
  _noteReadOk() {
    this._lastReadOkMs = Date.now();
    if (this._linkStale) {
      this._linkStale = false;
      this.connected = true;
      this.emit('log', 'radio is answering polls again — link restored');
      this.emit('status', { connected: true, target: this._target });
    }
  }

  pausePolling() { this._stopPolling(); }

  resumePolling() {
    // _linkStale keeps `connected` false while the transport is still up —
    // polls must resume anyway or the watchdog could never see the recovery.
    if ((this.connected || this._linkStale) && !this._pollTimer) this._startPolling();
  }

  // --- Tune ---

  tune(frequencyHz, mode, { split, filterWidth, xit } = {}) {
    if (!this.connected) return false;

    // Cancel pending tune timers
    for (const t of this._pendingTimers) clearTimeout(t);
    this._pendingTimers = [];
    this._stopPolling();

    const q = this._model.tune || {};
    const resolved = mode ? this._codec.resolveMode(mode, frequencyHz) : null;
    const modeChanged = resolved && this._codec.modeNameForMapping
      ? this._codec.modeNameForMapping(resolved) !== this._lastParsedMode
      : !!resolved;

    let delay = 0;

    // Mode BEFORE frequency
    if (q.modeBeforeFreq !== false && resolved && (modeChanged || q.alwaysResendMode)) {
      this._codec.setMode(mode, frequencyHz);
      delay = Math.max(delay, 100);
    }

    // Frequency
    this._pendingTimers.push(setTimeout(() => {
      if (this.connected) this._codec.setFrequency(frequencyHz);
    }, delay));
    delay += 100;

    // Mode AFTER frequency (band-recall fix)
    if (q.modeAfterFreq && resolved && (modeChanged || q.alwaysResendMode)) {
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setMode(mode, frequencyHz);
      }, delay));
      delay += 100;

      // Frequency AFTER post-mode (CW pitch offset fix — the "sandwich")
      if (q.freqAfterMode) {
        this._pendingTimers.push(setTimeout(() => {
          if (this.connected) this._codec.setFrequency(frequencyHz);
        }, delay));
        delay += 100;
      }
    }

    // Filter width
    if (filterWidth > 0) {
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setFilterWidth(filterWidth);
      }, delay));
      delay += 100;
    }

    // Split — only send when the desired state differs from what we last
    // told the rig. Previously we re-sent "split on" on every tune, which
    // forced TS-2000 back into split each time, and there was no path to
    // turn split off at all.
    const desiredSplit = !!split;
    if (desiredSplit !== this._lastSplit) {
      this._lastSplit = desiredSplit;
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setSplit(desiredSplit);
      }, delay));
      delay += 100;
    }

    // Native XIT (Yaesu TX CLAR) — re-apply after every tune since freq change resets it
    if (xit != null && typeof this._codec.setXit === 'function') {
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setXit(xit);
      }, delay));
      delay += 100;
    }

    // Remember requested mode for post-reconnect enforcement
    if (resolved) this._requestedMd = { mode, freqHz: frequencyHz };

    // Resume polling
    this._pendingTimers.push(setTimeout(() => {
      if (this.connected) this._startPolling();
    }, delay + 500));

    this._log(`tune: freq=${frequencyHz}Hz mode=${mode} split=${!!split} filter=${filterWidth || 0}${xit ? ' xit=' + xit : ''}`);
    return true;
  }

  // --- Post-reconnect mode enforcement ---

  _enforceRequestedMode() {
    if (!this._requestedMd) return;
    const { mode, freqHz } = this._requestedMd;
    // Wait for polling to establish current state, then re-send mode
    setTimeout(() => {
      if (!this.connected || !this._requestedMd) return;
      this._codec.setMode(mode, freqHz);
      this._log(`post-reconnect mode enforcement: ${mode}`);
    }, 1500);
  }

  // --- Rig control commands ---

  /** Change mode without re-tuning frequency. Used by SSB-over-DATA PTT. */
  setModeOnly(mode, freqHz) {
    if (!this.connected) return;
    this._stopPolling();
    const anchorHz = freqHz || this._lastFreqHz || 0;
    this._codec.setMode(mode, anchorHz);
    this._log(`mode-only: ${mode}`);
    // Yaesu (and similar) shift the VFO by the filter-width difference when
    // the mode changes — e.g. USB (2.4k) → PKTUSB (3k) on FT-710 nudges the
    // dial by ~700 Hz, which lands TX off-frequency. Re-anchor by re-sending
    // the freq after the mode lands. Harmless on rigs that don't drift.
    // (NT0Y, FT-710 via rigctld, 2026-04-30.)
    if (anchorHz > 0) {
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setFrequency(anchorHz);
      }, 200));
    }
    this._startPolling(500);
  }

  setTransmit(on) {
    if (!this.connected) return;
    this._transmitting = !!on;
    this._codec.setTransmit(on);
  }

  setFilterWidth(hz) {
    if (!this.connected || !hz) return;
    this._codec.setFilterWidth(hz);
    this._log(`Filter width: ${hz}Hz`);
  }

  setNb(on) {
    if (!this.connected) return;
    this._codec.setNb(on);
    this._log(`NB ${on ? 'on' : 'off'}`);
  }

  setRfGain(pct) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastRgTime && now - this._lastRgTime < 150) return;
    this._lastRgTime = now;
    this._codec.setRfGain(pct);
    this._log(`RF gain: ${pct}`);
  }

  setSquelch(pct) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastSqTime && now - this._lastSqTime < 150) return;
    this._lastSqTime = now;
    if (typeof this._codec.setSquelch === 'function') this._codec.setSquelch(pct);
    this._log(`Squelch: ${pct}`);
  }

  setTxPower(watts) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastPcTime && now - this._lastPcTime < 150) return;
    this._lastPcTime = now;
    this._codec.setTxPower(watts);
    this._log(`TX power: ${watts}W`);
  }

  setPowerState(on) {
    // Power-on: radio may be off, just need transport open
    if (!this._transport.connected) return;
    this._codec.setPowerState(on);
    this._log(`Power ${on ? 'on' : 'off'}`);
  }

  startTune() {
    if (!this.connected) return;
    const seq = this._codec.getAtuStartSequence();
    if (!seq) {
      // CI-V: codec handles ATU directly
      this._codec.startTune();
      this._log('ATU tune started');
      return;
    }
    // ASCII protocols: execute command sequence with delays
    let delay = 0;
    for (const step of seq) {
      if (step.cmd) {
        this._pendingTimers.push(setTimeout(() => {
          if (this.connected) this._transport.write(step.cmd);
        }, delay));
      }
      delay += step.delay || 0;
    }
    this._log('ATU tune started');
  }

  stopTune() {
    if (!this.connected) return;
    const cmd = this._codec.getAtuStopCmd();
    if (cmd) {
      this._transport.write(cmd);
    } else {
      this._codec.stopTune();
    }
    this._log('ATU tuner off');
  }

  setVfo(vfo) {
    if (!this.connected) return;
    this._codec.setVfo(vfo);
    this._log(`VFO: ${vfo}`);
  }

  swapVfo() {
    if (!this.connected) return;
    this._codec.swapVfo();
    this._log('VFO swap');
  }

  setXit(hz) {
    if (!this.connected) return;
    if (typeof this._codec.setXit === 'function') {
      this._codec.setXit(hz);
      this._log(`XIT: ${hz ? hz + 'Hz' : 'off'}`);
    }
  }

  /** Does this rig support native XIT commands? (Yaesu TX CLAR: XT/RU/RD) */
  get hasNativeXit() {
    return typeof this._codec.setXit === 'function'
      && this._model.brand === 'Yaesu'
      && this._model.caps?.xit !== false;
  }

  setSplit(on) {
    if (!this.connected) return;
    this._lastSplit = !!on;
    this._codec.setSplit(on);
    this._log(`Split ${on ? 'on' : 'off'}`);
  }

  /** Cancel in-progress CW text by dropping PTT, then send new text */
  sendCwText(text) {
    if (!this.connected || !text) return;
    const cwCaps = this._model.cw || {};
    if (cwCaps.text === 'ky1') {
      // Yaesu: BK-IN auto-key from CAT KY is unreliable across firmware
      // versions (notably FT-710). Explicit sequence — TX1 to assert PTT,
      // 50ms for the radio to enter TX, KY to queue the text, then TX0
      // after the estimated keying duration. Same pattern Hamlib uses
      // for Yaesu NewCAT rigs.
      if (this._cwTextDropTimer) { clearTimeout(this._cwTextDropTimer); this._cwTextDropTimer = null; }
      this._codec.setTransmit(true);
      const sendDelay = 50;
      setTimeout(() => {
        if (this.connected) this._codec.sendCwText(text);
      }, sendDelay);
      // CW element timing: 1 dit = 1200/wpm ms. PARIS word = 50 dits.
      // Approximate avg char = 10 dits → duration = text.length * 10 * 1200 / wpm
      const wpm = this._cwWpm || 20;
      const durationMs = Math.ceil((text.length * 12000) / wpm) + 1000;
      this._cwTextDropTimer = setTimeout(() => {
        this._cwTextDropTimer = null;
        if (this.connected) this._codec.setTransmit(false);
      }, sendDelay + durationMs);
    } else {
      // Kenwood buffered KY: abort current TX first so the new message starts clean
      this._codec.setTransmit(false);
      setTimeout(() => {
        if (this.connected) this._codec.sendCwText(text);
      }, 50);
    }
  }

  setCwSpeed(wpm) {
    if (!this.connected) return;
    this._cwWpm = wpm;
    this._codec.setCwSpeed(wpm);
  }

  /**
   * Abort an in-flight CW text send. Mirrors the cancel path that
   * sendCwText() runs implicitly when a new message starts: kill the
   * deferred PTT-drop timer (Yaesu KY1 path) and force PTT off, which
   * also flushes the Kenwood KY rolling buffer on rigs that honor it.
   * Codecs that have a protocol-specific cancel command (CI-V 0x17 FF)
   * can override or be invoked via their own path; the legacy CatClient
   * still owns that for CI-V.
   */
  stopCwText() {
    if (this._cwTextDropTimer) {
      clearTimeout(this._cwTextDropTimer);
      this._cwTextDropTimer = null;
    }
    if (this.connected) this._codec.setTransmit(false);
  }

  sendRaw(text) {
    if (!this.connected) return;
    this._codec.sendRaw(text);
  }

  // --- Extended controls ---

  setNbLevel(val) {
    if (!this.connected) return false;
    if (typeof this._codec.setNbLevel !== 'function') return this._unsupported('NB level');
    this._codec.setNbLevel(val);
    return true;
  }

  setAfGain(pct) {
    if (!this.connected) return false;
    if (typeof this._codec.setAfGain !== 'function') return this._unsupported('AF gain');
    const now = Date.now();
    if (this._lastAfTime && now - this._lastAfTime < 150) return true;
    this._lastAfTime = now;
    this._codec.setAfGain(pct);
    return true;
  }

  /** @param {boolean|number} level — ladder step, or boolean on rigs without one. */
  setPreamp(level) {
    if (!this.connected) return false;
    if (typeof this._codec.setPreamp !== 'function') return this._unsupported('Preamp');
    if (this._codec.setPreamp(level) === false) return this._unsupported('Preamp');
    return true;
  }

  /** @param {boolean|number} level — ladder step, or boolean on rigs without one. */
  setAttenuator(level) {
    if (!this.connected) return false;
    if (typeof this._codec.setAttenuator !== 'function') return this._unsupported('Attenuator');
    if (this._codec.setAttenuator(level) === false) return this._unsupported('Attenuator');
    return true;
  }

  /**
   * Preamp/ATT ladders this CONNECTION discovered at runtime (rigctld probes
   * the rig's real dB lists via dump_caps). Model-declared ladders come from
   * rig-models; this covers the hamlib case where only the radio knows.
   * Returns null when the codec has nothing to add.
   */
  getGainSteps() {
    if (typeof this._codec.getGainSteps !== 'function') return null;
    try { return this._codec.getGainSteps(); } catch { return null; }
  }

  /**
   * A control the active codec has no method for: say so ONCE per control
   * (always-on 'log', not the _debug-gated _log — the user just clicked a
   * button that did nothing) and return false so the caller can skip the
   * state flip. The old silent no-op left the UI toggle showing "applied"
   * while nothing was sent — K6RBJ burned weeks on exactly that (2026-08-03).
   */
  _unsupported(label) {
    if (!this._unsupportedWarned) this._unsupportedWarned = new Set();
    if (!this._unsupportedWarned.has(label)) {
      this._unsupportedWarned.add(label);
      this.emit('log', `${label} is not supported on this rig/connection type — nothing was sent to the radio`);
    }
    return false;
  }

  setNoiseReduction(on) {
    if (!this.connected) return false;
    if (typeof this._codec.setNoiseReduction !== 'function') return this._unsupported('NR');
    this._codec.setNoiseReduction(on);
    return true;
  }

  setAutoNotch(on) {
    if (!this.connected) return false;
    if (typeof this._codec.setAutoNotch !== 'function') return this._unsupported('Auto-notch');
    this._codec.setAutoNotch(on);
    return true;
  }

  setCompressor(on) {
    if (!this.connected) return false;
    if (typeof this._codec.setCompressor !== 'function') return this._unsupported('Compressor');
    // A codec may refuse per-connection (rigctld Yaesu-raw has no COMP
    // mapping) — propagate so the caller doesn't latch state for a
    // command that was never sent.
    if (this._codec.setCompressor(on) === false) return this._unsupported('Compressor');
    return true;
  }

  setVox(on) {
    if (!this.connected) return false;
    if (typeof this._codec.setVox !== 'function') return this._unsupported('VOX');
    if (this._codec.setVox(on) === false) return this._unsupported('VOX');
    return true;
  }

  setAgc(mode) {
    if (!this.connected) return false;
    if (typeof this._codec.setAgc !== 'function') return this._unsupported('AGC');
    this._codec.setAgc(mode);
    return true;
  }

  setNrLevel(pct) {
    if (!this.connected) return false;
    if (typeof this._codec.setNrLevel !== 'function') return this._unsupported('NR level');
    this._codec.setNrLevel(pct);
    return true;
  }

  setVoxLevel(pct) {
    if (!this.connected) return false;
    if (typeof this._codec.setVoxLevel !== 'function') return this._unsupported('VOX level');
    this._codec.setVoxLevel(pct);
    return true;
  }

  setMonitor(on) {
    if (!this.connected) return false;
    if (typeof this._codec.setMonitor !== 'function') return this._unsupported('Monitor');
    this._codec.setMonitor(on);
    return true;
  }

  setMonLevel(pct) {
    if (!this.connected) return false;
    if (typeof this._codec.setMonLevel !== 'function') return this._unsupported('Monitor level');
    this._codec.setMonLevel(pct);
    return true;
  }

  setRit(on) {
    if (!this.connected) return false;
    if (typeof this._codec.setRit !== 'function') return this._unsupported('RIT');
    this._codec.setRit(on);
    return true;
  }

  // --- FTX-1-class facade additions ---
  // Each guarded by typeof === 'function' so non-Yaesu codecs silently no-op
  // instead of throwing. Matches the existing pattern for setVox/setAgc etc.
  setMicGain(pct) {
    if (!this.connected) return;
    if (typeof this._codec.setMicGain === 'function') this._codec.setMicGain(pct);
  }

  setCompLevel(pct) {
    if (!this.connected) return;
    if (typeof this._codec.setCompLevel === 'function') this._codec.setCompLevel(pct);
  }

  setDnrLevel(level) {
    if (!this.connected) return;
    if (typeof this._codec.setDnrLevel === 'function') this._codec.setDnrLevel(level);
  }

  setClarRx(on) {
    if (!this.connected) return;
    if (typeof this._codec.setClarRx === 'function') this._codec.setClarRx(on);
  }

  setClarTx(on) {
    if (!this.connected) return;
    if (typeof this._codec.setClarTx === 'function') this._codec.setClarTx(on);
  }

  setClarOffset(hz) {
    if (!this.connected) return;
    if (typeof this._codec.setClarOffset === 'function') this._codec.setClarOffset(hz);
  }

  setBreakIn(on) {
    if (!this.connected) return;
    if (typeof this._codec.setBreakIn === 'function') this._codec.setBreakIn(on);
  }

  setBreakInDelay(ms) {
    if (!this.connected) return;
    if (typeof this._codec.setBreakInDelay === 'function') this._codec.setBreakInDelay(ms);
  }

  setPreampTarget(target, level) {
    if (!this.connected) return;
    if (typeof this._codec.setPreampTarget === 'function') this._codec.setPreampTarget(target, level);
  }

  setAntennaPort(port) {
    if (!this.connected) return;
    if (typeof this._codec.setAntennaPort === 'function') this._codec.setAntennaPort(port);
  }

  vfoCopyAB() {
    if (!this.connected) return;
    this._codec.vfoCopyAB();
  }

  vfoCopyBA() {
    if (!this.connected) return;
    this._codec.vfoCopyBA();
  }

  // --- CW keying (DTR + TX/RX routing) ---

  setCwKeyDtr(down, pins) {
    if (!this._transport.setPin) return;
    // If the transport has already told us DTR control isn't available on this
    // port (e.g. Linux cdc_acm returning ENOTSUP for TIOCMSET), don't send any
    // more pin-set calls. Per-element paddle keying would flood the log with
    // "Operation not supported" errors, one per dit/dah.
    if (this._dtrUnsupported) return;
    const p = pins || { dtr: true };
    // Drive BOTH modem-control lines explicitly on every element. node-serialport's
    // port.set() resets any line you OMIT back to its default (both dtr and rts
    // default to TRUE), so a partial {dtr} call latches RTS HIGH — a permanent
    // key-down / stuck PTT on a rig whose USB keying line is the one we didn't name
    // (node-serialport #2636; and the IC-7300's documented USB Keying (CW)=RTS
    // config). So the keyed line(s) follow `down` and the unused line is forced LOW,
    // never left to the library default.
    const state = {
      dtr: p.dtr ? !!down : false,
      rts: p.rts ? !!down : false,
    };
    this._transport.setPin(state, (err) => {
      if (!err) return;
      // Latch after the first failure — logging once is enough to tell the user
      // what's wrong, and subsequent paddle elements would just spam the same
      // message. Cleared automatically on reconnect (new _transport instance).
      if (this._dtrUnsupported) return;
      this._dtrUnsupported = true;
      this._log(
        `DTR keying not supported on this port: ${err.message}. ` +
        'This usually means the Linux cdc_acm driver does not honor TIOCMSET on USB-CDC radios (IC-7300 etc.). ' +
        'Workaround: use an external USB-UART adapter (FTDI/CH340) wired to the radio\'s CW KEY jack and set it as the "CW Key Port" in Settings. ' +
        'Paddle keying over ECHOCAT is disabled for this session; CW text macros (CI-V send_morse) still work.'
      );
    });
  }

  setCwKeyTxRx(down) {
    if (!this.connected) return;
    if (down) {
      // Key down: activate PTT once, reset holdoff timer
      if (!this._cwPttActive) {
        this._codec.setTransmit(true);
        this._cwPttActive = true;
      }
      if (this._cwPttTimer) clearTimeout(this._cwPttTimer);
      this._cwPttTimer = setTimeout(() => this._cwPttRelease(), this._cwPttHoldoff);
    } else {
      // Key up: don't release PTT immediately — holdoff timer handles it
      if (this._cwPttTimer) clearTimeout(this._cwPttTimer);
      this._cwPttTimer = setTimeout(() => this._cwPttRelease(), this._cwPttHoldoff);
    }
  }

  _cwPttRelease() {
    if (this._cwPttTimer) { clearTimeout(this._cwPttTimer); this._cwPttTimer = null; }
    if (this._cwPttActive) {
      this._cwPttActive = false;
      if (this.connected) this._codec.setTransmit(false);
    }
  }

  setCwKeyTa(down) {
    // TA keying: switch to digi mode, TX, send TA tone
    if (!this.connected) return;
    // Codec handles TA command specifics
    if (typeof this._codec.setCwKeyTa === 'function') {
      this._codec.setCwKeyTa(down);
    } else {
      this.setCwKeyTxRx(down);
    }
  }

  endCwKeyTa() {
    if (typeof this._codec.endCwKeyTa === 'function') {
      this._codec.endCwKeyTa();
    }
  }

  // --- Accessors ---

  get model() { return this._model; }
  get protocol() { return this._model.protocol; }
  get lastFreqHz() { return this._lastFreqHz; }
  get lastMode() { return this._lastParsedMode; }

  /** Return the codec's command table for the Table tab UI */
  getCommandTable() {
    if (typeof this._codec.getCommandTable === 'function') {
      return this._codec.getCommandTable();
    }
    return [];
  }

  /** Apply user command overrides to the codec (Kenwood/Yaesu only) */
  applyCommandOverrides(overrides) {
    if (typeof this._codec.applyOverrides === 'function') {
      this._codec.applyOverrides(overrides);
    }
  }
}

module.exports = { RigController };
