#!/usr/bin/env node
'use strict';
// The release workflow's update-website job pushes potacat-website index.html
// to master, which deploys to production. It may push only version strings in
// the DOWNLOAD block and the intel-mac hero link (Casey, 2026-11-22); anything
// else fails the job and becomes a website handoff on a branch.
// Run: node test/website-links-guard-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readSrc } = require('./_src');
const { checkVersionOnlyDiff, updateDownloadVersions, formatOffending } = require('../scripts/website-links-guard');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const ROOT = path.join(__dirname, '..');
const FIXTURE = readSrc(path.join(__dirname, 'fixtures', 'website-index-download.html'));
const UPDATE_SCRIPT = path.join(ROOT, 'scripts', 'update-website-links.js');
const GUARD_SCRIPT = path.join(ROOT, 'scripts', 'website-links-guard.js');

// The live page, when this machine has the website checkout (read-only).
function livePage() {
  for (const dir of [path.join(ROOT, '..', 'website'), path.join(ROOT, '..', '..', 'website'), 'D:/Projects/potacat/website']) {
    try {
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      return execFileSync('git', ['-C', dir, 'show', 'origin/master:index.html'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { /* not here */ }
  }
  return null;
}

const bump = (html, from, to) => html.split(from).join(to);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-website-guard-'));
function runUpdate(html, version) {
  const p = path.join(tmp, 'index-' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(p, html, 'utf8');
  execFileSync(process.execPath, [UPDATE_SCRIPT, version, p], { stdio: 'ignore' });
  return fs.readFileSync(p, 'utf8');
}

console.log('website links guard');

test('a pure version bump of the fixture passes', () => {
  const r = checkVersionOnlyDiff(FIXTURE, bump(FIXTURE, '1.14.7', '1.14.8'), { version: '1.14.8' });
  assert.ok(r.ok, formatOffending(r));
  assert.strictEqual(r.linksOld, r.linksNew);
  assert.ok(r.linksOld >= 15, 'the fixture block carries the download links: ' + r.linksOld);
});

const live = livePage();
test('a pure version bump of the live index.html passes (skips without the website checkout)', () => {
  if (!live) { console.log('       (no website checkout here, skipped)'); return; }
  const v = (live.match(/\/releases\/download\/v(\d+\.\d+\.\d+)\//) || [])[1];
  assert.ok(v, 'live page has a release link');
  const r = checkVersionOnlyDiff(live, bump(live, v, '9.9.9'), { version: '9.9.9' });
  assert.ok(r.ok, formatOffending(r));
});

test('an extra line inside the block fails and is listed', () => {
  const changed = FIXTURE.replace('<div class="dl-sub">64-bit installer &middot; Windows 10+</div>',
    '<div class="dl-sub">64-bit installer &middot; Windows 10+</div>\n      <div class="dl-sub">Now with more cats</div>');
  const r = checkVersionOnlyDiff(FIXTURE, changed, { version: '1.14.7' });
  assert.ok(!r.ok);
  assert.ok(r.offending.some((o) => o.kind === 'structure' && /inside the DOWNLOAD block/.test(o.detail)), formatOffending(r));
  assert.ok(r.offending.some((o) => o.kind === 'added' && /more cats/.test(o.new)), formatOffending(r));
});

test('a changed line inside the block (not a version) fails', () => {
  const changed = bump(FIXTURE, '1.14.7', '1.14.8').replace('Ready to Chase Some Parks?', 'Ready to Chase Parks?');
  const r = checkVersionOnlyDiff(FIXTURE, changed, { version: '1.14.8' });
  assert.ok(!r.ok);
  assert.ok(r.offending.some((o) => o.kind === 'structure' && /Ready to Chase Parks/.test(o.new)), formatOffending(r));
});

test('a change outside the block fails, even a version string', () => {
  const changed = bump(FIXTURE, '1.14.7', '1.14.8').replace('POTACAT 1.0.0 shipped', 'POTACAT 1.14.8 shipped');
  const r = checkVersionOnlyDiff(FIXTURE, changed, { version: '1.14.8' });
  assert.ok(!r.ok);
  assert.ok(r.offending.some((o) => o.kind === 'outside' && /1\.0\.0 shipped/.test(o.old)), formatOffending(r));
});

test('a changed link count fails', () => {
  const changed = FIXTURE.replace('<a href="#build-from-source">Build from source</a>', 'Build from source');
  const r = checkVersionOnlyDiff(FIXTURE, changed, { version: '1.14.7' });
  assert.ok(!r.ok);
  assert.ok(r.offending.some((o) => o.kind === 'link-count'), formatOffending(r));
});

test('a version other than the release fails', () => {
  const r = checkVersionOnlyDiff(FIXTURE, bump(FIXTURE, '1.14.7', '1.14.9'), { version: '1.14.8' });
  assert.ok(!r.ok);
  assert.ok(r.offending.some((o) => o.kind === 'version'), formatOffending(r));
});

test('a missing block fails', () => {
  const r = checkVersionOnlyDiff(FIXTURE, FIXTURE.replace('<!-- DOWNLOAD-END -->', '<!-- END -->'), { version: '1.14.7' });
  assert.ok(!r.ok);
});

test('update-website-links.js output passes the guard on the fixture', () => {
  const out = runUpdate(FIXTURE, '1.14.8');
  const r = checkVersionOnlyDiff(FIXTURE, out, { version: '1.14.8' });
  assert.ok(r.ok, formatOffending(r));
  assert.ok(out.includes('/releases/download/v1.14.8/POTACAT-Setup-1.14.8.exe'));
  assert.ok(out.includes('/releases/tag/v1.14.8'));
  assert.ok(out.includes("'download_version':'1.14.8'"));
  assert.ok(!/1\.14\.7/.test(out), 'no old version left');
});

test('update-website-links.js keeps the website session\'s own edits to the block', () => {
  const edited = FIXTURE.replace('Ready to Chase Some Parks?', 'Ready to Hunt Some Parks?')
    .replace('<div class="dl-sub">ARM64 / aarch64 &middot; Raspberry Pi 4/5, SBCs</div>',
      '<div class="dl-sub">ARM64 / aarch64 &middot; Raspberry Pi 4/5, SBCs</div>\n      <div class="dl-sub">Chromebook: use the .deb</div>');
  const out = runUpdate(edited, '1.14.8');
  const r = checkVersionOnlyDiff(edited, out, { version: '1.14.8' });
  assert.ok(r.ok, formatOffending(r));
  assert.ok(out.includes('Ready to Hunt Some Parks?') && out.includes('Chromebook: use the .deb'));
});

test('update-website-links.js brings a stale hero intel-mac link along', () => {
  const stale = FIXTURE.replace('v1.14.7/POTACAT-1.14.7.dmg" data-ga="hero_download_mac_intel"', 'v1.12.0/POTACAT-1.12.0.dmg" data-ga="hero_download_mac_intel"');
  const out = runUpdate(stale, '1.14.8');
  assert.ok(out.includes('<a class="intel-mac" href="https://github.com/Waffleslop/POTACAT/releases/download/v1.14.8/POTACAT-1.14.8.dmg"'));
  const r = checkVersionOnlyDiff(stale, out, { version: '1.14.8' });
  assert.ok(r.ok, formatOffending(r));
});

test('update-website-links.js output passes on the live index.html (skips without the website checkout)', () => {
  if (!live) { console.log('       (no website checkout here, skipped)'); return; }
  const out = runUpdate(live, '9.9.9');
  const r = checkVersionOnlyDiff(live, out, { version: '9.9.9' });
  assert.ok(r.ok, formatOffending(r));
});

test('updateDownloadVersions refuses a page without the markers', () => {
  assert.throws(() => updateDownloadVersions('<html></html>', '1.14.8'), /markers not found/);
  assert.throws(() => updateDownloadVersions(FIXTURE, 'latest'), /X\.Y\.Z/);
});

test('the guard CLI exits 1 and writes the report on a fail, 0 on a pass', () => {
  const a = path.join(tmp, 'old.html'), b = path.join(tmp, 'new.html'), rep = path.join(tmp, 'report.md');
  fs.writeFileSync(a, FIXTURE);
  fs.writeFileSync(b, bump(FIXTURE, '1.14.7', '1.14.8'));
  execFileSync(process.execPath, [GUARD_SCRIPT, a, b, '1.14.8'], { stdio: 'ignore' });
  fs.writeFileSync(b, FIXTURE.replace('Ready to Chase Some Parks?', 'Buy now'));
  let code = 0;
  try { execFileSync(process.execPath, [GUARD_SCRIPT, a, b, '1.14.8', '--report', rep], { stdio: 'ignore' }); }
  catch (e) { code = e.status; }
  assert.strictEqual(code, 1);
  assert.ok(/Buy now/.test(fs.readFileSync(rep, 'utf8')));
});

// ---- the workflow ----
const WF = readSrc(path.join(ROOT, '.github', 'workflows', 'release.yml'));
const job = (name) => {
  const m = WF.match(new RegExp('\\n  ' + name + ':\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)'));
  return m ? m[1] : '';
};

test('workflow: update-website saves the original, runs the guard, and pushes master only on a pass', () => {
  const j = job('update-website');
  assert.ok(j, 'update-website job exists');
  const iUpd = j.indexOf('scripts/update-website-links.js');
  const iGuard = j.indexOf('scripts/website-links-guard.js');
  const iOrig = j.indexOf('index.html.orig');
  assert.ok(iOrig >= 0 && iOrig < iUpd, 'the original index.html is kept before the update');
  assert.ok(iGuard > iUpd, 'the guard runs after the update');
  const push = j.match(/- name: Commit and push[\s\S]*?(?=\n      - name:|$)/);
  assert.ok(push, 'Commit and push step exists');
  assert.ok(/if: .*steps\.guard\.outputs\.ok == 'true'/.test(push[0]), 'master push is gated on the guard: ' + push[0].slice(0, 200));
  assert.ok(/git add index\.html/.test(push[0]) && /git push origin HEAD:master|git push\b/.test(push[0]));
});

test('workflow: a failed guard writes the handoff on a release-links branch, never master, and fails the job', () => {
  const j = job('update-website');
  const failStep = j.match(/- name: Website handoff[\s\S]*?(?=\n      - name:|$)/);
  assert.ok(failStep, 'handoff step exists');
  const s = failStep[0];
  assert.ok(/if: .*steps\.guard\.outputs\.ok != 'true'/.test(s), 'runs only when the guard failed');
  assert.ok(/docs\/handoffs\/DESKTOP_TO_WEBSITE_HANDOFF_\$\{?DATE\}?_RELEASE_\$\{?VERSION\}?_LINKS\.md/.test(s), 'handoff file name');
  assert.ok(/release-links\/\$\{?VERSION\}?/.test(s), 'release-links/<version> branch');
  assert.ok(/git checkout -- index\.html|git restore index\.html/.test(s), 'the rewritten index.html is dropped');
  assert.ok(/git add "?\$HANDOFF"?/.test(s), 'only the handoff is staged');
  assert.ok(!/git push[^\n]*master/.test(s), 'never pushes master');
  assert.ok(/GITHUB_STEP_SUMMARY/.test(s), 'summary written');
  const up = j.match(/- name: Upload the website handoff[\s\S]*?(?=\n      - name:|$)/);
  assert.ok(up && /if: always\(\) && steps\.guard\.outputs\.ok != 'true'/.test(up[0]) && /upload-artifact/.test(up[0]), 'the handoff is also uploaded as an artifact, even if the push step broke');
  const end = j.match(/- name: Fail the job[\s\S]*?(?=\n      - name:|$)/);
  assert.ok(end && /if: always\(\) && steps\.guard\.outputs\.ok != 'true'/.test(end[0]) && /exit 1/.test(end[0]), 'the job fails with a message');
  assert.ok(/release is published/.test(end[0]), 'the message says the release itself is fine');
});

test('workflow: permissions are per job; only create-release gets contents: write', () => {
  const top = WF.split('\njobs:')[0];
  assert.ok(/\npermissions:\n  contents: read\b/.test(top), 'workflow default is contents: read');
  assert.ok(/permissions:\n      contents: write/.test(job('create-release')), 'create-release can still create the release');
  for (const name of ['update-website', 'build-windows', 'build-macos-arm64', 'build-macos-x64', 'build-linux', 'build-linux-arm64']) {
    assert.ok(!/contents: write/.test(job(name)), name + ' has no write');
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
