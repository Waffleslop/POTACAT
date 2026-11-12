// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// VARA HF / VARA FM — the operator's OWN copy of EA5HVK's closed-source
// modems: on Windows, under Wine on Linux or macOS, or on another PC (#287).
// Nothing of VARA ships with POTACAT, is downloaded by it, or is licensed
// through it (docs/vara-integration-plan.md; Casey 2026-10-22: open modems
// first, VARA only as something the operator already has). POTACAT starts it
// only on Windows for a copy on this PC; everywhere else it only connects.
//
// What POTACAT does with it: finds the program (or takes a path), probes its
// command port (VARA answers `VERSION` on its TCP command port, the same
// protocol Mercury speaks), starts it detached when a session needs it and it
// is not running — and NEVER stops it: it is a window the operator is looking
// at — then points Pat's varahf / varafm transport at the port. PTT comes back
// through Pat and POTACAT's rigctld shim like every other mode, so VARA's own
// PTT must be set to None (the copy says so everywhere VARA is mentioned).
//
// Audio: VARA can only open a Windows sound device. The recommended route is a
// virtual audio cable (two of them, one each way), which POTACAT's modem audio
// bridge joins to the radio exactly as it carries ARDOP (`rig.modemCable`,
// main.js); the fallback is VARA opening the radio's own sound card.
//
// Pure apart from probeVaraPort (one loopback TCP connect). Tests:
// test/winlink-vara-test.js.

'use strict';

const net = require('net');

const VARA_DEFAULTS = Object.freeze({
  hfPort: 8300,
  fmPort: 8310,          // VARA FM ships on 8300 too; the help text tells the operator to set 8310
  probeTimeoutMs: 2000,
  launchWaitMs: 15000,
});
const KINDS = Object.freeze(['hf', 'fm']);

function varaName(kind) { return kind === 'fm' ? 'VARA FM' : 'VARA HF'; }
function varaModeId(kind) { return kind === 'fm' ? 'varafm' : 'vara'; }
function kindOfMode(mode) { return mode === 'varafm' ? 'fm' : mode === 'vara' ? 'hf' : null; }
function varaBinaryName(kind) { return kind === 'fm' ? 'VARAFM.exe' : 'VARA.exe'; }

/** Where VARA installs itself (its installer offers C:\VARA and C:\VARA FM), after the operator's own path. */
function varaPathCandidates({ settings, kind, env = process.env } = {}) {
  const out = [];
  const own = settings && (kind === 'fm' ? settings.winlinkVaraFmPath : settings.winlinkVaraHfPath);
  if (own) out.push(String(own));
  const dir = kind === 'fm' ? 'VARA FM' : 'VARA';
  const bin = varaBinaryName(kind);
  out.push(`C:\\${dir}\\${bin}`);
  for (const root of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]) {
    if (root) out.push(`${root}\\${dir}\\${bin}`);
  }
  return out;
}

function varaPortFor(settings, kind) {
  const raw = settings && (kind === 'fm' ? settings.winlinkVaraFmPort : settings.winlinkVaraPort);
  const n = parseInt(raw, 10);
  return n > 0 && n < 65536 ? n : (kind === 'fm' ? VARA_DEFAULTS.fmPort : VARA_DEFAULTS.hfPort);
}

// Where VARA runs (#287, Casey 2026-11-11: "I want mac, Linux and windows to
// have all available modems"). On Windows it is usually this PC; on Linux and
// macOS it is VARA under Wine on this computer, or a Windows PC on the LAN.
// POTACAT only ever talks to its TCP ports, so the host is all that changes.
const DEFAULT_HOST = '127.0.0.1';

/** A host the operator typed → a clean one, '' → 127.0.0.1, anything unsafe → null. */
function normalizeVaraHost(raw) {
  let h = String(raw == null ? '' : raw).trim();
  if (!h) return DEFAULT_HOST;
  if (/^\[.*\]$/.test(h)) h = h.slice(1, -1);
  // A name, an IPv4 or an IPv6 address: letters, digits, dots, dashes, colons.
  if (h.length > 253 || !/^[A-Za-z0-9.:-]+$/.test(h)) return null;
  // One colon is "host:port", not an address (IPv6 has two or more): the port
  // has its own box, and "[192.168.1.5:8300]:8300" would reach Pat otherwise.
  if (h.split(':').length === 2) return null;
  // A name starts and ends with a letter or digit.
  if (!h.includes(':') && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h)) return null;
  return h;
}

/** Why a typed host was refused, in the operator's words. */
function varaHostProblem(raw) {
  const h = String(raw == null ? '' : raw).trim().slice(0, 60);
  if (/^[^:\s]+:\d+$/.test(h)) return `"${h}" has a port in it. Type only the computer's name or address in Host; the port goes in the Port box`;
  return `"${h}" is not a computer name or address`;
}

