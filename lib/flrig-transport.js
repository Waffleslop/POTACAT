'use strict';
/**
 * FlrigTransport — the rig-controller transport contract (connect / write /
 * disconnect; emits connect / data / error / close) over flrig's XML-RPC
 * HTTP server. flrig (W1HKJ) holds the radio; POTACAT is one of its clients,
 * beside a logger or fldigi, so a station can keep the program it already
 * runs and still work POTA from here (KM4CFT, FTDX10 under Ham2K Polo,
 * 2026-10-25 — his logger's rigctld served frequency and mode but no PTT).
 *
 * How it maps onto request/response:
 *   - write(xml) queues ONE <methodCall>; calls go out one at a time on a
 *     keep-alive socket and every reply is emitted as 'data' (the body only),
 *     strictly in call order, so the codec keeps a FIFO of what it asked —
 *     exactly the rigctld codec's attribution model.
 *   - call(method, params) is the same queue with a promise attached; its
 *     reply is resolved and NOT emitted, so a side query (Test Connection,
 *     a probe) never desynchronises the codec's FIFO.
 *   - 'connect' fires when the TCP socket opens. flrig keeps the socket for
 *     HTTP/1.1 requests; if it (or a proxy) closes an IDLE socket that is not
 *     a lost link — the next call reopens it silently. A refused connect, a
 *     socket lost mid-call or a call that gets no reply in `timeoutMs` IS a
 *     lost link: 'error' + 'close', the queue is dropped, and the transport
 *     retries every 2 s like TcpTransport until disconnect().
 * Loopback or LAN only; there is no TLS or auth in flrig's server.
 */
const net = require('net');
const { EventEmitter } = require('events');
const { encodeCall, decodeResponse } = require('./xmlrpc');

const DEFAULT_TIMEOUT_MS = 3000;
const RECONNECT_MS = 2000;

class FlrigTransport extends EventEmitter {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, reconnectMs = RECONNECT_MS } = {}) {
    super();
    this._sock = null;
    this._connected = false;    // the LINK as the controller sees it
    this._target = null;        // { host, port }
    this._queue = [];           // { body, resolve?, reject? }
    this._inflight = null;
    this._buf = Buffer.alloc(0);
    this._timer = null;
    this._reconnectTimer = null;
    this._timeoutMs = timeoutMs;
    this._reconnectMs = reconnectMs;
    this._opening = false;
  }

  get connected() { return this._connected; }

  /** @param {{host?:string, port?:number}} opts */
  connect({ host = '127.0.0.1', port = 12345 } = {}) {
    this.disconnect();
    this._target = { host, port: Number(port) || 12345 };
    this._open(true);
  }

  disconnect() {
    this._target = null;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._clearTimer();
    const q = this._queue.splice(0);
    for (const it of q) if (it.reject) it.reject(new Error('flrig transport closed'));
    if (this._inflight && this._inflight.reject) this._inflight.reject(new Error('flrig transport closed'));
    this._inflight = null;
    this._dropSocket();
    this._connected = false;
  }

  /**
   * Queue one <methodCall> body (already XML). Its reply arrives as 'data'.
   * @returns {boolean} false when there is no target (never connected)
   */
  write(data) {
    if (!this._target) return false;
    this._queue.push({ body: String(data) });
    this._pump();
    return true;
  }

  /**
   * Call a method and get its decoded reply — resolved, not emitted.
   * @returns {Promise<any>} the value (null for an empty result); rejects on a fault or a lost link
   */
  call(method, params = []) {
    if (!this._target) return Promise.reject(new Error('flrig transport not connected'));
    return new Promise((resolve, reject) => {
      this._queue.push({ body: encodeCall(method, params), resolve, reject });
      this._pump();
    });
  }

  // --- socket ---

  _open(announce) {
    if (!this._target || this._opening) return;
    this._opening = true;
    const { host, port } = this._target;
    const sock = new net.Socket();
    this._sock = sock;
    this._buf = Buffer.alloc(0);
    let everConnected = false;
    sock.setNoDelay(true);
    sock.on('connect', () => {
      if (this._sock !== sock) return;
      this._opening = false;
      everConnected = true;
      sock.setKeepAlive(true, 10000);
      const wasConnected = this._connected;
      this._connected = true;
      if (announce || !wasConnected) this.emit('connect');
      this._pump();
    });
    sock.on('data', (chunk) => {
      if (this._sock !== sock) return;
      this._buf = Buffer.concat([this._buf, chunk]);
      this._drain();
    });
    sock.on('error', (err) => {
      if (this._sock !== sock) return;
      this._opening = false;
      this._fail(err);
    });
    // The server closed its side. A server (or proxy) that answers one
    // request per connection does this right after every reply, and the
    // next request may already have been written onto the dying socket —
    // that is a retry on a fresh socket, not a lost link. Only a request
    // that got no reply on TWO sockets, or a close before anything was ever
    // answered, counts as flrig gone.
    const peerGone = (why) => {
      if (this._sock !== sock) return;
      this._opening = false;
      this._sock = null;
      try { sock.destroy(); } catch { /* ignore */ }
      const it = this._inflight;
      if (it) {
        if (everConnected && this._buf.length === 0 && !it.retried) {
          it.retried = true;
          this._inflight = null;
          this._clearTimer();
          this._queue.unshift(it);
          this._open(false);
          return;
        }
        this._fail(new Error(everConnected ? `flrig closed the connection mid-call (${why})` : 'connection closed before flrig answered'));
        return;
      }
      if (!everConnected) { this._fail(new Error('connection closed')); return; }
      // Idle keep-alive socket closed by the server: the next call reopens it.
      if (this._queue.length) this._open(false);
    };
    sock.on('end', () => peerGone('end'));
    sock.on('close', () => peerGone('close'));
    try { sock.connect(port, host); } catch (e) { this._opening = false; this._fail(e); }
  }

  _dropSocket() {
    const s = this._sock;
    this._sock = null;
    this._opening = false;
    if (s) { try { s.destroy(); } catch { /* ignore */ } }
  }

  _fail(err) {
    this._clearTimer();
    this._dropSocket();
    const inflight = this._inflight;
    this._inflight = null;
    const q = this._queue.splice(0);
    if (inflight && inflight.reject) inflight.reject(err);
    for (const it of q) if (it.reject) it.reject(err);
    const wasConnected = this._connected;
    this._connected = false;
    this.emit('error', err);
    if (wasConnected) this.emit('close');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this._open(true);
    }, this._reconnectMs);
  }

  // --- request/response ---

  _pump() {
    if (this._inflight || !this._queue.length || !this._target) return;
    if (!this._sock || this._sock.destroyed || this._sock.readableEnded || this._sock.writableEnded) { this._sock = null; this._open(false); return; }
    if (this._sock.connecting) return; // 'connect' pumps
    const item = this._queue.shift();
    this._inflight = item;
    const body = Buffer.from(item.body, 'utf8');
    const head = `POST /RPC2 HTTP/1.1\r\nHost: ${this._target.host}:${this._target.port}\r\nUser-Agent: POTACAT\r\nContent-Type: text/xml\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n`;
    this._sock.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    this._timer = setTimeout(() => {
      this._timer = null;
      this._fail(new Error(`flrig did not answer within ${this._timeoutMs} ms`));
    }, this._timeoutMs);
  }

  _clearTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /** Parse as many complete HTTP responses as the buffer holds. */
  _drain() {
    while (this._inflight) {
      const headEnd = this._buf.indexOf('\r\n\r\n');
      if (headEnd === -1) return;
      const head = this._buf.slice(0, headEnd).toString('latin1');
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head);
      const lenM = /\r\ncontent-length:\s*(\d+)/i.exec(head);
      const len = lenM ? parseInt(lenM[1], 10) : -1;
      if (len < 0) {
        // No length: wait for the server to close (handled in 'close') —
        // flrig always sends one, so this is a foreign server.
        this._fail(new Error('reply had no Content-Length (not flrig?)'));
        return;
      }
      if (this._buf.length < headEnd + 4 + len) return;
      const body = this._buf.slice(headEnd + 4, headEnd + 4 + len).toString('utf8');
      this._buf = this._buf.slice(headEnd + 4 + len);
      const status = m ? parseInt(m[1], 10) : 0;
      const item = this._inflight;
      this._inflight = null;
      this._clearTimer();
      if (item.resolve) {
        if (status !== 200) item.reject(new Error(`HTTP ${status} from flrig`));
        else {
          const r = decodeResponse(body);
          if (r.ok) item.resolve(r.value);
          else item.reject(Object.assign(new Error(r.fault.string), { fault: r.fault }));
        }
      } else {
        this.emit('data', body);
      }
      this._pump();
    }
  }
}

