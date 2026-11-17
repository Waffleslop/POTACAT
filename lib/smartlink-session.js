// SPDX-License-Identifier: Apache-2.0
/**
 * POTACAT's FlexRadio SmartLink client: sign-in tokens, the SmartLink server
 * session, and the radio connection handed to SmartSdrClient as a transport
 * (lib/flex-transport.js).
 *
 * Implemented from FlexRadio's SmartLink API reference (cited by part below) and
 * corrected by POTACAT's own capture against an 8600M on v4.2.20 (2026-11-17).
 * Where the two differ, the capture wins:
 *   - the radio list names the radio `radio_name` (not nickname) and ends with a
 *     trailing '|' (an empty entry, dropped here);
 *   - `wan validate` must be a NUMBERED command, `C1|wan validate handle=...`,
 *     answered `R1|0|`. Sent bare, the radio answers the next command 50000021
 *     and drops the connection;
 *   - the radio licenses one GUI client: a second `client gui` is refused
 *     F3000001, and a non-GUI client is refused audio (500000AA);
 *   - a second `application connect` for the same radio is not granted.
 * The client ID is the one secret; it is passed in, never read or logged here
 * (lib/smartlink-config.js). Tokens, handles, the account and its user id are
 * never logged either: redact() is applied to every line this module logs.
 *
 * Pure: sockets, HTTPS, timers and the clock are injected, so the whole flow runs
 * against a fake server and a fake radio in test/smartlink-session-test.js.
 */
'use strict';

const { EventEmitter } = require('events');
const FlexTransport = require('./flex-transport');

// Part 1 (sign-in): FlexRadio's Auth0 tenant, implicit flow, its /mobile redirect.
const AUTH_DOMAIN = 'frtest.auth0.com';
const REDIRECT_URI = 'https://frtest.auth0.com/mobile';
const LOGIN_SCOPE = 'openid offline_access email given_name family_name picture';
const REFRESH_SCOPE = 'openid email given_name family_name picture';
// Part 2 (server).
const SERVER_HOST = 'smartlink.flexradio.com';
const SERVER_PORT = 443;
// "Timeouts and Constants".
const TIMEOUTS = {
  serverTlsMs: 10000,
  radioListMs: 15000,
  keepAliveMs: 10000,
  connectReadyMs: 15000,
  radioTlsMs: 10000,
  wanValidateMs: 10000,
  testUdpMs: 5000,
  testConnectionMs: 10000,
};

// What the operator reads for each failure (the mobile plan's table, with
// "FlexRadio SmartLink" spelled out as the wording rule asks).
const TEXT = {
  'not-configured': 'SmartLink is not available in this build.',
  'signed-out': 'Sign in to your FlexRadio account first (Settings > My Rigs).',
  'sign-in': 'Sign in to your FlexRadio account again.',
  'radio-offline': 'Your radio is not online with FlexRadio SmartLink. Is it powered on and connected to the internet?',
  'server-timeout': 'FlexRadio SmartLink did not answer for your radio. Try again in a minute.',
  'needs-hole-punch': "Your radio has no forwarded or UPnP port, so POTACAT cannot reach it over the internet yet. Forward the radio's ports in your router, or turn on UPnP.",
  'radio-unreachable': "Your radio's internet connection is not accepting connections (router port forward or UPnP).",
  'wan-validate': 'The radio did not accept the FlexRadio SmartLink connection. Try again in a minute.',
  'udp-blocked': "Connected, but your radio's network blocks the audio path.",
  'radio-busy': 'Another program is using the radio, and it allows one at a time. Close that program first.',
  'audio-not-gui': 'The radio sends audio only to the one program operating it, and POTACAT is not that program.',
  'cert-changed': "The radio's security certificate is not the one POTACAT saw before. If you did not reset or replace the radio, check your network.",
};

