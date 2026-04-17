#!/usr/bin/env node
// scripts/release.js — Create a GitHub release with install instructions and SHA256 checksums
//
// Usage:
//   node scripts/release.js "Release title" "## What's New\n- Feature 1\n- Feature 2"
//
// Or interactively — it will prompt if args are missing.
// Requires: gh CLI (https://cli.github.com) authenticated
//
// Collects all platform artifacts found in dist/:
//   Windows: POTACAT-Setup-{v}.exe, POTACAT-{v}-portable.exe, latest.yml
//   Linux:   POTACAT-{v}.AppImage, potacat_{v}_amd64.deb, latest-linux.yml
//   macOS:   POTACAT-{v}.dmg, POTACAT-{v}-mac.zip, latest-mac.yml

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = pkg.version;
const tag = `v${version}`;
const distDir = path.join(__dirname, '..', 'dist');

function sha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Try to add an artifact from dist/. Returns true if found. */
function tryAdd(assets, fileName, { hash = true } = {}) {
  const filePath = path.join(distDir, fileName);
  if (fs.existsSync(filePath)) {
    assets.push({ path: filePath, name: fileName, hash: hash ? sha256(filePath) : null });
    return true;
  }
  return false;
}

function main() {
  const assets = [];
  const platforms = [];

  // --- Windows ---
  const installerName = `POTACAT-Setup-${version}.exe`;
  const portableName = `POTACAT-Portable-${version}.exe`;
  if (tryAdd(assets, installerName)) {
    platforms.push('win');
    tryAdd(assets, portableName);
  }
  tryAdd(assets, 'latest.yml', { hash: false });

  // --- Linux ---
  const appImageName = `POTACAT-${version}.AppImage`;
  // electron-builder may also produce arm64 variant
  const appImageArm64 = `POTACAT-${version}-arm64.AppImage`;
  const debName = `potacat_${version}_amd64.deb`;
  const rpmName = `potacat-${version}.x86_64.rpm`;
  if (tryAdd(assets, appImageName)) platforms.push('linux');
  tryAdd(assets, appImageArm64);
  tryAdd(assets, debName);
  tryAdd(assets, rpmName);
  tryAdd(assets, 'latest-linux.yml', { hash: false });

  // --- macOS ---
  const dmgName = `POTACAT-${version}.dmg`;
  const macZipName = `POTACAT-${version}-mac.zip`;
  // Arm64 variants
  const dmgArm64 = `POTACAT-${version}-arm64.dmg`;
  const macZipArm64 = `POTACAT-${version}-arm64-mac.zip`;
  if (tryAdd(assets, dmgName) || tryAdd(assets, dmgArm64)) platforms.push('mac');
  tryAdd(assets, macZipName);
  tryAdd(assets, macZipArm64);
  tryAdd(assets, 'latest-mac.yml', { hash: false });

  if (!assets.length) {
    console.error('ERROR: No build artifacts found in dist/');
    console.error('Run one or more of: npm run dist:win, npm run dist:linux, npm run dist:mac');
    process.exit(1);
  }

  console.log(`\nPlatforms found: ${platforms.join(', ') || 'none'}`);

  // Build title and body
  const title = process.argv[2] || `${tag} beta`;
  const whatsNew = process.argv[3] || '<!-- Add release notes here -->';

  // Build checksums section
  const checksums = assets.filter(a => a.hash).map(a => `| \`${a.name}\` | \`${a.hash}\` |`).join('\n');

  // Build platform-specific install sections
  const installSections = [];

  if (platforms.includes('win')) {
    installSections.push(`### Windows
1. Download **\`${installerName}\`** below (or the portable version)
2. Run the installer — Windows SmartScreen may show **"Windows protected your PC"**
   - Click **More info** then **Run anyway**
   - This is normal for unsigned open-source apps
3. POTACAT will launch automatically after install`);
  }

  if (platforms.includes('linux')) {
    installSections.push(`### Linux
- **AppImage**: Download **\`${appImageName}\`**, then \`chmod +x\` and run it
- **Debian/Ubuntu**: Download **\`${debName}\`** and install with \`sudo dpkg -i ${debName}\``);
  }

  if (platforms.includes('mac')) {
    const macFile = fs.existsSync(path.join(distDir, dmgName)) ? dmgName : dmgArm64;
    installSections.push(`### macOS
1. Download **\`${macFile}\`**
2. Open the .dmg and drag POTACAT to Applications
3. On first launch: right-click → Open (Gatekeeper will block double-click)`);
  }

  const body = `${whatsNew}

---

## Install

${installSections.join('\n\n')}

> POTACAT is open source and not code-signed. Your OS may warn on first run.
> This is expected. You can verify the download using the SHA-256 checksums below.

## SHA-256 Checksums

| File | SHA-256 |
|------|---------|
${checksums}

**Full Changelog**: https://github.com/Waffleslop/POTACAT/compare/v${getPreviousTag()}...${tag}`;

  // Write body to temp file (avoids shell escaping issues)
  const bodyFile = path.join(distDir, 'release-notes.md');
  fs.writeFileSync(bodyFile, body, 'utf-8');

  console.log(`\nCreating release ${tag}: ${title}`);
  console.log(`Assets: ${assets.map(a => a.name).join(', ')}`);
  console.log(`Checksums:`);
  assets.filter(a => a.hash).forEach(a => console.log(`  ${a.name}: ${a.hash}`));
  console.log('');

  // Create release with gh
  const assetArgs = assets.map(a => `"${a.path}"`).join(' ');
  const cmd = `gh release create "${tag}" --title "${title}" --notes-file "${bodyFile}" ${assetArgs}`;

  try {
    console.log(`Running: ${cmd}\n`);
    execSync(cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    console.log(`\nRelease ${tag} created successfully!`);
  } catch (err) {
    console.error('Failed to create release. Check gh auth status.');
    process.exit(1);
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }
  }
}

function getPreviousTag() {
  try {
    const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf-8' }).trim().split('\n');
    // Find the first tag that isn't the current one
    for (const t of tags) {
      if (t.trim() && t.trim() !== tag) return t.trim();
    }
  } catch { /* ignore */ }
  // Fallback: decrement patch
  const parts = version.split('.').map(Number);
  if (parts[2] > 0) parts[2]--;
  else if (parts[1] > 0) { parts[1]--; parts[2] = 0; }
  return `v${parts.join('.')}`;
}

main();
