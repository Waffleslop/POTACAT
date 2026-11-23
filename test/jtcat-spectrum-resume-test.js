#!/usr/bin/env node
'use strict';
/**
 * #943: the phone's FT8 waterfall went grey ("Waiting for desktop waterfall")
 * after a band or mode change, and stayed grey until the operator toggled the
 * waterfall. Every engine start runs stopJtcat() first, which stops the
 * in-process spectrum loop that feeds the phone; nothing started it again,
 * because the phone's panel never closed and so never re-subscribed. The
 * sticky _mobileWantsSpectrum intent is the source of truth: an engine start
 * resumes the feed from it, the same way a reconnect does.
 */
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
const main = readSrc(path.join(ROOT, 'main.js'));
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** The text of a top-level `function name(` up to its closing brace at column 0. */
function fnSource(name) {
  const at = main.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, name + ' not found in main.js');
  const end = main.indexOf('\n}\n', at);
  return main.slice(at + 1, end + 2);
}
/** An `ipcMain.on('<channel>'` handler body, up to its closing `  });` line. */
function ipcSource(channel) {
  const at = main.indexOf("ipcMain.on('" + channel + "'");
  assert.ok(at >= 0, channel + ' handler not found in main.js');
  return main.slice(at, main.indexOf('\n  });\n', at));
}

console.log('Engine restart keeps the phone waterfall');
check('stopJtcat stops the loop but never drops the phone\'s intent', () => {
  const stop = fnSource('stopJtcat');
  assert.ok(/stopInProcessSpectrum\(\);/.test(stop));
  assert.ok(!/_mobileWantsSpectrum\s*=/.test(stop), 'stopJtcat must not clear _mobileWantsSpectrum');
});
check('startJtcat resumes the feed after its own stopJtcat (band and mode changes)', () => {
  const start = fnSource('startJtcat');
  const stopAt = start.indexOf('stopJtcat();');
  const resumeAt = start.indexOf('resumeMobileSpectrum();');
  assert.ok(stopAt >= 0, 'startJtcat stops the old engine first');
  assert.ok(resumeAt > stopAt, 'startJtcat must call resumeMobileSpectrum() after stopJtcat()');
});
check('a multi-slice start resumes it too', () => {
  const multi = ipcSource('jtcat-start-multi');
  const stopAt = multi.indexOf('stopJtcat();');
  const resumeAt = multi.indexOf('resumeMobileSpectrum();');
  assert.ok(stopAt >= 0 && resumeAt > stopAt, 'jtcat-start-multi must call resumeMobileSpectrum() after stopJtcat()');
});

// Run the real loop functions from main.js against stubs: subscribe, the
// engine restart's stop, then the resume.
function sandbox({ wants, client }) {
  const timers = new Set();
  const ctx = {
    console: { log() {} },
    setInterval(fn) { const t = { fn }; timers.add(t); return t; },
    clearInterval(t) { timers.delete(t); },
    powerSaveBlocker: { start: () => 1, isStarted: () => true, stop() {} },
    remoteServer: { hasClient: () => client, broadcastJtcatSpectrum() {} },
    remoteAudioWin: null,
    rxSpectrumSync() {},
    timers,
  };
  vm.createContext(ctx);
  const src = [
    'const SPECTRUM_INTERVAL_MS = 100;',
    'let _spectrumTimer = null;',
    'let _rxSpecBridgeOn = false;',
    'let _spectrumPowerSaveId = null;',
    'let _mobileWantsSpectrum = ' + JSON.stringify(!!wants) + ';',
    fnSource('_acquireSpectrumPowerSave'),
    fnSource('_releaseSpectrumPowerSave'),
    fnSource('startInProcessSpectrum'),
    fnSource('stopInProcessSpectrum'),
    fnSource('resumeMobileSpectrum'),
    'this.api = { start: startInProcessSpectrum, stop: stopInProcessSpectrum, resume: resumeMobileSpectrum,',
    '  armed: () => !!_spectrumTimer, blocker: () => _spectrumPowerSaveId !== null };',
  ].join('\n');
  vm.runInContext(src, ctx);
  return ctx;
}
check('subscribed phone: stop (engine restart) then resume re-arms the loop and the blocker', () => {
  const ctx = sandbox({ wants: true, client: true });
  ctx.api.start();
  assert.ok(ctx.api.armed());
  ctx.api.stop(); // what stopJtcat() does on every engine start
  assert.ok(!ctx.api.armed(), 'the restart stops the loop');
  ctx.api.resume();
  assert.ok(ctx.api.armed(), 'the loop is back without a re-subscribe');
  assert.ok(ctx.api.blocker(), 'the app-suspension blocker is back while the phone watches');
  assert.strictEqual(ctx.timers.size, 1, 'exactly one loop');
  ctx.api.resume();
  assert.strictEqual(ctx.timers.size, 1, 'resume is idempotent');
});
check('no phone watching: an engine start does not arm the loop', () => {
  const ctx = sandbox({ wants: false, client: true });
  ctx.api.resume();
  assert.ok(!ctx.api.armed());
  assert.ok(!ctx.api.blocker());
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