class SmartLinkError extends Error {
  constructor(code, detail) {
    super(TEXT[code] || code);
    this.name = 'SmartLinkError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

/** Remove everything secret or personal from a line before it is logged. */
function redact(s, extra) {
  let t = String(s == null ? '' : s);
  for (const x of (extra || [])) if (x && String(x).length > 3) t = t.split(String(x)).join('<secret>');
  return t
    .replace(/((?:^|[\s&?#])(?:token|refresh_token|id_token|access_token|client_id|target)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/(handle=)(?!0x[0-9A-F]{8}\b)\S+/gi, '$1<handle>')
    .replace(/auth0\|\S+/gi, '<auth0-user>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<jwt>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/(radio_license_id=)\S+/g, '$1<license>')
    .replace(/(first_name|last_name)=\S*/g, '$1=<name>');
}

// ---------------------------------------------------------------- sign-in (Part 1)

/** FlexRadio's Auth0 authorize URL. `state` is random per sign-in. */
function authorizeUrl({ clientId, state, device = 'POTACAT', loginHint } = {}) {
  if (!clientId) throw new SmartLinkError('not-configured');
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: REDIRECT_URI,
    scope: LOGIN_SCOPE,
    state: state || '',
    device,
  });
  if (loginHint) q.set('login_hint', loginHint);
  return `https://${AUTH_DOMAIN}/authorize?${q}`;
}

/** True when a navigation is the sign-in's final redirect. */
function isRedirect(url) {
  return typeof url === 'string' && url.startsWith(REDIRECT_URI);
}

/**
 * The tokens are in the redirect's URL fragment. Only the refresh token is kept.
 * @returns {{refreshToken:string}|{error:string}}
 */
function parseRedirect(url, expectedState) {
  if (!isRedirect(url)) return { error: 'not the sign-in redirect' };
  const frag = new URLSearchParams(String(url).split('#')[1] || String(url).split('?')[1] || '');
  if (frag.get('error')) return { error: frag.get('error_description') || frag.get('error') };
  if (expectedState != null && frag.get('state') !== expectedState) return { error: 'the sign-in answer did not match this request' };
  const rt = frag.get('refresh_token');
  if (!rt) return { error: 'FlexRadio did not send a refresh token' };
  return { refreshToken: rt };
}

/**
 * A fresh 60-second JWT from the stored refresh token through Auth0's
 * /delegation grant (Part 1, "Refreshing the JWT"). post(url, form) resolves
 * {status, body}. Throws SmartLinkError('sign-in') when the token is refused.
 */
async function refreshJwt({ clientId, refreshToken, post }) {
  if (!clientId) throw new SmartLinkError('not-configured');
  if (!refreshToken) throw new SmartLinkError('signed-out');
  let r;
  try {
    r = await post(`https://${AUTH_DOMAIN}/delegation`, {
      client_id: clientId,
      target: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      refresh_token: refreshToken,
      scope: REFRESH_SCOPE,
    });
  } catch (err) {
    throw new SmartLinkError('server-timeout', 'Auth0 unreachable: ' + (err && err.code || err && err.message));
  }
  let j = null;
  try { j = JSON.parse(r.body); } catch { /* not JSON */ }
  if (r.status === 200 && j && j.id_token) return j.id_token;
  if (r.status >= 500) throw new SmartLinkError('server-timeout', `Auth0 HTTP ${r.status}`);
  throw new SmartLinkError('sign-in', `Auth0 HTTP ${r.status}`);
}

// ------------------------------------------------------------- server lines (Part 2)

/** `key=value key=value` into an object; a value may be empty. */
function parseKv(text) {
  const o = {};
  for (const m of String(text || '').matchAll(/([A-Za-z0-9_]+)=(\S*)/g)) o[m[1]] = m[2];
  return o;
}

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : -1; };
const _list = (v) => (v ? String(v).split(',').filter(Boolean) : []);

/** One radio of the list, in POTACAT's words. */
function normalizeRadio(kv) {
  const programs = _list(kv.gui_client_programs);
  const stations = _list(kv.gui_client_stations);
  const hosts = _list(kv.gui_client_hosts);
  const ips = _list(kv.gui_client_ips);
  const handles = _list(kv.gui_client_handles);
  const n = Math.max(programs.length, stations.length, hosts.length, ips.length, handles.length);
  const guiClients = [];
  for (let i = 0; i < n; i++) {
    guiClients.push({ program: programs[i] || '', station: (stations[i] || '').replace(/_/g, ' '), host: hosts[i] || '', ip: ips[i] || '', handle: handles[i] || '' });
  }
  const name = String(kv.radio_name || kv.nickname || '').replace(/_/g, ' ');
  return {
    serial: kv.serial || '',
    model: kv.model || 'FlexRadio',
    name,
    callsign: kv.callsign || '',
    status: kv.status || '',
    version: kv.version || '',
    publicIp: kv.public_ip || '',
    tlsPort: _num(kv.public_tls_port),
    udpPort: _num(kv.public_udp_port),
    upnpTlsPort: _num(kv.public_upnp_tls_port),
    upnpUdpPort: _num(kv.public_upnp_udp_port),
    upnpSupported: kv.upnp_supported === '1',
    licensedClients: _num(kv.licensed_clients),
    inUseHost: kv.inUseHost || '',
    guiClients,
  };
}

/** `radio list ...|...|` into radios. The list ends with '|': the empty entry is dropped. */
function parseRadioList(line) {
  const body = String(line || '').replace(/^radio list\s?/, '');
  return body.split('|').map((s) => s.trim()).filter((s) => /\bserial=\S/.test(s)).map((s) => normalizeRadio(parseKv(s)));
}

/** Forwarded ports first, then UPnP (Part 2). null: neither, a hole punch would be needed. */
function choosePorts(radio) {
  if (!radio) return null;
  if (radio.tlsPort > 0 && radio.udpPort > 0) return { tls: radio.tlsPort, udp: radio.udpPort, via: 'forwarded' };
  if (radio.upnpTlsPort > 0 && radio.upnpUdpPort > 0) return { tls: radio.upnpTlsPort, udp: radio.upnpUdpPort, via: 'upnp' };
  return null;
}

/** "SmartSDR on SHACK-PC", from the gui_client_* fields; '' when nobody is listed. */
function whoHolds(radio) {
  if (!radio) return '';
  const c = radio.guiClients && radio.guiClients[0];
  if (c) {
    const what = c.program || c.station || 'another program';
    const where = c.host || c.ip;
    return where ? `${what} on ${where}` : what;
  }
  return radio.inUseHost ? `a program on ${radio.inUseHost}` : '';
}

/** The F3000001 sentence, naming the holder when the list does. */
function busySentence(radio) {
  const who = whoHolds(radio);
  return who ? `The radio is in use by ${who}. It allows one program at a time: close that one first.` : TEXT['radio-busy'];
}

/** Status of a radio for the rig editor's list. */
function describeRadio(radio) {
  const name = radio.name || radio.callsign || radio.serial;
  const who = whoHolds(radio);
  const status = /in_use/i.test(radio.status) ? (who ? `in use by ${who}` : 'in use') : (radio.status || 'unknown').replace(/_/g, ' ').toLowerCase();
  return `${name} (${radio.model}), ${status}`;
}

/** Trust on first use for the radio's self-signed certificate, per serial. */
function pinCheck(pins, serial, fingerprint) {
  const next = { ...(pins || {}) };
  if (!serial || !fingerprint) return { status: 'unknown', pins: next, fingerprint: fingerprint || null };
  if (!next[serial]) { next[serial] = fingerprint; return { status: 'first', pins: next, fingerprint }; }
  return { status: next[serial] === fingerprint ? 'match' : 'changed', pins: next, fingerprint };
}

/** Lines out of a byte stream; a partial line waits for the rest. */
function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

/** The radio's reply to a command, 'R<n>|<hex status>|<payload>'. */
function parseReply(line) {
  const m = String(line).match(/^R(\d+)\|([0-9A-Fa-f]+)\|?(.*)$/);
  return m ? { seq: Number(m[1]), status: parseInt(m[2], 16) >>> 0, payload: m[3] || '' } : null;
}

// ------------------------------------------------------------ the server session

/**
 * The SmartLink server session (Part 2): register, keep-alive, the radio list,
 * and brokering a connection to one radio.
 * Events: 'radios' (list), 'user' ({callsign}), 'closed' ({reason}), 'log' (text).
 */
class SmartLinkServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.clientId
   * @param {function} o.getRefreshToken  () => string|null
   * @param {function} o.connectTls       (opts) => tls socket (node tls.connect shape)
   * @param {function} o.post             (url, form) => Promise<{status, body}>
   * @param {string} [o.platform]         'Windows' | 'macOS' | 'Linux'
   */
  constructor(o) {
    super();
    this._o = o;
    this._t = { ...TIMEOUTS, ...(o.timeouts || {}) };
    this._timers = { setTimeout: o.setTimeout || setTimeout, clearTimeout: o.clearTimeout || clearTimeout, setInterval: o.setInterval || setInterval, clearInterval: o.clearInterval || clearInterval };
    this._sock = null;
    this._opening = null;
    this._open = false;
    this._ping = null;
    this._waiters = [];
    this._jwt = null;
    this.radios = [];
    this.user = null;
    this.registrationInvalid = false;
  }

  get isOpen() { return this._open; }

  _log(s) { this.emit('log', redact(s, [this._jwt, this._o.clientId])); }

  _waitLine(pred, ms, code) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      w.timer = this._timers.setTimeout(() => {
        this._waiters = this._waiters.filter((x) => x !== w);
        reject(new SmartLinkError(code || 'server-timeout'));
      }, ms);
      this._waiters.push(w);
    });
  }

