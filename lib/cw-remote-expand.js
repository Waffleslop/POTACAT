'use strict';

// CW text from an ECHOCAT device can arrive with {call}, {op_firstname} or
// {state} still in it. The mobile app never expanded them, so a macro like
// "{call} 599 TU" keyed the braces, or nothing, instead of the station being
// worked (N4RDX 2026-10-11). main.js fills whatever is left, from the
// desktop's own view of the QSO. Pure.
//
// Dual-mode: ECHOCAT Web gets this file inlined by remote-server.js
// (window.CwRemoteExpand) and expands its own macros with expandForCall, so
// {op_firstname} and {state} are always the name and state of the callsign
// {call} sends. They used to come from the tuned spot while {call} came from
// the typed call, and with two spots on one frequency the web keyed one
// station's call with another operator's name (GitHub #524).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CwRemoteExpand = api;
}(typeof self !== 'undefined' ? self : this, function () {
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

  /**
   * Expand macros for ONE callsign: {call} is `call`, and {op_firstname} and
   * {state} are looked up for that same callsign in `opInfoByCall` (keyed by
   * base call, values { name, state }). A call with no entry gets 'OM' and no
   * state, never another station's details.
   * @param {string} text
   * @param {string} call
   * @param {Object<string, {name?: string, state?: string}>} opInfoByCall
   * @param {(call: string) => string} [baseCall] strips /P, VE3/ and the like
   */
  function expandForCall(text, call, opInfoByCall, baseCall) {
    const up = String(call || '').trim().toUpperCase();
    const key = up && typeof baseCall === 'function' ? String(baseCall(up) || '').toUpperCase() : up;
    const info = (key && opInfoByCall && Object.prototype.hasOwnProperty.call(opInfoByCall, key))
      ? opInfoByCall[key] : null;
    return expandRemoteCw(text, {
      call: up,
      opFirstname: info ? info.name : '',
      state: info ? info.state : '',
    });
  }

  return { hasPlaceholders, expandRemoteCw, expandForCall };
}));
