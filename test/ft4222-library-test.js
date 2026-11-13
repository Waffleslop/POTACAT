#!/usr/bin/env node
'use strict';
// lib/ft4222-library.js: FTDI's LibFT4222 names on each platform, what
// Station Setup copies, Mach-O architectures, and the helper's loader error
// in the platform's words (GitHub #360, ak6ma's Apple Silicon FT-710).
// Run: node test/ft4222-library-test.js
const assert = require('assert');
const L = require('../lib/ft4222-library');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

console.log('FTDI file names');
t('FTDI\'s Mac name libft4222.1.4.4.221.dylib counts, and so does the plain name', () => {
  assert.ok(L.isFt4222LibraryName('libft4222.1.4.4.221.dylib', 'darwin'));
  assert.ok(L.isFt4222LibraryName('libft4222.dylib', 'darwin'));
  assert.ok(!L.isFt4222LibraryName('libftd2xx.dylib', 'darwin'));
  assert.ok(!L.isFt4222LibraryName('libft4222.so', 'darwin'));
  assert.ok(!L.isFt4222LibraryName('libft4222.h', 'darwin'));
});
t('Linux versioned .so names count; Windows wants the DLL', () => {
  assert.ok(L.isFt4222LibraryName('libft4222.so.1.4.4.221', 'linux'));
  assert.ok(L.isFt4222LibraryName('libft4222.so', 'linux'));
  assert.ok(L.isFt4222LibraryName('LibFT4222-64.dll', 'win32'));
  assert.ok(!L.isFt4222LibraryName('libft4222.dylib', 'win32'));
});
t('in FTDI\'s Mac build folder the library and libftd2xx are both found', () => {
  const p = L.pickInFolder(['libft4222.1.4.4.221.dylib', 'libftd2xx.dylib', 'libft4222.h', 'ftd2xx.h', 'WinTypes.h'], 'darwin');
  assert.deepStrictEqual(p, { library: 'libft4222.1.4.4.221.dylib', d2xx: 'libftd2xx.dylib' });
});
t('the plain name wins over a versioned one; otherwise the newest version', () => {
  assert.strictEqual(L.pickInFolder(['libft4222.1.4.4.221.dylib', 'libft4222.dylib'], 'darwin').library, 'libft4222.dylib');
  assert.strictEqual(L.pickInFolder(['libft4222.so.1.4.4.44', 'libft4222.so.1.4.4.221'], 'linux').library, 'libft4222.so.1.4.4.221');
});

console.log('What Find the file for me copies');
t('Mac: the versioned library goes in as libft4222.dylib, with libftd2xx.dylib beside it', () => {
  const plan = L.installPlan({ platform: 'darwin', chosenName: 'libft4222.1.4.4.221.dylib', siblings: ['libft4222.1.4.4.221.dylib', 'libftd2xx.dylib'] });
  assert.ok(plan.ok);
  assert.deepStrictEqual(plan.copies, [
    { from: 'libft4222.1.4.4.221.dylib', to: 'libft4222.dylib' },
    { from: 'libftd2xx.dylib', to: 'libftd2xx.dylib' },
  ]);
});
t('Mac: a lone copy without libftd2xx.dylib beside it is refused, and the message says where both are', () => {
  const plan = L.installPlan({ platform: 'darwin', chosenName: 'libft4222.dylib', siblings: ['libft4222.dylib'] });
  assert.ok(!plan.ok);
  assert.ok(/libftd2xx\.dylib/.test(plan.message));
  assert.ok(/"build"/.test(plan.message));
});
t('Windows installs LibFT4222-64.dll alone; Linux installs libft4222.so alone', () => {
  assert.deepStrictEqual(L.installPlan({ platform: 'win32', chosenName: 'LibFT4222-64.dll' }).copies, [{ from: 'LibFT4222-64.dll', to: 'LibFT4222-64.dll' }]);
  assert.deepStrictEqual(L.installPlan({ platform: 'linux', chosenName: 'libft4222.so.1.4.4.221' }).copies, [{ from: 'libft4222.so.1.4.4.221', to: 'libft4222.so' }]);
});
t('a file that is not LibFT4222 is refused by name', () => {
  const plan = L.installPlan({ platform: 'darwin', chosenName: 'libftd2xx.dylib', siblings: [] });
  assert.ok(!plan.ok);
  assert.ok(/libftd2xx\.dylib/.test(plan.message));
});

console.log('Mach-O architectures');
// The first 68 bytes of FTDI's libft4222.1.4.4.221.dylib for macOS: a
// universal header with three slices (x86_64, arm64, arm64e).
const FTDI_HEAD = Buffer.from('cafebabe00000003010000070000000300004000000582e80000000e0100000c000000000006000000053ab00000000e0100000c80000002000b400000057d100000000e', 'hex');
t('FTDI\'s 1.4.4.221 Mac library is universal: x86_64 and arm64', () => {
  assert.deepStrictEqual(L.machoArchs(FTDI_HEAD), ['x86_64', 'arm64']);
});
t('a thin arm64 and a thin x86_64 file read as one architecture each', () => {
  const thin = (cpu) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return b; };
  assert.deepStrictEqual(L.machoArchs(thin(0x0100000c)), ['arm64']);
  assert.deepStrictEqual(L.machoArchs(thin(0x01000007)), ['x86_64']);
});
t('a file that is not Mach-O gives null', () => {
  assert.strictEqual(L.machoArchs(Buffer.from('not a library at all')), null);
  assert.strictEqual(L.machoArchs(null), null);
});
t('the helper\'s architecture follows the app\'s', () => {
  assert.strictEqual(L.helperArch('arm64'), 'arm64');
  assert.strictEqual(L.helperArch('x64'), 'x86_64');
});

