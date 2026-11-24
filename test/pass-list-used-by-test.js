#!/usr/bin/env node
'use strict';
/**
 * Guest Pass list wording (GitHub #1003). The cloud's active_session_count is
 * guests who redeemed the pass and were not cancelled, not live presence, so
 * the owner's pass list must say "has used this pass", never "connected now".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PassWording = require('../lib/pass-wording');

assert.strictEqual(typeof PassWording.guestsUsedText, 'function');
assert.strictEqual(PassWording.guestsUsedText(0), '');
assert.strictEqual(PassWording.guestsUsedText(undefined), '');
assert.strictEqual(PassWording.guestsUsedText(1), '1 guest has used this pass');
assert.strictEqual(PassWording.guestsUsedText(2), '2 guests have used this pass');
assert.strictEqual(PassWording.guestsUsedText(12), '12 guests have used this pass');

// The renderer uses the formatter and the old phrase is gone everywhere.
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
assert.ok(app.includes('PassWording.guestsUsedText('), 'pass list must use PassWording.guestsUsedText');
for (const f of ['renderer/app.js', 'renderer/remote.js', 'renderer/index.html', 'main.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  assert.ok(!/guests? connected now/.test(src), f + ' still says "guest connected now"');
}
console.log('pass-list-used-by-test: ok');
