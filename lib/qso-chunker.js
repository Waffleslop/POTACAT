'use strict';

// Split an array of QSO records into byte-bounded slices for the chunked
// `all-qsos` push. The single unbounded `all-qsos` frame 1009-kills iOS on
// large logs (>8 MiB), and re-fires on every reconnect — see the
// all-qsos-chunking desktop ask. We chunk by SERIALIZED BYTE SIZE, not a fixed
// record count, because record width varies a lot (n-fer activations, long
// comments, contest strings), so a fixed count can blow past the cap on a heavy
// log while wasting frames on a light one.
//
// Each returned slice, when serialized as the `data` array, stays at or under
// `maxBytes`. Order is preserved and every record is emitted exactly once, so
// the per-record `idx` (embedded upstream) stays valid for update/delete. A
// single record larger than `maxBytes` can't be split, so it lands in its own
// slice rather than being dropped — rare, and far below the 8 MiB critical line.

// Default byte budget for a chunk's `data` array. Kept under the 256 KB LARGE
// warning with headroom for the message envelope (type/chunk/totalChunks/total)
// and WS framing. all-qsos is plain JSON (no base64), so wire size ≈ JSON size.
const DEFAULT_CHUNK_BYTES = 200 * 1024;

/**
 * @param {Array<object>} records
 * @param {number} [maxBytes] - byte budget per chunk's data array
 * @returns {Array<Array<object>>} slices in original order
 */
function chunkQsosBySize(records, maxBytes = DEFAULT_CHUNK_BYTES) {
  const limit = Math.max(1, maxBytes | 0);
  const chunks = [];
  let cur = [];
  let curBytes = 2; // the enclosing "[]"
  for (const rec of records) {
    let recBytes;
    try { recBytes = Buffer.byteLength(JSON.stringify(rec)) + 1; } // +1 for the "," separator
    catch { recBytes = 1; } // unserializable record — shouldn't happen; don't let it wedge the loop
    if (cur.length > 0 && curBytes + recBytes > limit) {
      chunks.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(rec);
    curBytes += recBytes;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

module.exports = { chunkQsosBySize, DEFAULT_CHUNK_BYTES };
