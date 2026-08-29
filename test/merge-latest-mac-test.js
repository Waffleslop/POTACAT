#!/usr/bin/env node
'use strict';
// The latest-mac.yml merge (scripts/merge-latest-mac.js): the two per-arch
// mac release jobs each write their own channel file, and staging let one
// clobber the other — a per-release arch coin flip that broke Intel
// auto-update when arm64 won (1.10.10) and put Apple Silicon under Rosetta
// when x64 won (every other 1.10.x). Fixtures below are the REAL released
// v1.10.12 x64 manifest and its arm64 twin.
// Run: node test/merge-latest-mac-test.js
const assert = require('assert');
const { parseChannelYml, serializeChannelYml, mergeChannelData } =
  require('../scripts/merge-latest-mac');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const X64 = [
  'version: 1.10.12',
  'files:',
  '  - url: POTACAT-1.10.12-mac.zip',
  '    sha512: B3ghsAjYmD5iBkMV8wptkep/McqqxTrA8EUo0jXZ314crEWuQ9JqcXIpIjXzuxYA7mf+YuQMGqcon+h/XOzSnA==',
  '    size: 226692580',
  '  - url: POTACAT-1.10.12.dmg',
  '    sha512: WyUz2cCkm/mHOhyzNZ1NykcoehZQNyuz9XbM7h0EPhJPerUL7K5kNoPU8L0VkUzHQS0EQITg1Uou5rWTHPvsrQ==',
  '    size: 234820089',
  'path: POTACAT-1.10.12-mac.zip',
  'sha512: B3ghsAjYmD5iBkMV8wptkep/McqqxTrA8EUo0jXZ314crEWuQ9JqcXIpIjXzuxYA7mf+YuQMGqcon+h/XOzSnA==',
  "releaseDate: '2026-08-27T22:12:59.469Z'",
  '',
].join('\n');

const ARM64 = [
  'version: 1.10.12',
  'files:',
  '  - url: POTACAT-1.10.12-arm64-mac.zip',
  '    sha512: aaaa+bbbb/cccc==',
  '    size: 216005199',
  '  - url: POTACAT-1.10.12-arm64.dmg',
  '    sha512: dddd+eeee/ffff==',
  '    size: 224019177',
  'path: POTACAT-1.10.12-arm64-mac.zip',
  'sha512: aaaa+bbbb/cccc==',
  "releaseDate: '2026-08-27T22:10:11.000Z'",
  '',
].join('\n');

test('parses the real released x64 manifest', () => {
  const p = parseChannelYml(X64);
  assert.strictEqual(p.version, '1.10.12');
  assert.strictEqual(p.files.length, 2);
  assert.strictEqual(p.files[0].url, 'POTACAT-1.10.12-mac.zip');
  assert.strictEqual(p.files[1].size, 234820089);
  assert.strictEqual(p.path, 'POTACAT-1.10.12-mac.zip');
  assert.strictEqual(p.releaseDate, '2026-08-27T22:12:59.469Z');
});

test('merge lists all four files, x64 kept primary, arm64 appended', () => {
  const m = mergeChannelData(parseChannelYml(X64), parseChannelYml(ARM64));
  assert.strictEqual(m.files.length, 4);
  assert.deepStrictEqual(m.files.map((f) => f.url), [
    'POTACAT-1.10.12-mac.zip', 'POTACAT-1.10.12.dmg',
    'POTACAT-1.10.12-arm64-mac.zip', 'POTACAT-1.10.12-arm64.dmg',
  ]);
  // Primary identity (path/sha512/releaseDate) must stay the x64 job's —
  // electron-updater's arch filter works on files[]; path is the legacy
  // fallback and must remain a file every pre-files client can use.
  assert.strictEqual(m.path, 'POTACAT-1.10.12-mac.zip');
  assert.strictEqual(m.sha512, parseChannelYml(X64).sha512);
});

test('round-trips through the serializer losslessly', () => {
  const merged = mergeChannelData(parseChannelYml(X64), parseChannelYml(ARM64));
  const reparsed = parseChannelYml(serializeChannelYml(merged));
  assert.deepStrictEqual(reparsed, merged);
});

test('VERSION MISMATCH refuses — a stale artifact must fail the release', () => {
  const stale = ARM64.replace(/1\.10\.12/g, '1.10.11');
  assert.throws(() => mergeChannelData(parseChannelYml(X64), parseChannelYml(stale)),
    /version mismatch/);
});

test('merge is idempotent (dedupe by url)', () => {
  const p = parseChannelYml(X64);
  const once = mergeChannelData(p, parseChannelYml(ARM64));
  const twice = mergeChannelData(once, parseChannelYml(ARM64));
  assert.strictEqual(twice.files.length, 4);
});

test('unrecognized lines refuse loudly instead of merging blind', () => {
  assert.throws(() => parseChannelYml(X64 + 'stagingPercentage: 10\n'),
    /unrecognized channel-file line/);
  assert.throws(() => parseChannelYml('version: 1.0.0\nfiles:\n'), /no files/);
});

console.log(`\nmerge-latest-mac: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
