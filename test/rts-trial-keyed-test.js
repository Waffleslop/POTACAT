#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Transmit-safety review of 2397429c and the RTS/CTS trial (MEDIUM): every
// Yaesu now opens with its lines low, so a stock radio whose CAT RTS menu is
// on answers nothing and gets the RTS/CTS trial. RTS is also a PTT line: on a
// radio whose PTT SELECT is RTS the trial keyed it, and RTS/CTS was then
// saved, keying it at every connect. Now: if the radio reports transmit within
// 2 s of answering with RTS up, the trial is reverted and the operator told.
// Runs main's own trial functions.
// Run: node test/rts-trial-keyed-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function load() {
  const src = main.slice(main.indexOf('function armSerialHandshakeNoAnswerTrial('), main.indexOf('async function connectCat() {'));
  const rigCat = new EventEmitter();
  rigCat._transmitting = false;
  rigCat.txOff = 0;
  rigCat.setTransmit = (on) => { if (!on) rigCat.txOff++; };
  const transport = new EventEmitter();
  const ctx = {
    console, setTimeout, clearTimeout, Map,
    _serialHsTrial: new Map([['COM5', 'hardware']]),
    SERIAL_HS_NOANSWER_MS: 5000, SERIAL_HS_KEY_WATCH_MS: 40,
    settings: { rigs: [{ catTarget: { type: 'serial', path: 'COM5' } }], catTarget: { type: 'serial', path: 'COM5' } },
    saved: 0, logs: [], notices: [], reconnects: [],
    saveSettings() { ctx.saved++; },
    sendCatLog(l) { ctx.logs.push(l); },
    win: { isDestroyed: () => false, webContents: { send: (ch, d) => ctx.notices.push(d) } },
    connectCatSafe(why) { ctx.reconnects.push(why); },
    cat: rigCat,
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.arm = armSerialHandshakeNoAnswerTrial;', ctx);
  ctx.arm(rigCat, transport, { path: 'COM5' }, { handshake: 'hardware', source: 'trial' });
  return { ctx, rigCat };
}

test('the radio answers with RTS up and goes into transmit: RTS/CTS is not saved, the radio is unkeyed, the operator is told', async () => {
  const { ctx, rigCat } = load();
  rigCat.emit('frequency', 14074000);
  rigCat._transmitting = true; rigCat.emit('ptt', true);   // PTT SELECT = RTS
  await wait(450);
  assert.strictEqual(ctx.saved, 0, 'nothing saved');
  assert.strictEqual(ctx.settings.catTarget.serialHandshake, undefined);
  assert.strictEqual(ctx._serialHsTrial.get('COM5'), 'keyed', 'and no second trial');
  assert.ok(rigCat.txOff >= 1, 'unkeyed');
  assert.deepStrictEqual(ctx.reconnects, ['rts-trial-keyed'], 'reconnected with the lines low');
  assert.ok(ctx.logs.some((l) => /went into transmit when POTACAT raised RTS on COM5/.test(l) && /move PTT \(PTT SELECT \/ keying\) off RTS, or turn the CAT RTS setting off/.test(l)));
  assert.ok(ctx.notices.some((n) => n && n.warn));
});

test('the radio answers with RTS up and stays in receive: RTS/CTS is saved, as before', async () => {
  const { ctx, rigCat } = load();
  rigCat.emit('frequency', 14074000);
  await wait(80);
  assert.strictEqual(ctx.saved, 1);
  assert.strictEqual(ctx.settings.catTarget.serialHandshake, 'hardware');
  assert.strictEqual(ctx._serialHsTrial.get('COM5'), 'done');
});

test('the no-answer wait is shorter, and a keyed trial is never tried again this session', () => {
  const m = main.match(/const SERIAL_HS_NOANSWER_MS = (\d+);/);
  assert.ok(m && Number(m[1]) <= 6000, 'no more than 6 s');
  assert.ok(/if \(hs\.source === 'model' && \(trial === 'done' \|\| trial === 'keyed'\)\) return;/.test(main));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nThe RTS/CTS trial never saves a setting that keys the radio: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
