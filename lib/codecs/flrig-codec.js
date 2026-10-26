'use strict';
/**
 * FlrigCodec — the rig-controller codec contract over flrig's XML-RPC API.
 *
 * flrig (W1HKJ) holds the radio and several programs share it; POTACAT is one
 * client (lib/flrig-transport.js carries the calls). Everything POTACAT sends
 * is a flrig method — never a brand CAT command — so the operator's Radio
 * Model only supplies caps, bands, power limits and presets (flrigModel()).
 *
 * Method semantics come from flrig 2.0.12 src/server/xml_server.cxx (read
 * 2026-10-25), not from memory:
 *   rig.get_vfo        -> "14020700" (Hz, string); "14070000" while the xcvr is OFFLINE
 *   rig.set_vfo        <- double Hz (an i4 is a type error on flrig's side)
 *   rig.get_mode       -> the RADIO's mode name ("DATA-U", "USB-D", "CW-U"...); "USB" offline
 *   rig.set_mode       <- that same name; a name not in rig.get_modes is silently ignored
 *   rig.get_modes      -> array of the radio's mode names
 *   rig.get_ptt/set_ptt   i4 0|1 (set waits up to 1 s for the radio to confirm)
 *   rig.get_AB/set_AB     "A"|"B"
 *   rig.get_split/set_split  i4
 *   rig.get_DBM        -> S-meter in dBm as a string (S9 = -73); "0" offline, during PTT, or no meter
 *   rig.get_SWR        -> true ratio "1.5" (flrig's own table); "0" when the rig has no SWR meter
 *   rig.get_pwrmeter   -> watts (string) on most rigs; flrig's UI divides by rig.get_pwrmeter_scale
 *   rig.get_power/set_power  watts (i4) — the power SETTING
 *   rig.get_rfgain/set_rfgain  0..100 (get i4, set DOUBLE)
 *   rig.get_volume/set_volume  0..100 i4
 *   rig.tune           -> starts the radio's tuner (what flrig's TUNE button does)
 *   rig.get_xcvr       -> transceiver name, "" offline;  main.get_version -> "2.0.12"
 * An unknown method is a <fault> "…: unknown method name". Replies come back
 * strictly in call order, so a FIFO of what was asked attributes each one.
 */
const { EventEmitter } = require('events');
const { encodeCall, decodeResponse, i4, dbl, str } = require('../xmlrpc');

