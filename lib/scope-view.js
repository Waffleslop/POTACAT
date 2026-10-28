// lib/scope-view.js — what the band scope DRAWS, shared by every surface:
// the Band Scope pop-out, ECHOCAT Web (inlined by remote-server as
// <!-- scope-view-js -->) and, later, the JTCAT strip. Dual-mode: require()
// in Node for the tests, `window.ScopeView` in a page. No dependencies.
//
// Two halves (docs/scope-improvements-plan.md, Phase 0):
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

  /** x (px) for a bin index on a canvas `w` px wide holding `bins` points. */
  function binX(bin, bins, w) { return bins > 1 ? bin * (w - 1) / (bins - 1) : 0; }

  /**
   * The ONE trace painter. `ctx` is a canvas 2D context, `frame` is
   * { bins, peak } (0..255 levels, any length; peak may be null), `view` is
   * { w, h, dpr, axis, dialHz, spanHz, anchor, peakHold, fill, notice }
 * (fill/notice default on; a page with its own mode line sets notice false).
   * w/h are the canvas's backing-store pixels; dpr scales line widths.
   * Hooks for later phases (scales, passband, band edges) hang off `view`
   * and draw nothing until set.
   */
  function drawTrace(ctx, frame, view) {
    var v = view || {};
    var w = v.w || ctx.canvas.width, h = v.h || ctx.canvas.height;
    var dpr = v.dpr || 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Grid: ten divisions across, four down.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    var i, x, y;
    for (i = 1; i < 10; i++) {
      x = Math.round(i * w / 10) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (i = 1; i < 4; i++) {
      y = Math.round(i * h / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    var bins = frame && frame.bins;
    if (bins && bins.length > 1) {
      var n = bins.length;
      var toY = function (val) { return h - (val / 255) * (h - 6 * dpr) - 3 * dpr; };
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
    var axis = v.axis;
    if (axis && axis.hzPerBin && v.dialHz) {
      var b = (v.dialHz - axis.startHz) / axis.hzPerBin;
      if (b >= 0 && b <= axis.bins - 1) {
        x = Math.round(binX(b, axis.bins, w)) + 0.5;
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }

    // CURSOR / FIX on the FT-710: the edges are not readable, so say so.
    if (v.notice !== false && axis && !axis.known && v.spanHz && v.anchor && v.anchor !== 'center' && v.anchor !== 'pan') {
      ctx.fillStyle = 'rgba(240,165,0,0.9)';
      ctx.font = (11 * dpr) + 'px sans-serif';
      ctx.fillText(String(v.anchor).toUpperCase() + ' mode — the radio does not report this window’s edges; axis assumed around the dial', 8 * dpr, 14 * dpr);
    }
  }

  return {
    CHAR_PX: CHAR_PX,
    niceStep: niceStep, freqDecimals: freqDecimals, formatTickHz: formatTickHz,
    frequencyTicks: frequencyTicks, levelTicks: levelTicks,
    drawTrace: drawTrace,
  };
});
