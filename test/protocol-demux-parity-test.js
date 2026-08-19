#!/usr/bin/env node
'use strict';
/**
 * Protocol registry ⇄ demux parity.
 *
 * `lib/echocat-protocol.js` declares, per message, which wire fields it
 * carries. `lib/remote-server.js` has the C2S demux that actually reads them.
 * Nothing kept the two honest, and they drifted: `set-enable-atu` and
 * `set-enable-split` declared `on` while both handlers destructured `value`,
 * so for months any client that followed the published registry was silently
 * ignored — no error, no log, the toggle just did nothing. It was found by
 * accident during the LZ3AW VFO work (2026-08-03).
 *
 * This scans the demux for `msg.<field>` reads inside each `case` block and
 * requires every one to be declared for that message. A field the registry
 * doesn't mention is either a bug in the registry (clients are told the wrong
 * name) or a bug in the handler (it reads something no client will send).
 *
 * Run: node test/protocol-demux-parity-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { MESSAGES } = require('../lib/echocat-protocol');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// Fields every handler may touch regardless of the registry: the envelope
// itself, plus request correlation.
const ALWAYS_ALLOWED = new Set(['type', 'id', 'reqId', 'seq', 'ts']);

/**
 * KNOWN DRIFT — the debt this test found when it was written (2026-08-05).
 * `set-enable-atu`/`set-enable-split` were fixed by hand on 2026-08-03; this
 * scan then found 35 more of exactly the same shape. Every one is a handler
 * reading a field name the registry doesn't publish, so a client written
 * against the registry is silently ignored.
 *
 * They are LISTED, not fixed, on purpose. Each needs evidence of which side is
 * wrong, and the evidence lives in the clients — the web client is in-repo but
 * the mobile app is not. Where it has been checked (qrz-lookup, lookup-call,
 * set-dist-unit) the web client sends the HANDLER's name, so the registry is
 * the wrong side and the fix is to correct the registry — the direction the
 * set-enable-atu fix already took. Do not "fix" these by changing handlers:
 * that breaks shipped clients.
 *
 * The point of the list is that it can only shrink. Anything not on it fails.
 */
const KNOWN_DRIFT = new Set([
  'log-qso:data',
  'set-activator-park:parkRef',
  'get-activation-map-data:parkRef',
  'get-activation-map-data:date',
  'get-activation-map-data:contacts',
  'filter-step:direction',
  'qrz-lookup:callsign',
  'tgxl-select-antenna:port',
  'rig-control:action',            // documented top-level fallback, not a bug
  'set-refresh-interval:value',
  'toggle-rotor:enabled',
  'set-scan-dwell:value',
  'set-max-age:value',
  'set-dist-unit:value',
  'set-cw-xit:value',
  'set-cw-filter:value',
  'set-ssb-filter:value',
  'set-digital-filter:value',
  'set-tune-click:value',
  'lookup-call:callsign',
  'freedv-set-tx:enabled',
  'freedv-set-squelch:enabled',
  'freedv-set-squelch:threshold',
  'jtcat-set-band:freqKhz',
  'jtcat-waterfall:visible',
  'jtcat-start-multi-remote:slices',
  'save-echo-pref:key',
  'save-echo-pref:value',
  'sstv-photo:image',
  'sstv-photo:mode',
  'sstv-get-gallery:limit',
  'sstv-get-gallery:offset',
  'sstv-get-gallery:requestId',
  'paddle:contact',
  'paddle:state',
]);

/** Messages the demux handles that the registry never declares at all. Same
 *  deal: listed so the set can only shrink. A client has no way to discover
 *  these, and `validate()` can't check them. */
const KNOWN_UNDECLARED = new Set([
  'rig-reconnect',
  'tx-eq-get',
  'tx-eq-set',
  'jtcat-set-skip-tx1',
  'jtcat-set-hound-mode',
  // jtcat-psk-send graduated to the registry 2026-08-20 (schema captured
  // from the live wire shape) — no longer undeclared debt.
]);

/** Pull the body of the `switch (msg.type) { … }` demux by brace matching. */
function extractDemux(src) {
  const start = src.indexOf('switch (msg.type)');
  assert.ok(start > -1, 'could not find the switch (msg.type) demux');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in the demux');
}

/**
 * Group the demux into { types: [...], body } records. Consecutive case
 * labels with no code between them share the block that follows (fallthrough),
 * so the block is attributed to all of them.
 */