function ssbSideband(freqHz) {
  if (freqHz >= 5250000 && freqHz < 5450000) return 'USB';
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

// POTACAT mode -> the radio names flrig may list for it, most specific first.
// Resolved against rig.get_modes at connect; the FIRST entry is the fallback
// before the list has arrived. Yaesu says DATA-U, Icom/Kenwood USB-D,
// Elecraft DATA, TS-2000-era PKT-U, some Icoms USB-D1 (hamlib's flrig
// backend keeps a table like this; the names below are from flrig's own
// rig drivers, src/rigs/*/*.cxx).
const MODE_CANDIDATES = {
  USB: ['USB'],
  LSB: ['LSB'],
  CW: ['CW', 'CW-U', 'CWU'],
  CWR: ['CW-R', 'CW-L', 'CWR', 'CWL'],
  AM: ['AM', 'AM-N', 'SAM'],
  FM: ['FM', 'FM-N', 'NFM', 'WFM'],
  RTTY: ['RTTY', 'RTTY-L', 'FSK', 'RTTY-U'],
  RTTYR: ['RTTY-R', 'RTTY-U', 'FSK-R', 'RTTY'],
  PKTUSB: ['USB-D', 'DATA-U', 'PKT-U', 'DIGU', 'DATA', 'USB-D1', 'USB-D2', 'USB-D3', 'PSK-U', 'PSK', 'DIG', 'PKT', 'USB'],
  PKTLSB: ['LSB-D', 'DATA-L', 'PKT-L', 'DIGL', 'LSB-D1', 'LSB-D2', 'LSB-D3', 'DATA-R', 'PSK-L', 'LSB'],
  PKTFM: ['FM-D', 'DATA-FM', 'PKT-FM', 'DATA-FMN', 'FM'],
};
// POTACAT's requested names -> the family above.
const REQUEST_TO_FAMILY = {
  USB: 'USB', LSB: 'LSB', CW: 'CW', CWR: 'CWR', 'CW-R': 'CWR', AM: 'AM', FM: 'FM',
  RTTY: 'RTTY', RTTYR: 'RTTYR', 'RTTY-R': 'RTTYR',
  DIGU: 'PKTUSB', PKTUSB: 'PKTUSB', 'USB-D': 'PKTUSB', 'DATA-U': 'PKTUSB', DATA: 'PKTUSB',
  FT8: 'PKTUSB', FT4: 'PKTUSB', FT2: 'PKTUSB', JS8: 'PKTUSB', WSPR: 'PKTUSB', JTTY: 'PKTUSB',
  DIGL: 'PKTLSB', PKTLSB: 'PKTLSB', 'LSB-D': 'PKTLSB', 'DATA-L': 'PKTLSB',
  PKTFM: 'PKTFM', 'FM-D': 'PKTFM', DATAFM: 'PKTFM',
};

/** The radio's mode name -> the token the rest of POTACAT reads (hamlib's vocabulary, as the rigctld codec emits). */
function normalizeRadioMode(name) {
  const m = String(name || '').trim().toUpperCase();
  if (!m) return '';
  if (m === 'USB' || m === 'LSB' || m === 'AM' || m === 'FM') return m;
  if (/^(CW|CW-U|CWU)$/.test(m)) return 'CW';
  if (/^(CW-R|CW-L|CWR|CWL)$/.test(m)) return 'CWR';
  if (/^(AM-N|SAM|DSB)$/.test(m)) return 'AM';
  if (/^(FM-N|NFM|WFM)$/.test(m)) return 'FM';
  if (/^(RTTY|RTTY-L|FSK)$/.test(m)) return 'RTTY';
  if (/^(RTTY-R|RTTY-U|FSK-R)$/.test(m)) return 'RTTYR';
  if (/^(USB-D\d?|DATA-U|PKT-U|DIGU|DATA|PKTUSB|PSK|PSK-U|DIG|PKT)$/.test(m)) return 'PKTUSB';
  if (/^(LSB-D\d?|DATA-L|PKT-L|DIGL|PKTLSB|DATA-R|PSK-L)$/.test(m)) return 'PKTLSB';
  if (/^(FM-D|DATA-FM|PKT-FM|DATA-FMN|PKTFM)$/.test(m)) return 'PKTFM';
  return m;
}

/** S-meter dBm -> the Flex-style 0..255 scale every client draws (S9 = 120). Null when flrig has no reading. */
function smeterFromDbm(dbm) {
  const v = Number(dbm);
  if (!Number.isFinite(v) || v === 0) return null; // "0" is flrig's no-reading answer (offline, keyed, no meter)
  // hamlib STRENGTH is dB over S9 and the rigctld codec maps (dB + 54) * 255 / 114; S9 = -73 dBm.
  return Math.max(0, Math.min(255, Math.round((v + 73 + 54) * 255 / 114)));
}

/** SWR ratio -> the 0..255 scale (ratio = 1 + raw/60). */
function swrFromRatio(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r < 1) return null;
  return Math.max(0, Math.min(255, Math.round((r - 1) * 60)));
}

const PENDING_MAX = 64;
const PENDING_TTL_MS = 8000;

