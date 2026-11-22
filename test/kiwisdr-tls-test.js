#!/usr/bin/env node
'use strict';
/**
 * KiwiSDR over TLS. A KiwiSDR whose owner turned on HTTPS answers only TLS on
 * its port: the browser opened it, POTACAT's plain ws:// handshake got
 * "socket hang up" (DL0HC, https://kiwi.770net.de:8073/, 2026-11-14). An
 * https:// entry now goes to wss:// at once, and a plain attempt that fails
 * on a host that was reached is tried once more over wss://.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const WebSocket = require('ws');
const { KiwiSdrClient } = require('../lib/kiwisdr');
const { getOrCreateTlsCert } = require('../lib/remote-server');
const { readSrc } = require('./_src');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (s) => Buffer.concat([Buffer.from('MSG '), Buffer.from(s)]);

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-kiwi-tls-'));
const { cert, key } = getOrCreateTlsCert(certDir, {});

/** A fake Kiwi on `server` (http or https): counts the sockets that open. */
function fakeKiwi(server) {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ server });
    const k = { opened: 0, close: () => { wss.close(); server.close(); } };
    wss.on('connection', (ws) => {
      k.opened++;
      setTimeout(() => ws.send(msg('audio_init=0 audio_rate=12000')), 20);
    });
    server.listen(0, '127.0.0.1', () => { k.port = server.address().port; resolve(k); });
  });
}
const tlsKiwi = () => fakeKiwi(https.createServer({ cert, key }));
const plainKiwi = () => fakeKiwi(http.createServer());

/** Connect and collect what the client reports for `ms`. */
async function run(port, opts, ms = 1500) {
  const c = new KiwiSdrClient({ tlsOptions: { rejectUnauthorized: false } });
  const seen = { connected: 0, errors: [], disconnected: 0, logs: [] };
  c.on('connected', () => seen.connected++);
  c.on('error', (e) => seen.errors.push(e));
  c.on('disconnected', () => seen.disconnected++);
  c.on('log', (l) => seen.logs.push(l));
  c.connect('127.0.0.1', port, '', 'DA2PK', opts);
  await wait(ms);
  return { c, seen };
}

(async () => {
  console.log('A receiver that answers only TLS');
  await check('a plain entry falls back to wss:// once and connects, with no error on the way', async () => {
    const k = await tlsKiwi();
    const { c, seen } = await run(k.port);
    assert.strictEqual(seen.connected, 1);
    assert.deepStrictEqual(seen.errors, []);
    assert.strictEqual(seen.disconnected, 0, 'the given-up plain socket says nothing');
    assert.strictEqual(c.tls, true);
    assert.ok(seen.logs.some((l) => /trying TLS \(wss:\/\/\)/.test(l)), seen.logs.join(' | '));
    c.disconnect(); k.close();
  });
  await check('an https:// entry (tls: true) goes to wss:// at once', async () => {
    const k = await tlsKiwi();
    const { c, seen } = await run(k.port, { tls: true });
    assert.strictEqual(seen.connected, 1);
    assert.strictEqual(k.opened, 1);
    assert.ok(!seen.logs.some((l) => /trying TLS/.test(l)), 'no plain attempt first');
    c.disconnect(); k.close();
  });

  console.log('Receivers that are not TLS');
  await check('a plain receiver stays plain', async () => {
    const k = await plainKiwi();
    const { c, seen } = await run(k.port);
    assert.strictEqual(seen.connected, 1);
    assert.strictEqual(c.tls, false);
    c.disconnect(); k.close();
  });
  await check('a host that was not reached is not tried again over TLS', async () => {
    const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const { c, seen } = await run(free, {}, 600);
    assert.strictEqual(seen.connected, 0);
    assert.strictEqual(seen.errors.length, 1);
    assert.strictEqual(c.tls, false);
    assert.ok(!seen.logs.some((l) => /trying TLS/.test(l)));
  });
  await check('both tries failing gives one error, not two', async () => {
    // A server that drops every socket: plain and TLS both fail.
    const s = net.createServer((sock) => sock.destroy());
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const { seen } = await run(s.address().port, {}, 800);
    assert.strictEqual(seen.connected, 0);
    assert.strictEqual(seen.errors.length, 1, seen.errors.join(' | '));
    s.close();
  });
  await check('disconnect() after a TLS connect still reports disconnected', async () => {
    const k = await tlsKiwi();
    const { c, seen } = await run(k.port, { tls: true }, 600);
    c.disconnect();
    await wait(300);
    assert.strictEqual(seen.disconnected, 1);
    k.close();
  });

  console.log('Wiring');
  await check('the VFO window and main carry the https:// choice to the client', () => {
    const vfo = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
    const main = readSrc(path.join(__dirname, '..', 'main.js'));
    assert.ok(/fullHost: clean, tls: \/\^\\s\*https:\\\/\\\/\/i\.test\(host\) \}\);/.test(vfo));
    assert.ok(vfo.includes('window.api.kiwiConnect({ host: st.host, port: st.port, tls: !!st.tls });'));
    assert.ok(main.includes("const tls = tlsAsked === true || /^https:\\/\\//i.test(hostIn.trim());"));
    assert.ok(main.includes("kiwiClient.connect(host, port, stationPassword, settings.myCallsign || '', { tls });"));
  });

  try { fs.rmSync(certDir, { recursive: true, force: true }); } catch {}
  console.log(`\nKiwiSDR TLS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
