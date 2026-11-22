#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * A renderer must not declare a script CSP it then violates.
 *
 * `script-src 'self'` (or `default-src 'self'` with no script-src) blocks
 * inline <script>, inline event-handler attributes (onclick=, onerror=, ...)
 * and javascript: URLs. The window still loads, reports no error anywhere main
 * can see, and simply runs nothing, which from the outside is
 * indistinguishable from a feature that is merely broken.
 *
 * Real cases:
 *   js8-audio-bridge.html   shipped with an inline block under script-src
 *                           'self'. It enumerated no audio devices and logged
 *                           nothing at all (K3SBP 2026-08-08).
 *   jtcat-map-popout.html   170 lines of inline JS under default-src 'self',
 *                           found by this check while fixing the first.
 *   index.html              the KiwiSDR and WebSDR.org directory links in
 *                           Settings > Station > WebSDR were
 *                           <a href="#" onclick="window.api.openExternal(..)">.
 *                           The click did nothing on every OS (#446). A link
 *                           to the browser is <a href="..." data-external>.
 *
 * Checked for every page whose effective policy lacks 'unsafe-inline':
 *   1. no inline <script> block with code in it;
 *   2. no inline event-handler attribute in the page's markup, nor in a markup
 *      string inside a local script the page loads (renderer/ and lib/ files
 *      named by its <script src>, not node_modules);
 *   3. no javascript: URL in either.
 * ECHOCAT Web (remote.html) is served by lib/remote-server.js: a CSP header it
 * sends counts as that page's policy.
 *
 * Run: node test/renderer-csp-test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'renderer');
let pass = 0, fail = 0;

function directive(policy, name) {
  const m = policy.match(new RegExp('(?:^|;)\\s*' + name + '(?:\\s([^;]*))?(?:;|$)', 'i'));
  return m ? (m[1] || '') : null;
}

/** The effective policy for inline <script>: script-src-elem, script-src, default-src. */
function scriptPolicy(policy) {
  for (const d of ['script-src-elem', 'script-src', 'default-src']) {
    const v = directive(policy, d);
    if (v !== null) return v;
  }
  return null;                      // no script policy at all: inline is allowed
}

/** The effective policy for handler attributes: script-src-attr, script-src, default-src. */
function attrPolicy(policy) {
  for (const d of ['script-src-attr', 'script-src', 'default-src']) {
    const v = directive(policy, d);
    if (v !== null) return v;
  }
  return null;
}

const allowsInline = (p) => p === null || /'unsafe-inline'/.test(p);

