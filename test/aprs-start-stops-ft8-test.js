#!/usr/bin/env node
'use strict';
// APRS Start with FT8 decoding (K3SBP 2026-11-22, FLEX-6000 on Flex Direct):
// "I am unable to switch to APRS decoding. When I hit 'start decoding' on
// APRS on desktop, it should kill FT8 decoding. The tear-down is something we
// do for other modes." Every press logged "not listening: FT8 is decoding.
// Stop it to listen to APRS." while a phone-started FT8 engine ran with no
// JTCAT window open.
//
// Now the operator's Start (the APRS window's switch, an owner's phone) hands
// the radio over the way opening SSTV does (releaseJtcatForSstv): JTCAT's
// transmitters are halted, the engine stops, ECHOCAT hears running:false, the
// window and the log say "Stopped FT8 so APRS can listen." Automatic starts
// and a Guest Pass guest keep the plain refusal. FT8 is not restarted when
// APRS stops (SSTV does not restart it either).
// Run: node test/aprs-start-stops-ft8-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const L = require('../lib/aprs-listen');

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function fnBody(name) {
  const m = new RegExp('^(async )?function ' + name + '\\(', 'm').exec(MAIN);
  assert.ok(m, 'missing function ' + name);
  return MAIN.slice(m.index, MAIN.indexOf('\n}\n', m.index));
}
const topLevel = (name) => new RegExp(`^(async )?function ${name}\\(|^(const|let|var) ${name}\\b`, 'm').test(MAIN);

const FREE = { remote: false, catConnected: true, bands: null, band: '2m', freq: { hz: 144390000, mhz: '144.390' }, modemFound: true, ft8Decoding: false, winlinkHasModem: false };
const plan = (f, o) => L.startPlan({ ...FREE, ...f }, o);

console.log('APRS Start stops FT8');

// ── The rule (lib/aprs-listen.js startPlan) ──────────────────────────────────
test('Start with FT8 decoding stops FT8 and listens', () => {
  assert.deepStrictEqual(plan({ ft8Decoding: true }, { operatorAsked: true }), { stopFt8: true, no: null });
});

test('nothing in the way: listens, FT8 untouched', () => {
  assert.deepStrictEqual(plan({}, { operatorAsked: true }), { stopFt8: false, no: null });
});

test('automatic starts (listen on open, Idle Mode, a phone beacon) keep the refusal', () => {
  const r = plan({ ft8Decoding: true }, {});
  assert.strictEqual(r.stopFt8, false);
  assert.strictEqual(r.no.reason, 'ft8');
  assert.strictEqual(r.no.sentence, 'FT8 is decoding. Stop it to listen to APRS.');
});

test('a Guest Pass guest never stops the owner\'s FT8', () => {
  const r = plan({ ft8Decoding: true }, { operatorAsked: true, guest: true });
  assert.strictEqual(r.stopFt8, false);
  assert.strictEqual(r.no.reason, 'ft8');
});

test('any other refusal stands and FT8 is left running', () => {
  for (const [p, reason] of [[{ catConnected: false }, 'no-cat'], [{ remote: true }, 'remote'], [{ modemFound: false }, 'no-modem'], [{ freq: null }, 'no-freq'], [{ winlinkHasModem: true }, 'winlink'], [{ bands: ['20m'], band: '2m' }, 'no-band']]) {
    const r = plan({ ft8Decoding: true, ...p }, { operatorAsked: true });
    assert.strictEqual(r.stopFt8, false, reason);
    assert.strictEqual(r.no.reason, reason);
  }
});

// ── TX in progress: the same rule as SSTV (halt, never refuse) ───────────────
test('TX or a QSO in progress follows SSTV: no refusal, the halt drops PTT first', () => {
  // The SSTV hand-over has no transmitting refusal; it stops the engine, and
  // stopJtcat cancels the tones and PTT. APRS matches it and halts first.
  const shared = fnBody('releaseJtcatFor');
  assert.ok(!/jtcatAnyTxActive|_txActive|jtcatQsoLive/.test(shared), 'the shared hand-over never refuses during TX');
  assert.ok(!/transmitting|txActive|jtcatQso/.test(L.startPlan.toString()), 'startPlan has no TX refusal');
  const take = fnBody('aprsStopJtcatForListen');
  const halt = take.indexOf("jtcatHaltTxNow('APRS listening')");
  assert.ok(halt > 0, 'Halt TX (Run, Hunt, the WSPR beacon, the message on the air, PTT)');
  assert.ok(halt < take.indexOf("releaseJtcatFor('APRS')"), 'halted before the engine stops');
  assert.ok(!/keepAuto/.test(take), 'every automatic transmitter stands down');
});

