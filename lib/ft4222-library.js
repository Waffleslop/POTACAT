'use strict';
//
// FTDI's LibFT4222 on the operator's computer: which files count, what Station
// Setup copies, and what the helper's loader error means (GitHub #360).
//
// What FTDI ships for macOS (LibFT4222 1.4.4.221, read 2026-11-12 from the
// copy vendored in gitlab.com/msrelectronics/python-ft4222, osx/):
//   - the library is named libft4222.1.4.4.221.dylib, never plainly
//     libft4222.dylib, and sits in the package's build folder beside
//     libftd2xx.dylib;
//   - both are universal binaries (x86_64 + arm64), so the arm64 and the x86_64
//     helper can both load them;
//   - libft4222 loads libftd2xx.dylib by its bare name (the vendor's readme
//     rewrites that reference to @loader_path), so without libftd2xx.dylib in
//     the same folder or on the library path it does not load.
// So on a Mac the library name is versioned and libftd2xx.dylib has to travel
// with it. On Linux libft4222.so carries the D2XX calls itself; on Windows the
// D2XX driver installs ftd2xx.dll system-wide.
//
// Pure: no fs, no Electron. main.js passes directory listings and file bytes.

/** The names the helper asks for first: what Setup installs a copy under. */
function canonicalName(platform) {
  if (platform === 'win32') return 'LibFT4222-64.dll';
  if (platform === 'darwin') return 'libft4222.dylib';
  return 'libft4222.so';
}

/** Whether a file name is FTDI's LibFT4222 for this platform, versioned or not. */
function isFt4222LibraryName(name, platform) {
  const n = String(name || '');
  if (platform === 'win32') return /^LibFT4222(-64)?\.dll$/i.test(n);
  if (platform === 'darwin') return /^libft4222(\.[0-9][0-9.]*)?\.dylib$/i.test(n);
  return /^libft4222\.so(\.[0-9][0-9.]*)?$/i.test(n);
}

/** The D2XX library a LibFT4222 needs beside it: only macOS ships it as a separate file next to the library. */
function d2xxName(platform) {
  if (platform === 'win32') return 'ftd2xx.dll';
  if (platform === 'darwin') return 'libftd2xx.dylib';
  return null;
}

function isD2xxName(name, platform) {
  const n = String(name || '');
  if (platform === 'darwin') return /^libftd2xx(\.[0-9][0-9.]*)?\.dylib$/i.test(n);
  if (platform === 'win32') return /^ftd2xx(64)?\.dll$/i.test(n);
  return false;
}

/**
 * In one folder's file list: the LibFT4222 file and the D2XX file, or null.
 * The plain name wins over a versioned one; among versioned names the highest
 * version wins.
 */
