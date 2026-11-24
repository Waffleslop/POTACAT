#!/usr/bin/env node
'use strict';
// The sound files in renderer/sounds/ (#1041) are exactly what
// scripts/make-qso-sounds.js renders from its note lists: no file comes from
// anywhere else. This renders them again and compares every byte, and pins
// that the generator reads no audio and uses nothing that differs between
// machines.
// Run: node test/qso-sound-files-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const gen = require('../scripts/make-qso-sounds');
const Q = require('../lib/qso-sounds');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'renderer', 'sounds');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('QSO sound files');
const built = gen.build();

test('the folder holds the generator\'s files and nothing else', () => {
  const want = built.map((f) => f.name).sort();
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), want);
  assert.deepStrictEqual(want, Q.FILES.map((id) => id + '.wav').sort(), 'the same nine the app plays');
});

test('every committed file is byte for byte what the generator renders', () => {
  for (const f of built) {
    const onDisk = fs.readFileSync(path.join(dir, f.name));
    assert.ok(onDisk.equals(f.bytes), f.name + ' differs: run node scripts/make-qso-sounds.js');
  }
});

test('rendering twice gives the same bytes', () => {
  const again = gen.build();
  built.forEach((f, i) => assert.ok(f.bytes.equals(again[i].bytes), f.name));
});

test('each file is 16-bit mono PCM at 44.1 kHz, starts and ends on silence, and never clips', () => {
  for (const f of built) {
    const b = f.bytes;
    assert.strictEqual(b.toString('latin1', 0, 4), 'RIFF');
    assert.strictEqual(b.toString('latin1', 8, 16), 'WAVEfmt ');
    assert.deepStrictEqual([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)], [1, 1, 44100, 16], f.name);
    assert.strictEqual(b.readUInt32LE(40), b.length - 44);
    const n = (b.length - 44) / 2;
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(b.readInt16LE(44 + i * 2)));
    assert.ok(top > 8000 && top < 32000, f.name + ' peak ' + top);
    assert.strictEqual(b.readInt16LE(44), 0, f.name + ' starts at zero');
    assert.ok(Math.abs(b.readInt16LE(b.length - 2)) < 40, f.name + ' ends at zero');
  }
});

test('the lengths: the coin about 0.1 s, the short coin about 0.06 s, the milestone sounds as the set', () => {
  const sec = Object.fromEntries(built.map((f) => [f.name.replace('.wav', ''), f.seconds]));
  const near = (id, want, tol) => assert.ok(Math.abs(sec[id] - want) <= tol, `${id} is ${sec[id].toFixed(3)} s, wanted about ${want}`);
  near('potacat-coin', 0.1, 0.02);
  near('potacat-coin-short', 0.06, 0.01);
  near('potacat-dupe', 0.2, 0.05);
  near('potacat-save-failed', 0.33, 0.05);
  near('potacat-010-pickup', 14 / 60, 0.001);
  near('potacat-025-power-up', 38 / 60, 0.001);
  near('potacat-050-stage-get', 55 / 60, 0.001);
  near('potacat-100-boss-down', 81 / 60, 0.001);
  near('potacat-250-world-clear', 224 / 60, 0.001);
});

test('the contact sounds are quieter than the milestone sounds', () => {
  const peak = (id) => gen.SOUNDS[id].peak;
  for (const quiet of ['potacat-coin', 'potacat-coin-short', 'potacat-dupe']) {
    for (const m of Object.values(Q.MILESTONE_SOUND)) assert.ok(peak(quiet) < peak(m), quiet + ' < ' + m);
  }
});

test('the generator reads no audio and uses nothing that differs between machines', () => {
  const src = readSrc(path.join(root, 'scripts', 'make-qso-sounds.js'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/readFileSync\([^)]*\)(?!\.equals)/.test(code.replace(/fs\.readFileSync\(file\)\.equals/g, '')), 'it reads only its own output, to compare it');
  assert.ok(!/Math\.(random|sin|cos|pow|exp|log|sqrt|tan)\b/.test(code), 'no random, no transcendental functions');
  assert.ok(!/require\('(?!fs'|path')/.test(code), 'only fs and path');
  assert.ok(!/child_process|ffmpeg|https?:/.test(code), 'no encoder, no download');
  assert.ok(/Date\b/.test(code) === false, 'no clock');
});

test('this test is in the list CI runs', () => {
  const list = readSrc(path.join(root, 'scripts', 'run-tests.js'));
  for (const t of ['test/qso-sound-files-test.js', 'test/qso-sounds-test.js', 'test/sound-guard-test.js']) assert.ok(list.includes("'" + t + "'"), t);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
