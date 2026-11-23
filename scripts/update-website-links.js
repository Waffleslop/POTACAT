#!/usr/bin/env node
// scripts/update-website-links.js
//
// Points the download section of potacat-website/index.html at a new release
// by changing VERSION STRINGS IN PLACE, inside the DOWNLOAD-START/END block and
// the hero "Get the Intel build" link (class="intel-mac"). It never rebuilds
// the block from a template: the website session owns the block's markup and
// copy, and the release job may push only version changes (Casey, 2026-11-22;
// scripts/website-links-guard.js checks that before the push).
//
// The asset names the block links to must match electron-builder's artifact
// names (package.json build config): POTACAT-Setup-<v>.exe,
// POTACAT-Portable-<v>.exe, POTACAT-<v>.dmg, POTACAT-<v>-arm64.dmg,
// POTACAT-<v>.AppImage, POTACAT-<v>-arm64.AppImage, potacat_<v>_amd64.deb,
// potacat_<v>_arm64.deb, potacat-<v>.x86_64.rpm, potacat-<v>.aarch64.rpm.
//
// Usage: node update-website-links.js <version> <path-to-index.html>

const fs = require('fs');
const { updateDownloadVersions } = require('./website-links-guard');

const version = process.argv[2];
const htmlPath = process.argv[3];

if (!version || !htmlPath) {
  console.error('Usage: node update-website-links.js <version> <path-to-index.html>');
  process.exit(1);
}

let result;
try {
  result = updateDownloadVersions(fs.readFileSync(htmlPath, 'utf-8'), version);
} catch (e) {
  console.error('update-website-links:', e.message);
  process.exit(1);
}

if (!result.changed) {
  console.log('No changes needed, already at v' + version);
  process.exit(0);
}

fs.writeFileSync(htmlPath, result.html, 'utf-8');
console.log('Updated', htmlPath, 'from v' + result.oldVersion + ' to v' + version);
