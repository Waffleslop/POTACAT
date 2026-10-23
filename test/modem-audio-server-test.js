// lib/modem-audio-server.js — the loopback audio port an external modem uses
// instead of a sound card. A fake modem (what ardopcf's SocketAudio.c does)
// connects, receives the radio's RX audio as 12 kHz s16 and sends TX audio
// the same way; POTACAT's side resamples to/from the radio's rate.
// Run: node test/modem-audio-server-test.js
'use strict';

const assert = require('assert');
const net = require('net');
const { ModemAudioServer, floatToInt16, int16ToFloat } = require('../lib/modem-audio-server');
const { StreamingResampler } = require('../lib/mercury-audio-bridge');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (a, b) => new StreamingResampler(a, b);

(async () => {
  await test('s16 conversion round-trips and clips', () => {
    const f = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]);
    const b = floatToInt16(f);
    assert.deepStrictEqual([b.readInt16LE(0), b.readInt16LE(2), b.readInt16LE(6), b.readInt16LE(8)], [0, 16384, 32767, -32767]);
    const back = int16ToFloat(b, b.length);
    assert.ok(Math.abs(back[1] - 0.5) < 0.001);
  });

  await test('loopback only', () => {
    const s = new ModemAudioServer({ makeResampler: mk });
    assert.throws(() => s.listen(0, '0.0.0.0'), /loopback only/);
  });

  await test('a 48 kHz modem (Dire Wolf): RX arrives at 48 kHz, TX at 48 kHz comes back at the radio rate', async () => {
    assert.throws(() => new ModemAudioServer({ makeResampler: mk, modemRate: 1000 }), /not a sample rate/);
    const srv = new ModemAudioServer({ makeResampler: mk, txOutRate: 24000, modemRate: 48000 });
    assert.strictEqual(srv.modemRate, 48000);
    const port = await srv.listen(0);
    const txOut = [];
    srv.on('tx', (f32) => txOut.push(f32));
    const modem = net.connect(port, '127.0.0.1');
    const got = [];
    modem.on('data', (d) => got.push(d));
    await new Promise((r) => modem.once('connect', r));
    await wait(30);
    const tone = new Float32Array(24000);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / 24000);
    for (let i = 0; i < tone.length; i += 256) srv.feedRx(tone.subarray(i, i + 256), 24000);
    await wait(80);
    const rx = Buffer.concat(got);
    assert.ok(Math.abs(rx.length / 2 - 48000) < 600, `48000 samples at 48 kHz, got ${rx.length / 2}`);
    const s = int16ToFloat(rx, rx.length);
    let maxDiff = 0;
    for (let i = 200; i < 2200; i++) maxDiff = Math.max(maxDiff, Math.abs(s[i] - s[i + 48]));
    assert.ok(maxDiff < 0.08, `1 kHz period preserved at 48 kHz (max drift ${maxDiff.toFixed(3)})`);
    const tx = new Float32Array(4800); // 100 ms at 48 kHz
    for (let i = 0; i < tx.length; i++) tx[i] = 0.8 * Math.sin(2 * Math.PI * 1500 * i / 48000);
    modem.write(floatToInt16(tx));
    await wait(80);
    const outN = txOut.reduce((n, f) => n + f.length, 0);
    assert.ok(Math.abs(outN - 2400) < 200, `100 ms back at 24 kHz, got ${outN}`);
    modem.destroy();
    await srv.close();
  });

  await test('RX: 24 kHz radio frames reach the modem as 12 kHz s16; TX: modem 12 kHz comes back at 24 kHz', async () => {
    const srv = new ModemAudioServer({ makeResampler: mk, txOutRate: 24000 });
    const port = await srv.listen(0);
    const txOut = [];
    srv.on('tx', (f32) => txOut.push(f32));
    const modem = net.connect(port, '127.0.0.1');
    const got = [];
    modem.on('data', (d) => got.push(d));
    await new Promise((r) => modem.once('connect', r));
    await wait(30);
    assert.ok(srv.connected);
    // One second of a 1 kHz tone at 24 kHz, fed in 256-sample frames as dax_rx does.
    const tone = new Float32Array(24000);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / 24000);
    for (let i = 0; i < tone.length; i += 256) srv.feedRx(tone.subarray(i, i + 256), 24000);
    await wait(80);
    const rx = Buffer.concat(got);
    assert.ok(Math.abs(rx.length / 2 - 12000) < 300, `12000 samples at 12 kHz, got ${rx.length / 2}`);
    // Still a 1 kHz tone at 12 kHz: 12 samples per cycle, so sample 0 ≈ sample 12.
    const s = int16ToFloat(rx, rx.length);
    let maxDiff = 0;
    for (let i = 100; i < 1100; i++) maxDiff = Math.max(maxDiff, Math.abs(s[i] - s[i + 12]));
    assert.ok(maxDiff < 0.08, `period preserved (max drift ${maxDiff.toFixed(3)})`);
    // The modem transmits: 1200 samples (100 ms) of 12 kHz s16.
    const tx = new Float32Array(1200);
    for (let i = 0; i < tx.length; i++) tx[i] = 0.8 * Math.sin(2 * Math.PI * 1500 * i / 12000);
    modem.write(floatToInt16(tx));
    await wait(60);
    const outLen = txOut.reduce((n, c) => n + c.length, 0);
    assert.ok(Math.abs(outLen - 2400) < 20, `100 ms at 24 kHz, got ${outLen}`);
    assert.strictEqual(srv.stats.txChunks >= 1, true);
    // An odd trailing byte is carried to the next chunk, never misaligned.
    modem.write(Buffer.from([0x12]));
    await wait(20);
    modem.write(Buffer.from([0x34, 0x00, 0x00]));
    await wait(40);
    assert.ok(txOut.length >= 2);
    modem.destroy();
    await wait(30);
    assert.ok(!srv.connected);
    await srv.close();
  });

  await test('a modem that stops reading does not stall the radio path (frames are dropped, counted)', async () => {
    const srv = new ModemAudioServer({ makeResampler: mk });
    const port = await srv.listen(0);
    const modem = net.connect(port, '127.0.0.1');
    modem.pause(); // never reads
    await new Promise((r) => modem.once('connect', r));
    await wait(30);
    const frame = new Float32Array(2400).fill(0.3);
    const t0 = Date.now();
    for (let i = 0; i < 400; i++) srv.feedRx(frame, 12000); // 80 s of audio into a stuck reader
    assert.ok(Date.now() - t0 < 500, 'feedRx never blocks');
    assert.ok(srv.stats.rxDropped > 0, 'excess was dropped, not queued forever');
    modem.destroy();
    await srv.close();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
