#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// lib/raw-cat-command.js — custom CAT buttons carrying raw bytes.
//
// The reported failure (K8IKO, IC-7410 over rigctld, 2026-09-20): antenna
// buttons built from the manual's `FE FE 80 E0 12 00 FD` did nothing —
//
//   rx: RPRT -1 (Invalid argument) — likely rejecting "w \xfe\xfe\x80\xe0\x12\x00\xfd"
//
// — while the identical bytes sent from CI-V Scout switched the antenna, which
// proved the frame itself was right. rigctld's `w` (send_cmd) takes binary as
// `\0xNN`; POTACAT emitted `\xNN`. Hamlib's parser hit a backslash it could not
// read and returned RIG_EINVAL without putting anything on the wire.
//
// Confirmed against the bundled hamlib rigctld (dummy backend, `-m 1`):
//   w \0xfe\0xfe\0x80\0xe0\0x12\0x00\0xfd  ->  "\0xFE\0xFE\0x80\0xE0\0x12\0x00\0xFD 7"
//       (parsed, normalized, 7 bytes counted)
//   w \xfe\xfe\x80\xe0\x12\x00\xfd         ->  "\xfe\xfe\x80\xe0\x12\x00\xfd"
//       (echoed verbatim — sent to the radio as the CHARACTERS \ x f e)
//
// Run:  node test/raw-cat-command-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rawCatBytes, rigctldRawArg } = require('../lib/raw-cat-command');

let pass = 0;
let fail = 0;
const failures = [];

function check(msg, fn) {
  try { fn(); pass++; } catch (err) {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}\n      ${err.message}`);
  }
}
function section(name) { console.log(`\n=== ${name} ===`); }

const ANT1 = 'FE FE 80 E0 12 00 FD';
const ANT1_BYTES = [0xFE, 0xFE, 0x80, 0xE0, 0x12, 0x00, 0xFD];

section('The reported case');

check('K8IKO\'s antenna command is recognised as bytes', () => {
  assert.deepStrictEqual(rawCatBytes(ANT1), ANT1_BYTES);
});

check('rigctld gets \\0xNN escapes, not \\xNN', () => {
  assert.strictEqual(rigctldRawArg(ANT1), '\\0xfe\\0xfe\\0x80\\0xe0\\0x12\\0x00\\0xfd');
});

check('the old, rejected spelling is gone', () => {
  const arg = rigctldRawArg(ANT1);
  assert.ok(!/\\x[0-9a-f]{2}/.test(arg), `hamlib rejects this form outright: ${arg}`);
});

check('his second attempt — the same frame without spaces — works too', () => {
  // He retyped it unspaced when the spaced form failed. Both are the same
  // bytes and both must send.
  assert.deepStrictEqual(rawCatBytes('fefe80e01200fd'), ANT1_BYTES);
  assert.strictEqual(rigctldRawArg('fefe80e01200fd'), rigctldRawArg(ANT1));
});

section('ASCII commands stay ASCII');

check('a Kenwood/Yaesu command passes through untouched', () => {
  assert.strictEqual(rawCatBytes('FA014074000;'), null);
  assert.strictEqual(rigctldRawArg('FA014074000;'), 'FA014074000;');
});

check('a short ASCII token that is also valid hex stays text', () => {
  // `AB` is a real Yaesu command (VFO A->B). Reading it as one byte would
  // send the radio 0xAB instead.
  assert.strictEqual(rawCatBytes('AB'), null);
  assert.strictEqual(rigctldRawArg('AB'), 'AB');
});

check('an unbroken run that is not a CI-V frame stays text', () => {
  // No FE FE preamble / FD terminator, so this is somebody's ASCII command
  // that happens to be spelled with hex letters.
  assert.strictEqual(rawCatBytes('DEADBEEF'), null);
});

check('empty and nullish input yields nothing', () => {
  assert.strictEqual(rawCatBytes(''), null);
  assert.strictEqual(rawCatBytes(null), null);
  assert.strictEqual(rawCatBytes(undefined), null);
  assert.strictEqual(rigctldRawArg(''), '');
});

section('Tidying what the operator typed');

check('surrounding whitespace and line endings are stripped', () => {
  assert.deepStrictEqual(rawCatBytes('  FE FE 80 E0 12 00 FD \r\n'), ANT1_BYTES);
  assert.strictEqual(rigctldRawArg(' FA014074000; \r\n'), 'FA014074000;');
});

check('case does not matter and the escape is lower case', () => {
  assert.strictEqual(rigctldRawArg('fe fe 80 e0 12 00 fd'), rigctldRawArg(ANT1));
});

check('a two-byte pair is still bytes', () => {
  assert.deepStrictEqual(rawCatBytes('12 00'), [0x12, 0x00]);
});

section('Source guards');

const rigctldSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'rigctld-codec.js'), 'utf-8');
const catSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cat.js'), 'utf-8');
const civSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'civ-codec.js'), 'utf-8');

check('the rigctld codec builds its w argument through this module', () => {
  assert.ok(rigctldSrc.includes("require('../raw-cat-command')"), 'module not required');
  assert.ok(rigctldSrc.includes('rigctldRawArg(cmd)'), 'sendRaw does not use it');
});

check('the legacy rigctld client in cat.js uses it too', () => {
  // It had no hex handling at all: an Icom frame went out as the literal
  // characters "FE FE 80 E0 12 00 FD".
  assert.ok(catSrc.includes("require('./raw-cat-command')"), 'module not required');
  assert.ok(catSrc.includes('rigctldRawArg(cmd)'), 'sendRaw does not use it');
});

check('the CI-V codec parses bytes through it', () => {
  assert.ok(civSrc.includes("require('../raw-cat-command')"), 'module not required');
  assert.ok(civSrc.includes('rawCatBytes(text)'), 'sendRaw does not use it');
});

check('no \\x escape builder has grown back in any sender', () => {
  for (const [name, src] of [['rigctld-codec.js', rigctldSrc], ['cat.js', catSrc]]) {
    assert.ok(!src.includes("'\\\\x' +"), `${name} builds a \\xNN escape again — hamlib rejects it`);
  }
});

console.log('\n' + '='.repeat(52));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('All tests passed.');