function parseCaseBlocks(demux) {
  const caseRe = /case\s+'([^']+)'\s*:/g;
  const hits = [];
  let m;
  while ((m = caseRe.exec(demux)) !== null) hits.push({ type: m[1], at: m.index, end: caseRe.lastIndex });

  const blocks = [];
  for (let i = 0; i < hits.length; i++) {
    const bodyEnd = i + 1 < hits.length ? hits[i + 1].at : demux.length;
    const body = demux.slice(hits[i].end, bodyEnd);
    // A label immediately followed by another label is a fallthrough group.
    if (body.trim() === '') {
      blocks.push({ types: [hits[i].type], body: '', fallthrough: true });
    } else {
      blocks.push({ types: [hits[i].type], body, fallthrough: false });
    }
  }
  // Attach each fallthrough label to the next block that has a body.
  const merged = [];
  let pending = [];
  for (const b of blocks) {
    if (b.fallthrough) { pending.push(b.types[0]); continue; }
    merged.push({ types: pending.concat(b.types), body: b.body });
    pending = [];
  }
  return merged;
}

/** Every `msg.<ident>` read in a block. */
function msgFieldsIn(body) {
  const out = new Set();
  const re = /\bmsg\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
const blocks = parseCaseBlocks(extractDemux(src));

console.log('\n=== protocol registry ⇄ C2S demux parity ===');

test('the demux was parsed into case blocks', () => {
  assert.ok(blocks.length > 40, `only found ${blocks.length} case blocks — parser probably broke`);
});

test('every field the demux reads is declared in the registry', () => {
  const problems = [];
  for (const { types, body } of blocks) {
    const read = msgFieldsIn(body);
    for (const type of types) {
      const spec = MESSAGES[type];
      if (!spec) continue;            // covered by the next test
      const declared = new Set(Object.keys(spec.fields || {}));
      for (const f of read) {
        if (ALWAYS_ALLOWED.has(f) || declared.has(f)) continue;
        if (KNOWN_DRIFT.has(`${type}:${f}`)) continue;
        problems.push(`  ${type}: handler reads msg.${f}, registry declares {${[...declared].join(', ') || 'nothing'}}`);
      }
    }
  }
  assert.strictEqual(problems.length, 0,
    `${problems.length} NEW registry/handler mismatch(es) — a client following the ` +
    `published registry would be silently ignored. Fix the registry to match the ` +
    `shipped handler (never the reverse; that breaks shipped clients):\n` + problems.join('\n'));
});

test('every message the demux handles exists in the registry', () => {
  const unknown = [];
  for (const { types } of blocks) {
    for (const type of types) {
      if (!MESSAGES[type] && !KNOWN_UNDECLARED.has(type)) unknown.push(type);
    }
  }
  assert.strictEqual(unknown.length, 0,
    `demux handles message(s) the registry never declares: ${unknown.join(', ')}`);
});

// The lists are debt, so they must stay honest: an entry that no longer
// matches anything means someone fixed it and forgot to delete the line, and
// a stale list quietly stops protecting the entries around it.
test('the known-drift lists contain no stale entries', () => {
  const live = new Set();
  const liveTypes = new Set();
  for (const { types, body } of blocks) {
    const read = msgFieldsIn(body);
    for (const type of types) {
      liveTypes.add(type);
      const declared = new Set(Object.keys((MESSAGES[type] || {}).fields || {}));
      for (const f of read) {
        if (!ALWAYS_ALLOWED.has(f) && !declared.has(f)) live.add(`${type}:${f}`);
      }
    }
  }
  const staleDrift = [...KNOWN_DRIFT].filter((k) => !live.has(k));
  const staleUndeclared = [...KNOWN_UNDECLARED].filter((t) => !liveTypes.has(t) || MESSAGES[t]);
  assert.deepStrictEqual([...staleDrift, ...staleUndeclared], [],
    'these are fixed — delete them from the list so it keeps shrinking');
});

test('the set-enable-atu/-split regression that motivated this stays fixed', () => {
  for (const type of ['set-enable-atu', 'set-enable-split']) {
    const declared = Object.keys((MESSAGES[type] || {}).fields || {});
    assert.ok(declared.includes('value'),
      `${type} must declare the field its handler actually reads (value), got [${declared}]`);
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
