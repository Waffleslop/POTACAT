#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// VFO window PTT: what the PC microphone did. Run: node test/vfo-ptt-mic-test.js
//
// KD9OUT (#170, FT-710 on serial): PTT in the VFO window keyed the radio with
// no modulation while ECHOCAT voice through the same PC modulated it. Both
// paths play into the same output (settings.remoteAudioOutput) and key the
// same way; only the input differs. The window opened "System Default" (or a
// device the operator picked), any failure went to the window's console and
// the radio keyed anyway, and nothing logged which device was opened or its
// level. Now every press logs one line naming the input, the output and the
// level, and a problem shows a notice in the window.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const root = path.join(__dirname, '..');
let M = null;
try { M = require('../lib/vfo-ptt-mic'); } catch (e) { M = null; }

check('module loads', () => assert.ok(M && typeof M.assess === 'function', 'lib/vfo-ptt-mic.js with assess()'));

const base = {
  path: 'usb',
  micChosen: '',
  inputLabel: 'Microphone (Realtek(R) Audio)',
  rigInputId: 'rig-in',
  rigInputLabel: 'Microphone (USB Audio CODEC )',
  outputId: 'rig-out',
  outputLabel: 'Speakers (USB Audio CODEC )',
  peakDbfs: -32,
  heldMs: 2000,
};
const a = (over) => M.assess({ ...base, ...over });

if (M) {
  check('labelBase strips the Windows role prefix', () => {
    assert.strictEqual(M.labelBase('Default - Microphone (USB Audio CODEC )'), 'Microphone (USB Audio CODEC )');
    assert.strictEqual(M.labelBase('Communications - Mic (X)'), 'Mic (X)');
    assert.strictEqual(M.labelBase(''), '');
  });

  check('a working mic is ok, and the line names input, output and level', () => {
    const r = a({});
    assert.strictEqual(r.problem, null);
    assert.strictEqual(r.notice, null);
    assert.ok(/^\[VFO PTT\] /.test(r.line), r.line);
    assert.ok(r.line.includes('"Microphone (Realtek(R) Audio)"'), r.line);
    assert.ok(r.line.includes('System Default'), r.line);
    assert.ok(r.line.includes('"Speakers (USB Audio CODEC )"'), r.line);
    assert.ok(/-32 dBFS/.test(r.line), r.line);
    assert.ok(!/\n/.test(r.line), 'one line');
  });

  check('mic blocked (NotAllowedError) = no-mic, names Windows microphone privacy', () => {
    const r = a({ inputLabel: '', peakDbfs: null, error: 'Permission denied', errorName: 'NotAllowedError', stage: 'mic' });
    assert.strictEqual(r.problem, 'no-mic');
    assert.ok(/privacy/i.test(r.line) && /privacy/i.test(r.notice), r.notice);
    assert.ok(/keyed/i.test(r.notice), 'says the radio keyed without audio');
  });

  check('chosen mic gone (OverconstrainedError/NotFoundError) = no-mic, points at the Microphone select', () => {
    for (const errorName of ['OverconstrainedError', 'NotFoundError']) {
      const r = a({ micChosen: 'gone-id', inputLabel: '', peakDbfs: null, error: 'x', errorName, stage: 'mic' });
      assert.strictEqual(r.problem, 'no-mic');
      assert.ok(/Transmit audio/.test(r.notice) && /Microphone/.test(r.notice), r.notice);
    }
  });

  check('no output set on a USB-audio rig = no-output (mic plays on this PC)', () => {
    const r = a({ outputId: '', outputLabel: '' });
    assert.strictEqual(r.problem, 'no-output');
    assert.ok(/TX audio out \(to radio\)/.test(r.notice), r.notice);
  });

  check('output failed to open = output-failed', () => {
    const r = a({ error: 'NotFoundError: Requested device not found', errorName: 'NotFoundError', stage: 'output', peakDbfs: null });
    assert.strictEqual(r.problem, 'output-failed');
    assert.ok(/TX audio out \(to radio\)/.test(r.notice), r.notice);
  });

  check('System Default that is the radio codec = mic-is-radio', () => {
    const r = a({ inputLabel: 'Default - Microphone (USB Audio CODEC )', peakDbfs: -95 });
    assert.strictEqual(r.problem, 'mic-is-radio');
    assert.ok(/System Default/.test(r.notice) && /Microphone/.test(r.notice), r.notice);
  });

  check('a chosen mic equal to the rig RX input (by id) = mic-is-radio, even with a level', () => {
    const r = a({ micChosen: 'rig-in', inputId: 'rig-in', inputLabel: 'Line (Interface)', rigInputLabel: 'Line (Interface)', peakDbfs: -40 });
    assert.strictEqual(r.problem, 'mic-is-radio');
  });

  check('silence from a real mic = silent', () => {
    const r = a({ peakDbfs: -120 });
    assert.strictEqual(r.problem, 'silent');
    assert.ok(/-120 dBFS/.test(r.line), r.line);
    assert.ok(/privacy/i.test(r.notice), 'silent stream is also what blocked privacy gives');
  });

  check('a press too short to measure judges errors only', () => {
    const r = a({ peakDbfs: null, heldMs: 200 });
    assert.strictEqual(r.problem, null);
    assert.ok(/not measured/.test(r.line), r.line);
  });

  check('direct paths (Flex/K4/Icom LAN) have no output device to judge', () => {
    const r = a({ path: 'direct', outputId: '', outputLabel: '' });
    assert.strictEqual(r.problem, null);
    assert.ok(/radio over the network/.test(r.line), r.line);
  });

  check('labels are quoted safely (one line, bounded)', () => {
    const r = a({ inputLabel: 'evil\nline' + 'x'.repeat(500) });
    assert.ok(!/\n/.test(r.line));
    assert.ok(r.line.length < 700, String(r.line.length));
  });
}

