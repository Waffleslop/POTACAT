#!/usr/bin/env node
'use strict';
/**
 * Private keys and secret-bearing files are owner-only (0600) on Linux and
 * macOS: the ECHOCAT self-signed TLS key, the Tailscale-issued key, and
 * settings.json (passwords and tokens). A key written by an earlier version
 * is chmod'ed when the server starts. Windows ignores POSIX modes (profile
 * ACLs protect the folder), so there the test checks the mode option is
 * passed and the chmod is skipped.
 *
 * Run: node test/secret-file-test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSrc } = require('./_src');
const SecretFile = require('../lib/secret-file');

const POSIX = process.platform !== 'win32';
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
}
const mode = (p) => fs.statSync(p).mode & 0o777;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-secret-'));

/** Record every fs.writeFileSync / chmodSync while fn runs. */
function spyFs(fn) {
  const writes = [], chmods = [];
  const w = fs.writeFileSync, c = fs.chmodSync;
  fs.writeFileSync = function (p, data, opts) { writes.push({ p: String(p), opts }); return w.apply(this, arguments); };
  fs.chmodSync = function (p, m) { chmods.push({ p: String(p), m }); return c.apply(this, arguments); };
  try { return { result: fn(), writes, chmods }; }
  finally { fs.writeFileSync = w; fs.chmodSync = c; }
}

test('writeSecretFile passes mode 0600 and chmods (POSIX), skips the chmod on Windows', () => {
  const calls = [];
  const fake = {
    writeFileSync: (p, d, o) => calls.push(['write', p, o]),
    statSync: () => ({ mode: 0o100644 }),
    chmodSync: (p, m) => calls.push(['chmod', p, m]),
  };
  SecretFile.writeSecretFile('/x/key.pem', 'k', { fs: fake, platform: 'linux' });
  assert.deepStrictEqual(calls, [['write', '/x/key.pem', { mode: 0o600 }], ['chmod', '/x/key.pem', 0o600]]);
  calls.length = 0;
  SecretFile.writeSecretFile('C:\\x\\key.pem', 'k', { fs: fake, platform: 'win32' });
  assert.deepStrictEqual(calls, [['write', 'C:\\x\\key.pem', { mode: 0o600 }]]);
});

test('tightenSecretFile: a 0644 file is chmod 0600; a missing file or a chmod error never throws', () => {
  const calls = [];
  const fake = { statSync: () => ({ mode: 0o100644 }), chmodSync: (p, m) => calls.push([p, m]) };
  assert.strictEqual(SecretFile.tightenSecretFile('/x/k', { fs: fake, platform: 'darwin' }), true);
  assert.deepStrictEqual(calls, [['/x/k', 0o600]]);
  assert.strictEqual(SecretFile.tightenSecretFile('/x/k', { fs: { statSync: () => ({ mode: 0o100600 }), chmodSync: () => { throw new Error('no'); } }, platform: 'linux' }), false, 'already 0600');
  assert.strictEqual(SecretFile.tightenSecretFile('/x/k', { fs: { statSync: () => { throw new Error('ENOENT'); } }, platform: 'linux' }), false);
  assert.strictEqual(SecretFile.tightenSecretFile('/x/k', { fs: { statSync: () => ({ mode: 0o100644 }), chmodSync: () => { throw new Error('EPERM'); } }, platform: 'linux' }), false);
  assert.strictEqual(SecretFile.tightenSecretFile('C:\\x\\k', { fs: { statSync: () => { throw new Error('must not stat'); } }, platform: 'win32' }), false);
});

test('a real file is written 0600 (POSIX) and an existing 0644 file is tightened', () => {
  const d = tmpDir();
  const p = path.join(d, 'key.pem');
  SecretFile.writeSecretFile(p, 'secret');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'secret');
  if (POSIX) {
    assert.strictEqual(mode(p), 0o600);
    fs.chmodSync(p, 0o644);
    SecretFile.writeSecretFile(p, 'again'); // writeFileSync's mode applies only on create
    assert.strictEqual(mode(p), 0o600);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('ECHOCAT self-signed TLS key: written with mode 0600', () => {
  const { getOrCreateTlsCert } = require('../lib/remote-server');
  const d = tmpDir();
  const { result, writes } = spyFs(() => getOrCreateTlsCert(d));
  assert.ok(result && result.key && result.cert, 'a cert was made');
  const key = writes.find((w) => path.basename(w.p) === 'remote-key.pem');
  assert.ok(key, 'the key was written');
  assert.ok(key.opts && key.opts.mode === 0o600, 'mode 0600 passed: ' + JSON.stringify(key.opts));
  if (POSIX) assert.strictEqual(mode(path.join(d, 'remote-key.pem')), 0o600);
  fs.rmSync(d, { recursive: true, force: true });
});

test('ECHOCAT TLS key from an earlier version (0644): chmod 0600 at start', () => {
  const { getOrCreateTlsCert } = require('../lib/remote-server');
  const d = tmpDir();
  getOrCreateTlsCert(d);
  const keyPath = path.join(d, 'remote-key.pem');
  if (POSIX) {
    fs.chmodSync(keyPath, 0o644);
    const { chmods } = spyFs(() => getOrCreateTlsCert(d));
    assert.ok(chmods.some((c) => c.p === keyPath && c.m === 0o600), 'chmod called on the key');
    assert.strictEqual(mode(keyPath), 0o600);
  } else {
    // Windows: stat reports 0o666 for a writable file, so the rule would
    // chmod; run it as Linux would and check the call is made on the key.
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    let chmods;
    try { ({ chmods } = spyFs(() => getOrCreateTlsCert(d))); }
    finally { Object.defineProperty(process, 'platform', real); }
    assert.ok(chmods.some((c) => c.p === keyPath && c.m === 0o600), 'chmod called on the key: ' + JSON.stringify(chmods));
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('Tailscale-issued key: tightened when loaded and after issue', () => {
  const rs = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  assert.ok(/if \(!fs\.existsSync\(certPath\) \|\| !fs\.existsSync\(keyPath\)\) return null;\n  SecretFile\.tightenSecretFile\(keyPath\);/.test(rs), 'loadCachedTailscaleCert');
  assert.ok(/SecretFile\.tightenSecretFile\(keyPath\);\n  return \{ certPath, keyPath \};/.test(rs), 'issueTailscaleCert');
  assert.ok(!/fs\.writeFileSync\(keyPath/.test(rs), 'no plain key write left');
});

test('settings.json (passwords and tokens): written 0600, the backup too', () => {
  const SF = require('../lib/settings-file');
  const d = tmpDir();
  const p = path.join(d, 'settings.json');
  const { writes } = spyFs(() => { SF.writeSettingsFile(p, { a: 1 }, { now: 1 }); SF.writeSettingsFile(p, { a: 2 }, { now: 1 + 2 * 3600000 }); });
  const tmpWrites = writes.filter((w) => w.p === p + '.tmp');
  assert.ok(tmpWrites.length === 2 && tmpWrites.every((w) => w.opts && w.opts.mode === 0o600), JSON.stringify(writes));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 2 });
  if (POSIX) {
    assert.strictEqual(mode(p), 0o600);
    assert.strictEqual(mode(p + '.bak'), 0o600);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('profile settings rewrite (profile-dirs) uses the 0600 writer', () => {
  const src = readSrc(path.join(__dirname, '..', 'lib', 'profile-dirs.js'));
  assert.ok(/if \(dirty\) SecretFile\.writeSecretFile\(sPath, /.test(src));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
