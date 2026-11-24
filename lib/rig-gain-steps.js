/**
 * Preamp / attenuator STEP ladders and the pure resolver every layer shares.
 *
 * Most HF radios don't have an on/off preamp or attenuator — they have a
 * short ladder (Yaesu: IPO/AMP1/AMP2 and 6/12/18 dB; hamlib reports a real
 * dB list per backend). POTACAT modeled both as booleans, so the toggle
 * could only ever reach the FIRST step: KB2UXB's FT-710 went "off ↔ 6 dB"
 * and never 12/18, preamp "off ↔ AMP1" and never AMP2 (2026-08-04).
 *
 * A step is `{ v, label, short }` where `v` is the value handed to the codec
 * (a Yaesu P2 digit, or a hamlib dB level) and `v === 0` is always OFF.
 * `label` is for menus/tooltips, `short` for a compact button chip. A rig
 * that declares no ladder keeps the plain boolean path, so nothing changes
 * for models we haven't characterized.
 *
 * Dual-mode: Node `require()` gets `module.exports`; the browser (plain
 * <script> tag — the renderers have no require) gets `window.RigGainSteps`.
 * Tests: test/rig-gain-steps-test.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RigGainSteps = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Yaesu modern generation (FT-710 / FTDX10 / FT-991A / FTDX101 / FTDX3000):
  // PA0{n} n=0 IPO, 1 AMP1, 2 AMP2 — RA0{n} n=0 off, 1 6dB, 2 12dB, 3 18dB.
  // Icom two-stage preamp — the values ARE the CI-V 0x16 0x02 data byte
  // (0=off, 1=P.AMP1, 2=P.AMP2), same way the Yaesu values are the PA0x
  // digit. Attach per-model only where the hardware is CONFIRMED two-stage
  // (K6RBJ's IC-7100, 2026-08-14) — never guess a ladder.
  var ICOM_PREAMP_1_2 = [
    { v: 0, label: 'Off', short: '' },
    { v: 1, label: 'P.AMP1', short: '1' },
    { v: 2, label: 'P.AMP2', short: '2' },
  ];

  var YAESU_PREAMP_IPO_AMP1_AMP2 = [
    { v: 0, label: 'IPO', short: '' },
    { v: 1, label: 'AMP1', short: '1' },
    { v: 2, label: 'AMP2', short: '2' },
  ];
  var YAESU_ATT_6_12_18 = [
    { v: 0, label: 'Off', short: '' },
    { v: 1, label: '6 dB', short: '6' },
    { v: 2, label: '12 dB', short: '12' },
    { v: 3, label: '18 dB', short: '18' },
  ];

  /** True when `steps` is a usable ladder (>= 2 entries, first is OFF). */
  function hasSteps(steps) {
    return Array.isArray(steps) && steps.length >= 2 && Number(steps[0].v) === 0;
  }

  /** Normalize a raw ladder declaration; returns [] when unusable. */
  function normalizeSteps(steps) {
    if (!Array.isArray(steps)) return [];
    var out = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s == null) continue;
      var v = Number(typeof s === 'object' ? s.v : s);
      if (!isFinite(v) || v < 0) continue;
      var dupe = false;
      for (var j = 0; j < out.length; j++) if (out[j].v === v) dupe = true;
      if (dupe) continue;
      var label = (typeof s === 'object' && s.label) ? String(s.label)
        : (v === 0 ? 'Off' : String(v));
      var short = (typeof s === 'object' && s.short != null) ? String(s.short)
        : (v === 0 ? '' : label.replace(/\s*dB$/i, ''));
      out.push({ v: v, label: label, short: short });
    }
    out.sort(function (a, b) { return a.v - b.v; });
    return hasSteps(out) ? out : [];
  }

  /**
   * Resolve what a client asked for into a concrete step value.
   *
   * Accepts the legacy boolean (mobile clients and the pre-2026-08 desktop
   * send `value: true|false`) so an old client keeps working: `true` means
   * "the first ON step", `false` means off. A number is snapped to the
   * nearest declared step so a stale ladder can't send the radio a value it
   * will reject.
   *
   * @param {boolean|number} raw
   * @param {Array} steps  [] = no ladder declared
   * @returns {number} step value (0 = off)
   */
  function resolveStep(raw, steps) {
    var list = normalizeSteps(steps);
    if (typeof raw === 'boolean') {
      if (!raw) return 0;
      return list.length ? list[1].v : 1;
    }
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) return 0;
    if (!list.length) return 1; // no ladder — any truthy request is plain "on"
    var best = list[0];
    for (var i = 0; i < list.length; i++) {
      if (Math.abs(list[i].v - n) < Math.abs(best.v - n)) best = list[i];
    }
    return best.v;
  }

  /**
   * Next value when the operator taps a cycling control: advances through
   * the ladder and wraps back to OFF past the top, so one control reaches
   * every step and can always be turned off again.
   */
  function nextStep(current, steps) {
    var list = normalizeSteps(steps);
    if (!list.length) return current ? 0 : 1; // plain toggle
    var cur = resolveStep(current, list);
    var idx = 0;
    for (var i = 0; i < list.length; i++) if (list[i].v === cur) idx = i;
    return list[(idx + 1) % list.length].v;
  }

  /**
   * What a button that CLICKS (the VFO window's Preamp / Att) sends: the next
   * ladder step as a number on a rig with a ladder, a plain boolean toggle on
   * one without (the same rule as the main Rig panel's _bindGainStepBtn).
   */
  function clickValue(current, steps) {
    var list = normalizeSteps(steps);
    if (!list.length) return !current;
    return nextStep(current, list);
  }

  /**
   * The ladder a window should cycle at this dial frequency. A model whose
   * preamp is split per band (`targets` declared: FTX-1 PA0 HF/50, PA1 VHF,
   * PA2 UHF) has the whole ladder on HF/50 MHz but only off/on on 2 m and
   * 70 cm (Yaesu FTX-1 CAT manual 2508-C, PA command, PDF p.22). No targets,
   * or no frequency yet: the ladder as declared.
   */
  function ladderForFreq(steps, targets, hz) {
    var list = normalizeSteps(steps);
    if (!list.length) return [];
    if (Array.isArray(targets) && targets.length && Number(hz) >= 100e6) return list.slice(0, 2);
    return list;
  }

  /** Full display label for a value ('' when the ladder lacks it). */
  function stepLabel(value, steps) {
    var list = normalizeSteps(steps);
    for (var i = 0; i < list.length; i++) if (list[i].v === Number(value)) return list[i].label;
    return '';
  }

  /**
   * Button text for a cycling control: the base label alone when off, plus
   * the compact step marker when on ("Pre" → "Pre 2", "Att" → "Att 12").
   */
  function buttonLabel(base, value, steps) {
    var list = normalizeSteps(steps);
    if (!list.length || !value) return base;
    var short = '';
    for (var i = 0; i < list.length; i++) if (list[i].v === Number(value)) short = list[i].short;
    return short ? base + ' ' + short : base;
  }

  /**
   * Build a ladder from a hamlib dB list (rigctld `dump_caps` "Preamp: 10dB
   * 20dB"). Backends exact-match the dB against this list, so the probed
   * values ARE the ladder — POTACAT used to keep only the lowest and could
   * never reach the rest.
   */
  function stepsFromDbList(dbs) {
    if (!Array.isArray(dbs) || !dbs.length) return [];
    var seen = {};
    var uniq = [];
    for (var i = 0; i < dbs.length; i++) {
      var d = Number(dbs[i]);
      if (!isFinite(d) || d <= 0 || seen[d]) continue;
      seen[d] = true;
      uniq.push(d);
    }
    if (!uniq.length) return [];
    uniq.sort(function (a, b) { return a - b; });
    var out = [{ v: 0, label: 'Off', short: '' }];
    for (var k = 0; k < uniq.length; k++) {
      out.push({ v: uniq[k], label: uniq[k] + ' dB', short: String(uniq[k]) });
    }
    return out;
  }

  return {
    YAESU_PREAMP_IPO_AMP1_AMP2: YAESU_PREAMP_IPO_AMP1_AMP2,
    YAESU_ATT_6_12_18: YAESU_ATT_6_12_18,
    hasSteps: hasSteps,
    normalizeSteps: normalizeSteps,
    resolveStep: resolveStep,
    nextStep: nextStep,
    clickValue: clickValue,
    ladderForFreq: ladderForFreq,
    stepLabel: stepLabel,
    buttonLabel: buttonLabel,
    stepsFromDbList: stepsFromDbList,
    ICOM_PREAMP_1_2: ICOM_PREAMP_1_2,
  };
});