class FlrigCodec extends EventEmitter {
  /**
   * @param {object} model rig model (flrigModel() output)
   * @param {function} writeFn writes an XML <methodCall> to the transport
   */
  constructor(model, writeFn) {
    super();
    this._model = model || {};
    this._writeFn = writeFn;
    this._pending = [];           // [{ kind, at, arg }]
    this._radioModes = null;      // from rig.get_modes
    this._xcvr = null;            // transceiver name, '' while offline
    this._offlineSaid = false;
    this._unsupported = new Set();// METHODS latched off after an unknown-method fault
    this._offered = null;         // Set from system.listMethods, null = not known
    this._probeRestSent = false;
    this._probeTimer = null;
    this._saidOnce = new Set();
    this._lastMode = null;        // normalized token last reported
    this._lastRadioMode = null;   // the radio's own name last reported
    this._lastFreqHz = 0;
    this._pwrScale = 1;
    this._pwrRawSaid = false;
    this._minPower = this._model.minPower || 1;
    this._maxPower = this._model.maxPower || 100;
    this.maxPowerReported = null;
    this.version = null;
  }

  // --- plumbing ---

  _call(kind, method, params, arg) {
    // Per METHOD, never per kind: every setter shares kind 'set', so latching
    // the kind let one missing setter on a bridge switch off tune, PTT and mode.
    if (this._unsupported.has(method)) return false;
    if (this._offered && !this._offered.has(method) && !method.startsWith('system.')) {
      this._unsupported.add(method);
      this._once('unoffered:' + method, `flrig does not list ${method} in system.listMethods — not asked for this connection`);
      return false;
    }
    const now = Date.now();
    this._pending = this._pending.filter((p) => now - p.at < PENDING_TTL_MS);
    if (this._pending.length >= PENDING_MAX) this._pending.shift();
    this._pending.push({ kind, at: now, arg, method });
    this._writeFn(encodeCall(method, params));
    return true;
  }

  _once(key, msg) {
    if (this._saidOnce.has(key)) return;
    this._saidOnce.add(key);
    this.emit('log', msg);
  }

  /** Transport data: one XML <methodResponse> body per event. */
  onData(chunk) {
    const body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const p = this._pending.shift();
    const r = decodeResponse(body); // never throws: an unreadable reply is a fault
    if (!p) {
      this.emit('log', `flrig: reply with nothing asked (${body.length} bytes)`);
      return;
    }
    if (!r.ok) {
      this._onFault(p, r.fault);
      return;
    }
    try { this._handle(p, r.value); } catch (e) { this.emit('log', `flrig: ${p.method} reply "${String(r.value).slice(0, 40)}" — ${e.message}`); }
  }

  _onFault(p, fault) {
    const txt = fault.string || 'fault';
    if (p.kind === 'methods') {
      // No introspection on this server: ask for everything, as before.
      this._once('methods-fault', `flrig: system.listMethods not answered (${txt}) — every method will be tried`);
      this._probeRest();
      return;
    }
    // flrig says "unknown method"; Python's xmlrpc.server says 'method "x" is
    // not supported'; -32601 is the spec's method-not-found code.
    if (/unknown method|not supported|not found|no such method/i.test(txt) || fault.code === -32601) {
      // An older flrig (or a bridge) without this method: stop asking, say so once.
      this._unsupported.add(p.method);
      this._once('fault:' + p.kind, `flrig does not have ${p.method} (${txt}) — ${p.kind === 'set' ? 'that control' : 'that readback'} is off for this connection`);
      return;
    }
    this._once('fault:' + p.method + ':' + txt, `flrig refused ${p.method}: ${txt}`);
  }

