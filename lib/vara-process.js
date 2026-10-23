// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// VARA HF / VARA FM — the operator's OWN copy of EA5HVK's closed-source
// modems, on Windows. Nothing of VARA ships with POTACAT, is downloaded by it,
// or is licensed through it (docs/vara-integration-plan.md; Casey 2026-10-22:
// open modems first, VARA only as something the operator already has).
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

/** One line for the log / bug report. */
function describeVara(kind, { enabled, found, path, probe } = {}) {
  const name = varaName(kind);
  if (!enabled) return `${name} off`;
  const where = found ? `found${path ? ' at ' + path : ''}` : 'program not found';
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
  parseVaraVersion,
  varaSpawnOptions,
  probeVaraPort,
  describeVara,
};