  _onLine(line) {
    if (line.startsWith('radio list')) {
      this.radios = parseRadioList(line);
      this.emit('radios', this.radios);
    } else if (line.startsWith('application user_settings')) {
      const kv = parseKv(line);
      this.user = { callsign: kv.callsign || '' };
      this.emit('user', this.user);
    } else if (line.startsWith('application registration_invalid')) {
      this.registrationInvalid = true;
      this._log('server: registration_invalid (the sign-in token expired); will sign in again on the next connect');
      this.close('registration_invalid');
      return;
    }
    for (const w of this._waiters.slice()) {
      if (w.pred(line)) {
        this._timers.clearTimeout(w.timer);
        this._waiters = this._waiters.filter((x) => x !== w);
        w.resolve(line);
      }
    }
  }

  /** Sign in (refresh the JWT), register, and wait for the first radio list. */
  open() {
    if (this._open) return Promise.resolve(this.radios);
    if (this._opening) return this._opening;
    this._opening = this._doOpen().finally(() => { this._opening = null; });
    return this._opening;
  }

  async _doOpen() {
    const o = this._o;
    this.registrationInvalid = false;
    this._jwt = await refreshJwt({ clientId: o.clientId, refreshToken: o.getRefreshToken(), post: o.post });
    const sock = o.connectTls({ host: SERVER_HOST, port: SERVER_PORT, servername: SERVER_HOST });
    this._sock = sock;
    // The parser is on the socket before it can read anything.
    sock.on('data', lineSplitter((l) => this._onLine(l)));
    sock.on('error', (err) => this._log('server connection error: ' + (err && err.message)));
    sock.on('close', () => {
      if (this._sock !== sock) return;
      const was = this._open;
      this._teardown();
      if (was) this.emit('closed', { reason: 'server closed the connection' });
    });
    await new Promise((resolve, reject) => {
      const t = this._timers.setTimeout(() => reject(new SmartLinkError('server-timeout', 'TLS to the server timed out')), this._t.serverTlsMs);
      sock.once('secureConnect', () => { this._timers.clearTimeout(t); resolve(); });
      sock.once('error', (err) => { this._timers.clearTimeout(t); reject(new SmartLinkError('server-timeout', err && err.code)); });
    }).catch((err) => { this._teardown(); throw err; });
    const listP = this._waitLine((l) => l.startsWith('radio list'), this._t.radioListMs, 'server-timeout');
    // Part 2: register first, with a JWT under 60 s old.
    sock.write(`application register name=${o.appName || 'POTACAT'} platform=${o.platform || 'Windows'} token=${this._jwt}\n`);
    this._log(`server: registered as ${o.appName || 'POTACAT'} (token=<redacted>)`);
    this._ping = this._timers.setInterval(() => { if (this._sock) this._sock.write('ping from client\n'); }, this._t.keepAliveMs);
    try {
      await listP;
    } catch (err) {
      const invalid = this.registrationInvalid;
      this._teardown();
      throw invalid ? new SmartLinkError('sign-in', 'registration_invalid') : err;
    }
    this._jwt = null; // spent: a new one is fetched for every registration
    this._open = true;
    this._log(`server: ${this.radios.length} radio(s) on the account`);
    return this.radios;
  }

