#!/usr/bin/env node
'use strict';
// An OPERATOR mode change stops TX and clears decodes and callers (Casey, #517).
// Within FT8 / FT4 / FT2 / WSPR the mode used to change under a live QSO, Run
// and Hunt: TX stayed enabled and the old mode's decodes stayed on screen and in
// the server's replay buffer. A family switch already went through stopJtcat.
// Automatic mode hops keep Run going (docs/JTCAT.md) and must not come here.
// Run: node test/jtcat-mode-change-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { operatorModeChange } = require('../lib/jtcat-mode-change');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const root = path.join(__dirname, '..');
const read = (f) => readSrc(path.join(root, f));
const MAIN = read('main.js');
const REMOTE = read('renderer/remote.js');

function fnBody(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing: ' + header);
  const close = src.indexOf(') {', i);
  let depth = 0, j = close >= 0 && close - i < 200 ? close + 2 : src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(j, k + 1); }
  }
  throw new Error('unbalanced: ' + header);
}
function handlerBody(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing: ' + header);
  return fnBody(src.slice(i), '=> {');
}

// A fake shack: records the order of effects; the spot target lives beside it.
function shack(mode) {
  const s = { mode, calls: [], spotTarget: { call: 'K3SBP', mode: 'FT4' } };
  s.d = {
    engineMode: () => s.mode,
    halt: (why) => s.calls.push('halt:' + why),
    clearDecodes: () => s.calls.push('clear'),
    setMode: (m) => { s.calls.push('setMode:' + m); s.mode = m; },
    modeHopReset: () => s.calls.push('hopReset'),
    wsprSessionEnd: () => s.calls.push('wsprEnd'),
    pushActivityState: () => s.calls.push('push'),
  };
  return s;
}

test('FT8 -> FT4 by the operator halts TX, clears decodes, then sets the mode', () => {
  const s = shack('FT8');
  assert.strictEqual(operatorModeChange('FT4', s.d), true);
  assert.deepStrictEqual(s.calls, ['halt:Mode change', 'clear', 'setMode:FT4', 'hopReset', 'wsprEnd', 'push']);
});

test('the same mode again halts nothing and clears nothing', () => {
  const s = shack('FT4');
  assert.strictEqual(operatorModeChange('FT4', s.d), false);
  assert.ok(!s.calls.some((c) => c.startsWith('halt') || c === 'clear'), s.calls.join(','));
  assert.ok(s.calls.includes('setMode:FT4'));
});

test('to WSPR halts too, and keeps the WSPR session', () => {
  const s = shack('FT8');
  operatorModeChange('WSPR', s.d);
  assert.strictEqual(s.calls[0], 'halt:Mode change');
  assert.ok(!s.calls.includes('wsprEnd'));
});

test('the hunt the operator just asked for survives (spot target untouched)', () => {
  const s = shack('FT8');
  operatorModeChange('FT4', s.d);
  assert.deepStrictEqual(s.spotTarget, { call: 'K3SBP', mode: 'FT4' });
  // ...and in main.js neither the halt nor the mode change touches the target.
  const halt = fnBody(MAIN, 'function jtcatHaltTxNow(');
  const change = fnBody(MAIN, 'function jtcatOperatorModeChange(');
  for (const [name, body] of [['jtcatHaltTxNow', halt], ['jtcatOperatorModeChange', change]]) {
    assert.ok(!/clearSpotTarget|jtcatSpotTarget\s*=/.test(body), name + ' must not clear the spot target');
  }
});

