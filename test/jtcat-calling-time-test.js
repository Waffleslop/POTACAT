#!/usr/bin/env node
'use strict';
// JTCAT calling time (#161): the FT8/FT4/FT2 transmit watchdog's span is a
// setting, jtcatCallingTimeMin, default 6 minutes, clamped to 1..30 so it can
// never outlast the 30-minute attended-operator limit on Run and Hunt.
// Runs the real jtcatTxWatchdogTripped() from main.js against a fake clock.
// Run: node test/jtcat-calling-time-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const CT = require('../lib/jtcat-calling-time');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (p) => readSrc(path.join(__dirname, '..', p));
const MAIN = R('main.js');
function extract(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing ' + header);
  const open = src.indexOf(') {', i) + 2;
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced');
}
const min = 60000;

// ── the pure rule ──────────────────────────────────────────────────────────
test('the default is 6 minutes', () => {
  assert.strictEqual(CT.DEFAULT_MIN, 6);
  assert.strictEqual(CT.callingTimeMs({}), 6 * min);
  assert.strictEqual(CT.callingTimeMs(undefined), 6 * min);
  assert.strictEqual(CT.clampMinutes(undefined), 6);
  assert.strictEqual(CT.clampMinutes(''), 6);
  assert.strictEqual(CT.clampMinutes('abc'), 6);
  assert.strictEqual(CT.clampMinutes(NaN), 6);
});

test('out-of-range values clamp to 1..30', () => {
  assert.strictEqual(CT.clampMinutes(0), 1);
  assert.strictEqual(CT.clampMinutes(-5), 1);
  assert.strictEqual(CT.clampMinutes(31), 30);
  assert.strictEqual(CT.clampMinutes(999), 30);
  assert.strictEqual(CT.clampMinutes(Infinity), 6, 'not a finite number reads as the default');
  assert.strictEqual(CT.clampMinutes('12'), 12);
  assert.strictEqual(CT.clampMinutes(2.6), 3);
  assert.strictEqual(CT.callingTimeMs({ jtcatCallingTimeMin: 45 }), 30 * min);
});

test('the ceiling is the 30-minute attended-operator limit', () => {
  const m = /const JTCAT_FULL_AUTO_CQ_WATCHDOG_MS = (\d+) \* 60 \* 1000;/.exec(MAIN);
  assert.ok(m, 'the attended watchdog constant is still in main.js');
  assert.strictEqual(Number(m[1]), 30, 'the attended watchdog stays at 30 minutes');
  assert.ok(CT.MAX_MIN <= Number(m[1]), 'calling time can never outlast it');
});

// ── main.js uses the setting ───────────────────────────────────────────────
function harness(settings) {
  const ctx = {
    now: 1_000_000_000,
    settings: Object.assign({ ultracat: false }, settings),
    jtcatFullAutoCq: false, jtcatAutoCqMode: 'off',
    jtcatFullAutoCqLastActivity: 0, _jtcatTxWatchArmedAt: 0,
    JtcatCallingTime: CT,
  };
  ctx.Date = { now: () => ctx.now };
  vm.createContext(ctx);
  vm.runInContext([
    extract(MAIN, 'function jtcatTxWatchdogMs('),
    extract(MAIN, 'function jtcatTxWatchdogTripped('),
    extract(MAIN, 'function jtcatNoteOperatorAtRadio('),
  ].join('\n'), ctx);
  return ctx;
}
const tripsAt = (c, mode = 'FT8') => vm.runInContext(`jtcatTxWatchdogTripped('${mode}')`, c);

test('the watchdog uses the setting: 2 minutes stops TX after 2', () => {
  const c = harness({ jtcatCallingTimeMin: 2 });
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 1.5 * min;
  assert.strictEqual(tripsAt(c), false);
  c.now += 1 * min;
  assert.strictEqual(tripsAt(c), true);
});

test('the watchdog uses the setting: 15 minutes keeps calling past 6', () => {
  const c = harness({ jtcatCallingTimeMin: 15 });
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 14 * min;
  assert.strictEqual(tripsAt(c, 'FT4'), false);
  c.now += 1.5 * min;
  assert.strictEqual(tripsAt(c, 'FT4'), true);
});

test('with no setting it is 6 minutes, as before', () => {
  const c = harness({});
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 5.9 * min;
  assert.strictEqual(tripsAt(c), false);
  c.now += 0.2 * min;
  assert.strictEqual(tripsAt(c), true);
});

test('a saved value above 30 stops at 30 minutes, never later', () => {
  const c = harness({ jtcatCallingTimeMin: 120 });
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 30.5 * min;
  assert.strictEqual(tripsAt(c), true);
});

