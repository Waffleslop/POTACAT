// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink via Pat — process helpers and wire parsers (pure, unit-tested).
//
// Pat (https://github.com/la5nta/pat, MIT, LA5NTA) is the Winlink client.
// POTACAT runs it as a SEPARATE PROCESS ("pat http") per operator profile and
// talks to it only over its local HTTP JSON API and /ws websocket — never
// linked, never a B2F implementation of our own (Casey, 2026-10-22).
//
// Pat's HTTP API has NO authentication, so it is only ever bound to 127.0.0.1
// on a port POTACAT chooses. For radio sessions Pat does the Winlink protocol
// and the modem (ARDOP / Mercury / VARA) does the audio; PTT and QSY come back
// into POTACAT through the loopback rigctld shim (lib/rigctld-server.js) that
// the config below points Pat's hamlib_rigs at.
//
// Operating rules this module enforces by construction (Part 97 — a client
// station needs its control operator present; automatic control is the
// gateway's, not ours):
//   - buildPatArgs never passes --listen (no unattended answering) and never
//     --send-only; buildPatConfig always writes listen: [] and schedule: {}.
//   - RF connects are started only by an operator's Connect (main.js); the
//     telnet auto-check is internet-only.
//
// Wire facts are from Pat v1.0.0's source (api/api.go, api/mailbox.go,
// api/types, api/wshub.go, app/rmslist.go, app/freq.go, cfg/config.go):
//   - /ws frames are objects with ONE key: Status, Progress, Notification,
//     Prompt, PromptAbort, UpdateMailbox, Ping, LogLine (or {MyCall} first).
//     A Ping must be answered {"Pong":true} or Pat drops the socket after
//     4 min + 10 s. A prompt is answered {"prompt_response":{id,value}}.
//   - An RMS entry's `url` already carries the DIAL frequency (centre −
//     1500 Hz for ARDOP/VARA, app/freq.go Dial()), so a gateway connect uses
//     that URL verbatim; Pat QSYs before and QSXes back after the session.

'use strict';

const { freqToBand } = require('./bands');

const PAT_DEFAULTS = Object.freeze({
  httpPortRange: [8590, 8599],
  shimPortRange: [4540, 4549],
  ardopPort: 8515,
  varaPort: 8300,
  ardopBw: 500,
  agwPort: 8010,
  varaBw: 2300,
  telnetAlias: 'telnet://{mycall}:CMSTelnet@cms.winlink.org:8772/wl2k',
});

/** The radio transports POTACAT offers, in display order. */
const WINLINK_MODES = Object.freeze(['telnet', 'ardop', 'packet', 'mercury', 'vara']);

/** Platform-correct Pat executable name. */
function patBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'pat.exe' : 'pat';
}

/**
 * Ordered candidate locations for the Pat binary (most specific first). The
 * bare name (PATH) is NOT included — findPat() falls back to it last, like
 * findRigctld()/findMercury().
 */
function patPathCandidates({ settings, isPackaged, resourcesPath, appDir, platform = process.platform } = {}) {
  const bin = patBinaryName(platform);
  const isWin = platform === 'win32';
  const sep = isWin ? '\\' : '/';
  const join = (...parts) => parts.join(sep);
  const out = [];
  if (settings && settings.winlinkPatPath) out.push(settings.winlinkPatPath);
  if (isPackaged && resourcesPath) out.push(join(resourcesPath, 'bin', bin));
  else if (appDir) out.push(join(appDir, 'assets', 'pat', bin));
  if (isWin) {
    out.push('C:\\Program Files\\pat\\pat.exe', 'C:\\Program Files (x86)\\pat\\pat.exe');
  } else {
    out.push('/usr/bin/pat', '/usr/local/bin/pat', '/opt/homebrew/bin/pat');
  }
  return out;
}

/**
 * CLI args for `pat http`. Every path is POTACAT's (per operator profile), so
 * two operators on one PC never share a mailbox. Never --listen, never
 * --send-only (see header).
 */
function buildPatArgs({ configPath, mboxDir, logPath, eventLogPath, formsDir } = {}) {
  const args = [];
  if (configPath) args.push('--config', configPath);
  if (mboxDir) args.push('--mbox', mboxDir);
  if (logPath) args.push('--log', logPath);
  if (eventLogPath) args.push('--event-log', eventLogPath);
  if (formsDir) args.push('--forms', formsDir);
  args.push('http');
  return args;
}

