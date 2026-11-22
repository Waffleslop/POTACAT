#!/usr/bin/env node
'use strict';
// APRS phase 3: the 30 m receive config really decodes 300-baud HF APRS.
// The test builds AX.25 UI frames, turns them into 300-baud AFSK on the
// 1600/1800 Hz pair (no recording needed), feeds them to the bundled Dire Wolf
// over its socket audio input with the config lib/direwolf-process.js writes
// for 30 m (no PTT line, offline, no radio), and reads them back from the AGW
// monitor. The second pass is 70 Hz off tune and the third 190 Hz off, which
// only the nine staggered receive decoders ("9@30") reach: seven reached about
// 100 Hz, and a radio a little off lost every packet (2026-11-21 review).
//
// Needs the POTACAT build of Dire Wolf (its socket audio patch): assets/direwolf/
// after `scripts/build-winlink-helpers.sh`, or POTACAT_DIREWOLF_BIN. Without it
// the test says so and passes; a system Dire Wolf has no socket audio and is
// never used.
// Run: node test/direwolf-aprs-hf-decode-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const D = require('../lib/direwolf-process');
const Mon = require('../lib/direwolf-agw-monitor');
const AprsRfFrames = require('../lib/aprs-rf-frames');
const AprsParser = require('../lib/aprs-parser');

const RATE = D.DIREWOLF_RATE;
const SHIFTS = [0, 70, 190]; // Hz off tune: 190 is past what seven decoders reached
const BAUD = 300;

