#!/usr/bin/env node
'use strict';
// Points git at scripts/git-hooks (the pre-push hook runs the whole test suite
// before every push). Run once per clone: `node scripts/install-hooks.js`.
// The path is relative, so git looks in the scripts/git-hooks of whichever
// checkout or worktree is pushing; one setting covers every worktree of the clone.
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

git(['config', 'core.hooksPath', 'scripts/git-hooks']);
console.log(`[install-hooks] core.hooksPath = ${git(['config', 'core.hooksPath'])} (${git(['rev-parse', '--show-toplevel'])})`);
console.log('[install-hooks] pre-push now runs node scripts/run-tests.js; POTACAT_SKIP_PREPUSH=1 skips it, for emergencies only');
