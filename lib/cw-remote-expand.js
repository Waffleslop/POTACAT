'use strict';

// CW text from an ECHOCAT device can arrive with {call}, {op_firstname} or
// {state} still in it. ECHOCAT Web expands them before sending; the mobile
// app never has, so a macro like "{call} 599 TU" keyed the braces, or
// nothing, instead of the station being worked (N4RDX 2026-10-11). main.js
// fills whatever is left, from the desktop's own view of the QSO. Pure.

const PLACEHOLDER = /\{(call|op_firstname|state)\}/i;

function hasPlaceholders(text) {
  return PLACEHOLDER.test(String(text || ''));
}

/**
 * @param {string} text
 * @param {{call?: string, opFirstname?: string, state?: string}} ctx
 * @returns {{ text: string, missingCall: boolean }}
 *   A {call} with no callsign to give it is removed (never keyed as braces),
 *   and missingCall says so, so the caller can log why.
 */
function expandRemoteCw(text, ctx) {
  const c = ctx || {};
  const call = String(c.call || '').trim().toUpperCase();
  let missingCall = false;
  let out = String(text || '').replace(/\{call\}/gi, () => {
    if (!call) missingCall = true;
    return call;
  });
  out = out
    .replace(/\{op_firstname\}/gi, String(c.opFirstname || '').trim() || 'OM')
    .replace(/\{state\}/gi, String(c.state || '').trim());
  // An empty substitution must not leave a double space in the keyed text.
  out = out.replace(/ {2,}/g, ' ').trim();
  return { text: out, missingCall };
}

module.exports = { hasPlaceholders, expandRemoteCw };
