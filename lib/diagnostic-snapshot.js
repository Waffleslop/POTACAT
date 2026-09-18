'use strict';
//
// Desktop diagnostic-snapshot assembly for the Unified Bug Report.
//
// Canonical wire contract: status/brief-bug-report-{desktop,mobile}.md. The
// mobile app already ships a BugReportAssembler that consumes EXACTLY this
// `sections` shape, so the desktop must produce it verbatim.
//
// This module is the PURE assembly + redaction step: main.js gathers the live
// state (settings, CAT status, tunnel/tailscale, log ring buffer) and passes
// it in as `raw`; here we shape it into the brief's `sections` object and,
// when redact=true, mask anything unsafe to paste into a public report. Pure
// JS, no I/O, no Electron — so the redaction is unit-testable.
//
// Desktop sections: account, connection, pairedDevices, rig, tailscale,
// cloudTunnel, logLines. `network` is mobile-only and is omitted here.
//

const REDACTED = '<redacted>';

// ── Redaction helpers ──────────────────────────────────────────────────────

/** Mask an email as first+last of the local part and first of the domain
 *  label, preserving the TLD: casey@cmox.co -> c***y@c***.co. Display only —
 *  the mobile never parses this back. Returns '' for falsy input. */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? REDACTED : '';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const maskLocal = local.length <= 2
    ? local[0] + '*'
    : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];
  const dot = domain.indexOf('.');
  let maskDomain;
  if (dot < 1) {
    maskDomain = (domain[0] || '') + '*'.repeat(Math.max(1, domain.length - 1));
  } else {
    const label = domain.slice(0, dot);
    const tld = domain.slice(dot); // includes the leading dot
    maskDomain = label[0] + '*'.repeat(Math.max(1, label.length - 1)) + tld;
  }
  return `${maskLocal}@${maskDomain}`;
}

/** Replace any routable IPv4 in `str` with its /24 (192.168.1.50 ->
 *  192.168.1.0/24). Loopback (127.x) is left alone — pointless and noisy. */
function redactIpTo24(str) {
  if (str == null) return str;
  return String(str).replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    (m, a, b, c) => (a === '127') ? m : `${a}.${b}.${c}.0/24`);
}

// Order matters: JWT first (contains dots the long-token rule would miss),
// then Bearer tokens, then any remaining 32+ char opaque blob.
const RE_JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const RE_BEARER = /\bBearer\s+[A-Za-z0-9_.+\-=/]+/gi;
const RE_LONG = /[A-Za-z0-9+/=]{32,}/g;

/** Strip secrets from a single log line.
 *
 *  IPs are masked to /24 here for the same reason `connection.remoteAddress`
 *  and `rig.catTransport` are: these reports get emailed and pasted into
 *  Discord. Masking only the summary fields was a half-measure — the log lines
 *  carry the same addresses verbatim (`socket connect from 192.168.1.188`,
 *  `dialing wss://192.168.1.150:7300`), so a report could redact the header and
 *  leak the identical value twenty lines down (KQ4DX 2026-08-10).
 *
 *  Order matters: token rules run first. redactIpTo24 rewrites digits, and a
 *  base64 blob containing a dotted-quad substring would otherwise be reshaped
 *  before RE_LONG could match it. */
function redactLogLine(line) {
  return redactIpTo24(String(line)
    .replace(RE_JWT, '<redacted-jwt>')
    .replace(RE_BEARER, 'Bearer <redacted>')
    .replace(RE_LONG, REDACTED));
}

/** Strip secrets from an array of log lines. */
function redactLogLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map(redactLogLine);
}

// ── Section assembly ────────────────────────────────────────────────────────

/**
 * Build the brief's desktop `sections` object from gathered raw state.
 *
 * @param {object} raw   live state gathered by main.js; each key maps to a
 *                       section (account, connection, pairedDevices, rig,
 *                       tailscale, cloudTunnel, logLines). Missing keys yield
 *                       a safe default section so a partial gather still ships.
 * @param {object} [opts]  { redact:boolean } — mask identifying values.
 * @returns {object} the `sections` object (no `network` — that's mobile-only).
 */
