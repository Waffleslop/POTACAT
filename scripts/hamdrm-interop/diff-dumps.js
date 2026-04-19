#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// Layer-by-layer diff between our JS port's dumps and QSSTV's instrumented
// dumps. Both dirs should contain files named:
//
//   fac-block.txt          hex bytes, one frame per line
//   fac-channel-bits.txt   0/1 string, one line per frame
//   mot-data-groups.txt    `DG<n> <H|B><seg> len=<N> <hex bytes>`
//   msc-payload-bytes.txt  hex bytes, one frame per line
//   msc-channel-bits.txt   0/1 string, one line per frame
//   grid-cells.txt         `sym<n> <re im re im ...>` (57 cells per symbol)
//   symbol0-samples.f32    binary float32, 1280 samples
//   (optional) cell-map.txt, pilot-cells.txt, constants.txt
//
// Usage:  node diff-dumps.js <js-dump-dir> <qsstv-dump-dir>
//
// Returns exit code 0 if all layers match within tolerance; non-zero if
// any mismatch.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readBinary(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

function summaryLine(label, ok, detail) {
  const tag = ok ? 'MATCH' : 'DIFFER';
  console.log(`  ${tag.padEnd(7)} ${label}${detail ? ': ' + detail : ''}`);
  return ok ? 0 : 1;
}

// Compare two text files line by line, ignoring trailing whitespace. For each
// differing line, report the first-byte index where they diverge.
function diffText(label, aText, bText, opts = {}) {
  const aLines = aText.trim().split(/\r?\n/);
  const bLines = bText.trim().split(/\r?\n/);
  const n = Math.max(aLines.length, bLines.length);
  let firstMismatch = -1;
  let mismatchCount = 0;
  for (let i = 0; i < n; i++) {
    const a = (aLines[i] || '').replace(/\s+$/, '');
    const b = (bLines[i] || '').replace(/\s+$/, '');
    if (a !== b) {
      if (firstMismatch < 0) firstMismatch = i;
      mismatchCount++;
    }
  }
  if (mismatchCount === 0) {
    return summaryLine(label, true, `${aLines.length} lines identical`);
  }
  const detail = `${mismatchCount}/${n} lines differ; first at line ${firstMismatch + 1}`;
  summaryLine(label, false, detail);
  if (opts.verbose) {
    const a = aLines[firstMismatch] || '<missing>';
    const b = bLines[firstMismatch] || '<missing>';
    console.log(`      js:    ${a.slice(0, 120)}${a.length > 120 ? '…' : ''}`);
    console.log(`      qsstv: ${b.slice(0, 120)}${b.length > 120 ? '…' : ''}`);
  }
  return 1;
}

// Compare two complex-cell text lines of the form "<tag> re im re im …".
// Reports max absolute error.
function diffComplexCells(label, aText, bText, tol = 1e-4) {
  const aLines = aText.trim().split(/\r?\n/);
  const bLines = bText.trim().split(/\r?\n/);
  const n = Math.min(aLines.length, bLines.length);
  let maxErr = 0;
  let worstLine = -1;
  for (let i = 0; i < n; i++) {
    const aTok = aLines[i].split(/\s+/).slice(1).map(Number);
    const bTok = bLines[i].split(/\s+/).slice(1).map(Number);
    if (aTok.length !== bTok.length) {
      return summaryLine(label, false,
        `line ${i + 1} token count differs (${aTok.length} vs ${bTok.length})`);
    }
    for (let k = 0; k < aTok.length; k++) {
      const e = Math.abs(aTok[k] - bTok[k]);
      if (e > maxErr) { maxErr = e; worstLine = i + 1; }
    }
  }
  if (aLines.length !== bLines.length) {
    return summaryLine(label, false,
      `line count differs (${aLines.length} vs ${bLines.length})`);
  }
  const ok = maxErr < tol;
  return summaryLine(label, ok, `max |err| = ${maxErr.toExponential(3)} (tol ${tol}, ${n} lines, worst line ${worstLine})`);
}

// Compare two Float32 binary files sample-by-sample.
function diffFloat32(label, aBuf, bBuf, tol = 1e-3) {
  if (aBuf.length !== bBuf.length) {
    return summaryLine(label, false, `byte length differs (${aBuf.length} vs ${bBuf.length})`);
  }
  const a = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.length / 4);
  const b = new Float32Array(bBuf.buffer, bBuf.byteOffset, bBuf.length / 4);
  let maxErr = 0;
  for (let i = 0; i < a.length; i++) {
    const e = Math.abs(a[i] - b[i]);
    if (e > maxErr) maxErr = e;
  }
  return summaryLine(label, maxErr < tol,
    `${a.length} samples, max |err| = ${maxErr.toExponential(3)} (tol ${tol})`);
}

function main() {
  const [jsDir, qsDir, ...flags] = process.argv.slice(2);
  const verbose = flags.includes('-v') || flags.includes('--verbose');
  if (!jsDir || !qsDir) {
    console.error('Usage: diff-dumps.js <js-dump-dir> <qsstv-dump-dir> [-v]');
    process.exit(2);
  }
  console.log(`Comparing: ${jsDir}`);
  console.log(`      vs:  ${qsDir}\n`);

  const layers = [
    // [filename, comparator]
    ['fac-block.txt',         'text'],
    ['fac-channel-bits.txt',  'text'],
    ['msc-payload-bytes.txt', 'text'],
    ['msc-channel-bits.txt',  'text'],
    ['mot-data-groups.txt',   'text'],
    ['grid-cells.txt',        'cells'],
    ['symbol0-samples.f32',   'float32'],
  ];

  let fails = 0;
  for (const [name, kind] of layers) {
    const jsPath = path.join(jsDir, name);
    const qsPath = path.join(qsDir, name);
    if (!fs.existsSync(jsPath) || !fs.existsSync(qsPath)) {
      console.log(`  SKIP    ${name}${fs.existsSync(jsPath) ? '' : ' (missing in js)'}${fs.existsSync(qsPath) ? '' : ' (missing in qsstv)'}`);
      continue;
    }
    if (kind === 'text') {
      fails += diffText(name, readText(jsPath), readText(qsPath), { verbose });
    } else if (kind === 'cells') {
      fails += diffComplexCells(name, readText(jsPath), readText(qsPath));
    } else if (kind === 'float32') {
      fails += diffFloat32(name, readBinary(jsPath), readBinary(qsPath));
    }
  }

  console.log();
  if (fails === 0) {
    console.log(`All layers match. Port is byte-exact with QSSTV.`);
    process.exit(0);
  } else {
    console.log(`${fails} layer(s) differ. Start from the first DIFFER line — that's where the port deviates. Re-run with -v for line-level context.`);
    process.exit(1);
  }
}

main();
