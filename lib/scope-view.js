// lib/scope-view.js — what the band scope DRAWS, shared by every surface:
// the Band Scope pop-out, ECHOCAT Web (inlined by remote-server as
// <!-- scope-view-js -->) and, later, the JTCAT strip. Dual-mode: require()
// in Node for the tests, `window.ScopeView` in a page. No dependencies.
//
// Two halves (docs/scope-improvements-plan.md, Phases 0-2):
//   - pure geometry — frequencyTicks / levelTicks — which the tests hold to
//     round numbers and non-overlapping labels at phone and desktop widths;
//   - one canvas 2D painter, drawTrace(), so a change to the trace is made
//     once and every surface shows it. It took the pop-out's look (grid,
//     filled trace, peak-hold line, dial marker, the "axis assumed" notice).
//
// Axis objects are lib/scope-axis.js scopeAxis() results.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScopeView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Estimated label width in px: ~6.5 px per character at the 10-11 px scope font. */
  var CHAR_PX = 6.5;
  var LABEL_GAP_PX = 12;

  /** 1, 2, 5 × 10^n at or above `x`. */
  function niceStep(x) {
    if (!(x > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(x)));
    var bases = [1, 2, 5, 10];
    for (var i = 0; i < bases.length; i++) if (bases[i] * p >= x - 1e-9 * p) return bases[i] * p;
    return 10 * p;
  }
  /** The next 1/2/5 step above `step`. */
  function nextStep(step) {
    var p = Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    var m = Math.round(step / p);
    return m < 2 ? 2 * p : m < 5 ? 5 * p : 10 * p;
  }

  /** MHz decimals a label needs at this step: kHz (3) at least, Hz (6) at most. */
  function freqDecimals(stepHz) {
    var d = 3;
    while (d < 6 && Math.round(stepHz) % Math.pow(10, 6 - d) !== 0) d++;
    return d;
  }

  /** "14.075" / "14.0745" — a tick label in MHz with the decimals the step needs. */
  function formatTickHz(hz, decimals) {
    return (Math.round(hz) / 1e6).toFixed(decimals);
  }

  /**
   * Round-number frequency ticks across `axis` drawn `widthPx` wide.
   * Returns { stepHz, decimals, major: [{hz, x, label}], minor: [{hz, x}] }.
   * The step is the smallest 1/2/5 × 10^n whose labels are at least
   * `minLabelPx` apart AND wider apart than the widest label plus a gap, so
   * no two labels overlap. x is in the same px as widthPx; bin 0 is x 0 and
   * the last bin is x widthPx - 1, as the trace draws them.
   */
  function frequencyTicks(axis, widthPx, opts) {
    var o = opts || {};
    var w = Number(widthPx) || 0;
    var out = { stepHz: 0, decimals: 3, major: [], minor: [] };
    if (!axis || !(axis.endHz > axis.startHz) || w < 2) return out;
    var span = axis.endHz - axis.startHz;
    var pxPerHz = (w - 1) / span;
    var minPx = o.minLabelPx || 70;
    var charPx = o.charPx || CHAR_PX;
    var step = niceStep(minPx / pxPerHz);
    for (var guard = 0; guard < 40; guard++) {
      var dec = freqDecimals(step);
      var widest = formatTickHz(axis.endHz, dec).length * charPx;
      if (step * pxPerHz >= Math.max(minPx, widest + LABEL_GAP_PX)) break;
      step = nextStep(step);
    }
    out.stepHz = step;
    out.decimals = freqDecimals(step);
    var p = Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    var minorStep = Math.round(step / p) === 2 ? step / 4 : step / 5;
    var first = Math.ceil(axis.startHz / minorStep - 1e-9) * minorStep;
    for (var hz = first; hz <= axis.endHz + 1e-6; hz += minorStep) {
      var r = Math.round(hz);
      var x = (r - axis.startHz) * pxPerHz;
      if (Math.abs(r / step - Math.round(r / step)) < 1e-6) out.major.push({ hz: r, x: x, label: formatTickHz(r, out.decimals) });
      else out.minor.push({ hz: r, x: x });
    }
    return out;
  }

  /**
   * Level lines for a scale { unit: 'dBm'|'radio'|'dB'|null, min, max } drawn
   * `heightPx` tall. With a unit: lines every 1/2/5 × 10^n dB (at least
   * `minPx` apart, default 18), labelled, y 0 at `max`. With no unit (an
   * uncalibrated source such as the FT-710): `divisions` (default 4) even,
   * UNLABELLED lines — a grid, never an invented number.
   * Returns { stepDb, lines: [{ y, value|null, label|null }] }.
   */
  function levelTicks(scale, heightPx, opts) {
    var o = opts || {};
    var h = Number(heightPx) || 0;
    var out = { stepDb: 0, lines: [] };
    if (h < 2) return out;
    var hasNumbers = scale && scale.unit && Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min;
    if (!hasNumbers) {
      var n = o.divisions || 4;
      for (var i = 1; i < n; i++) out.lines.push({ y: i * h / n, value: null, label: null });
      return out;
    }
    var range = scale.max - scale.min;
    var pxPerDb = h / range;
    var step = niceStep((o.minPx || 18) / pxPerDb);
    out.stepDb = step;
    // Top to bottom, so lines[] is in y order like the frequency ticks are in x.
    var first = Math.floor(scale.max / step + 1e-9) * step;
    for (var v = first; v >= scale.min - 1e-9; v -= step) {
      var val = Math.round(v * 1000) / 1000;
      var y = (scale.max - val) * pxPerDb;
      if (y <= 0.5 || y >= h - 0.5) continue;   // a line on the edge is the edge
      out.lines.push({ y: y, value: val, label: String(val) });
    }
    return out;
  }

  // ─── Levels: what a 0..255 level means, and the display window over it ──
  //
  // A source's levelScale { unit: 'dBm'|'radio'|'dB'|null, min, max } says
  // level 0 is `min` and 255 is `max` (main.js scopeLevelScale). The operator's
  // reference level and range pick a window [lo, hi] of LEVELS to fill the
  // trace (docs/scope-improvements-plan.md item 4): display only, the source's
  // data is untouched. The old Floor slider is exactly lo with hi = 255, so
  // applyRange(b, f, 255) === ScopeAxis.applyFloor(b, f) (the tests hold it).

  var MIN_RANGE = 16;   // levels; narrower than this and the trace is noise

  /** Averaging choices → the trace's smoothing factor (Light = the old look). */
  var AVERAGING = { off: 1, light: 0.55, medium: 0.3, heavy: 0.15 };
  /** Peak-hold decay choices → levels per frame (Slow = the old 0.6). */
  var PEAK_DECAY = { fast: 3, slow: 0.6, hold: 0 };
  /** Left level gutter width, CSS px. */
  var GUTTER_PX = 34;

  function clampRange(lo, hi) {
    var l = Math.round(Number(lo)); var h = Math.round(Number(hi));
    if (!Number.isFinite(l)) l = 0;
    if (!Number.isFinite(h)) h = 255;
    l = Math.max(0, Math.min(255 - MIN_RANGE, l));
    h = Math.max(l + MIN_RANGE, Math.min(255, h));
    return { lo: l, hi: h };
  }

  /** Move the window by `d` levels, keeping its width (stops at either end). */
  function shiftRange(r, d) {
    var w = r.hi - r.lo;
    var lo = Math.max(0, Math.min(255 - w, Math.round(r.lo + d)));
    return { lo: lo, hi: lo + w };
  }

  /** Widen (factor > 1) or narrow the window about its middle. */
  function zoomRange(r, factor) {
    var mid = (r.lo + r.hi) / 2;
    var w = Math.max(MIN_RANGE, Math.min(255, (r.hi - r.lo) * factor));
    var lo = mid - w / 2, hi = mid + w / 2;
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > 255) { lo -= hi - 255; hi = 255; }
    return clampRange(lo, hi);
  }

  /** Levels remapped so `lo` is the bottom of the trace and `hi` the top. */
  function applyRange(bins, lo, hi) {
    var r = clampRange(lo, hi);
    if (r.lo === 0 && r.hi === 255) return bins;
    var out = new Uint8Array(bins.length);
    var scale = 255 / (r.hi - r.lo);
    for (var i = 0; i < bins.length; i++) {
      var v = bins[i] - r.lo;
      out[i] = v <= 0 ? 0 : Math.min(255, Math.round(v * scale));
    }
    return out;
  }

  function hasUnit(scale) {
    return !!(scale && scale.unit && Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min);
  }

  /** The dB value of a level on a calibrated scale, else null. */
  function dbAtLevel(scale, level) {
    if (!hasUnit(scale) || !Number.isFinite(level)) return null;
    return scale.min + (level / 255) * (scale.max - scale.min);
  }

  /** The scale the trace SHOWS once the window [lo, hi] is applied. */
  function displayScale(scale, lo, hi) {
    if (!hasUnit(scale)) return { unit: null, min: 0, max: 255 };
    var r = clampRange(lo, hi);
    return { unit: scale.unit, min: dbAtLevel(scale, r.lo), max: dbAtLevel(scale, r.hi) };
  }

  /** "dBm" / "dB (radio)" / "dB over noise" — the gutter caption. */
  function unitLabel(unit) {
    return unit === 'dBm' ? 'dBm' : unit === 'radio' ? 'dB (radio)' : unit === 'dB' ? 'dB over noise' : '';
  }

  /** Exponential averaging of a new frame into `acc` (Float32Array, in place). */
  function smoothInto(acc, bins, alpha) {
    var a = Number(alpha);
    if (!(a > 0) || a > 1) a = AVERAGING.light;
    var k = 1 - a;
    for (var i = 0; i < acc.length && i < bins.length; i++) acc[i] = acc[i] * k + bins[i] * a;
    return acc;
  }

  /** Peak hold with decay `d` levels per frame (0 = hold until cleared). */
  function peakInto(peak, bins, d) {
    var dec = Number(d) || 0;
    for (var i = 0; i < peak.length && i < bins.length; i++) peak[i] = Math.max(peak[i] - dec, bins[i]);
    return peak;
  }

  /** S-unit marks (S9 = -73 dBm, 6 dB per unit; +10/+20/+40/+60 over S9) for a
   *  dBm scale drawn `heightPx` tall, at least 12 px apart. Others: none. */
  function sUnitMarks(scale, heightPx) {
    var out = [];
    var h = Number(heightPx) || 0;
    if (!hasUnit(scale) || scale.unit !== 'dBm' || h < 2) return out;
    var marks = [];
    for (var s = 1; s <= 9; s++) marks.push({ dbm: -73 - (9 - s) * 6, label: 'S' + s });
    [10, 20, 40, 60].forEach(function (o) { marks.push({ dbm: -73 + o, label: '+' + o }); });
    var pxPerDb = h / (scale.max - scale.min);
    var lastY = -Infinity;
    for (var i = marks.length - 1; i >= 0; i--) {   // top down
      var m = marks[i];
      if (m.dbm <= scale.min || m.dbm >= scale.max) continue;
      var y = (scale.max - m.dbm) * pxPerDb;
      if (y - lastY < 12) continue;
      out.push({ y: y, dbm: m.dbm, label: m.label });
      lastY = y;
    }
    return out;
  }

  /** The level under a pointer at `frac` (0..1) across `bins`. */
  function levelAt(bins, frac) {
    if (!bins || !bins.length) return null;
    var f = Math.max(0, Math.min(1, Number(frac) || 0));
    return bins[Math.round(f * (bins.length - 1))];
  }

  /**
   * The cursor readout: "14.07415 MHz · -92 dBm". The frequency carries the
   * precision a pointer can resolve at this span (ScopeAxis.snapTapHz's
   * steps: 10/50 Hz → five decimals, 100/500 Hz → four). The level part is
   * there only when the source is calibrated; never a number we do not have.
   */
  function formatReadout(hz, level, scale, spanHz) {
    if (!(hz > 0)) return '';
    var s = Number(spanHz) || 0;
    var step = s <= 10000 ? 10 : s <= 50000 ? 50 : s <= 200000 ? 100 : 500;
    var snapped = Math.round(hz / step) * step;
    var text = (snapped / 1e6).toFixed(step < 100 ? 5 : 4) + ' MHz';
    var db = dbAtLevel(scale, level);
    if (db != null) {
      var v = Math.round(db);
      if (scale.unit === 'dBm') text += ' · ' + v + ' dBm';
      else if (scale.unit === 'radio') text += ' · ' + v + ' dB (radio scale)';
      else text += ' · ' + (v > 0 ? '+' : '') + v + ' dB over noise';
    }
    return text;
  }

  /** Frequency ticks in device px, the same call for the trace grid and the strip. */
  function ticksFor(axis, w, dpr) {
    var d = dpr || 1;
    return frequencyTicks(axis, w, { minLabelPx: 70 * d, charPx: CHAR_PX * d });
  }

  /** x (px) for a bin index on a canvas `w` px wide holding `bins` points. */
  function binX(bin, bins, w) { return bins > 1 ? bin * (w - 1) / (bins - 1) : 0; }

  /**
   * The ONE trace painter. `ctx` is a canvas 2D context, `frame` is
   * { bins, peak } (0..255 DISPLAY levels — already through applyRange — any
   * length; peak may be null), `view` is
   * { w, h, dpr, axis, dialHz, spanHz, anchor, peakHold, fill, notice,
   *   scale, gutter, sUnits }:
   *   fill/notice default on (a page with its own mode line sets notice false);
   *   scale = the DISPLAYED level scale (displayScale), lines on round dB
   *   values when it has a unit, four even unlabelled lines when it has none;
   *   gutter = draw the level labels in a left gutter; sUnits = S-unit marks
   *   on the right (dBm only).
   * w/h are the canvas's backing-store pixels; dpr scales line widths.
   * Vertical grid lines sit on the frequency scale's round ticks whenever the
   * axis has a span, so the grid and the strip under it agree.
   */
  function drawTrace(ctx, frame, view) {
    var v = view || {};
    var w = v.w || ctx.canvas.width, h = v.h || ctx.canvas.height;
    var dpr = v.dpr || 1;
    var axis = v.axis;
    var pad = 3 * dpr;          // the trace keeps 3 px clear at top and bottom
    var plotH = h - 2 * pad;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    var i, x, y;
    // Vertical: on the frequency ticks, else ten divisions.
    var ft = axis && axis.hzPerBin ? ticksFor(axis, w, dpr) : null;
    if (ft && ft.major.length) {
      for (i = 0; i < ft.major.length; i++) {
        x = Math.round(ft.major[i].x) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    } else {
      for (i = 1; i < 10; i++) {
        x = Math.round(i * w / 10) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    // Horizontal: dB lines for a calibrated scale, else four even divisions.
    var calibrated = hasUnit(v.scale);
    var lt = calibrated ? levelTicks(v.scale, plotH) : levelTicks(null, h);
    for (i = 0; i < lt.lines.length; i++) {
      y = Math.round(lt.lines[i].y + (calibrated ? pad : 0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    var bins = frame && frame.bins;
    if (bins && bins.length > 1) {
      var n = bins.length;
      var toY = function (val) { return h - (val / 255) * plotH - pad; };
      var peak = frame.peak;
      if (v.peakHold && peak && peak.length === n) {
        ctx.strokeStyle = 'rgba(240,165,0,0.55)';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        for (i = 0; i < n; i++) {
          x = binX(i, n, w);
          if (i === 0) ctx.moveTo(x, toY(peak[i])); else ctx.lineTo(x, toY(peak[i]));
        }
        ctx.stroke();
      }
      if (v.fill !== false) {
        var grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(79,195,247,0.55)');
        grad.addColorStop(1, 'rgba(79,195,247,0.05)');
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (i = 0; i < n; i++) ctx.lineTo(binX(i, n, w), toY(bins[i]));
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.strokeStyle = '#4fc3f7';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        x = binX(i, n, w);
        if (i === 0) ctx.moveTo(x, toY(bins[i])); else ctx.lineTo(x, toY(bins[i]));
      }
      ctx.stroke();
    }

    // Dial marker.
    if (axis && axis.hzPerBin && v.dialHz) {
      var b = (v.dialHz - axis.startHz) / axis.hzPerBin;
      if (b >= 0 && b <= axis.bins - 1) {
        x = Math.round(binX(b, axis.bins, w)) + 0.5;
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }

    // Phase 3 overlay (passband, split TX, band plan, dial flag) sits on the
    // trace but under the level gutter, so the labels stay readable.
    if (v.overlay) {
      var ov = v.overlay;
      drawOverlay(ctx, { w: w, h: h, dpr: dpr, axis: axis, dialHz: v.dialHz, passband: ov.passband, txHz: ov.txHz,
        bandPlan: ov.bandPlan, privileges: ov.privileges, labels: ov.labels, flag: ov.flag });
    }

    // Level gutter: a darkened band at the left with the dB labels.
    if (v.gutter && calibrated) {
      var gw = GUTTER_PX * dpr;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, gw, h);
      ctx.fillStyle = 'rgba(200,210,225,0.85)';
      ctx.font = (10 * dpr) + 'px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      // The unit caption owns the top corner; a label that would sit under it
      // gives way (its grid line stays).
      for (i = 0; i < lt.lines.length; i++) {
        if (lt.lines[i].y + pad < 18 * dpr) continue;
        ctx.fillText(lt.lines[i].label, gw - 3 * dpr, lt.lines[i].y + pad);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(200,210,225,0.6)';
      ctx.fillText(unitLabel(v.scale.unit), 3 * dpr, 2 * dpr);
      ctx.textBaseline = 'alphabetic';
    }
    // S-units on the right (dBm only).
    if (v.sUnits && calibrated && v.scale.unit === 'dBm') {
      var marks = sUnitMarks(v.scale, plotH);
      ctx.font = (10 * dpr) + 'px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(240,165,0,0.85)';
      for (i = 0; i < marks.length; i++) ctx.fillText(marks[i].label, w - 3 * dpr, marks[i].y + pad);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // CURSOR / FIX on the FT-710: the edges are not readable, so say so.
    if (v.notice !== false && axis && !axis.known && v.spanHz && v.anchor && v.anchor !== 'center' && v.anchor !== 'pan') {
      ctx.fillStyle = 'rgba(240,165,0,0.9)';
      ctx.font = (11 * dpr) + 'px sans-serif';
      ctx.fillText(String(v.anchor).toUpperCase() + ' mode — the radio does not report this window’s edges; axis assumed around the dial', (v.gutter && calibrated ? GUTTER_PX + 8 : 8) * dpr, 14 * dpr);
    }
  }

  /**
   * The frequency scale strip under the trace (plan item 1): round-number
   * ticks and labels from the same ticks the trace grid uses, the dial as a
   * red tick with its frequency, and "axis assumed" in amber when the window's
   * edges are not reported (FT-710 CURSOR/FIX) — never a confident label for
   * a guessed axis. `view` = { w, h, dpr, axis, dialHz }.
   */
  function drawFreqScale(ctx, view) {
    var v = view || {};
    var w = v.w || ctx.canvas.width, h = v.h || ctx.canvas.height;
    var dpr = v.dpr || 1;
    var axis = v.axis;
    ctx.fillStyle = '#0b0b16';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, 0, w, Math.max(1, Math.round(dpr)));
    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'bottom';
    if (!axis || !axis.hzPerBin) {
      ctx.fillStyle = 'rgba(200,210,225,0.5)';
      ctx.textAlign = 'center';
      ctx.fillText('—', w / 2, h - 2 * dpr);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      return;
    }
    var assumed = !axis.known;
    var tickColor = assumed ? 'rgba(240,165,0,0.7)' : 'rgba(200,210,225,0.55)';
    var labelColor = assumed ? 'rgba(240,165,0,0.9)' : 'rgba(200,210,225,0.85)';
    var t = ticksFor(axis, w, dpr);
    var i, x;
    ctx.fillStyle = tickColor;
    for (i = 0; i < t.minor.length; i++) ctx.fillRect(Math.round(t.minor[i].x), 0, Math.max(1, Math.round(dpr)), 3 * dpr);
    for (i = 0; i < t.major.length; i++) ctx.fillRect(Math.round(t.major[i].x), 0, Math.max(1, Math.round(dpr)), 6 * dpr);

    // The dial's own label is drawn first so round labels give way to it.
    var dialBox = null;
    if (v.dialHz) {
      var b = (v.dialHz - axis.startHz) / axis.hzPerBin;
      if (b >= 0 && b <= axis.bins - 1) {
        x = binX(b, axis.bins, w);
        var dlabel = formatTickHz(v.dialHz, Math.max(3, freqDecimals(Math.round(v.dialHz / 10) * 10)));
        var dw = ctx.measureText ? ctx.measureText(dlabel).width : dlabel.length * CHAR_PX * dpr;
        var dx0 = Math.max(0, Math.min(w - dw - 6 * dpr, x - dw / 2 - 3 * dpr));
        dialBox = { x0: dx0, x1: dx0 + dw + 6 * dpr };
        ctx.fillStyle = '#e94560';
        ctx.fillRect(Math.round(x), 0, Math.max(1, Math.round(1.5 * dpr)), h);
        ctx.fillStyle = 'rgba(11,11,22,0.92)';
        ctx.fillRect(dx0, 7 * dpr, dw + 6 * dpr, h - 7 * dpr);
        ctx.fillStyle = '#e94560';
        ctx.fillText(dlabel, dx0 + 3 * dpr, h - 2 * dpr);
      }
    }
    ctx.fillStyle = labelColor;
    for (i = 0; i < t.major.length; i++) {
      var m = t.major[i];
      var lw = ctx.measureText ? ctx.measureText(m.label).width : m.label.length * CHAR_PX * dpr;
      var x0 = Math.max(0, Math.min(w - lw, m.x - lw / 2));
      if (dialBox && x0 < dialBox.x1 + 2 * dpr && x0 + lw > dialBox.x0 - 2 * dpr) continue;
      ctx.fillText(m.label, x0, h - 2 * dpr);
    }
    if (assumed) {
      ctx.fillStyle = 'rgba(240,165,0,0.95)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('axis assumed', w - 3 * dpr, 1 * dpr);
      ctx.textAlign = 'left';
    }
    ctx.textBaseline = 'alphabetic';
  }

  // ─── Phase 3: the receiver and the band plan drawn on the scope ──────────
  // Colours shared by every surface (and the phone handoff).
  var OVERLAY = {
    dial: '#e94560',
    tx: '#f0a500',
    passFill: 'rgba(255,255,255,0.10)',
    passEdge: 'rgba(255,255,255,0.45)',
    dim: 'rgba(0,0,0,0.55)',
    hatch: 'rgba(233,69,96,0.30)',
    seg: { cw_digi: '#4fc3f7', phone: '#4ecca3', all: '#b39ddb' },
    dialTick: '#ffd54f',
  };

  /** x (px) of a frequency on this axis, or null when outside the window. */
  function hzToX(axis, hz, w) {
    if (!axis || !axis.hzPerBin || !(hz > 0)) return null;
    var b = (hz - axis.startHz) / axis.hzPerBin;
    if (b < 0 || b > axis.bins - 1) return null;
    return binX(b, axis.bins, w);
  }
  /** x (px) clamped to the canvas, for spans that run off either edge. */
  function hzToXClamped(axis, hz, w) {
    var b = (hz - axis.startHz) / axis.hzPerBin;
    if (b < 0) b = 0;
    if (b > axis.bins - 1) b = axis.bins - 1;
    return binX(b, axis.bins, w);
  }

  /** The passband in absolute Hz from scope-state's dial offsets. */
  function passbandHz(pb, dialHz) {
    if (!pb || !(dialHz > 0) || !(pb.hiOffsetHz > pb.loOffsetHz)) return null;
    return { loHz: dialHz + pb.loOffsetHz, hiHz: dialHz + pb.hiOffsetHz, reported: !!pb.reported, kind: pb.kind || null };
  }

  /** [lo, hi] spans clipped to the window, as px. Empty spans dropped. */
  function spansToPx(axis, w, spans) {
    var out = [];
    if (!axis || !axis.hzPerBin) return out;
    var winLo = axis.startHz, winHi = axis.endHz;
    for (var i = 0; i < spans.length; i++) {
      var lo = Math.max(winLo, spans[i].loHz), hi = Math.min(winHi, spans[i].hiHz);
      if (hi <= lo) continue;
      var o = { x0: hzToXClamped(axis, lo, w), x1: hzToXClamped(axis, hi, w) };
      if (spans[i].kind) o.kind = spans[i].kind;
      if (o.x1 - o.x0 >= 0.5) out.push(o);
    }
    return out;
  }

  /**
   * The band plan as px for this window: dim (outside the band), hatch
   * (inside the band, outside the operator's privileges — only when a class
   * is set and `privileges` is on), segs (the allowed ranges, for the line
   * along the bottom), dials ({x, label}).
   */
  function bandPlanGeometry(plan, axis, w, opts) {
    var o = opts || {};
    var g = { dim: [], hatch: [], segs: [], dials: [], classLabel: null };
    if (!plan || !axis || !axis.hzPerBin) return g;
    g.dim = spansToPx(axis, w, [{ loHz: -Infinity, hiHz: plan.loHz }, { loHz: plan.hiHz, hiHz: Infinity }]);
    if (o.privileges !== false && Array.isArray(plan.allowed)) {
      var allowed = plan.allowed.slice().sort(function (a, b) { return a.loHz - b.loHz; });
      var gaps = [], at = plan.loHz;
      for (var i = 0; i < allowed.length; i++) {
        if (allowed[i].loHz > at) gaps.push({ loHz: at, hiHz: allowed[i].loHz });
        if (allowed[i].hiHz > at) at = allowed[i].hiHz;
      }
      if (at < plan.hiHz) gaps.push({ loHz: at, hiHz: plan.hiHz });
      g.hatch = spansToPx(axis, w, gaps);
      g.segs = spansToPx(axis, w, allowed);
      if (g.hatch.length) g.classLabel = plan.classLabel || null;
    }
    var dials = plan.dials || [];
    for (var k = 0; k < dials.length; k++) {
      var x = hzToX(axis, dials[k].hz, w);
      if (x != null) g.dials.push({ x: x, label: dials[k].label });
    }
    return g;
  }

  function hatchRect(ctx, x0, x1, h, dpr, color) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, h); ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * dpr;
    var step = 8 * dpr;
    for (var s = x0 - h; s < x1; s += step) {
      ctx.beginPath(); ctx.moveTo(s, h); ctx.lineTo(s + h, 0); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Draw the overlay over a trace drawn by drawTrace (same canvas, same w/h).
   * view = { w, h, dpr, axis, dialHz, passband (scope-state offsets), txHz,
   *   bandPlan, privileges (default true), labels (default true), flag
   *   (default true: the dial's frequency in a flag at the top) }.
   * Strips pass labels:false — edges and shading only.
   */
  function drawOverlay(ctx, view) {
    var v = view || {};
    var w = v.w || ctx.canvas.width, h = v.h || ctx.canvas.height;
    var dpr = v.dpr || 1;
    var axis = v.axis;
    if (!axis || !axis.hzPerBin) return;
    var labels = v.labels !== false;
    var i, x;
    ctx.font = (10 * dpr) + 'px sans-serif';

    // Band plan: dim outside the band, hatch outside privileges.
    var g = bandPlanGeometry(v.bandPlan, axis, w, { privileges: v.privileges });
    ctx.fillStyle = OVERLAY.dim;
    for (i = 0; i < g.dim.length; i++) ctx.fillRect(g.dim[i].x0, 0, g.dim[i].x1 - g.dim[i].x0, h);
    for (i = 0; i < g.hatch.length; i++) hatchRect(ctx, g.hatch[i].x0, g.hatch[i].x1, h, dpr, OVERLAY.hatch);
    if (labels && g.classLabel) {
      // One label, in the widest hatched stretch that fits it.
      var text = 'Outside ' + g.classLabel;
      var tw = ctx.measureText ? ctx.measureText(text).width : text.length * CHAR_PX * dpr;
      var best = null;
      for (i = 0; i < g.hatch.length; i++) if (!best || g.hatch[i].x1 - g.hatch[i].x0 > best.x1 - best.x0) best = g.hatch[i];
      if (best && best.x1 - best.x0 >= tw + 8 * dpr) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(best.x0 + 4 * dpr, h - 26 * dpr, tw + 6 * dpr, 13 * dpr);
        ctx.fillStyle = 'rgba(255,170,180,0.95)';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, best.x0 + 7 * dpr, h - 19.5 * dpr);
      }
    }
    // The allowed segments as a 3 px line along the bottom.
    for (i = 0; i < g.segs.length; i++) {
      ctx.fillStyle = OVERLAY.seg[g.segs[i].kind] || OVERLAY.seg.all;
      ctx.fillRect(g.segs[i].x0, h - 3 * dpr, g.segs[i].x1 - g.segs[i].x0, 3 * dpr);
    }
    // Digital-mode dials: a short tick from the bottom, labelled when room.
    var lastLabelX = -Infinity;
    ctx.textBaseline = 'alphabetic';
    for (i = 0; i < g.dials.length; i++) {
      x = Math.round(g.dials[i].x);
      ctx.fillStyle = OVERLAY.dialTick;
      ctx.fillRect(x, h - 10 * dpr, Math.max(1, Math.round(dpr)), 7 * dpr);
      if (labels && x - lastLabelX > 34 * dpr) {
        ctx.fillText(g.dials[i].label, Math.min(w - 30 * dpr, x + 3 * dpr), h - 5 * dpr);
        lastLabelX = x;
      }
    }

    // Passband: filled when reported, a dashed outline labelled "nominal" when not.
    var pb = passbandHz(v.passband, v.dialHz);
    if (pb) {
      var px = spansToPx(axis, w, [pb]);
      if (px.length) {
        var x0 = px[0].x0, x1 = Math.max(px[0].x1, px[0].x0 + 1);
        ctx.strokeStyle = OVERLAY.passEdge;
        ctx.lineWidth = 1 * dpr;
        if (pb.reported) {
          ctx.fillStyle = OVERLAY.passFill;
          ctx.fillRect(x0, 0, x1 - x0, h);
          ctx.beginPath();
          ctx.moveTo(Math.round(x0) + 0.5, 0); ctx.lineTo(Math.round(x0) + 0.5, h);
          ctx.moveTo(Math.round(x1) + 0.5, 0); ctx.lineTo(Math.round(x1) + 0.5, h);
          ctx.stroke();
        } else {
          ctx.save();
          if (ctx.setLineDash) ctx.setLineDash([4 * dpr, 3 * dpr]);
          ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(1, Math.round(x1 - x0)), h - 1);
          ctx.restore();
          if (labels && x1 - x0 > 40 * dpr) {
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.textBaseline = 'top';
            ctx.fillText('nominal', x0 + 3 * dpr, 16 * dpr);
          }
        }
      }
    }

    // TX marker while split.
    if (v.txHz) {
      x = hzToX(axis, v.txHz, w);
      if (x != null) {
        x = Math.round(x) + 0.5;
        ctx.strokeStyle = OVERLAY.tx;
        ctx.lineWidth = 1.5 * dpr;
        ctx.save();
        if (ctx.setLineDash) ctx.setLineDash([6 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.restore();
        if (labels) { ctx.fillStyle = OVERLAY.tx; ctx.textBaseline = 'top'; ctx.fillText('TX', Math.min(w - 16 * dpr, x + 3 * dpr), 2 * dpr); }
      }
    }

    // Dial flag: the frequency in the dial colour at the top of the trace.
    if (labels && v.flag !== false && v.dialHz) {
      x = hzToX(axis, v.dialHz, w);
      if (x != null) {
        var fl = formatTickHz(v.dialHz, Math.max(3, freqDecimals(Math.round(v.dialHz / 10) * 10)));
        var fw = (ctx.measureText ? ctx.measureText(fl).width : fl.length * CHAR_PX * dpr) + 8 * dpr;
        var fx = x + 2 * dpr + fw > w ? x - 2 * dpr - fw : x + 2 * dpr;
        ctx.fillStyle = OVERLAY.dial;
        ctx.fillRect(fx, 1 * dpr, fw, 13 * dpr);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(fl, fx + 4 * dpr, 7.5 * dpr);
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  /** Waterfall markers for the passband edges (thin lines, never a fill). */
  function passbandMarkers(passband, dialHz, axis) {
    var pb = passbandHz(passband, dialHz);
    if (!pb || !axis || !axis.hzPerBin) return [];
    var out = [];
    var edges = [pb.loHz, pb.hiHz];
    for (var i = 0; i < 2; i++) {
      var b = (edges[i] - axis.startHz) / axis.hzPerBin;
      if (b >= 0 && b <= axis.bins - 1) out.push({ pos: b / (axis.bins - 1), color: [1, 1, 1, pb.reported ? 0.45 : 0.3], kind: 'passband' });
    }
    return out;
  }

  return {
    OVERLAY: OVERLAY, hzToX: hzToX, passbandHz: passbandHz, spansToPx: spansToPx, bandPlanGeometry: bandPlanGeometry,
    drawOverlay: drawOverlay, passbandMarkers: passbandMarkers,
    CHAR_PX: CHAR_PX, GUTTER_PX: GUTTER_PX, MIN_RANGE: MIN_RANGE, AVERAGING: AVERAGING, PEAK_DECAY: PEAK_DECAY,
    niceStep: niceStep, freqDecimals: freqDecimals, formatTickHz: formatTickHz,
    frequencyTicks: frequencyTicks, levelTicks: levelTicks, ticksFor: ticksFor,
    clampRange: clampRange, shiftRange: shiftRange, zoomRange: zoomRange, applyRange: applyRange,
    dbAtLevel: dbAtLevel, displayScale: displayScale, unitLabel: unitLabel,
    smoothInto: smoothInto, peakInto: peakInto, sUnitMarks: sUnitMarks, levelAt: levelAt, formatReadout: formatReadout,
    drawTrace: drawTrace, drawFreqScale: drawFreqScale,
  };
});
