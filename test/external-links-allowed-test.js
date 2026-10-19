'use strict';
// Every link the app opens in the browser (an <a data-external> in a window's
// HTML) must pass main's open-external allowlist — the gate fails CLOSED with
// no message, so a link missing from it simply does nothing (Casey
// 2026-10-19: the §97.119 link in Settings > Share Rig).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const at = main.indexOf("ipcMain.on('open-external'");
const block = main.slice(main.indexOf('const allowed = [', at), main.indexOf('];', main.indexOf('const allowed = [', at)));
const allowed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.ok(allowed.length > 10, 'allowlist parsed');

const bad = [];
for (const f of fs.readdirSync(path.join(root, 'renderer')).filter((n) => n.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(root, 'renderer', f), 'utf8');
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\bdata-external\b/.test(tag)) continue;
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    if (!href || !/^https?:|^mailto:/.test(href)) continue;
    if (!allowed.some((p) => href.startsWith(p))) bad.push(f + ': ' + href);
  }
}
assert.deepStrictEqual(bad, [], 'links the allowlist refuses:\n  ' + bad.join('\n  '));
console.log('  ok  every data-external link passes the open-external allowlist (' + allowed.length + ' prefixes)');
console.log('\nExternal links: 1 passed, 0 failed');