  radio(serial) { return this.radios.find((r) => r.serial === serial) || null; }

  /** `application connect` and the WAN handle from `radio connect_ready` (15 s). */
  async connectRadio(serial) {
    if (!this._open) await this.open();
    const p = this._waitLine((l) => l.startsWith('radio connect_ready') && parseKv(l).serial === serial, this._t.connectReadyMs, 'server-timeout');
    this._sock.write(`application connect serial=${serial} hole_punch_port=0\n`);
    this._log(`server: application connect serial=${serial}`);
    const line = await p;
    const handle = parseKv(line).handle;
    if (!handle) throw new SmartLinkError('server-timeout', 'connect_ready without a handle');
    return { handle };
  }

  /** The server's port test for a radio, or null when it does not answer. */
  async testConnection(serial) {
    if (!this._open) await this.open();
    const p = this._waitLine((l) => l.startsWith('radio test_connection') && parseKv(l).serial === serial, this._t.testConnectionMs, 'server-timeout');
    this._sock.write(`radio test_connection serial=${serial}\n`);
    try { return parseKv(await p); } catch { return null; }
  }

  _teardown() {
    if (this._ping) { this._timers.clearInterval(this._ping); this._ping = null; }
    for (const w of this._waiters) { this._timers.clearTimeout(w.timer); w.reject(new SmartLinkError('server-timeout', 'server connection closed')); }
    this._waiters = [];
    const s = this._sock;
    this._sock = null;
    this._open = false;
    if (s) { try { s.destroy(); } catch {} }
  }

