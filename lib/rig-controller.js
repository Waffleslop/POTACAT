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
const VoiceDataMode = require('./voice-data-mode');
const { cwAirtimeMs } = require('./cw-airtime');

// CW text backstops (Yaesu keyer-memory path): how long after a message's
// envelope a radio still reporting TX is taken to be stuck (longer than the
// longest BK-IN delay, 3 s), and when BK-IN goes back to the operator's setting.
const CW_STUCK_CHECK_MS = 4000;
const CW_STUCK_READBACK_MS = 2500; // a TX report older than this says nothing about now
const CW_BREAKIN_RESTORE_GRACE_MS = 3500;

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

    // Voice in DATA mode (rig.voiceAsData, lib/voice-data-mode.js): voice
    // USB/LSB goes to the radio as DIGU/DIGL, and while it does the radio's
    // DATA report is read back as the voice mode.
    this._voiceAsData = false;
    this._voiceSentAsData = false;

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
    // Yaesu keyer-memory sends (KM + play): chunks waiting for the one playing.
    this._cwKmTimers = [];
    this._cwKmFreeAt = 0;
    this._breakIn = null; // the radio's BK-IN as last read (null = never read)
    this._cwBreakInWarned = false;

    // Throttle state
    this._lastRgTime = 0;
    this._lastPcTime = 0;

    // TX state — used to gate meter polling. S-meter is meaningless during TX,
    // SWR+ALC are meaningless during RX. Flipped by setTransmit() below; foot-
    // switch/mic PTT won't toggle it, but today's behaviour in that case is
    // just "poll garbage" too, so this is no regression.
    this._transmitting = false;
    // CW envelope hold — see _holdTxForCw(). The radio keys itself from its
    // KY buffer, so setTransmit() never runs for CW text and _transmitting
    // stayed false through every message.
    this._cwHoldTimer = null;
    this._cwHoldUntil = 0;
    this._codecTxSeen = null; // last CAT-observed PTT (Kenwood IF; P8), null = never reported
    // Every TX-state change emits 'ptt' (PTT, CW text hold, key-port paddle):
    // the codec hears each one (_syncTxHint).
    this.on('ptt', () => this._syncTxHint());
    this._syncTxHint();

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
      this.pttUnavailable = false;
      this._lastReadOkMs = Date.now();
      // Fresh session: re-arm the mode-silence watchdog. Swapping rigs or
      // recovering a cable must get its own verdict, not the last one's.
      this._pollStartedMs = 0;
      this._modeSilenceLogged = false;
      // An Icom watches again for dropped CI-V replies (civ-codec pacingCheck).
      if (typeof this._codec.rearmPacingDetection === 'function') this._codec.rearmPacingDetection();
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
      // Throttle a REPEATING error. The 2s reconnect loop turns one unplugged
      // cable into thirty identical lines a minute — WB0MMC's report was
      // 175 lines of "Resource busy" with the actual diagnosis pushed out of
      // the excerpt. Same lesson cat.js learned from K6RBJ; a message that
      // CHANGES always gets through, so nothing new is ever suppressed.
      const now = Date.now();
      if (err.message === this._lastTransportError && now - (this._lastTransportErrorMs || 0) < 15000) return;
      this._lastTransportError = err.message;
      this._lastTransportErrorMs = now;
      this._log(`Transport error: ${err.message}`);
      // A port that does not exist: say which ones do, once per message.
      // Windows renumbers a radio's ports when it moves to another USB
      // socket, so the saved COM9 becomes COM10 with nothing else changing
      // (KF0TDB, FT-991A, 2026-10-02).
      if (/File not found|ENOENT|No such file/i.test(err.message) && this._portsListedFor !== err.message) {
        this._portsListedFor = err.message;
        try {
          require('serialport').SerialPort.list().then((ports) => {
            const names = (ports || []).map((p) => p.path + (p.friendlyName ? ` (${p.friendlyName.replace(/\s*\(COM\d+\)\s*$/i, '')})` : ''));
            // A Yaesu's USB port is a Silicon Labs CP210x/CP2105 bridge:
            // with no driver Windows lists no port at all (FT-991A Q&A 2026-11-04).
            const yaesu = this._model && this._model.brand === 'Yaesu';
            this._log(names.length
              ? `Serial ports on this computer: ${names.join('; ')}. Pick the radio's in Settings > My Rigs.`
              : yaesu
                ? "No serial ports found on this computer: is the radio powered on and its USB cable connected? Yaesu radios need the Silicon Labs CP210x USB to UART Bridge (VCP) driver, from the radio's product page on Yaesu's site (Files tab) or Silicon Labs' VCP driver page."
                : 'No serial ports found on this computer: is the radio powered on and its USB cable connected? Its driver may be missing.');
          }).catch(() => {});
        } catch { /* serialport unavailable */ }
      }
      // A port that exists but will not open: Windows says "Access denied",
      // Linux/macOS "Resource busy" — another program already has it. A new
      // operator moving from a logger that drives the same radio sees only
      // the raw error and reads it as "POTACAT doesn't recognise my COM
      // port" (N4IN, FTDX101MP on COM3/COM4 with ACLog, 2026-10-20).
      if (/Access denied|EBUSY|Resource busy|in use|already open/i.test(err.message) && this._busyHintFor !== err.message) {
        this._busyHintFor = err.message;
        const port = (this._target && this._target.path) || 'that port';
        let own = null;
        try { own = require('./transport').recentOwnClose(this._target && this._target.path); } catch { /* no serial */ }
        if (own && !own.closed && own.agoMs > 15000) {
          this._log(`${port}: POTACAT's own earlier connection to this port never finished closing (${Math.round(own.agoMs / 1000)} s ago), so Windows still counts it as open. Restart POTACAT, or unplug the radio's USB cable and plug it back in.`);
          return; // say it once per message; the next retry repeats only if the text changes
        }
        if (own) {
          this._log(`${port}: POTACAT itself had this port open ${Math.max(1, Math.round(own.agoMs / 1000))} s ago${own.closed ? '' : ' and Windows had not finished closing it'}, so this is probably its own handle being released. POTACAT keeps retrying; if it never opens, another program may have taken it in between.`);
          this._busyHintFor = null; // past the window, a still-busy port gets the other-program hint
          return;
        }
        this._log(`${port} is open in another program (a logger such as ACLog, HRD or Log4OM, WSJT-X, flrig, rigctld, or a second POTACAT). Only one program can hold a serial port: close the radio connection there and reconnect here, or share the radio through a virtual COM splitter.`);
      }
    });

    // Forward transport-layer diagnostic messages (e.g. DTR/RTS SetControlLineState
    // ack/failure) to the same CAT log panel the rig commands use. Helps
    // diagnose "radio keys on CW switch" bugs where the question is whether
    // the kernel driver honored the pin-deassert request.
    // A transport whose owner routes its log itself (the Icom Network RS-BA1
    // transport: main.js filters the 30-per-second keepalive lines out) must
    // not be forwarded here too — that bypassed the filter and printed every
    // line twice, and KG5EIU's bug report lost its whole repro to the flood
    // (IC-9700, 2026-10-22).
    if (!this._transport.routesOwnLog) this._transport.on('log', (msg) => this._log(msg));

    this._transport.on('data', (chunk) => {
      this._codec.onData(chunk);
    });

    // Wire codec events
    this._codec.on('frequency', (hz, meta) => {
      this._noteReadOk();
      // A frequency read while transmitting is the TX frequency, not the dial:
      // an IC-7100 on a repeater memory reads the offset TX frequency, and
      // POTACAT acted on it (kg6odijohn). Polls stop in TX; anything that
      // still arrives (a reply already in flight, a Kenwood IF) is ignored.
      if (this._transmitting) {
        if (!this._txFreqIgnoredLogged && hz !== this._lastFreqHz) {
          this._txFreqIgnoredLogged = true;
          this._log(`frequency read during transmit ignored (${(hz / 1e6).toFixed(6)} MHz): the dial is read again on receive`);
        }
        return;
      }
      this._txFreqIgnoredLogged = false;
      // Log the radio's REPORTED frequency on change. The UI mirrors this value
      // verbatim when CAT is connected (no optimistic readout), so a "freq
      // display reverts to a stale value even though the radio moved" symptom
      // (K6RBJ, IC-7100) is only diagnosable if we can SEE what the rig reports
      // back vs what we commanded. On-change only — silent while parked, so it
      // doesn't flood the CAT log during normal operation.
      if (hz !== this._lastFreqHz) this._log(`rig reports freq: ${(hz / 1e6).toFixed(6)} MHz`);
      this._lastFreqHz = hz;
      // meta (CI-V only): {cmd, fromAddr, toAddr} — which radio answered.
      this.emit('frequency', hz, meta);
    });
    // CI-V set-mode item reply (cmd 1A 05) — {settingId, value}. The Icom
    // Network path reads/writes the DATA MOD input source through this.
    this._codec.on('data-mod', (d) => {
      this._noteReadOk();
      this.emit('data-mod', d);
    });
    this._codec.on('mode', (mode) => {
      this._noteReadOk();
      if (mode !== this._lastParsedMode) this._log(`rig reports mode: ${mode}`);
      this._lastParsedMode = mode;
      this.emit('mode', this._voiceModeIn(mode));
    });
    this._codec.on('log', (m) => this._log(m)); // codec diagnostics (e.g. raw CI-V freq frame)
    this._codec.on('power', (w) => { this._noteReadOk(); this.emit('power', w); });
    this._codec.on('pacing', (p) => this.emit('pacing', p));
    this._codec.on('nb', (on) => { this._noteReadOk(); this.emit('nb', on); });
    this._codec.on('rfgain', (val) => this.emit('rfgain', val));
    this._codec.on('afgain', (val) => this.emit('afgain', val));
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
    this._codec.on('breakIn', (on) => {
      if (this._cwBreakInProbe) {
        // The reply to the BI; sent just before our BI1;: the operator's own
        // setting, which goes back when the message ends. The radio is on now.
        this._cwBreakInProbe = false;
        this._cwBreakInRestore = on ? null : true;
        this._breakIn = true;
        this.emit('breakIn', true);
        return;
      }
      this._breakIn = !!on;
      this.emit('breakIn', on);
    });
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
    // Measured forward power. The controller listened for nothing here
    // until 2026-09-19, so every direct-serial and rigctld rig emitted
    // watts that stopped at this object: main.js subscribes to the
    // CONTROLLER, and the wattmeter fan-out it feeds (main window PWR row,
    // VFO and JTCAT pop-outs, ECHOCAT) only ever had a source on the Flex
    // path. LZ3AW's TS-480 in 1.10.18: "there is a bargraph, but not moving".
    this._codec.on('powerMeter', (watts) => {
      this._txMeterAnswered = true;
      this._noteReadOk();
      this.emit('powerMeter', watts);
    });
    this._codec.on('smeter', (val) => { this._noteReadOk(); this.emit('smeter', val); });
    this._codec.on('swr', (val) => { this._noteReadOk(); this.emit('swr', val); });
    this._codec.on('alc', (val) => { this._noteReadOk(); this.emit('alc', val); });
    // CAT-observed PTT state (physical mic / footswitch / external keying).
    // Update _transmitting so the polling loop swaps to TX-only meters.
    this._codec.on('ptt', (on) => {
      this._noteReadOk();
      this._codecTxSeen = !!on;
      this._codecTxSeenAt = Date.now();
      // A hold POTACAT keeps for its OWN key line (DTR key port: text or
      // paddle) is not ended by an RX readback. POTACAT is the one keying, so
      // it knows when the over ends; the readback can be a reply the radio
      // gave just before key-down. LZ3AW 2026-10-02 (TS-480, 1.11.2): "the
      // radio reported receive 3156 ms before POTACAT's CW hold ended", 24 ms
      // into a 3 s over, and the power bar then read as the S-meter, which
      // is his "S-meter moves on CW TX". Said at most every 10 s.
      if (!on && this._cwHoldTimer && this._cwHoldKeyLine) {
        if (Date.now() - (this._cwHoldRxLoggedAt || 0) > 10000) {
          this._cwHoldRxLoggedAt = Date.now();
          this._log(`CW: the radio reported receive ${Math.max(0, this._cwHoldUntil - Date.now())} ms before POTACAT finishes keying; keeping the TX state until it does`);
        }
        return;
      }
      // The radio's own text buffer (KY) is the other kind of hold: there the
      // radio's word beats the envelope estimate. Back in RX, the hold ends now.
      if (!on) this._cancelCwHold();
      if (this._transmitting !== !!on) {
        this._transmitting = !!on;
        this.emit('ptt', !!on);
      }
    });
    this._codec.on('da', (on) => this.emit('da', on));
    // An Icom's band scope (CI-V 27, lib/icom-scope.js). A waveform frame is
    // the radio talking to us, so it counts as a live read.
    this._codec.on('scope-data', (payload, frame) => { this._noteReadOk(); this.emit('scope-data', payload, frame); });
    this._codec.on('scope-status', (payload, frame) => { this._noteReadOk(); this.emit('scope-status', payload, frame); });
    this._codec.on('scope-nak', (sub) => this.emit('scope-nak', sub));
    // The link cannot key the radio (a rigctld server answered RPRT -11 to
    // `T`). Read by main's PTT path so every key-down says so instead of
    // failing silently; cleared on each connect.
    this._codec.on('ptt-unavailable', () => { this.pttUnavailable = true; this.emit('ptt-unavailable'); });
    this._codec.on('error', (e) => this._log(e.message || 'codec error'));
  }

  // --- Lifecycle ---

  connect(target) {
    this._target = target;
    this._transport.connect(target);
  }

  disconnect() {
    this._cancelCwHold();
    this._stopPolling();
    this._cwPttRelease();
    if (this._cwTextDropTimer) { clearTimeout(this._cwTextDropTimer); this._cwTextDropTimer = null; }
    for (const t of this._cwKmTimers) clearTimeout(t);
    this._cwKmTimers = [];
    for (const t of this._pendingTimers) clearTimeout(t);
    this._pendingTimers = [];
    // A serial transport answers with a promise for the OS release.
    const closed = this._transport.disconnect();
    this.connected = false;
    this._closedPromise = (closed && typeof closed.then === 'function') ? closed : Promise.resolve();
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
    // A model may poll slower (pollIntervalMs). The (tr)uSDX carries its
    // audio over the same USB serial link as CAT, and every CAT command
    // interrupts the stream: a once-a-second poll was a click every second
    // on receive and gaps in the transmitted audio (KQ4VUU 2026-09-28; its
    // WSJT-X users poll every 30-80 s for the same reason).
    const interval = this._model.pollIntervalMs || (this._model.protocol === 'rigctld' ? 500 : 1000);
    // The link-down watchdog assumed a reply at least every 10 s; with a slow
    // poll that would declare a healthy radio gone between two polls.
    this._pollStaleMs = Math.max(RigController.POLL_STALE_MS, interval * 3);

    // Only on the FIRST run of a connection. _startPolling() re-runs after every
    // tune sequence's pause/resume, and restarting the clock there would mean a
    // station tuning more often than MODE_SILENCE_MS never reaches the check.
    if (!this._pollStartedMs) this._pollStartedMs = Date.now();
    this._pollRunSinceMs = Date.now();

    const tick = () => {
      this._checkPollStaleness();
      // Before the mode-silence note: a radio that only drops replies is
      // switched to one command at a time, not told its model is wrong.
      if (typeof this._codec.pacingCheck === 'function') this._codec.pacingCheck();
      this._checkModeSilence();
      // No CAT at all while transmitting when every command breaks the audio
      // stream (the (tr)uSDX): the meters are not worth a garbled over.
      if (this._transmitting && this._model.pollDuringTx === false) return;
      let polledPower = false;
      // No frequency/mode poll while PTT is asserted: the radio answers with
      // its TX frequency (repeater offset, split) and mode. The meter reads
      // below that need TX keep going.
      if (!this._transmitting) {
        if (this._codec.getFrequency) this._codec.getFrequency();
        if (this._codec.getMode) this._codec.getMode();
      }

      // Poll TX state so meters track physical-mic / footswitch / external
      // PTT, not just POTACAT-initiated TX. (AB9AI 2026-05-04: keyed up via
      // mic on FTdx3000, smeter kept polling and SWR/ALC stayed frozen
      // because _transmitting only flipped on POTACAT's own setTransmit.)
      if (this._codec.getPtt) this._codec.getPtt();
      // A codec whose only TX report rides on a status poll skipped above
      // (Kenwood IF; P8) keeps asking for it while transmitting, or a
      // hand-mic over latches TX for good (review of 044bf10d).
      if (this._transmitting && typeof this._codec.pollPttDuringTx === 'function') this._codec.pollPttDuringTx();

      // Active VFO + split readback (Kenwood IF; / rigctld v+s). Every cycle
      // so a front-panel A/B press or a custom-CAT VFO switch shows within
      // ~1s — the whole LZ3AW complaint was state that never followed the
      // radio. Codecs without the method (CI-V for now) skip it.
      if (this._codec.getVfoSplit && !this._transmitting) this._codec.getVfoSplit();

      // S-meter only during RX; SWR+ALC only during TX (every 2nd cycle).
      // Polling the wrong meter for the current state returns garbage and
      // wastes CAT bandwidth.
      if (!this._transmitting && this._codec.getSmeter) this._codec.getSmeter();
      const txMeters = this._transmitting || this._model.pollTxMetersAlways;
      if (txMeters && this._pollCount % 2 === 0) {
        if (this._codec.getSwr && !this._model.noSwr) this._codec.getSwr();
        if (this._codec.getAlc && !this._model.noSwr) this._codec.getAlc();
      }
      // Measured forward power — a real wattmeter, not the power setting.
      // TX-only for the same reason as SWR/ALC: it reads garbage on RX. Direct
      // serial reads it on its own faster timer (below); rigctld's whole poll
      // already runs every 500 ms, so it stays here.
      if (txMeters && !this._fastTxMeter) this._askPowerMeter();
      // Poll power and NB every 5th cycle (they change rarely)
      if (this._pollCount++ % 5 === 0) {
        if (caps.txpower && this._codec.getPower) {
          this._codec.getPower();
          polledPower = true;
        }
        if (caps.nb && this._codec.getNb) this._codec.getNb();
        if (caps.rfgain && this._codec.getRfGain) this._codec.getRfGain();
        if (this._codec.getAfGain) this._codec.getAfGain(); // no-op unless the codec's table can read it
        // Passband readback (slope-filter rigs answer SL;/SH;) so a width
        // turned on the radio's own knob reaches the displays too.
        if (caps.filter && typeof this._codec.getFilter === 'function') this._codec.getFilter();
        if (caps.agc && this._codec.getAgc) this._codec.getAgc();
        if (caps.anf && this._codec.getAutoNotch) this._codec.getAutoNotch();
        if (caps.vox && this._codec.getVox) this._codec.getVox();
        if (caps.voxLevel && this._codec.getVoxLevel) this._codec.getVoxLevel();
        if (caps.nr && this._codec.getDnrLevel) this._codec.getDnrLevel();
        if (caps.comp && this._codec.getCompressor) this._codec.getCompressor();
        if (caps.compLevel && this._codec.getCompLevel) this._codec.getCompLevel();
        if (caps.mon && this._codec.getMonitor) this._codec.getMonitor();
        if (caps.micGain && this._codec.getMicGain) this._codec.getMicGain();
        if ((caps.breakIn || (this._model.cw && this._model.cw.text === 'ky1' && this._model.brand === 'Yaesu')) && this._codec.getBreakIn) this._codec.getBreakIn();
        if (caps.antennaPort && this._codec.getAntennaPort) this._codec.getAntennaPort();
        // Preamp/ATT readback (#82) — radio-side ladder changes reflect in
        // POTACAT instead of the state being latch-on-command only.
        if (caps.preamp && this._codec.getPreamp) this._codec.getPreamp();
        if (caps.att && this._codec.getAtt) this._codec.getAtt();
        // Round 3 (#82 retest): monitor gain, RIT state, ATU inline state.
        if (caps.monLevel && this._codec.getMonLevel) this._codec.getMonLevel();
        if (caps.rit && this._codec.getRit) this._codec.getRit();
        if (caps.atu && this._codec.getAtuEnabled) this._codec.getAtuEnabled();
        // Icom DATA mode readback (1A 06): which of DATA1/2/3 the radio is
        // in and that mode's filter, so a mode set re-selects the operator's
        // own choice (WF4I IC-7610 USB-D2, #96). Last in the burst so its
        // NAK-latch attribution sees the fewest other replies.
        if (typeof this._codec.getDataMode === 'function') this._codec.getDataMode();
      }
      if (this._model.powerPollEvery && this._pollCount % this._model.powerPollEvery === 0) {
        if (!polledPower && caps.txpower && this._codec.getPower) this._codec.getPower();
      }
    };
    this._pollTimer = setInterval(tick, interval);
    // The wattmeter while transmitting, every 300 ms on its own timer. One
    // sample a second lagged the radio's bar by up to a second on the way up
    // and caught CW between elements (LZ3AW TS-480, 2026-09-29: "not so
    // dynamic, sometimes takes longer to visualise"). SM0; is 4 bytes out and
    // 8 back, so three more a second cost nothing on the link.
    this._fastTxMeter = this._model.protocol !== 'rigctld' && this._model.pollDuringTx !== false &&
      typeof this._codec.getPowerMeter === 'function' && interval >= 1000 && !this._model.pollIntervalMs;
    if (this._fastTxMeter) {
      this._txMeterTimer = setInterval(() => {
        if (this._transmitting || this._model.pollTxMetersAlways) this._askPowerMeter();
      }, RigController.TX_METER_MS);
    }
    // A slow poll must not leave frequency and mode unknown for its whole
    // first interval: read once now. Fast rigs keep their old start.
    if (interval > 1000) tick();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._txMeterTimer) {
      clearInterval(this._txMeterTimer);
      this._txMeterTimer = null;
    }
  }

  static get TX_METER_MS() { return 300; }

  /**
   * Ask the radio for its RF power setting now, instead of waiting for the
   * every-5th-cycle poll (a Guest Pass sets its cap and must see it read
   * back before the first key-down). false = this codec cannot read it.
   */
  readPower() {
    if (!this._codec || typeof this._codec.getPower !== 'function') return false;
    if (typeof this._codec.notePowerWanted === 'function') this._codec.notePowerWanted();
    this._codec.getPower();
    return true;
  }

  /** Ask for the measured forward power once (TX only). */
  _askPowerMeter() {
    if (!this._codec.getPowerMeter) return;
    this._codec.getPowerMeter();
    this._txMeterAsked = (this._txMeterAsked || 0) + 1;
    // Some radios answer nothing at all on CAT while they transmit, and
    // then a wattmeter simply cannot work over this link — the meter
    // sits at zero and nothing says why (LZ3AW's TS-480, whose silence
    // during transmit is also what the CW hold exists for). Say it once
    // per connection, in the log a bug report carries. (24 asks = about
    // 8 s of transmitting at either poll rate.)
    if (this._txMeterAsked === (this._fastTxMeter ? 24 : 8) && !this._txMeterAnswered && !this._txMeterSaid) {
      this._txMeterSaid = true;
      this._log('no meter reply while transmitting — this radio answers no CAT during TX, so the power/SWR meters stay blank over this link');
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
    if (silentMs > (this._pollStaleMs || RigController.POLL_STALE_MS)) {
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
  _noteReadOk(fromRadio = true) {
    this._lastReadOkMs = Date.now();
    if (fromRadio) this._lastAnswerMs = this._lastReadOkMs;
    if (this._linkStale) {
      this._linkStale = false;
      this.connected = true;
      this.emit('log', 'radio is answering polls again — link restored');
      this.emit('status', { connected: true, target: this._target });
    }
  }

  /**
   * Is the radio itself switched on, as far as CAT can tell (ECHOCAT's RIG
   * POWER pill)? A USB CAT port stays open with the radio off, so the port
   * says nothing; an ANSWER to a poll does — a radio that is off answers
   * none. true = it answered within the no-reply window; false = polls have
   * run that long unanswered AND it has answered over this link before
   * (`answeredBefore`: this session, or the rig's Station Setup), so this is
   * not a wrong port or baud; null = cannot tell (no transport, polling
   * paused, transmitting — some rigs mute CAT in TX — or never answered).
   */
  radioPowerEvidence(answeredBefore) {
    const now = Date.now();
    const win = this._pollStaleMs || RigController.POLL_STALE_MS;
    if (this._transmitting) return null;
    if (this._lastAnswerMs && now - this._lastAnswerMs <= win) return true;
    if (!this._pollTimer || !this._pollRunSinceMs || now - this._pollRunSinceMs <= win) return null;
    if (!(this.connected || this._linkStale)) return null;
    return (this._lastAnswerMs || answeredBefore) ? false : null;
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
    mode = this._voiceModeOut(mode, frequencyHz);

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

    // Filter width, for the mode this tune sets. Polling is stopped, so the
    // codec's last parsed mode is still the old one: an indexed Yaesu looked
    // a USB -> CW tune's 500 Hz up in the SSB chart (FT-710, 2026-10-22).
    if (filterWidth > 0) {
      const widthMode = resolved && this._codec.modeNameForMapping
        ? this._codec.modeNameForMapping(resolved)
        : null;
      this._pendingTimers.push(setTimeout(() => {
        if (this.connected) this._codec.setFilterWidth(filterWidth, widthMode);
      }, delay));
      delay += 100;
    }

    // Split — only send when the desired state differs from what we last
    // told the rig. Previously we re-sent "split on" on every tune, which
    // forced TS-2000 back into split each time, and there was no path to
    // turn split off at all.
    //
    // And never send split OFF unless POTACAT itself turned it on (GitHub
    // #113 item 2, mdeltito FT-710): _lastSplit starts null, so the first
    // tune of every session sent ST0; and cancelled a split the operator
    // had set on the radio. Off is only ours to send when on was ours.
    const desiredSplit = !!split;
    const sendSplit = desiredSplit ? this._lastSplit !== true : this._lastSplit === true;
    if (sendSplit) {
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

  // --- Voice in DATA mode (GitHub #24) ---

  setVoiceAsData(on) {
    this._voiceAsData = !!on;
    if (!this._voiceAsData) this._voiceSentAsData = false;
  }

  // A mode about to be sent: voice SSB becomes DIGU/DIGL when the option is
  // on. Any other request (JTCAT's own DIGU, CW, FM) clears the mark, so a
  // real data mode is reported as itself.
  _voiceModeOut(mode, freqHz) {
    if (!mode || !this._voiceAsData) return mode;
    const data = VoiceDataMode.voiceToData(mode, freqHz);
    this._voiceSentAsData = !!data;
    if (data) this._log(`voice in DATA mode: ${mode} sent as ${data}`);
    return data || mode;
  }

  // A mode the radio reported: USB-D/LSB-D reads as USB/LSB while the last
  // request was a voice mode sent as DATA. Anything else ends that.
  _voiceModeIn(mode) {
    if (!this._voiceSentAsData) return mode;
    const voice = VoiceDataMode.dataToVoice(mode);
    if (voice) return voice;
    const m = String(mode || '').toUpperCase();
    if (m !== 'USB' && m !== 'LSB') this._voiceSentAsData = false;
    return mode;
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
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.noAnchor] skip the frequency re-send after the
   *   mode. An Icom never moves the dial on a mode change, and a frequency
   *   set takes an Icom in MEMORY mode out to the VFO, with the VFO's own
   *   duplex: nj7n_nate's IC-705 repeater memories (- offset) transmitted
   *   with + offset on every ECHOCAT PTT that swapped FM to FM-D.
   */
  setModeOnly(mode, freqHz, opts = {}) {
    if (!this.connected) return;
    this._stopPolling();
    // The frequency still picks the sideband for a mode like SSB; only the
    // re-send below is skipped.
    const anchorHz = freqHz || this._lastFreqHz || 0;
    const reAnchor = !(opts && opts.noAnchor);
    mode = this._voiceModeOut(mode, anchorHz);
    this._codec.setMode(mode, anchorHz);
    this._log(`mode-only: ${mode}`);
    // A Yaesu can move the dial on a mode change: on the FT-710 the shift is
    // the CW pitch under CW FREQ DISPLAY = PITCH OFFSET (EX020118), ~700 Hz
    // on a USB <-> DATA-U change at any width, gone with DIRECT FREQ
    // (measured on WWV by mdeltito, GitHub #113 item 3; it is not the
    // filter-width difference this comment used to name). Re-anchor by
    // re-sending the freq. Harmless on rigs that don't drift.
    // (NT0Y, FT-710 via rigctld, 2026-04-30.)
    //
    // opts.anchorNow (the PTT path, GitHub #113 item 1): the frequency goes
    // straight after the mode, before the key-down that follows, so the over
    // never starts ~700 Hz off for 200 ms. Writes leave in order, and
    // `MD; FA; TX1;` back to back works on the FT-710 (mdeltito).
    if (reAnchor && anchorHz > 0) {
      if (opts && opts.anchorNow) {
        this._codec.setFrequency(anchorHz);
      } else {
        this._pendingTimers.push(setTimeout(() => {
          if (this.connected) this._codec.setFrequency(anchorHz);
        }, 200));
      }
    }
    this._startPolling(500);
  }

  setTransmit(on) {
    if (!this.connected) return;
    if (!on) this._cancelCwHold(); // an explicit key-up ends any CW envelope
    this._pttCommanded = !!on;
    this._transmitting = !!on;
    this._syncTxHint();
    this._codec.setTransmit(on);
  }

  /**
   * Key the radio with a modem-control line on the CAT port instead of a CAT
   * command (catTarget.ptt 'rts' | 'dtr'). The IC-706MKIIG has no CI-V
   * transmit command at all, so a CAT key-down did nothing; its interface
   * keys on RTS, as WSJT-X is set up (steveo0600, wadevk1mic 2026-11-01).
   * Same TX bookkeeping as setTransmit; the other line keeps its state.
   */
  setTransmitLine(line, on, done) {
    if (!this.connected || !this._transport.setPin) { if (done) done(new Error('not connected')); return; }
    if (!on) this._cancelCwHold();
    this._pttCommanded = !!on;
    this._transmitting = !!on;
    this._syncTxHint();
    this._transport.setPin({ [line === 'dtr' ? 'dtr' : 'rts']: !!on }, done);
  }

  /** Tell the codec whether we are keyed (Kenwood SM: S-meter vs power bar,
   *  kenwood-codec setTxHint). Every TX-state change emits 'ptt' here, except
   *  setTransmit() above, which calls this itself. */
  _syncTxHint() {
    if (this._codec && typeof this._codec.setTxHint === 'function') this._codec.setTxHint(this._transmitting);
  }

  /** `mode` (optional): the mode this width is for, when it was just tuned
   *  and the radio has not reported it yet (a VFO profile tunes, then sets its
   *  width; GitHub #113 item 4). Without it the codec uses the last mode read. */
  setFilterWidth(hz, mode) {
    if (!this.connected || !hz) return;
    let widthMode;
    if (mode && this._codec.resolveMode && this._codec.modeNameForMapping) {
      const resolved = this._codec.resolveMode(mode, this._lastFreqHz || 0);
      widthMode = resolved ? this._codec.modeNameForMapping(resolved) : undefined;
    }
    if (widthMode) this._codec.setFilterWidth(hz, widthMode);
    else this._codec.setFilterWidth(hz);
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

  /**
   * TX power in WATTS, whatever the backend: a codec with its own watts
   * conversion (rigctld, on Hamlib's scale) gets watts; every other codec's
   * setTxPower already takes watts. Never throttled — a power write that is
   * dropped (the WSPR cap followed by a restore) is a radio left at the
   * wrong power.
   */
  setTxPowerWatts(watts) {
    if (!this.connected) return;
    if (typeof this._codec.setTxPowerWatts === 'function') this._codec.setTxPowerWatts(watts);
    else this._codec.setTxPower(watts);
    this._lastPcTime = Date.now();
    this._log(`TX power: ${watts}W`);
  }

  setPowerState(on) {
    // Power-on: radio may be off, just need transport open
    if (!this._transport.connected) {
      this.emit('log', `Power ${on ? 'on' : 'off'} not sent — the ${this._model.protocol === 'rigctld' ? 'rigctld connection' : 'port'} is not open`);
      return;
    }
    // The line rate sizes the Icom wake-up preamble (civ-codec setPowerState);
    // a serial port opened with no rate runs at the transport's 9600 default.
    const t = this._transport._target || {};
    const baudRate = t.baudRate || (t.path ? 9600 : undefined);
    this._codec.setPowerState(on, { baudRate });
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

  /** State toggle (enable/disable the inline tuner). Falls back to the old
   *  tune-cycle/stop pair on codecs without a real enable command. */
  setAtuEnabled(on) {
    if (!this.connected) return;
    // A codec answers false when it has no enable command for this radio
    // (kenwood-codec on a Kenwood), and the old tune/stop pair applies.
    if (typeof this._codec.setAtuEnabled === 'function' && this._codec.setAtuEnabled(on) !== false) {
      this._log('ATU ' + (on ? 'enabled' : 'disabled'));
    } else if (on) { this.startTune(); } else { this.stopTune(); }
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

  /** Can this codec set the OTHER (TX) VFO's frequency? (caps.splitFreq) */
  get hasFrequencyOther() {
    return typeof this._codec.setFrequencyOther === 'function';
  }

  /**
   * Set the other VFO's frequency — the TX side in split — without moving
   * the dial (WC5T IC-7300 2026-10-31). The display follows the readback
   * (`frequencyOther`), never this request. False = the rig cannot.
   */
  setFrequencyOther(hz) {
    if (!this.connected) return false;
    if (!this.hasFrequencyOther) { this._log('this radio has no command to set the other VFO'); return false; }
    const ok = this._codec.setFrequencyOther(hz);
    if (ok !== false) this._log(`Other VFO (TX): ${hz} Hz`);
    return ok !== false;
  }

  /** Cancel in-progress CW text by dropping PTT, then send new text */
  /**
   * @param {string} text
   * @param {{live?: boolean}} [opts] live = key-as-I-type. Each call is ONE
   *   character (or a couple), appended to a transmission already in flight.
   *   The normal path opens every send by ABORTING whatever is playing so a
   *   new macro starts clean — do that per keystroke and each letter kills
   *   the letter before it, then waits 50ms to start again, so the operator
   *   types ahead of a radio that keeps restarting ("when typing is faster,
   *   keying is delaying too much" — LZ3AW). Live sends append and never
   *   abort; that is what the rigs' buffers are for.
   */
  sendCwText(text, opts) {
    if (!this.connected || !text) return;
    const live = !!(opts && opts.live);
    const cwCaps = this._model.cw || {};
    if (cwCaps.text === 'ky1' && this._model.brand === 'Yaesu') {
      // Yaesu: the radio keys ITSELF from the text through break-in, which is
      // how Hamlib sends it (newcat_send_morse: KM1 text, then play it — no
      // PTT). Asserting TX1; first keyed a steady CARRIER in CW on the FTX-1
      // and FT-710 (W2XYZ, W3MDT 2026-10-28: "TX1; alone in CW keys a full
      // carrier, BK-IN on or off"); the April TX1 wrapper only looked like it
      // worked because the FT-710 refuses "KY <text>;" and went to TX anyway.
      // The radio keys itself only with BK-IN on; with it off the message
      // plays in the sidetone and nothing goes out ("unable to send any CW",
      // W2XYZ FTX-1F on 1.13.8). Turn it on for the message and put the
      // operator's setting back when it ends: a setting POTACAT changes is a
      // setting POTACAT restores.
      this._cwEnsureBreakIn();
      this._cwStuckWatch = true;
      if (!live) this._cancelCwHold();
      if (cwCaps.kyMode === 'km') {
        // One keyer memory holds one chunk: write each chunk when the one
        // before it has played, or the next KM overwrites it mid-message.
        if (!live) {
          for (const t of this._cwKmTimers) clearTimeout(t);
          this._cwKmTimers = [];
          this._cwKmFreeAt = 0;
        }
        const perCharMs = 12000 / (this._cwWpm || 20);
        const chunk = cwCaps.textChunk || 50;
        let at = Math.max(0, this._cwKmFreeAt - Date.now());
        for (let i = 0; i < text.length; i += chunk) {
          const part = text.substring(i, i + chunk);
          if (at === 0) this._codec.sendCwText(part, { live });
          else this._cwKmTimers.push(setTimeout(() => { if (this.connected) this._codec.sendCwText(part, { live }); }, at));
          at += Math.ceil(part.length * perCharMs);
        }
        this._cwKmFreeAt = Date.now() + at;
      } else {
        this._codec.sendCwText(text, { live });
      }
      this._holdTxForCw(text);
      this._cwArmBreakInRestore();
      return;
    }
    if (cwCaps.text === 'ky1') {
      // Yaesu: BK-IN auto-key from CAT KY is unreliable across firmware
      // versions (notably FT-710). Explicit sequence — TX1 to assert PTT,
      // 50ms for the radio to enter TX, KY to queue the text, then TX0
      // after the estimated keying duration. Same pattern Hamlib uses
      // for Yaesu NewCAT rigs.
      // CW element timing: 1 dit = 1200/wpm ms. PARIS word = 50 dits.
      // Approximate avg char = 10 dits → duration = text.length * 10 * 1200 / wpm
      const wpm = this._cwWpm || 20;
      const durationMs = Math.ceil((text.length * 12000) / wpm) + 1000;
      const keying = !!this._cwTextDropTimer;
      if (this._cwTextDropTimer) { clearTimeout(this._cwTextDropTimer); this._cwTextDropTimer = null; }
      if (live && keying) {
        // Already transmitting: hand the radio the character now and push
        // key-up out, rather than re-asserting PTT and paying 50ms again.
        this._codec.sendCwText(text);
        this._cwTextDropTimer = setTimeout(() => {
          this._cwTextDropTimer = null;
          if (this.connected) this._codec.setTransmit(false);
        }, durationMs);
        return;
      }
      this._codec.setTransmit(true);
      const sendDelay = 50;
      setTimeout(() => {
        if (this.connected) this._codec.sendCwText(text, { live });
      }, sendDelay);
      this._cwTextDropTimer = setTimeout(() => {
        this._cwTextDropTimer = null;
        if (this.connected) this._codec.setTransmit(false);
      }, sendDelay + durationMs);
    } else if (live) {
      this._cwStuckWatch = false;
      // Kenwood buffered KY: append straight into the radio's buffer. No
      // RX; (it would abort the character still being keyed) and no 50ms
      // settle (there is nothing to settle — TX is already up).
      this._codec.sendCwText(text, { live: true });
      this._holdTxForCw(text);
    } else {
      // Kenwood buffered KY: abort current TX first so the new message starts clean
      this._cwStuckWatch = false;
      this._codec.setTransmit(false);
      this._cancelCwHold();
      setTimeout(() => {
        if (!this.connected) return;
        this._codec.sendCwText(text);
        this._holdTxForCw(text);
      }, 50);
    }
  }

  /**
   * Mark the rig as transmitting for a CW message's estimated envelope.
   *
   * The radio keys ITSELF from its KY buffer (break-in), so POTACAT's own
   * setTransmit() never runs for CW text and _transmitting stayed false the
   * whole time. A TS-480 mutes CAT while it transmits, and the staleness
   * watchdog exempts only _transmitting — so ten seconds of a CQ, or a few
   * seconds of key-as-I-type, declared the radio gone and every keystroke
   * after that was dropped on the floor: "after several seconds the radio
   * stops transmitting" (LZ3AW 2026-09-14). Each appended character extends
   * the hold; a CAT PTT readback (Kenwood IF; P8) overrides the estimate.
   */
  _holdTxForCw(text) {
    const wpm = this._cwWpm || 20;
    const perCharMs = 12000 / wpm; // ~10 dits per character, gaps included
    // The longer of the two: calls and digits outrun the per-character figure.
    this.noteTransmitting(Math.max(Math.ceil(text.length * perCharMs), cwAirtimeMs(text, wpm)), { queue: true });
  }

  /**
   * Something outside this controller is keying the rig for about `ms` more
   * (main.js's DTR key port: text queued on it, or a paddle edge). Hold the
   * TX flag so the staleness watchdog does not read a CAT-muted radio as a
   * dead one — the paddle case is LZ3AW's "radio stops transmitting after a
   * few seconds": link declared DOWN mid-over, key line forced low.
   * `ms` is normally the whole remaining envelope, so successive calls EXTEND
   * the hold to cover it and never stack: a paddle edge asks for two seconds
   * each time, and adding that to a running deadline left a half-minute of
   * sending flagged as transmitting for minutes afterwards — PTT held, and
   * the staleness watchdog exempting a link that had really died.
   *
   * `{ queue: true }` is the exception, for text handed to a buffer that
   * sends it one character at a time (the rig's own KY buffer): there each
   * character is additional airtime behind what is already queued, so the
   * hold is stacked onto the running deadline.
   *
   * A CAT PTT readback still overrides either form.
   */
  noteTransmitting(ms, opts) {
    const now = Date.now();
    // Whose keying this is: a queue hold is the radio's own KY buffer, which
    // the radio reports on; anything else is POTACAT driving the key line.
    this._cwHoldKeyLine = !(opts && opts.queue);
    const base = (opts && opts.queue) ? Math.max(now, this._cwHoldUntil || 0) : now;
    const until = base + Math.max(0, Number(ms) || 0) + (this._cwHoldTimer ? 0 : 500);
    this._cwHoldUntil = Math.max(this._cwHoldUntil || 0, until);
    if (!this._transmitting) { this._transmitting = true; this.emit('ptt', true); }
    this._noteReadOk(false); // the no-reply window restarts when TX ends, not before
    if (this._cwHoldTimer) clearTimeout(this._cwHoldTimer);
    this._cwHoldTimer = setTimeout(() => this._cwHoldExpired(), this._cwHoldUntil - now + 300);
  }

  _cwHoldExpired() {
    this._cwHoldTimer = null;
    this._cwHoldUntil = 0;
    // A radio that reported itself still keyed keeps the flag until its next
    // readback says otherwise; with no readback, assume the buffer drained.
    if (this._codecTxSeen === true) { if (this._cwStuckWatch) this._cwArmStuckCheck(); return; }
    if (this._transmitting) { this._transmitting = false; this.emit('ptt', false); }
    this._lastReadOkMs = Date.now();
  }

  /**
   * Backstop for a radio that stays in transmit after a CW text message
   * (kc9hekbrian FTDX10 2026-10-25: the red TX light and a carrier stayed on
   * until he pressed Stop). The message's envelope plus the longest break-in
   * delay has passed, the radio still reports TX, POTACAT is not holding PTT
   * and no newer message is keying: send RX and say so.
   *
   * Yaesu keyer-memory sends only, the one path that has left a radio keyed.
   * Everywhere else the radio's keyer ends its own message, and this ran on an
   * estimate of when that was: WF4I's IC-7610 got the warning on message
   * buttons (#120), and RX in the middle of a message cuts it off. It also
   * needs a fresh readback, because a TX report left over from before the
   * radio went quiet is not evidence of anything.
   */
  _cwArmStuckCheck() {
    if (this._cwStuckTimer) clearTimeout(this._cwStuckTimer);
    this._cwStuckTimer = setTimeout(() => {
      this._cwStuckTimer = null;
      if (!this.connected || this._cwHoldTimer || this._pttCommanded) return;
      if (this._codecTxSeen !== true || !this._cwStuckWatch) return;
      if (Date.now() - (this._codecTxSeenAt || 0) > CW_STUCK_READBACK_MS) return;
      this.emit('log', 'CW: the radio was still transmitting 4 s after the message ended; sent receive');
      this.emit('notice', 'The radio stayed in transmit after the CW message. POTACAT switched it back to receive.');
      try { this._codec.setTransmit(false); } catch { /* link going down */ }
      if (this._transmitting) { this._transmitting = false; this.emit('ptt', false); }
    }, CW_STUCK_CHECK_MS);
  }

  _cwEnsureBreakIn() {
    if (this._breakIn === true || typeof this._codec.setBreakIn !== 'function') return;
    if (this._cwBreakInRestore == null && !this._cwBreakInProbe) {
      if (this._breakIn === false) {
        this._cwBreakInRestore = true;
      } else if (typeof this._codec.getBreakIn === 'function') {
        // Unknown: ask, then turn it on. The reply (to the BI; sent first)
        // tells the breakIn handler what to put back.
        this._cwBreakInProbe = true;
        this._codec.getBreakIn();
      }
      this.emit('log', "CW: turned BK-IN on for this message; the radio's setting goes back when it ends");
    }
    this._codec.setBreakIn(true);
    if (!this._cwBreakInProbe) { this._breakIn = true; this.emit('breakIn', true); }
  }

  _cwArmBreakInRestore() {
    if (this._cwBreakInRestore !== true && !this._cwBreakInProbe) return;
    if (this._cwBreakInTimer) clearTimeout(this._cwBreakInTimer);
    const wait = Math.max(0, (this._cwHoldUntil || Date.now()) - Date.now()) + CW_BREAKIN_RESTORE_GRACE_MS;
    this._cwBreakInTimer = setTimeout(() => {
      this._cwBreakInTimer = null;
      if (this._cwHoldTimer) { this._cwArmBreakInRestore(); return; } // a newer message is still keying
      this._cwBreakInProbe = false;
      if (this._cwBreakInRestore === true && this.connected) {
        this._codec.setBreakIn(false);
        this._breakIn = false;
        this.emit('breakIn', false);
        this.emit('log', 'CW: BK-IN back off, as the radio had it');
      }
      this._cwBreakInRestore = null;
    }, wait);
  }

  _cancelCwHold() {
    if (this._cwHoldTimer) { clearTimeout(this._cwHoldTimer); this._cwHoldTimer = null; }
    this._cwHoldUntil = 0;
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
    for (const t of this._cwKmTimers) clearTimeout(t);
    this._cwKmTimers = [];
    this._cwKmFreeAt = 0;
    this._cancelCwHold();
    if (this._cwStuckTimer) { clearTimeout(this._cwStuckTimer); this._cwStuckTimer = null; }
    if (this._cwTextDropTimer) {
      clearTimeout(this._cwTextDropTimer);
      this._cwTextDropTimer = null;
    }
    if (this.connected) this._codec.setTransmit(false);
    // The hold timer that would have ended the TX state just went. A radio
    // that is still keyed says so at the next poll.
    if (this._transmitting && !this._cwPttActive) { this._transmitting = false; this.emit('ptt', false); }
    this._lastReadOkMs = Date.now();
  }

  sendRaw(text) {
    if (!this.connected) return;
    this._codec.sendRaw(text);
  }

  /**
   * Send a raw command and get the radio's reply back (Kenwood/Yaesu text
   * protocol and rigctld). Rejects on a link that cannot match replies.
   * @returns {Promise<string>}
   */
  queryRaw(cmd, opts) {
    if (!this.connected) return Promise.reject(new Error('rig not connected'));
    if (typeof this._codec.queryRaw !== 'function') {
      return Promise.reject(new Error('this rig link cannot read replies to raw commands'));
    }
    return this._codec.queryRaw(cmd, opts);
  }

  // --- Extended controls ---

  /** CI-V scope command (Icom only); returns the frame sent, or null. */
  sendScope(bytes) {
    if (!this.connected || typeof this._codec.sendScope !== 'function') return null;
    return this._codec.sendScope(bytes);
  }

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
        // Paddle TX;/RX; went straight to the codec, so the watchdog saw a
        // silent radio for the whole over — same trap as the KY buffer.
        if (!this._transmitting) { this._transmitting = true; this.emit('ptt', true); }
        this._noteReadOk(false);
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
      if (this._transmitting && !this._cwHoldTimer) { this._transmitting = false; this.emit('ptt', false); }
      this._lastReadOkMs = Date.now();
    }
  }

  /** True when the codec can key CW elements with TA. No codec implements it
   *  today, and the fallback below is bare PTT — no CW. */
  supportsCwKeyTa() {
    return !!(this._codec && typeof this._codec.setCwKeyTa === 'function');
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

  /**
   * CI-V set-mode items (cmd 1A 05), used by the Icom Network path to
   * switch the radio's DATA MOD input to LAN for RS-BA1 TX audio and put it
   * back afterwards. The reply arrives as a 'data-mod' event. These two
   * wrappers were CALLED by main.js from the day Icom Network shipped
   * (2026-06-16) but never existed — the auto-LAN step logged "CI-V settings
   * commands are unavailable" on every connect and every operator set DATA
   * MOD by hand (K3FZT, IC-7760, 2026-09-14).
   */
  getDataMod(settingId) {
    if (!this.connected) return false;
    if (typeof this._codec.getDataMod !== 'function') return this._unsupported('DATA MOD read');
    this._codec.getDataMod(settingId);
    return true;
  }

  setDataMod(settingId, value) {
    if (!this.connected) return false;
    if (typeof this._codec.setDataMod !== 'function') return this._unsupported('DATA MOD write');
    return this._codec.setDataMod(settingId, value) !== false;
  }

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
