'use strict';
// TS-2000 CAT over TCP for N1MM+ (NK8Q 2026-10-23): replies POTACAT's own
// Kenwood codec parses, and a real socket round trip.
const assert = require('assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const T = require('../lib/ts2000-cat-server');
let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };
const st = { freqHz: 14074000, mode: 'DIGU', ptt: false, smeter: 120, powerW: 60, wpm: 25 };
(async () => {
  const ifr = T.handleTs2000Command('IF', st).reply;
  assert.strictEqual(ifr.length, 38); assert.strictEqual(ifr.slice(2, 13), '00014074000'); assert.strictEqual(ifr[28], '0'); assert.strictEqual(ifr[29], '2');
  assert.strictEqual(T.handleTs2000Command('IF', { ...st, ptt: true, mode: 'CW' }).reply[28], '1');
  ok('IF; is the 38-character status line (freq, TX at 28, mode at 29)');
  assert.strictEqual(T.handleTs2000Command('FA', st).reply, 'FA00014074000;');
  assert.deepStrictEqual(T.handleTs2000Command('FA00007030000', st).action, { setFreqHz: 7030000 });
  assert.deepStrictEqual(T.handleTs2000Command('MD3', st).action, { setMode: 'CW' });
  assert.strictEqual(T.handleTs2000Command('MD', { ...st, mode: 'SSB', freqHz: 7200000 }).reply, 'MD1;');
  assert.deepStrictEqual(T.handleTs2000Command('TX', st).action, { ptt: true });
  assert.deepStrictEqual(T.handleTs2000Command('RX', st).action, { ptt: false });
  assert.deepStrictEqual(T.handleTs2000Command('KY CQ TEST K3SBP  ', st).action, { cw: 'CQ TEST K3SBP' });
  assert.strictEqual(T.handleTs2000Command('ID', st).reply, 'ID019;');
  assert.strictEqual(T.handleTs2000Command('ZZ', st).reply, '?;');
  ok('FA/MD/TX/RX/KY/ID map to actions and replies');
  // Field positions a Kenwood client reads (Hamlib kenwood.c): freq = chars
  // 2..12, TX = 28, mode = 29, split = 32, ';' = 37.
  assert.strictEqual(parseInt(ifr.slice(2, 13), 10), 14074000);
  assert.strictEqual(ifr[32], '0');
  assert.strictEqual(ifr[37], ';');
  ok('the IF line carries freq/TX/mode/split where Kenwood clients read them');
  // Socket round trip, several commands in one write.
  const actions = [];
  const srv = T.createTs2000Server({ getState: () => st, onAction: (a) => actions.push(a) }, { host: '127.0.0.1', port: 0 });
  await new Promise((r) => srv.on('listening', r));
  const port = srv.address().port;
  const got = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('FA;MD;FA00021074000;TX;'));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('MD2;')) { s.end(); resolve(buf); } });
  });
  await new Promise((r) => setTimeout(r, 50));
  srv.close();
  assert.strictEqual(got, 'FA00014074000;MD2;');
  assert.deepStrictEqual(actions, [{ setFreqHz: 21074000 }, { ptt: true }]);
  ok('a real TCP client gets replies in order and its sets reach POTACAT');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/createTs2000Server\([\s\S]{0,1200}?\{ host: '127\.0\.0\.1', port \}\)/.test(main), 'loopback only');
  assert.ok(/if \(_loggerCatPtt && !_loggerCatClients\) \{ _loggerCatPtt = false; handleRemotePtt\(false\);/.test(main), 'a dropped logger releases PTT');
  assert.ok(/try \{ stopLoggerCat\(\); \} catch \{\}/.test(main), 'stopped at quit');
  ok('wired in main: loopback, PTT released on disconnect, stopped at quit');
  console.log(`Logger CAT: ${n} passed, 0 failed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