  close(reason) {
    const was = this._open;
    this._teardown();
    if (was) this.emit('closed', { reason: reason || 'closed' });
  }
}

/** The port test, in plain words. */
function describePortTest(kv) {
  if (!kv) return '';
  const ok = (v) => v === '1' || v === 'true';
  const parts = [];
  if (ok(kv.forward_tcp_port_working) || ok(kv.forward_udp_port_working)) parts.push(`forwarded ports ${ok(kv.forward_tcp_port_working) && ok(kv.forward_udp_port_working) ? 'work' : 'work only in part'}`);
  if (ok(kv.upnp_tcp_port_working) || ok(kv.upnp_udp_port_working)) parts.push(`UPnP ports ${ok(kv.upnp_tcp_port_working) && ok(kv.upnp_udp_port_working) ? 'work' : 'work only in part'}`);
  if (!parts.length) parts.push('no forwarded or UPnP port answered');
  return `FlexRadio's port test: ${parts.join('; ')}.`;
}

// --------------------------------------------------------- the radio (Part 3, 4)

/**
 * Dial the radio: server connect, TLS to its public address, `C1|wan validate`
 * FIRST, then hand every line to `onLine`. Resolves once the radio answered R1|0|.
 * Exposed for the transport and the rig editor's Test connection.
 */