test('a change takes effect on the next key-down (read live, not cached)', () => {
  const c = harness({ jtcatCallingTimeMin: 20 });
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 10 * min;
  assert.strictEqual(tripsAt(c), false);
  c.settings.jtcatCallingTimeMin = 5;
  assert.strictEqual(tripsAt(c), true);
});

// ── wiring ─────────────────────────────────────────────────────────────────
test('main.js has no fixed 6-minute constant left and reads the one rule', () => {
  assert.ok(!/const JTCAT_TX_WATCHDOG_MS\b/.test(MAIN), 'the fixed constant is gone');
  assert.ok(/const JtcatCallingTime = require\('\.\/lib\/jtcat-calling-time'\);/.test(MAIN));
  assert.ok(/return JtcatCallingTime\.callingTimeMs\(settings\);/.test(extract(MAIN, 'function jtcatTxWatchdogMs(')));
  assert.ok(/jtcatTxWatchdogMs\(\)/.test(extract(MAIN, 'function jtcatTxWatchdogTripped(')));
});

test('the stop message names the minutes actually set', () => {
  const body = extract(MAIN, 'function jtcatTxWatchdogStop(');
  assert.ok(/Math\.round\(jtcatTxWatchdogMs\(\) \/ 60000\)/.test(body));
  assert.ok(/mins === 1 \? 'minute' : 'minutes'/.test(body), 'one minute reads as "1 minute"');
});

test('the JTCAT window: a minutes box under Options with the exact label, clamped by the shared rule', () => {
  const html = R('renderer/jtcat-popout.html');
  assert.ok(html.includes('<span class="jp-opt-label">Stop calling after <input id="jp-calling-time" type="number" min="1" max="30" value="6"> minutes with no answer</span>'));
  assert.ok(html.includes('<span class="jp-opt-help">If nobody answers in a way that moves a contact on, and you have not pressed anything, JTCAT stops transmitting after this many minutes. Pressing CQ, turning TX on, replying to a station, or an answer that moves the contact on starts the count again. 1 to 30 minutes; 6 is the same as WSJT-X.</span>'));
  assert.ok(html.indexOf('<script src="../lib/jtcat-calling-time.js"></script>') >= 0 &&
    html.indexOf('<script src="../lib/jtcat-calling-time.js"></script>') < html.indexOf('<script src="jtcat-popout.js"></script>'));
  const js = R('renderer/jtcat-popout.js');
  assert.ok(/getElementById\('jp-calling-time'\)/.test(js));
  assert.ok(/callingTimeInput\.value = window\.JtcatCallingTime\.clampMinutes\(s\.jtcatCallingTimeMin\);/.test(js), 'loads the saved value');
  assert.ok(/var n = window\.JtcatCallingTime\.clampMinutes\(callingTimeInput\.value\);[\s\S]{0,80}window\.api\.saveSettings\(\{ jtcatCallingTimeMin: n \}\);/.test(js), 'saves the clamped value');
});

test('a remote JTCAT window and devices set it as a per-profile pref', () => {
  const B = require('../lib/remote-bridge');
  assert.strictEqual(B.JTCAT_PREFS.jtcatCallingTimeMin, 'number');
  assert.deepStrictEqual(B.prefMessages({ jtcatCallingTimeMin: 10 }), [{ type: 'jtcat-set-pref', key: 'jtcatCallingTimeMin', value: 10 }]);
});

test('devices read it in the settings frame, clamped', () => {
  assert.ok(/jtcatCallingTimeMin: JtcatCallingTime\.clampMinutes\(settings\.jtcatCallingTimeMin\),/.test(MAIN));
});

test('a change from the desktop or a device reaches every connected device', () => {
  assert.ok(/if \(has\('jtcatCallingTimeMin'\)\) updateRemoteSettings\(\);/.test(MAIN), 'desktop save');
  assert.ok(/if \(key === 'jtcatCallingTimeMin'\) updateRemoteSettings\(\);/.test(MAIN), 'device jtcat-set-pref');
});

test('the setting is per profile, not machine-wide', () => {
  const g = MAIN.slice(MAIN.indexOf('const GLOBAL_KEYS = new Set(['), MAIN.indexOf(']);', MAIN.indexOf('const GLOBAL_KEYS = new Set([')));
  assert.ok(!g.includes('jtcatCallingTimeMin'));
});

test('documented: settings reference, JTCAT.md and the ECHOCAT protocol', () => {
  assert.ok(R('docs/settings-reference-dev.md').includes('`jtcatCallingTimeMin`'));
  assert.ok(R('docs/JTCAT.md').includes('jtcatCallingTimeMin'));
  assert.ok(R('docs/echocat-protocol.md').includes('jtcatCallingTimeMin'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