// --- wiring -----------------------------------------------------------------
const html = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const start = html.slice(html.indexOf('async function pttStart() {'), html.indexOf('function pttStop() {'));
const main = readSrc(path.join(root, 'main.js'));
const preload = readSrc(path.join(root, 'preload-vfo-popout.js'));
const index = readSrc(path.join(root, 'renderer', 'index.html'));

check('the VFO window loads the module', () => {
  assert.ok(html.includes('<script src="../lib/vfo-ptt-mic.js"></script>'));
});

check('pttStart records the failing stage and always closes what it opened', () => {
  assert.ok(/stage = 'mic'/.test(start) && /stage = 'output'/.test(start), 'stages recorded');
  const c = start.slice(start.indexOf("console.error('[VFO] Mic PTT failed:'"));
  assert.ok(/abandon\(\);/.test(c.slice(0, 400)), 'catch abandons the mic it opened (leak when setSinkId threw)');
});

check('the report is sent after the key-down, by a press that is still current', () => {
  const key = start.indexOf('window.api.nakedPtt(true)');
  const probe = start.indexOf('vfoPttMicProbe(');
  assert.ok(key > 0 && probe > key, 'probe after key-down');
  const fn = html.slice(html.indexOf('function vfoPttMicProbe('), html.indexOf('function vfoPttMicProbe(') + 2500);
  assert.ok(/remoteShack/.test(fn), 'skipped when driving a remote shack');
  assert.ok(/window\.api\.vfoPttMicReport\(/.test(fn), 'sends the report');
  assert.ok(/VfoPttMic\.assess\(/.test(fn), 'notice from the same rules as the log');
});

check('preload and main carry the report to the log', () => {
  assert.ok(/vfoPttMicReport: \(r\) => ipcRenderer\.send\('vfo-ptt-mic-report', r\)/.test(preload));
  const h = main.slice(main.indexOf("ipcMain.on('vfo-ptt-mic-report'"), main.indexOf("ipcMain.on('vfo-ptt-mic-report'") + 400);
  assert.ok(h.length > 40, 'handler present');
  assert.ok(/sendCatLog\(/.test(h) && /assess\(/.test(h), 'logs the assessed line');
});

check('every UI label the notices name exists', () => {
  if (!M) throw new Error('module missing');
  const all = [
    a({ inputLabel: '', peakDbfs: null, error: 'x', errorName: 'NotAllowedError', stage: 'mic' }),
    a({ micChosen: 'g', inputLabel: '', peakDbfs: null, error: 'x', errorName: 'NotFoundError', stage: 'mic' }),
    a({ outputId: '' }),
    a({ error: 'x', errorName: 'NotFoundError', stage: 'output', peakDbfs: null }),
    a({ inputLabel: 'Default - Microphone (USB Audio CODEC )' }),
    a({ peakDbfs: -120 }),
  ].map((r) => r.notice).join(' ');
  if (/Transmit audio/.test(all)) assert.ok(html.includes('<div class="lbl">Transmit audio</div>'));
  if (/Microphone/.test(all)) assert.ok(html.includes('<span>Microphone</span>'));
  if (/System Default/.test(all)) assert.ok(html.includes('System Default'));
  if (/TX audio out \(to radio\)/.test(all)) assert.ok(index.includes('TX audio out (to radio):'));
  assert.ok(!/Help menu|File menu/.test(all));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