function dialRadio({ server, serial, connectTls, pins, onLine, log, timeouts, setTimeout: st, clearTimeout: ct }) {
  const T = { ...TIMEOUTS, ...(timeouts || {}) };
  const setT = st || setTimeout;
  const clearT = ct || clearTimeout;
  const say = (s) => { if (log) log(redact(s)); };
  return (async () => {
    await server.open();
    const radio = server.radio(serial);
    if (!radio) throw new SmartLinkError('radio-offline');
    const ports = choosePorts(radio);
    if (!ports) throw new SmartLinkError('needs-hole-punch');
    const { handle } = await server.connectRadio(serial);
    say(`radio: TLS to the radio's public address, port ${ports.tls} (${ports.via})`);
    const sock = connectTls({ host: radio.publicIp, port: ports.tls, rejectUnauthorized: false });
    let validated = false;
    let pin = { status: 'unknown', pins: pins || {} };
    return await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (settled) return; settled = true; clearT(timer); try { sock.destroy(); } catch {} reject(err); };
      let timer = setT(() => fail(new SmartLinkError('radio-unreachable', 'TLS to the radio timed out')), T.radioTlsMs);
      // Part 3: the radio speaks first over TLS. The parser is attached here,
      // when the socket is created, before anything can be read.
      sock.on('data', lineSplitter((line) => {
        if (!validated) {
          const r = parseReply(line);
          if (r && r.seq === 1) {
            if (r.status !== 0) { fail(new SmartLinkError('wan-validate', 'R1 ' + r.status.toString(16).toUpperCase())); return; }
            validated = true;
            settled = true;
            clearT(timer);
            say('radio: wan validate accepted');
            resolve({ sock, radio, ports, pin });
            return;
          }
        }
        onLine(line);
      }));
      sock.on('error', (err) => { if (!validated) fail(new SmartLinkError('radio-unreachable', err && err.code)); });
      sock.on('close', () => { if (!validated) fail(new SmartLinkError('radio-unreachable', 'closed before wan validate')); });
      sock.once('secureConnect', () => {
        const cert = sock.getPeerCertificate ? sock.getPeerCertificate() : null;
        pin = pinCheck(pins, serial, cert && cert.fingerprint256);
        if (pin.status === 'changed') say('radio: WARNING the certificate changed since the last connection');
        clearT(timer);
        timer = setT(() => fail(new SmartLinkError('wan-validate', 'no answer to wan validate')), T.wanValidateMs);
        // FIRST line, numbered (D0: bare `wan validate` is answered 50000021 later).
        sock.write(`C1|wan validate handle=${handle}\n`);
        say('radio: C1|wan validate handle=<handle>');
      });
    });
  })();
}

/**
 * The transport SmartSdrClient uses for a SmartLink rig (lib/flex-transport.js).
 * Every (re)connect dials afresh: server, connect_ready, TLS, wan validate.
 * Errors reach SmartSdrClient as an 'error' event carrying err.code, then 'close'.
 */
function smartLinkTransport({ server, serial, connectTls, getPins, onPin, log, timeouts, udp }) {
  const state = { host: null, udpPort: null };
  return FlexTransport.injectedTransport({
    kind: 'smartlink',
    firstSeq: 2, // C1 was wan validate
    udp: {
      kind: 'wan',
      start: (o) => FlexTransport.wanUdpRegistration({ ...(udp || {}), host: state.host, port: state.udpPort }).start(o),
    },
    describe: () => `FlexRadio SmartLink radio ${serial}`,
    open(_host, attach) {
      const conn = new EventEmitter();
      let tls = null;
      let closed = false;
      const closeOnce = () => { if (closed) return; closed = true; conn.emit('close'); };
      conn.write = (s) => (tls && !tls.destroyed ? tls.write(s) : false);
      conn.end = () => { if (tls) { try { tls.end(); } catch {} } else closeOnce(); };
      conn.destroy = () => { if (tls) { try { tls.destroy(); } catch {} } closeOnce(); };
      conn.setNoDelay = () => {};
      attach(conn);
      dialRadio({
        server, serial, connectTls, timeouts, log,
        pins: getPins ? getPins() : {},
        onLine: (line) => conn.emit('data', line + '\n'),
      }).then(({ sock, radio, ports, pin }) => {
        tls = sock;
        state.host = radio.publicIp;
        state.udpPort = ports.udp;
        if (onPin) onPin(pin);
        sock.on('error', (err) => conn.emit('error', err));
        sock.on('close', closeOnce);
        if (closed) { try { sock.destroy(); } catch {} return; }
        conn.emit('connect');
      }, (err) => {
        if (closed) return;
        conn.emit('error', err);
        closeOnce();
      });
      return conn;
    },
  });
}

