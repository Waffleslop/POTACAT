// Hamlib rotctld client — the free, open alternative to PstRotator (KD9WI
// 2026-09-13: "Currently we only support PstRotator, which is paid software").
// rotctld speaks one line-oriented TCP protocol for every rotator Hamlib
// supports (GS-232, SPID, Rotor-EZ, Easycomm, ARS, Prosistel, ~50 models), so
// one client here covers all of them. POTACAT can either START rotctld itself
// (bundled Hamlib, model + serial port from Settings — see buildRotctldArgs)
// or connect to one the operator already runs, on this machine or another.
//
// Protocol facts, captured from rotctld 4.7.0 (the build we bundle), not the
// man page:
//   - Every command is sent in EXTENDED form ("+" prefix), so every reply —
//     including a failure — ends with exactly one "RPRT <n>" line. That is the
//     only framing that holds for all commands: plain "p" answers two bare
//     numbers with no RPRT, plain "P" answers only "RPRT 0".
//   - "+\dump_state" reports the EFFECTIVE azimuth limits — it reflects
//     --set-conf=min_az/max_az — where "\dump_caps" reports the backend's
//     defaults. A rotor stopped at -180..180 (south-centre) must be sent
//     -90, not 270, or rotctld answers RPRT -21 (RIG_ELIMIT) and nothing turns.
//   - "+P <az> <el>" answers promptly; the rotor then moves on its own. The
//     only way to know it arrived is to poll "+p".
//   - A backslash long command must NOT follow "+" as the first two bytes of
//     some commands ("+\dump_caps" parsed as "+\d" = dec2dms). "+\dump_state"
//     and "+\get_info" parse correctly; those are the only long forms used.

'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const DEFAULTS = {
  commandTimeoutMs: 10000,   // a backend waiting on a dead serial line answers RPRT -5 well inside this
  pollIntervalMs: 1000,      // position poll while a rotation is in flight
  stableReads: 3,            // consecutive reads within moveToleranceDeg = stopped
  moveToleranceDeg: 1,
  arriveToleranceDeg: 5,     // within this of the target = arrived
  maxTurnMs: 180000,         // watchdog: a slow rotor doing a full 450 deg takes ~2 min
  reconnectMinMs: 2000,
  reconnectMaxMs: 30000,
};

// Hamlib's rig_errcode_e, negated on the wire (rig.h, 4.7.0).
const HAMLIB_ERRORS = {
  1: 'invalid parameter',
  2: 'invalid configuration (serial port, speed...)',
  3: 'memory shortage',
  4: 'function not implemented',
  5: 'communication timed out — check the rotor controller is powered and on this port',
  6: 'I/O error, including the port failing to open',
  7: 'internal Hamlib error',
  8: 'protocol error',
  9: 'command rejected by the rotor',
  10: 'argument truncated',
  11: 'function not available',
  17: 'argument out of domain',
  20: 'rotor not powered on',
  21: 'position outside the rotor\'s limits',
  22: 'access denied — the port is already in use',
};

function hamlibErrorText(code) {
  const n = Math.abs(Number(code));
  return HAMLIB_ERRORS[n] || `Hamlib error ${n}`;
}

/**
 * Map a compass bearing onto what THIS rotor accepts. Rotors are configured
 * 0..360, -180..180 (south-centre), 0..450 (overlap) and more; a bearing is
 * the same direction as bearing ± 360. Picks the equivalent inside the
 * limits; with overlap (two equivalents both legal) prefers the plain
 * 0..360 one, the direction the operator reads off the spot table.
 * @returns {{az:number}|{error:string}}
 */
function mapAzimuth(bearing, limits) {
  const b = Number(bearing);
  if (!isFinite(b)) return { error: `not a bearing: ${bearing}` };
  const norm = ((b % 360) + 360) % 360;
  // Number.isFinite, not isFinite: a limit rotctld did not report is null,
  // and isFinite(null) is true — that made every bearing "outside 0 to 0".
  const min = limits && Number.isFinite(limits.minAz) ? limits.minAz : 0;
  const max = limits && Number.isFinite(limits.maxAz) ? limits.maxAz : 360;
  for (const cand of [norm, norm - 360, norm + 360, norm - 720]) {
    if (cand >= min - 1e-9 && cand <= max + 1e-9) return { az: Math.round(cand * 10) / 10 };
  }
  return { error: `bearing ${norm}° is outside this rotor's range (${min}° to ${max}°)` };
}

