#!/usr/bin/env node
'use strict';
/**
 * Nonstandard-callsign encode/decode round-trip test for the native FT8 addon.
 *
 * Guards the 2026-07-07 fixes: bracketed <CALL> hash encoding in pack28,
 * the one-hash-per-message rule in encode_std (forces RRR/RR73/73 legs and
 * nonstandard CQs through type 4), the encode_nonstd bracket strip +
 * len_call_de fix, and the live hash_if in the addon's encode export.
 *
 * Each message is synthesized with encode() and decoded back through the full
 * waterfall pipeline with decode(). Within one process the hash table is warm
 * (encode/decode both seed it); the cold-listener case (<...> rendering) is
 * exercised in a child process with a fresh table.
 *
 * Run: node scripts/test-nonstd-roundtrip.js
 */

const path = require('path');
const { execFileSync } = require('child_process');
const addon = require(path.join(__dirname, '..', 'lib', 'ft8_native', 'build', 'Release', 'ft8_native.node'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function roundTrip(text) {
  const enc = addon.encode(text, 1500, 'FT8'); // returns a Float32Array of samples (or null)
  if (!enc || !enc.length) return { encoded: false };
  const decodes = addon.decode(enc, 'FT8');
  const texts = (decodes || []).map((d) => (d.text || '').trim());
  return { encoded: true, texts };
}

console.log('=== Standard messages still round-trip ===');
for (const t of ['CQ K3SBP FN20', 'W1A K3SBP FN20', 'K1ABC W9XYZ -11', 'CQ POTA K3SBP FN20']) {
  const r = roundTrip(t);
  check(t, r.encoded && r.texts.includes(t), r.encoded ? 'decoded: ' + JSON.stringify(r.texts) : 'encode failed');
}

console.log('=== Nonstandard call: type-4 CQ (full call, no grid) ===');
{
  const r = roundTrip('CQ GB13COL');
  check('CQ GB13COL', r.encoded && r.texts.includes('CQ GB13COL'), JSON.stringify(r.texts));
}

console.log('=== Bracketed hash legs (type 1 with h22) ===');
// The CQ above seeded GB13COL into this process's hash table, so decodes
// render the bracketed call in full — exactly the WSJT-X warm-table behavior.
for (const t of ['<GB13COL> K3SBP', '<GB13COL> K3SBP R-08', '<GB13COL> K3SBP -15']) {
  const r = roundTrip(t);
  check(t, r.encoded && r.texts.includes(t), r.encoded ? JSON.stringify(r.texts) : 'encode failed');
}

console.log('=== Ack legs go out as type 4 (nonstandard call in full) ===');
for (const t of ['GB13COL <K3SBP> RR73', 'GB13COL <K3SBP> 73', '<K3SBP> GB13COL RR73']) {
  const r = roundTrip(t);
  check(t, r.encoded && r.texts.includes(t), r.encoded ? JSON.stringify(r.texts) : 'encode failed');
}

console.log('=== Compound-call forms ===');
{
  let r = roundTrip('CQ PJ4/K1ABC');
  check('CQ PJ4/K1ABC', r.encoded && r.texts.includes('CQ PJ4/K1ABC'), JSON.stringify(r.texts));
  r = roundTrip('<PJ4/K1ABC> W9XYZ +03');
  check('<PJ4/K1ABC> W9XYZ +03', r.encoded && r.texts.includes('<PJ4/K1ABC> W9XYZ +03'), JSON.stringify(r.texts));
}

console.log('=== Unresolvable/illegal forms ===');
{
  check('<...> K3SBP rejects', addon.encode('<...> K3SBP', 1500, 'FT8') === null);
  // Two nonstandard calls: the codec CAN pack this (type 4 hashes one of
  // them, same as any t4 message) — refusing the pairing is the message
  // GENERATOR's job (JtcatParser.formatDirectedMsg returns null), matching
  // WSJT-X, whose UI refuses it while the wire format is agnostic.
  const r = roundTrip('GB13COL PJ4/K1ABC 73');
  check('two nonstandard calls pack as t4 (generator must refuse upstream)',
    r.encoded && r.texts.includes('<GB13COL> PJ4/K1ABC 73'), JSON.stringify(r.texts));
}

console.log('=== FT8 DXpedition (Fox/Hound) dual messages — type 0.1 ===');
{
  // Warm the hash table with the fox's full call (a real hound hears the
  // fox CQ first), then round-trip the dual message. Reports are −30..+32
  // in 2 dB steps — odd inputs floor to the step below.
  let r = roundTrip('CQ KH1/KH7Z');
  check('fox CQ warms hash table', r.encoded && r.texts.includes('CQ KH1/KH7Z'), JSON.stringify(r.texts));
  r = roundTrip('K1ABC RR73; W9XYZ <KH1/KH7Z> -08');
  check('dual RR73+report round-trips', r.encoded && r.texts.includes('K1ABC RR73; W9XYZ <KH1/KH7Z> -08'), JSON.stringify(r.texts));
  r = roundTrip('W2AAA RR73; K3SBP <KH7Z> +02');
  check('dual with standard fox call', r.encoded && r.texts.includes('W2AAA RR73; K3SBP <KH7Z> +02'), JSON.stringify(r.texts));
}

console.log('=== Cold listener renders <...> until the full call is heard ===');
{
  // Encode in THIS process (warm table), decode in a child with a fresh table.
  const enc = addon.encode('<GB13COL> K3SBP R-08', 1500, 'FT8');
  const tmp = path.join(require('os').tmpdir(), 'nonstd-rt-' + process.pid + '.f32');
  require('fs').writeFileSync(tmp, Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength));
  const child = `
    const addon = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'ft8_native', 'build', 'Release', 'ft8_native.node'))});
    const buf = require('fs').readFileSync(${JSON.stringify(tmp)});
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const out = (addon.decode(new Float32Array(ab), 'FT8') || []).map(d => (d.text || '').trim());
    console.log(JSON.stringify(out));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', child]).toString().trim());
  require('fs').unlinkSync(tmp);
  check('cold decode shows <...>', out.includes('<...> K3SBP R-08'), JSON.stringify(out));
}

console.log('='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
