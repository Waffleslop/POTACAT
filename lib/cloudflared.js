// POTACAT Cloud — runtime helper for the bundled cloudflared binary.
//
// electron-builder ships the platform-appropriate binary as an
// extraResource so it lands at `process.resourcesPath/cloudflared(.exe)`
// in packaged builds. In dev (electron .) the binary lives under
// `resources/cloudflared/<platform>/cloudflared(.exe)` and is fetched
// on demand via `node scripts/fetch-cloudflared.js`.
//
// `resolveCloudflaredPath()` is the only thing other modules should
// call — it handles packaged-vs-dev and the .exe suffix.

const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? '.exe' : '';

function devVendorPath() {
  // Source tree layout written by scripts/fetch-cloudflared.js.
  const platDir =
    process.platform === 'win32'  ? 'win'   :
    process.platform === 'darwin' ? 'mac'   :
                                    'linux';
  return path.join(__dirname, '..', 'resources', 'cloudflared', platDir, `cloudflared${EXE}`);
}

function packagedPath() {
  // process.resourcesPath is undefined in non-Electron contexts; the
  // packaged extraResource entry puts the binary flat at that root.
  if (!process.resourcesPath) return null;
  return path.join(process.resourcesPath, `cloudflared${EXE}`);
}

function resolveCloudflaredPath() {
  const candidates = [packagedPath(), devVendorPath()].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function isAvailable() {
  return resolveCloudflaredPath() !== null;
}

module.exports = { resolveCloudflaredPath, isAvailable };