/**
 * One-shot probe for Test Connection: is there an flrig at host:port, and
 * what does it hold? Never throws; the error text is for the operator.
 * @returns {Promise<{ok:boolean, version?:string, xcvr?:string, freqHz?:number, mode?:string, modes?:string[], error?:string}>}
 */
async function probeFlrig({ host = '127.0.0.1', port = 12345, timeoutMs = 2500 } = {}) {
  const t = new FlrigTransport({ timeoutMs });
  const out = { ok: false };
  try {
    await new Promise((resolve, reject) => {
      t.once('connect', resolve);
      t.once('error', reject);
      t.connect({ host, port });
    });
    out.version = String(await t.call('main.get_version'));
    out.xcvr = String(await t.call('rig.get_xcvr'));
    out.freqHz = parseInt(String(await t.call('rig.get_vfo')), 10) || 0;
    out.mode = String(await t.call('rig.get_mode'));
    const modes = await t.call('rig.get_modes');
    out.modes = Array.isArray(modes) ? modes.map(String) : [];
    out.ok = true;
  } catch (e) {
    out.error = describeFlrigError(e, host, port);
  } finally {
    t.disconnect();
  }
  return out;
}

function describeFlrigError(e, host, port) {
  const msg = (e && e.message) || String(e);
  const code = e && e.code;
  if (code === 'ECONNREFUSED') return `nothing is listening on ${host}:${port} — is flrig running, and is its XML-RPC port ${port} (flrig: Config > Setup > Xcvr > Server port)?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `host ${host} was not found`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${host} is unreachable from this computer`;
  if (code === 'ETIMEDOUT' || /did not answer/.test(msg)) return `no answer from ${host}:${port} (a firewall, or that is not flrig's port)`;
  if (/unknown method name/.test(msg)) return `the server at ${host}:${port} answered, but it is not flrig (${msg})`;
  return msg;
}

module.exports = { FlrigTransport, probeFlrig, describeFlrigError };
