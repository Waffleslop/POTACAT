#!/usr/bin/env node
'use strict';
/**
 * FT8 / JS8 release gate: ft8_native and js8_native must be present, built
 * for the target architecture, and load. FT8's WASM fallback is slower and
 * cannot encode some calls; JS8 has no fallback at all, so a build without
 * js8_native ships a JS8 window with no modem behind it.
 *
 *   node scripts/check-required-natives.js                  the build tree (lib/)
 *   node scripts/check-required-natives.js --packaged       every app.asar.unpacked under dist/
 *   ... --expect-arch=x64|arm64                             also check the PE / ELF / Mach-O arch
 *
 * The arch is read from the file header in JS, so the check is the same on
 * Windows (PE machine type), Linux (ELF e_machine) and macOS (Mach-O cputype,
 * fat binaries included). Both addons are N-API, so plain Node loads the
 * same .node file the packaged Electron app loads.
 *
 * The pure parts are exported for test/check-required-natives-test.js.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const REQUIRED = [
  { name: 'ft8_native', rel: path.join('ft8_native', 'build', 'Release', 'ft8_native.node') },
  { name: 'js8_native', rel: path.join('js8_native', 'build', 'Release', 'js8_native.node') },
];

const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32', 0x01c4: 'arm' };
const ELF_MACHINE = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' };
const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 0x00000007: 'ia32', 0x0000000c: 'arm' };

/**
 * Read the architecture(s) from a binary's header.
 * Returns { format: 'pe'|'elf'|'macho'|'macho-fat', arches: [...] } or
 * { format: 'unknown', arches: [] }.
 */
function archFromHeader(buf) {
  const none = { format: 'unknown', arches: [] };
  if (!buf || buf.length < 8) return none;
  // PE: "MZ", e_lfanew at 0x3c, "PE\0\0", then the COFF machine field.
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    if (buf.length < 0x40) return none;
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 6 > buf.length) return none;
    if (buf.readUInt32LE(peOff) !== 0x00004550) return none;
    const m = buf.readUInt16LE(peOff + 4);
    return { format: 'pe', arches: [PE_MACHINE[m] || `pe-machine-0x${m.toString(16)}`] };
  }
  // ELF: 0x7f "ELF", EI_DATA at 5 (1 = little endian), e_machine at 18.
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    if (buf.length < 20) return none;
    const m = buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18);
    return { format: 'elf', arches: [ELF_MACHINE[m] || `elf-machine-0x${m.toString(16)}`] };
  }
  // Mach-O fat (universal): 0xcafebabe big endian, nfat_arch, then 20-byte entries.
  if (buf.readUInt32BE(0) === 0xcafebabe) {
    const n = buf.readUInt32BE(4);
    const arches = [];
    for (let i = 0; i < n && 8 + i * 20 + 4 <= buf.length; i++) {
      const cpu = buf.readUInt32BE(8 + i * 20);
      arches.push(MACHO_CPU[cpu] || `macho-cpu-0x${cpu.toString(16)}`);
    }
    return { format: 'macho-fat', arches };
  }
  // Mach-O thin, 64- or 32-bit, little endian on every Mac we ship.
  const magic = buf.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    const cpu = buf.readUInt32LE(4);
    return { format: 'macho', arches: [MACHO_CPU[cpu] || `macho-cpu-0x${cpu.toString(16)}`] };
  }
  return none;
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    // A PE header can sit anywhere e_lfanew points; 4 KB covers every
    // linker we use. Fat Mach-O entry tables are far smaller.
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

// `file -b` output for the log, where `file` exists (Linux, macOS).
function fileDescription(file) {
  try { return execFileSync('file', ['-b', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/**
 * Check one lib/ directory (the build tree or a packaged app.asar.unpacked/lib).
 * opts: { expectArch, load = true, describe = fileDescription }
 * Returns an array of { ok, msg } lines.
 */
function checkBase(base, opts = {}) {
  const { expectArch = '', load = true, describe = fileDescription } = opts;
  const lines = [];
  const say = (ok, msg) => lines.push({ ok, msg });
  for (const a of REQUIRED) {
    const file = path.join(base, a.rel);
    if (!fs.existsSync(file)) { say(false, `${a.name}: missing ${file}`); continue; }
    if (expectArch) {
      let info;
      try { info = archFromHeader(readHeader(file)); } catch (e) { info = { format: 'unreadable', arches: [] }; }
      const desc = describe ? describe(file) : null;
      const shown = info.arches.length ? info.arches.join('+') : info.format;
      say(info.arches.includes(expectArch),
        `${a.name}: ${info.format} ${shown} (want ${expectArch})${desc ? ` [file: ${desc}]` : ''}`);
    }
    if (load) {
      try {
        const addon = require(file);
        say(typeof addon.decode === 'function', `${a.name}: loads, decode() ${typeof addon.decode === 'function' ? 'present' : 'MISSING'}`);
      } catch (e) {
        say(false, `${a.name}: does not load: ${String(e && e.message || e).split('\n')[0]}`);
      }
    }
  }
  return lines;
}

// Every app.asar.unpacked/lib under dist/ (win-unpacked, linux-unpacked,
// linux-arm64-unpacked, mac*/POTACAT.app/Contents/Resources).
function packagedBases(dist) {
  const out = [];
  if (!fs.existsSync(dist)) return out;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === 'app.asar.unpacked') { out.push(path.join(p, 'lib')); continue; }
      if (e.name.endsWith('.app') || /unpacked$|^mac/.test(e.name) || ['Contents', 'Resources', 'resources'].includes(e.name)) walk(p, depth + 1);
    }
  };
  walk(dist, 0);
  return out;
}

function main(argv) {
  const packaged = argv.includes('--packaged');
  const expectArch = (argv.find((a) => a.startsWith('--expect-arch=')) || '').slice(14);
  const bases = packaged ? packagedBases(path.join(ROOT, 'dist')) : [path.join(ROOT, 'lib')];
  if (!bases.length) {
    console.error('::error::no packaged app (app.asar.unpacked) found under dist/');
    return 1;
  }
  let bad = 0;
  for (const b of bases) {
    console.log(`[check-required-natives] ${b}`);
    for (const l of checkBase(b, { expectArch })) {
      console.log(`${l.ok ? '  ok  ' : '  FAIL'} ${l.msg}`);
      if (!l.ok) bad++;
    }
  }
  if (bad) {
    console.error(`::error::ft8_native/js8_native failed ${bad} check(s): this build would ship FT8 on the slow fallback and no JS8 modem`);
    return 1;
  }
  console.log('[check-required-natives] ft8_native and js8_native present, right arch, and load');
  return 0;
}

module.exports = { archFromHeader, checkBase, packagedBases, REQUIRED };

if (require.main === module) process.exit(main(process.argv.slice(2)));