/** Parse "+\dump_state" lines into azimuth/elevation limits (null when absent). */
function parseDumpState(lines) {
  const out = { minAz: null, maxAz: null, minEl: null, maxEl: null, model: null };
  for (const line of lines || []) {
    const m = /^\s*(Minimum|Maximum) (Azimuth|Elevation):\s*(-?[\d.]+)/i.exec(line);
    if (m) {
      const key = (m[1].toLowerCase() === 'minimum' ? 'min' : 'max') + (m[2].toLowerCase() === 'azimuth' ? 'Az' : 'El');
      out[key] = parseFloat(m[3]);
      continue;
    }
    const mm = /^\s*Rotor Model:\s*(\d+)/i.exec(line);
    if (mm) out.model = parseInt(mm[1], 10);
  }
  return out;
}

/** Parse "+p" lines ("Azimuth: 12.00", "Elevation: 0.00"). */
function parsePosition(lines) {
  let az = null, el = null;
  for (const line of lines || []) {
    const a = /^\s*Azimuth:\s*(-?[\d.]+)/i.exec(line);
    if (a) az = parseFloat(a[1]);
    const e = /^\s*Elevation:\s*(-?[\d.]+)/i.exec(line);
    if (e) el = parseFloat(e[1]);
  }
  return az == null ? null : { az, el };
}

/**
 * Parse "rotctld -l" into [{id, mfg, model, status}]. Columns are fixed-width
 * under a header line; a long manufacturer name can leave one space before
 * the model, so split on the header's column positions, not on whitespace.
 */