/**
 * Test connection for the rig editor, without taking the radio's GUI seat: the
 * whole chain as a non-GUI client, plus the UDP path (meters), then let go.
 * Resolves { ok, steps[], text, radio, error? }.
 */
async function testRadio({ server, serial, connectTls, createUdp, pins, timeouts, log }) {
  const T = { ...TIMEOUTS, ...(timeouts || {}) };
  const steps = [];
  let conn = null;
  let udpSock = null;
  let reg = null;
  try {
    await server.open();
    steps.push('Signed in to FlexRadio SmartLink.');
    const radio = server.radio(serial);
    if (!radio) throw new SmartLinkError('radio-offline');
    steps.push(`Your radio is listed: ${describeRadio(radio)}.`);
    let handleHex = null;
    conn = await dialRadio({ server, serial, connectTls, pins, timeouts, log, onLine: (l) => { const m = l.match(/^H([0-9A-Fa-f]+)/); if (m) handleHex = m[1]; } });
    steps.push('The radio accepted the connection.');
    // Test connection is the operator's own check, so a changed certificate is
    // shown and then trusted from here on.
    const pinsAfter = conn.pin.fingerprint ? { ...conn.pin.pins, [serial]: conn.pin.fingerprint } : conn.pin.pins;
    if (conn.pin.status === 'changed') steps.push(TEXT['cert-changed'] + ' POTACAT trusts the new one from now on.');
    // Meters over UDP prove the path audio takes.
    conn.sock.write('C2|sub meter all\n');
    udpSock = createUdp();
    await new Promise((r) => udpSock.bind(0, r));
    const got = await new Promise((resolve) => {
      reg = FlexTransport.wanUdpRegistration({ host: conn.radio.publicIp, port: conn.ports.udp, giveUpMs: T.testUdpMs })
        .start({ udpSock, getHandle: () => handleHex, onConfirmed: () => resolve(true), onFailed: () => resolve(false) });
      udpSock.on('message', (b) => reg.onPacket(b));
      udpSock.on('error', () => {});
    });
    if (!got) {
      steps.push(TEXT['udp-blocked']);
      return { ok: false, code: 'udp-blocked', steps, radio, text: steps.join(' ') };
    }
    steps.push('The audio path is open.');
    if (/in_use/i.test(radio.status)) steps.push(busySentence(radio));
    return { ok: true, steps, radio, pins: pinsAfter, text: steps.join(' ') };
  } catch (err) {
    const code = err && err.code;
    const text = TEXT[code] || 'POTACAT could not reach the radio over FlexRadio SmartLink.';
    steps.push(text);
    return { ok: false, code: code || 'error', steps, text: steps.join(' ') };
  } finally {
    if (reg) reg.stop();
    if (udpSock) { try { udpSock.close(); } catch {} }
    if (conn && conn.sock) { try { conn.sock.end(); conn.sock.destroy(); } catch {} }
  }
}

/** The platform word `application register` carries. */
function platformName(p) {
  return p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : 'Windows';
}

module.exports = {
  AUTH_DOMAIN, REDIRECT_URI, LOGIN_SCOPE, REFRESH_SCOPE, SERVER_HOST, SERVER_PORT, TIMEOUTS, TEXT,
  SmartLinkError, SmartLinkServer,
  redact, authorizeUrl, isRedirect, parseRedirect, refreshJwt,
  parseKv, parseRadioList, normalizeRadio, choosePorts, whoHolds, busySentence, describeRadio, describePortTest,
  pinCheck, lineSplitter, parseReply, dialRadio, smartLinkTransport, testRadio, platformName,
};
