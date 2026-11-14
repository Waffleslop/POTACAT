// #507: every field that holds a list of park refs fits six of the longest refs
// the hunter-park parser accepts (B/ABC-12345, ABCD/XX-123: 11 characters), joined by ", ".
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const longest = ['B/ABC-12345', 'ABCD/XX-123', 'ABCD-12345'].reduce((a, b) => (b.length > a.length ? b : a));
const sixRefs = Array(6).fill(longest).join(', ');

for (const id of ['activator-hunter-park', 'bl-ref']) {
  const tag = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
  assert.ok(tag, id + ' input exists');
  const m = tag[0].match(/maxlength="(\d+)"/);
  if (!m) continue;
  assert.ok(Number(m[1]) >= sixRefs.length,
    id + ' maxlength ' + m[1] + ' cuts off a six-park list (' + sixRefs.length + ' chars)');
}
console.log('park-field-length-test: ok (' + sixRefs.length + ' chars)');
