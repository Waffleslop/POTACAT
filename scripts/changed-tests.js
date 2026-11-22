'use strict';
// `node scripts/run-tests.js --changed [base]`: pick the tests worth running for
// what changed. A quick filter while working, never a replacement for the full
// run (the pre-push hook and CI run everything).
//
// Picked:
//  - every test whose source mentions a changed file: its path without the
//    extension ('lib/aprs-rf-gate'), its file name ('aprs-rf-gate.js'), or its
//    bare name when that is long enough to be distinctive ('aprs-rf-gate');
//  - main.js is mentioned by most tests, so for main.js a test must mention
//    'main.js' AND either the name of a function a changed line sits in, or a
//    quoted string (6+ characters) from a changed line, as whole tokens; a term
//    more than MAX_TERM_HITS main.js tests mention narrows nothing and is dropped;
//  - the changed test files themselves;
//  - this runner's own checks (and only those for a change to scripts/run-tests.js:
//    most tests mention it only to check that they are listed).
// The pure parts are exported for test/run-tests-changed-test.js.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RUNNER_CHECKS = ['test/run-tests-runner-test.js', 'test/run-tests-changed-test.js'];
const SOURCE_EXT = /\.(js|cjs|mjs|ts|json|html|css|c|cc|cpp|h)$/i;
// Function names too common to narrow anything.
const NOISE = new Set(['function', 'return', 'async', 'await', 'handler', 'callback', 'done', 'next', 'resolve', 'reject', 'init', 'start', 'stop', 'send', 'close', 'open', 'push', 'emit', 'then', 'catch']);

// A main.js term mentioned by more tests than this is too common to narrow.
const MAX_TERM_HITS = 25;

// x appears in src as a whole token (so 'refuse' does not match 'refused').
function mentions(src, x) {
  let i = src.indexOf(x);
  const edge = /[\w$]/;
  while (i >= 0) {
    const before = src[i - 1], after = src[i + x.length];
    const okB = !edge.test(x[0]) || !before || !edge.test(before);
    const okA = !edge.test(x[x.length - 1]) || !after || !edge.test(after);
    if (okB && okA) return true;
    i = src.indexOf(x, i + 1);
  }
  return false;
}

const DECLS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:static\s+)?(?:async\s+)?(?!(?:if|for|while|switch|catch|function|return|with)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
  // IPC and event handlers: the channel name stands in for a function name.
  /\.(?:handle|on|once)\(\s*['"]([^'"]{4,})['"]/,
];

function indentOf(line) {
  const m = /^[ \t]*/.exec(line);
  return m[0].replace(/\t/g, '  ').length;
}

function declName(line) {
  for (const re of DECLS) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

// The name of the function (or handler) that line index i sits in, or null.
function enclosingFunction(lines, i, maxScan = 4000) {
  if (i < 0 || i >= lines.length) return null;
  let k = i;
  while (k > 0 && !lines[k].trim()) k--;
  const own = declName(lines[k]);
  if (own) return own;
  let ind = indentOf(lines[k]);
  for (let j = k - 1; j >= 0 && j >= k - maxScan; j--) {
    const l = lines[j];
    if (!l.trim()) continue;
    const li = indentOf(l);
    if (li >= ind) continue;
    const name = declName(l);
    if (name) return name;
    ind = li;
    if (ind === 0) return null;
  }
  return null;
}

// Parses `git diff -U0` output for one file: the changed line numbers on each
// side and the text of every added or removed line.
function parseHunks(diff) {
  const oldLines = [], newLines = [], text = [], headers = [];
  for (const line of diff.split(/\r?\n/)) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (h) {
      const a = +h[1], b = h[2] === undefined ? 1 : +h[2];
      const c = +h[3], d = h[4] === undefined ? 1 : +h[4];
      for (let x = 0; x < b; x++) oldLines.push(a + x);
      for (let x = 0; x < d; x++) newLines.push(c + x);
      if (d === 0) newLines.push(Math.max(1, c));
      if (h[5].trim()) headers.push(h[5].trim());
      continue;
    }
    if (/^[+-](?![+-]{2} )/.test(line)) text.push(line.slice(1));
  }
  return { oldLines, newLines, text, headers };
}

// Quoted string literals of 6+ characters (no template holes) on the given lines.
function stringLiterals(lines) {
  const out = new Set();
  const re = /'((?:[^'\\\n]|\\.){6,})'|"((?:[^"\\\n]|\\.){6,})"|`([^`$\\\n]{6,})`/g;
  for (const l of lines) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(l))) {
      const s = m[1] || m[2] || m[3];
      if (s && s.trim().length >= 6) out.add(s);
    }
  }
  return out;
}

// The strings that make a test "mention" a changed file (not main.js).
function fileKeys(file) {
  const noExt = file.replace(/\.[^./]+$/, '');
  const base = path.posix.basename(file);
  const bare = path.posix.basename(noExt);
  const keys = new Set([noExt, base]);
  if (bare.length >= 6) keys.add(bare);
  return [...keys];
}