  _handle(p, v) {
    switch (p.kind) {
      case 'methods': {
        const list = Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
        // Only trust a list that names flrig's own core: a server answering
        // something unrelated must not switch every method off.
        if (list.includes('rig.get_vfo')) {
          this._offered = new Set(list);
          this.emit('log', `flrig offers ${list.length} methods`);
        } else {
          this._once('methods-odd', 'flrig: system.listMethods did not list rig.get_vfo — every method will be tried');
        }
        this._probeRest();
        break;
      }
      case 'version':
        this.version = String(v || '');
        break;
      case 'xcvr': {
        const name = String(v || '');
        const was = this._xcvr;
        this._xcvr = name;
        if (!name) {
          if (!this._offlineSaid) {
            this._offlineSaid = true;
            this.emit('log', `flrig ${this.version || ''} is running but its transceiver is OFFLINE — frequency and mode are flrig's placeholders until it connects to the radio (flrig: Config > Setup > Transceiver, then Init)`);
          }
        } else if (was !== name) {
          this._offlineSaid = false;
          this.emit('log', `flrig ${this.version || ''} holds the radio: ${name}`);
        }
        break;
      }
      case 'modes': {
        const list = Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
        if (list.length) {
          this._radioModes = list;
          this.emit('log', `flrig modes: ${list.join(' ')}`);
        }
        break;
      }
      case 'maxpwr': {
        const w = parseInt(String(v), 10);
        if (w > 0) this.maxPowerReported = w;
        break;
      }
      case 'pwrscale': {
        const s = parseFloat(String(v));
        if (s > 0) this._pwrScale = s;
        break;
      }
      case 'freq': {
        if (this._xcvr === '') return; // offline placeholder 14070000
        const hz = parseInt(String(v), 10);
        if (!(hz > 0)) return;
        this._lastFreqHz = hz;
        this.emit('frequency', hz);
        break;
      }
      case 'mode': {
        if (this._xcvr === '') return; // offline placeholder "USB"
        const raw = String(v || '').trim();
        if (!raw) return;
        const tok = normalizeRadioMode(raw);
        if (raw !== this._lastRadioMode) this.emit('log', `flrig mode ${raw} -> ${tok}`);
        this._lastRadioMode = raw;
        this._lastMode = tok;
        this.emit('mode', tok);
        break;
      }
      case 'ptt': {
        const on = String(v) === '1' || v === 1 || v === true;
        this.emit('ptt', on);
        break;
      }
      case 'ab': {
        const s = String(v || '').toUpperCase();
        if (s === 'A' || s === 'B') this.emit('vfo', s);
        break;
      }
      case 'split':
        this.emit('split', String(v) === '1' || v === 1 || v === true);
        break;
      case 'smeter': {
        const val = smeterFromDbm(String(v));
        if (val != null) this.emit('smeter', val);
        break;
      }
      case 'swr': {
        const val = swrFromRatio(String(v));
        if (val != null) this.emit('swr', val);
        break;
      }
      case 'pwrmeter': {
        const raw = parseFloat(String(v));
        if (!Number.isFinite(raw)) return;
        const watts = this._pwrScale > 1 ? raw / this._pwrScale : raw;
        if (raw > 0 && !this._pwrRawSaid) {
          this._pwrRawSaid = true;
          this.emit('log', `flrig power meter: raw ${raw}, scale ${this._pwrScale} -> ${watts.toFixed(1)} W (first reading this connection)`);
        }
        this.emit('powerMeter', Math.max(0, watts));
        break;
      }
      case 'power': {
        const w = parseInt(String(v), 10);
        if (Number.isFinite(w) && w >= 0) this.emit('power', w);
        break;
      }
      case 'rfgain': {
        const n = parseInt(String(v), 10);
        if (Number.isFinite(n)) this.emit('rfgain', Math.max(0, Math.min(100, n)));
        break;
      }
      case 'afgain': {
        const n = parseInt(String(v), 10);
        if (Number.isFinite(n)) this.emit('afgain', Math.max(0, Math.min(100, n)));
        break;
      }
      case 'set':
      default:
        break;
    }
  }

  // --- the controller contract: reads ---

  /** At connect, before the safety PTT-off: who is there and what it holds. */
  probeCaps() {
    this._radioModes = null;
    this._xcvr = null;
    this._offlineSaid = false;
    this._unsupported.clear();
    this._offered = null;
    this._probeRestSent = false;
    // Ask what the server offers first (WG9I's suggestion: a homebrew bridge
    // offers a few methods and faults on the rest). The rest of the probe goes
    // out on the answer, on a fault, or after 3 s of silence.
    this._call('methods', 'system.listMethods', []);
    clearTimeout(this._probeTimer);
    this._probeTimer = setTimeout(() => this._probeRest(), 3000);
    if (this._probeTimer.unref) this._probeTimer.unref();
  }

