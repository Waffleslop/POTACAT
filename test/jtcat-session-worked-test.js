#!/usr/bin/env node
'use strict';
// JTCAT's session memory ("attempted/worked this session") must be band- and
// mode-aware like the log check behind it. N2FSM 2026-09-26: after working
// stations on FT8 earlier in a session, Hunt on 20m FT4 skipped them ("green,
// being ignored") although the dupe toast said the earlier QSO was on another
// mode — the session set held bare callsigns. Run: node test/jtcat-session-worked-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

console.log('jtcat session worked');

// The helpers, run against a stubbed current band/mode.
// eslint-disable-next-line no-new-func
const make = new Function('state', `
  const jtcatAutoCqWorkedSession = new Set();
  const ft8Engine = { _mode: 'FT8' };
  function jtcatCurrentBandMode() { return { band: state.band, mode: state.mode }; }
  ${extract('jtcatSessionKey')}
  ${extract('jtcatSessionMark')}
  ${extract('jtcatSessionHas')}
  return { mark: jtcatSessionMark, has: jtcatSessionHas, set: jtcatAutoCqWorkedSession };
`);

test('a station worked on 20m FT8 does not block 20m FT4 or 40m FT8', () => {
  const state = { band: '20M', mode: 'FT8' };
  const h = make(state);
  h.mark('k1abc');
  assert.strictEqual(h.has('K1ABC', '20M', 'FT8'), true, 'same band+mode blocks');
  assert.strictEqual(h.has('K1ABC', '20M', 'FT4'), false, 'other mode is a new contact');
  assert.strictEqual(h.has('K1ABC', '40M', 'FT8'), false, 'other band is a new contact');
});

test('an explicit band/mode (multi-slice) is recorded as given', () => {
  const h = make({ band: '20M', mode: 'FT8' });
  h.mark('W9TEF', { band: '17m', mode: 'FT4' });
  assert.strictEqual(h.has('W9TEF', '17M', 'FT4'), true);
  assert.strictEqual(h.has('W9TEF', '20M', 'FT8'), false);
});

test('nothing in main.js reads or writes the session set by bare callsign', () => {
  const direct = src.split('\n').filter((l) => /jtcatAutoCqWorkedSession\.(add|has)\(/.test(l) && !/jtcatSessionKey\(/.test(l));
  assert.deepStrictEqual(direct, [], direct.join('\n'));
  assert.ok(/if \(jtcatSessionHas\(c, band, mode\)\) return true;/.test(src), 'jtcatIsWorkedCall uses the keyed check');
  assert.ok(/if \(jtcatSessionHas\(d\.call, dupeBandMode\.band, dupeBandMode\.mode\)\) return false;/.test(src), 'Hunt candidates use the keyed check');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
