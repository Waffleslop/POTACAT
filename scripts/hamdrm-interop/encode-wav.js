#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// HamDRM interop test harness — Tier 1
//
// Encode any file (JPEG, PNG, or arbitrary bytes) to a HamDRM Mode A / SO_1
// WAV that a decoder (QSSTV, Dream, EasyPal) should be able to receive.
//
// Usage:
//   node scripts/hamdrm-interop/encode-wav.js <input> [options]
//
// Options:
//   --out <path>        WAV output (default: <input>.wav)
//   --label <str>       Operator label, ≤9 chars (default: POTACAT)
//   --name <str>        ContentName in MOT header (default: basename of input)
//   --repeat <n>        Repeat the MOT schedule n times (default: 1)
//   --dump-dir <path>   Write intermediate layer dumps for Tier 2 diff
//
// Example:
//   node scripts/hamdrm-interop/encode-wav.js potacat-logo.jpg --label K3SBP
//
// The output WAV is 48 kHz / 16-bit / mono. Peak normalised to 0.8 (so ALC
// has a little room). Duration ≈ 1.2 s per MOT data group + 1.2 s × RUNIN
// (24) + 1.2 s × RUNOUT (10).
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { encodeImage, writeWav } = require('../../lib/hamdrm/hamdrm-encoder');

function parseArgs(argv) {
  const args = { input: null, out: null, label: 'POTACAT', name: null, repeat: 1, dumpDir: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--out')            args.out = rest[++i];
    else if (a === '--label')     args.label = rest[++i];
    else if (a === '--name')      args.name = rest[++i];
    else if (a === '--repeat')    args.repeat = parseInt(rest[++i], 10);
    else if (a === '--dump-dir')  args.dumpDir = rest[++i];
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a.startsWith('--'))  { console.error(`unknown flag: ${a}`); process.exit(2); }
    else if (!args.input)         args.input = a;
    else                          { console.error(`extra arg: ${a}`); process.exit(2); }
  }
  return args;
}

function usage() {
  console.log('Usage: encode-wav.js <input> [--out file.wav] [--label K3SBP] [--name foo.jpg] [--repeat 1] [--dump-dir path]');
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.input) { usage(); process.exit(2); }
  if (!fs.existsSync(args.input)) {
    console.error(`input not found: ${args.input}`);
    process.exit(1);
  }
  if (args.label.length > 9) {
    console.error(`label "${args.label}" too long (max 9 chars)`);
    process.exit(2);
  }

  const jpegBytes = new Uint8Array(fs.readFileSync(args.input));
  const filename = args.name || path.basename(args.input);
  const outWav = args.out || (args.input.replace(/\.[^.]+$/, '') + '.wav');

  console.log(`Input:   ${args.input}  (${jpegBytes.length} bytes)`);
  console.log(`Label:   ${args.label}`);
  console.log(`Name:    ${filename}`);
  console.log(`Output:  ${outWav}`);
  if (args.dumpDir) console.log(`Dumps:   ${args.dumpDir}`);

  const t0 = Date.now();
  const result = encodeImage({
    jpegBytes,
    filename,
    label: args.label,
    repetition: args.repeat,
    dumpDir: args.dumpDir,
  });
  const encodeMs = Date.now() - t0;

  writeWav(result.audio, outWav, result.sampleRate);

  console.log();
  console.log(`TransportID:           0x${result.transportId.toString(16).padStart(4, '0')}`);
  console.log(`Schedule length:       ${result.schedule.length} data groups`);
  console.log(`Superframes emitted:   ${result.superframes} × 1.2 s`);
  console.log(`Audio length:          ${result.audio.length} samples  (${result.durationSec.toFixed(3)} s)`);
  console.log(`Encode wall time:      ${encodeMs} ms  (${(result.durationSec * 1000 / encodeMs).toFixed(1)}× real-time)`);
  console.log(`WAV written:           ${outWav}  (${fs.statSync(outWav).size} bytes)`);
  if (args.dumpDir && fs.existsSync(args.dumpDir)) {
    const dumps = fs.readdirSync(args.dumpDir);
    console.log(`Dumps written:         ${dumps.length} files in ${args.dumpDir}`);
  }
}

main();
