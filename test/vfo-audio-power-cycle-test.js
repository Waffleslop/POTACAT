#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// VFO window radio audio after a radio power cycle (GitHub #247, ride1226,
// FT-710 on serial CAT, Windows). Run: node test/vfo-audio-power-cycle-test.js
//
// The FT-710's USB audio CODEC is powered by the radio. Power it off with the
// RIG button and the CODEC leaves Windows, which ends the VFO window's capture
// track; power it on and the CODEC comes back, sometimes under a new device
// ID. The window kept the dead stream: unmute only set the gain on it, so
// nothing played until the window was closed and reopened. Now the window
// reopens the capture on POTACAT's power-on, when the device reappears, and
// on unmute of a dead stream, following the device by name with
// lib/audio-device-heal.js (no second matcher).

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const root = path.join(__dirname, '..');
const R = (p) => readSrc(path.join(root, p));
let M = null;
try { M = require('../lib/vfo-audio-reattach'); } catch (e) { M = null; }

check('module loads', () => assert.ok(M && typeof M.decide === 'function' && typeof M.pickInput === 'function' && typeof M.logLine === 'function',
  'lib/vfo-audio-reattach.js with decide(), pickInput(), logLine()'));

const live = { active: true, direct: false, muted: false, streamLive: true, pending: false };
const S = (over) => ({ ...live, ...over });