function _int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Maidenhead to the 6 characters Pat accepts as a locator. */
function patLocator(grid) {
  const g = String(grid || '').trim();
  return /^[A-Ra-r]{2}\d{2}([A-Xa-x]{2})?/.test(g) ? g.slice(0, 6) : '';
}

/**
 * The config.json POTACAT writes for Pat (regenerated on every launch and
 * before every radio session — "do not edit", like mercury.ini).
 *
 * `shimPort` present = radio transports configured, all keyed through the
 * POTACAT shim (`ptt_ctrl: true`, rig "potacat"). Absent = the internet-only
 * shape: no hamlib rigs, no modems.
 *
 * @param {object} o
 * @param {string} o.mycall
 * @param {string} [o.password]
 * @param {string} [o.grid]
 * @param {number} o.httpPort
 * @param {number} [o.shimPort]
 * @param {object} [o.transport] {ardopPort, ardopBw, varaAddr, varaBw, agwPort}
 */
function buildPatConfig({ mycall, password, grid, httpPort, shimPort, transport = {} } = {}) {
  const cfg = {
    mycall: String(mycall || '').toUpperCase(),
    secure_login_password: password || '',
    locator: patLocator(grid),
    http_addr: `127.0.0.1:${_int(httpPort, PAT_DEFAULTS.httpPortRange[0])}`,
    service_codes: ['PUBLIC'],
    auto_download_size_limit: -1,
    connect_aliases: { telnet: PAT_DEFAULTS.telnetAlias },
    listen: [],
    schedule: {},
    hamlib_rigs: {},
    gpsd: { enable_http: false, allow_forms: false, use_server_time: false, addr: '' },
  };
  if (shimPort) {
    const ardopBw = [200, 500, 1000, 2000].includes(Number(transport.ardopBw)) ? Number(transport.ardopBw) : PAT_DEFAULTS.ardopBw;
    const varaBw = [500, 2300, 2750].includes(Number(transport.varaBw)) ? Number(transport.varaBw) : PAT_DEFAULTS.varaBw;
    cfg.hamlib_rigs = { potacat: { address: `127.0.0.1:${shimPort}`, network: 'tcp' } };
    cfg.ardop = {
      addr: `127.0.0.1:${_int(transport.ardopPort, PAT_DEFAULTS.ardopPort)}`,
      rig: 'potacat', ptt_ctrl: true,
      arq_bandwidth: { Forced: false, Max: ardopBw },
      cwid_enabled: true,
    };
    // Packet: Pat's AX.25 over Dire Wolf's AGWPE port. Pat uses the rig only
    // to QSY; Dire Wolf keys (through the same shim — lib/direwolf-process.js).
    cfg.ax25 = { engine: 'agwpe', rig: 'potacat', beacon: { every: 0, message: '', destination: '' } };
    cfg.agwpe = { addr: `127.0.0.1:${_int(transport.agwPort, PAT_DEFAULTS.agwPort)}`, radio_port: 0 };
    cfg.varahf = {
      addr: transport.varaAddr || `127.0.0.1:${PAT_DEFAULTS.varaPort}`,
      rig: 'potacat', ptt_ctrl: true, bandwidth: varaBw,
    };
  }
  return cfg;
}

/** Callsign-ish: a gateway call with optional -SSID. */
function _isGatewayCall(c) {
  return /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(-\d{1,2})?$/i.test(String(c || ''));
}

/**
 * The Pat connect URL for a session. Mercury speaks VARA's TNC protocol, so a
 * Mercury session uses Pat's varahf transport (pointed at Mercury's port by
 * buildPatConfig's transport.varaAddr). `dialKhz` is the RADIO DIAL, which is
 * what Pat's rmslist `dial` and `url` already carry.
 */
function connectUrl({ mode, gateway, dialKhz, bw } = {}) {
  if (mode === 'telnet') return 'telnet';
  if (!_isGatewayCall(gateway)) return null;
  const scheme = mode === 'ardop' ? 'ardop' : mode === 'packet' ? 'ax25' : (mode === 'mercury' || mode === 'vara') ? 'varahf' : null;
  if (!scheme) return null;
  const params = [];
  if (scheme === 'varahf' && bw) params.push(`bw=${Number(bw)}`);
  const f = Number(dialKhz);
  if (Number.isFinite(f) && f > 0) params.push(`freq=${+f.toFixed(2)}`);
  return `${scheme}:///${String(gateway).toUpperCase()}${params.length ? '?' + params.join('&') : ''}`;
}