  _probeRest() {
    clearTimeout(this._probeTimer);
    if (this._probeRestSent) return;
    this._probeRestSent = true;
    this._call('version', 'main.get_version', []);
    this._call('xcvr', 'rig.get_xcvr', []);
    this._call('modes', 'rig.get_modes', []);
    this._call('maxpwr', 'rig.get_maxpwr', []);
    this._call('pwrscale', 'rig.get_pwrmeter_scale', []);
  }

  getFrequency() {
    this._call('freq', 'rig.get_vfo', []);
    // Every ~10 s: the transceiver can go offline/online under flrig while
    // POTACAT stays attached, and offline turns rig.get_vfo into a placeholder.
    this._freqPolls = (this._freqPolls || 0) + 1;
    if (this._freqPolls % 10 === 0) this.getXcvr();
  }
  getMode() { this._call('mode', 'rig.get_mode', []); }
  getPtt() { this._call('ptt', 'rig.get_ptt', []); }
  getVfoSplit() {
    this._call('ab', 'rig.get_AB', []);
    this._call('split', 'rig.get_split', []);
  }
  getSmeter() { this._call('smeter', 'rig.get_DBM', []); }
  getSwr() { this._call('swr', 'rig.get_SWR', []); }
  // flrig has no ALC readback.
  getPowerMeter() { this._call('pwrmeter', 'rig.get_pwrmeter', []); }
  getPower() { this._call('power', 'rig.get_power', []); }
  getRfGain() { this._call('rfgain', 'rig.get_rfgain', []); }
  getAfGain() { this._call('afgain', 'rig.get_volume', []); }
  /** Slow-cycle: the transceiver can go offline/online under flrig while we are attached. */
  getXcvr() { this._call('xcvr', 'rig.get_xcvr', []); }

  // --- writes ---

  setFrequency(hz) {
    const f = Math.round(Number(hz) || 0);
    if (!(f > 0)) return;
    this._call('set', 'rig.set_vfo', [dbl(f)]);
  }

  /** @returns {string|null} the hamlib-style token sent (what the controller logs) */
  setMode(modeName, freqHz) {
    const token = this.resolveMode(modeName, freqHz);
    if (!token) return null;
    const radioName = this.radioModeFor(token);
    if (!radioName) {
      this._once('nomode:' + token, `flrig: ${this._xcvr || 'the radio'} lists no mode for ${token} (has: ${(this._radioModes || []).join(' ') || 'unknown'}) — mode not sent`);
      return null;
    }
    this._call('set', 'rig.set_mode', [str(radioName)]);
    this._lastMode = token;
    return token;
  }

  /** POTACAT mode name -> hamlib-style token (what setMode will send a radio name for). */
  resolveMode(modeName, freqHz) {
    let m = String(modeName || '').toUpperCase();
    if (!m) return null;
    if (m === 'SSB') m = ssbSideband(freqHz || this._lastFreqHz || 0);
    if (m.startsWith('PSK')) m = 'PKTUSB';
    const fam = REQUEST_TO_FAMILY[m];
    if (fam) return fam;
    // Already one of the radio's own names? Pass it through.
    if (this._radioModes && this._radioModes.some((x) => x.toUpperCase() === m)) return normalizeRadioMode(m);
    return null;
  }

  /** The radio's own name for a token, chosen from rig.get_modes (or the first candidate before it arrives). */
  radioModeFor(token) {
    // A radio name given directly (resolveMode passed it through).
    const cands = MODE_CANDIDATES[token] || [token];
    if (!this._radioModes) return cands[0];
    const have = new Map(this._radioModes.map((x) => [x.toUpperCase(), x]));
    for (const c of cands) if (have.has(c.toUpperCase())) return have.get(c.toUpperCase());
    // Loose match: anything the radio lists that normalizes to this token.
    for (const x of this._radioModes) if (normalizeRadioMode(x) === token) return x;
    return null;
  }

