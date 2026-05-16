// TX Audio EQ + Compressor chain — shared between the ECHOCAT audio
// bridge (renderer/remote-audio.html) and the VFO popout's PC-mic PTT
// path (renderer/vfo-popout.html). One source of truth for the preset
// values and the Web Audio wiring so a tweak lands everywhere.
//
// Usage:
//   const chain = TxEqChain.create(ctx);
//   TxEqChain.wire(chain, sourceNode, destNode, { enabled, preset });
//   // later, to retarget without rebuilding the AudioContext:
//   TxEqChain.wire(chain, sourceNode, destNode, { enabled: false });
//
// The chain object holds references to the nodes so `wire()` can tear
// them down on reconfigure without leaking. `destNode` is whatever
// consumes the audio: an AudioWorkletNode (dax-tx-chunk path) or
// ctx.destination (setSinkId path to a USB CODEC). The chain itself
// is identical either way.

(function (root) {
  'use strict';

  // Presets — same low/high shelf centers and compressor knobs as
  // documented in v1.6.0 release notes. Conservative defaults; the user
  // who needs more aggressive processing picks "DX". K3SBP 2026-05-16.
  const PRESETS = {
    ragchew: { lowGainDb: 0,  highGainDb: 0,  threshold: -24, ratio: 2, attack: 0.003, release: 0.25, knee: 30, makeupDb: 0 },
    pileup:  { lowGainDb: -3, highGainDb: 6,  threshold: -18, ratio: 4, attack: 0.003, release: 0.15, knee: 20, makeupDb: 4 },
    dx:      { lowGainDb: -6, highGainDb: 9,  threshold: -16, ratio: 6, attack: 0.001, release: 0.10, knee: 15, makeupDb: 6 },
  };
  // Default values for "Custom" if user opens it without ever tweaking.
  // Same shape as a preset; the renderer treats them identically.
  const CUSTOM_DEFAULTS = { lowGainDb: 0, highGainDb: 0, threshold: -24, ratio: 2, attack: 0.003, release: 0.25, knee: 30, makeupDb: 0 };

  // Range constraints for the UI sliders. Hard-clamped here so a bad
  // value over the WS bridge or a typo in a custom preset can't blow up
  // the Web Audio nodes (DynamicsCompressor throws on out-of-range).
  const PARAM_RANGES = {
    lowGainDb:  { min: -12, max: 12,  step: 0.5 },
    highGainDb: { min: -12, max: 12,  step: 0.5 },
    threshold:  { min: -60, max: 0,   step: 1   },
    ratio:      { min: 1,   max: 20,  step: 0.5 },
    attack:     { min: 0,   max: 1,   step: 0.001 },
    release:    { min: 0,   max: 1,   step: 0.01  },
    knee:       { min: 0,   max: 40,  step: 1   },
    makeupDb:   { min: 0,   max: 24,  step: 0.5 },
  };
  function clampParams(p) {
    const out = { ...CUSTOM_DEFAULTS, ...(p || {}) };
    for (const k of Object.keys(PARAM_RANGES)) {
      const r = PARAM_RANGES[k];
      const v = Number(out[k]);
      out[k] = Number.isFinite(v) ? Math.max(r.min, Math.min(r.max, v)) : CUSTOM_DEFAULTS[k];
    }
    return out;
  }
  const LOW_HZ  = 120;
  const HIGH_HZ = 2000;

  function dbToLinear(db) { return Math.pow(10, db / 20); }

  function create() {
    return { lowShelf: null, highShelf: null, compressor: null, makeup: null };
  }

  // Splice EQ + compressor between source and dest. When enabled=false,
  // connects source → dest directly (zero-cost passthrough). Tearing
  // down on every call keeps the function idempotent — fine to invoke
  // on every preset change without leaking AudioNodes.
  function wire(chain, ctx, source, dest, opts) {
    try { source.disconnect(); } catch (_) {}
    if (chain.lowShelf)   { try { chain.lowShelf.disconnect(); }   catch (_) {} chain.lowShelf   = null; }
    if (chain.highShelf)  { try { chain.highShelf.disconnect(); }  catch (_) {} chain.highShelf  = null; }
    if (chain.compressor) { try { chain.compressor.disconnect(); } catch (_) {} chain.compressor = null; }
    if (chain.makeup)     { try { chain.makeup.disconnect(); }     catch (_) {} chain.makeup     = null; }

    if (!opts || !opts.enabled) {
      source.connect(dest);
      return;
    }

    const presetName = opts.preset || 'ragchew';
    // "custom" preset uses opts.customParams (whatever the user dialed
    // in) rather than a baked PRESETS entry. Other preset names fall
    // back to PRESETS lookup, with ragchew as last resort.
    const p = (presetName === 'custom')
      ? clampParams(opts.customParams)
      : (PRESETS[presetName] || PRESETS.ragchew);

    chain.lowShelf = ctx.createBiquadFilter();
    chain.lowShelf.type = 'lowshelf';
    chain.lowShelf.frequency.value = LOW_HZ;
    chain.lowShelf.gain.value = p.lowGainDb;

    chain.highShelf = ctx.createBiquadFilter();
    chain.highShelf.type = 'highshelf';
    chain.highShelf.frequency.value = HIGH_HZ;
    chain.highShelf.gain.value = p.highGainDb;

    chain.compressor = ctx.createDynamicsCompressor();
    chain.compressor.threshold.value = p.threshold;
    chain.compressor.ratio.value     = p.ratio;
    chain.compressor.attack.value    = p.attack;
    chain.compressor.release.value   = p.release;
    chain.compressor.knee.value      = p.knee;

    chain.makeup = ctx.createGain();
    chain.makeup.gain.value = dbToLinear(p.makeupDb);

    // If caller provided meter taps, fan out at the appropriate points.
    // Pre-comp tap reads the input to the compressor (= post-EQ); post-
    // comp tap reads the output after makeup gain. Difference is the
    // gain reduction the user is asking the compressor for. Both taps
    // are AnalyserNodes the caller pre-created and owns.
    if (opts.preTap) {
      try { opts.preTap.disconnect(); } catch (_) {}
      chain.highShelf.connect(opts.preTap);
    }
    if (opts.postTap) {
      try { opts.postTap.disconnect(); } catch (_) {}
      chain.makeup.connect(opts.postTap);
    }

    source.connect(chain.lowShelf);
    chain.lowShelf.connect(chain.highShelf);
    chain.highShelf.connect(chain.compressor);
    chain.compressor.connect(chain.makeup);
    chain.makeup.connect(dest);
  }

  root.TxEqChain = { PRESETS, CUSTOM_DEFAULTS, PARAM_RANGES, clampParams, create, wire };
})(typeof window !== 'undefined' ? window : globalThis);