function parseRotorList(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = lines.find(l => /Rot #/.test(l) && /Mfg/.test(l) && /Model/.test(l));
  if (!header) return [];
  const col = (name) => header.indexOf(name);
  const cMfg = col('Mfg'), cModel = col('Model'), cVer = col('Version'), cStatus = col('Status'), cMacro = col('Macro');
  const out = [];
  for (const line of lines) {
    const id = /^\s*(\d+)\s/.exec(line);
    if (!id || line === header) continue;
    out.push({
      id: parseInt(id[1], 10),
      mfg: line.slice(cMfg, cModel).trim(),
      model: line.slice(cModel, cVer).trim(),
      status: (cMacro > cStatus ? line.slice(cStatus, cMacro) : line.slice(cStatus)).trim(),
    });
  }
  return out;
}

/**
 * Arguments for a rotctld POTACAT launches itself. Listens on 127.0.0.1 only:
 * rotctld has no authentication, and anything that can reach the port can
 * turn the antenna.
 */
function buildRotctldArgs({ model, device, baud, port, conf }) {
  const args = ['-m', String(model), '-T', '127.0.0.1', '-t', String(port || 4533)];
  // Network backends (NET rotctl, PstRotator) take host:port as their "device";
  // the Dummy rotor needs none.
  if (device) args.push('-r', String(device));
  if (device && baud) args.push('-s', String(baud));
  if (conf && String(conf).trim()) args.push('--set-conf=' + String(conf).trim());
  return args;
}

class RotctldClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._opts = { ...DEFAULTS, ...opts };
    this._host = '127.0.0.1';
    this._port = 4533;
    this._sock = null;
    this.connected = false;
    this._closing = true;

    this.limits = null;          // from +\dump_state
    this.bearing = null;         // last read azimuth
    this.elevation = null;
    this.info = '';

    this._buf = '';
    this._queue = [];            // [{cmd, resolve, reject}]
    this._inflight = null;       // {cmd, lines, resolve, reject, timer}

    this._target = null;         // azimuth of the rotation in flight
    this._pendingBearing = null; // newest bearing requested while a set is in flight
    this._setting = false;
    this._pollTimer = null;
    this._turnStartedAt = 0;
    this._lastRead = null;
    this._stableCount = 0;

    this._reconnectTimer = null;
    this._reconnectDelay = this._opts.reconnectMinMs;
    this._failLogged = false;
  }

  /**
   * @param {object} o
   *   graceMs  refusals inside this window are not logged — a rotctld POTACAT
   *            has just started takes a moment to listen, and "no answer"
   *            at launch would read as a fault
   */
  connect({ host, port, graceMs = 0 } = {}) {
    this.disconnect();
    this._graceUntil = Date.now() + graceMs;
    this._host = host || '127.0.0.1';
    this._port = parseInt(port, 10) || 4533;
    this._closing = false;
    this._reconnectDelay = this._opts.reconnectMinMs;
    this._failLogged = false;
    this._open();
  }

  disconnect() {
    this._closing = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopPolling();
    this._teardownSocket(new Error('disconnected'));
    this._target = null;
    this._pendingBearing = null;
    this._setting = false;
  }

  get endpoint() { return `${this._host}:${this._port}`; }

  _open() {
    const sock = net.connect({ host: this._host, port: this._port });
    this._sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.on('connect', () => this._onConnect(sock));
    sock.on('data', (d) => { if (this._sock === sock) this._onData(d); });
    sock.on('error', (err) => {
      if (this._sock !== sock) return;
      if (!this.connected && !this._failLogged && Date.now() >= (this._graceUntil || 0)) {
        this._failLogged = true;
        this.emit('log', `[rotctld] no answer at ${this.endpoint} (${err.code || err.message}) — retrying until it does`);
      } else if (this.connected) {
        this.emit('log', `[rotctld] connection to ${this.endpoint} failed: ${err.code || err.message}`);
      }
    });
    sock.on('close', () => {
      if (this._sock !== sock) return;
      const was = this.connected;
      this._teardownSocket(new Error('connection closed'));
      if (was) {
        this.emit('log', `[rotctld] connection to ${this.endpoint} closed — reconnecting`);
        this.emit('status', { connected: false });
      }
      this._scheduleReconnect();
    });
  }

  _teardownSocket(err) {
    const sock = this._sock;
    this._sock = null;
    this.connected = false;
    this._buf = '';
    if (this._inflight) {
      clearTimeout(this._inflight.timer);
      this._inflight.reject(err);
      this._inflight = null;
    }
    for (const q of this._queue.splice(0)) q.reject(err);
    if (sock) { try { sock.removeAllListeners('data'); sock.destroy(); } catch {} }
  }

  _scheduleReconnect() {
    if (this._closing || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._opts.reconnectMaxMs);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closing) this._open();
    }, delay);
  }

  async _onConnect(sock) {
    if (this._sock !== sock) return;
    this.connected = true;
    this._failLogged = false;
    this._reconnectDelay = this._opts.reconnectMinMs;
    try {
      const st = await this._command('+\\dump_state');
      this.limits = parseDumpState(st.lines);
    } catch (err) {
      this.limits = null;
      this.emit('log', `[rotctld] could not read the rotor's limits (${err.message}) — assuming 0-360°`);
    }
    try {
      const info = await this._command('+\\get_info');
      if (info.code === 0) this.info = (info.lines.find(l => /^Info:/i.test(l)) || '').replace(/^Info:\s*/i, '').trim();
    } catch {}
    if (this._sock !== sock) return;
    const lim = this.limits && Number.isFinite(this.limits.minAz) && Number.isFinite(this.limits.maxAz) ? `, azimuth ${this.limits.minAz}° to ${this.limits.maxAz}°` : '';
    this.emit('log', `[rotctld] connected to ${this.endpoint}${this.info ? ' — ' + this.info : ''}${lim}`);
    this.emit('status', { connected: true, limits: this.limits });
    await this.readPosition().catch(() => {});
    // A bearing requested while we were down goes out now.
    if (this._pendingBearing != null) this._pump();
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).replace(/\r$/, '');
      this._buf = this._buf.slice(nl + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    const cur = this._inflight;
    if (!cur) return; // stray output (none expected in extended mode)
    const m = /^RPRT\s+(-?\d+)/.exec(line);
    if (!m) { cur.lines.push(line); return; }
    clearTimeout(cur.timer);
    this._inflight = null;
    cur.resolve({ code: parseInt(m[1], 10), lines: cur.lines });
    this._sendNext();
  }

  /** Queue one extended command; resolves {code, lines}. */
  _command(cmd) {
    return new Promise((resolve, reject) => {
      if (!this._sock || !this.connected) { reject(new Error('not connected')); return; }
      this._queue.push({ cmd, resolve, reject });
      if (!this._inflight) this._sendNext();
    });
  }

  _sendNext() {
    if (this._inflight || !this._queue.length || !this._sock) return;
    const q = this._queue.shift();
    const cur = { ...q, lines: [], timer: null };
    cur.timer = setTimeout(() => {
      if (this._inflight !== cur) return;
      this.emit('log', `[rotctld] "${q.cmd}" got no reply in ${Math.round(this._opts.commandTimeoutMs / 1000)} s — reconnecting`);
      const sock = this._sock;
      this._teardownSocket(new Error('command timed out'));
      if (sock) this.emit('status', { connected: false });
      this._scheduleReconnect();
    }, this._opts.commandTimeoutMs);
    this._inflight = cur;
    try { this._sock.write(q.cmd + '\n'); } catch (err) { /* close handler cleans up */ }
  }

  /** Read the current position; updates .bearing/.elevation. */
  async readPosition() {
    const r = await this._command('+p');
    if (r.code !== 0) throw new Error(hamlibErrorText(r.code));
    const pos = parsePosition(r.lines);
    if (pos) {
      this.bearing = pos.az;
      this.elevation = pos.el;
      this.emit('position', pos);
    }
    return pos;
  }

  /**
   * Turn to a compass bearing. Rapid QSYs coalesce: only the newest bearing
   * requested while a set is on the wire goes out after it.
   */
  rotate(bearing) {
    this._pendingBearing = bearing;
    if (this.connected) this._pump();
    else this.emit('log', `[rotctld] not connected to ${this.endpoint} — will turn to ${Math.round(bearing)}° once it answers`);
  }

  async _pump() {
    if (this._setting || this._pendingBearing == null || !this.connected) return;
    const bearing = this._pendingBearing;
    this._pendingBearing = null;
    const mapped = mapAzimuth(bearing, this.limits);
    if (mapped.error) {
      this.emit('log', `[rotctld] not turning: ${mapped.error}`);
      return;
    }
    this._setting = true;
    // Elevation: keep whatever the rotor reports (az-only rotors ignore it;
    // an az/el rotor is not tipped to the horizon by an HF QSY).
    let el = this.elevation != null && isFinite(this.elevation) ? this.elevation : 0;
    if (this.limits && Number.isFinite(this.limits.minEl) && Number.isFinite(this.limits.maxEl)) el = Math.max(this.limits.minEl, Math.min(this.limits.maxEl, el));
    try {
      const r = await this._command(`+P ${mapped.az} ${el}`);
      if (r.code !== 0) {
        this.emit('log', `[rotctld] turn to ${mapped.az}° refused: RPRT ${r.code} (${hamlibErrorText(r.code)})`);
      } else {
        const compass = Math.round(((Number(bearing) % 360) + 360) % 360);
        this.emit('log', `[rotctld] turning to ${mapped.az}°${Math.round(mapped.az) !== compass ? ` (bearing ${compass}° on this rotor's scale)` : ''}`);
        this._target = mapped.az;
        this._turnStartedAt = Date.now();
        this._lastRead = null;
        this._stableCount = 0;
        this._startAz = null;
        this._moved = false;
        this._startPolling();
      }
    } catch (err) {
      this.emit('log', `[rotctld] turn to ${mapped.az}° failed: ${err.message}`);
    } finally {
      this._setting = false;
    }
    if (this._pendingBearing != null) this._pump();
  }

  /** Stop the rotor now. */
  async stop() {
    this._pendingBearing = null;
    this._stopPolling();
    this._target = null;
    try {
      const r = await this._command('+S');
      if (r.code !== 0) this.emit('log', `[rotctld] stop refused: RPRT ${r.code} (${hamlibErrorText(r.code)})`);
    } catch (err) {
      this.emit('log', `[rotctld] stop failed: ${err.message}`);
    }
  }

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._pollTick(), this._opts.pollIntervalMs);
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async _pollTick() {
    if (this._target == null || !this.connected || this._inflight || this._queue.length) return;
    let pos;
    try { pos = await this.readPosition(); } catch { return; }
    if (!pos || this._target == null) return;
    const target = this._target;
    if (this._lastRead != null && Math.abs(pos.az - this._lastRead) <= this._opts.moveToleranceDeg) this._stableCount++;
    else this._stableCount = 0;
    if (this._startAz == null) this._startAz = pos.az;
    if (Math.abs(pos.az - this._startAz) > this._opts.moveToleranceDeg) this._moved = true;
    this._lastRead = pos.az;
    const arrived = Math.abs(pos.az - target) <= this._opts.arriveToleranceDeg;
    const timedOut = Date.now() - this._turnStartedAt > this._opts.maxTurnMs;
    // Arrived and still = done. Still but NOT arrived only counts once the
    // rotor has moved and then stalled for a while: many controllers sit for
    // a few seconds (brake release, soft start) before the first degree, and
    // that pause is not a failure.
    const stalled = this._moved && this._stableCount >= this._opts.stableReads * 3;
    if ((arrived && this._stableCount >= this._opts.stableReads) || stalled || timedOut) {
      this._stopPolling();
      this._target = null;
      this.emit('settled', { bearing: pos.az, target, arrived, timedOut });
    }
  }
}

module.exports = {
  RotctldClient,
  mapAzimuth,
  parseDumpState,
  parsePosition,
  parseRotorList,
  buildRotctldArgs,
  hamlibErrorText,
};
