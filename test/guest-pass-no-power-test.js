#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Guest Pass with a radio that is not reporting its RF power (NA4DQ's IC-7300
// lent to KF0WWL, 2026-11-05). The rule stays: no power report, no transmit.
// What changes: the guest is told in plain words in the window they are using,
// the owner gets one line a minute naming the fix, the shack asks the radio for
// its power right after setting the cap and again on a refusal, and the FT8
// "TX power 100 %" line says it is the audio level under a capped RF power.
// Run: node test/guest-pass-no-power-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PassEnforcement } = require('../lib/pass-enforcement');
const { RigController } = require('../lib/rig-controller');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const main = readSrc(path.join(__dirname, '..', 'main.js'));
const slice = (from, to) => main.slice(main.indexOf(from), main.indexOf(to));

test('the guest reads a plain refusal that names the limit and says the owner knows', () => {
  const pe = new PassEnforcement({ revalidateMs: 0, rigPowerReadable: () => true });
  pe._state = 'active';
  pe._expiresAtMs = Date.now() + 3600000;
  pe._pass = { code: 'T1', guest_callsign: 'KF0WWL', privilege_class: 'us_technician', privilege_class_short: 'tech', max_power_w: 25, allowed_modes: [] };
  const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 28400000, mode: 'USB', currentWatts: 0, powerAgeMs: Infinity });
  assert.strictEqual(r.reason, 'tx_disabled_no_power_cat');
  assert.strictEqual(r.userVisible, 'Not transmitting: the shack\'s radio has not reported its power setting, so the 25 W cap on this pass cannot be confirmed. The station owner has been told.');
});

test('the controller can ask the radio for its power now', () => {
  let asked = 0;
  const ctl = Object.create(RigController.prototype);
  ctl._codec = { getPower() { asked++; } };
  assert.strictEqual(ctl.readPower(), true);
  assert.strictEqual(asked, 1);
  ctl._codec = {};
  assert.strictEqual(ctl.readPower(), false);
});

function loadPass(extra) {
  const ctx = Object.assign({
    logs: [], sent: [], asked: 0, timers: [],
    Date, Math, Number, String,
    setTimeout: (fn, ms) => { ctx.timers.push(ms); fn(); },
    sendCatLog: (l) => ctx.logs.push(l),
    win: { isDestroyed: () => false, webContents: { send: (ch, d) => ctx.sent.push(['main', ch, d]) } },
    vfoPopoutWin: { isDestroyed: () => false, webContents: { send: (ch, d) => ctx.sent.push(['vfo', ch, d]) } },
    jtcatPopoutWin: { isDestroyed: () => false, webContents: { send: (ch, d) => ctx.sent.push(['jtcat', ch, d]) } },
    cat: { connected: true, readPower() { ctx.asked++; } },
    _lastPowerReadback: null,
    remoteServer: null,
    setRadioTxPowerRaw: () => true,
  }, extra || {});
  vm.createContext(ctx);
  const src = slice('let _passPowerAskAt = 0;', 'function sendCatSmeter(')
    + slice('function passTxBlocked(res) {', 'function passTxJustBlocked()');
  vm.runInContext('let _passTxBlockedAt = 0;\n' + src
    + '\nthis.cap = passApplyPowerCap; this.blocked = passTxBlocked; this.refused = remoteShackRefused;', ctx);
  return ctx;
}

test('setting the lease cap asks the radio to read its power back', () => {
  const ctx = loadPass();
  assert.strictEqual(ctx.cap(25, 'lease start'), true);
  assert.ok(ctx.logs.some((l) => l === "[pass] RF power set to 25 W — the pass's cap (lease start)"));
  assert.strictEqual(ctx.asked, 1);
  assert.deepStrictEqual(ctx.timers, [600]);
});

test('a "no power reading" refusal asks the radio again and tells the owner what to fix, once a minute', () => {
  const ctx = loadPass();
  const res = { reason: 'tx_disabled_no_power_cat', userVisible: 'x' };
  ctx.blocked(res);
  ctx.blocked(res);
  assert.strictEqual(ctx.asked, 1, 'throttled');
  const owner = ctx.logs.filter((l) => l.startsWith('[pass] Owner:'));
  assert.strictEqual(owner.length, 1);
  assert.ok(/has never reported it this session/.test(owner[0]));
  assert.ok(/Settings > My Rigs names this radio's exact model \(and CI-V address on an Icom\)/.test(owner[0]));
  assert.ok(ctx.sent.some(([w, ch]) => w === 'main' && ch === 'app-notice'));
  ctx.blocked({ reason: 'over_power', userVisible: 'y' });
  assert.strictEqual(ctx.logs.filter((l) => l.startsWith('[pass] Owner:')).length, 1, 'other refusals add nothing');
});

test('on the guest\'s desktop the shack\'s refusal reaches the log, the VFO window and the FT8 window', () => {
  const ctx = loadPass();
  const why = 'Not transmitting: the shack\'s radio has not reported its power setting, so the 25 W cap on this pass cannot be confirmed. The station owner has been told.';
  ctx.refused(why);
  ctx.refused(why);
  assert.strictEqual(ctx.logs.filter((l) => l === '[Remote] The shack refused: ' + why).length, 1, 'logged once per 30 s');
  assert.ok(ctx.sent.some(([w, ch, d]) => w === 'jtcat' && ch === 'jtcat-qso-state' && d.phase === 'error' && d.error === why));
  assert.ok(ctx.sent.some(([w, ch, d]) => w === 'vfo' && ch === 'tune-blocked' && d === why));
  assert.ok(ctx.sent.some(([w, ch, d]) => w === 'main' && ch === 'tune-blocked' && d === why));
  assert.ok(/remoteClient\.on\('tune-blocked', \(\{ reason \}\) => remoteShackRefused\(reason\)\);/.test(main));
});

test('the FT8 audio level line says the RF power stays at the pass cap', () => {
  const f = slice('function applyJtcatTxGain(', 'function applyJtcatTxGain(') + main.slice(main.indexOf('function applyJtcatTxGain('), main.indexOf('function applyJtcatTxGain(') + 2500);
  assert.ok(/\(the FT8 audio level; the radio's RF power stays capped at the pass's \$\{passCap\} W\)/.test(f));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nGuest Pass, no power reading: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
