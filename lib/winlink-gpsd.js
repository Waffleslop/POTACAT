// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The grid's position for Pat's Winlink forms (#346): a GPSd stand-in.
//
// Casey 2026-11-19: forms that ask for the location are answered from
// POTACAT's grid. The Winlink forms never ask the browser; Pat fills their
// {Latitude}, {Longitude}, {GridSquare}, {GPS...} insertion tags from GPSd
// only (Pat v1.0.1 internal/forms/forms.go gpsPos, needs gpsd.allow_forms;
// builder.go insertionTagReplacer). So POTACAT answers Pat as a GPSd would,
// with the centre of the Settings grid, and nothing else.
//
// Pat v1.0.1's client (github.com/la5nta/pat at 2ad31e8, internal/gpsd/
// gpsd.go, objects.go): Dial reads one JSON object first and needs a VERSION
// with release != "" and proto_major >= 3; Watch(true) sends
// ?WATCH={"class":"WATCH","enable":true,"json":true} with no terminator and
// reads lines until a WATCH object; NextPosTimeout(3 s) reads TPV/SKY lines
// until a TPV with mode > 1; Close sends WATCH enable:false. Only the
// first object may be sent before Pat asks: its json.Decoder buffers ahead.
//
// Other GPSd users in Pat v1.0.1 stay off: enable_http (the web GUI proxy,
// api/api.go positionHandler) and update_locator (app/gpsd_locator.go) are
// false in POTACAT's config, and `pat position` (cli/position.go) is a
// command POTACAT never runs; its position report goes through
// /api/posreport with the latitude and longitude it is given. Nothing in Pat
// sends the position on its own because gpsd is set.
//
// The server binds 127.0.0.1 on a port chosen at start, refuses any peer that
// is not loopback, and is pointed at only by POTACAT's own Pat config.

'use strict';

const net = require('net');
const { geolocationFromGrid } = require('./winlink-forms');

const DEVICE = 'potacat-grid';

function line(o) { return JSON.stringify(o) + '\n'; }

/** The first object on a connection (Pat: release set, proto_major >= 3). */
function versionLine() {
  return line({ class: 'VERSION', release: 'POTACAT grid', rev: '', proto_major: 3, proto_minor: 11 });
}

/**
 * Commands in what a client sent: "?NAME" with an optional "=" and a JSON
 * object, ended by ";", a newline, or nothing (Pat sends no terminator).
 * An unfinished command is kept as `rest`; junk before a "?" is dropped.
 * @returns {{commands: Array<{name:string, params?:object}>, rest:string}}
 */
function parseCommands(buf) {
  let s = String(buf || '');
  const commands = [];
  for (;;) {
    const q = s.indexOf('?');
    if (q < 0) { s = ''; break; }
    s = s.slice(q);
    const m = /^\?([A-Z]+)/.exec(s);
    if (!m) { if (s.length < 2) break; s = s.slice(1); continue; }
    let i = m[0].length;
    if (i === s.length) break; // "?WATCH" may still get its "=..."
    let params;
    if (s[i] === '=') {
      const end = jsonEnd(s, i + 1);
      if (end < 0) break; // wait for the rest
      try { params = JSON.parse(s.slice(i + 1, end)); } catch { params = undefined; }
      i = end;
    }
    while (i < s.length && (s[i] === ';' || s[i] === '\r' || s[i] === '\n')) i++;
    commands.push(params === undefined ? { name: m[1] } : { name: m[1], params });
    s = s.slice(i);
  }
  return { commands, rest: s.length > 4096 ? '' : s };
}

/** The index just past the JSON object starting at s[from], or -1 when it is not complete yet. */
function jsonEnd(s, from) {
  if (s[from] !== '{') return from; // no object: the command ends here
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

function tpv(grid, now) {
  const geo = geolocationFromGrid(grid);
  const time = (now instanceof Date ? now : new Date()).toISOString();
  if (!geo) return { class: 'TPV', device: DEVICE, mode: 1, time };
  return { class: 'TPV', device: DEVICE, mode: 2, time, lat: geo.latitude, lon: geo.longitude, epx: geo.accuracy, epy: geo.accuracy };
}

/** A TPV line: the grid's centre as a 2D fix, or no fix (mode 1, no position) without a grid. */
function tpvLine(grid, now) { return line(tpv(grid, now)); }

/**
 * The answer to one command. WATCH on: the device, the WATCH, a TPV; with no
 * fix the connection then closes, so Pat stops waiting at once instead of
 * after its 3 s timeout (it then uses its own empty values).
 * @returns {{lines:string[], watching?:boolean, close:boolean}}
 */
function reply(cmd, grid, now) {
  const name = cmd && cmd.name;
  const devices = line({ class: 'DEVICES', devices: [{ class: 'DEVICE', path: DEVICE, driver: 'POTACAT grid square' }] });
  if (name === 'WATCH') {
    const on = !(cmd.params && cmd.params.enable === false);
    if (!on) return { lines: [line({ class: 'WATCH', enable: false, json: true })], watching: false, close: false };
    const t = tpv(grid, now);
    return { lines: [devices, line({ class: 'WATCH', enable: true, json: true }), line(t)], watching: true, close: t.mode < 2 };
  }
  if (name === 'VERSION') return { lines: [versionLine()], close: false };
  if (name === 'DEVICES') return { lines: [devices], close: false };
  if (name === 'POLL') {
    const t = tpv(grid, now);
    return { lines: [line({ class: 'POLL', time: t.time, active: 1, tpv: [t], sky: [] })], close: false };
  }
  return { lines: [line({ class: 'ERROR', message: 'Unrecognized request' })], close: false };
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::ffff:127.0.0.1' || addr === '::1';
}

/**
 * The server. `getGrid()` is read for every answer, so a grid changed in
 * Settings is used on the next form. start() resolves with the port.
 */
function createGridGpsd({ getGrid, intervalMs = 1000 } = {}) {
  const socks = new Set();
  let server = null;
  const self = {
    port: 0,
    address: '127.0.0.1',
    start() {
      return new Promise((resolve, reject) => {
        server = net.createServer((sock) => {
          if (!isLoopback(sock.remoteAddress) || socks.size >= 8) { sock.destroy(); return; }
          socks.add(sock);
          let buf = '', timer = null;
          const send = (s) => { try { sock.write(s); } catch { /* closed */ } };
          const stop = () => { clearInterval(timer); timer = null; };
          sock.setEncoding('utf8');
          sock.on('data', (d) => {
            const p = parseCommands(buf + d);
            buf = p.rest;
            for (const c of p.commands) {
              const r = reply(c, getGrid && getGrid(), new Date());
              for (const l of r.lines) send(l);
              if (r.close) { stop(); sock.end(); return; }
              if (r.watching === true && !timer) timer = setInterval(() => send(tpvLine(getGrid && getGrid(), new Date())), intervalMs);
              if (r.watching === false) stop();
            }
          });
          sock.on('error', () => {});
          sock.on('close', () => { stop(); socks.delete(sock); });
          send(versionLine());
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { self.port = server.address().port; resolve(self.port); });
      });
    },
    stop() {
      for (const s of socks) { try { s.destroy(); } catch { /* gone */ } }
      socks.clear();
      return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server = null; });
    },
  };
  return self;
}

module.exports = { versionLine, parseCommands, tpvLine, reply, createGridGpsd, isLoopback };
