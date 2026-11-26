// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// JTCAT Run (ULTRACAT Full Auto CQ): why a start was refused, in words an
// operator can act on, and what TX is left as after the request (#1085).
//
// startFullAutoCq refuses for one of three causes. Each has its own code and
// its own sentence, for two audiences:
//   'shack' — the text that goes on the wire (jtcat-ultracat-state.reason) to
//             the JTCAT window on another computer and to the phone.
//   'here'  — the text for the JTCAT window on the same computer.
// The session time limit (lib/jtcat-session-limit.js) never refuses a start:
// starting Run starts its count. It stops a run later, with its own notice.
//
// Transmit safety: the JTCAT window's Run click asks for TX on together with
// the start (txOn). requestStart turns TX on before the start (as the old
// separate jtcat-enable-tx did) and, when the start is refused, leaves TX the
// way it was before the click: a refused Run never leaves TX enabled.
'use strict';

const CODES = Object.freeze({
  ULTRACAT_LOCKED: 'ultracat-locked',
  ENGINE_OFF: 'engine-off',
  NO_CALL_GRID: 'no-call-grid',
});

const TEXT = {
  'ultracat-locked': {
    shack: 'The shack has not unlocked ULTRACAT. Unlock it on the shack computer, then press Run again.',
    here: 'ULTRACAT is not unlocked on this computer.',
  },
  'engine-off': {
    shack: 'FT8 is not running at the shack. Start FT8, then press Run again.',
    here: 'FT8 is not running. Start FT8, then press Run again.',
  },
  'no-call-grid': {
    shack: 'The shack has no callsign or grid set. Set them in Settings on the shack computer.',
    here: 'Your callsign or grid is not set. Set them in Settings, then press Run again.',
  },
};
const UNKNOWN = { shack: 'The shack did not start Run.', here: 'Run did not start.' };

/** The operator's sentence for a refusal code. audience 'shack' (default) or 'here'. */
function text(code, audience) {
  const t = TEXT[code] || UNKNOWN;
  return audience === 'here' ? t.here : t.shack;
}

/** True for one of the three codes above. */
function isCode(code) { return Object.prototype.hasOwnProperty.call(TEXT, code); }

/**
 * The first check startFullAutoCq makes, before it touches any state:
 * '' = may start, else the code. The callsign/grid check needs the CQ built
 * and so happens later (CODES.NO_CALL_GRID).
 */
function precheck(o) {
  o = o || {};
  if (!o.ultracat) return CODES.ULTRACAT_LOCKED;
  if (!o.engine) return CODES.ENGINE_OFF;
  return '';
}

/**
 * One Run start request against the FT8 engine.
 *   engine   the engine (or null): only its _txEnabled is touched here
 *   txOn     the click asked for TX on with the start
 *   start    async (why) => boolean; sets why.code on a refusal
 *   onTxOn   called when TX is turned on (the transmit watchdog's "operator")
 * Returns { ok, code }. A refusal leaves TX off if it was off before.
 */
async function requestStart(o) {
  o = o || {};
  const engine = o.engine || null;
  const txBefore = !!(engine && engine._txEnabled);
  if (o.txOn && engine) {
    if (typeof o.onTxOn === 'function') o.onTxOn();
    engine._txEnabled = true;
  }
  const why = {};
  let ok = false;
  try { ok = !!(await o.start(why)); }
  finally {
    if (!ok && o.txOn && engine && !txBefore) engine._txEnabled = false;
  }
  return { ok, code: ok ? '' : (isCode(why.code) ? why.code : '') };
}

module.exports = { CODES, text, isCode, precheck, requestStart };
