#!/usr/bin/env node
'use strict';
/**
 * KiwiSDR client against a fake Kiwi (N9ZX 2026-10-30: "SDR quits after a
 * few seconds"). Firmware 1.902 streams audio only once the receiver
 * settings arrive AFTER `SET AR OK`; a receiver whose owner allows no apps
 * (ext_api_nchans 0) plays a preview, then sends too_busy=0 and closes.
 */
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { KiwiSdrClient } = require('../lib/kiwisdr');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const msg = (s) => Buffer.concat([Buffer.from('MSG '), Buffer.from(s)]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Kiwi: records what the client sends, runs `script(ws, sent)`. */
function fakeKiwi(script) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocket.Server({ server });
    const sent = [];
    wss.on('connection', (ws) => {
      ws.on('message', (d) => sent.push(String(d)));
      script(ws, sent);
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, sent, close: () => { wss.close(); server.close(); } }));
  });
}

(async () => {
  console.log('The audio handshake (firmware 1.902)');
  await check('the receiver settings are sent again after SET AR OK, tune first', async () => {
    const k = await fakeKiwi((ws) => setTimeout(() => ws.send(msg('audio_init=0 audio_rate=12000')), 50));
    const c = new KiwiSdrClient();
    c.on('connected', () => { c.tune(14074, 'usb'); c.setAgc(true); });
    c.connect('127.0.0.1', k.port, '', 'K3SBP');
    await wait(250);
    c.disconnect(); k.close();
    const ar = k.sent.findIndex((s) => s.startsWith('SET AR OK'));
    assert.ok(ar >= 0, 'AR OK sent');
    const after = k.sent.slice(ar + 1);
    assert.strictEqual(after[0], 'SET mod=usb low_cut=300 high_cut=2700 freq=14074.000');
    assert.ok(after[1].startsWith('SET agc=1'), after[1]);
    for (const s of ['SET squelch=0 param=0.00', 'SET gen=0 mix=-1', 'SET genattn=0', 'SET compression=0']) {
      assert.ok(after.includes(s), 'missing ' + s);
    }
  });

  console.log('A receiver that allows no apps');
  await check('too_busy=0 after load_cfg ext_api_nchans 0 is named, not a silent quit', async () => {
    const cfg = encodeURIComponent(JSON.stringify({ ext_api_nchans: 0, chan_no_pwd: 2 }));
    const k = await fakeKiwi((ws) => {
      ws.send(msg('load_cfg=' + cfg));
      setTimeout(() => ws.send(msg('too_busy=0')), 50);
    });
    const c = new KiwiSdrClient();
    const errors = [];
    c.on('error', (e) => errors.push(e));
    c.connect('127.0.0.1', k.port, '', 'K3SBP');
    await wait(250);
    c.disconnect(); k.close();
    assert.strictEqual(errors.length, 1, JSON.stringify(errors));
    assert.ok(/does not allow apps/.test(errors[0]), errors[0]);
  });
  await check('too_busy=0 on a receiver that allows apps stays a heartbeat', async () => {
    const cfg = encodeURIComponent(JSON.stringify({ ext_api_nchans: 2 }));
    const k = await fakeKiwi((ws) => {
      ws.send(msg('load_cfg=' + cfg));
      setTimeout(() => ws.send(msg('too_busy=0')), 50);
    });
    const c = new KiwiSdrClient();
    const errors = [];
    c.on('error', (e) => errors.push(e));
    c.connect('127.0.0.1', k.port, '', 'K3SBP');
    await wait(250);
    const still = c._connected;
    c.disconnect(); k.close();
    assert.deepStrictEqual(errors, []);
    assert.ok(still, 'still connected');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
