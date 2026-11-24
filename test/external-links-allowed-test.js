'use strict';
const { readSrc } = require('./_src');
// Every link the app opens in the browser (an <a data-external> in a window's
// HTML) must pass main's open-external allowlist — the gate fails CLOSED with
// no message, so a link missing from it simply does nothing (Casey
// 2026-10-19: the §97.119 link in Settings > Share Rig).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
// The rule lives in lib/external-url.js (host compared exactly, not a prefix).
const ExternalUrl = require('../lib/external-url');
const allowed = ExternalUrl.ALLOWED;
assert.ok(allowed.length > 10, 'allowlist loaded');

const bad = [];
for (const f of fs.readdirSync(path.join(root, 'renderer')).filter((n) => n.endsWith('.html'))) {
  const html = readSrc(path.join(root, 'renderer', f));
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\bdata-external\b/.test(tag)) continue;
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    if (!href || !/^https?:|^mailto:/.test(href)) continue;
    if (!ExternalUrl.allowed(href.replace(/&amp;/g, '&'))) bad.push(f + ': ' + href);
  }
}
assert.deepStrictEqual(bad, [], 'links the allowlist refuses:\n  ' + bad.join('\n  '));
console.log('  ok  every data-external link passes the open-external allowlist (' + allowed.length + ' entries)');
console.log('\nExternal links: 1 passed, 0 failed');
