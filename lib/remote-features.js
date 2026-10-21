/**
 * What works on a desktop that is driving a REMOTE shack — SHARED between
 * main, the renderer and tests.
 *
 * Desktop-to-desktop (docs/remote-desktop-parity-spec.md, A4): the worst
 * outcome in a remote UI is a control that looks live and does nothing, and
 * until 2026-10-21 that was every engine (FT8, CW, SSTV, JS8, scope) on a
 * paired laptop. Every rig-scoped feature is listed here with where it runs:
 *
 *   'shack'       — runs on the shack, driven over the link (works)
 *   'here'        — runs on this PC and needs no radio (works)
 *   'unavailable' — needs the radio on this PC; `reason` says what to do
 *
 * The renderer greys the entry points of an unavailable feature and answers
 * a click with the reason; main refuses the same feature's start IPC with the
 * SAME text, so the log and the screen agree. A feature bridged to the shack
 * flips to 'shack' here and nowhere else.
 *
 * Dual-mode: Node `require()` gets `module.exports`; the browser (plain
 * <script> tag) gets `window.RemoteFeatures`. No DOM or Node dependencies.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RemoteFeatures = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FEATURES = {
    rig:          { label: 'Rig controls',      where: 'shack' },
    vfo:          { label: 'VFO window',        where: 'shack' },
    audio:        { label: 'Audio and PTT',     where: 'shack' },
    jtcat:        { label: 'FT8 / FT4 / FT2, WSPR, PSK31, JTTY', where: 'unavailable',
                    elements: ['view-jtcat-btn', 'view-wspr-btn', 'view-psk31-btn', 'view-jtty-btn'],
                    reason: 'FT8 and the other digital modes are not yet driven over a remote link. Open them on the shack PC, or in ECHOCAT.' },
    cw:           { label: 'CW keyer',          where: 'shack' },
    voiceMacros:  { label: 'Voice macros',      where: 'shack' },
    sstv:         { label: 'SSTV',              where: 'unavailable',
                    elements: ['view-sstv-btn'],
                    reason: 'SSTV is not yet driven over a remote link. Open it on the shack PC, or in ECHOCAT.' },
    scope:        { label: 'Band Scope',        where: 'unavailable',
                    elements: ['view-scope-btn'],
                    reason: 'The Band Scope reads the radio on the shack. Open it on the shack PC, or in ECHOCAT.' },
    js8:          { label: 'JS8',               where: 'unavailable',
                    elements: ['view-js8call-btn'],
                    reason: 'JS8 runs through JS8Call on the shack PC. Use JS8Call there (Remote Desktop works), or the ECHOCAT app.' },
    mercury:      { label: 'Mercury HF data',   where: 'unavailable',
                    elements: ['view-mercury-btn'],
                    reason: 'Mercury runs beside the radio. Open it on the shack PC.' },
    stationSetup: { label: 'Station Setup',     where: 'unavailable',
                    elements: ['view-station-setup-btn'],
                    reason: 'Station Setup checks the radio on this PC. Run it on the shack PC; this desktop is driving a remote shack.' },
    wsjtx:        { label: 'WSJT-X Mode',       where: 'unavailable',
                    reason: 'WSJT-X Mode controls a radio on this PC. Run WSJT-X on the shack PC.' },
    // Native on this PC: spots, map, logbook, activator, propagation, contests,
    // DXCC, conditions, bandspread, the cluster terminal. Not listed: they
    // never touch the radio.
  };

  function feature(name) { return FEATURES[name] || null; }

  /** {ok:true} or {ok:false, reason} for `name` while driving a remote shack. */
  function check(name) {
    var f = FEATURES[name];
    if (!f) return { ok: true };
    if (f.where === 'unavailable') return { ok: false, reason: f.reason || (f.label + ' is not available while driving a remote shack.') };
    return { ok: true, where: f.where };
  }

  /** [{name, id, reason}] — every element to grey out in remote mode. */
  function unavailableElements() {
    var out = [];
    Object.keys(FEATURES).forEach(function (name) {
      var f = FEATURES[name];
      if (f.where !== 'unavailable') return;
      (f.elements || []).forEach(function (id) { out.push({ name: name, id: id, reason: f.reason }); });
    });
    return out;
  }

  return { FEATURES: FEATURES, feature: feature, check: check, unavailableElements: unavailableElements };
});
