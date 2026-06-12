'use strict';
// electron-builder afterPack hook (Linux only) — install the sandbox
// launcher (GitHub issue #37). Renames the real Electron binary to
// <name>.bin and puts scripts/linux-launcher.sh in its place, so every
// Linux target (deb / rpm / AppImage — they all package this same
// unpacked dir, and their .desktop/symlink entry points reference the
// executable name) goes through the sandbox-compat decision before
// Chromium starts. The decision can't live in main.js: on systems that
// deny user namespaces, Chromium aborts before any JS runs.
//
// Pairs with build/linux-apparmor-profile (linux.appArmorProfile),
// which attaches to the RENAMED <name>.bin path — the stock
// electron-builder profile would attach to the wrapper script and
// grant nothing to the real binary.

const fs = require('fs');
const path = require('path');

exports.default = async function linuxAfterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const exe = context.packager.executableName;
  const appOutDir = context.appOutDir;
  const binPath = path.join(appOutDir, exe);
  const realPath = path.join(appOutDir, exe + '.bin');
  if (!fs.existsSync(binPath)) {
    throw new Error(`linux-after-pack: expected executable ${binPath} not found`);
  }
  if (fs.existsSync(realPath)) return; // idempotent (re-runs per target)
  fs.renameSync(binPath, realPath);
  const launcher = fs.readFileSync(path.join(__dirname, 'linux-launcher.sh'), 'utf8')
    .replace(/\r\n/g, '\n'); // Windows checkout must not ship CRLF into a shebang script
  fs.writeFileSync(binPath, launcher, { mode: 0o755 });
  console.log(`  • linux-after-pack: ${exe} is now the sandbox launcher; real binary at ${exe}.bin`);
};
