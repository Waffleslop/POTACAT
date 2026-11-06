// Tests for renderer/popout-theme-boot.js — the rule that makes every popout
// open in the operator's theme on the first frame (no flash). The script is
// browser code (window.location / document), so we run it with mocked globals
// and assert: (1) the boot applies the loadFile ?theme= query, and (2) the
// exposed window.applyPopoutTheme() handles BOTH a string and the { theme,
// variant } object the live onTheme IPC sends — the object shape is the bug
// that made the VFO popout open dark in light mode (setAttribute stringified
// it to "[object Object]"). Mirrors the main window's applyTheme().
// Run: node test/popout-theme-boot-test.js
'use strict';
const { readSrc } = require('./_src');

const fs = require('fs');
const path = require('path');

const src = readSrc(path.join(__dirname, '..', 'renderer', 'popout-theme-boot.js'));

// Execute the boot IIFE with injected window/document/URLSearchParams.
// Returns { attrs (set on <html>), win (carries applyPopoutTheme) }.
function boot(search) {
  const attrs = {};
  const el = {
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  };
  const win = { location: { search: search || '' } };
  const doc = { documentElement: el };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'URLSearchParams', src)(win, doc, URLSearchParams);
  return { attrs, win, el };
}

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

console.log('=== boot: apply from loadFile query ===');
let a = boot('?theme=light&variant=navy').attrs;
check(a['data-theme'] === 'light', 'light → data-theme=light');
check(!('data-dark-variant' in a), 'light → no data-dark-variant');

a = boot('?theme=dark&variant=charcoal').attrs;
check(a['data-theme'] === 'dark' && a['data-dark-variant'] === 'charcoal', 'dark+charcoal → data-theme=dark + data-dark-variant=charcoal');

a = boot('?theme=dark&variant=navy').attrs;
check(a['data-theme'] === 'dark' && !('data-dark-variant' in a), 'dark+navy → no data-dark-variant');

a = boot('').attrs;
check(a['data-theme'] === 'dark', 'no query → defaults to dark');

a = boot('?theme=bogus').attrs;
check(a['data-theme'] === 'dark', 'unrecognized theme → dark');

console.log('\n=== applyPopoutTheme: object payload (the live IPC shape) ===');
let ctx = boot('?theme=dark&variant=navy');
check(typeof ctx.win.applyPopoutTheme === 'function', 'boot exposes window.applyPopoutTheme');

ctx.win.applyPopoutTheme({ theme: 'light', variant: 'navy' });
check(ctx.attrs['data-theme'] === 'light', 'object {theme:light} → data-theme=light (NOT "[object Object]")');
check(ctx.attrs['data-theme'] !== '[object Object]', 'object payload never stringifies into data-theme (the VFO bug)');
check(!('data-dark-variant' in ctx.attrs), 'object light → no data-dark-variant');

ctx.win.applyPopoutTheme({ theme: 'dark', variant: 'charcoal' });
check(ctx.attrs['data-theme'] === 'dark' && ctx.attrs['data-dark-variant'] === 'charcoal', 'object {dark,charcoal} → dark + charcoal');

ctx.win.applyPopoutTheme({ theme: 'light', variant: 'charcoal' });
check(ctx.attrs['data-theme'] === 'light' && !('data-dark-variant' in ctx.attrs), 'object light clears a prior dark-variant');

console.log('\n=== applyPopoutTheme: string payload (back-compat) ===');
ctx.win.applyPopoutTheme('light');
check(ctx.attrs['data-theme'] === 'light', 'string "light" → light');
ctx.win.applyPopoutTheme('dark');
check(ctx.attrs['data-theme'] === 'dark', 'string "dark" → dark');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