// ── The line ─────────────────────────────────────────────────────────────────
test('the line: "Stopped FT8 so APRS can listen."', () => {
  assert.strictEqual(L.ft8StoppedSentence('FT8'), 'Stopped FT8 so APRS can listen.');
  assert.strictEqual(L.ft8StoppedSentence('FT4'), 'Stopped FT4 so APRS can listen.');
  assert.strictEqual(L.ft8StoppedSentence('JS8'), 'Stopped JS8 so APRS can listen.');
  assert.strictEqual(L.ft8StoppedSentence(''), 'Stopped FT8 so APRS can listen.');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(L.ft8StoppedSentence('FT8')));
});

test('the line goes to the log and to the window and phone (the radio card note)', () => {
  const take = fnBody('aprsStopJtcatForListen');
  assert.ok(/const line = AprsListen\.ft8StoppedSentence\(mode\);\s*aprsLog\(line\);\s*return line;/.test(take));
  const start = fnBody('aprsListenStart');
  assert.ok(/aprsListen\.handover = aprsStopJtcatForListen\(\);/.test(start));
  assert.ok(/aprsListen\.noteBase = \[aprsListen\.handover, aprsListen\.noteBase\]/.test(start), 'the note the window and ECHOCAT show');
  assert.ok(/aprsListen\.handover = '';/.test(start), 'cleared on every start');
  assert.ok(/\[aprsListen\.handover, aprsSetupLine\(\), r\.sentence, r\.rit\]/.test(fnBody('aprsRxFilterWiden')), 'the Flex filter line keeps it');
});

// ── Wiring ───────────────────────────────────────────────────────────────────
test('aprsListenStart asks startPlan with the operator flag, then stops FT8 before it tunes', () => {
  const start = fnBody('aprsListenStart');
  assert.ok(/async function aprsListenStart\(\{ resume = false, operator = false, guest = false \} = \{\}\)/.test(start));
  assert.ok(/AprsListen\.startPlan\(\{[\s\S]*ft8Decoding: autoSstvBlockedByJtcat\(\),[\s\S]*\}, \{ operatorAsked: operator, guest \}\)/.test(start));
  const stop = start.indexOf('if (start.stopFt8)');
  assert.ok(stop > start.indexOf('if (no) { aprsNotNow(no); return; }'), 'only when nothing else refuses');
  assert.ok(stop < start.indexOf('tuneRadio('), 'before the radio moves');
});

test('the window\'s switch and an owner\'s phone are the operator; automatic starts are not', () => {
  assert.ok(/ipcMain\.on\('aprs-listen-set', \(_e, on\) => \{ markUserActive\(\); aprsListenSet\(!!on, \{ operator: true \}\);/.test(MAIN));
  assert.ok(/listenSet: \(on\) => aprsListenSet\(on, \{ operator: true, guest: !!\(aprsEcho && aprsEcho\.guestListening\(\)\) \}\)/.test(MAIN));
  assert.ok(/aprsListenStart\(\{ operator: !!opts\.operator, guest: !!opts\.guest \}\)/.test(fnBody('aprsListenSet')));
  assert.ok(/aprsListenSet\(true\);/.test(fnBody('aprsAutoListenOnOpen')), 'listen on open: no operator flag');
  assert.ok(/if \(autoIdleAprsOwnsListen\) aprsListenSet\(true\);/.test(MAIN), 'Idle Mode: no operator flag');
});

test('the tear-down is the SSTV one: windows closed, engine stopped, main window capture released, phones told', () => {
  assert.ok(/function releaseJtcatForSstv\(\) \{ return releaseJtcatFor\('SSTV'\); \}/.test(MAIN));
  const b = fnBody('releaseJtcatFor');
  assert.ok(/jtcatPopoutWin\.close\(\)/.test(b) && /js8PopoutWin\.close\(\)/.test(b));
  assert.ok(/stopJtcat\(\);\n\s+remoteJtcatQso = null;/.test(b));
  assert.ok(/'jtcat-stop-for-remote'/.test(b), 'the main window stops its capture (a phone-started engine)');
  assert.ok(/broadcastJtcatStatus\(\{ running: false \}\)/.test(b), 'ECHOCAT sees FT8 stop');
});

test('APRS never transmits and never restarts FT8', () => {
  const take = fnBody('aprsStopJtcatForListen');
  assert.ok(!/startJtcat|acquireRadio|handleRemotePtt\(true|setTransmit\(true|aprsRfSend|aprsBeaconSend/.test(take));
  assert.ok(!/startJtcat\(/.test(fnBody('aprsListenStop')), 'listening stopping does not start FT8 again');
  assert.ok(!/startJtcat\(/.test(fnBody('releaseJtcatFor')));
});

test('every name the new glue uses is at module scope', () => {
  const b = fnBody('aprsStopJtcatForListen').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const n of ['ft8Engine', 'jtcatHaltTxNow', 'releaseJtcatFor', 'AprsListen', 'aprsLog']) {
    assert.ok(new RegExp('\\b' + n + '\\b').test(b), n);
    assert.ok(topLevel(n), n + ' is not declared at module scope');
  }
});

test('this test is in the list CI runs', () => {
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-start-stops-ft8-test.js'"));
});

console.log(`\nAPRS Start stops FT8: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