if (M) {
  // --- decide(): power-on ---
  check('power-on while the window listens and is unmuted: reopen', () => {
    const d = M.decide(S({}), 'power-on');
    assert.strictEqual(d.reopen, true);
    assert.strictEqual(d.pending, true, 'stays pending until the reopen succeeds');
  });
  check('power-on with a dead stream, unmuted: reopen', () => {
    assert.strictEqual(M.decide(S({ streamLive: false }), 'power-on').reopen, true);
  });
  check('power-on while muted: nothing now, but remembered', () => {
    const d = M.decide(S({ muted: true }), 'power-on');
    assert.strictEqual(d.reopen, false);
    assert.strictEqual(d.pending, true);
  });
  check('power-on when the monitor is off: nothing to reattach', () => {
    const d = M.decide(S({ active: false }), 'power-on');
    assert.deepStrictEqual(d, { reopen: false, pending: false });
  });
  check('power-on on packet audio (SmartSDR / Icom Network / SCU-LAN10): untouched', () => {
    const d = M.decide(S({ direct: true }), 'power-on');
    assert.deepStrictEqual(d, { reopen: false, pending: false });
  });

  // --- decide(): unmute ---
  check('muted through the power cycle, then unmute: reopen', () => {
    const afterPower = M.decide(S({ muted: true }), 'power-on');
    const d = M.decide(S({ muted: false, pending: afterPower.pending }), 'unmute');
    assert.strictEqual(d.reopen, true);
  });
  check('unmute on a dead stream reopens it (the manual recovery)', () => {
    const d = M.decide(S({ muted: false, streamLive: false }), 'unmute');
    assert.strictEqual(d.reopen, true);
    assert.strictEqual(d.pending, true);
  });
  check('unmute on a live stream with nothing pending: just the gain, no reopen', () => {
    assert.deepStrictEqual(M.decide(S({}), 'unmute'), { reopen: false, pending: false });
  });

  // --- decide(): devicechange ---
  check('device change with a dead stream, unmuted: reopen', () => {
    const d = M.decide(S({ streamLive: false }), 'devicechange');
    assert.strictEqual(d.reopen, true);
    assert.strictEqual(d.pending, true);
  });
  check('device change with a dead stream while muted: remembered for unmute', () => {
    const d = M.decide(S({ streamLive: false, muted: true }), 'devicechange');
    assert.deepStrictEqual(d, { reopen: false, pending: true });
    assert.strictEqual(M.decide(S({ streamLive: false, pending: true }), 'unmute').reopen, true);
  });
  check('device change with a live stream and nothing pending (another USB device): leave it', () => {
    assert.deepStrictEqual(M.decide(S({}), 'devicechange'), { reopen: false, pending: false });
  });
  check('device change after a power-on that found no device yet: reopen now', () => {
    assert.strictEqual(M.decide(S({ pending: true }), 'devicechange').reopen, true);
  });
  check('an unknown event does nothing', () => {
    assert.deepStrictEqual(M.decide(S({ streamLive: false }), 'whatever'), { reopen: false, pending: true });
  });

  // --- pickInput(): follows the device by name through audio-device-heal ---
  const codec = 'Microphone (USB Audio CODEC )';
  const devs = (id, label = codec) => [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - ' + label },
    { kind: 'audioinput', deviceId: 'realtek', label: 'Microphone (Realtek(R) Audio)' },
    { kind: 'audioinput', deviceId: id, label },
    { kind: 'audiooutput', deviceId: 'out-' + id, label: 'Speakers (USB Audio CODEC )' },
  ];
  check('the saved ID is back: use it', () => {
    const r = M.pickInput({ deviceId: 'codec-1', label: codec, rigName: 'FT-710' }, devs('codec-1'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deviceId, 'codec-1');
    assert.strictEqual(r.label, codec);
  });
  check('the CODEC came back under a new ID: followed by name, with the heal note', () => {
    const r = M.pickInput({ deviceId: 'codec-1', label: codec, rigName: 'FT-710' }, devs('codec-2'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deviceId, 'codec-2');
    assert.ok(/came back under a new device ID .* following it by name/.test(r.note), r.note);
  });
  check('the CODEC is not back yet: not ok (wait for the next device change)', () => {
    const gone = devs('x').filter((d) => d.deviceId !== 'x');
    const r = M.pickInput({ deviceId: 'codec-1', label: codec, rigName: 'FT-710' }, gone);
    assert.strictEqual(r.ok, false);
  });
  check('a different device is never picked (no label match = not ok)', () => {
    const r = M.pickInput({ deviceId: 'codec-1', label: codec }, devs('other', 'Microphone (Some Webcam)'));
    assert.strictEqual(r.ok, false);
  });
  check('two identical CODECs: ambiguous, not guessed', () => {
    const list = devs('a').concat([{ kind: 'audioinput', deviceId: 'b', label: codec }]);
    const r = M.pickInput({ deviceId: 'gone', label: codec }, list);
    assert.strictEqual(r.ok, false);
  });
  check('no saved input (System Default): ok once any input exists', () => {
    assert.strictEqual(M.pickInput({ deviceId: '' }, devs('c')).ok, true);
    assert.strictEqual(M.pickInput({ deviceId: '' }, []).ok, false);
  });
  check('pickInput reuses audio-device-heal (no second matcher)', () => {
    const src = R('lib/vfo-audio-reattach.js');
    assert.ok(/healRigAudioDevices\(/.test(src), 'calls AudioDeviceHeal.healRigAudioDevices');
    assert.ok(!/\.label[^;\n]*===/.test(src.replace(/\/\/.*$/gm, '')), 'no label comparison of its own');
  });

  // --- logLine() ---
  check('one log line on reattach, names why and the device', () => {
    assert.strictEqual(M.logLine('power-on', codec), `[VFO] radio audio back after power-on — reopened "${codec}"`);
    assert.ok(/^\[VFO\] radio audio back after unmute — reopened "/.test(M.logLine('unmute', codec)));
    assert.ok(/^\[VFO\] radio audio back after .*device.* — reopened "/.test(M.logLine('devicechange', codec)));
  });
  check('logLine: one line, clipped, an unknown reason is not echoed', () => {
    const l = M.logLine('evil\nline', 'x'.repeat(500) + '\n');
    assert.ok(!/\n/.test(l));
    assert.ok(l.length < 200, l.length);
    assert.ok(!/evil/.test(l));
    assert.ok(/reopened "the default input"/.test(M.logLine('power-on', '')));
  });
}

// --- wiring guards ---
const main = R('main.js');
const vfo = R('renderer/vfo-popout.html');
const pre = R('preload-vfo-popout.js');

check('main: POTACAT power-on tells the VFO window, next to the scope', () => {
  const i = main.indexOf("case 'power-on': {");
  assert.ok(i > 0);
  const block = main.slice(i, main.indexOf('break;', main.indexOf('RigPower.powerOnReport', i)));
  assert.ok(/yaesuScopeNoteRadioBack\('radio powered on'\)/.test(block), 'scope still told');
  assert.ok(/vfoAudioNoteRadioBack\(/.test(block), 'VFO audio told in the same block');
  assert.ok(/function vfoAudioNoteRadioBack\([^)]*\)\s*\{[\s\S]{0,400}vfoPopoutWin\.webContents\.send\('vfo-radio-power-on'/.test(main));
});
check('main: the reattach log line goes through the pure helper', () => {
  assert.ok(/ipcMain\.on\('vfo-audio-reattached',[\s\S]{0,300}VfoAudioReattach\.logLine\(/.test(main) ||
    /ipcMain\.on\('vfo-audio-reattached',[\s\S]{0,300}vfo-audio-reattach'\)\.logLine\(/.test(main));
});
check('preload: power-on event and the reattach log are bridged', () => {
  assert.ok(/onRadioPowerOn:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('vfo-radio-power-on'/.test(pre));
  assert.ok(/vfoAudioReattached:\s*\([^)]*\)\s*=>\s*ipcRenderer\.send\('vfo-audio-reattached'/.test(pre));
});
check('VFO window loads audio-device-heal and the reattach helper', () => {
  assert.ok(/<script src="\.\.\/lib\/audio-device-heal\.js"><\/script>/.test(vfo));
  assert.ok(/<script src="\.\.\/lib\/vfo-audio-reattach\.js"><\/script>/.test(vfo));
});
check('VFO window: power-on, devicechange and unmute all go through decide()', () => {
  assert.ok(/window\.api\.onRadioPowerOn\(/.test(vfo));
  assert.ok(/navigator\.mediaDevices\.addEventListener\('devicechange'/.test(vfo));
  for (const ev of ['power-on', 'devicechange', 'unmute']) {
    assert.ok(new RegExp(`VfoAudioReattach\\.decide\\(\\w+\\(\\), '${ev}'\\)`).test(vfo), ev);
  }
});
check('VFO window: unmute no longer only sets the gain on a dead stream', () => {
  const i = vfo.indexOf('// Third click: unmute');
  assert.ok(i > 0);
  const branch = vfo.slice(i, vfo.indexOf('});', i));
  assert.ok(/reattachRadioAudio\('unmute'\)/.test(branch), branch);
});
check('VFO window: the reopen follows the device by name and logs one line', () => {
  const i = vfo.indexOf('async function reattachRadioAudio(');
  assert.ok(i > 0);
  const fn = vfo.slice(i, vfo.indexOf('\n}\n', i));
  assert.ok(/enumerateDevices\(\)/.test(fn));
  assert.ok(/VfoAudioReattach\.pickInput\(/.test(fn));
  assert.ok(/stopAudioMonitor\(\)/.test(fn) && /startAudioMonitor\(\{\s*deviceId:/.test(fn));
  assert.ok(/window\.api\.vfoAudioReattached\(/.test(fn));
});
check('VFO window: packet-audio paths are not reopened', () => {
  // The direct (SmartSDR / Icom Network / SCU-LAN10) branch is unchanged and
  // decide() is told the monitor is direct.
  assert.ok(/direct:\s*audioMonitorDirect/.test(vfo));
  assert.ok(/if \(s\.audioSource === 'smartsdr' \|\| s\.audioSource === 'icom-network' \|\| s\.audioSource === 'yaesu-lan'\)/.test(vfo));
});
check('run-tests registers this file', () => {
  assert.ok(R('scripts/run-tests.js').includes("'test/vfo-audio-power-cycle-test.js'"));
});

console.log(`\nVFO audio power cycle (#247): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
