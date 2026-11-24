#!/usr/bin/env node
'use strict';
/**
 * scripts/check-required-natives.js is the release gate that stops a Windows
 * or Linux build shipping without ft8_native / js8_native, or with the wrong
 * architecture. A gate that always passes is worse than none, so this pins
 * that it fails on a missing file and on the wrong arch, and passes a good one.
 *
 * Run: node test/check-required-natives-test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { archFromHeader, checkBase, packagedBases, REQUIRED } = require('../scripts/check-required-natives');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// Minimal headers, just enough for the parser.
function pe(machine) {
  const b = Buffer.alloc(0x100);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(machine, 0x84);
  return b;
}
function elf(machine, bigEndian) {
  const b = Buffer.alloc(64);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = 2; // 64-bit
  b[5] = bigEndian ? 2 : 1;
  if (bigEndian) b.writeUInt16BE(machine, 18); else b.writeUInt16LE(machine, 18);
  return b;
}
function macho(cpu) {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
}
function fat(cpus) {
  const b = Buffer.alloc(8 + cpus.length * 20);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cpus.length, 4);
  cpus.forEach((c, i) => b.writeUInt32BE(c, 8 + i * 20));
  return b;
}

const temps = [];

// A lib/ tree with both addons, each holding the given header bytes.
function tree(headers) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'req-natives-'));
  temps.push(base);
  for (const a of REQUIRED) {
    if (!headers[a.name]) continue;
    const f = path.join(base, a.rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, headers[a.name]);
  }
  return base;
}
const noLoad = { load: false, describe: null };
const failures = (lines) => lines.filter((l) => !l.ok);

test('PE machine types: x64, arm64, ia32', () => {
  assert.deepStrictEqual(archFromHeader(pe(0x8664)), { format: 'pe', arches: ['x64'] });
  assert.deepStrictEqual(archFromHeader(pe(0xaa64)).arches, ['arm64']);
  assert.deepStrictEqual(archFromHeader(pe(0x014c)).arches, ['ia32']);
});

test('ELF e_machine: x86_64 and aarch64, either byte order', () => {
  assert.deepStrictEqual(archFromHeader(elf(0x3e)), { format: 'elf', arches: ['x64'] });
  assert.deepStrictEqual(archFromHeader(elf(0xb7)).arches, ['arm64']);
  assert.deepStrictEqual(archFromHeader(elf(0xb7, true)).arches, ['arm64']);
});

test('Mach-O thin and fat', () => {
  assert.deepStrictEqual(archFromHeader(macho(0x0100000c)), { format: 'macho', arches: ['arm64'] });
  assert.deepStrictEqual(archFromHeader(fat([0x01000007, 0x0100000c])), { format: 'macho-fat', arches: ['x64', 'arm64'] });
});

test('garbage and truncated files are unknown, never a match', () => {
  assert.deepStrictEqual(archFromHeader(Buffer.from('not a binary at all')).arches, []);
  assert.deepStrictEqual(archFromHeader(Buffer.from('MZ')).arches, []);
  assert.deepStrictEqual(archFromHeader(Buffer.alloc(0)).arches, []);
  const badPe = pe(0x8664); badPe.write('XX', 0x80, 'latin1');
  assert.deepStrictEqual(archFromHeader(badPe).arches, []);
});

test('missing js8_native fails, ft8_native alone is not enough', () => {
  const base = tree({ ft8_native: pe(0x8664) });
  const bad = failures(checkBase(base, { expectArch: 'x64', ...noLoad }));
  assert.strictEqual(bad.length, 1, JSON.stringify(bad));
  assert.match(bad[0].msg, /js8_native: missing/);
});

test('missing both fails twice', () => {
  const base = tree({});
  assert.strictEqual(failures(checkBase(base, noLoad)).length, 2);
});

test('wrong arch fails: arm64 PE in an x64 Windows build', () => {
  const base = tree({ ft8_native: pe(0x8664), js8_native: pe(0xaa64) });
  const bad = failures(checkBase(base, { expectArch: 'x64', ...noLoad }));
  assert.strictEqual(bad.length, 1);
  assert.match(bad[0].msg, /js8_native: pe arm64 \(want x64\)/);
});

test('wrong arch fails: x64 ELF in the Linux arm64 build', () => {
  const base = tree({ ft8_native: elf(0x3e), js8_native: elf(0xb7) });
  const bad = failures(checkBase(base, { expectArch: 'arm64', ...noLoad }));
  assert.strictEqual(bad.length, 1);
  assert.match(bad[0].msg, /ft8_native: elf x64 \(want arm64\)/);
});

test('an unreadable header fails the arch check', () => {
  const base = tree({ ft8_native: Buffer.from('junk'), js8_native: elf(0x3e) });
  const bad = failures(checkBase(base, { expectArch: 'x64', ...noLoad }));
  assert.strictEqual(bad.length, 1);
  assert.match(bad[0].msg, /ft8_native: unknown/);
});

test('good files pass: x64 PE, x64 ELF, arm64 ELF', () => {
  for (const [h, arch] of [[pe(0x8664), 'x64'], [elf(0x3e), 'x64'], [elf(0xb7), 'arm64']]) {
    const base = tree({ ft8_native: h, js8_native: h });
    assert.deepStrictEqual(failures(checkBase(base, { expectArch: arch, ...noLoad })), []);
  }
});

test('a file with a good header that is not a real addon fails the load check', () => {
  const base = tree({ ft8_native: pe(0x8664), js8_native: pe(0x8664) });
  const bad = failures(checkBase(base, { expectArch: 'x64', describe: null }));
  assert.strictEqual(bad.length, 2);
  for (const b of bad) assert.match(b.msg, /does not load/);
});

test('packaged: finds app.asar.unpacked/lib under win-unpacked and linux-arm64-unpacked', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'req-natives-dist-'));
  temps.push(dist);
  for (const d of ['win-unpacked', 'linux-arm64-unpacked']) {
    fs.mkdirSync(path.join(dist, d, 'resources', 'app.asar.unpacked', 'lib'), { recursive: true });
  }
  const found = packagedBases(dist).map((p) => path.relative(dist, p).split(path.sep).join('/')).sort();
  assert.deepStrictEqual(found, [
    'linux-arm64-unpacked/resources/app.asar.unpacked/lib',
    'win-unpacked/resources/app.asar.unpacked/lib',
  ]);
  assert.deepStrictEqual(packagedBases(path.join(dist, 'nope')), []);
});

// The real build tree, when this machine has built the addons: right arch for
// this Node, and they load. Skipped (loudly) on a box that never built them.
const libDir = path.join(__dirname, '..', 'lib');
const built = REQUIRED.every((a) => fs.existsSync(path.join(libDir, a.rel)));
if (built && (process.arch === 'x64' || process.arch === 'arm64')) {
  test(`real build tree: both addons are ${process.arch} and load`, () => {
    assert.deepStrictEqual(failures(checkBase(libDir, { expectArch: process.arch, describe: null })), []);
  });
} else {
  console.log('  skip real build tree: ft8_native/js8_native not built here (npm run build-natives)');
}

for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\ncheck-required-natives: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
