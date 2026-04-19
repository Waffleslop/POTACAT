'use strict';
// ---------------------------------------------------------------------------
// HamDRM MOT (Multimedia Object Transfer) segmenter.
//
// Ported from src/drmtx/common/datadecoding/DABMOT.cpp on QSSTV main. Takes a
// payload blob (typically a JPEG) + filename and produces:
//   1. An MOT header (filename, content type, size, version) split into 98-byte
//      partitions, each wrapped in a 16-bit segment header.
//   2. A body split into (bytesAvailable - 14) byte partitions, same wrap.
//   3. A list of MSC data groups: each wraps one segment in a group header +
//      session field + user-access field + CRC-16, ready to hand to the MLC.
//   4. A transmit schedule: run-in (24 interleaves) + body (header every 50
//      segs) + run-out (10 interleaves).
//
// Interoperates byte-for-byte with EasyPal / QSSTV via the CRC placement and
// the RUNIN/RUNOUT pattern; a decoder can re-assemble the JPEG by collecting
// unique segment numbers as they arrive.
// ---------------------------------------------------------------------------

const { crc16Mot } = require('./hamdrm-crc');
const { BitEnqueuer } = require('./hamdrm-fac');

const RUNINLEN = 24;
const RUNOUTLEN = 10;
const PARTITION_SIZE_HEADER = 98;     // bytes
const MOT_GROUP_OVERHEAD_BYTES = 14;  // bodyPartition = bytesAvailable - 14
const MAX_FILENAME_LEN = 80;

// Data group types
const DGT_MOT_HEADER = 3;
const DGT_MOT_DATA = 4;

/**
 * Derive the 16-bit TransportID from a filename, matching QSSTV's
 * ham-extension hash: `256*add + xor`, with a minimum floor.
 */
function transportIdFromFilename(name) {
  let n = name.length;
  if (n > MAX_FILENAME_LEN) n = MAX_FILENAME_LEN;
  let xorfname = 0;
  let addfname = 0;
  for (let k = 0; k < n; k++) {
    const ch = name.charCodeAt(k) & 0xFF;
    xorfname ^= ch;
    addfname = (addfname + ch) & 0xFF;
    addfname ^= (k & 0xFF);
  }
  let tid = ((addfname << 8) | xorfname) & 0xFFFF;
  if (tid <= 2) tid = (tid + n) & 0xFFFF;
  return tid;
}

/**
 * Map common file extensions to (ContentType, ContentSubType) per DRM.
 */
function contentTypeFor(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'gif') return [2, 0];
  if (f === 'jpg' || f === 'jpeg' || f === 'jp2' || f === 'jfif' ||
      f === 'rs1' || f === 'rs2' || f === 'rs3' || f === 'rs4') return [2, 1];
  if (f === 'bmp') return [2, 2];
  if (f === 'png') return [2, 3];
  return [2, 1]; // default to JPEG (what EasyPal expects)
}

/**
 * Build the MOT header byte array for a given file, mirroring QSSTV's
 * SetMOTObject header construction. Size is exactly 7 + 5 + 3 + filename + 2.
 */
function buildMotHeader(filename, bodyBytes, contentType, contentSubType) {
  const fnameLen = Math.min(filename.length, MAX_FILENAME_LEN);
  const headerSize = 7 + 5 + 3 + fnameLen + 2;
  const bits = new BitEnqueuer(headerSize);

  // Core 7 bytes
  bits.enqueue(bodyBytes & 0x0FFFFFFF, 28);     // BodySize (28)
  bits.enqueue(headerSize & 0x1FFF, 13);        // HeaderSize (13)
  bits.enqueue(contentType & 0x3F, 6);          // ContentType (6)
  bits.enqueue(contentSubType & 0x1FF, 9);      // ContentSubType (9)

  // Extension: TriggerTime (PLI=10, 5 bytes total)
  bits.enqueue(2, 2);                           // PLI=10
  bits.enqueue(5, 6);                           // ParamId=5
  bits.enqueue(0, 32);                          // "Now" / MJD=0

  // VersionNumber (PLI=01, 2 bytes total)
  bits.enqueue(1, 2);                           // PLI=01
  bits.enqueue(6, 6);                           // ParamId=6
  bits.enqueue(0, 8);                           // version=0

  // ContentName (PLI=11, variable)
  bits.enqueue(3, 2);                           // PLI=11
  bits.enqueue(12, 6);                          // ParamId=12
  bits.enqueue(0, 1);                           // Ext=0 (7-bit length follows)
  bits.enqueue((1 + fnameLen) & 0x7F, 7);       // DataFieldLength
  bits.enqueue(0, 4);                           // Char set = EBU Latin
  bits.enqueue(0, 4);                           // Rfa
  for (let i = 0; i < fnameLen; i++) {
    bits.enqueue(filename.charCodeAt(i) & 0xFF, 8);
  }

  const out = bits.toBytes();
  if (out.length !== headerSize) {
    throw new Error(`MOT header size mismatch: ${out.length} vs ${headerSize}`);
  }
  return out;
}