  setTransmit(on) {
    this.emit('log', `PTT write: rig.set_ptt ${on ? 1 : 0}`);
    this._call('set', 'rig.set_ptt', [i4(on ? 1 : 0)]);
  }

  setVfo(vfo) {
    const v = String(vfo || '').toUpperCase() === 'B' ? 'B' : 'A';
    this._call('set', 'rig.set_AB', [str(v)]);
  }

  setSplit(on) { this._call('set', 'rig.set_split', [i4(on ? 1 : 0)]); }

  setTxPower(watts) {
    const cap = this.maxPowerReported || this._maxPower;
    const w = Math.max(this._minPower, Math.min(cap, Math.round(Number(watts) || 0)));
    this._call('set', 'rig.set_power', [i4(w)]);
  }

  /** @param {number} pct 0..100 */
  setRfGain(pct) {
    const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    this._call('set', 'rig.set_rfgain', [dbl(n)]); // flrig casts this one as a double
  }

  /** @param {number} pct 0..100 (the radio's AF / volume) */
  setAfGain(pct) {
    const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    this._call('set', 'rig.set_volume', [i4(n)]);
  }

  setMicGain(pct) {
    const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    this._call('set', 'rig.set_micgain', [i4(n)]);
  }

  // The radio's tuner, as flrig's own TUNE button. No readback and no stop.
  getAtuStartSequence() { return null; }
  getAtuStopCmd() { return null; }
  startTune() { this._call('set', 'rig.tune', []); }
  stopTune() { this._once('atu-stop', 'flrig: the tuner cannot be stopped from here (rig.tune only starts it)'); }

  // Not in flrig's API: say so once, never throw.
  setFilterWidth() { this._once('filter', 'flrig: filter width is set in flrig itself (POTACAT sends no bandwidth over this link)'); return false; }
  setNb() { this._once('nb', 'flrig: noise blanker is not controllable over this link'); return false; }
  setSquelch() { this._once('sql', 'flrig: squelch is not controllable over this link'); return false; }
  setPowerState(on) { this._once('pwrstate', `flrig: power ${on ? 'on' : 'off'} is not available over this link`); return false; }
  setCwSpeed() { this._once('cwspeed', 'flrig: CW speed is not set over this link'); return false; }
  sendRaw() { this._once('raw', 'flrig: raw CAT passthrough is not sent over this link yet'); return false; }
}

/**
 * The model POTACAT runs an flrig rig with: the operator's picked radio (or
 * the generic flrig entry) for bands / power limits / presets, with the
 * protocol and caps pinned to what this codec can do. Pure.
 */
function flrigModel(base) {
  const b = base || {};
  return {
    ...b,
    brand: b.brand || 'flrig',
    protocol: 'flrig',
    caps: {
      nb: false, atu: true, vfo: true, split: true, filter: false, filterType: 'none',
      rfgain: true, txpower: true, power: false, squelch: false, afgain: true, micGain: true,
      preamp: false, att: false, comp: false, nr: false, anf: false, vox: false, agc: false, rit: false,
    },
    cw: { text: false, textChunk: 0, speed: false, paddleKey: false, dtrPins: null, taKey: false, breakIn: false },
    atuCmd: false,
    noSwr: false,
    maxPower: b.maxPower || 100,
    minPower: b.minPower || 1,
    // flrig applies the mode the radio way; one mode after the frequency is enough.
    tune: { modeBeforeFreq: false, modeAfterFreq: true, freqAfterMode: false, alwaysResendMode: false, daCommand: false },
  };
}

module.exports = { FlrigCodec, flrigModel, normalizeRadioMode, smeterFromDbm, swrFromRatio, MODE_CANDIDATES, REQUEST_TO_FAMILY };
