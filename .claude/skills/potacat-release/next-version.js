#!/usr/bin/env node
// The ONE place a POTACAT release version is decided.
//
// Casey's rule (2026-10-21, after 1.12.0 and 1.13.0 both went out as minor
// bumps): every release is the previous release + 0.0.1. Never a minor or
// major bump, never a skipped number, never a number typed by hand.
//
//   node .claude/skills/potacat-release/next-version.js          → prints the plan, changes nothing
//   node .claude/skills/potacat-release/next-version.js --apply  → writes package.json + package-lock.json
//
// Exit codes: 0 ok, 1 refused (the reason is printed), 2 usage.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const apply = process.argv.includes('--apply');
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}
function refuse(msg) { console.error('REFUSED: ' + msg); process.exit(1); }
function cmp(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
function parse(s) { const m = SEMVER.exec(s); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; }

try { git(['fetch', '--tags', '--quiet', 'origin']); } catch { console.error('warning: could not fetch tags from origin; using local tags'); }

// The latest released version = the highest vX.Y.Z tag (by number, not by date).
const tags = git(['tag', '--list', 'v*.*.*']).split(/\r?\n/).map(t => t.trim()).filter(t => parse(t));
if (!tags.length) refuse('no vX.Y.Z tags found');
tags.sort((a, b) => cmp(parse(b), parse(a)));
const last = parse(tags[0]);
const next = [last[0], last[1], last[2] + 1];
const lastS = last.join('.');
const nextS = next.join('.');

const pkgPath = path.join(ROOT, 'package.json');
const lockPath = path.join(ROOT, 'package-lock.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const cur = parse(pkg.version);
if (!cur) refuse(`package.json version "${pkg.version}" is not X.Y.Z`);

// Already bumped to exactly next (a re-run) is fine; anything else is not.
if (cmp(cur, next) > 0) refuse(`package.json is ${pkg.version}, past the next release ${nextS} (last tag ${tags[0]}). Someone bumped it by hand; set it back to ${lastS} and run this again.`);
if (cmp(cur, last) < 0) refuse(`package.json is ${pkg.version}, behind the last tag ${tags[0]}. Check out master and pull before releasing.`);
if (git(['tag', '--list', 'v' + nextS])) refuse(`tag v${nextS} already exists`);

console.log(`last release : v${lastS}`);
console.log(`next release : v${nextS}   (last + 0.0.1, the only allowed step)`);
console.log(`package.json : ${pkg.version}`);

if (!apply) { console.log('dry run — pass --apply to write package.json and package-lock.json'); process.exit(0); }

if (pkg.version !== nextS) {
  // npm keeps package.json and the lockfile's two version fields in step and
  // does not commit or tag (the skill commits explicit paths itself).
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['version', nextS, '--no-git-tag-version'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
}
const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const lockRoot = lock.packages && lock.packages[''] ? lock.packages[''].version : lock.version;
if (after !== nextS || lock.version !== nextS || lockRoot !== nextS) refuse(`after the bump package.json=${after}, lock=${lock.version}/${lockRoot}; expected ${nextS}`);
console.log(`applied      : package.json and package-lock.json are ${nextS}`);
