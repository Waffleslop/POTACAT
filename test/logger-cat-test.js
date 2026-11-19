'use strict';
const { readSrc } = require('./_src');
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
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/createTs2000Server\([\s\S]{0,1200}?\{ host: '127\.0\.0\.1', port \}\)/.test(main), 'loopback only');
  assert.ok(/if \(_loggerCatPtt && !_loggerCatClients\) \{ loggerCatAction\(\{ ptt: false \}\);/.test(main), 'a dropped logger releases PTT (on every route)');
  assert.ok(/try \{ stopLoggerCat\(\); \} catch \{\}/.test(main), 'stopped at quit');
  ok('wired in main: loopback, PTT released on disconnect, stopped at quit');
  // #770: on the Yaesu LAN a logger (fldigi, GTTY, WSJT-X through Hamlib's
  // TS-2000) keys through the VFO window's own PTT, which sends its PTT
  // microphone over the LAN; without the window it is refused, never keyed silent.
  assert.ok(/typeof a\.ptt === 'boolean'\) \{[\s\S]{0,400}if \(yaesuLanVoiceRoute\(\)\) \{ loggerCatLanPtt\(a\.ptt\); return; \}[\s\S]{0,80}if \(a\.ptt && yaesuLanTxRefusal\(\)\)/.test(main), 'the LAN route goes to the window before the old refusal');
  const lanPtt = main.slice(main.indexOf('function loggerCatLanPtt('), main.indexOf('function startLoggerCat('));
  assert.ok(/if \(on && !vfo\) \{\s*_loggerCatPtt = false;[\s\S]{0,120}open the VFO window[\s\S]{0,200}return;\s*\}/.test(lanPtt), 'no VFO window: refused, the logger not told TX');
  assert.ok(/_loggerCatPtt = on;\s*if \(vfo\) vfo\.webContents\.send\('external-ptt', \{ on, who: 'logger CAT' \}\);/.test(lanPtt), 'press and release go to the window');
  assert.ok(!/handleRemotePtt/.test(lanPtt), 'no key-down of its own: the window keys');
  const preload = readSrc(path.join(__dirname, '..', 'preload-vfo-popout.js'));
  assert.ok(/onExternalPtt: \(cb\) => ipcRenderer\.on\('external-ptt', \(_e, d\) => cb\(d\)\),/.test(preload));
  const vfo = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
  assert.ok(/window\.api\.onExternalPtt\(\(d\) => \{ if \(d && d\.on\) pttStart\(\); else pttStop\(\); \}\);/.test(vfo), 'the window presses its PTT');
  assert.ok(/if \(_loggerCatPtt\) \{ try \{ loggerCatAction\(\{ ptt: false \}\); \} catch \{\} _loggerCatPtt = false; \}/.test(main), 'stopping Logger CAT releases on every route');
  ok('Yaesu LAN: a logger keys through the VFO window\'s PTT, refused without the window (#770)');
  console.log(`Logger CAT: ${n} passed, 0 failed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
