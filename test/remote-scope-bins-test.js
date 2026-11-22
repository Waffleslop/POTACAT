#!/usr/bin/env node
'use strict';
/**
 * #772: a POTACAT desktop driving a shack (desktop-to-desktop remote) showed
 * the scope window's state but never drew a trace or waterfall. The remote
 * subscribed with no `bins`, so the shack sent 256 points (its default for a
 * phone), and the scope pop-out drops every frame that is not ScopeAxis.BINS
 * (850) points. The remote now asks for the full 850.
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { RemoteServer } = require('../lib/remote-server');
const ScopeAxis = require('../lib/scope-axis');
const YaesuScope = require('../lib/yaesu-scope');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const main = readSrc(path.join(ROOT, 'main.js'));
const popout = readSrc(path.join(ROOT, 'renderer/scope-popout.js'));

// Every scope-subscribe the desktop remote client sends to the shack.
const subscribes = main.split('\n').filter((l) => /remoteClient\.sendRaw\(\{ type: 'scope-subscribe'/.test(l));

console.log('The remote subscribe (main.js)');
check('the remote client subscribes in two places (window open, reconnect)', () => {
  assert.strictEqual(subscribes.length, 2, subscribes.join('\n'));
});
check('each subscribe asks for the scope window\'s full width (bins: YaesuScope.BINS)', () => {
  for (const l of subscribes) assert.ok(/bins: YaesuScope\.BINS/.test(l), 'no bins: ' + l.trim());
  assert.strictEqual(YaesuScope.BINS, ScopeAxis.BINS);
});

console.log('What the shack sends back, and the pop-out takes');
// The shack's own handling of scope-subscribe { on, bins }, run against a fake socket.
function subscribeOn(bins) {
  const s = Object.create(RemoteServer.prototype);
  const ws = { readyState: 1 };
  // Same rule as the 'scope-subscribe' case in lib/remote-server.js.
  const src = readSrc(path.join(ROOT, 'lib/remote-server.js'));
  assert.ok(/ws\._scopeBins = Number\.isFinite\(b\) && b > 0 \? Math\.max\(32, Math\.min\(1024, b\)\) : 256;/.test(src));
  const b = Math.round(Number(bins));
  ws._scopeBins = Number.isFinite(b) && b > 0 ? Math.max(32, Math.min(1024, b)) : 256;
  const sent = [];
  s._openClients = () => [ws];
  s._client = ws;
  s._sendTo = (c, m) => sent.push(m);
  s.broadcastScopeFrame({ seq: 1, kind: 0, wf1: new Uint8Array(ScopeAxis.BINS), gapMs: 66, cloudGapMs: 100 });
  return sent[0];
}
check('a subscribe with bins 850 gets 850-point frames from an 850-point source (FT-710, Icom, Flex, ...)', () => {
  const f = subscribeOn(YaesuScope.BINS);
  assert.strictEqual(f.bins.length, ScopeAxis.BINS);
});
check('without bins the shack sends a phone 256 points, which the pop-out would drop (the bug)', () => {
  assert.strictEqual(subscribeOn(undefined).bins.length, 256);
});
check('the scope pop-out keeps only frames of exactly ScopeAxis.BINS points', () => {
  assert.ok(/if \(!raw \|\| raw\.length !== BINS\) return;/.test(popout));
  assert.ok(/const BINS = A\.BINS;/.test(popout), 'the pop-out takes BINS from ScopeAxis');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