// The pure picker. changes: [{ file, functions:Set, strings:Set }]; sources: Map(test -> text).
// Returns Map(test -> reason).
function pick({ tests, sources, changes, skipped }) {
  const picked = new Map();
  const add = (t, why) => { if (!picked.has(t)) picked.set(t, why); };
  const inList = new Set(tests);
  for (const t of RUNNER_CHECKS) if (inList.has(t)) add(t, "the runner's own check");
  for (const ch of changes) if (inList.has(ch.file)) add(ch.file, 'the test file changed');
  for (const ch of changes) {
    // Most tests check that they are listed in the runner; editing the list
    // (every new test does) only needs the runner's own checks, added above.
    if (ch.file === 'scripts/run-tests.js') continue;
    if (ch.file === 'main.js') {
      const readers = tests.filter((t) => !picked.has(t) && (sources.get(t) || '').includes('main.js'));
      // A term most main.js tests mention ('window', 'device', 'connected')
      // narrows nothing; it is dropped (and reported) instead of picking them all.
      const distinct = (terms) => terms.filter((x) => {
        const hits = readers.filter((t) => mentions(sources.get(t), x)).length;
        if (hits > MAX_TERM_HITS) { if (skipped) skipped.push(`${x} (${hits} tests)`); return false; }
        return true;
      });
      const names = distinct([...(ch.functions || [])].filter((n) => n.length >= 4 && !NOISE.has(n)));
      const strs = distinct([...(ch.strings || [])]);
      for (const t of readers) {
        if (picked.has(t)) continue;
        const src = sources.get(t);
        const n = names.find((x) => mentions(src, x));
        if (n) { add(t, `main.js, mentions changed function ${n}`); continue; }
        const s = strs.find((x) => mentions(src, x));
        if (s) add(t, `main.js, mentions changed-line string '${s.length > 40 ? s.slice(0, 40) + '...' : s}'`);
      }
      continue;
    }
    const keys = fileKeys(ch.file);
    for (const t of tests) {
      if (picked.has(t) || t === ch.file) continue;
      const src = sources.get(t);
      if (!src) continue;
      const k = keys.find((x) => src.includes(x));
      if (k) add(t, `mentions ${k}`);
    }
  }
  return picked;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Git glue: changed files vs merge-base plus the working tree, with function
// names and changed-line strings for main.js. Prints one line per pick.
function pickChangedTests({ root, tests, base = 'origin/master', log = console.log }) {
  let mb;
  try { mb = git(root, ['merge-base', 'HEAD', base]).trim(); }
  catch (e) { throw new Error(`[run-tests] --changed: no merge-base with ${base} (git fetch first?)`); }
  const files = new Set();
  for (const l of git(root, ['diff', '--name-only', mb]).split(/\r?\n/)) if (l.trim()) files.add(l.trim());
  for (const l of git(root, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/)) if (l.trim()) files.add(l.trim());
  const changes = [];
  for (const file of files) {
    if (!SOURCE_EXT.test(file)) continue;
    const ch = { file };
    if (file === 'main.js') {
      const h = parseHunks(git(root, ['diff', '-U0', mb, '--', file]));
      const nowLines = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/) : [];
      let oldLines = [];
      try { oldLines = git(root, ['show', `${mb}:${file}`]).split(/\r?\n/); } catch (_) { /* new file */ }
      const fns = new Set();
      for (const n of h.newLines) { const f = enclosingFunction(nowLines, n - 1); if (f) fns.add(f); }
      for (const n of h.oldLines) { const f = enclosingFunction(oldLines, n - 1); if (f) fns.add(f); }
      for (const hd of h.headers) { const f = declName(hd); if (f) fns.add(f); }
      ch.functions = fns;
      ch.strings = stringLiterals(h.text);
      log(`[run-tests] --changed: main.js functions: ${[...fns].join(', ') || '(none found)'}; ${ch.strings.size} changed-line string(s)`);
    }
    changes.push(ch);
  }
  log(`[run-tests] --changed: ${changes.length} changed source file(s) since ${mb.slice(0, 8)} (${base}) plus the working tree`);
  const listed = new Set(tests);
  for (const ch of changes) {
    if (/^test\/.*\.js$/.test(ch.file) && /-test\.js$|\.test\.js$/.test(ch.file) && !listed.has(ch.file) && fs.existsSync(path.join(root, ch.file))) {
      log(`[run-tests] --changed: WARNING ${ch.file} is not in the TESTS list in scripts/run-tests.js; CI will not run it`);
    }
  }
  const sources = new Map();
  for (const t of tests) {
    try { sources.set(t, fs.readFileSync(path.join(root, t), 'utf8')); } catch (_) { /* listed but missing: the full run reports it */ }
  }
  const skipped = [];
  const picked = pick({ tests, sources, changes, skipped });
  if (skipped.length) log(`[run-tests] --changed: main.js terms too common to narrow, ignored: ${skipped.join(', ')}`);
  for (const t of tests) if (picked.has(t)) log(`[run-tests]   ${t}  (${picked.get(t)})`);
  return new Set(picked.keys());
}

module.exports = { pick, mentions, MAX_TERM_HITS, pickChangedTests, parseHunks, enclosingFunction, declName, stringLiterals, fileKeys, RUNNER_CHECKS };
