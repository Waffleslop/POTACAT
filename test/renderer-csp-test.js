#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * A renderer must not declare a script CSP it then violates.
 *
 * `script-src 'self'` (or `default-src 'self'` with no script-src) blocks
 * inline <script>. The window still loads, reports no error anywhere main can
 * see, and simply runs nothing — which from the outside is indistinguishable
 * from a feature that is merely broken.
 *
 * Two real cases:
 *   js8-audio-bridge.html   shipped with an inline block under script-src
 *                           'self'. It enumerated no audio devices and logged
 *                           nothing at all (K3SBP 2026-08-08).
 *   jtcat-map-popout.html   170 lines of inline JS under default-src 'self',
 *                           found by this check while fixing the first.
 *
 * Run: node test/renderer-csp-test.js
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'renderer');
let pass = 0, fail = 0;

/** The effective script policy: script-src if present, else default-src. */
function scriptPolicy(content) {
  const src = content.match(/script-src([^;]*)/i);
  if (src) return src[1];
  const def = content.match(/default-src([^;]*)/i);
  return def ? def[1] : null;      // no policy at all — inline is allowed
}

/** Inline blocks with actual code in them (a <script src=…> is not inline). */
function inlineBlocks(html) {
  return (html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [])
    .filter((b) => b.replace(/<\/?script[^>]*>/gi, '').trim().length > 0);
}

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const html = readSrc(path.join(DIR, file));
  const meta = html.match(/http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']+)["']/i);
  if (!meta) { pass++; continue; }                       // no CSP: nothing to contradict
  const policy = scriptPolicy(meta[1]);
  if (policy === null || /'unsafe-inline'/.test(policy)) { pass++; continue; }
  const blocks = inlineBlocks(html);
  if (blocks.length) {
    fail++;
    console.log(`  FAIL ${file}`);
    console.log(`       ${blocks.length} inline <script> block(s), but the policy is "${policy.trim()}"`);
    console.log('       The window will load and the code will never run. Move it to a .js file.');
  } else {
    pass++;
  }
}

console.log(`\nRenderer CSP: ${pass} clean, ${fail} violating`);
process.exit(fail === 0 ? 0 : 1);
