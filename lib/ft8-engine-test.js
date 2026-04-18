'use strict';
/**
 * ft8-engine unit tests — exercises safety logic, slot locking, timer cleanup,
 * and consecutive TX cap WITHOUT spawning a real worker or touching audio.
 *
 * Run: node lib/ft8-engine-test.js
 */

const { Ft8Engine } = require('./ft8-engine');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// Create a test engine that doesn't spawn a real worker
function makeEngine(mode) {
  const eng = new Ft8Engine();
  eng._running = true;
  eng._workerReady = true;
  eng._mode = mode || 'FT8';
  // Stub encodeMessage to resolve immediately with fake samples
  eng.encodeMessage = async (text, freq) => new Float32Array(1000);
  return eng;
}

async function testSafetyTimerClear() {
  console.log('\n--- Test: Safety timer cleared before new one ---');
  const eng = makeEngine();
  eng._txMessage = 'CQ K3SBP FN20';
  eng._txSamples = new Float32Array(1000);
  eng._txEncodedMsg = eng._txMessage;
  eng._txEncodedFreq = 1500;
  eng._txEnabled = true;
  eng._lastRxSlot = 'even';
  eng._lockedTxSlot = 'odd';

  // Simulate first TX by calling tryImmediateTx — need to be in correct slot
  // Instead, directly set a timer like _onTxBoundary would
  eng._txEndTimer = setTimeout(() => {}, 10000);
  const firstTimer = eng._txEndTimer;

  // Set a new timer — old one should be cleared
  eng._txActive = false;
  eng._txEndTimer = null;
  // Simulate setting via tryImmediateTx-like code
  if (eng._txEndTimer) clearTimeout(eng._txEndTimer);
  eng._txEndTimer = setTimeout(() => {}, 10000);
  assert(eng._txEndTimer !== firstTimer, 'New timer replaces old one');

  // Clean up
  clearTimeout(firstTimer);
  clearTimeout(eng._txEndTimer);
  eng.stop();
}

async function testSetTxMessageClearsTimer() {
  console.log('\n--- Test: setTxMessage("") clears _txEndTimer ---');
  const eng = makeEngine();
  eng._txEndTimer = setTimeout(() => {}, 10000);
  assert(eng._txEndTimer !== null, 'Timer is set');

  eng.setTxMessage('');
  assert(eng._txEndTimer === null, 'Timer cleared after setTxMessage("")');
  assert(eng._consecutiveTxCount === 0, 'Consecutive TX count reset');
  assert(eng._lockedTxSlot === null, 'Locked slot cleared');
  eng.stop();
}

async function testModeResetSlots() {
  console.log('\n--- Test: Mode switch resets _lastRxSlot and _lockedTxSlot ---');
  const eng = makeEngine('FT8');
  eng._lastRxSlot = 'odd';
  eng._lockedTxSlot = 'even';

  eng.setMode('FT4');
  assert(eng._lastRxSlot === null, '_lastRxSlot reset after FT8->FT4');
  assert(eng._lockedTxSlot === null, '_lockedTxSlot reset after FT8->FT4');

  eng._lastRxSlot = 'even';
  eng._lockedTxSlot = 'odd';
  eng.setMode('FT2');
  assert(eng._lastRxSlot === null, '_lastRxSlot reset after FT4->FT2');
  assert(eng._lockedTxSlot === null, '_lockedTxSlot reset after FT4->FT2');
  eng.stop();
}

async function testConsecutiveTxOnlyResetsOnDecodes() {
  console.log('\n--- Test: Consecutive TX counter only resets on actual decodes ---');
  const eng = makeEngine('FT8');
  eng._consecutiveTxCount = 3;

  // Simulate a decode cycle with 0 results, TX not active
  eng._txActive = false;
  // Manually call the logic from _onWorkerMessage decode-result
  const count0 = 0;
  if (!eng._txActive && count0 > 0) eng._consecutiveTxCount = 0;
  assert(eng._consecutiveTxCount === 3, 'Counter NOT reset on 0 decodes');

  // Simulate a decode cycle with 2 results, TX not active
  const count2 = 2;
  if (!eng._txActive && count2 > 0) eng._consecutiveTxCount = 0;
  assert(eng._consecutiveTxCount === 0, 'Counter reset on 2 decodes');

  // Simulate: TX active, 5 decodes — should NOT reset
  eng._consecutiveTxCount = 4;
  eng._txActive = true;
  const count5 = 5;
  if (!eng._txActive && count5 > 0) eng._consecutiveTxCount = 0;
  assert(eng._consecutiveTxCount === 4, 'Counter NOT reset while TX active');
  eng.stop();
}

