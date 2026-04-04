#!/usr/bin/env node
/**
 * Build script for rade_native — builds Opus from source if needed, then
 * compiles the RADE V1 native addon with node-gyp.
 *
 * Works on Windows, macOS, and Linux.
 * Requirements: C compiler (MSVC/gcc/clang), CMake, node-gyp
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', 'lib', 'rade_native');
const OPUS_SRC = path.join(ROOT, 'opus_src');
const OPUS_LIB_DIR = path.join(ROOT, 'opus_lib');

// Platform-specific library paths
const PLATFORM_LIB = {
  win32:  { dir: 'win64',  file: 'opus.lib' },
  darwin: { dir: 'macos',  file: 'libopus.a' },
  linux:  { dir: 'linux',  file: 'libopus.a' },
};

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function buildOpus() {
  const plat = PLATFORM_LIB[process.platform];
  if (!plat) {
    console.error(`[build-rade] Unsupported platform: ${process.platform}`);
    process.exit(1);
  }

  const libDir = path.join(OPUS_LIB_DIR, plat.dir);
  const libPath = path.join(libDir, plat.file);

  if (fs.existsSync(libPath)) {
    console.log(`[build-rade] Opus library exists: ${libPath}`);
    return;
  }

  console.log(`[build-rade] Building Opus from source for ${process.platform}...`);

  if (!fs.existsSync(OPUS_SRC)) {
    console.error('[build-rade] Opus source not found at', OPUS_SRC);
    process.exit(1);
  }

  // Check CMake is available
  try {
    execSync('cmake --version', { stdio: 'pipe' });
  } catch {
    console.error('[build-rade] CMake not found. Install it:');
    console.error('  macOS:  brew install cmake');
    console.error('  Linux:  sudo apt install cmake  (or dnf/pacman)');
    console.error('  Windows: install Visual Studio or cmake.org');
    process.exit(1);
  }

  const buildDir = path.join(ROOT, 'opus_build_tmp');
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });

  // CMake configure
  const cmakeArgs = [
    `-S "${OPUS_SRC}"`,
    `-B "${buildDir}"`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DOPUS_DRED=ON',
    '-DOPUS_OSCE=ON',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DBUILD_TESTING=OFF',
    '-DBUILD_PROGRAMS=OFF',
  ];

  // Windows: specify x64 architecture
  if (process.platform === 'win32') {
    cmakeArgs.push('-A x64');
  }

  run(`cmake ${cmakeArgs.join(' ')}`);

  // Build
  run(`cmake --build "${buildDir}" --config Release`);

  // Find and copy the library
  let builtLib;
  if (process.platform === 'win32') {
    builtLib = path.join(buildDir, 'Release', 'opus.lib');
    if (!fs.existsSync(builtLib)) builtLib = path.join(buildDir, 'opus.lib');
  } else {
    builtLib = path.join(buildDir, 'libopus.a');
  }

  if (!fs.existsSync(builtLib)) {
    // Search for it
    const findCmd = process.platform === 'win32'
      ? `dir /s /b "${buildDir}\\opus.lib"`
      : `find "${buildDir}" -name "libopus.a" -type f`;
    try {
      builtLib = execSync(findCmd, { encoding: 'utf8' }).trim().split('\n')[0];
    } catch {}
  }

  if (!builtLib || !fs.existsSync(builtLib)) {
    console.error('[build-rade] Could not find built Opus library in', buildDir);
    process.exit(1);
  }

  fs.copyFileSync(builtLib, libPath);
  console.log(`[build-rade] Opus library installed: ${libPath}`);

  // Cleanup build directory
  fs.rmSync(buildDir, { recursive: true, force: true });
}

function buildRade() {
  console.log('[build-rade] Building rade_native addon...');
  run('npx node-gyp rebuild', { cwd: ROOT });
  console.log('[build-rade] rade_native build complete!');
}

// --- Main ---
console.log('[build-rade] RADE V1 native addon build');
console.log(`  Platform: ${process.platform} ${os.arch()}`);
console.log(`  Node: ${process.version}`);

try {
  buildOpus();
  buildRade();
} catch (err) {
  console.error('[build-rade] Build failed:', err.message);
  process.exit(1);
}
