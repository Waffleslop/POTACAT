'use strict';

// Is the desktop actually answering behind the Cloud Tunnel?
//
// K5AWJ 2026-09-17: Cloudflare reported his tunnel healthy with four live
// connections while every request to k5awj.potacat.com returned 502 for
// hours. cloudflared is POTACAT's own child process, so a healthy tunnel
// means the app was running — its LOCAL server on :7300 was not answering.
// Nothing in the app looked at that: the tunnel state came from cloudflared's
// stderr and the cloud's /status, the local bind result went to a log line,
// and the UI said "Live" while handing out a URL that 502'd.
//
// The tunnel's ingress is `https://localhost:7300` with TLS verification
// off — configured SERVER-side at provision time (potacat-cloudlog
// routes/cloud-tunnel.js DESKTOP_HTTPS_PORT), never from this app. So the
// desktop must serve HTTPS on exactly that port, and the ways it can fail
// are each a distinct, actionable state:
//   - port not bound (a stale POTACAT holding it after a reboot),
//   - serving plain HTTP (the cert step failed and the server fell back),
//   - bound to a different port (settings.remotePort was changed — the
//     ingress does not follow it),
//   - bound and speaking TLS but not responding.
//
// decideOriginState() is pure; probeLocalOrigin() makes the one real
// request. Both are cheap and touch no Cloudflare or cloud API.

const http = require('http');
const https = require('https');

/** The port the server-side ingress points at. Not configurable here. */
const TUNNEL_INGRESS_PORT = 7300;

const PROBE_TIMEOUT_MS = 3000;

/**
 * @param {object} p
 * @param {boolean} p.tunnelEnabled
 * @param {string}  p.tunnelStatus  - CloudTunnelManager status
 * @param {number}  p.port          - the port the local server was asked to bind
 * @param {object}  [p.server]      - RemoteServer.serverState(): { listening, https, bindFailed, tlsFailed, lastError }
 * @param {object}  [p.probe]       - probeLocalOrigin() result: { ok, https, error }
 * @returns {{ state: string, label: string, reason: string, actionable: boolean }}
 *   state: 'ok' | 'not-listening' | 'http-origin' | 'port-mismatch' | 'not-answering' | 'off' | 'pending'
 */
function decideOriginState({ tunnelEnabled, tunnelStatus, port, server, probe }) {
  if (!tunnelEnabled) return { state: 'off', label: '', reason: '', actionable: false };
  const s = server || {};
  const bound = Number(port) || TUNNEL_INGRESS_PORT;

  // Order matters: each test names the cause the previous ones cannot.
  if (bound !== TUNNEL_INGRESS_PORT) {
    return {
      state: 'port-mismatch',
      label: 'Cloud up · POTACAT on the wrong port',
      reason: `The Cloud Tunnel always forwards to port ${TUNNEL_INGRESS_PORT}, but the ECHOCAT port is set to ${bound}. Set it back to ${TUNNEL_INGRESS_PORT} (Settings > ECHOCAT) or every remote connection fails with a 502.`,
      actionable: true,
    };
  }
  if (s.bindFailed || (s.listening === false && !s.tlsFailed)) {
    return {
      state: 'not-listening',
      label: 'Cloud up · POTACAT not answering',
      reason: s.lastError || `Nothing is listening on port ${bound}. Another program — usually a POTACAT left over from before a restart — is holding it. Close it or restart the computer; POTACAT keeps retrying in the background.`,
      actionable: true,
    };
  }
  if (s.tlsFailed || (s.listening && s.https === false) || (probe && probe.ok && probe.https === false)) {
    return {
      state: 'http-origin',
      label: 'Cloud up · POTACAT not answering',
      reason: s.lastError || 'POTACAT could not create its TLS certificate and is serving plain HTTP. The Cloud Tunnel requires HTTPS, so every remote connection fails with a 502. Restart POTACAT; if it persists, send a bug report.',
      actionable: true,
    };
  }
  if (probe && !probe.ok) {
    return {
      state: 'not-answering',
      label: 'Cloud up · POTACAT not answering',
      reason: `POTACAT's own server on port ${bound} did not answer a local test request (${probe.error || 'no response'}). Restart POTACAT.`,
      actionable: true,
    };
  }
  if (!probe && !s.listening) {
    return { state: 'pending', label: '', reason: '', actionable: false };
  }
  return { state: 'ok', label: tunnelStatus === 'live' ? 'Live' : '', reason: '', actionable: false };
}

/**
 * One real request to the local server, the way the tunnel makes it: HTTPS,
 * certificate not verified. If TLS fails, a plain-HTTP attempt tells a
 * server that fell back to HTTP apart from no server at all.
 *
 * @returns {Promise<{ ok: boolean, https: boolean|null, statusCode: number|null, error: string|null }>}
 */
function probeLocalOrigin(port, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const target = Number(port) || TUNNEL_INGRESS_PORT;
  const attempt = (mod, secure) => new Promise((resolve) => {
    const req = mod.request({
      host: '127.0.0.1', port: target, path: '/', method: 'GET',
      timeout: timeoutMs,
      rejectUnauthorized: false, // the tunnel uses noTLSVerify; so do we
      headers: { 'user-agent': 'POTACAT-origin-probe', connection: 'close' },
    }, (res) => {
      res.resume();
      resolve({ ok: true, https: secure, statusCode: res.statusCode || null, error: null });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (err) => resolve({ ok: false, https: secure, statusCode: null, error: (err && err.code) || (err && err.message) || 'error' }));
    req.end();
  });

  return attempt(https, true).then((tls) => {
    if (tls.ok) return tls;
    // ECONNREFUSED / timeout: nothing there — no point trying HTTP.
    if (tls.error === 'ECONNREFUSED' || tls.error === 'timed out') return tls;
    // Anything else (EPROTO, ECONNRESET, "wrong version number") smells
    // like a non-TLS listener. Ask it in plain HTTP.
    return attempt(http, false).then((plain) => (plain.ok ? plain : tls));
  });
}

module.exports = { decideOriginState, probeLocalOrigin, TUNNEL_INGRESS_PORT, PROBE_TIMEOUT_MS };