test('main.js: the helper halts with the one halt and empties the server replay', () => {
  const change = fnBody(MAIN, 'function jtcatOperatorModeChange(');
  assert.ok(/halt:[^\n]*jtcatHaltTxNow\(/.test(change), 'halt must be jtcatHaltTxNow');
  assert.ok(/remoteServer\.clearJtcatDecodes\(\)/.test(change), 'server decode buffer must be cleared');
});

test('both operator handlers (pop-out IPC and ECHOCAT) go through the helper', () => {
  const ipc = handlerBody(MAIN, "ipcMain.on('jtcat-set-mode'");
  const ws = handlerBody(MAIN, "remoteServer.on('jtcat-set-mode'");
  for (const [name, body] of [['ipc', ipc], ['echocat', ws]]) {
    assert.ok(body.includes('jtcatOperatorModeChange(mode'), name + ' handler must call jtcatOperatorModeChange');
    assert.ok(!/ft8Engine\.setMode\(/.test(body), name + ' handler sets the mode around the helper');
    assert.ok(body.indexOf('startJtcat(mode)') < body.indexOf('jtcatOperatorModeChange(mode'),
      name + ': a family switch still rebuilds first');
  }
});

test('the auto-RX hand-back changes the mode without a halt', () => {
  const s = shack('WSPR');
  assert.strictEqual(operatorModeChange('FT8', s.d, { handBack: true }), true);
  assert.ok(!s.calls.some((c) => c.startsWith('halt')), 'the hand-back must not halt: ' + s.calls.join(','));
  assert.ok(s.calls.includes('clear') && s.calls.includes('setMode:FT8'));
  // main.js: the hand-back marks itself, and only the internal emit can.
  assert.ok(/ipcMain\.emit\('jtcat-set-mode', null, restoreMode, \{ handBack: true \}\)/.test(MAIN));
  assert.strictEqual((MAIN.match(/handBack: true/g) || []).length, 1, 'only the auto-RX hand-back may skip the halt');
  const ipc = handlerBody(MAIN, "ipcMain.on('jtcat-set-mode'");
  assert.ok(/handBack: !!\(internal && internal\.handBack\)/.test(ipc));
  assert.ok(/jtcatSetMode: \(mode\) => ipcRenderer\.send\('jtcat-set-mode', mode\)/.test(read('preload-jtcat-popout.js')),
    'a renderer must not be able to pass the hand-back flag');
});

test('an automatic mode hop never halts (Run survives a hop)', () => {
  const hop = fnBody(MAIN, 'function jtcatHopMode(');
  assert.ok(/ft8Engine\.setMode\(next\)/.test(hop));
  assert.ok(!/jtcatOperatorModeChange|jtcatHaltTxNow/.test(hop), 'a hop must not halt');
  const engine = read('lib/ft8-engine.js');
  const setMode = fnBody(engine, '  setMode(');
  assert.ok(!/halt|clearJtcatDecodes/i.test(setMode), 'never put the clearing inside the engine setMode');
});

test('remote-server clearJtcatDecodes empties the replay buffer', () => {
  const RemoteServer = require('../lib/remote-server');
  const Cls = RemoteServer.RemoteServer || RemoteServer;
  const fake = { _jtcatDecodeBuffer: [{ a: 1 }, { b: 2 }] };
  Cls.prototype.clearJtcatDecodes.call(fake);
  assert.strictEqual(fake._jtcatDecodeBuffer.length, 0);
});

test('ECHOCAT Web: its mode select clears decodes and callers', () => {
  const clear = fnBody(REMOTE, 'function ft8ClearForModeChange(');
  assert.ok(/ft8DecodeLog = \[\]/.test(clear));
  assert.ok(/ft8ClearMyActivity\(\)/.test(clear), 'the calling list (My Activity) must clear');
  assert.ok(!/ft8HuntCall/.test(clear), 'the hunt call is not the mode change\'s to clear');
  const sel = handlerBody(REMOTE, "ft8ModeSelect.addEventListener('change'");
  assert.ok(sel.indexOf("type: 'jtcat-set-mode'") < sel.indexOf('ft8ClearForModeChange('), 'clear on the mode change');
});

test('ECHOCAT Web: a spot click on another mode clears before it sets the hunt', () => {
  const at = REMOTE.indexOf("if (ft8Running) ft8Send({ type: 'jtcat-set-mode', mode: ft8Mode });");
  assert.ok(at > 0);
  const seg = REMOTE.slice(at, at + 600);
  const clr = seg.indexOf('ft8ClearForModeChange(');
  const hunt = seg.indexOf('ft8HuntCall = callsign.toUpperCase()');
  assert.ok(clr > 0 && hunt > clr, 'the clear must come before the hunt call is set');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