/**
 * Split `bytes` into partitions of `partSize` bytes, each prefixed with a
 * 16-bit segment header: [RepetitionCount:3][SegmentSize:13].
 */
function partitionUnits(bytes, partSize) {
  const sourceSize = bytes.length;
  const numSeg = Math.ceil(sourceSize / partSize);
  const lastSize = sourceSize - Math.floor(sourceSize / partSize) * partSize;
  const segments = [];
  for (let i = 0; i < numSeg; i++) {
    const actSegSize = (i < numSeg - 1 || lastSize === 0) ? partSize : lastSize;
    const seg = new Uint8Array(actSegSize + 2);
    seg[0] = ((0 & 0x07) << 5) | ((actSegSize >> 8) & 0x1F); // 3 bits RepCount, upper 5 of size
    seg[1] = actSegSize & 0xFF;
    seg.set(bytes.subarray(i * partSize, i * partSize + actSegSize), 2);
    segments.push(seg);
  }
  return segments;
}

/**
 * Wrap one segment in an MSC data-group: 16-bit group header + 16-bit session
 * field + user-access field (TransportID) + segment bytes + CRC-16.
 * Everything is byte-aligned.
 */
function genDataGroup({
  segmentBytes,
  isHeader,
  segNumber,
  transportId,
  isLastSeg,
  continuityIndex,
}) {
  // Total length in bytes:
  //   2 (group header) + 2 (segment field) + 3 (user-access + TID hdr) +
  //   2 (TID) + segment + 2 (CRC-16)
  const segBits = segmentBytes.length * 8;
  const totBits = 16 + 16 + 8 + 16 + segBits + 16;
  if (totBits % 8 !== 0) throw new Error(`MOT data-group bit count not byte aligned: ${totBits}`);
  const totBytes = totBits / 8;
  const bits = new BitEnqueuer(totBytes);

  // Group header (16 bits)
  bits.enqueue(0, 1);                                   // Extension flag = 0
  bits.enqueue(1, 1);                                   // CRC flag = 1
  bits.enqueue(1, 1);                                   // Segment flag = 1
  bits.enqueue(1, 1);                                   // UserAccess flag = 1
  bits.enqueue(isHeader ? DGT_MOT_HEADER : DGT_MOT_DATA, 4); // DataGroupType
  bits.enqueue(continuityIndex & 0x0F, 4);              // ContinuityIndex
  bits.enqueue(0, 4);                                   // RepetitionIndex = 0

  // Session header: segment field (16 bits)
  bits.enqueue(isLastSeg ? 1 : 0, 1);
  bits.enqueue(segNumber & 0x7FFF, 15);

  // User access field: 3-bit Rfa + TxIDflag + LenInd + TransportID
  bits.enqueue(0, 3);                                   // Rfa
  bits.enqueue(1, 1);                                   // TransportIdFlag
  bits.enqueue(2, 4);                                   // LengthIndicator = 2 (TID is 2 bytes)
  bits.enqueue(transportId & 0xFFFF, 16);               // TransportID

  // Data field (segment bytes including the 16-bit segment header prefix)
  for (let i = 0; i < segmentBytes.length; i++) {
    bits.enqueue(segmentBytes[i], 8);
  }

  // CRC-16 placeholder
  bits.enqueue(0, 16);

  // Compute CRC over the whole group (QSSTV's crc16_bytewise uses the last
  // two bytes with the final-complement XOR on the input bit stream).
  const out = bits.toBytes();
  const crc = crc16Mot(out);
  out[out.length - 2] = (crc >> 8) & 0xFF;
  out[out.length - 1] = crc & 0xFF;
  return out;
}

/**
 * Produce the full MOT state for a file. Returns an object with:
 *   headerSegments: array of Uint8Array — each is a partitioned MOT header.
 *   bodySegments:   array of Uint8Array — each is a partitioned body.
 *   transportId:    16-bit ID derived from filename.
 *   scheduleList:   array of ints — negative = headerIdx-mapped (-1-k), else
 *                   body segment number. This is the play order (RUNIN +
 *                   body + RUNOUT).
 */
function motEncode({ filename, bodyBytes, format, bytesAvailable, repetition = 1 }) {
  if (!filename) throw new Error('filename required');
  if (!(bodyBytes instanceof Uint8Array)) {
    throw new Error('bodyBytes must be a Uint8Array');
  }
  if (!Number.isFinite(bytesAvailable) || bytesAvailable <= MOT_GROUP_OVERHEAD_BYTES) {
    throw new Error(`bytesAvailable must be > ${MOT_GROUP_OVERHEAD_BYTES}`);
  }

  const transportId = transportIdFromFilename(filename);
  const [cType, cSubType] = contentTypeFor(format);
  const headerBytes = buildMotHeader(filename, bodyBytes.length, cType, cSubType);

  const headerSegments = partitionUnits(headerBytes, PARTITION_SIZE_HEADER);
  const bodySegments = partitionUnits(bodyBytes, bytesAvailable - MOT_GROUP_OVERHEAD_BYTES);

  const scheduleList = buildScheduleList({
    numHeaderSegments: headerSegments.length,
    numBodySegments: bodySegments.length,
    repetition,
  });

  return {
    filename,
    transportId,
    headerSegments,
    bodySegments,
    scheduleList,
  };
}