console.log('The helper\'s loader error');
// dyld's words as macOS prints them for these cases.
const MISSING_D2XX = 'yaesu-scope: load failed: /Users/op/Library/Application Support/POTACAT/ftdi/libft4222.dylib: dlopen(/Users/op/Library/Application Support/POTACAT/ftdi/libft4222.dylib, 0x0002): Library not loaded: libftd2xx.dylib   Referenced from: <UUID> /Users/op/Library/Application Support/POTACAT/ftdi/libft4222.dylib   Reason: tried: \'libftd2xx.dylib\' (no such file)\nyaesu-scope: libft4222 found but would not load (reason above)\n';
const WRONG_ARCH = 'yaesu-scope: load failed: /usr/local/lib/libft4222.dylib: dlopen(/usr/local/lib/libft4222.dylib, 0x0002): tried: \'/usr/local/lib/libft4222.dylib\' (mach-o file, but is an incompatible architecture (have \'x86_64\', need \'arm64e\' or \'arm64\'))\n';
t('the path and the reason are read back out of the helper\'s line', () => {
  const e = L.loaderError(MISSING_D2XX);
  assert.strictEqual(e.path, '/Users/op/Library/Application Support/POTACAT/ftdi/libft4222.dylib');
  assert.ok(/^dlopen\(/.test(e.reason));
});
t('missing libftd2xx, wrong architecture and a refused signature are told apart', () => {
  assert.strictEqual(L.classifyLoaderError(L.loaderError(MISSING_D2XX).reason), 'missing-d2xx');
  assert.strictEqual(L.classifyLoaderError(L.loaderError(WRONG_ARCH).reason), 'arch');
  assert.strictEqual(L.classifyLoaderError('code signature in <...> not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs'), 'signature');
  assert.strictEqual(L.classifyLoaderError('libftd2xx.so: cannot open shared object file: No such file or directory'), 'missing-d2xx');
  assert.strictEqual(L.classifyLoaderError('something new'), 'other');
});
t('no loader line gives null (an older helper, or "not found")', () => {
  assert.strictEqual(L.loaderError('yaesu-scope: libft4222 not found (install FTDI\'s LibFT4222)'), null);
});

console.log('The "would not load" card speaks the platform\'s language');
t('Mac: missing libftd2xx says so, never mentions a .dll or amd64', () => {
  const d = L.loadFailureDiag({ platform: 'darwin', stderr: MISSING_D2XX });
  assert.strictEqual(d.kind, 'missing-d2xx');
  assert.ok(/libftd2xx\.dylib/.test(d.action));
  assert.ok(!/\.dll|amd64/i.test(d.action + (d.detail || '')));
  assert.ok(/^The computer said: dlopen/.test(d.detail));
});
t('Mac: an architecture mismatch names both architectures', () => {
  const d = L.loadFailureDiag({ platform: 'darwin', stderr: WRONG_ARCH, archs: ['x86_64'], helper: 'arm64' });
  assert.strictEqual(d.kind, 'arch');
  assert.ok(/x86_64/.test(d.action) && /arm64/.test(d.action));
});
t('Mac: with no loader line, a library of the wrong architecture is still caught from its header', () => {
  const d = L.loadFailureDiag({ platform: 'darwin', stderr: '', archs: ['x86_64'], helper: 'arm64' });
  assert.strictEqual(d.kind, 'arch');
});
t('every Mac kind has Mac wording', () => {
  for (const reason of ['Library not loaded: libftd2xx.dylib', 'incompatible architecture', 'code signature invalid', 'Library not loaded: libfoo.dylib', 'other']) {
    const d = L.loadFailureDiag({ platform: 'darwin', stderr: 'yaesu-scope: load failed: /x/libft4222.dylib: ' + reason + '\n' });
    assert.ok(d.action && !/\.dll|amd64/i.test(d.action), reason);
  }
});
t('Windows keeps its amd64 wording', () => {
  assert.ok(/LibFT4222-64\.dll/.test(L.loadFailureDiag({ platform: 'win32' }).action));
});

console.log('Station Setup download steps');
t('the Mac steps say disk image, the build folder, and that POTACAT copies both files', () => {
  const s = L.downloadSteps('darwin').join(' ');
  assert.ok(/\.dmg/.test(s));
  assert.ok(/"build"/.test(s));
  assert.ok(/libftd2xx\.dylib/.test(s));
  assert.ok(!/\.dll|amd64|Extract All/.test(s));
});
t('the Windows steps still point at LibFT4222-64.dll in amd64', () => {
  assert.ok(/LibFT4222-64\.dll.*amd64/.test(L.downloadSteps('win32').join(' ')));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
