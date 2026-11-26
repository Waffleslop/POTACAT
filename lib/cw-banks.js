'use strict';

// CW macro banks (#741): one for Activator (Run), one for Hunter (S&P).
//
// The layout is positional, F1 to F12, as N1MM Logger+ lays out its function
// keys (n1mmwp.hamdocs.com, "Function Keys, Messages and Macros", section
// "ESM - Enter Sends Message", read 2026-11-23): Enter Sends Message uses
// F1 CQ, F2 exchange, F3 TU, F4 my call, F5 his call, F8 again. The key is the
// role; the label is only a label. POTACAT adds one key N1MM leaves empty in
// its CW example: F7 is the park-to-park exchange, sent in place of F2 when
// the contact is park to park. The messages themselves are POTACAT's own.
//
// Storage: settings.cwMacros stays the Hunter (S&P) bank, so a phone on an
// older ECHOCAT keeps reading and writing it as `remoteCwMacros`;
// settings.cwMacrosRun is the Activator (Run) bank. A first load copies the
// operator's existing macros into the Run bank unchanged, so no F key sends
// anything new on the air until the operator chooses the new layout.
//
// Variables: {CALL} (alias {call}), {MYSTATE}, {PARK}, {RST}, {NR},
// {MYGRID}, {op_firstname} and {state} are filled by expandVars from the
// renderer's own fields. {MYCALL}, {mycallsign} and {greeting} pass through
// untouched: main fills them at the one CW sink (onAirCall, expandCwGreeting).
// Any other {word} is dropped and reported, never keyed as braces.
//
// Dual-mode: require() in node, window.CwBanks in a page.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CwBanks = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const BANK_KEYS = 12;
  const MAX_ROWS = 25;

  // The keys Enter Sends Message reads, zero-based slot per role.
  const ROLE_SLOT = Object.freeze({ CQ: 0, EXCH: 1, TU: 2, MYCALL: 3, CALL: 4, P2P: 6, AGN: 7 });

  const RUN_DEFAULTS = Object.freeze([
    { label: 'CQ', text: 'CQ POTA DE {MYCALL} {MYCALL} K' },
    { label: 'EXCH', text: '5NN {MYSTATE}' },
    { label: 'TU', text: 'TU 73 {MYCALL}' },
    { label: 'MYCALL', text: '{MYCALL}' },
    { label: 'CALL', text: '{CALL}' },
    { label: 'RPT', text: '5NN {MYSTATE} {MYSTATE}' },
    { label: 'P2P', text: '5NN {MYSTATE} {PARK}' },
    { label: 'AGN', text: 'AGN?' },
    { label: 'ST?', text: 'ST?' },
    { label: 'CALL?', text: 'CALL?' },
    { label: 'PARK', text: '{PARK}' },
    { label: 'QRL?', text: 'QRL?' },
  ].map(Object.freeze));

  const SP_DEFAULTS = Object.freeze([
    { label: 'CQ', text: 'CQ POTA DE {MYCALL} {MYCALL} K' },
    { label: 'EXCH', text: '5NN {MYSTATE}' },
    { label: 'TU', text: 'TU 73' },
    { label: 'MYCALL', text: '{MYCALL}' },
    { label: 'CALL', text: '{CALL}' },
    { label: 'RPT', text: '5NN {MYSTATE} {MYSTATE}' },
    { label: 'P2P', text: '5NN {MYSTATE} {PARK}' },
    { label: 'AGN', text: 'AGN?' },
    { label: 'ST?', text: 'ST?' },
    { label: 'CALL?', text: 'CALL?' },
    { label: 'PARK', text: '{PARK}' },
    { label: 'RR', text: 'RR TU 73' },
  ].map(Object.freeze));

  // The set POTACAT shipped before #741 (renderer/app.js). Kept to recognise
  // an operator who never changed it, never to send it.
  const LEGACY_DEFAULTS = Object.freeze([
    { label: 'CQ', text: 'CQ CQ CQ DE {MYCALL} {MYCALL} K' },
    { label: '599', text: '{call} UR 599 {state} BK' },
    { label: '73', text: '{call} TNX {op_firstname} 73 DE {MYCALL} E E' },
    { label: 'AGN', text: 'AGN AGN PSE' },
    { label: 'TU', text: 'TU DE {MYCALL} K' },
  ].map(Object.freeze));

  function cleanRow(m) {
    if (!m || typeof m !== 'object') return { label: '', text: '' };
    return { label: String(m.label == null ? '' : m.label).slice(0, 12), text: String(m.text == null ? '' : m.text).slice(0, 500) };
  }
  function cleanBank(list) {
    if (!Array.isArray(list)) return null;
    return list.slice(0, MAX_ROWS).map(cleanRow);
  }
  function copy(list) { return list.map((m) => ({ label: m.label, text: m.text })); }
  function hasAny(list) { return Array.isArray(list) && list.some((m) => m && ((m.label || '').length || (m.text || '').length)); }

  /**
   * The two banks from settings, migrating on first load.
   * @returns {{ run: Array, sp: Array, migrated: boolean }}
   *   migrated is true when the Run bank was made now (the caller saves it).
   */
  function banksFromSettings(s) {
    s = s || {};
    const sp = hasAny(s.cwMacros) ? cleanBank(s.cwMacros) : copy(LEGACY_DEFAULTS);
    if (Array.isArray(s.cwMacrosRun)) return { run: cleanBank(s.cwMacrosRun), sp, migrated: false };
    // First load: the operator's macros as they are, in both banks.
    return { run: copy(sp), sp, migrated: true };
  }

  function defaultsFor(bank) { return copy(bank === 'run' ? RUN_DEFAULTS : SP_DEFAULTS); }

  function slotText(bank, role) {
    const i = ROLE_SLOT[role];
    if (i == null || !Array.isArray(bank)) return '';
    const m = bank[i];
    return m && typeof m.text === 'string' ? m.text : '';
  }

  /**
   * Is this bank laid out for Enter Sends Message? F4 must send my call and F5
   * their call, the two keys that tell a contest layout from an old free-form
   * set (whose F5 was "TU DE {MYCALL} K"). An old set never drives ESM: the
   * operator is asked to load the layout first.
   */
  function esmReady(bank) {
    const f4 = slotText(bank, 'MYCALL');
    const f5 = slotText(bank, 'CALL');
    return /\{(MYCALL|mycallsign)\}/i.test(f4) && /\{call\}/i.test(f5)
      && !!slotText(bank, 'CQ').trim() && !!slotText(bank, 'EXCH').trim() && !!slotText(bank, 'TU').trim();
  }

  // Filled here from the renderer's context.
  const LOCAL_VARS = ['call', 'mystate', 'park', 'rst', 'nr', 'mygrid', 'op_firstname', 'state'];
  // Left for main, which fills them at the one CW sink.
  const MAIN_VARS = ['mycall', 'mycallsign', 'greeting'];
  const KNOWN = new Set([...LOCAL_VARS, ...MAIN_VARS]);

  function unknownVars(text) {
    const out = [];
    String(text || '').replace(/\{([^{}]*)\}/g, (all, name) => {
      if (!KNOWN.has(String(name).toLowerCase())) out.push(all);
      return all;
    });
    return out;
  }

  // Cut numbers in a report: 599 -> 5NN. Only 9 is cut, the one every CW
  // operator reads the same way.
  function cutRst(rst) {
    return String(rst || '').trim().toUpperCase().replace(/9/g, 'N');
  }

  /**
   * Fill the variables this side owns; drop unknown {words}; leave {MYCALL},
   * {mycallsign} and {greeting} for main.
   * ctx: { call, myState, park, rst, nr, myGrid, opFirstname, state }
   * @returns {{ text: string, unknown: string[], missing: string[] }}
   *   missing: ['{MYGRID}'] when the macro needs a grid and none is set;
   *   text is then '' and nothing is keyed.
   */
  function expandVars(text, ctx) {
    ctx = ctx || {};
    const unknown = [];
    const val = {
      call: String(ctx.call || '').trim().toUpperCase(),
      mystate: String(ctx.myState || '').trim().toUpperCase(),
      park: String(ctx.park || '').trim().toUpperCase(),
      rst: cutRst(ctx.rst || '599'),
      nr: ctx.nr == null || ctx.nr === '' ? '' : String(ctx.nr),
      mygrid: String(ctx.myGrid || '').trim().toUpperCase(),
      op_firstname: String(ctx.opFirstname || ''),
      state: String(ctx.state || '').trim().toUpperCase(),
    };
    // {MYGRID} with no grid set: the whole macro is refused (text ''), never
    // keyed as "QTH" with nothing after it. missing names it for the caller.
    if (!val.mygrid && /\{mygrid\}/i.test(String(text || ''))) {
      return { text: '', unknown, missing: ['{MYGRID}'] };
    }
    let out = String(text || '').replace(/\{([^{}]*)\}/g, (all, name) => {
      const k = String(name).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(val, k)) return val[k];
      if (MAIN_VARS.includes(k)) return all;
      unknown.push(all);
      return '';
    });
    // A stray brace left over (an unclosed "{CALL") is never keyed either.
    const kept = [];
    out = out.replace(/\{(mycall|mycallsign|greeting)\}/gi, (all) => { kept.push(all); return '\u0001'; })
      .replace(/[{}]/g, '')
      .replace(/\u0001/g, () => kept.shift());
    return { text: out.replace(/\s+/g, ' ').trim(), unknown, missing: [] };
  }

  return {
    BANK_KEYS, MAX_ROWS, ROLE_SLOT, RUN_DEFAULTS, SP_DEFAULTS, LEGACY_DEFAULTS,
    banksFromSettings, defaultsFor, slotText, esmReady, unknownVars, expandVars, cutRst,
  };
}));
