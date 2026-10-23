'use strict';
// renderer/index.html must stay tag-balanced: one stray </div> in the Winlink
// Settings block (10423e6e) collapsed the whole Settings dialog — the sidebar
// vanished and the WebSDR fieldset sat where the menu belongs (K3SBP 2026-10-23).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const TAGS = new Set(['div', 'fieldset', 'details', 'section', 'label', 'span', 'select', 'form', 'table', 'ul', 'ol']);
const stack = [];
const bad = [];
let line = 1;
const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>|<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|\n/g;
let m;
while ((m = re.exec(src))) {
  if (m[0] === '\n') { line++; continue; }
  if (m[0].startsWith('<!--') || m[0].startsWith('<script') || m[0].startsWith('<style')) { line += (m[0].match(/\n/g) || []).length; continue; }
  const tag = m[2].toLowerCase();
  if (!TAGS.has(tag) || m[3] === '/') continue;
  if (m[1] === '/') {
    if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
    else bad.push(`</${tag}> at line ${line} closes ${stack.length ? '<' + stack[stack.length - 1].tag + '> from line ' + stack[stack.length - 1].line : 'nothing'}`);
  } else stack.push({ tag, line });
}
assert.deepStrictEqual(bad, [], 'mismatched closing tags:\n  ' + bad.join('\n  '));
assert.deepStrictEqual(stack, [], 'unclosed tags: ' + stack.map((s) => `<${s.tag}> line ${s.line}`).join(', '));
console.log('index.html balance: ok (' + line + ' lines)');
