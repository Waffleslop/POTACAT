// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// A loopback rigctld-protocol server so an EXTERNAL program (Pat, the Winlink
// client) keys and tunes the radio THROUGH POTACAT instead of around it.
//
// Why: POTACAT owns the radio — one CAT link, one PTT dispatcher, the SWR
// latch, the radio-owner arbiter, rig presets. Pat's hamlib client is happy
// talking to anything that speaks rigctld on a TCP port, so instead of handing
// Pat a COM port (two programs on one serial port, PTT behind POTACAT's back)
// POTACAT answers the handful of commands Pat sends and routes them through
// the same paths every other surface uses.
//
// Pat's client (wl2k-go rigcontrol/hamlib/rigctld.go) sends ONLY:
//   dump_caps          ping — any line that is not "RPRT <n≠0>" means alive
//   \chk_vfo           we answer "CHKVFO 0" so Pat uses the current VFO
//   \get_freq          bare Hz
//   \set_freq <Hz>     RPRT 0 | RPRT -1
//   t                  0 | 1
//   \set_ptt <0|1|3>   RPRT 0 | RPRT -1
// one line each, CRLF, 1 s timeout, 3 attempts — and it reads exactly ONE
// reply line per command, so every reply here is one line. The plain one-letter forms
// (f, F, T) are accepted too, so `rigctl -m 2` can be used to test by hand.
//
// Replies are written BEFORE the radio work runs (the hooks are fire-and-
// forget): Pat's timeout is 1 s and a CAT round trip can be longer.
//
// This server binds 127.0.0.1 and nothing else — rigctld has no
// authentication, and a reachable one is a remote PTT for anyone on the LAN.

'use strict';

const net = require('net');

const RPRT_OK = 'RPRT 0';
const RPRT_EINVAL = 'RPRT -1';
const RPRT_ENAVAIL = 'RPRT -11';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** One request line → {cmd, args}. Long (backslash) and short forms map to the same cmd. */
function parseRigctldLine(line) {
  const s = String(line || '').trim();
  if (!s) return { cmd: '', args: [] };
  const parts = s.split(/\s+/);
  let head = parts[0];
  const args = parts.slice(1);
  // Extended-response prefixes (+ ; | ,) are not used by Pat; strip if present.
  if (/^[+;|,]/.test(head) && head.length > 1) head = head.slice(1);
  const map = {
    'dump_caps': 'ping', '\\dump_caps': 'ping', '1': 'ping',
    '\\chk_vfo': 'chk_vfo',
    '\\get_freq': 'get_freq', 'f': 'get_freq',
    '\\set_freq': 'set_freq', 'F': 'set_freq',
    '\\get_ptt': 'get_ptt', 't': 'get_ptt',
    '\\set_ptt': 'set_ptt', 'T': 'set_ptt',
    '\\get_vfo': 'get_vfo', 'v': 'get_vfo',
    'q': 'quit', '\\quit': 'quit',
  };
  return { cmd: map[head] || 'unknown', raw: head, args };
}

/**
 * The reply lines for one parsed request. `hooks` are synchronous readers
 * plus fire-and-forget actions; an action hook returns true when accepted.
 *
 * @param {{cmd:string,args:string[]}} req
 * @param {object} hooks
 * @param {()=>number} hooks.getFreqHz
 * @param {(hz:number)=>boolean} hooks.setFreqHz
 * @param {()=>boolean} hooks.getPtt
 * @param {(on:boolean)=>boolean} hooks.setPtt
 * @returns {string[]}
 */
function rigctldReply(req, hooks = {}) {
  switch (req.cmd) {
    case 'ping':
      // ONE line, always: Pat reads exactly one reply line per command, so
      // a multi-line dump_caps would be read as the answers to its NEXT
      // commands (get_freq would parse "Mfg name:").
      return ['Model name:\tPOTACAT'];
    case 'chk_vfo':
      return ['CHKVFO 0'];
    case 'get_vfo':
      return ['VFOA'];
    case 'get_freq': {
      const hz = Math.round(Number(hooks.getFreqHz && hooks.getFreqHz()) || 0);
      return [String(hz)];
    }
    case 'set_freq': {
      // With a VFO token ("\set_freq VFOA 7101000") the number is the last arg.
      const hz = Math.round(Number(req.args[req.args.length - 1]));
      if (!Number.isFinite(hz) || hz <= 0) return [RPRT_EINVAL];
      return [hooks.setFreqHz && hooks.setFreqHz(hz) ? RPRT_OK : RPRT_EINVAL];
    }
    case 'get_ptt':
      return [hooks.getPtt && hooks.getPtt() ? '1' : '0'];
    case 'set_ptt': {
      const v = parseInt(req.args[req.args.length - 1], 10);
      if (![0, 1, 2, 3].includes(v)) return [RPRT_EINVAL];
      return [hooks.setPtt && hooks.setPtt(v !== 0) ? RPRT_OK : RPRT_EINVAL];
    }
    case 'quit':
      return [];
    default:
      return [RPRT_ENAVAIL];
  }
}

/**
 * Start a loopback server. Throws on a non-loopback host — never "fix" that
 * by allowing 0.0.0.0.
 * @returns {{listen:(port:number)=>Promise<number>, close:()=>Promise<void>, address:()=>any, clients:()=>number}}
 */
function createRigctldServer(hooks, { host = '127.0.0.1', log } = {}) {
  if (!LOOPBACK.has(host)) throw new Error(`rigctld shim refuses to bind ${host} — loopback only`);
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setNoDelay(true);
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.length > 4096) { buf = ''; sock.destroy(); return; }
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1);
        const req = parseRigctldLine(line);
        if (!req.cmd) continue;
        if (req.cmd === 'quit') { sock.end(); return; }
        let lines;
        try { lines = rigctldReply(req, hooks); }
        catch (e) { lines = [RPRT_EINVAL]; if (log) log(`rigctld shim: ${req.raw} failed: ${e.message}`); }
        if (req.cmd === 'unknown' && log) log(`rigctld shim: unsupported command "${req.raw}"`);
        if (lines.length) sock.write(lines.join('\n') + '\n');
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
  });
  server.on('error', (e) => { if (log) log(`rigctld shim: ${e.message}`); });
  return {
    listen(port) {
      return new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(port, host);
      });
    },
    close() {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    address() { return server.address(); },
    clients() { return sockets.size; },
  };
}

module.exports = { parseRigctldLine, rigctldReply, createRigctldServer, RPRT_OK, RPRT_EINVAL, RPRT_ENAVAIL };
