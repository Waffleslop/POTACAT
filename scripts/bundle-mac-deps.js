#!/usr/bin/env node
'use strict';
/**
 * macOS: make the Homebrew-built helper binaries we ship (rigctld, wsprd)
 * self-contained inside the .app, then PROVE it before the build continues.
 *
 * Why this exists (WB0MMC 2026-08-31 — "No rigs found" on a Mac, but really
 * on EVERY Mac): Homebrew bakes absolute Cellar paths into its binaries. The
 * shipped rigctld asked dyld for
 *   /opt/homebrew/Cellar/hamlib/4.7.2/lib/libhamlib.4.dylib
 * which exists on the CI runner and on nobody's Mac. dyld killed it at
 * launch, `rigctld -l` printed nothing, and the Add Rig dialog said "No rigs
 * found" — Hamlib had never worked in a packaged mac build, since the first
 * release pipeline commit.
 *
 * The shell function this replaces got it ALMOST right: it copied the dylibs
 * and rewrote the load commands, but its loop variable `dep` was not `local`,
 * so the recursive call clobbered the caller's copy. Back in the outer frame,
 * `$dep` was the libusb path the recursion had left behind while `$name` was
 * still libhamlib.4.dylib — so rigctld's LIBUSB entry got rewritten to
 * @loader_path/libhamlib.4.dylib and the real Cellar reference was never
 * touched. install_name_tool says nothing when a -change matches nothing, and
 * `ls` showed both dylibs present, so the build looked healthy for 30 releases.
 *
 * Two lessons are baked in here. The rewrite keeps its state in data
 * structures instead of shell globals. And nothing is trusted: the verify
 * pass re-reads every load command of every Mach-O file we ship and fails the
 * build on any absolute non-system path, or any @loader_path pointing at a
 * file we did not actually ship. The build machine — where the Homebrew paths
 * still resolve, so the binary runs fine — is the only place this class of bug
 * can be caught before a user hits it.
 *
 * Usage:
 *   node scripts/bundle-mac-deps.js [--expect-arch=arm64] <binary> [binary...]
 *
 * Each binary is made self-contained in its OWN directory (that directory is
 * where the copied dylibs land and what @loader_path resolves to at runtime).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Paths dyld can always resolve on a user's Mac. Everything else has to be
// shipped next to the binary. /usr/local and /opt/* are NOT system paths —
// they are the two Homebrew prefixes.
const SYSTEM_PREFIXES = ['/usr/lib/', '/System/'];
const isSystem = (p) => SYSTEM_PREFIXES.some((s) => p.startsWith(s));
const isOurs = (p) => p.startsWith('@loader_path/');

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    const be = buf.readUInt32BE(0);
    const le = buf.readUInt32LE(0);
    // MH_MAGIC / MH_MAGIC_64 (either endianness) or FAT_MAGIC
    return be === 0xcafebabe || [0xfeedface, 0xfeedfacf].includes(be) ||
      [0xfeedface, 0xfeedfacf].includes(le);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * A dylib's own install name (LC_ID_DYLIB) shows up as the first entry of
 * `otool -L`, which is why the old shell version tried to filter it out by
 * basename. `otool -D` reports it directly, so we can exclude it by value.
 */
function installNames(file) {
  const ids = new Set();
  try {
    for (const line of run('otool', ['-D', file]).split('\n')) {
      const t = line.trim();
      if (t && !t.endsWith(':')) ids.add(t);
    }
  } catch { /* executables have no LC_ID_DYLIB */ }
  return ids;
}

function loadedDylibs(file) {
  const ids = installNames(file);
  const deps = [];
  for (const line of run('otool', ['-L', file]).split('\n')) {
    const m = line.match(/^\s+(\S.*?)\s+\(compatibility version /);
    if (m && !ids.has(m[1])) deps.push(m[1]);
  }
  return deps;
}

function archOf(file) {
  try {
    return run('lipo', ['-archs', file]).trim();
  } catch {
    return '?';
  }
}

/** Copy every non-system dependency next to `binary` and repoint it there. */
function bundle(binary) {
  const dir = path.dirname(binary);
  const queue = [binary];
  const processed = new Set();
  const copied = new Map(); // basename -> absolute path of our copy

  while (queue.length) {
    const bin = queue.shift();
    if (processed.has(bin)) continue;
    processed.add(bin);

    // install_name_tool needs owner-write, and Homebrew installs 444/555.
    // 755 (not just +w): a file without owner-write also breaks Squirrel.Mac
    // auto-update, which must strip the quarantine xattr from every file in
    // the downloaded zip (W3DFX, 1.10.3 -> 1.10.5).
    fs.chmodSync(bin, 0o755);

    for (const dep of loadedDylibs(bin)) {
      if (isSystem(dep) || isOurs(dep)) continue;
      if (!dep.startsWith('/')) {
        // @rpath/@executable_path: resolving these needs the binary's LC_RPATH
        // list, which nothing we ship uses. Refuse rather than guess.
        throw new Error(`${bin} loads ${dep} — this script only rewrites absolute paths`);
      }
      const name = path.basename(dep);
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(dep, target);
        console.log(`[bundle-mac-deps]   + ${name} (from ${dep})`);
        copied.set(name, target);
      }
      queue.push(target);
      run('install_name_tool', ['-change', dep, `@loader_path/${name}`, bin]);
    }
  }

  // A copied dylib still calls itself by its Homebrew path. Anything that
  // links it by that name (or a later re-sign) would go looking there.
  for (const [name, file] of copied) {
    run('install_name_tool', ['-id', `@loader_path/${name}`, file]);
  }
}

