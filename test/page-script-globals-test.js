'use strict';
/**
 * Every classic <script> on a page shares ONE top-level scope. A name declared
 * with const/let/class in two of them is a SyntaxError that stops the second
 * file from running at all, with nothing on screen.
 *
 * That is how 1.13.5 shipped the AE5JE "follow the audio device by name" fix
 * dead: lib/dx-rule.js and lib/audio-device-heal.js both ended in
 * `const api = ...`, dx-rule loaded first, and the heal module never defined
 * window.AudioDeviceHeal (found 2026-10-26 on WB3EGD's blank Output box).
 *
 * The check reads each page's script tags in order and the declarations that
 * start at column 0 of each file (the files' own top level). A lexical name
 * (const/let/class) may not appear in two files, nor beside a function or var
 * of the same name. Two plain function declarations are allowed: the later one
 * wins, which is legal and some pages rely on.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + e.message); }
}

function topLevelNames(src) {
  const out = [];
  const re = /^(?:export\s+)?(const|let|var|class|(?:async\s+)?function\*?)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) {
    const kind = /function/.test(m[1]) ? 'function' : m[1];
    out.push({ kind, name: m[2] });
  }
  // `const { a, b } = ...` at the top level
  const destr = /^(?:const|let)\s*\{([^}]*)\}\s*=/gm;
  while ((m = destr.exec(src))) {
    for (const part of m[1].split(',')) {
      const nm = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) out.push({ kind: 'const', name: nm });
    }
  }
  return out;
}

function classicScripts(html, htmlPath) {
  const list = [];
  const re = /<script\b([^>]*)\bsrc="([^"]+)"[^>]*>\s*<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (/type\s*=\s*["']module["']/.test(m[1])) continue;
    const src = m[2];
    if (/^(https?:)?\/\//.test(src)) continue;
    const file = path.resolve(path.dirname(htmlPath), src.split('?')[0]);
    if (fs.existsSync(file)) list.push(file);
  }
  return list;
}

const pages = fs.readdirSync(RENDERER).filter((f) => f.endsWith('.html'));
for (const page of pages) {
  const htmlPath = path.join(RENDERER, page);
  const scripts = classicScripts(fs.readFileSync(htmlPath, 'utf8'), htmlPath);
  if (scripts.length < 2) continue;
  check(`${page}: no top-level name is declared twice across its ${scripts.length} scripts`, () => {
    const seen = new Map(); // name -> {kind, file}
    const clashes = [];
    for (const file of scripts) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const mine = new Set();
      for (const d of topLevelNames(fs.readFileSync(file, 'utf8'))) {
        if (mine.has(d.name)) continue; // a file's own duplicates are its own parse error
        mine.add(d.name);
        const prev = seen.get(d.name);
        if (prev && prev.file !== rel) {
          const lexical = (k) => k === 'const' || k === 'let' || k === 'class';
          if (lexical(d.kind) || lexical(prev.kind)) clashes.push(`${d.name}: ${prev.kind} in ${prev.file}, ${d.kind} in ${rel}`);
        }
        if (!prev || d.kind !== 'function') seen.set(d.name, { kind: d.kind, file: rel });
      }
    }
    assert.deepStrictEqual(clashes, [], 'a second declaration stops that file from loading');
  });
}

check('the two files that collided keep their own export names', () => {
  for (const f of ['lib/dx-rule.js', 'lib/audio-device-heal.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/^const api\b/m.test(src), f + ' must not declare a top-level `api`');
  }
  assert.strictEqual(typeof require('../lib/audio-device-heal').healRigAudioDevices, 'function');
  assert.strictEqual(typeof require('../lib/dx-rule').isDx, 'function');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
