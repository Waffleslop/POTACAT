#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// MM0TWX FTDX5000 (set up as FTDX3000), 2026-10-20: POTACAT read the dial
// and every tune did nothing. The FT-450/950/2000 and FTDX1200/3000/5000 take
// an EIGHT-digit FA; POTACAT sent the nine-digit form of the FT-891/991/710
// generation, which those radios refuse without a reply.
//
// Run:  node test/yaesu-fa-digits-test.js

const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${msg}`);
}
function codecFor(name) {
  const out = [];
  const logs = [];
  const c = new KenwoodCodec(RIG_MODELS[name], (d) => out.push(d));
  c.on('log', (l) => logs.push(l));
  return { c, out, logs };
}

for (const name of ['FT-450', 'FT-2000', 'FTDX3000', 'FTDX5000']) {
  const { c, out } = codecFor(name);
  c.setFrequency(14061941);
  assert(out.join('') === 'FA14061941;', `${name}: 8-digit FA (got ${out.join('')})`);
}
for (const name of ['FT-891', 'FT-991/991A', 'FT-710', 'FTDX10', 'FTDX101D/MP']) {
  const { c, out } = codecFor(name);
  c.setFrequency(7002900);
  assert(out.join('') === 'FA007002900;', `${name}: 9-digit FA (got ${out.join('')})`);
}
assert(RIG_MODELS.FTDX5000 && RIG_MODELS.FTDX5000.maxPower === 200, 'FTDX5000 is a model of its own (200 W)');

{ // The wrong model picked: the radio's own reply sets the width.
  const { c, out, logs } = codecFor('FT-710');
  c.onData('FA14061000;');
  c.setFrequency(7002900);
  assert(out.join('') === 'FA07002900;', `9-digit model, 8-digit radio: follows the reply (got ${out.join('')})`);
  assert(logs.some((l) => /8-digit frequencies/.test(l)), 'says so once in the log');
  out.length = 0;
  c.onData('FA014061000;');
  c.setFrequency(7002900);
  assert(out.join('') === 'FA007002900;', 'and back to 9 for a 9-digit reply');
}
{ // A user command override is never rewritten (the controller writes
  // overrides into _cmds; _defaultCmds keeps the model's own table).
  const { c, out } = codecFor('FT-710');
  c._cmds.setFreq = 'FA{freq:pad9};';
  c._defaultCmds.setFreq = 'FA{freq:pad10};';
  c.onData('FA14061000;');
  c.setFrequency(7002900);
  assert(out.join('') === 'FA007002900;', `override kept (got ${out.join('')})`);
}
{ // Kenwood stays 11.
  const { c, out } = codecFor('TS-480');
  c.onData('FA00014061000;');
  c.setFrequency(7002900);
  assert(out.join('') === 'FA00007002900;', 'Kenwood: 11 digits');
}

console.log(`\nYaesu FA digits: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
