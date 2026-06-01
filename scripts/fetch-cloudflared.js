#!/usr/bin/env node
// Download the cloudflared binary (one per platform/arch) and vendor it
// under resources/cloudflared/<platform>/cloudflared(.exe) so
// electron-builder can ship it as an extraResource.
//
// Usage:
//   node scripts/fetch-cloudflared.js                    # fetch all platforms
//   node scripts/fetch-cloudflared.js --platform=win     # win x64 only
//   node scripts/fetch-cloudflared.js --platform=mac --arch=arm64
//   node scripts/fetch-cloudflared.js --platform=linux --arch=arm64
//
// Used by:
//   - contributors before a local `npm run dist:*`
//   - the release workflow (.github/workflows/release.yml) — a "Fetch
//     cloudflared" step runs this with --platform/--arch matching the
//     electron-builder target right before packaging.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'resources', 'cloudflared');

// Source-of-truth GitHub release artifact names — straight from
// https://github.com/cloudflare/cloudflared/releases/latest.
// Mac binaries ship as .tgz tarballs containing a single `cloudflared`
// file; Windows + Linux are flat binaries.
// Per-platform destinations are FLAT (one binary per platform dir). The
// CI release workflow runs each electron-builder target on a separate
// runner — Win, Mac arm64, Mac x64, Linux x64, Linux arm64 — and each
// runner only ever fetches the arch it's about to package. So a single
// stable path per platform keeps the package.json extraResources entry
// arch-agnostic.
const TARGETS = {
  'win:x64':    { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', tarball: false, destDir: 'win',   destName: 'cloudflared.exe' },
  'mac:x64':    { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',  tarball: true,  destDir: 'mac',   destName: 'cloudflared' },
  'mac:arm64':  { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',  tarball: true,  destDir: 'mac',   destName: 'cloudflared' },
  'linux:x64':  { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',       tarball: false, destDir: 'linux', destName: 'cloudflared' },
  'linux:arm64':{ url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',       tarball: false, destDir: 'linux', destName: 'cloudflared' },
};

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

function pickTargets({ platform, arch }) {
  // No args: fetch one binary per platform matching the host arch, so
  // contributors get a working local dev tree (win:x64, plus host-arch
  // mac & linux). The destDirs are flat per platform, so fetching both
  // archs of the same platform would clobber each other.
  if (!platform) {
    const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return ['win:x64', `mac:${hostArch}`, `linux:${hostArch}`];
  }
  if (platform === 'win') return ['win:x64']; // arm64 windows unsupported for now
  const a = arch || 'x64';
  const key = `${platform}:${a}`;
  if (!TARGETS[key]) {
    throw new Error(`Unknown platform:arch combo "${key}". Valid: ${Object.keys(TARGETS).join(', ')}`);
  }
  return [key];
}

async function downloadToFile(url, destPath) {
  // Node 22 has global fetch with automatic redirect handling.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return destPath;
}

function extractTarball(tarballPath, destDir, destName) {
  // bsdtar (Windows 10+) and gnu tar (mac/linux) both grok -xzf.
  // Extract into a temp dir, then move the cloudflared file out — the
  // tarball's internal layout is flat ('./cloudflared') on every
  // platform release we've seen, but `tar` is happy to ignore extras.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-extract-'));
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', tmp], { stdio: 'inherit' });
    const candidates = ['cloudflared', './cloudflared'];
    let found = null;
    for (const c of candidates) {
      const p = path.join(tmp, c);
      if (fs.existsSync(p)) { found = p; break; }
    }
    if (!found) {
      // Last resort: pick the first file in the temp dir.
      const entries = fs.readdirSync(tmp);
      if (entries.length === 0) throw new Error('Tarball extracted nothing');
      found = path.join(tmp, entries[0]);
    }
    fs.mkdirSync(destDir, { recursive: true });
    const finalPath = path.join(destDir, destName);
    fs.copyFileSync(found, finalPath);
    return finalPath;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function fetchOne(key) {
  const t = TARGETS[key];
  const destDir = path.join(VENDOR_ROOT, t.destDir);
  const destPath = path.join(destDir, t.destName);
  console.log(`[fetch-cloudflared] ${key} → ${path.relative(REPO_ROOT, destPath)}`);
  console.log(`[fetch-cloudflared]   from ${t.url}`);

  if (t.tarball) {
    const tmpTgz = path.join(os.tmpdir(), `cloudflared-${key.replace(':', '-')}.tgz`);
    await downloadToFile(t.url, tmpTgz);
    extractTarball(tmpTgz, destDir, t.destName);
    try { fs.unlinkSync(tmpTgz); } catch {}
  } else {
    await downloadToFile(t.url, destPath);
  }
  // Executable bit for non-Windows binaries. fs.chmod is a no-op on
  // Windows so guarding isn't strictly necessary, but be explicit.
  if (!t.destName.endsWith('.exe')) {
    try { fs.chmodSync(destPath, 0o755); } catch {}
  }
  const size = fs.statSync(destPath).size;
  console.log(`[fetch-cloudflared]   ok (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  const args = parseArgs();
  let keys;
  try {
    keys = pickTargets({ platform: args.platform, arch: args.arch });
  } catch (err) {
    console.error('[fetch-cloudflared] ' + err.message);
    process.exit(2);
  }
  console.log(`[fetch-cloudflared] target(s): ${keys.join(', ')}`);
  for (const k of keys) {
    try {
      await fetchOne(k);
    } catch (err) {
      console.error(`[fetch-cloudflared] FAILED for ${k}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log('[fetch-cloudflared] done.');
}

main();
