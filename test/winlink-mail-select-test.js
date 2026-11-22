#!/usr/bin/env node
'use strict';
/**
 * Deleting several Winlink messages at once (#346).
 *
 *   lib/winlink-mail-select.js     the selection (click, shift-click, all, prune)
 *                                  and the bar's words and its one confirm
 *   renderer/winlink-popout.*      the wiring (source guards): a box per row,
 *                                  the bar, the confirm in the app's own style
 *                                  (never a browser confirm), and each message
 *                                  deleted through the existing delete path
 *
 * Run: node test/winlink-mail-select-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/winlink-mail-select');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

const order = ['a', 'b', 'c', 'd', 'e'];

t('a plain click toggles one message and moves the anchor', () => {
  let s = S.pick(S.none(), 'b', {}, order);
  assert.deepStrictEqual(s, { mids: ['b'], anchor: 'b' });
  s = S.pick(s, 'd', {}, order);
  assert.deepStrictEqual(s.mids, ['b', 'd']);
  s = S.pick(s, 'b', {}, order);
  assert.deepStrictEqual(s, { mids: ['d'], anchor: 'b' });
});

t('the selection keeps list order whatever the click order', () => {
  let s = S.pick(S.none(), 'e', {}, order);
  s = S.pick(s, 'a', {}, order);
  assert.deepStrictEqual(s.mids, ['a', 'e']);
});

t('shift-click adds the range from the anchor, either direction', () => {
  let s = S.pick(S.none(), 'b', {}, order);
  s = S.pick(s, 'd', { shift: true }, order);
  assert.deepStrictEqual(s.mids, ['b', 'c', 'd']);
  assert.strictEqual(s.anchor, 'b');
  let u = S.pick(S.none(), 'd', {}, order);
  u = S.pick(u, 'a', { shift: true }, order);
  assert.deepStrictEqual(u.mids, ['a', 'b', 'c', 'd']);
});

t('shift-click with no anchor is a plain click', () => {
  assert.deepStrictEqual(S.pick(S.none(), 'c', { shift: true }, order), { mids: ['c'], anchor: 'c' });
});

t('shift-click keeps picks outside the range', () => {
  let s = S.pick(S.none(), 'e', {}, order);
  s = S.pick(s, 'a', {}, order);
  s = S.pick(s, 'b', { shift: true }, order);
  assert.deepStrictEqual(s.mids, ['a', 'b', 'e']);
});

t('a click on a message no longer listed changes nothing but stale picks', () => {
  const s = S.pick({ mids: ['a', 'zz'], anchor: 'a' }, 'gone', {}, order);
  assert.deepStrictEqual(s.mids, ['a']);
});

t('select all, and prune after a refresh', () => {
  assert.deepStrictEqual(S.allOf(order).mids, order);
  assert.deepStrictEqual(S.allOf([]), { mids: [], anchor: null });
  const p = S.prune({ mids: ['a', 'c', 'e'], anchor: 'c' }, ['a', 'b', 'd', 'e']);
  assert.deepStrictEqual(p, { mids: ['a', 'e'], anchor: null });
  assert.deepStrictEqual(S.prune({ mids: ['c'], anchor: 'c' }, ['a']), { mids: [], anchor: null });
  assert.deepStrictEqual(S.prune(null, order), { mids: [], anchor: null });
});

t('the bar and its button say how many', () => {
  assert.strictEqual(S.barText(3), '3 selected');
  assert.strictEqual(S.deleteLabel('in', 3), 'Delete selected (3)');
  assert.strictEqual(S.deleteLabel('deleted', 2), 'Delete 2 for good');
});

t('the confirm: Deleted is for good, every other folder can be restored', () => {
  assert.strictEqual(S.confirmText('in', 1), 'Move 1 message to Deleted? You can restore it from there.');
  assert.strictEqual(S.confirmText('sent', 4), 'Move 4 messages to Deleted? You can restore them from there.');
  assert.strictEqual(S.confirmText('deleted', 1), 'Delete 1 message for good? It cannot be brought back.');
  assert.strictEqual(S.confirmText('deleted', 5), 'Delete 5 messages for good? They cannot be brought back.');
});

t('progress and the result sentence', () => {
  assert.strictEqual(S.progressText('in', 2, 3), 'Deleting 2 of 3...');
  assert.strictEqual(S.resultText('in', 3, 0), 'Moved 3 messages to Deleted.');
  assert.strictEqual(S.resultText('deleted', 1, 0), 'Deleted 1 message for good.');
  assert.strictEqual(S.resultText('in', 2, 1, 'Pat is not running'), 'Moved 2 messages to Deleted. One message was not deleted: Pat is not running.');
  assert.strictEqual(S.resultText('in', 0, 2, 'Pat is not running.'), '2 messages were not deleted: Pat is not running.');
  assert.strictEqual(S.resultText('in', 0, 1), 'One message was not deleted.');
});

// ── wiring (source guards) ──────────────────────────────────────────────────
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'winlink-popout.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'winlink-popout.html'), 'utf8');

t('the page loads the module before its script', () => {
  const a = html.indexOf('../lib/winlink-mail-select.js');
  const b = html.indexOf('winlink-popout.js"');
  assert.ok(a > 0 && b > a, 'winlink-mail-select.js is loaded before winlink-popout.js');
});

t('every row has a box to pick it, and the list has the bar', () => {
  assert.ok(/class="wl-sel"/.test(js), 'a checkbox per row');
  assert.ok(/id="wl-selbar"/.test(js), 'the selection bar');
  assert.ok(/id="wl-sel-del"/.test(js) && /id="wl-sel-all"/.test(js) && /id="wl-sel-clear"/.test(js));
});

t('the confirm is the app\'s own, never a browser dialog', () => {
  assert.ok(!/\bconfirm\s*\(/.test(js.replace(/confirmText\s*\(/g, '')), 'no window.confirm in the Winlink window');
  assert.ok(!/\balert\s*\(/.test(js), 'no alert in the Winlink window');
  assert.ok(/WMS\.confirmText\(/.test(js));
});

t('each selected message goes through the one delete path, one at a time', () => {
  const run = js.slice(js.indexOf('function deleteSelected'));
  assert.ok(run.length > 0 && /await window\.api\.del\(/.test(run.slice(0, 2000)), 'window.api.del per message, awaited');
});

console.log(`\nwinlink-mail-select: ${pass} passed`);
