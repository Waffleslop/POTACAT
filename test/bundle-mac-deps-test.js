// Tests for the macOS bundle gate (scripts/bundle-mac-deps.js).
//
// The fixtures below are the ACTUAL load commands read out of the shipped
// POTACAT-1.10.12-arm64-mac.zip on 2026-08-31, after WB0MMC reported "No rigs
// found" on a Hamlib K3. Both helper binaries we ship on macOS were asking
// dyld for absolute Homebrew paths that exist only on the CI runner, so both
// died at launch on every user's Mac. This test is the gate's memory: if the
// bundling ever regresses, these two shapes must still be rejected.
'use strict';
const assert = require('assert');
const { bundleProblems, isSystem, isOurs } = require('../scripts/bundle-mac-deps');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const HAMLIB_DIR = ['COPYING.LIB.txt', 'COPYING.txt', 'LICENSE.txt', 'libhamlib.4.dylib', 'libusb-1.0.0.dylib', 'rigctld'];

console.log('bundleProblems()');

t('rejects the rigctld that actually shipped in 1.10.12', () => {
  // Only the libusb slot got rewritten (and to the wrong name); the real
  // libhamlib load command still pointed into the runner's Cellar.
  const problems = bundleProblems([{
    name: 'rigctld',
    deps: [
      '/opt/homebrew/Cellar/hamlib/4.7.2/lib/libhamlib.4.dylib',
      '@loader_path/libhamlib.4.dylib',
      '/usr/lib/libSystem.B.dylib',
      '/usr/lib/libedit.3.dylib',
    ],
    shipped: HAMLIB_DIR,
  }]);
  assert.strictEqual(problems.length, 1, `expected 1 problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /Cellar\/hamlib/);
});

t('rejects the wsprd that actually shipped in 1.10.12', () => {
  // -static-libgfortran/-static-libgcc leave libquadmath dynamic.
  const problems = bundleProblems([{
    name: 'wsprd',
    deps: [
      '/opt/homebrew/opt/gcc/lib/gcc/current/libquadmath.0.dylib',
      '/usr/lib/libSystem.B.dylib',
    ],
    shipped: ['README.md', 'wsprd'],
  }]);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /libquadmath/);
});

t('accepts a properly bundled hamlib directory', () => {
  const problems = bundleProblems([
    {
      name: 'rigctld',
      deps: ['@loader_path/libhamlib.4.dylib', '/usr/lib/libSystem.B.dylib', '/usr/lib/libedit.3.dylib'],
      shipped: HAMLIB_DIR,
    },
    {
      name: 'libhamlib.4.dylib',
      deps: ['@loader_path/libusb-1.0.0.dylib', '/usr/lib/libSystem.B.dylib'],
      shipped: HAMLIB_DIR,
    },
    {
      name: 'libusb-1.0.0.dylib',
      deps: ['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/IOKit.framework/Versions/A/IOKit'],
      shipped: HAMLIB_DIR,
    },
  ]);
  assert.deepStrictEqual(problems, []);
});

t('catches a @loader_path pointing at a file we forgot to ship', () => {
  // The other half of the failure: the rewrite succeeded, the copy did not.
  const problems = bundleProblems([{
    name: 'rigctld',
    deps: ['@loader_path/libhamlib.4.dylib'],
    shipped: ['rigctld'],
  }]);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /not shipped/);
});

t('/usr/local is Intel Homebrew, not a system path', () => {
  const problems = bundleProblems([{
    name: 'rigctld',
    deps: ['/usr/local/opt/hamlib/lib/libhamlib.4.dylib'],
    shipped: ['rigctld'],
  }]);
  assert.strictEqual(problems.length, 1);
});

t('flags @rpath and @executable_path — neither resolves from Resources/', () => {
  const problems = bundleProblems([{
    name: 'rigctld',
    deps: ['@rpath/libhamlib.4.dylib', '@executable_path/../Frameworks/libfoo.dylib'],
    shipped: ['rigctld', 'libhamlib.4.dylib'],
  }]);
  assert.strictEqual(problems.length, 2);
});

console.log('isSystem() / isOurs()');

t('only /usr/lib and /System are system paths', () => {
  assert.ok(isSystem('/usr/lib/libSystem.B.dylib'));
  assert.ok(isSystem('/System/Library/Frameworks/IOKit.framework/Versions/A/IOKit'));
  assert.ok(!isSystem('/usr/libexec/something.dylib')); // near-miss on the prefix
  assert.ok(!isSystem('/usr/local/lib/libhamlib.4.dylib'));
  assert.ok(!isSystem('/opt/homebrew/lib/libhamlib.4.dylib'));
});

t('ours means @loader_path, exactly', () => {
  assert.ok(isOurs('@loader_path/libhamlib.4.dylib'));
  assert.ok(!isOurs('@rpath/libhamlib.4.dylib'));
  assert.ok(!isOurs('/opt/homebrew/lib/libhamlib.4.dylib'));
});

console.log(`\n${passed} passed`);