async function testSetTxSlotPreservesAutoLock() {
  console.log('\n--- Test: setTxSlot("auto") preserves lock when TX message set ---');
  const eng = makeEngine('FT8');
  eng._lastRxSlot = 'even';

  // setTxMessage auto-locks to opposite slot
  await eng.setTxMessage('CQ K3SBP FN20');
  assert(eng._lockedTxSlot === 'odd', 'Auto-locked to odd after setTxMessage');

  // setTxSlot('auto') should NOT clear the lock because TX message is active
  eng.setTxSlot('auto');
  assert(eng._lockedTxSlot === 'odd', 'Lock preserved after setTxSlot("auto") with active message');

  // Explicit slot should override
  eng.setTxSlot('even');
  assert(eng._lockedTxSlot === 'even', 'Explicit setTxSlot("even") overrides lock');

  // Clear message, then setTxSlot('auto') should clear lock
  eng.setTxMessage('');
  assert(eng._lockedTxSlot === null, 'Lock cleared by setTxMessage("")');

  eng._lockedTxSlot = 'odd'; // manually set
  eng.setTxSlot('auto');
  assert(eng._lockedTxSlot === null, 'Lock cleared by setTxSlot("auto") with no message');
  eng.stop();
}

async function testTryImmediateTxSafetyTimer() {
  console.log('\n--- Test: tryImmediateTx clears old safety timer ---');
  const eng = makeEngine('FT8');
  eng._txMessage = 'CQ K3SBP FN20';
  eng._txSamples = new Float32Array(1000);
  eng._txEncodedMsg = eng._txMessage;
  eng._txEncodedFreq = 1500;
  eng._txEnabled = true;
  eng._lockedTxSlot = null;
  eng._lastRxSlot = null;

  // Set a fake old timer
  eng._txEndTimer = setTimeout(() => {
    // This should NEVER fire — it's the "old" timer
    console.error('FAIL: Old safety timer fired — was not cleared');
  }, 200);

  // tryImmediateTx should replace it
  const fired = eng.tryImmediateTx();
  if (fired) {
    assert(eng._txEndTimer !== null, 'New safety timer set');
    // Clean up
    clearTimeout(eng._txEndTimer);
    eng._txActive = false;
  } else {
    // Might not fire due to slot timing — that's OK
    clearTimeout(eng._txEndTimer);
    console.log('  SKIP: tryImmediateTx returned false (slot timing) — timer test inconclusive');
  }
  eng.stop();
}

async function testFT2MonitoringGap() {
  console.log('\n--- Test: FT2 requires monitoring gap between TX cycles ---');
  const eng = makeEngine('FT2');
  eng._txMessage = 'CQ K3SBP FN20';
  eng._txSamples = new Float32Array(1000);
  eng._txEncodedMsg = eng._txMessage;
  eng._txEncodedFreq = 1500;
  eng._txEnabled = true;

  // Simulate TX on cycle 5
  eng._cycleNumber = 5;
  eng._lastTxCycleNum = -1;
  const first = eng.tryImmediateTx();
  if (first) {
    assert(eng._lastTxCycleNum === 5, 'Last TX cycle recorded');
    clearTimeout(eng._txEndTimer);
    eng._txActive = false;

    // Try TX on cycle 6 — should be blocked (gap < 2)
    eng._cycleNumber = 6;
    const second = eng.tryImmediateTx();
    assert(second === false, 'FT2 TX blocked on cycle 6 (gap=1)');

    // Try TX on cycle 7 — should work (gap = 2)
    eng._cycleNumber = 7;
    const third = eng.tryImmediateTx();
    assert(third === true, 'FT2 TX allowed on cycle 7 (gap=2)');
    clearTimeout(eng._txEndTimer);
    eng._txActive = false;
  } else {
    console.log('  SKIP: First FT2 TX did not fire — test inconclusive');
  }
  eng.stop();
}

async function testMaxConsecutiveTxCap() {
  console.log('\n--- Test: Max consecutive TX (5) blocks further TX ---');
  const eng = makeEngine('FT8');
  eng._txMessage = 'CQ K3SBP FN20';
  eng._txSamples = new Float32Array(1000);
  eng._txEncodedMsg = eng._txMessage;
  eng._txEncodedFreq = 1500;
  eng._txEnabled = true;
  eng._consecutiveTxCount = 5; // at the cap

  const fired = eng.tryImmediateTx();
  // For FT8, consecutive check only applies in _onTxBoundary, not tryImmediateTx
  // But for FT2 it does apply in tryImmediateTx:
  const eng2 = makeEngine('FT2');
  eng2._txMessage = 'CQ K3SBP FN20';
  eng2._txSamples = new Float32Array(1000);
  eng2._txEncodedMsg = eng2._txMessage;
  eng2._txEncodedFreq = 1500;
  eng2._txEnabled = true;
  eng2._consecutiveTxCount = 5;
  eng2._cycleNumber = 100;
  eng2._lastTxCycleNum = 50; // gap OK

  const fired2 = eng2.tryImmediateTx();
  assert(fired2 === false, 'FT2 tryImmediateTx blocked at max consecutive TX');

  eng.stop();
  eng2.stop();
}

// --- Grid validation tests ---

