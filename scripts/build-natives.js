#!/usr/bin/env node
/**
 * Postinstall script — attempts to build native addons (FT8, FreeDV, RADE).
 * Failures are non-fatal: features that need native addons simply won't
 * be available at runtime.
 */

const { execSync } = require('child_process');
const path = require('path');

// Cross-compile support: `node scripts/build-natives.js --arch=x64` passes
// the target arch through to node-gyp. Needed because GitHub retired the
// Intel macOS runners — the x64 DMG is now built on an Apple Silicon host,
// and a plain `node-gyp rebuild` there produces arm64 .node files that an
// Intel Mac cannot load (ft8_native silently fell back to the slow WASM
// decoder — N3VD 2026-07-10). macOS clang cross-compiles x86_64 from arm64
// natively; gyp maps --arch=x64 to ARCHS=x86_64.
const archArg = (process.argv.find((a) => a.startsWith('--arch=')) || '').slice(7);
const gypArch = archArg ? ` --arch=${archArg}` : '';
if (archArg) console.log(`[postinstall] Target arch override: ${archArg}`);

const addons = [
  { name: 'ft8_native',    dir: 'lib/ft8_native',    cmd: 'npx node-gyp rebuild' + gypArch },
  { name: 'freedv_native',  dir: 'lib/freedv_native',  cmd: 'npx node-gyp rebuild' + gypArch },
  { name: 'rade_native',    dir: null,                  cmd: 'node scripts/build-rade.js' },
  // alsa_native gives Linux users access to raw hw:/plughw: ALSA devices
  // that Chromium's enumerateDevices() hides. binding.gyp falls back to a
  // tiny stub on Windows/macOS (so the .node file still loads) but the
  // libasound link is Linux-only — no point invoking the build on hosts
  // that can't find -lasound, so we skip those entirely. Linux-and-WSL
  // are detected by os.platform() === 'linux'.
  ...(process.platform === 'linux'
    ? [{ name: 'alsa_native', dir: 'lib/alsa_native', cmd: 'npx node-gyp rebuild' }]
    : []),
];

let built = 0, skipped = 0;

for (const addon of addons) {
  console.log(`\n[postinstall] Building ${addon.name}...`);
  try {
    const cwd = addon.dir
      ? path.join(__dirname, '..', addon.dir)
      : path.join(__dirname, '..');
    execSync(addon.cmd, { stdio: 'inherit', cwd, timeout: 600000 });
    console.log(`[postinstall] ✓ ${addon.name} built successfully`);
    built++;
  } catch (err) {
    console.warn(`[postinstall] ✗ ${addon.name} build failed (feature will be unavailable)`);
    skipped++;
  }
}

console.log(`\n[postinstall] Done: ${built} built, ${skipped} skipped`);
