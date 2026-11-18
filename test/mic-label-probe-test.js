#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// Device-name probe opens the mic with voice processing off. Run: node test/mic-label-probe-test.js
//
// #743 (AB1EX, macOS, 1.14.6): opening Settings made the playback volume jump
// for a moment and return. The Settings summary, the rig audio lists, the VARA
// setup and the VFO window's mic list each opened the default microphone only
// to unlock device names, with getUserMedia({ audio: true }): echo
// cancellation, noise suppression and auto gain all ON. On macOS that switches
// on system voice processing, which changes the level of what is playing until
// the mic closes. Every such probe now goes through lib/mic-label-probe.js,
// which asks for all three OFF and stops the tracks at once. Refs #658.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const root = path.join(__dirname, '..');
let P = null;
try { P = require('../lib/mic-label-probe'); } catch (e) { P = null; }

function fakeMedia(opts) {
  const o = opts || {};
  const calls = [];
  const tracks = [{ stopped: 0, stop() { this.stopped++; } }, { stopped: 0, stop() { this.stopped++; } }];
  return {
    calls, tracks,
    md: {
      getUserMedia(c) {
        calls.push(c);
        if (o.fail) return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
        return Promise.resolve({ getTracks: () => tracks });
      },
    },
  };
}

(async () => {
  await check('module loads', () => assert.ok(P && typeof P.unlockDeviceLabels === 'function', 'lib/mic-label-probe.js with unlockDeviceLabels()'));

  await check('constraints: echo cancellation, noise suppression and auto gain all false', async () => {
    const f = fakeMedia();
    await P.unlockDeviceLabels(f.md);
    assert.strictEqual(f.calls.length, 1);
    const a = f.calls[0].audio;
    assert.ok(a && typeof a === 'object', 'audio constraints are an object, not true');
    assert.strictEqual(a.echoCancellation, false);
    assert.strictEqual(a.noiseSuppression, false);
    assert.strictEqual(a.autoGainControl, false);
    assert.strictEqual(f.calls[0].video, undefined);
  });

  await check('every track is stopped before it returns', async () => {
    const f = fakeMedia();
    await P.unlockDeviceLabels(f.md);
    assert.deepStrictEqual(f.tracks.map((t) => t.stopped), [1, 1]);
  });

  await check('each call gets its own constraints object (no shared mutable state)', async () => {
    const f = fakeMedia();
    await P.unlockDeviceLabels(f.md);
    f.calls[0].audio.echoCancellation = true;
    await P.unlockDeviceLabels(f.md);
    assert.strictEqual(f.calls[1].audio.echoCancellation, false);
  });

  await check('a refused mic throws the error so callers can still enumerate', async () => {
    const f = fakeMedia({ fail: true });
    await assert.rejects(() => P.unlockDeviceLabels(f.md), /Permission denied/);
  });

  await check('no mediaDevices: throws a readable error', async () => {
    await assert.rejects(() => P.unlockDeviceLabels(null), /mediaDevices/);
  });

  // Source guards: no renderer surface opens the mic with browser defaults
  // just to read names, and the label probes use the shared helper.
  const index = readSrc(path.join(root, 'renderer', 'index.html'));
  const app = readSrc(path.join(root, 'renderer', 'app.js'));
  const vfo = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
  const fs = require('fs');

  await check('no renderer file calls getUserMedia({ audio: true })', () => {
    const dir = path.join(root, 'renderer');
    const bad = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(js|html)$/.test(f)) continue;
      const src = readSrc(path.join(dir, f));
      if (/getUserMedia\(\s*\{\s*audio\s*:\s*true\s*\}\s*\)/.test(src)) bad.push(f);
    }
    assert.deepStrictEqual(bad, [], 'label probes go through MicLabelProbe.unlockDeviceLabels');
  });

  await check('main window loads the helper and its three label probes use it', () => {
    assert.ok(index.includes('<script src="../lib/mic-label-probe.js"></script>'));
    const uses = app.match(/MicLabelProbe\.unlockDeviceLabels\(navigator\.mediaDevices\)/g) || [];
    assert.strictEqual(uses.length, 3, 'VARA setup, populateRigAudioDevices, populateQuickAudioDevices');
    for (const fn of ['async function populateRigAudioDevices', 'async function populateQuickAudioDevices']) {
      const i = app.indexOf(fn);
      assert.ok(i >= 0, fn);
      assert.ok(app.slice(i, i + 1200).includes('MicLabelProbe.unlockDeviceLabels('), fn + ' uses the helper');
    }
  });

  await check('VFO window loads the helper and its mic list uses it', () => {
    assert.ok(vfo.includes('<script src="../lib/mic-label-probe.js"></script>'));
    const i = vfo.indexOf('async function populateMicDevices');
    assert.ok(i >= 0);
    assert.ok(vfo.slice(i, i + 600).includes('MicLabelProbe.unlockDeviceLabels(navigator.mediaDevices)'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