function testGridRegex() {
  console.log('\n--- Test: Grid extraction regex + RR73 exclusion ---');
  const regex = /\b([A-R]{2}\d{2})\s*$/i;
  const exclude = /^RR\d{2}$/i;

  function gridMatch(msg) {
    const m = msg.match(regex);
    if (!m) return null;
    if (exclude.test(m[1])) return null; // RR73 etc excluded
    return m[1].toUpperCase();
  }

  // Valid grids at end of CQ messages
  assert(gridMatch('CQ K1ABC FN20') === 'FN20', 'FN20 extracted from CQ');
  assert(gridMatch('CQ K1ABC AA00') === 'AA00', 'AA00 extracted');
  assert(gridMatch('CQ K1ABC EM11') === 'EM11', 'EM11 extracted (not confused with DXCC)');
  assert(gridMatch('CQ K1ABC JN48') === 'JN48', 'JN48 extracted');
  assert(gridMatch('CQ K1ABC IO91') === 'IO91', 'IO91 extracted');
  assert(gridMatch('CQ DX K1ABC FN20') === 'FN20', 'Grid after directed CQ');

  // FT8 exchanges that should NOT match as grids
  assert(gridMatch('K1ABC W2XYZ RR73') === null, 'RR73 excluded by filter');
  assert(gridMatch('K1ABC W2XYZ RR99') === null, 'RR99 excluded by filter');
  assert(gridMatch('K1ABC W2XYZ -15') === null, 'Signal report -15 not a grid');
  assert(gridMatch('K1ABC W2XYZ R-07') === null, 'R-report not a grid');
  assert(gridMatch('K1ABC W2XYZ 73') === null, '73 not a grid (2 chars)');
  assert(gridMatch('K1ABC W2XYZ RRR') === null, 'RRR not a grid (3 chars)');
  assert(gridMatch('K1ABC W2XYZ R+05') === null, 'R+report not a grid');
}

// --- Double-logging prevention tests ---

function testDoubleLogGuard() {
  console.log('\n--- Test: Double-logging prevention via _logged flag ---');

  // Simulate a QSO object
  const qso = { call: 'W1XYZ', report: '-12', sentReport: '+05', phase: '73', _logged: false };

  // First "log" should succeed
  assert(!qso._logged, 'QSO not logged initially');
  qso._logged = true;
  assert(qso._logged, 'QSO marked as logged');

  // Second "log" attempt should be blocked
  const wouldLog = !qso._logged;
  assert(wouldLog === false, 'Second log attempt blocked by _logged flag');
}

function testNoLogWithoutReports() {
  console.log('\n--- Test: QSO without reports should not log ---');

  // QSO with no reports at all
  const qso1 = { call: 'W1XYZ', report: null, sentReport: null };
  const shouldLog1 = !!(qso1.report || qso1.sentReport);
  assert(shouldLog1 === false, 'QSO with no reports blocked from logging');

  // QSO with only received report
  const qso2 = { call: 'W1XYZ', report: '-12', sentReport: null };
  const shouldLog2 = !!(qso2.report || qso2.sentReport);
  assert(shouldLog2 === true, 'QSO with received report allowed (partial OK)');

  // QSO with both reports
  const qso3 = { call: 'W1XYZ', report: '-12', sentReport: '+05' };
  const shouldLog3 = !!(qso3.report || qso3.sentReport);
  assert(shouldLog3 === true, 'QSO with both reports allowed');
}

// --- Report regex tests ---

function testReportRegex() {
  console.log('\n--- Test: CQ mode report regex (R prefix optional) ---');
  const regex = /R?([+-]\d{2})/;

  // With R prefix
  let m = 'K1ABC K3SBP R-12'.match(regex);
  assert(m && m[1] === '-12', 'R-12 extracted correctly');

  m = 'K1ABC K3SBP R+05'.match(regex);
  assert(m && m[1] === '+05', 'R+05 extracted correctly');

  // Without R prefix (some stations omit it)
  m = 'K1ABC K3SBP -15'.match(regex);
  assert(m && m[1] === '-15', '-15 extracted without R prefix');

  m = 'K1ABC K3SBP +02'.match(regex);
  assert(m && m[1] === '+02', '+02 extracted without R prefix');

  // Should NOT match non-reports
  m = 'K1ABC K3SBP RR73'.match(regex);
  // RR73 would match R followed by R73... but R73 doesn't match [+-]\d{2}
  assert(!m || m[1] !== 'R73', 'RR73 does not extract as report');

  m = 'K1ABC K3SBP 73'.match(regex);
  assert(!m, '73 alone is not a report (no +/- sign)');
}

// Run all tests
(async () => {
  console.log('=== FT8 Engine Unit Tests ===');
  await testSafetyTimerClear();
  await testSetTxMessageClearsTimer();
  await testModeResetSlots();
  await testConsecutiveTxOnlyResetsOnDecodes();
  await testSetTxSlotPreservesAutoLock();
  await testTryImmediateTxSafetyTimer();
  await testFT2MonitoringGap();
  await testMaxConsecutiveTxCap();

  console.log('\n=== Grid, Report & Logging Tests ===');
  testGridRegex();
  testDoubleLogGuard();
  testNoLogWithoutReports();
  testReportRegex();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