/**
 * The URL for a session to a gateway picked from the list. Winlink's own row
 * URL is used when it names the SAME gateway on the transport this mode uses
 * — it carries what the gateway offers (ARDOP "bw=2000MAX" from the list;
 * without it Pat falls back to our 500 Hz default, a quarter of the speed).
 * Anything else (no row URL, another call, another scheme, a host part) is
 * ignored and the URL is built from the parts.
 */
function sessionUrl({ mode, gateway, dialKhz, bw, rowUrl } = {}) {
  const built = connectUrl({ mode, gateway, dialKhz, bw });
  if (!built || mode === 'telnet' || !rowUrl) return built;
  const want = built.slice(0, built.indexOf(':///') + 4) + String(gateway).toUpperCase();
  const m = /^([a-z0-9]+):\/\/\/([A-Z0-9-]+)(\?[A-Za-z0-9=&.%-]*)?$/i.exec(String(rowUrl));
  if (!m) return built;
  if (`${m[1].toLowerCase()}:///${m[2].toUpperCase()}` !== want) return built;
  // Mercury rides Pat's varahf transport; its bw values are VARA's.
  return `${want}${m[3] || ''}`;
}

function _freq(v) {
  if (v && typeof v === 'object') return Number(v.hz) || 0;
  return Number(v) || 0;
}

/**
 * Pat's /api/rmslist array → POTACAT gateway rows. Pat sorts (by predicted
 * link quality, else distance) and that order is kept; `band` filters by the
 * DIAL frequency's band.
 */
function normalizeRmslist(list, { band } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (!r || !r.callsign) continue;
    const freqHz = _freq(r.freq);
    const dialHz = _freq(r.dial) || freqHz;
    const b = dialHz ? freqToBand(dialHz / 1e6) : null;
    if (band && b !== band) continue;
    out.push({
      call: String(r.callsign).toUpperCase(),
      grid: r.gridsquare || '',
      distKm: Number.isFinite(Number(r.distance)) ? Math.round(Number(r.distance)) : null,
      bearing: Number.isFinite(Number(r.azimuth)) ? Math.round(Number(r.azimuth)) : null,
      modes: r.modes || '',
      freqKhz: freqHz ? freqHz / 1000 : null,
      dialKhz: dialHz ? dialHz / 1000 : null,
      band: b,
      url: typeof r.url === 'string' ? r.url : (r.url && r.url.String) || '',
      quality: r.prediction && Number.isFinite(Number(r.prediction.link_quality)) ? Number(r.prediction.link_quality) : null,
    });
  }
  return out;
}

function _addr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  // wl2k-go fbb.Address marshals as {Proto, Addr}; SMTP addresses are full emails.
  return a.Addr || a.addr || '';
}

/** One Pat JSONMessage (list form or full form) → POTACAT's message shape. */
function normalizeMessage(m, box) {
  if (!m || !m.MID) return null;
  const files = Array.isArray(m.Files) ? m.Files : [];
  return {
    mid: String(m.MID),
    box: box || '',
    from: _addr(m.From),
    to: (Array.isArray(m.To) ? m.To : []).map(_addr).filter(Boolean),
    cc: (Array.isArray(m.Cc) ? m.Cc : []).map(_addr).filter(Boolean),
    subject: String(m.Subject || ''),
    date: m.Date || '',
    read: box === 'in' ? !m.Unread : true,
    p2pOnly: !!m.P2POnly,
    attachments: files.map((f) => ({ name: String((f && (f.Name || f.name)) || ''), size: Number((f && (f.Size || f.size)) || 0) })).filter((f) => f.name),
    ...(typeof m.Body === 'string' ? { body: m.Body } : {}),
  };
}

function normalizeMailbox(list, box) {
  return (Array.isArray(list) ? list : []).map((m) => normalizeMessage(m, box)).filter(Boolean);
}

/** Split a To/Cc field the way an operator types it: commas, semicolons, spaces. */
function splitAddresses(s) {
  return String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Validate and shape an outgoing message for POST /api/mailbox/out. Returns
 * {ok, error?, fields?}; `fields` are the form fields (Pat requires an
 * RFC3339 `date`).
 */
function composeFields({ to, cc, subject, body, p2p, date } = {}) {
  const toList = Array.isArray(to) ? to.flatMap(splitAddresses) : splitAddresses(to);
  const ccList = Array.isArray(cc) ? cc.flatMap(splitAddresses) : splitAddresses(cc);
  if (!toList.length) return { ok: false, error: 'Add at least one recipient' };
  const bad = [...toList, ...ccList].find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) && !/^[A-Z0-9/-]{3,}$/i.test(a));
  if (bad) return { ok: false, error: `"${bad}" is not a callsign or an email address` };
  const subj = String(subject || '').trim();
  if (!subj) return { ok: false, error: 'Add a subject' };
  const d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) return { ok: false, error: 'Bad date' };
  return {
    ok: true,
    fields: {
      to: toList.join(','),
      cc: ccList.join(','),
      subject: subj.slice(0, 128),
      body: String(body || '').replace(/\r?\n/g, '\r\n'),
      ...(p2p ? { p2ponly: 'true' } : {}),
      date: d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
  };
}