// ── AX.25 UI frame -> NRZI bits -> AFSK ─────────────────────────────────────
function addr(call, last, h) {
  const [c, s] = call.split('-');
  const b = Buffer.alloc(7);
  for (let i = 0; i < 6; i++) b[i] = (c.charCodeAt(i) || 0x20) << 1;
  b[6] = 0x60 | ((Number(s) || 0) << 1) | (last ? 1 : 0) | (h ? 0x80 : 0);
  return b;
}
/** TNC2 "FROM>TO,DIGI*,...:info" to an AX.25 UI frame with its FCS. */
function frame(tnc2) {
  const i = tnc2.indexOf(':');
  const [from, rest] = tnc2.slice(0, i).split('>');
  const [to, ...digis] = rest.split(',');
  const star = digis.findIndex((d) => d.endsWith('*'));
  const parts = [addr(to, false, false), addr(from, digis.length === 0, false)];
  digis.forEach((d, k) => parts.push(addr(d.replace('*', ''), k === digis.length - 1, k <= star)));
  const body = Buffer.concat([...parts, Buffer.from([0x03, 0xf0]), Buffer.from(tnc2.slice(i + 1), 'latin1')]);
  let crc = 0xffff;
  for (const byte of body) for (let k = 0; k < 8; k++) { const x = (crc ^ (byte >> k)) & 1; crc >>>= 1; if (x) crc ^= 0x8408; }
  crc ^= 0xffff;
  return Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
}
/** Flags, bit-stuffed frame, flags (LSB first). */
function bits(fr) {
  const out = [];
  const flag = () => { for (let k = 0; k < 8; k++) out.push((0x7e >> k) & 1); };
  for (let n = 0; n < 24; n++) flag();
  let ones = 0;
  for (const byte of fr) {
    for (let k = 0; k < 8; k++) {
      const b = (byte >> k) & 1;
      out.push(b);
      if (b) { if (++ones === 5) { out.push(0); ones = 0; } } else ones = 0;
    }
  }
  for (let n = 0; n < 4; n++) flag();
  return out;
}
/** NRZI AFSK: a 0 bit changes tone, a 1 keeps it. Phase-continuous, 16-bit mono at RATE. */
function afsk(bitList, shiftHz) {
  const lo = 1600 + shiftHz, hi = 1800 + shiftHz, spb = RATE / BAUD;
  const pcm = [];
  let tone = lo, phase = 0, acc = 0;
  for (const b of bitList) {
    if (b === 0) tone = tone === lo ? hi : lo;
    acc += spb;
    while (acc >= 1) { phase += 2 * Math.PI * tone / RATE; pcm.push(Math.round(Math.sin(phase) * 12000)); acc -= 1; }
  }
  for (let i = 0; i < RATE / 2; i++) pcm.push(0);
  const buf = Buffer.alloc(pcm.length * 2);
  pcm.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

const PACKETS = [
  'W1AW-9>APRS:!4140.00N/07243.00W>30 m direct',
  'K3SBP-7>APDR16,KB1XYZ-1*,WIDE2-1:=3958.21N/07510.47W-30 m via a digipeater',
];

function findBin() {
  if (process.env.POTACAT_DIREWOLF_BIN) return process.env.POTACAT_DIREWOLF_BIN;
  const p = path.join(__dirname, '..', 'assets', 'direwolf', D.direwolfBinaryName(process.platform));
  return fs.existsSync(p) ? p : '';
}

async function main() {
  console.log('Dire Wolf decodes 300-baud 30 m APRS (offline, no radio)');

  // Always: the generator's own frames are what the decoder will be asked for.
  assert.strictEqual(afsk(bits(frame(PACKETS[0])), 0).length % 2, 0);

  const bin = findBin();
  if (!bin || !fs.existsSync(bin)) {
    console.log('  skip  no POTACAT Dire Wolf build here (assets/direwolf or POTACAT_DIREWOLF_BIN)');
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }

  const queue = [];
  const chunk = RATE / 50 * 2; // 20 ms
  // Paced by the clock, not by ticks: a 20 ms setInterval runs at about 31 ms
  // on Windows (timer granularity), which fed audio at two thirds of real time
  // and left the last frame unsent when the wait ran out. Each tick sends every
  // 20 ms chunk that is due by now.
  const audio = net.createServer((s) => {
    const t0 = Date.now();
    let sent = 0;
    const t = setInterval(() => {
      const due = Math.floor((Date.now() - t0) / 20);
      while (sent < due) { sent++; try { s.write(queue.length ? queue.shift() : Buffer.alloc(chunk)); } catch {} }
    }, 10);
    s.on('data', () => {});
    s.on('close', () => clearInterval(t));
    s.on('error', () => clearInterval(t));
  });
  await new Promise((r) => audio.listen(0, '127.0.0.1', r));
  const agwPort = 18000 + Math.floor(Math.random() * 900);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-dw-hf-'));
  const conf = D.buildDirewolfAprsRxConfig({ mycall: 'N0CALL', audioPort: audio.address().port, agwPort, band: '30m' });
  assert.ok(!/^PTT/m.test(conf), 'no PTT line');
  fs.writeFileSync(path.join(dir, 'aprs-hf.conf'), conf);
  const p = spawn(bin, D.buildDirewolfArgs({ configName: 'aprs-hf.conf' }), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });

  const frames = [];
  let sock = null;
  let unsent = 0;
  try {
    const until = Date.now() + 15000;
    while (Date.now() < until && !(await D.probeAgwPort({ port: agwPort })).ok) await new Promise((r) => setTimeout(r, 200));
    sock = net.connect({ host: '127.0.0.1', port: agwPort });
    const parser = new Mon.AgwFrameParser();
    sock.on('data', (c) => { for (const f of parser.push(c)) frames.push(f); });
    await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
    sock.write(Mon.encodeAgwFrame({ datakind: 'm' }));
    await new Promise((r) => setTimeout(r, 300));

    for (const shift of SHIFTS) {
      for (const t of PACKETS) {
        const pcm = afsk(bits(frame(t)), shift);
        for (let i = 0; i < pcm.length; i += chunk) queue.push(pcm.subarray(i, i + chunk));
      }
    }
    // Wait until every chunk has gone out, then 3 s for the decoders; the cap
    // (twice real time) only stops a hung run.
    const end = Date.now() + queue.length * 40 + 3000;
    let drainedAt = 0;
    while (Date.now() < end && frames.filter((f) => Mon.isReceivedFrame(f)).length < PACKETS.length * SHIFTS.length) {
      if (!queue.length && !drainedAt) drainedAt = Date.now();
      if (drainedAt && Date.now() - drainedAt > 3000) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    unsent = queue.length;
  } finally {
    if (sock) sock.destroy();
    p.kill();
    audio.close();
  }

  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  };
  const got = frames.map((f) => AprsRfFrames.packet(f, AprsParser.parse)).filter(Boolean);

  test('Dire Wolf read the 30 m receive config with no complaint (nine decoders, no config error)', () => {
    assert.ok(/300 baud, AFSK 1600 & 1800 Hz/.test(out), 'channel line');
    assert.ok(/0\.0: A 1480 & 1680/.test(out) && /0\.8: A 1720 & 1920/.test(out), 'nine decoders: ' + out.slice(0, 600));
    assert.ok(!/^Line \d+:/m.test(out), 'a config line was rejected');
    assert.ok(!/can't be combined/.test(out), 'decoder options clash');
  });
  test('both frames on tune come back through the AGW monitor as APRS packets', () => {
    assert.ok(got.length >= 2, `got ${got.length}: ${out.slice(-400)}`);
    assert.strictEqual(got[0].from || got[0].source || got[0].call, 'W1AW-9');
  });
  test('the same frames 70 and 190 Hz off tune are decoded too (the nine staggered decoders)', () => {
    assert.strictEqual(got.length, PACKETS.length * SHIFTS.length, `got ${got.length}, ${unsent} audio chunks never sent`);
  });
  test('the digipeater path survives: heard via KB1XYZ-1', () => {
    const viaDigi = got.filter((g) => /KB1XYZ-1/.test(JSON.stringify(g)));
    assert.ok(viaDigi.length >= 1);
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(e); process.exit(1); });
