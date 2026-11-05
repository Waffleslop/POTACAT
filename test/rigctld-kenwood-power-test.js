#!/usr/bin/env node
'use strict';
// A Kenwood behind Hamlib keeps its TX power when POTACAT connects
// (physicsdaqguy TS-590SG, djrev TS-2000: both read exactly 5 W).
//
// Hamlib 4.7.2's RFPOWER level on these radios runs kenwood_get_power_minmax,
// which sends PC;PC000;PC;PC255;PC;PC000; to learn the range — and "restores"
// PC000. POTACAT's first power poll (`l RFPOWER`) therefore left the radio at
// its minimum. The set path re-runs the probe after a mode change. Power is now
// read with `w PC;` and set with `w PCnnn;` (watts) on those models, and
// Hamlib's level is never asked.
// Run: node test/rigctld-kenwood-power-test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { RigctldCodec, kenwoodRawPower } = require('../lib/codecs/rigctld-codec');
const { GENERIC_CAPS } = require('../lib/rig-models');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const HAMLIB = GENERIC_CAPS.rigctld;
function codec(model, opts) {
  const writes = [];
  const c = new RigctldCodec(model, (d) => writes.push(String(d)), opts);
  const feed = (s) => c.onData(Buffer.from(s));
  return { c, writes, feed };
}

test('Other Rig (Hamlib) TS-590SG (2037): the power poll is w PC;, never l RFPOWER', () => {
  const { c, writes, feed } = codec(HAMLIB, { hamlibRigId: 2037 });
  let watts = null, hz = null;
  c.on('power', (w) => { watts = w; });
  c.on('frequency', (f) => { hz = f; });
  c.getPower();
  assert.deepStrictEqual(writes, ['w PC;\n']);
  c.getFrequency();
  // rigctld ends a w reply with a NUL and no newline; the next reply follows.
  feed('PC050;\u000014074000\n');
  assert.strictEqual(watts, 50);
  assert.strictEqual(hz, 14074000);
});

test('setting power on a TS-2000 (2014) writes PCnnn; in watts', () => {
  const { c, writes } = codec(HAMLIB, { hamlibRigId: 2014 });
  c.setTxPowerWatts(40);
  assert.strictEqual(writes[writes.length - 1], 'w PC040;\n');
  c.setTxPower(0.25);
  assert.strictEqual(writes[writes.length - 1], 'w PC025;\n');
  assert.ok(!writes.some((w) => /RFPOWER|power2mW/.test(w)), JSON.stringify(writes));
  c.probePowerScale(14074000);
  assert.ok(!writes.some((w) => /power2mW/.test(w)));
});

test('a Kenwood model picked in My Rigs uses raw PC over rigctld too', () => {
  assert.ok(kenwoodRawPower(GENERIC_CAPS.kenwood, 0));
});

test('Elecraft, Flex, QRP Labs and the Hamlib dummy keep Hamlib\'s power level', () => {
  for (const id of [1, 2029, 2036, 2045, 2052, 2054, 3088]) {
    const { c, writes } = codec(HAMLIB, { hamlibRigId: id });
    c.getPower();
    assert.deepStrictEqual(writes, ['l RFPOWER\n'], 'model ' + id);
  }
});

test('rigctld Network: dump_caps naming a TS-590SG switches to raw PC before the first power read', () => {
  const { c, writes, feed } = codec(HAMLIB);
  c.probeCaps();
  c.getPower();
  assert.ok(!writes.some((w) => /RFPOWER/.test(w)), 'asked Hamlib before the caps said which radio');
  feed('Caps dump for model: 2037\nModel name:\tTS-590SG\nMfg name:\tKenwood\nRPRT 0\n');
  c.getPower();
  assert.strictEqual(writes[writes.length - 1], 'w PC;\n');
});

// Real bundled rigctld in front of a simulated TS-590SG (Kenwood CAT over TCP).
const bin = path.join(__dirname, '..', 'assets', 'hamlib', process.platform === 'win32' ? 'rigctld.exe' : 'rigctld');
function fakeTs590() {
  const st = { PC: 50, FA: 14074000, MD: 2, written: [] };
  const answer = (c) => {
    if (c === 'ID') return 'ID021;';
    if (c === 'PC') return 'PC' + String(st.PC).padStart(3, '0') + ';';
    if (/^PC\d+$/.test(c)) { st.written.push(c); st.PC = Math.max(5, Math.min(100, +c.slice(2))); return ''; }
    if (c === 'FA') return 'FA' + String(st.FA).padStart(11, '0') + ';';
    if (c === 'IF') return 'IF' + String(st.FA).padStart(11, '0') + '     +00000000000' + st.MD + '0000000 ;';
    if (c === 'MD') return 'MD' + st.MD + ';';
    if (c === 'DA') return 'DA0;';
    if (c === 'SF1') return 'SF10001407400002;';
    if (c === 'PS') return 'PS1;';
    if (c === 'KS') return 'KS020;';
    if (/^[A-Z]{2}$/.test(c)) return '?;';
    return '';
  };
  const srv = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf(';')) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 1); const r = answer(c); if (r) s.write(r); }
    });
  });
  return { srv, st };
}

test('real rigctld + simulated TS-590SG: reading and setting power never writes PC000 or PC255', async () => {
  if (!fs.existsSync(bin)) { console.log('       (SKIP: no bundled rigctld)'); return; }
  const { srv, st } = fakeTs590();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = 46000 + Math.floor(Math.random() * 900);
  const proc = spawn(bin, ['-m', '2037', '-r', `127.0.0.1:${srv.address().port}`, '-T', '127.0.0.1', '-t', String(port)], { stdio: 'ignore', windowsHide: true });
  let sock;
  try {
    await new Promise((r) => setTimeout(r, 2000));
    sock = net.connect(port, '127.0.0.1');
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    const c = new RigctldCodec(HAMLIB, (d) => sock.write(d), { hamlibRigId: 2037 });
    sock.on('data', (d) => c.onData(d));
    let read = null;
    c.on('power', (w) => { read = w; });
    c.getPower();
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(read, 50, 'read ' + read);
    assert.strictEqual(st.PC, 50, 'the radio was left at ' + st.PC + ' W');
    c.setTxPowerWatts(40);
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(st.PC, 40);
    assert.deepStrictEqual(st.written, ['PC040'], 'PC writes: ' + st.written.join(','));
  } finally {
    if (sock) sock.destroy();
    proc.kill();
    srv.close();
  }
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
  }
  console.log(`\nrigctld Kenwood power: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
