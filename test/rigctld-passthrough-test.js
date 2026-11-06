#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// electricfalcon (2026-11-03, a Pi running rigctld): a custom CAT button could
// only send radio CAT, wrapped in rigctld's `w`, so rigctld's own commands
// (set the VFO, the split) could not be sent. A command starting with + or \
// now goes to rigctld as typed.
// Run: node test/rigctld-passthrough-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rigctldPassthrough } = require('../lib/raw-cat-command');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { GENERIC_CAPS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
function codec() {
  const writes = [];
  const c = new RigctldCodec(GENERIC_CAPS.rigctld || { brand: 'Hamlib', protocol: 'rigctld', caps: {} }, (d) => writes.push(String(d)));
  return { c, writes };
}

test('+ and \\ commands are rigctld commands, sent as typed', () => {
  const { c, writes } = codec();
  c.sendRaw('+V VFOB');
  c.sendRaw('\\set_vfo VFOB');
  c.sendRaw('  +S 1 VFOB\r\n');
  assert.deepStrictEqual(writes, ['+V VFOB\n', '\\set_vfo VFOB\n', '+S 1 VFOB\n']);
});

test('radio CAT still goes through w, text and Icom hex alike', () => {
  const { c, writes } = codec();
  c.sendRaw('FA014074000;');
  c.sendRaw('FE FE 94 E0 1C 00 01 FD');
  assert.strictEqual(writes[0], 'w FA014074000;\n');
  assert.ok(/^w \\0xfe\\0xfe\\0x94/.test(writes[1]), writes[1]);
});

test('the prefix is only a command when a letter follows', () => {
  assert.strictEqual(rigctldPassthrough('+V VFOB'), '+V VFOB');
  assert.strictEqual(rigctldPassthrough('\\get_freq'), '\\get_freq');
  assert.strictEqual(rigctldPassthrough('+'), null);
  assert.strictEqual(rigctldPassthrough('+5;'), null);
  assert.strictEqual(rigctldPassthrough('FA;'), null);
});

test('the custom CAT help names the prefix', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  const custom = html.slice(html.indexOf('id="rig-tab-custom"'), html.indexOf('id="rig-tab-presets"'));
  assert.ok(/<code>\+V VFOB<\/code>/.test(custom) && /<code>\\set_vfo VFOB<\/code>/.test(custom));
});

console.log(`\nrigctld passthrough: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