function assembleSections(raw, opts) {
  raw = raw || {};
  const redact = !!(opts && opts.redact);
  const sections = {};

  function section(name, fn) {
    try { sections[name] = fn(); }
    catch (err) { sections[name] = { error: String((err && err.message) || err) }; }
  }

  section('account', () => {
    const a = raw.account || {};
    return {
      signedIn: !!a.signedIn,
      callsign: a.callsign || null,
      emailRedacted: a.email ? (redact ? maskEmail(a.email) : String(a.email)) : null,
      subscriptionStatus: a.subscriptionStatus || 'none',
      subscriptionSource: a.subscriptionSource || null,
      subscriptionExpiresAt: a.subscriptionExpiresAt || null,
    };
  });

  section('connection', () => {
    const c = raw.connection || {};
    let remoteAddress = c.remoteAddress || null;
    if (redact && remoteAddress) remoteAddress = redactIpTo24(remoteAddress);
    return {
      role: c.role || 'host',
      pathTried: Array.isArray(c.pathTried) ? c.pathTried.slice() : [],
      pathActive: c.pathActive || null,
      remoteAddress,
      latencyMs: typeof c.latencyMs === 'number' ? c.latencyMs : null,
      reconnectsLastHour: typeof c.reconnectsLastHour === 'number' ? c.reconnectsLastHour : 0,
      passSession: !!c.passSession,
      // Host-side listener (additive — the mobile assembler ignores keys it
      // doesn't know). A tunnel that is healthy while this says "not
      // listening" is the K5AWJ 502, stated instead of inferred.
      localServer: c.localServer ? {
        enabled: c.localServer.enabled !== false,
        listening: !!c.localServer.listening,
        https: typeof c.localServer.https === 'boolean' ? c.localServer.https : null,
        port: c.localServer.port || null,
        bindFailed: !!c.localServer.bindFailed,
        tlsFailed: !!c.localServer.tlsFailed,
        lastError: c.localServer.lastError || '',
      } : null,
    };
  });

  section('pairedDevices', () => {
    const list = Array.isArray(raw.pairedDevices) ? raw.pairedDevices : [];
    return list.map((d) => ({
      id: d.id || '',
      name: d.name || '',
      platform: d.platform || '',
      lastSeenAt: d.lastSeenAt || d.lastSeen || null,
    }));
  });

  section('rig', () => {
    const r = raw.rig || {};
    let catTransport = r.catTransport || null;
    if (redact && catTransport) catTransport = redactIpTo24(catTransport);
    return {
      configured: !!r.configured,
      profile: r.profile || null,
      catTransport,
      catStatus: r.catStatus || 'not_configured',
      catLastPollAgeMs: typeof r.catLastPollAgeMs === 'number' ? r.catLastPollAgeMs : null,
      vfo: r.vfo || null,
      audioBridge: r.audioBridge || null,
    };
  });

  section('tailscale', () => {
    const t = raw.tailscale || {};
    return {
      installed: !!t.installed,
      connected: !!t.connected,
      hostname: t.hostname || null,
      peerCount: typeof t.peerCount === 'number' ? t.peerCount : null,
    };
  });

  section('cloudTunnel', () => {
    const t = raw.cloudTunnel || {};
    return {
      enabled: !!t.enabled,
      status: t.status || 'off',
      cloudHost: t.cloudHost || null,
      lastHealthCheckAt: t.lastHealthCheckAt || null,
      // Origin self-test result (lib/origin-health.js): 'ok' or why not.
      origin: t.origin ? { state: t.origin.state || null, reason: t.origin.reason || '', checkedAt: t.origin.checkedAt || null } : null,
    };
  });

  section('logLines', () => {
    const lines = Array.isArray(raw.logLines) ? raw.logLines : [];
    return redact ? redactLogLines(lines) : lines.slice();
  });

  return sections;
}

/**
 * Convenience: wrap assembled sections in the full `diagnostic-snapshot`
 * message envelope. main.js can use this directly. `platform` is the brief's
 * object form; `timestamp` is ISO-8601.
 *
 * @param {object} env  { requestId, source, appVersion, platform, timestamp }
 * @param {object} raw  raw state for assembleSections
 * @param {object} [opts] { redact }
 */
function buildDiagnosticSnapshot(env, raw, opts) {
  env = env || {};
  return {
    type: 'diagnostic-snapshot',
    requestId: typeof env.requestId === 'string' ? env.requestId : '',
    source: env.source || 'desktop',
    appVersion: env.appVersion || '',
    platform: env.platform || { os: '', osVersion: '', deviceModel: null },
    timestamp: env.timestamp || '',
    sections: assembleSections(raw, opts),
  };
}

module.exports = {
  assembleSections,
  buildDiagnosticSnapshot,
  maskEmail,
  redactIpTo24,
  redactLogLine,
  redactLogLines,
  REDACTED,
};
