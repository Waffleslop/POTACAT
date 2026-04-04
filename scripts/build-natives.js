#!/usr/bin/env node
/**
 * Postinstall script — attempts to build native addons (FT8, FreeDV, RADE).
 * Failures are non-fatal: features that need native addons simply won't
 * be available at runtime.
 */

const { execSync } = require('child_process');
const path = require('path');

const addons = [
  { name: 'ft8_native',    dir: 'lib/ft8_native',    cmd: 'npx node-gyp rebuild' },
  { name: 'freedv_native',  dir: 'lib/freedv_native',  cmd: 'npx node-gyp rebuild' },
  { name: 'rade_native',    dir: null,                  cmd: 'node scripts/build-rade.js' },
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
