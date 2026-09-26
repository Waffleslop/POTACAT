'use strict';
/**
 * FT8 decoder benchmark — native addon vs WSJT-X reference decodes (issue #87).
 *
 * Decodes every test WAV that has a WSJT-X reference .txt beside it (ft8_lib's
 * test set, including 20m_busy) through lib/ft8_native exactly as the FT8 worker
 * calls it — decode(Float32Array 12 kHz mono, 'FT8', myCall, dxCall), 180000
 * samples (one 15 s slot, zero-padded / truncated like the engine's buffer) —
 * and compares the decoded message texts against the reference.
 *
 *   node scripts/ft8-benchmark.js            # per-file + total table
 *   node scripts/ft8-benchmark.js --quiet    # totals only
 *   node scripts/ft8-benchmark.js --extras   # also list every extra decode
 *   node scripts/ft8-benchmark.js --json     # machine-readable totals on the last line
 *   node scripts/ft8-benchmark.js --addon <path/to/ft8_native.node>
 *
 * Matching is on normalized message text: whitespace collapsed, upper-cased,
 * WSJT-X's trailing country / "a1" AP annotations dropped, and any <hashed>
 * callsign reduced to "<...>" on both sides (ft8_lib prints "<...>" for a hash
 * it has not seen; WSJT-X prints the call when it has).
 *
 * An EXTRA is a decode not in the reference. WSJT-X is not ground truth — it
 * misses real signals too — so extras are split:
 *   corroborated — a callsign in it appears in some reference decode (any file)
 *   plausible    — every token parses as FT8 message vocabulary (calls, grids,
 *                  reports, CQ/RR73/73/...), but not corroborated
 *   implausible  — fails the structure check (most likely a false decode)
 * "implausible" is the number a decoder change must not grow.
 *
 * Reference data: lib/ft8_native/ft8_lib/test/wav/ (never the dist/ copies).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ADDON = path.resolve(opt('--addon', path.join(ROOT, 'lib', 'ft8_native', 'build', 'Release', 'ft8_native.node')));
const WAV_DIR = path.resolve(opt('--dir', path.join(ROOT, 'lib', 'ft8_native', 'ft8_lib', 'test', 'wav')));
const MY_CALL = opt('--mycall', '');
const DX_CALL = opt('--dxcall', '');
const SR = 12000;
const SLOT_SAMPLES = 15 * SR; // what the engine hands the worker

const native = require(ADDON);

// ---- WAV reading ----------------------------------------------------------
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV: ' + file);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('bad WAV: ' + file);
  const bps = fmt.bits / 8;
  const frames = Math.floor(data.length / (bps * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = i * bps * fmt.channels; // first channel
    let v;
    if (fmt.format === 3 && fmt.bits === 32) v = data.readFloatLE(o);
    else if (fmt.bits === 16) v = data.readInt16LE(o) / 32768;
    else if (fmt.bits === 32) v = data.readInt32LE(o) / 2147483648;
    else if (fmt.bits === 8) v = (data.readUInt8(o) - 128) / 128;
    else throw new Error(`unsupported ${fmt.bits}-bit WAV: ${file}`);
    out[i] = v;
  }
  return { rate: fmt.rate, samples: out };
}

// Linear-interpolation resample to 12 kHz (the engine receives 12 kHz from
// the renderer's capture path; this only matters for off-rate test files).
function resample(samples, from, to) {
  if (from === to) return samples;
  const n = Math.floor(samples.length * to / from);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step, i0 = Math.floor(x), f = x - i0;
    const a = samples[i0] || 0, b = samples[i0 + 1] !== undefined ? samples[i0 + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

function toSlot(samples) {
  const out = new Float32Array(SLOT_SAMPLES);
  out.set(samples.subarray(0, Math.min(samples.length, SLOT_SAMPLES)));
  return out;
}

// ---- Reference parsing / normalization ------------------------------------
function normalize(text) {
  return String(text)
    .toUpperCase()
    .replace(/<[^>]*>/g, '<...>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseReference(file) {
  const msgs = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    // 110130  -6  0.7  683 ~  CQ TA6CQ KN70      AS Turkey
    const m = raw.match(/^\s*\d+\s+-?\d+\s+-?[\d.]+\s+\d+\s+~\s+(.*)$/);
    if (!m) continue;
    const text = m[1].split(/\s{2,}/)[0]; // drop country / AP annotations
    msgs.push(normalize(text));
  }
  return msgs;
}

// ---- Plausibility ---------------------------------------------------------
const CALL_RE = /^(?:[A-Z0-9]{1,4}\/)?(?=[A-Z0-9]*\d)[A-Z0-9]{3,11}(?:\/[A-Z0-9]{1,4})?$/;
const BASE_CALL_RE = /^[A-Z0-9]{0,3}\d[A-Z]{1,4}$|^[A-Z]{1,2}\d{1,4}[A-Z]{1,4}$/;
const GRID_RE = /^[A-R]{2}\d{2}$/;
const REPORT_RE = /^R?[+-]\d{2}$/;
const WORDS = new Set(['CQ', 'DE', 'QRZ', 'RRR', 'RR73', '73', 'R', '<...>', 'DX', 'TEST', 'POTA', 'SOTA', 'WW', 'FD', 'NA', 'EU']);
function isCallish(tok) {
  const t = tok.replace(/^<|>$/g, '');
  if (!CALL_RE.test(t)) return false;
  const base = t.split('/').sort((a, b) => b.length - a.length)[0];
  return BASE_CALL_RE.test(base) || /\d/.test(base);
}
function plausible(text) {
  const toks = text.split(' ');
  if (toks.length < 2 || toks.length > 5) return false;
  let calls = 0;
  for (const t of toks) {
    if (WORDS.has(t) || GRID_RE.test(t) || REPORT_RE.test(t) || /^[A-Z]{2,4}$/.test(t)) continue;
    if (isCallish(t)) { calls++; continue; }
    return false;
  }
  return calls >= 1;
}

// ---- Run ------------------------------------------------------------------
function listCases(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listCases(full));
    else if (/\.wav$/i.test(ent.name)) {
      const txt = full.replace(/\.wav$/i, '.txt');
      if (fs.existsSync(txt)) out.push({ wav: full, txt });
    }
  }
  return out;
}

const cases = listCases(WAV_DIR);
if (!cases.length) { console.error('No WAV+TXT pairs under ' + WAV_DIR); process.exit(1); }

// Every callsign WSJT-X heard anywhere in the set (for corroborating extras).
const refCalls = new Set();
const refs = cases.map((c) => parseReference(c.txt));
for (const r of refs) for (const m of r) for (const t of m.split(' ')) if (isCallish(t) && t !== '<...>') refCalls.add(t);

const tot = { files: 0, ours: 0, ref: 0, matched: 0, missed: 0, extra: 0, corroborated: 0, plausible: 0, implausible: 0, ms: 0, maxMs: 0 };
const rows = [];
const extrasList = [];

// Warm-up (first call pays one-time allocation / page-fault cost).
native.decode(new Float32Array(SLOT_SAMPLES), 'FT8', MY_CALL, DX_CALL);

cases.forEach((c, idx) => {
  const { rate, samples } = readWav(c.wav);
  const slot = toSlot(resample(samples, rate, SR));
  const t0 = process.hrtime.bigint();
  const res = native.decode(slot, 'FT8', MY_CALL, DX_CALL);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const ref = refs[idx];
  const refSet = new Set(ref);
  const ours = [...new Set(res.map((r) => normalize(r.text)))];
  const oursSet = new Set(ours);
  const matched = [...refSet].filter((m) => oursSet.has(m)).length;
  const missed = refSet.size - matched;
  const extras = ours.filter((m) => !refSet.has(m));
  let corr = 0, plaus = 0, impl = 0;
  for (const e of extras) {
    const k = e.split(' ').some((t) => refCalls.has(t)) ? 'corroborated' : (plausible(e) ? 'plausible' : 'implausible');
    if (k === 'corroborated') corr++; else if (k === 'plausible') plaus++; else impl++;
    extrasList.push({ file: path.relative(WAV_DIR, c.wav), text: e, kind: k });
  }

  const row = { file: path.relative(WAV_DIR, c.wav).replace(/\\/g, '/'), rate, ours: ours.length, ref: refSet.size, matched, missed, extra: extras.length, corr, plaus, impl, ms };
  rows.push(row);
  tot.files++; tot.ours += row.ours; tot.ref += row.ref; tot.matched += matched; tot.missed += missed;
  tot.extra += extras.length; tot.corroborated += corr; tot.plausible += plaus; tot.implausible += impl;
  tot.ms += ms; tot.maxMs = Math.max(tot.maxMs, ms);
});

const pad = (s, n) => String(s).padStart(n);
if (!flag('--quiet') && !flag('--json')) {
  console.log(`addon: ${path.relative(ROOT, ADDON)}   AP: ${MY_CALL || '(off)'}${DX_CALL ? '/' + DX_CALL : ''}`);
  console.log('file                       ours  wsjtx  match  miss  extra (corr/plaus/impl)     ms');
  for (const r of rows) {
    console.log(`${r.file.padEnd(25)} ${pad(r.ours, 5)} ${pad(r.ref, 6)} ${pad(r.matched, 6)} ${pad(r.missed, 5)} ${pad(r.extra, 6)}  (${r.corr}/${r.plaus}/${r.impl})`.padEnd(76) + pad(r.ms.toFixed(0), 6) + (r.rate !== SR ? `  [resampled from ${r.rate} Hz]` : ''));
  }
}
if (flag('--extras')) {
  console.log('\nExtras (not in WSJT-X reference):');
  for (const e of extrasList) console.log(`  ${e.kind.padEnd(13)} ${e.file.padEnd(24)} ${e.text}`);
}
const pct = (100 * tot.matched / tot.ref).toFixed(1);
if (!flag('--json')) {
  console.log('-'.repeat(84));
  console.log(`TOTAL ${tot.files} files: ours ${tot.ours}, WSJT-X ${tot.ref}, matched ${tot.matched} (${pct}%), missed ${tot.missed}, ` +
    `extra ${tot.extra} (corroborated ${tot.corroborated}, plausible ${tot.plausible}, implausible ${tot.implausible})`);
  console.log(`decode time: total ${tot.ms.toFixed(0)} ms, mean ${(tot.ms / tot.files).toFixed(0)} ms/slot, max ${tot.maxMs.toFixed(0)} ms/slot`);
} else {
  console.log(JSON.stringify({ ...tot, matchedPct: +pct }));
}