/**
 * Build the ordering that QSSTV's prepareSegmentList produces: RUNINLEN-count
 * passes of {allHeaders, lastBody, bodySegs...}, then body with a header
 * every 50 segments, then RUNOUTLEN-count passes again.
 */
function buildScheduleList({ numHeaderSegments, numBodySegments, repetition }) {
  const list = [];
  const pushHeaders = () => {
    for (let k = 0; k < numHeaderSegments; k++) list.push(-1 - k);
    list.push(numBodySegments - 1); // also send the last body segment
  };
  for (let j = 0; j < repetition; j++) {
    // RUN-IN
    let counter = 0;
    while (counter < RUNINLEN) {
      pushHeaders();
      counter++;
      for (let i = 0; i < numBodySegments && counter < RUNINLEN; i++) {
        list.push(i);
        counter++;
      }
    }
    // BODY (with header every 50 segs)
    for (let c = 0; c < numBodySegments; c++) {
      if (c % 50 === 0) pushHeaders();
      list.push(c);
    }
    // RUN-OUT
    counter = 0;
    while (counter < RUNOUTLEN) {
      pushHeaders();
      counter++;
      for (let i = 0; i < numBodySegments && counter < RUNOUTLEN; i++) {
        list.push(i);
        counter++;
      }
    }
  }
  return list;
}

/**
 * Resolve a schedule entry to the corresponding MSC data group bytes.
 * The caller manages the continuity-index counters for header and body
 * independently (mod 16 per QSSTV).
 */
function buildDataGroupFromScheduleEntry(entry, mot, ci) {
  if (entry < 0) {
    const hdrIdx = -1 - entry;
    const isLast = (hdrIdx + 1) === mot.headerSegments.length;
    const dg = genDataGroup({
      segmentBytes: mot.headerSegments[hdrIdx],
      isHeader: true,
      segNumber: hdrIdx,
      transportId: mot.transportId,
      isLastSeg: isLast,
      continuityIndex: ci.header,
    });
    ci.header = (ci.header + 1) & 0x0F;
    return dg;
  } else {
    const isLast = (entry + 1) === mot.bodySegments.length;
    const dg = genDataGroup({
      segmentBytes: mot.bodySegments[entry],
      isHeader: false,
      segNumber: entry,
      transportId: mot.transportId,
      isLastSeg: isLast,
      continuityIndex: ci.body,
    });
    ci.body = (ci.body + 1) & 0x0F;
    return dg;
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const fake = new Uint8Array(256);
  for (let i = 0; i < fake.length; i++) fake[i] = (i * 7 + 13) & 0xFF;
  const mot = motEncode({
    filename: 'test.jpg',
    bodyBytes: fake,
    format: 'jpg',
    bytesAvailable: 150,
    repetition: 1,
  });
  const ci = { header: 0, body: 0 };
  const firstDg = buildDataGroupFromScheduleEntry(mot.scheduleList[0], mot, ci);
  console.log(`TransportID:       0x${mot.transportId.toString(16)}`);
  console.log(`Header segments:   ${mot.headerSegments.length}`);
  console.log(`Body segments:     ${mot.bodySegments.length}`);
  console.log(`Schedule length:   ${mot.scheduleList.length}`);
  console.log(`First DG length:   ${firstDg.length} bytes`);
  console.log(`First DG[0..15]:   ${Array.from(firstDg.slice(0, 16)).map(x => x.toString(16).padStart(2, '0')).join(' ')}`);

  // Sanity: schedule must start with a header emission (negative entry).
  if (mot.scheduleList[0] >= 0) { console.log('FAIL: schedule must start with header'); process.exit(1); }
  // CRC must be non-zero (extremely unlikely for random data)
  const crcLo = firstDg[firstDg.length - 1];
  const crcHi = firstDg[firstDg.length - 2];
  if (crcLo === 0 && crcHi === 0) { console.log('FAIL: CRC both zero'); process.exit(1); }
  console.log('\nMOT self-tests passed.');
}

module.exports = {
  RUNINLEN,
  RUNOUTLEN,
  PARTITION_SIZE_HEADER,
  MOT_GROUP_OVERHEAD_BYTES,
  transportIdFromFilename,
  contentTypeFor,
  buildMotHeader,
  partitionUnits,
  genDataGroup,
  motEncode,
  buildScheduleList,
  buildDataGroupFromScheduleEntry,
};
