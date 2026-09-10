// Tests for classifyClockOffset() — how far off UTC the PC clock may be
// before JTCAT/JS8 say something.
//
// These thresholds were 1 s / 2 s, "chosen to match FT8's decode tolerance",
// which calibrated the warning against the wrong question. A clock a second
// out decodes everything perfectly and gets answered by nobody: the
// transmission lands outside the window the station being called will accept.
// K3SBP ran two weeks that way (2026-09-03) — decoding South America and
// Europe, spotted on PSKReporter out to the Mississippi, zero QSOs — with a
// green "Sync: OK" the entire time. Installing an NTP client produced a
// contact immediately.
//
// So: these numbers answer "will I be answered", not "will I decode". If a
// future change wants to loosen them, it needs a better reason than decode
// tolerance, because decode tolerance is exactly what made this invisible.
'use strict';
const assert = require('assert');
const { classifyClockOffset, CLOCK_OK_MS, CLOCK_BAD_MS } = require('../lib/ntp');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }

console.log('classifyClockOffset()');

t('a disciplined clock says nothing', () => {
  for (const ms of [0, 5, 50, 120, 249]) {
    assert.strictEqual(classifyClockOffset(ms), 'ok', ms + 'ms should be ok');
  }
});

t('THE REGRESSION GUARD: sub-second offsets are NOT ok', () => {
  // Every one of these decoded fine and worked nobody.
  for (const ms of [300, 500, 700, 900, 999]) {
    assert.strictEqual(classifyClockOffset(ms), 'warn',
      ms + 'ms must warn — it decodes perfectly and loses every QSO');
  }
});

t('a second or more is the band where QSOs are being lost right now', () => {
  for (const ms of [1000, 1500, 2000, 5000]) {
    assert.strictEqual(classifyClockOffset(ms), 'bad', ms + 'ms should be bad');
  }
});

t('a slow clock is as bad as a fast one', () => {
  // The old code used Math.abs too, but the sign of the failure differs
  // (early vs late transmission) and both lose QSOs, so both must alarm.
  assert.strictEqual(classifyClockOffset(-900), 'warn');
  assert.strictEqual(classifyClockOffset(-1500), 'bad');
  assert.strictEqual(classifyClockOffset(-50), 'ok');
});

t('the boundaries are exactly the exported constants', () => {
  assert.strictEqual(CLOCK_OK_MS, 250);
  assert.strictEqual(CLOCK_BAD_MS, 1000);
  assert.strictEqual(classifyClockOffset(CLOCK_OK_MS - 1), 'ok');
  assert.strictEqual(classifyClockOffset(CLOCK_OK_MS), 'warn');
  assert.strictEqual(classifyClockOffset(CLOCK_BAD_MS - 1), 'warn');
  assert.strictEqual(classifyClockOffset(CLOCK_BAD_MS), 'bad');
});

t('junk offsets are treated as no offset, never as an alarm', () => {
  // checkClockOffset can only fail by throwing (the caller reports 'unknown'),
  // so a non-number here is a bug — but crying "bad clock" at a healthy
  // station is worse than staying quiet.
  assert.strictEqual(classifyClockOffset(null), 'ok');
  assert.strictEqual(classifyClockOffset(undefined), 'ok');
  assert.strictEqual(classifyClockOffset(NaN), 'ok');
  assert.strictEqual(classifyClockOffset('nonsense'), 'ok');
});

// ---------------------------------------------------------------------------
// The monitor has to actually RUN. From 39ec7ca (2026-06-10) to 2026-09-10 it
// was hooked on the engine's {state:'running'} status, which Ft8Engine.start()
// emits synchronously inside jtcatManager.startSlice() — before main attached
// a single listener. Not one '[Clock]' line ever reached a log on its own; the
// 2026-09-03 thresholds were tuned for a check only the Recheck button ran.
console.log('\nclock monitor wiring (main.js)');
const fs = require('fs');
const path = require('path');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function fnBody(name) {
  const at = MAIN.indexOf('function ' + name + '(');
  assert.notStrictEqual(at, -1, name + ' not found');
  let depth = 0, i = MAIN.indexOf('{', at);
  for (; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++;
    else if (MAIN[i] === '}' && --depth === 0) break;
  }
  return MAIN.slice(at, i + 1);
}

t('startJtcat re-emits the running status AFTER its status listener is attached', () => {
  const body = fnBody('startJtcat');
  const listener = body.indexOf("ft8Engine.on('status'");
  assert.notStrictEqual(listener, -1, 'no status listener in startJtcat');
  const reemit = body.indexOf("ft8Engine.emit('status', { state: 'running'");
  assert.notStrictEqual(reemit, -1, 'the running status is never re-emitted — the monitor and the running jtcat-status never fire');
  assert.ok(reemit > listener, 'the re-emit precedes the listener, which is the original bug');
  assert.ok(/state === 'running'\) startJtcatClockMonitor\(\)/.test(body), 'the listener no longer starts the clock monitor');
});

t('the multi-slice start arms the monitor itself (it has no status listener)', () => {
  const at = MAIN.indexOf("ipcMain.on('jtcat-start-multi'");
  assert.notStrictEqual(at, -1, 'jtcat-start-multi handler not found');
  const handler = MAIN.slice(at, MAIN.indexOf('Multi-slice started', at));
  assert.ok(handler.includes('startJtcatClockMonitor();'), 'multi-slice never starts the clock monitor');
});

t('stopJtcat stops the monitor for both paths', () => {
  assert.ok(fnBody('stopJtcat').includes('stopJtcatClockMonitor();'), 'stopJtcat leaves the 5-minute NTP poll running');
});

t('a fresh measurement is reused across engine rebuilds instead of re-querying NTP', () => {
  const body = fnBody('startJtcatClockMonitor');
  assert.ok(body.includes('broadcastJtcatClock(jtcatLastClock)'), 'a rebuilt popout never receives the last reading');
  assert.ok(body.includes("level !== 'unknown'"), 'a failed NTP query is reused instead of retried');
  assert.ok(body.includes('setInterval(runJtcatClockCheck'), 'the periodic poll is not armed');
});

console.log(`\n${passed} passed`);
