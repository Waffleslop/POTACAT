#!/usr/bin/env node
'use strict';
/**
 * GridTracker as JTCAT's call roster (AE5JE 2026-10-28): POTACAT sends each
 * FT8/FT4 decode to the Extra UDP destination as a WSJT-X DECODE, and
 * GridTracker's double-click (REPLY) and stop (HALT_TX) come back to the
 * same socket and act in the JTCAT window.
 */
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const W = require('../lib/wsjtx');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const pending = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed++; console.log('  ok  ' + name); }, (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }));
      return;
    }
    passed++; console.log('  ok  ' + name);
  } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// A WsjtxClient parses the DECODE exactly as GridTracker's own reader does
// (it skips the id POTACAT, its own bridges' echo, so the tests use another)
// (both follow NetworkMessage.hpp field for field).
function readBack(buf) {
  const c = new W.WsjtxClient();
  let got = null;
  c.on('decode', (d) => { got = d; });
  c._handleMessage(buf, { address: '127.0.0.1', port: 1 });
  return got;
}
const slotStart = Date.UTC(2026, 9, 28, 14, 30, 15);   // 14:30:15 UTC

console.log('The DECODE');
check('a JTCAT decode reads back as WSJT-X wrote it: time of its slot, SNR, DT, DF, mode mark, text', () => {
  const dec = W.decodeFromJtcat({ text: 'CQ POTA K1ABC FN42 ', db: -12, dt: 0.34, df: 1234.6, slot: 'odd' }, 'FT8', slotStart);
  const got = readBack(W.encodeDecode('POTACAT-test', dec));
  assert.strictEqual(got.time, ((14 * 60 + 30) * 60 + 15) * 1000);
  assert.strictEqual(got.snr, -12);
  assert.strictEqual(got.deltaTime, 0.3);
  assert.strictEqual(got.deltaFrequency, 1235);
  assert.strictEqual(got.mode, '~');
  assert.strictEqual(got.message, 'CQ POTA K1ABC FN42');
  assert.strictEqual(got.isNew, true);
  assert.strictEqual(got.dxCall, 'K1ABC');
});
check('FT4 is "+"; an AP decode is marked low confidence', () => {
  const dec = W.decodeFromJtcat({ text: 'K3SBP K1ABC -05', db: -20, dt: 0, df: 900, ap: true }, 'FT4', slotStart);
  assert.strictEqual(dec.mode, '+');
  assert.strictEqual(dec.lowConfidence, true);
});

console.log('What comes back');
check('a REPLY (double-click) and a HALT_TX are recognised; heartbeats and highlights are not', () => {
  const dec = W.decodeFromJtcat({ text: 'CQ K1ABC FN42', db: -8, dt: 0.1, df: 1500 }, 'FT8', slotStart);
  const rep = W.parseBridgeInbound(W.encodeReply('GridTracker', dec, 0));
  assert.strictEqual(rep.type, 'reply');
  assert.strictEqual(rep.reply.message, 'CQ K1ABC FN42');
  assert.strictEqual(rep.reply.deltaFrequency, 1500);
  assert.strictEqual(rep.reply.time, dec.time);
  assert.deepStrictEqual(W.parseBridgeInbound(W.encodeHaltTx('GridTracker', true)), { type: 'halt', id: 'GridTracker', autoTxOnly: true });
  assert.strictEqual(W.parseBridgeInbound(W.encodeHeartbeat('GridTracker', 3)), null);
  assert.strictEqual(W.parseBridgeInbound(Buffer.from('nonsense')), null);
});
check('a reply to a decode no longer cached still finds its slot from its time', () => {
  assert.strictEqual(W.replySlot(((14 * 60 + 30) * 60 + 15) * 1000, '~'), 'odd');
  assert.strictEqual(W.replySlot(((14 * 60 + 30) * 60) * 1000, '~'), 'even');
  assert.strictEqual(W.replySlot(7500, '+'), 'odd');
});

check('over a real socket: GridTracker answers the port the decodes came from', () => new Promise((resolve, reject) => {
  const gt = dgram.createSocket('udp4');      // stands in for GridTracker on its listen port
  const bridge = dgram.createSocket('udp4');  // POTACAT's Extra UDP bridge: unbound until it sends
  const timer = setTimeout(() => { gt.close(); bridge.close(); reject(new Error('no reply came back')); }, 3000);
  gt.on('message', (buf, rinfo) => {
    const d = readBack(buf);
    if (!d) return;
    const back = W.encodeReply('GridTracker', d, 0);
    gt.send(back, 0, back.length, rinfo.port, rinfo.address);
  });
  bridge.on('message', (buf) => {
    const m = W.parseBridgeInbound(buf);
    clearTimeout(timer); gt.close(); bridge.close();
    try { assert.strictEqual(m.type, 'reply'); assert.strictEqual(m.reply.message, 'CQ K1ABC FN42'); resolve(); }
    catch (e) { reject(e); }
  });
  gt.bind(0, '127.0.0.1', () => {
    const buf = W.encodeDecode('POTACAT-test', W.decodeFromJtcat({ text: 'CQ K1ABC FN42', db: -8, dt: 0.1, df: 1500 }, 'FT8', slotStart));
    bridge.send(buf, 0, buf.length, gt.address().port, '127.0.0.1');
  });
}));

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const fnOf = (name, len = 2500) => main.slice(main.indexOf('function ' + name + '('), main.indexOf('function ' + name + '(') + len);
check('every FT8/FT4 decode batch goes to the Extra UDP bridge, after a Status, unless turned off', () => {
  assert.ok(/pskrQueueDecodes\(data\);\s*\r?\n\s*\/\/ GridTracker[^\n]*\r?\n\s*gridTrackerSendDecodes\(data\);/.test(main));
  assert.ok(/return !!extraUdpBridge\.socket && settings\.extraUdpDecodes !== false;/.test(main));
  assert.ok(/sendDecodes\(decodes, statusOver\) \{\s*if \(!this\.socket \|\| !decodes\.length\) return;\s*this\._sendStatus\(statusOver\);/.test(main));
});
check('the bridge listens on its own socket; a reply becomes a JTCAT double-click, a halt the Halt button', () => {
  assert.ok(/this\.socket\.on\('message', \(buf, rinfo\) => \{ if \(this\.onInbound\) this\.onInbound\(buf, rinfo\); \}\);/.test(main));
  assert.ok(/extraUdpBridge\.onInbound = gridTrackerInbound;/.test(main));
  const inb = fnOf('gridTrackerInbound');
  assert.ok(/jtcatPopoutWin\.webContents\.send\('jtcat-external-reply', d\)/.test(inb) && /webContents\.send\('jtcat-external-halt'\)/.test(inb));
  assert.ok(/open the JTCAT window/.test(inb), 'with no JTCAT window it says what to do');
  const pop = fs.readFileSync(path.join(ROOT, 'renderer/jtcat-popout.js'), 'utf8');
  assert.ok(/onJtcatExternalReply\(function\(d\) \{ onDecodeRowClick\(d\); \}\)/.test(pop));
  assert.ok(/onJtcatExternalHalt\(function\(\) \{ haltTxBtn\.click\(\); \}\)/.test(pop));
});
check('Settings: on by default, saved and loaded', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert.ok(/id="set-extra-udp-decodes" checked/.test(html));
  assert.ok(/setExtraUdpDecodes\.checked = s\.extraUdpDecodes !== false;/.test(app) && /extraUdpDecodes: setExtraUdpDecodes \? setExtraUdpDecodes\.checked : true,/.test(app));
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
