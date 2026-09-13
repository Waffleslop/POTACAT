// Tests for lib/swr-guard.js — the pure half of the Flex SWR guard — plus
// source-text guards on main.js for the wiring that has to stay put.
//
// Why these exist (K3SBP 2026-09-13, 20 m, 19:1): with swrAutoTune on, the
// guard aborted the transmission, sent `atu start` 300 ms later and cleared
// its own latch the moment the command went out. The Flex ATU churned every
// L/C combination at 10 W into the fault and gave up; the guard was blind for
// 30 s, the latch was already gone, and the next Hunt answer keyed 69 W into
// the same 19:1. Nothing in the log said the tune had FAILED. Three rules
// fell out of it: a tune never clears the latch (only a reported match
// does), no auto-tune beyond what an ATU can match, one failed auto-tune per
// band per session.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/swr-guard');

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('  ✓ ' + label); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + label + '\n      ' + (e.message || e)); }
}

console.log('classifyAtuStatus:');
check('TUNE_IN_PROGRESS is sweeping', () => assert.strictEqual(G.classifyAtuStatus('TUNE_IN_PROGRESS'), 'sweeping'));
check('TUNE_OK (memory recall) is matched', () => assert.strictEqual(G.classifyAtuStatus('TUNE_OK'), 'matched'));
check('TUNE_SUCCESSFUL is matched', () => assert.strictEqual(G.classifyAtuStatus('TUNE_SUCCESSFUL'), 'matched'));
check('TUNE_FAIL_BYPASS is failed (what the 19:1 tune ended in)', () => assert.strictEqual(G.classifyAtuStatus('TUNE_FAIL_BYPASS'), 'failed'));
check('TUNE_FAIL and TUNE_ABORTED are failed', () => {
  assert.strictEqual(G.classifyAtuStatus('TUNE_FAIL'), 'failed');
  assert.strictEqual(G.classifyAtuStatus('TUNE_ABORTED'), 'failed');
});
check('resting states are idle', () => {
  for (const s of ['TUNE_NOT_STARTED', 'TUNE_BYPASS', 'TUNE_MANUAL_BYPASS', '', undefined, 'SOMETHING_NEW']) {
    assert.strictEqual(G.classifyAtuStatus(s), 'idle', String(s));
  }
});
check('case and whitespace tolerant', () => assert.strictEqual(G.classifyAtuStatus(' tune_ok '), 'matched'));

console.log('\ndecideAtuOutcome — resolving a tune POTACAT started:');
const T0 = 1_000_000;
function episode() { return { startedAt: T0, sawSweep: false }; }
check('sweep → no outcome yet, remembered on the episode', () => {
  const e = episode();
  const r = G.decideAtuOutcome(e, 'TUNE_IN_PROGRESS', T0 + 200);
  assert.strictEqual(r.outcome, null);
  assert.strictEqual(e.sawSweep, true);
});
check('idle status right after `atu start` is the PRE-tune state, not a result', () => {
  const r = G.decideAtuOutcome(episode(), 'TUNE_NOT_STARTED', T0 + 100);
  assert.strictEqual(r.outcome, null);
});
check('idle status after the echo window with no sweep at all = tune never ran = failed', () => {
  const r = G.decideAtuOutcome(episode(), 'TUNE_BYPASS', T0 + G.ATU_STALE_ECHO_MS + 1);
  assert.strictEqual(r.outcome, 'failed');
});
check('idle status after a sweep was seen = ended without a match = failed', () => {
  const e = episode();
  G.decideAtuOutcome(e, 'TUNE_IN_PROGRESS', T0 + 200);
  const r = G.decideAtuOutcome(e, 'TUNE_BYPASS', T0 + 400);
  assert.strictEqual(r.outcome, 'failed');
});
check('TUNE_OK / TUNE_SUCCESSFUL resolve matched immediately', () => {
  assert.strictEqual(G.decideAtuOutcome(episode(), 'TUNE_OK', T0 + 50).outcome, 'matched');
  assert.strictEqual(G.decideAtuOutcome(episode(), 'TUNE_SUCCESSFUL', T0 + 3000).outcome, 'matched');
});
check('TUNE_FAIL_BYPASS resolves failed immediately, even inside the echo window', () => {
  assert.strictEqual(G.decideAtuOutcome(episode(), 'TUNE_FAIL_BYPASS', T0 + 50).outcome, 'failed');
});

