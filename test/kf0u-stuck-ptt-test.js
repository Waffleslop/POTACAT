#!/usr/bin/env node
'use strict';
// KF0U's FT-710 keyed at 0 W for hours (1.11.5/1.11.6, 2026-10-17..20),
// released only by closing the browser or POTACAT — and no log of it survived:
//   1. session.log kept ONE previous run; a manual restart + the updater's
//      restart pushed the overnight run out before anyone could read it.
//   2. Both his bug reports were filed AFTER the keying, and the paste kept
//      only the lines after the "recording started" marker.
//   3. A PTT release that found the CAT link down was dropped in silence, and
//      a link the staleness watchdog declared DOWN comes back on the next
//      reply with no PTT-off safety (only a transport reconnect has one).
// Run: node test/kf0u-stuck-ptt-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BUG_REPORT_MARKER, selectReportLines, sessionLogRotationMoves } = require('../lib/bug-report-log');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('KF0U stuck PTT: evidence survives, release is never dropped');
const main = R('main.js');
const mk = (n, p) => Array.from({ length: n }, (_, i) => `${p} ${i}`);

test('rotation keeps three runs: session.log → .old → .old2 → .old3, oldest dropped', () => {
  const plan = sessionLogRotationMoves('/x/session.log', 3);
  assert.strictEqual(plan.unlink, '/x/session.log.old3');
  assert.deepStrictEqual(plan.moves, [
    { from: '/x/session.log.old2', to: '/x/session.log.old3' },
    { from: '/x/session.log.old', to: '/x/session.log.old2' },
    { from: '/x/session.log', to: '/x/session.log.old' },
  ], 'oldest first, so no rename clobbers a newer file');
  assert.deepStrictEqual(sessionLogRotationMoves('/x/s.log', 1), { unlink: '/x/s.log.old', moves: [{ from: '/x/s.log', to: '/x/s.log.old' }] }, 'one generation = the old behaviour');
  assert.strictEqual(sessionLogRotationMoves('/x/s.log').moves.length, 3, 'default is three');
});

test('main.js rotates through the plan at launch AND at the 5 MB mid-run rotation; the crash report still reads .old', () => {
  assert.ok(/const SESSION_LOG_GENERATIONS = 3;/.test(main));
  assert.ok(/function rotateSessionLog\(\) \{\n\s*const plan = sessionLogRotationMoves\(_sessionLogPath, SESSION_LOG_GENERATIONS\);/.test(main));
  assert.strictEqual((main.match(/rotateSessionLog\(\);/g) || []).length, 2, 'launch + mid-run');
  assert.ok(!/const old = _sessionLogPath \+ '\.old';\n\s*try \{ fs\.unlinkSync\(old\); \} catch \{\}\n\s*fs\.renameSync\(_sessionLogPath, old\);/.test(main), 'no hand-rolled single-generation rename left');
  assert.ok(/prevTail\(_sessionLogPath \+ '\.old', 200\)/.test(main), 'the previous run is still .old');
});

test('a report filed after the fact carries the lines before the marker', () => {
  const lines = [...mk(500, 'startup'), BUG_REPORT_MARKER, ...mk(50, 'repro')];
  const sel = selectReportLines(lines, { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400, beforeMarker: 150 });
  assert.strictEqual(sel.tail[0], 'startup 350', 'tail opens 150 lines above the marker');
  assert.strictEqual(sel.tail[150], BUG_REPORT_MARKER);
  assert.strictEqual(sel.tail.length, 201);
  assert.strictEqual(sel.skipped, 200);
  assert.strictEqual(sel.head.length + sel.skipped + sel.tail.length, lines.length, 'nothing counted twice');
  // Marker near the top: the window is clamped, head and tail meet, no gap.
  const early = selectReportLines([...mk(20, 's'), BUG_REPORT_MARKER, ...mk(5, 'r')], { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400, beforeMarker: 150 });
  assert.strictEqual(early.skipped, 0);
  assert.strictEqual(early.head.concat(early.tail).length, 26);
  // Long repro: the END is still what survives.
  const long = selectReportLines([...mk(200, 's'), BUG_REPORT_MARKER, ...mk(1000, 'r')], { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400, beforeMarker: 150 });
  assert.strictEqual(long.tail[long.tail.length - 1], 'r 999');
  assert.strictEqual(long.tail.length, 400);
  // Default unchanged for callers that do not ask.
  assert.strictEqual(selectReportLines(lines, { marker: BUG_REPORT_MARKER }).tail[0], BUG_REPORT_MARKER);
  assert.ok(/const BUG_REPORT_BEFORE_MARKER = 150;/.test(main) && /beforeMarker: BUG_REPORT_BEFORE_MARKER/.test(main), 'main asks for 150');
});

test('a PTT release that finds the link down is remembered and sent on link-up', () => {
  const fn = main.slice(main.indexOf('function handleRemotePtt('), main.indexOf('\n}\n', main.indexOf('function handleRemotePtt(')));
  assert.ok(/sendCatLog\('PTT FAILED: CAT not connected[^']*'\);\n\s*\} else \{[\s\S]*?_pttReleasePending = true;/.test(fn), 'the silent drop is gone');
  assert.ok(/if \(state\) _pttReleasePending = false;/.test(fn), 'a later key-down forgets it');
  const st = main.slice(main.indexOf('function sendCatStatus('), main.indexOf('function sendCatStatus(') + 600);
  assert.ok(/s\.connected && _pttReleasePending && cat && cat\.connected/.test(st) && /gatedSetTransmit\(false\)/.test(st), 'sent through the pass-gated PTT path on the next connected status');
  assert.ok(main.indexOf('let _pttReleasePending = false;') < main.indexOf('function sendCatStatus('), 'declared before use');
  // The status event that carries a stale-link recovery must still exist.
  const rc = R('lib/rig-controller.js');
  assert.ok(/this\._linkStale = false;\n\s*this\.connected = true;\n\s*this\.emit\('log', 'radio is answering polls again — link restored'\);\n\s*this\.emit\('status', \{ connected: true/.test(rc), 'stale recovery emits status connected:true');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
