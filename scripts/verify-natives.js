#!/usr/bin/env node
'use strict';
/**
 * Pre-dist gate: refuse to package a build whose native addons were never
 * compiled. Runs from the npm predist:* hooks (NOT in release CI, which
 * calls electron-builder directly and has its own per-arch verify steps).
 *
 * Why (G6INI 2026-08-18): the README's from-source path was `npm install`
 * then `npm run dist:mac` — but nothing in that sequence builds the
 * addons (build-natives is not a postinstall; official CI runs it as an
 * explicit step). The result packaged cleanly and shipped with no FT8
 * native decoder (silent WASM fallback) and no JS8 modem at all — a dead
 * JS8 window telling the user to "reinstall".
 *
 * ft8_native and js8_native are hard failures: FT8's WASM fallback can't
 * encode FD/nonstandard calls and JS8 has no fallback whatsoever. The
 * FreeDV/RADE addons only warn — those features degrade with their own
 * in-app messaging. Escape hatch: POTACAT_SKIP_NATIVE_CHECK=1.
 */
const fs = require('fs');
const path = require('path');

if (process.env.POTACAT_SKIP_NATIVE_CHECK === '1') {
  console.log('[verify-natives] Skipped (POTACAT_SKIP_NATIVE_CHECK=1)');
  process.exit(0);
}

const REQUIRED = [
  { name: 'ft8_native', file: 'lib/ft8_native/build/Release/ft8_native.node' },
  { name: 'js8_native', file: 'lib/js8_native/build/Release/js8_native.node' },
];
const OPTIONAL = [
  { name: 'freedv_native', file: 'lib/freedv_native/build/Release/freedv_native.node' },
];

let missing = [];
for (const a of REQUIRED) {
  if (!fs.existsSync(path.join(__dirname, '..', a.file))) missing.push(a);
}
for (const a of OPTIONAL) {
  if (!fs.existsSync(path.join(__dirname, '..', a.file))) {
    console.warn(`[verify-natives] WARNING: ${a.name} not built (${a.file}) — that feature will be unavailable in the packaged app`);
  }
}

if (missing.length) {
  console.error('');
  console.error('[verify-natives] Cannot package: native addons are not built:');
  for (const a of missing) console.error(`  - ${a.name}  (expected ${a.file})`);
  console.error('');
  console.error('Run this first, then re-run the dist command:');
  console.error('  npm run build-natives');
  console.error('');
  console.error('That needs a C/C++ toolchain: Xcode Command Line Tools (macOS),');
  console.error('Visual Studio Build Tools (Windows), or build-essential (Linux).');
  console.error('To package anyway (FT8 falls back to a slower WASM decoder;');
  console.error('JS8 will be unavailable): POTACAT_SKIP_NATIVE_CHECK=1');
  process.exit(1);
}
console.log('[verify-natives] All required native addons present');
