'use strict';
// Every source file must parse. The rest of the suite reads main.js as TEXT
// (source guards), so a syntax error there passed all 250 tests and showed up
// only as the "JavaScript error in the main process" dialog at launch
// (48c62d8e, an apostrophe inside a single-quoted log line).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const root = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.git', 'ft8_lib', 'third_party', 'assets', 'fixtures']);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) walk(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith('.js')) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

const files = [
  ...fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => path.join(root, f)),
  ...walk(path.join(root, 'lib'), []),
  ...walk(path.join(root, 'renderer'), []),
];

let failed = 0, checked = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (/^\s*(import|export)\s[^(]/m.test(src)) continue; // ES modules: not CommonJS or page scripts
  try {
    new vm.Script(Module.wrap(src.replace(/^#!.*/, '')), { filename: file });
    checked++;
  } catch (e) {
    failed++;
    console.log(`  FAIL ${path.relative(root, file)}: ${e.message}`);
  }
}
console.log(`syntax check: ${checked} files parsed, ${failed} failed`);
if (failed) process.exit(1);