// Log lines Pat writes during a session, classified so POTACAT can say one
// actionable thing instead of relaying Pat's log. Matched case-insensitively.
const LINE_RULES = [
  { kind: 'login-failed', re: /secure login failed|invalid password|password.*(incorrect|rejected|failed)|\[\*\*\*\s*secure login/i },
  { kind: 'no-answer', re: /no answer|connect timeout|timed? ?out.*connect|connection refused|target.*not responding|i\/o timeout/i },
  { kind: 'busy', re: /waiting for clear channel|channel busy/i },
  { kind: 'transport-down', re: /dial tcp.*(refused|no connection)|unable to (connect to|open) (ardop|vara|tnc)|tnc.*not (running|reachable)/i },
  { kind: 'rig-refused', re: /unable to (get|set) rig frequency|not defined or not loaded|hamlib rig '.*' not loaded/i },
  { kind: 'exchange-done', re: /disconnected\.?$|exchange completed|session ended/i },
];

function classifyPatLine(line) {
  const s = String(line || '');
  for (const r of LINE_RULES) if (r.re.test(s)) return r.kind;
  return 'log';
}

/**
 * One /ws frame → {kind, ...}. Unknown frames are {kind:'unknown'} (Pat may
 * add types; they are ignored, never fatal).
 */
function classifyPatEvent(frame) {
  if (!frame || typeof frame !== 'object') return { kind: 'unknown' };
  if ('Ping' in frame) return { kind: 'ping' };
  if ('MyCall' in frame) return { kind: 'hello', mycall: String(frame.MyCall || '') };
  if (frame.Status) {
    const s = frame.Status;
    return { kind: 'status', connected: !!s.connected, dialing: !!s.dialing, remoteAddr: s.remote_addr || '', listeners: s.active_listeners || [] };
  }
  if (frame.Progress) {
    const p = frame.Progress;
    const total = Number(p.bytes_total) || 0;
    const done = Number(p.bytes_transferred) || 0;
    return {
      kind: 'progress', mid: p.mid || '', subject: p.subject || '',
      direction: p.receiving ? 'receiving' : p.sending ? 'sending' : '',
      bytes: done, total, pct: total ? Math.min(100, Math.round(done * 100 / total)) : 0, done: !!p.done,
    };
  }
  if (frame.Notification) return { kind: 'notification', title: frame.Notification.title || '', body: frame.Notification.body || '' };
  if (frame.Prompt) return { kind: 'prompt', id: frame.Prompt.id, prompt: frame.Prompt.kind, message: frame.Prompt.message || '', options: frame.Prompt.options || [] };
  if (frame.PromptAbort) return { kind: 'prompt-abort', id: frame.PromptAbort.id };
  if ('UpdateMailbox' in frame) return { kind: 'mailbox-changed' };
  if ('LogLine' in frame) {
    const text = String(frame.LogLine || '');
    return { kind: 'log', text, class: classifyPatLine(text) };
  }
  return { kind: 'unknown' };
}

/**
 * The answer POTACAT gives a Pat prompt on its own, or null when the operator
 * must answer. The secure-login password is the profile's (never a typed
 * guess); multi-select only appears past the auto-download limit, which
 * POTACAT sets to unlimited — accept everything if it ever shows.
 */
function autoPromptAnswer(ev, { password } = {}) {
  if (!ev || ev.kind !== 'prompt') return null;
  if (ev.prompt === 'password') return password ? password : null;
  if (ev.prompt === 'multi-select') return (ev.options || []).map((o) => o.value).join(',');
  return null; // busy-channel, (pre-)account-activation: the operator decides
}

module.exports = {
  PAT_DEFAULTS,
  WINLINK_MODES,
  patBinaryName,
  patPathCandidates,
  buildPatArgs,
  buildPatConfig,
  patLocator,
  connectUrl,
  sessionUrl,
  normalizeRmslist,
  normalizeMessage,
  normalizeMailbox,
  splitAddresses,
  composeFields,
  classifyPatLine,
  classifyPatEvent,
  autoPromptAnswer,
};
