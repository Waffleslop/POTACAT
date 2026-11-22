// Winlink forms need Pat 1.0.1 or newer (#346 phase 0).
//
// Pat v1.0.0 serves a form's HTML (/api/forms) same-origin with its own
// unauthenticated API, so a form page could connect, send or delete mail
// through Pat. v1.0.1 sends those pages with a CSP sandbox (null origin).
// POTACAT offers or serves forms only when the running Pat says it is 1.0.1
// or newer; anything it cannot read counts as "no forms".
// Run: node test/winlink-forms-gate-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../lib/winlink-forms');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('Winlink forms: Pat 1.0.1 or newer');

test('the floor is 1.0.1', () => {
  assert.strictEqual(F.FORMS_MIN_PAT, '1.0.1');
});

test('reads `pat version` output', () => {
  // cli/version.go: "<AppName> v<Version> (<GitRev>) <os>/<arch> - <go version>"
  const v = F.parsePatVersion('Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3\n');
  assert.deepStrictEqual(v, { major: 1, minor: 0, patch: 1, pre: '', text: '1.0.1' });
  assert.deepStrictEqual(F.parsePatVersion('Pat v1.0.0 (2e6a8d1) linux/arm64 - go1.24.9'), { major: 1, minor: 0, patch: 0, pre: '', text: '1.0.0' });
  assert.deepStrictEqual(F.parsePatVersion('Pat v0.16.0 (abc1234) darwin/amd64 - go1.21'), { major: 0, minor: 16, patch: 0, pre: '', text: '0.16.0' });
});

test('reads a bare version, a leading v and a pre-release tag', () => {
  assert.deepStrictEqual(F.parsePatVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: '', text: '1.2.3' });
  assert.deepStrictEqual(F.parsePatVersion('v1.0.1'), { major: 1, minor: 0, patch: 1, pre: '', text: '1.0.1' });
  assert.deepStrictEqual(F.parsePatVersion('Pat v1.0.2-rc1 (deadbee) windows/amd64 - go1.26'), { major: 1, minor: 0, patch: 2, pre: 'rc1', text: '1.0.2-rc1' });
});

test('anything else is no version', () => {
  for (const t of [undefined, null, '', '   ', 'Pat', 'Pat vX.Y.Z', 'go1.26.0', 'windows/amd64 - go1.26.3', 42, {}, 'Pat v1.0 (abc)']) {
    assert.strictEqual(F.parsePatVersion(t), null, JSON.stringify(t));
  }
});

test('the Go version in the same line is never taken for Pat\'s', () => {
  // A Pat whose own version is missing must not pass on "go1.26.3".
  assert.strictEqual(F.parsePatVersion('Pat (2ad31e8) windows/amd64 - go1.26.3'), null);
});

test('forms: 1.0.1 and newer yes, 1.0.0 and older no', () => {
  const yes = ['Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3', 'Pat v1.0.2 (x) linux/amd64 - go1.26', 'Pat v1.1.0 (x) a/b - go', 'Pat v2.0.0 (x) a/b - go', '1.0.10'];
  for (const t of yes) {
    const g = F.formsAllowed(t);
    assert.strictEqual(g.ok, true, t);
    assert.strictEqual(g.why, '', t);
  }
  const no = ['Pat v1.0.0 (2e6a8d1) windows/amd64 - go1.24.9', 'Pat v0.16.0 (x) a/b - go', 'Pat v0.99.99 (x) a/b - go', '1.0.1-rc1', '1.0.1-dev'];
  for (const t of no) {
    const g = F.formsAllowed(t);
    assert.strictEqual(g.ok, false, t);
    assert.ok(/1\.0\.1 or newer/.test(g.why), t + ': ' + g.why);
    assert.ok(g.why.includes(F.parsePatVersion(t).text), 'the sentence names the Pat it found: ' + g.why);
  }
});

test('forms: a Pat that does not say its version gets no forms', () => {
  for (const t of [undefined, null, '', 'garbage', 'Pat (abc) - go1.26.3']) {
    const g = F.formsAllowed(t);
    assert.strictEqual(g.ok, false, String(t));
    assert.strictEqual(g.version, '', String(t));
    assert.ok(/could not tell/i.test(g.why) && /1\.0\.1 or newer/.test(g.why), g.why);
  }
});

test('the result says the version it read', () => {
  assert.strictEqual(F.formsAllowed('Pat v1.0.1 (2ad31e8) windows/amd64 - go1.26.3').version, '1.0.1');
  assert.strictEqual(F.formsAllowed('Pat v1.0.0 (2e6a8d1) windows/amd64 - go1.24.9').version, '1.0.0');
});

test('comparePatVersions orders like SemVer (pre-release below its release)', () => {
  const c = (a, b) => F.comparePatVersions(F.parsePatVersion(a), F.parsePatVersion(b));
  assert.strictEqual(c('1.0.1', '1.0.1'), 0);
  assert.ok(c('1.0.0', '1.0.1') < 0);
  assert.ok(c('1.0.10', '1.0.9') > 0);
  assert.ok(c('1.1.0', '1.0.99') > 0);
  assert.ok(c('2.0.0', '1.99.99') > 0);
  assert.ok(c('1.0.1-rc1', '1.0.1') < 0);
  assert.ok(c('1.0.1', '1.0.1-rc1') > 0);
});

test('the bundled Pat is pinned at 1.0.1 or newer, and so is the floor the build ships', () => {
  const root = path.join(__dirname, '..');
  const sh = fs.readFileSync(path.join(root, 'scripts/build-winlink-helpers.sh'), 'utf8');
  const tag = (sh.match(/^PAT_TAG=(\S+)$/m) || [])[1];
  assert.ok(tag, 'PAT_TAG in the build script');
  assert.strictEqual(F.formsAllowed(tag).ok, true, `the bundled Pat (${tag}) must be one forms may run on`);
  const ver = fs.readFileSync(path.join(root, 'third_party/pat/VERSION.txt'), 'utf8');
  assert.ok(ver.startsWith(`la5nta/pat ${tag}\n`), 'VERSION.txt names the same tag');
  const sha = (sh.match(/^PAT_SHA=([0-9a-f]{40})$/m) || [])[1];
  assert.ok(sha && ver.includes(`commit ${sha}\n`), 'VERSION.txt names the same commit');
});

test('every CI job that builds Pat uses Go 1.26', () => {
  const root = path.join(__dirname, '..');
  for (const wf of ['.github/workflows/release.yml', '.github/workflows/winlink-helpers.yml']) {
    const y = fs.readFileSync(path.join(root, wf), 'utf8');
    const pins = [...y.matchAll(/go-version:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(pins.length > 0, wf + ' sets up Go');
    for (const p of pins) assert.strictEqual(p, '1.26', `${wf}: go-version ${p}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
