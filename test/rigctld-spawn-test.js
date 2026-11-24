#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// What POTACAT hands the bundled rigctld (main.js spawnRigctld), pinned by
// two field reports of 2026-10-23/24. Run: node test/rigctld-spawn-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const main = readSrc(path.join(__dirname, '..', 'main.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('a bridge Hamlib model (Dummy / NET / FLRig / TRXManager / TCI) on a serial port is resolved to the radio by name, or named (WX4MWA, -m 4 on COM6)', () => {
  assert.ok(/const HAMLIB_BRIDGE_MODELS = \{ 1: 'Dummy', 2: 'NET rigctl', 4: 'FLRig', 5: 'TRXManager', 6: 'TCI' \};/.test(main));
  assert.ok(/if \(HAMLIB_BRIDGE_MODELS\[Number\(target\.rigId\)\] && target\.serialPort\) \{/.test(main));
  assert.ok(/const fixed = await hamlibModelForRadio\(rigctldPath\);/.test(main) && /target = \{ \.\.\.target, rigId: fixed \};/.test(main));
  // the picker never offers them
  assert.ok(/const SKIP_IDS = new Set\(\[1, 2, 4, 5, 6\]\);/.test(main));
});

test('the Ten-Tec Jupiter and Argonaut V get DTR and RTS raised (their interface is powered by the lines — ACLog "Power Option = Both", NO4D)', () => {
  assert.ok(/const HAMLIB_LINES_POWER_RIG = \{ 16002: 'Ten-Tec TT-538 Jupiter', 16007: 'Ten-Tec TT-516 Argonaut V' \};/.test(main));
  const i = main.indexOf("if (target.dtrOff) args.push('--set-conf=dtr_state=OFF,rts_state=OFF');");
  assert.ok(i > 0);
  const after = main.slice(i, i + 900);
  assert.ok(/else if \(HAMLIB_LINES_POWER_RIG\[Number\(target\.rigId\)\]\) \{/.test(after), 'only when DTR/RTS off was NOT asked for');
  assert.ok(/args\.push\('--set-conf=dtr_state=ON,rts_state=ON'\);/.test(after));
});

test('Xiegu with no PTT port: DTR and RTS held low so a Digirig is not keyed on connect (bankonthat)', () => {
  assert.ok(/const HAMLIB_LINES_LOW_RIG = \{ 3076: 'Xiegu X108G', 3087: 'Xiegu X6100', 3088: 'Xiegu G90', 3089: 'Xiegu X5105', 3091: 'Xiegu X6200' \};/.test(main));
  const i = main.indexOf("if (target.dtrOff) args.push('--set-conf=dtr_state=OFF,rts_state=OFF');");
  const after = main.slice(i, i + 1600);
  assert.ok(/else if \(!target\.pttPort && HAMLIB_LINES_LOW_RIG\[Number\(target\.rigId\)\]\) \{\s*args\.push\('--set-conf=dtr_state=OFF,rts_state=OFF'\);/.test(after),
    'only without a separate PTT port (with one, Hamlib drives the PTT line itself)');
  assert.ok(after.indexOf('HAMLIB_LINES_LOW_RIG[') > after.indexOf('HAMLIB_LINES_POWER_RIG['), 'after the powered-lines rule');
});

test('POTACAT\'s rigctld listens on 127.0.0.1 only: -T from lib/rigctld-bind.js right before -t (Casey 2026-11-22)', () => {
  assert.ok(/const \{ RIGCTLD_HOST, rigctldListenArgs \} = require\('\.\/lib\/rigctld-bind'\);/.test(main));
  const i = main.indexOf('function spawnRigctld(target, portOverride) {');
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/'-s', String\(target\.baudRate \|\| 9600\),\s*\.\.\.rigctldListenArgs\(port\),\s*\];/.test(body),
    'the args end -s <baud> -T 127.0.0.1 -t <port>');
  assert.ok(!/'-t', port/.test(body), 'no bare -t left (it would bind every interface)');
  assert.ok(!/0\.0\.0\.0/.test(body), 'never all interfaces');
  // the macOS callout device and the PTT port options are untouched
  assert.ok(/'-r', serialPort,/.test(body));
  assert.ok(/args\.push\('--ptt-file=' \+ \(calloutTwin\(target\.pttPort\) \|\| target\.pttPort\)\);/.test(body));
  const { rigctldListenArgs } = require('../lib/rigctld-bind');
  assert.deepStrictEqual(rigctldListenArgs('4532'), ['-T', '127.0.0.1', '-t', '4532']);
});

test('POTACAT connects to its own rigctld on RIGCTLD_HOST (127.0.0.1), never "localhost" (::1)', () => {
  assert.ok(/transport\.connect\(\{ host: RIGCTLD_HOST, port: rigctldPort \}\);/.test(main), 'the live link');
  assert.ok(/net\.createConnection\(\{ host: RIGCTLD_HOST, port: 4533 \}/.test(main), 'Test Connection');
  assert.ok(!/host: 'localhost', port: (rigctldPort|4533)/.test(main));
});

test('the bundled Hamlib still numbers them so (a renumbered Hamlib would silently miss them)', () => {
  const exe = path.join(__dirname, '..', 'assets', 'hamlib', process.platform === 'win32' ? 'rigctld.exe' : 'rigctld');
  if (!fs.existsSync(exe)) { console.log('       (no bundled rigctld here — skipped)'); return; }
  const out = require('child_process').execFileSync(exe, ['-l'], { encoding: 'utf8', timeout: 20000 });
  assert.ok(/^\s*16002\s+Ten-Tec\s+TT-538 Jupiter/m.test(out), 'Jupiter is 16002');
  assert.ok(/^\s*16007\s+Ten-Tec\s+TT-516 Argonaut V/m.test(out), 'Argonaut V is 16007');
  assert.ok(/^\s*4\s+FLRig/m.test(out), 'FLRig is 4');
  assert.ok(/^\s*2014\s+Kenwood\s+TS-2000/m.test(out), 'TS-2000 is 2014');
  assert.ok(/^\s*3088\s+Xiegu\s+G90/m.test(out), 'G90 is 3088');
  assert.ok(/^\s*3087\s+Xiegu\s+X6100/m.test(out), 'X6100 is 3087');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
