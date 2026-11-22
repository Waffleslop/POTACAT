'use strict';
// Test helper (not a test): TNC2 text -> AX.25 UI frame -> bit-stuffed HDLC
// bits -> NRZI AFSK audio, plus seeded white noise. Adapted from the generator
// in test/direwolf-aprs-hf-decode-test.js (our own code), without Buffer, so
// the phone's port is a copy. Used by test/afsk-demod-test.js and
// scripts/afsk-demod-vs-direwolf.js.

function addr(call, last, h) {
  const [c, s] = call.split('-');
  const b = new Uint8Array(7);
  for (let i = 0; i < 6; i++) b[i] = (c.charCodeAt(i) || 0x20) << 1;
  b[6] = 0x60 | ((Number(s) || 0) << 1) | (last ? 1 : 0) | (h ? 0x80 : 0);
  return b;
}

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** FCS of bytes (CRC-16/X.25), bit by bit: a separate implementation from the library's table. */
function fcs(body) {
  let crc = 0xffff;
  for (const byte of body) for (let k = 0; k < 8; k++) { const x = (crc ^ (byte >> k)) & 1; crc >>>= 1; if (x) crc ^= 0x8408; }
  return (crc ^ 0xffff) & 0xffff;
}

/** TNC2 "FROM>TO,DIGI*,...:info" -> AX.25 UI frame bytes, FCS appended. Digis up to the '*' get the H bit. */
function frame(tnc2, { badFcs = false } = {}) {
  const i = tnc2.indexOf(':');
  const [from, rest] = tnc2.slice(0, i).split('>');
  const [to, ...digis] = rest.split(',');
  const star = digis.findIndex((d) => d.endsWith('*'));
  const parts = [addr(to, false, false), addr(from, digis.length === 0, false)];
  digis.forEach((d, k) => parts.push(addr(d.replace('*', ''), k === digis.length - 1, k <= star)));
  const info = tnc2.slice(i + 1);
  const infoBytes = new Uint8Array(info.length);
  for (let k = 0; k < info.length; k++) infoBytes[k] = info.charCodeAt(k) & 0xff;
  const body = concat([...parts, Uint8Array.from([0x03, 0xf0]), infoBytes]);
  let c = fcs(body);
  if (badFcs) c ^= 0x0001;
  return concat([body, Uint8Array.from([c & 0xff, c >> 8])]);
}

function flagBits(out, n) { for (let f = 0; f < n; f++) for (let k = 0; k < 8; k++) out.push((0x7e >> k) & 1); }

/** Raw bytes -> stuffed bits (LSB first), no flags. */
function stuffed(bytes, out = []) {
  let ones = 0;
  for (const byte of bytes) {
    for (let k = 0; k < 8; k++) {
      const b = (byte >> k) & 1;
      out.push(b);
      if (b) { if (++ones === 5) { out.push(0); ones = 0; } } else ones = 0;
    }
  }
  return out;
}

/** Flags, bit-stuffed frame, flags. */
function bits(fr, { pre = 24, post = 4 } = {}) {
  const out = [];
  flagBits(out, pre);
  stuffed(fr, out);
  flagBits(out, post);
  return out;
}

/** Several frames back to back, sharing flags between them (one flag apart by default). */
function bitsMany(frames, { pre = 24, between = 1, post = 4 } = {}) {
  const out = [];
  flagBits(out, pre);
  frames.forEach((fr, k) => { stuffed(fr, out); flagBits(out, k === frames.length - 1 ? post : between); });
  return out;
}

const MODE = {
  1200: { baud: 1200, mark: 1200, space: 2200 },
  300: { baud: 300, mark: 1600, space: 1800 },
};

/**
 * NRZI AFSK: a 0 bit changes tone, a 1 keeps it. Phase-continuous Float32.
 * opts: mode ('1200'|'300'), rate, shiftHz, amp (peak), twistDb (mark level
 * relative to space), clock (baud scale, 1.01 = 1% fast), lead/tail silence (s).
 */
function afsk(bitList, opts = {}) {
  const m = MODE[String(opts.mode || '1200')];
  const rate = opts.rate || 12000;
  const shift = opts.shiftHz || 0;
  const amp = opts.amp == null ? 0.5 : opts.amp;
  const tw = Math.pow(10, (opts.twistDb || 0) / 20);
  const baud = m.baud * (opts.clock || 1);
  const markHz = m.mark + shift, spaceHz = m.space + shift;
  const spb = rate / baud;
  const lead = Math.round((opts.lead == null ? 0.05 : opts.lead) * rate);
  const tail = Math.round((opts.tail == null ? 0.05 : opts.tail) * rate);
  const total = lead + Math.ceil(bitList.length * spb) + tail + 2;
  const out = new Float32Array(total);
  let idx = lead, mark = true, phase = 0, acc = 0;
  for (const b of bitList) {
    if (b === 0) mark = !mark;
    acc += spb;
    while (acc >= 1) {
      phase += 2 * Math.PI * (mark ? markHz : spaceHz) / rate;
      out[idx++] = Math.sin(phase) * amp * (mark ? tw : 1);
      acc -= 1;
    }
  }
  return out.subarray(0, idx + tail);
}

/** Seeded PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Adds white Gaussian noise in place. snrDb is the signal-to-noise ratio in a
 * 3 kHz bandwidth (the SSB convention), for a tone of peak amplitude `amp`:
 * signal power amp^2/2, noise power in 3 kHz = sigma^2 * 3000 / (rate/2).
 */
function addNoise(samples, { snrDb, amp = 0.5, rate = 12000, seed = 1 }) {
  const r = rng(seed);
  const sigPow = amp * amp / 2;
  const n3k = sigPow / Math.pow(10, snrDb / 10);
  const sigma = Math.sqrt(n3k * (rate / 2) / 3000);
  for (let i = 0; i < samples.length; i += 2) {
    const u1 = Math.max(r(), 1e-12), u2 = r();
    const mag = sigma * Math.sqrt(-2 * Math.log(u1));
    samples[i] += mag * Math.cos(2 * Math.PI * u2);
    if (i + 1 < samples.length) samples[i + 1] += mag * Math.sin(2 * Math.PI * u2);
  }
  return samples;
}

function join(chunks) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

module.exports = { addr, frame, fcs, bits, bitsMany, stuffed, afsk, addNoise, rng, join, MODE };