/**
 * The rule, as a pure function so it can be tested off a Mac: every load
 * command must resolve on a machine that has never heard of Homebrew.
 * `entries` is [{ name, deps, shipped }] — shipped being the file names
 * actually present next to the binary.
 */
function bundleProblems(entries) {
  const problems = [];
  for (const { name, deps, shipped } of entries) {
    for (const dep of deps) {
      if (isSystem(dep)) continue;
      if (isOurs(dep)) {
        const file = dep.slice('@loader_path/'.length);
        if (!shipped.includes(file)) problems.push(`${name}: ${dep} is not shipped alongside it`);
        continue;
      }
      problems.push(`${name}: ${dep} — absolute path, will not exist on a user's Mac`);
    }
  }
  return problems;
}

/**
 * Re-read what we just wrote. This is the gate the old shell version never
 * had: it ran on a machine where the Homebrew paths resolve, so a binary with
 * an un-rewritten absolute dependency launched perfectly in CI.
 */
function verify(dirs, expectArch) {
  const problems = [];
  let checked = 0;

  for (const dir of dirs) {
    const present = fs.readdirSync(dir).sort();
    const entries = [];
    for (const entry of present) {
      const file = path.join(dir, entry);
      if (!fs.statSync(file).isFile() || !isMachO(file)) continue;
      checked++;
      const arch = archOf(file);
      console.log(`[bundle-mac-deps] ${path.join(path.basename(dir), entry)} (${arch})`);
      if (expectArch && !arch.split(/\s+/).includes(expectArch)) {
        // NOT fatal: the x64 job cross-compiles on an ARM runner, so `brew
        // install hamlib` there yields arm64 helpers in the Intel DMG. Known
        // and tracked (potacat-meta work/open/macos-x64-hamlib-arch.md) —
        // this keeps it visible in every build log instead of silent.
        console.log(`[bundle-mac-deps] WARNING: ${entry} is ${arch}, expected ${expectArch} — it cannot run on that Mac`);
      }
      const deps = loadedDylibs(file);
      for (const dep of deps) console.log(`[bundle-mac-deps]     -> ${dep}`);
      entries.push({ name: entry, deps, shipped: present });
    }
    problems.push(...bundleProblems(entries));
  }

  if (problems.length) {
    console.error('\n[bundle-mac-deps] FAILED — these would ship broken:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nEvery dependency must be /usr/lib, /System, or @loader_path/<file shipped alongside>.');
    process.exit(1);
  }
  console.log(`[bundle-mac-deps] OK — ${checked} Mach-O file(s) self-contained`);
}

function main() {
  const args = process.argv.slice(2);
  let expectArch = null;
  const binaries = [];
  for (const a of args) {
    if (a.startsWith('--expect-arch=')) expectArch = a.split('=')[1];
    else binaries.push(a);
  }
  if (!binaries.length) {
    console.error('usage: bundle-mac-deps.js [--expect-arch=arm64] <binary> [binary...]');
    process.exit(2);
  }
  if (process.platform !== 'darwin') {
    console.error('[bundle-mac-deps] refusing to run off macOS (needs otool/install_name_tool)');
    process.exit(2);
  }

  const dirs = new Set();
  for (const b of binaries) {
    if (!fs.existsSync(b)) {
      console.error(`[bundle-mac-deps] missing binary: ${b}`);
      process.exit(1);
    }
    console.log(`[bundle-mac-deps] bundling ${b}`);
    bundle(b);
    dirs.add(path.dirname(b));
  }
  verify([...dirs], expectArch);
}

if (require.main === module) main();

module.exports = { bundleProblems, isSystem, isOurs };
