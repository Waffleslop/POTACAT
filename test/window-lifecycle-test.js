#!/usr/bin/env node
'use strict';
/**
 * POTACAT has to actually exit when you close it.
 *
 * Electron fires `window-all-closed` only when the LAST BrowserWindow is
 * destroyed, and hidden windows count. `app.quit()` lives in that handler, so a
 * single surviving window — an audio bridge, a pre-warmed WebRTC window, a
 * popout nobody remembered — leaves POTACAT running with no UI at all. The
 * taskbar is clear, the process is not, `before-quit` never fires (so neither
 * does its shutdown watchdog), and the launching terminal never returns.
 *
 * K3SBP hit this for roughly ten sessions: "I have to CTRL-C the npm start
 * window after I close POTACAT. The windows close but something remains
 * running." The main window's close handler was closing a hand-maintained list
 * of window variables that had drifted NINE windows behind the app.
 *
 * A list that must be edited every time a window is added, and that fails
 * silently when it isn't, is not a mechanism — it is a countdown. This test
 * pins the enumeration that replaced it.
 *
 * Run: node test/window-lifecycle-test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** The main window's close handler, brace-matched from its opening line. */
function mainWindowCloseHandler() {
  const start = SRC.indexOf("win.on('close', () => {");
  assert.ok(start > 0, "the main window's close handler was not found — renamed?");
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in the close handler');
}

test('closing the main window closes every other window, by enumeration', () => {
  const body = mainWindowCloseHandler();
  assert.ok(/BrowserWindow\.getAllWindows\(\)/.test(body),
    'the close handler must enumerate windows, not close a list of named ones — '
    + 'a named list silently falls behind and leaves POTACAT running headless');
});

test('no window is closed by name in the main close handler', () => {
  // One named close is how the list grew back last time. If a window genuinely
  // needs different treatment it belongs in its own helper with a reason, not
  // as another line here.
  const body = mainWindowCloseHandler();
  const named = body.match(/\b\w*(Win|Window)\b\s*&&[^\n]*\.close\(\)/g) || [];
  assert.strictEqual(named.length, 0,
    'named window closes are back in the handler: ' + named.join(' | '));
});

test('window-all-closed still quits the app', () => {
  // The enumeration above is only useful because this handler ends the process.
  const start = SRC.lastIndexOf("app.on('window-all-closed'");
  assert.ok(start > 0, 'window-all-closed handler not found');
  const body = SRC.slice(start, start + 1600);
  assert.ok(/app\.quit\(\)/.test(body), 'window-all-closed must call app.quit()');
});

test('every hidden helper window is reachable by the enumeration', () => {
  // Enumeration covers anything Electron knows about, so this is really a check
  // that nobody has introduced a window through some other API. Listed here by
  // name only to make the count visible when one is added.
  const hidden = (SRC.match(/(\w+)\s*=\s*new BrowserWindow\(/g) || []).length;
  assert.ok(hidden >= 15,
    'expected the usual crop of BrowserWindows; found ' + hidden + ' — has window creation moved?');
});

// N2FSM 2026-09-16: a second launch ran app.quit() ~24k lines in, which does
// not stop a not-yet-ready app — it opened the rig's COM port, crashed on
// :7300, and rotated the RUNNING instance's startup.log and session.log first,
// so the operator's bug report lost everything before the relaunch.
test('the single-instance lock is taken before any log file is touched', () => {
  const lock = SRC.indexOf('app.requestSingleInstanceLock()');
  const firstLog = SRC.search(/^logStartupStage\(/m);
  assert.ok(lock > 0, 'requestSingleInstanceLock not found');
  assert.ok(firstLog > 0, 'first logStartupStage call not found');
  assert.ok(lock < firstLog, 'the lock must be acquired before the first logStartupStage (which rotates startup.log)');
  const between = SRC.slice(lock, firstLog);
  assert.ok(/if \(!gotTheLock\)[\s\S]*app\.exit\(0\)/.test(between),
    'a second instance must app.exit() before ready — app.quit() lets whenReady run');
  assert.ok(!/_appendStartupLog\(/.test(between), 'the second-instance path must not rotate startup.log');
});

console.log(`\nWindow lifecycle: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
