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

  /**
   * What a toggle shows and what its click sends.
   * @param {{follows?: string}} slot
   * @param {object|null} state     the latest radio state on this surface
   * @param {boolean} lastSentOn    this surface's last-sent memory
   * @returns {{on: boolean, fromRadio: boolean, nextCommand: 'on'|'off'}}
   */
  function toggleView(slot, state, lastSentOn) {
    const radio = slot && slot.follows ? followedState(slot.follows, state) : null;
    const on = radio === null ? !!lastSentOn : radio;
    return { on, fromRadio: radio !== null, nextCommand: on ? 'off' : 'on' };
  }

  return { FOLLOWABLE, isFollowable, followedState, toggleView };
});