console.log('\ndecideSwrAutoTune — may the guard run the ATU after this trip?');
const base = { enabled: true, flexConnected: true, swr: 4.2, band: '20m', failedBand: '', lastAutoTuneAt: 0, now: T0 };
check('a 4.2:1 trip on a Flex with auto-tune on tunes', () => {
  assert.deepStrictEqual(G.decideSwrAutoTune(base), { tune: true, reason: 'ok' });
});
check('setting off → off', () => assert.strictEqual(G.decideSwrAutoTune({ ...base, enabled: false }).reason, 'off'));
check('no SmartSDR API → no-flex (nothing to drive or read)', () => {
  assert.strictEqual(G.decideSwrAutoTune({ ...base, flexConnected: false }).reason, 'no-flex');
});
check('19:1 is beyond what an ATU can match — refused (that was the 10 W into the fault)', () => {
  const r = G.decideSwrAutoTune({ ...base, swr: 19 });
  assert.strictEqual(r.tune, false);
  assert.strictEqual(r.reason, 'beyond-atu');
});
check(`exactly ${G.SWR_AUTOTUNE_MAX}:1 still tunes; just over does not; NaN/undefined is refused`, () => {
  assert.strictEqual(G.decideSwrAutoTune({ ...base, swr: G.SWR_AUTOTUNE_MAX }).tune, true);
  assert.strictEqual(G.decideSwrAutoTune({ ...base, swr: G.SWR_AUTOTUNE_MAX + 0.1 }).reason, 'beyond-atu');
  assert.strictEqual(G.decideSwrAutoTune({ ...base, swr: NaN }).reason, 'beyond-atu');
  assert.strictEqual(G.decideSwrAutoTune({ ...base, swr: undefined }).reason, 'beyond-atu');
});
check('the ATU already failed on this band this session → refused', () => {
  assert.strictEqual(G.decideSwrAutoTune({ ...base, failedBand: '20m' }).reason, 'failed-on-band');
});
check('a failure on ANOTHER band does not block this one', () => {
  assert.strictEqual(G.decideSwrAutoTune({ ...base, failedBand: '40m' }).tune, true);
});
check('unknown band never matches a failed band', () => {
  assert.strictEqual(G.decideSwrAutoTune({ ...base, band: '', failedBand: '' }).tune, true);
});
check('one auto-tune a minute: 59 s after the last is rate-limited, 60 s is not', () => {
  assert.strictEqual(G.decideSwrAutoTune({ ...base, lastAutoTuneAt: T0 - 59_000 }).reason, 'rate-limited');
  assert.strictEqual(G.decideSwrAutoTune({ ...base, lastAutoTuneAt: T0 - G.SWR_AUTOTUNE_MIN_INTERVAL_MS }).tune, true);
});
check('beyond-atu is decided before the rate limit and the band memory (the log line names the real reason)', () => {
  assert.strictEqual(G.decideSwrAutoTune({ ...base, swr: 25, failedBand: '20m', lastAutoTuneAt: T0 - 1000 }).reason, 'beyond-atu');
});

console.log('\nmain.js wiring (source-text guards):');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const sdrSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'smartsdr.js'), 'utf8');
check('main.js requires lib/swr-guard', () => assert.ok(/require\('\.\/lib\/swr-guard'\)/.test(mainSrc)));
check('the Flex setAtu wrapper opens a result-awaiting episode', () => {
  assert.ok(mainSrc.includes("noteAtuTuneStarted({ awaitResult: true, auto: !!(opts && opts.auto) })"));
});
check("main.js subscribes to the radio's atu-status", () => {
  assert.ok(mainSrc.includes("smartSdr.on('atu-status', onAtuStatus)"));
});
check('the auto-tune goes through setAtu with auto:true (so a failure is remembered per band)', () => {
  assert.ok(mainSrc.includes('smartSdr.setAtu(true, { auto: true })'));
});
check('the auto-tune no longer clears the latch itself', () => {
  assert.ok(!/noteAtuTuneStarted\(\);\s*smartSdr\.setAtu\(true\)/.test(mainSrc));
});
check('the auto-tune decision is the pure policy, not an inline time gate', () => {
  assert.ok(mainSrc.includes('SwrGuard.decideSwrAutoTune({'));
  assert.ok(!/settings\.swrAutoTune && smartSdr && smartSdr\.connected && Date\.now\(\) - _swrLastAutoTune/.test(mainSrc));
});
check("clearSwrTrip('ATU tune') survives only on the no-result path", () => {
  const hits = mainSrc.match(/clearSwrTrip\('ATU tune'\)/g) || [];
  assert.strictEqual(hits.length, 1, 'exactly one call site');
  assert.ok(mainSrc.includes("if (!awaitResult) { clearSwrTrip('ATU tune'); return; }"));
});
check('lib/smartsdr.js parses `atu` status lines and subscribes to them', () => {
  assert.ok(sdrSrc.includes('_parseAtuStatus(line)'));
  assert.ok(sdrSrc.includes("this.emit('atu-status', kv)"));
  assert.ok(sdrSrc.includes("this._send('sub atu all')"));
});

console.log('\nlib/smartsdr.js _parseAtuStatus (live parser on a real status line):');
check('a Flex atu status line becomes an atu-status event with the raw fields', () => {
  const { SmartSdrClient } = require('../lib/smartsdr');
  const c = new SmartSdrClient();
  const got = [];
  c.on('atu-status', kv => got.push(kv));
  c._parseAtuStatus('S5A1B2C3D|atu status=TUNE_FAIL_BYPASS atu_enabled=1 memories_enabled=1 using_mem=0');
  c._parseAtuStatus('S5A1B2C3D|slice 0 RF_frequency=14.074000 mode=DIGU');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].status, 'TUNE_FAIL_BYPASS');
  assert.strictEqual(got[0].atu_enabled, '1');
  assert.strictEqual(c.atuStatus, 'TUNE_FAIL_BYPASS');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
