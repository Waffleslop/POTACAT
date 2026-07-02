// Byte-based QSO chunker for the chunked all-qsos push. The single unbounded
// all-qsos frame 1009-kills iOS on large logs; chunks must stay under the cap
// while preserving order and every record (so per-record idx stays valid).
// Run: node test/qso-chunker-test.js
'use strict';

const assert = require('assert');
const { chunkQsosBySize, DEFAULT_CHUNK_BYTES } = require('../lib/qso-chunker');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const dataBytes = (slice) => Buffer.byteLength(JSON.stringify(slice));

// Build N records of roughly `approxBytes` each, each with a unique idx.
function makeQsos(n, approxBytes = 300) {
  const pad = 'x'.repeat(Math.max(1, approxBytes - 60));
  return Array.from({ length: n }, (_, i) => ({ idx: i, CALL: 'K3SBP', COMMENT: pad }));
}

console.log('empty + tiny:');
check(chunkQsosBySize([]).length === 0, 'empty input → no chunks');
{
  const one = makeQsos(1);
  const c = chunkQsosBySize(one, 200 * 1024);
  check(c.length === 1 && c[0].length === 1, 'one small record → one chunk');
}

console.log('splitting by byte budget:');
{
  const qsos = makeQsos(1000, 400);        // ~400 KB total
  const max = 50 * 1024;                    // 50 KB chunks
  const chunks = chunkQsosBySize(qsos, max);
  check(chunks.length > 1, `1000 records / 50KB → multiple chunks (${chunks.length})`);
  check(chunks.every(ch => dataBytes(ch) <= max), 'every chunk data ≤ 50KB');
  // order + completeness preserved
  const flat = chunks.flat();
  check(flat.length === 1000, 'all 1000 records emitted exactly once');
  check(flat.every((r, i) => r.idx === i), 'order + idx preserved end to end');
}

console.log('a single oversized record is not dropped:');
{
  const big = { idx: 0, CALL: 'K3SBP', COMMENT: 'y'.repeat(300 * 1024) }; // > budget
  const small = { idx: 1, CALL: 'W1AW' };
  const chunks = chunkQsosBySize([big, small], 100 * 1024);
  const flat = chunks.flat();
  check(flat.length === 2, 'both records survive');
  check(flat.some(r => r.idx === 0) && flat.some(r => r.idx === 1), 'oversized + small both present');
  check(chunks.some(ch => ch.length === 1 && ch[0].idx === 0), 'oversized record gets its own chunk');
}

console.log('realistic log stays under the LARGE (256KB) warning:');
{
  // ~7000 records ~1.4KB each ≈ 9.6MB (N3VD scale) at the default budget.
  const qsos = makeQsos(7000, 1400);
  const chunks = chunkQsosBySize(qsos, DEFAULT_CHUNK_BYTES);
  check(chunks.every(ch => dataBytes(ch) <= 256 * 1024), 'every chunk well under 256KB');
  check(chunks.flat().length === 7000, 'all 7000 records emitted');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'qso-chunker tests failed');