/** This computer? (Only then can POTACAT start VARA, and only on Windows.) */
function isLocalVaraHost(host) {
  // 127.x.x.x as an address only: "127.example.com" is a name on the network.
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function varaHostFor(settings, kind) {
  const raw = settings && (kind === 'fm' ? settings.winlinkVaraFmHost : settings.winlinkVaraHost);
  return normalizeVaraHost(raw) || DEFAULT_HOST;
}

/** host:port for Pat (IPv6 in brackets). */
function varaAddr(host, port) {
  const h = normalizeVaraHost(host) || DEFAULT_HOST;
  return (h.includes(':') ? `[${h}]` : h) + ':' + port;
}

/** POTACAT starts VARA only for a copy on this Windows PC; anywhere else it only connects. */
function canLaunchVara({ platform, host } = {}) {
  return platform === 'win32' && isLocalVaraHost(host);
}

/**
 * "Where": words for the log and for the operator. A remote host carries the
 * audio note: VARA's audio then runs on that PC, not through this one.
 */
function varaWhere(host, port) {
  return isLocalVaraHost(host) ? `127.0.0.1:${port}` : `${host}:${port} (another computer: VARA's audio runs there)`;
}

/** `VERSION VARA HF v4.8.7` → 'VARA HF v4.8.7'; anything else → null. */
function parseVaraVersion(line) {
  const m = /^\s*VERSION\s+(.+?)\s*$/i.exec(String(line || ''));
  return m ? m[1] : null;
}

/**
 * Launch options: detached, its own window, nothing piped. POTACAT never
 * kills what it started this way (JS8Call rule) — a session end leaves the
 * modem for the next one.
 */
function varaSpawnOptions() {
  return { detached: true, stdio: 'ignore', windowsHide: false };
}

/**
 * Is a VARA answering on 127.0.0.1:<port>? Connects, asks VERSION, waits up
 * to timeoutMs for the reply. A port that accepts the connection but says
 * nothing is still reported `ok` (`silent: true`): some builds answer only
 * after a command they recognise, and an open port is the thing a session
 * needs. Connection refused is the one certain "not running".
 * @returns {Promise<{ok:boolean, version?:string, silent?:boolean, error?:string}>}
 */
function probeVaraPort(port, { host = '127.0.0.1', timeoutMs = VARA_DEFAULTS.probeTimeoutMs } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const sock = net.connect({ port, host });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish(sock.connecting ? { ok: false, error: 'timeout' } : { ok: true, version: '', silent: true }), timeoutMs);
    sock.setNoDelay(true);
    sock.on('connect', () => { try { sock.write('VERSION\r'); } catch {} });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (const line of buf.split(/\r?\n|\r/)) {
        const v = parseVaraVersion(line);
        if (v) return finish({ ok: true, version: v });
      }
      if (buf.length > 4096) buf = buf.slice(-1024);
    });
    sock.on('error', (e) => finish({ ok: false, error: e && e.code === 'ECONNREFUSED' ? 'refused' : (e && e.code) || 'error' }));
    sock.on('close', () => { if (!done) finish(buf ? { ok: true, version: '', silent: true } : { ok: false, error: 'closed' }); });
  });
}

/**
 * What the Settings "Test" button says for a VARA that POTACAT does not start
 * (Linux, macOS, or another computer): whether it answered, and if not, the
 * one thing to check.
 */
function varaTestText(kind, { probe, host, port } = {}) {
  const name = varaName(kind);
  const h = host || DEFAULT_HOST;
  const at = `${h.includes(':') ? '[' + h + ']' : h}:${port}`;
  const there = isLocalVaraHost(h) ? '' : ' on that computer';
  if (probe && probe.ok && probe.version) return `${name} answered at ${at} (${probe.version}).`;
  if (probe && probe.ok) return `A program answered at ${at} but did not give a VARA version. If it is ${name}, it is ready.`;
  const err = (probe && probe.error) || '';
  if (err === 'ENOTFOUND' || err === 'EAI_AGAIN') return `No computer named "${h}" was found on your network. Check the name, or type its address.`;
  if (err === 'refused') return `${name} did not answer at ${at}. Start ${name}${there} and check that its TCP port is ${port}.`;
  if (isLocalVaraHost(h)) return `No answer at ${at}. Start ${name} and check that its TCP port is ${port}.`;
  return `No answer at ${at}. Check that the computer is on, that ${name} is running there with its TCP port set to ${port}, and that its firewall lets this computer in.`;
}

/**
 * One line for the log / bug report. `launches` false (Linux, macOS, or a
 * VARA on another computer): POTACAT never looks for the program there, so
 * the line names where it connects instead.
 */
function describeVara(kind, { enabled, found, path, probe, host, port, launches = true } = {}) {
  const name = varaName(kind);
  if (!enabled) return `${name} off`;
  const where = !launches
    ? `at ${varaWhere(host || DEFAULT_HOST, port || (kind === 'fm' ? VARA_DEFAULTS.fmPort : VARA_DEFAULTS.hfPort))}, started by you`
    : (found ? `found${path ? ' at ' + path : ''}` : 'program not found');
  const run = probe ? (probe.ok ? `running${probe.version ? ' (' + probe.version + ')' : ''}` : `not running (${probe.error || 'no answer'})`) : 'not probed';
  return `${name} on, ${where}, ${run}`;
}

module.exports = {
  VARA_DEFAULTS,
  KINDS,
  varaName,
  varaModeId,
  kindOfMode,
  varaBinaryName,
  varaPathCandidates,
  varaPortFor,
  DEFAULT_HOST,
  normalizeVaraHost,
  varaHostProblem,
  isLocalVaraHost,
  varaHostFor,
  varaAddr,
  canLaunchVara,
  varaWhere,
  parseVaraVersion,
  varaSpawnOptions,
  probeVaraPort,
  describeVara,
  varaTestText,
};
