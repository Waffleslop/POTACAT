#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// The CW text TX lockout (main.js _setCwTxLockout) holds the unified TX state
// true while a CW macro plays, and its timer re-broadcasts when it ends. A
// timer can fire a millisecond before Date.now() reaches its target; the
// callback then still saw the lockout running, broadcast "transmitting", and
// no timer was left to clear it: the VFO window's PTT stayed on "ON AIR" after
// CW text macros until PTT was pressed (DA2PK, FT-710, 2026-11-15).
//
// The three functions are taken from main.js as they are and run with a fake
// clock and timers.
//
// Run:  node test/cw-tx-lockout-timer-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++; failures.push(msg); console.log(`  x ${msg}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/** The source of `function name(...) { ... }` from main.js, braces matched. */
function fnSource(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const setLockout = fnSource('_setCwTxLockout');
const isTx = fnSource('_isEffectivelyTransmitting');
ok(!!setLockout, 'main.js has _setCwTxLockout');
ok(!!isTx, 'main.js has _isEffectivelyTransmitting');

function harness() {
  const h = { now: 1000000, timers: [], broadcasts: [] };
  const ctx = {
    Date: { now: () => h.now },
    Math,
    setTimeout: (fn, ms) => { const t = { fn, at: h.now + ms, cleared: false }; h.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    h,
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let _remoteTxState = false;
    let _cwTxLockoutUntilMs = 0;
    let tciRig = null; // #195: a TCI rig's own over also counts as transmitting
    function tciRigTarget() { return null; }
    let _cwTxLockoutTimer = null;
    ${isTx}
    function _broadcastEffectiveTxState() { h.broadcasts.push(_isEffectivelyTransmitting()); }
    ${setLockout}
    h.set = _setCwTxLockout;
    h.setRemote = (v) => { _remoteTxState = v; };
  `, ctx);
  /** Fire the live timer `earlyMs` before its target. */
  h.fireLive = (earlyMs) => {
    const t = h.timers.filter((x) => !x.cleared).pop();
    if (!t) return false;
    t.cleared = true;
    h.now = t.at - earlyMs;
    t.fn();
    return true;
  };
  return h;
}

if (setLockout && isTx) {
  section('the timer fires a millisecond early');
  {
    const h = harness();
    h.set(4000);
    ok(h.broadcasts[0] === true, 'the macro start broadcasts transmitting');
    ok(h.fireLive(1), 'the lockout timer is armed');
    ok(h.broadcasts[h.broadcasts.length - 1] === false, 'an early timer still ends the TX state (was: stuck on "ON AIR")');
  }

  section('the timer fires on time');
  {
    const h = harness();
    h.set(4000);
    h.fireLive(0);
    ok(h.broadcasts[h.broadcasts.length - 1] === false, 'an on-time timer ends the TX state');
  }

  section('a second macro extends the lockout');
  {
    const h = harness();
    h.set(4000);
    h.now += 1000;
    h.set(4000);
    ok(h.timers.filter((x) => !x.cleared).length === 1, 'only the newest timer is live');
    h.fireLive(1);
    ok(h.broadcasts[h.broadcasts.length - 1] === false, 'the extended lockout ends with its own timer');
  }

  section('another TX source is still keying');
  {
    const h = harness();
    h.set(4000);
    h.setRemote(true);
    h.fireLive(1);
    ok(h.broadcasts[h.broadcasts.length - 1] === true, 'PTT held elsewhere keeps the TX state when the lockout ends');
  }
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  process.exit(0);
}
finish();
