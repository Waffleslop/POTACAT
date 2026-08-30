#!/usr/bin/env node
'use strict';
// FTX_MAX_MESSAGE_LENGTH must cover the LONGEST line any decoder can emit.
//
// SP9LOP, Ubuntu 26.04, 2026-08-29: two segfaults in ft8_native.node, both a
// WRITE (error 6) to an unmapped address that was the low 32 bits of the stack
// pointer — an adjacent stack pointer whose top half an overflow had zeroed —
// and both at the same module offset. Cause: callers size their output buffer
// with FTX_MAX_MESSAGE_LENGTH and the decoders write into it UNBOUNDED. The
// macro was 35, correct for a standard message, but POTACAT added two longer
// types to this codec (ARRL Field Day ~39, DXpedition/fox dual ~52), so a
// received message of either kind smashed up to 17 bytes of the caller's stack.
//
// This test recomputes the worst case FROM THE DECODERS rather than trusting a
// number in a comment: it reads the pieces each decoder appends and checks the
// macro still covers the largest. Add a message type, and this fails until the
// buffer grows.
// Run: node test/ft8-message-buffer-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const NAT = (...f) => path.join(__dirname, '..', 'lib', 'ft8_native', ...f);
const HDR = fs.readFileSync(NAT('ft8_lib', 'ft8', 'message.h'), 'utf8');
const MSG = fs.readFileSync(NAT('ft8_lib', 'ft8', 'message.c'), 'utf8');
const ADDON = fs.readFileSync(NAT('ft8_addon.c'), 'utf8');

function macroValue() {
  const m = HDR.match(/#define\s+FTX_MAX_MESSAGE_LENGTH\s+(\d+)/);
  assert.ok(m, 'FTX_MAX_MESSAGE_LENGTH not found');
  return parseInt(m[1], 10);
}

/** Body of a decoder function, for measuring what it appends. */
function bodyOf(fnName) {
  const at = MSG.indexOf(fnName);
  assert.notStrictEqual(at, -1, 'decoder not found: ' + fnName);
  const open = MSG.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < MSG.length; i++) {
    if (MSG[i] === '{') depth++;
    else if (MSG[i] === '}') { depth--; if (depth === 0) break; }
  }
  return MSG.slice(open, i);
}

// A callsign field is char[14] => at most 13 chars + NUL. Bracketed hashed
// calls ("<KH1/KH7Z>") are already bounded by that same buffer.
const CALL_MAX = 13;

/**
 * Worst-case bytes a decoder writes, INCLUDING the terminator.
 *
 * Deliberately CONSERVATIVE: every callsign field is credited its full 13
 * characters even where the format cannot reach that, so the estimate runs a
 * little high (the standard decoder measures 42 here against a true 35). For a
 * buffer bound, over-counting is the safe direction — the assertion is that the
 * buffer is at least this big, never that the estimate is exact.
 */
function worstCase(fnName) {
  const body = bodyOf(fnName);
  let total = 1; // NUL
  // Literal appends: append_string(x, "...")
  for (const m of body.matchAll(/append_string\([^,]+,\s*"([^"]*)"\)/g)) {
    total += m[1].length;
  }
  // Variable appends: callsign-shaped buffers and small scratch buffers.
  for (const m of body.matchAll(/append_string\([^,]+,\s*([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
    const name = m[1];
    const decl = body.match(new RegExp('char\\s+' + name + '\\[(\\d+)\\]'));
    if (decl) total += parseInt(decl[1], 10) - 1;     // buffer minus its NUL
    else total += CALL_MAX;                            // call_to / call1 / foxcall...
  }
  // Sections are appended from a table of fixed strings (ARRL sections are
  // short, but count generously rather than parse the table).
  if (/arrl_fd_sections\[/.test(body)) total += 4;
  return total;
}

const DECODERS = [
  'ftx_message_decode_std',
  'ftx_message_decode_nonstd',
  'ftx_message_decode_arrl_fd',
];

test('the macro covers every decoder that appends into the caller buffer', () => {
  const cap = macroValue();
  for (const fn of DECODERS) {
    if (MSG.indexOf(fn) === -1) continue; // type not present in this build
    const need = worstCase(fn);
    assert.ok(cap >= need,
      `${fn} can write ${need} bytes but FTX_MAX_MESSAGE_LENGTH is ${cap}`);
  }
});

test('the DXpedition dual message fits (the 52-byte case that crashed)', () => {
  // "K1ABC RR73; W9XYZ <KH1/KH7Z> -08" — call + " RR73; " + call + " " +
  // foxcall + " " + report + NUL.
  const need = CALL_MAX + ' RR73; '.length + CALL_MAX + 1 + CALL_MAX + 1 + 3 + 1;
  assert.strictEqual(need, 52, 'worst-case arithmetic drifted: ' + need);
  assert.ok(macroValue() >= need,
    `a received DXpedition message writes ${need} bytes into a ${macroValue()}-byte buffer`);
});

test('it is bigger than the old 35 — the value that shipped the crash', () => {
  assert.ok(macroValue() > 35, 'still at the size that smashed the stack');
});

test('the addon still sizes its decode buffer FROM the macro', () => {
  // If this ever becomes a bare literal, raising the macro stops protecting it.
  assert.ok(/char text\[FTX_MAX_MESSAGE_LENGTH\]/.test(ADDON),
    'addon no longer sizes its text buffer from the macro');
});

test('the header documents how to recompute the bound', () => {
  const at = HDR.indexOf('FTX_MAX_MESSAGE_LENGTH');
  const doc = HDR.slice(Math.max(0, at - 1600), at);
  assert.ok(/DXpedition/.test(doc) && /Field Day/.test(doc),
    'the long message types are not documented at the macro');
});

console.log(`\nFT8 message buffer: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