function pickInFolder(fileNames, platform) {
  const names = (fileNames || []).map(String);
  const libs = names.filter((n) => isFt4222LibraryName(n, platform));
  const canon = canonicalName(platform).toLowerCase();
  libs.sort((a, b) => {
    if (a.toLowerCase() === canon) return -1;
    if (b.toLowerCase() === canon) return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
  const d2 = names.filter((n) => isD2xxName(n, platform));
  d2.sort((a, b) => a.length - b.length);
  return { library: libs[0] || null, d2xx: d2[0] || null };
}

/**
 * What "Find the file for me" copies into POTACAT's own ftdi folder.
 * `chosenName`: the file the operator picked. `siblings`: the names in its
 * folder. Returns { ok, copies: [{ from, to }], message }. `from` is a name in
 * the chosen folder; `to` is the name to write in POTACAT's folder.
 */
function installPlan({ platform, chosenName, siblings = [] }) {
  const base = String(chosenName || '');
  if (!isFt4222LibraryName(base, platform)) {
    return { ok: false, copies: [], message: `That file is "${base}". Choose the one named ${platform === 'darwin' ? 'libft4222 (it ends in .dylib)' : canonicalName(platform)}.` };
  }
  const copies = [{ from: base, to: canonicalName(platform) }];
  if (platform === 'darwin') {
    const { d2xx } = pickInFolder(siblings, platform);
    if (!d2xx) {
      return { ok: false, copies: [], message: 'libftd2xx.dylib is not in the same folder as that file, and the library cannot load without it. '
        + 'In FTDI\'s download both files are in the folder named "build": choose the libft4222 file there.' };
    }
    copies.push({ from: d2xx, to: 'libftd2xx.dylib' });
  }
  return { ok: true, copies, message: 'Done. The file is installed.' };
}

// ─── Mach-O: which architectures a .dylib holds ──────────────────────────────
const CPU_NAMES = { 0x01000007: 'x86_64', 0x0100000c: 'arm64', 7: 'i386', 12: 'arm' };

/** The architectures in a Mach-O file's first bytes (thin or universal), or null when it is not Mach-O. */
function machoArchs(buf) {
  if (!buf || buf.length < 8) return null;
  const be = buf.readUInt32BE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) {        // universal ("fat"), big-endian header
    const n = buf.readUInt32BE(4);
    const wide = be === 0xcafebabf;
    const step = wide ? 32 : 20;
    if (n < 1 || n > 16 || buf.length < 8 + n * step) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
      const cpu = buf.readUInt32BE(8 + i * step);
      const name = CPU_NAMES[cpu] || ('cpu ' + cpu);
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }
  const le = buf.readUInt32LE(0);
  if (le === 0xfeedfacf || le === 0xfeedface) {
    const cpu = buf.readUInt32LE(4);
    return [CPU_NAMES[cpu] || ('cpu ' + cpu)];
  }
  return null;
}

/** The Mach-O name of the helper's architecture for a Node process.arch. */
function helperArch(processArch) {
  return processArch === 'arm64' ? 'arm64' : processArch === 'x64' ? 'x86_64' : String(processArch || '');
}

// ─── The helper's loader error ────────────────────────────────────────────────
// The helper prints, for each LibFT4222 file that exists and would not load:
//   yaesu-scope: load failed: <path>: <dlerror() text>
// and finishes with a "found but would not load" or "not found" line.

/** The first loader error the helper printed for a file that exists: { path, reason } or null. */
function loaderError(stderr) {
  const m = /yaesu-scope: load failed: (.+?): (.+)/.exec(String(stderr || ''));
  if (!m) return null;
  return { path: m[1].trim(), reason: m[2].trim() };
}

/** What the loader's words mean, as a key. */
function classifyLoaderError(reason) {
  const r = String(reason || '');
  if (/incompatible architecture|wrong architecture|wrong ELF class|have '[^']+', need '[^']+'/i.test(r)) return 'arch';
  if (/Library not loaded:.*libftd2xx|libftd2xx[^ ]*: cannot open shared object/i.test(r)) return 'missing-d2xx';
  if (/code signature|not valid for use in process|quarantine|notariz|Team ID/i.test(r)) return 'signature';
  if (/Library not loaded/i.test(r)) return 'missing-dependency';
  return 'other';
}

/**
 * The card for "the library is on this computer but would not load", in the
 * words of the platform. `stderr`: what the helper said. `archs`: the
 * architectures of the installed library when known; `helper`: the helper's.
 */
function loadFailureDiag({ platform, stderr = '', archs = null, helper = '' }) {
  const err = loaderError(stderr);
  const reason = err ? err.reason : '';
  let kind = err ? classifyLoaderError(reason) : 'other';
  if (kind === 'other' && archs && helper && !archs.includes(helper)) kind = 'arch';
  const headline = 'LibFT4222 is on this computer but would not load';
  const why = reason ? 'The computer said: ' + reason : '';
  if (platform === 'darwin') {
    const actions = {
      'missing-d2xx': 'The library needs libftd2xx.dylib beside it. Press Find the file for me in Station Setup and choose the libft4222 file in the "build" folder of FTDI\'s download: POTACAT copies libftd2xx.dylib with it.',
      arch: `This copy of the library is not built for this Mac (it holds ${archs && archs.length ? archs.join(' and ') : 'another architecture'}, POTACAT needs ${helper || 'its own'}). Download the current LibFT4222 for Mac from ftdichip.com and choose the libft4222 file in its "build" folder.`,
      signature: 'macOS refused the file. Press Find the file for me in Station Setup and choose the libft4222 file again: POTACAT installs a fresh copy. If it still fails, send a bug report from Help.',
      'missing-dependency': 'The library needs another file that is not on this Mac. Choose the libft4222 file in the "build" folder of FTDI\'s download with Find the file for me, then send a bug report from Help if it still fails.',
      other: 'Press Find the file for me in Station Setup and choose the libft4222 file in the "build" folder of FTDI\'s download. If it still fails, send a bug report from Help: it carries the reason.',
    };
    return { kind, reason, headline, detail: why || undefined, action: actions[kind] };
  }
  if (platform === 'win32') {
    return { kind, reason, headline, detail: why || undefined,
      action: 'Press Find the file for me in Station Setup and choose LibFT4222-64.dll from the amd64 folder.' };
  }
  return { kind, reason, headline, detail: why || undefined,
    action: kind === 'arch'
      ? 'This copy of libft4222 is for another processor. Install the build folder that matches this computer from FTDI\'s Linux package, then run sudo ldconfig.'
      : 'Press Find the file for me in Station Setup and choose libft4222.so from FTDI\'s Linux package, or install it following its README and run sudo ldconfig.' };
}

/** Station Setup's download instructions for this platform. */
function downloadSteps(platform) {
  if (platform === 'win32') {
    return [
      'Press Open FTDI\'s download page. Download "LibFT4222" for Windows. It arrives as a zip file.',
      'Open the zip file (on Windows, double-click it, or right-click and choose Extract All).',
      'Press Find the file for me and choose LibFT4222-64.dll. It is in a folder called "amd64". POTACAT copies it where it needs to go; nothing else to install.',
    ];
  }
  if (platform === 'darwin') {
    return [
      'Press Open FTDI\'s download page. Download "LibFT4222" for Mac. It arrives as a disk image (.dmg) or a zip file.',
      'Open it (double-click). Inside is a folder named "build".',
      'Press Find the file for me and choose the file in "build" whose name starts with libft4222 (for example libft4222.1.4.4.221.dylib). POTACAT copies it and libftd2xx.dylib beside it; you do not need to rename anything or use the Terminal.',
    ];
  }
  return [
    'Press Open FTDI\'s download page. Download "LibFT4222" for Linux. It arrives as a compressed archive.',
    'Unpack it.',
    'Press Find the file for me and choose the libft4222 file in the build folder for this computer (build-x86_64 on most PCs, build-arm-v8 on a 64-bit Raspberry Pi). POTACAT copies it where it needs to go.',
  ];
}

module.exports = {
  canonicalName, isFt4222LibraryName, d2xxName, isD2xxName, pickInFolder, installPlan,
  machoArchs, helperArch, loaderError, classifyLoaderError, loadFailureDiag, downloadSteps,
};
