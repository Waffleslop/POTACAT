/**
 * A custom CAT TOGGLE can follow a state POTACAT already reads from the radio
 * (LZ3AW 2026-10-17: "when I start POTACAT and SPLIT on the radio is ON, the
 * button should show ON, and the first click turns it OFF"). A plain toggle
 * can only show the last command it SENT — POTACAT cannot interpret every
 * rig's reply to a typed raw command — but split, NB, ATU, preamp and the rest
 * below are already read back from the radio by the codecs, so a toggle linked
 * to one of them lights from the radio's real state and its click sends
 * whichever of its two commands moves the radio AWAY from that state.
 *
 * Since #242 a toggle may also carry its OWN read: a command and an "ON when"
 * rule the operator types (parseOnRule below), read by main.js through
 * lib/custom-cat-read.js. A toggle with neither shows UNKNOWN until it has
 * sent something, rather than claiming OFF.
 *
 * One list for all three surfaces (desktop main window, VFO pop-out, ECHOCAT
 * Web — inlined into the page by remote-server like scope-axis), because the
 * state object each one receives names a few fields differently (the main
 * window's rig-state says atuActive, the VFO and ECHOCAT status say atu).
 *
 * Dual-mode: Node require() gets module.exports, a <script> gets
 * window.CustomCatFollow. Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CustomCatFollow = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // key → the label in the slot editor and the state fields that carry it,
  // first present wins.
  const FOLLOWABLE = [
    { key: 'split', label: 'Split', fields: ['split'] },
    { key: 'nb', label: 'NB', fields: ['nb'] },
    { key: 'nr', label: 'NR', fields: ['nr'] },
    { key: 'anf', label: 'ANF', fields: ['anf'] },
    { key: 'atu', label: 'ATU', fields: ['atuActive', 'atu'] },
    { key: 'preamp', label: 'Preamp', fields: ['preamp'] },
    { key: 'att', label: 'ATT', fields: ['att'] },
    { key: 'comp', label: 'Comp', fields: ['comp'] },
    { key: 'vox', label: 'VOX', fields: ['vox'] },
    { key: 'mon', label: 'Monitor', fields: ['mon'] },
    { key: 'rit', label: 'RIT', fields: ['rit', 'clarRx'] },
    { key: 'breakIn', label: 'Break-in', fields: ['breakIn'] },
  ];
  const BY_KEY = Object.create(null);
  for (const f of FOLLOWABLE) BY_KEY[f.key] = f;

  function isFollowable(key) { return !!BY_KEY[key]; }

  /**
   * The radio's state for a followed key: true / false, or null when the
   * state object does not carry it (rig not connected, unsupported, or an
   * older desktop) — the caller then falls back to last-sent.
   */
  function followedState(key, state) {
    const f = BY_KEY[key];
    if (!f || !state || typeof state !== 'object') return null;
    for (const field of f.fields) {
      const v = state[field];
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number' && Number.isFinite(v)) return v !== 0;
    }
    return null;
  }

  // --- Read state per button (GitHub #242) ---------------------------------
  //
  // A toggle may carry its own read: a command POTACAT sends (readCommand) and
  // a rule that says when the reply means ON (onWhen). Two rule forms, both
  // typed in the slot editor:
  //
  //   33=1        the reply's character 33 is "1" (the first character is 1,
  //               so for a Kenwood IF; reply the I of IF is character 1).
  //               The value may be longer than one character: 6=0123 compares
  //               characters 6..9.
  //   /SP1;?$/i   the reply matches this regular expression.
  //
  // main.js sends the reads (lib/custom-cat-read.js) and reports each result
  // under readKey(slot) in state.customCatStates: true, false, or null when
  // there was no usable answer.

  /** Parse an "ON when" rule. @returns {{kind:'char',pos:number,value:string}|{kind:'regex',re:RegExp}|{error:string}|null} */
  function parseOnRule(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const rx = /^\/(.+)\/([ims]*)$/.exec(t);
    if (rx) {
      try { return { kind: 'regex', re: new RegExp(rx[1], rx[2]) }; }
      catch (e) { return { error: 'not a valid regular expression' }; }
    }
    const ch = /^(\d{1,3})\s*=\s*(\S+)$/.exec(t);
    if (ch) {
      const pos = parseInt(ch[1], 10);
      if (pos < 1) return { error: 'character positions start at 1' };
      return { kind: 'char', pos, value: ch[2] };
    }
    return { error: 'use N=X (character N of the reply is X) or /regex/' };
  }

  /** Does a reply mean ON? true / false, or null when the reply cannot say. */
  function matchOnRule(rule, reply) {
    if (!rule || rule.error || typeof reply !== 'string' || !reply) return null;
    if (rule.kind === 'regex') return rule.re.test(reply);
    if (rule.kind === 'char') {
      if (reply.length < rule.pos - 1 + rule.value.length) return null; // too short to hold the field
      return reply.substr(rule.pos - 1, rule.value.length) === rule.value;
    }
    return null;
  }

  /** The slot's read, or null when it has none (or the rule is not valid). */
  function slotRead(slot) {
    if (!slot || typeof slot !== 'object' || slot.type !== 'toggle') return null;
    const cmd = String(slot.readCommand || '').trim();
    const rule = parseOnRule(slot.onWhen);
    if (!cmd || !rule || rule.error) return null;
    return { command: cmd, rule, key: cmd + '\n' + String(slot.onWhen).trim() };
  }

  /** Where a slot's read result lives in state.customCatStates. */
  function readKey(slot) {
    const r = slotRead(slot);
    return r ? r.key : null;
  }

  /** The read result for a slot from a state object: true / false / null. */
  function readState(slot, state) {
    const key = readKey(slot);
    if (!key || !state || typeof state !== 'object') return null;
    const all = state.customCatStates;
    if (!all || typeof all !== 'object') return null;
    const v = all[key];
    return typeof v === 'boolean' ? v : null;
  }

  /**
   * What a toggle shows and what its click sends.
   *
   * on is true / false, or null for UNKNOWN: the toggle has neither a radio
   * state nor anything it sent this session, so it must not claim OFF (an OFF
   * light over a radio already in SPLIT made the first click re-send ON —
   * LZ3AW, #242). An unknown toggle's click sends the On command.
   *
   * @param {{follows?: string, readCommand?: string, onWhen?: string}} slot
   * @param {object|null} state     the latest radio state on this surface
   * @param {boolean|undefined} lastSentOn  this surface's last-sent memory (undefined = nothing sent)
   * @returns {{on: boolean|null, fromRadio: boolean, nextCommand: 'on'|'off'}}
   */
  function toggleView(slot, state, lastSentOn) {
    let radio = slot && slot.follows ? followedState(slot.follows, state) : null;
    if (radio === null) radio = readState(slot, state);
    const on = radio !== null ? radio : (typeof lastSentOn === 'boolean' ? lastSentOn : null);
    return { on, fromRadio: radio !== null, nextCommand: on ? 'off' : 'on' };
  }

  return { FOLLOWABLE, isFollowable, followedState, toggleView, parseOnRule, matchOnRule, slotRead, readKey, readState };
});
