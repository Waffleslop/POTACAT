#!/usr/bin/env node
'use strict';
// An n-fer's other parks from the activator's own spot comments, logged as
// one record per park locally and as one POTA_REF list to the external logbook.
// Run: node test/nfer-refs-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const N = require('../lib/nfer-refs');
const LF = require('../lib/logger-forward');
const main = readSrc(path.join(__dirname, '..', 'main.js'));
const potaSrc = readSrc(path.join(__dirname, '..', 'lib/pota.js'));

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const DK5UR = [
  { spotter: 'DK5UR', comments: '3-fer DE-1197,DE-0941,DE-0034 FT8' },
  { spotter: 'OE6ADD-#', comments: 'RBN -15 dB via OE6ADD-# DE-9999' },
  { spotter: 'DA2PK', comments: 'P2P from DE-0001' },
];

test('only the activator\'s own spots count; RBN and hunters naming other parks do not', () => {
  assert.deepStrictEqual(N.selfSpotRefs(DK5UR, 'DK5UR'), ['DE-1197', 'DE-0941', 'DE-0034']);
  assert.deepStrictEqual(N.selfSpotRefs(DK5UR, 'DK5UR/P'), ['DE-1197', 'DE-0941', 'DE-0034'], 'portable suffix');
  assert.deepStrictEqual(N.selfSpotRefs([{ spotter: 'X1ABC', comments: 'DLFF-0123 US-12345 K-1234' }], 'X1ABC'), ['US-12345', 'K-1234'], 'WWFF never matches');
});

test('extra refs: the spotted park must be named, known parks are not repeated', () => {
  const cached = N.selfSpotRefs(DK5UR, 'DK5UR');
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR', spottedRef: 'DE-1197', known: ['DE-1197'], cached }), ['DE-0941', 'DE-0034']);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR', spottedRef: 'DE-5555', known: ['DE-5555'], cached }), [], 'a comment from another activation adds nothing');
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR', spottedRef: 'DE-1197', known: ['DE-1197', 'DE-0941'], collected: [{ spotter: 'DK5UR', comments: '3-fer DE-1197,DE-0941,DE-0034' }] }), ['DE-0034'], 'POTACAT\'s collected spots count too');
});

test('cache: one fetch per activator and park, read without waiting', async () => {
  let calls = 0;
  const c = new N.NferCache({ fetchHistory: async () => { calls++; return DK5UR; } });
  assert.deepStrictEqual(c.get('DK5UR', 'DE-1197'), [], 'nothing before the fetch lands');
  c.prefetch('DK5UR', 'DE-1197'); c.prefetch('DK5UR', 'DE-1197');
  await new Promise((r) => setTimeout(r, 10));
  c.prefetch('DK5UR', 'DE-1197');
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(c.get('DK5UR', 'DE-1197'), ['DE-1197', 'DE-0941', 'DE-0034']);
  const failing = new N.NferCache({ fetchHistory: async () => { throw new Error('down'); } });
  failing.prefetch('DK5UR', 'DE-1197');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(failing.get('DK5UR', 'DE-1197'), [], 'a failed fetch is just no extras');
});

test('the forwarded record carries every POTA park as POTA_REF; the local records are untouched', async () => {
  let sent = null;
  await LF.forwardToLoggers({ callsign: 'DK5UR', potaRef: 'DE-1197', forwardPotaRefs: 'DE-1197,DE-0941,DE-0034' },
    { sendToLogbook: true, logbookType: 'wavelog' }, { forwardToLogbook: async (q) => { sent = q; } });
  assert.strictEqual(sent.potaRef, 'DE-1197,DE-0941,DE-0034');
  assert.strictEqual(sent.forwardPotaRefs, undefined);
  const qe = readSrc(path.join(__dirname, '..', 'lib/qso-expand.js'));
  assert.ok(/else if \(potaAll\.length > 1 \|\| \(potaAll\.length === 1 && !\(h && h\.sig === 'POTA'\)\)\) r\.forwardPotaRefs = potaAll\.join\(','\);/.test(qe));
});

test('pota.app history is /spot/comments/{call}/{ref}', () => {
  assert.ok(/spot\/comments\/\$\{encodeURIComponent\(call\.toUpperCase\(\)\)\}\/\$\{encodeURIComponent\(reference\)\}/.test(potaSrc));
});

test('wired: prefetched where JTCAT matches an activator, read (not awaited) at log time', () => {
  assert.ok(/if \(pota\) _nferCache\.prefetch\(call, pota\.ref\);/.test(main));
  assert.ok(/cached: _nferCache\.get\(q\.call, spotted\.ref\),/.test(main));
  assert.ok(!/await[^\n]*_nferCache/.test(main), 'never awaited: the next TX message waits on the log write');
  assert.ok(/for \(const ref of extra\) qsoData\.hunted\.push\(\{ sig: 'POTA', ref \}\);/.test(main));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  console.log(`\nn-fer refs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