/** Inline blocks with actual code in them (a <script src=…> is not inline). */
function inlineBlocks(html) {
  return (html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [])
    .filter((b) => b.replace(/<\/?script[^>]*>/gi, '').trim().length > 0);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// An on*= attribute inside a tag: `<a href="#" onclick="...">`, `<img onerror=x>`.
const HANDLER_IN_TAG = /<[a-z][a-z0-9-]*\b[^<>]*?\s(on[a-z]+)\s*=/gi;
// A javascript: URL as an attribute value (markup) or a quoted string (script).
const JS_URL = /(?:=\s*["']?|["'`])\s*javascript:/gi;

/** Every inline-handler attribute and javascript: URL in `text`. */
function inlineCode(text) {
  const hits = [];
  for (const m of text.matchAll(HANDLER_IN_TAG)) hits.push({ line: lineOf(text, m.index), what: m[1] + '=' });
  for (const m of text.matchAll(JS_URL)) hits.push({ line: lineOf(text, m.index), what: 'javascript: URL' });
  return hits;
}

/** Local scripts a page loads: <script src="x.js">, renderer-relative. */
function localScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const src = m[1].split(/[?#]/)[0];
    if (/^[a-z]+:/i.test(src) || src.startsWith('//')) continue;
    const p = path.join(DIR, src);
    if (/[\\/]node_modules[\\/]/.test(p)) continue;      // vendored libraries are not ours to scan
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

function checkPage(file, html, policy, source) {
  const problems = [];
  const sp = scriptPolicy(policy);
  if (!allowsInline(sp)) {
    const blocks = inlineBlocks(html);
    if (blocks.length) problems.push(`${blocks.length} inline <script> block(s) under "${sp.trim()}". Move the code to a .js file.`);
  }
  const ap = attrPolicy(policy);
  if (!allowsInline(ap)) {
    // Markup only: inline <script> bodies are judged above, and their own
    // strings are scanned like any script file.
    for (const h of inlineCode(html)) problems.push(`${file}:${h.line} ${h.what} is blocked by "${ap.trim()}"`);
    for (const js of localScripts(html)) {
      const rel = path.relative(ROOT, js).replace(/\\/g, '/');
      for (const h of inlineCode(readSrc(js))) problems.push(`${rel}:${h.line} ${h.what} in markup built for ${file} is blocked by "${ap.trim()}"`);
    }
  }
  if (problems.length) {
    fail++;
    console.log(`  FAIL ${file} (policy from ${source})`);
    for (const p of problems) console.log('       ' + p);
    console.log('       The click (or load) does nothing and only the DevTools console says why.');
    console.log('       Links to the browser: <a href="https://..." data-external>. Anything else: addEventListener in the page script.');
  } else {
    pass++;
  }
}

// ── Self-check of the detector, so a regex change cannot silently pass everything.
{
  const bad = '<a href="#" onclick="window.api.openExternal(\'http://websdr.org\');return false;">x</a>'
    + '<img src=x onerror=hide()><a href="javascript:void(0)">y</a>';
  const hits = inlineCode(bad).map((h) => h.what);
  const want = ['onclick=', 'onerror=', 'javascript: URL'];
  if (JSON.stringify(hits) !== JSON.stringify(want)) {
    console.log('  FAIL detector self-check: got ' + JSON.stringify(hits) + ', want ' + JSON.stringify(want));
    fail++;
  } else if (inlineCode('<a href="https://websdr.org" data-external>x</a> const onChange = () => {}; el.onclick = f;').length) {
    console.log('  FAIL detector self-check: false positive on clean markup/code');
    fail++;
  } else if (allowsInline(attrPolicy("default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'"))) {
    console.log("  FAIL policy self-check: style-src 'unsafe-inline' must not count for scripts");
    fail++;
  } else if (!allowsInline(attrPolicy("default-src 'self'; script-src-attr 'unsafe-inline'"))) {
    console.log("  FAIL policy self-check: script-src-attr 'unsafe-inline' allows handlers");
    fail++;
  } else {
    pass++;
  }
}

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const html = readSrc(path.join(DIR, file));
  // The value is quoted with " and holds 'self' etc., so match the same quote
  // back (a [^"']+ capture stopped at the first ' and read every policy as empty).
  const meta = html.match(/http-equiv=["']Content-Security-Policy["'][^>]*content=(["'])([\s\S]*?)\1/i);
  if (!meta) { pass++; continue; }                       // no CSP: nothing to contradict
  checkPage(file, html, meta[2], 'its <meta> tag');
}

// ECHOCAT Web: remote.html is served over HTTP by lib/remote-server.js, so a
// policy can also arrive as a response header. Any header it declares binds
// the page; with none (today) inline code is allowed there.
{
  const rs = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
  const headers = [...rs.matchAll(/['"]Content-Security-Policy['"]\s*[:,]\s*(['"`])([^'"`]+)\1/gi)].map((m) => m[2]);
  if (/Content-Security-Policy/i.test(rs) && !headers.length) {
    console.log('  FAIL lib/remote-server.js mentions Content-Security-Policy but this test could not read the value;');
    console.log('       teach the header parse here so remote.html stays covered.');
    fail++;
  }
  const html = readSrc(path.join(DIR, 'remote.html'));
  for (const h of headers) checkPage('remote.html', html, h, 'lib/remote-server.js header');
  if (!headers.length) pass++;
}

console.log(`\nRenderer CSP: ${pass} clean, ${fail} violating`);
process.exit(fail === 0 ? 0 : 1);
