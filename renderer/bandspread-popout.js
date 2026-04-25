'use strict';

// Bandspread pop-out renderer — horizontal strip showing spots on a single HF/VHF band
// with mode-segment shading and per-license-class privilege overlay.

// Inlined to avoid any contextBridge serialization concerns. Mirror of lib/bands.js.
const BANDS = {
  '160m': { lower: 1.800, upper: 2.000 },
  '80m':  { lower: 3.500, upper: 4.000 },
  '60m':  { lower: 5.330, upper: 5.410 },
  '40m':  { lower: 7.000, upper: 7.300 },
  '30m':  { lower: 10.100, upper: 10.150 },
  '20m':  { lower: 14.000, upper: 14.350 },
  '17m':  { lower: 18.068, upper: 18.168 },
  '15m':  { lower: 21.000, upper: 21.450 },
  '12m':  { lower: 24.890, upper: 24.990 },
  '10m':  { lower: 28.000, upper: 29.700 },
  '6m':   { lower: 50.000, upper: 54.000 },
  '4m':   { lower: 70.000, upper: 70.500 },
  '2m':   { lower: 144.000, upper: 148.000 },
  '70cm': { lower: 420.000, upper: 450.000 },
};

// Mirror of lib/privileges.js PRIVILEGE_MAP (US + Canadian classes only used for overlay).
const PRIVILEGE_MAP = {
  us_extra: [
    [1800, 2000, 'all'], [3500, 3600, 'cw_digi'], [3600, 4000, 'phone'],
    [7000, 7125, 'cw_digi'], [7125, 7300, 'phone'],
    [10100, 10150, 'all'], [14000, 14150, 'cw_digi'], [14150, 14350, 'phone'],
    [18068, 18168, 'all'], [21000, 21200, 'cw_digi'], [21200, 21450, 'phone'],
    [24890, 24990, 'all'], [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'],
    [50000, 54000, 'all'],
  ],
  us_general: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3800, 4000, 'phone'],
    [7025, 7125, 'cw_digi'], [7175, 7300, 'phone'],
    [10100, 10150, 'all'], [14025, 14150, 'cw_digi'], [14225, 14350, 'phone'],
    [18068, 18168, 'all'], [21025, 21200, 'cw_digi'], [21275, 21450, 'phone'],
    [24890, 24990, 'all'], [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'],
    [50000, 54000, 'all'],
  ],
  us_technician: [
    [3525, 3600, 'cw_digi'], [7025, 7125, 'cw_digi'],
    [21025, 21200, 'cw_digi'], [28000, 28300, 'cw_digi'], [28300, 28500, 'phone'],
    [50000, 54000, 'all'],
  ],
  ca_basic: [[50000, 54000, 'all']],
  ca_honours: [
    [1800, 2000, 'all'], [3500, 4000, 'all'], [7000, 7300, 'all'],
    [10100, 10150, 'all'], [14000, 14350, 'all'], [18068, 18168, 'all'],
    [21000, 21450, 'all'], [24890, 24990, 'all'], [28000, 29700, 'all'],
    [50000, 54000, 'all'],
  ],
};

// Band selector order (UI order, not object order)
const BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m', '70cm'];

let settings = null;
let selectedBand = '20m';
let licenseClass = 'none';
let allSpots = [];
let currentVfoKhz = 0;
// Zoom/pan state — viewport in kHz, a subset of the current band's edges.
// null values mean "use full band range"; set to finite numbers when zoomed/panned.
let viewLo = null;
let viewHi = null;
const MIN_ZOOM_SPAN_KHZ = 2; // tightest zoom
// Font / UI scale — applied to both HTML chrome (via --bs-scale CSS var) and canvas text.
let fontScale = 1.0;
const FONT_SCALE_MIN = 0.7;
const FONT_SCALE_MAX = 2.2;
const FONT_SCALE_STEPS = [0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.2];

const canvas = document.getElementById('bs-canvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('bs-canvas-wrap');
const infoEl = document.getElementById('bs-info');
const tooltipEl = document.getElementById('bs-tooltip');
const bandSelectEl = document.getElementById('bs-band-select');

// --- Titlebar controls ---
document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
document.getElementById('tb-close').addEventListener('click', () => window.api.close());

document.getElementById('bs-font-dec').addEventListener('click', () => nudgeFontScale(-1));
document.getElementById('bs-font-inc').addEventListener('click', () => nudgeFontScale(1));

// Ctrl/Cmd + '+' / '-' / '0' for font size (matches most apps).
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '+' || e.key === '=') { e.preventDefault(); nudgeFontScale(1); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); nudgeFontScale(-1); }
  else if (e.key === '0') { e.preventDefault(); applyFontScale(1.0); }
});

if (window.api.platform === 'darwin') document.body.classList.add('platform-darwin');

// --- Theme + tune-blocked feedback ---
window.api.onTheme((theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  draw();
});
window.api.onTuneBlocked((msg) => {
  infoEl.textContent = msg || 'Tune blocked';
  infoEl.style.color = 'var(--accent-red)';
  setTimeout(() => {
    infoEl.style.color = '';
    updateSpotCount();
  }, 2200);
});

// --- Band selector dropdown ---
function buildBandSelect() {
  bandSelectEl.innerHTML = '';
  for (const name of BAND_ORDER) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    bandSelectEl.appendChild(o);
  }
  bandSelectEl.value = selectedBand;
  bandSelectEl.addEventListener('change', () => selectBand(bandSelectEl.value));
}

function selectBand(name) {
  if (!BANDS[name] || name === selectedBand) return;
  selectedBand = name;
  viewLo = null;
  viewHi = null;
  if (bandSelectEl.value !== name) bandSelectEl.value = name;
  persistState();
  draw();
}

function resetZoom() {
  viewLo = null;
  viewHi = null;
  draw();
}

function applyFontScale(newScale, { persist = true } = {}) {
  const s = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, newScale));
  fontScale = s;
  document.body.style.setProperty('--bs-scale', String(s));
  const valEl = document.getElementById('bs-font-val');
  if (valEl) valEl.textContent = Math.round(s * 100) + '%';
  if (persist) persistState();
  draw();
}

function nudgeFontScale(direction) {
  // Snap to the next step in the requested direction for a pleasant progression.
  const current = fontScale;
  if (direction > 0) {
    const next = FONT_SCALE_STEPS.find(v => v > current + 0.001);
    applyFontScale(next != null ? next : FONT_SCALE_MAX);
  } else {
    let prev = null;
    for (const v of FONT_SCALE_STEPS) { if (v < current - 0.001) prev = v; }
    applyFontScale(prev != null ? prev : FONT_SCALE_MIN);
  }
}

// Resolve the current view range — falls back to the full band if unset.
function currentView() {
  const b = BANDS[selectedBand];
  if (!b) return null;
  const bandLo = b.lower * 1000;
  const bandHi = b.upper * 1000;
  let lo = viewLo != null ? viewLo : bandLo;
  let hi = viewHi != null ? viewHi : bandHi;
  // Clamp to band edges and enforce min span.
  lo = Math.max(bandLo, lo);
  hi = Math.min(bandHi, hi);
  if (hi - lo < MIN_ZOOM_SPAN_KHZ) hi = lo + MIN_ZOOM_SPAN_KHZ;
  return { lo, hi, bandLo, bandHi };
}

// --- Persistence ---
let persistTimer = null;
function persistState() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!settings) return;
    window.api.saveSettings({
      bandspreadBand: selectedBand,
      bandspreadFontScale: fontScale,
    });
  }, 300);
}

// --- Data pipelines ---
// onSpots is the legacy unfiltered feed (kept for safety). Once the main
// renderer reports in via onView, we stop honoring onSpots so the user's
// active filters / source toggles aren't quietly bypassed here.
let _haveFilteredView = false;
window.api.onSpots((data) => {
  if (_haveFilteredView) return;
  allSpots = Array.isArray(data) ? data : [];
  draw();
});

if (window.api.onView) {
  window.api.onView((payload) => {
    _haveFilteredView = true;
    allSpots = Array.isArray(payload && payload.spots) ? payload.spots : [];
    // Auto-follow the band the main window is "on" (single visible band, or
    // the band of the current radio freq when Table is multi-band).
    if (payload && payload.band && BANDS[payload.band] && payload.band !== selectedBand) {
      selectedBand = payload.band;
      viewLo = null;
      viewHi = null;
      if (bandSelectEl && bandSelectEl.value !== selectedBand) bandSelectEl.value = selectedBand;
      persistState();
    }
    draw();
  });
}

window.api.onFrequencyUpdate((freqKhz) => {
  currentVfoKhz = parseFloat(freqKhz) || 0;
  draw();
});

// --- Geometry / drawing ---
// Layout plan:
//   title row (HTML)                              — external
//   toolbar (HTML)                                — external
//   [top pad] spot labels                         — ~60% of canvas height, labels stacked upward from ruler
//   frequency ruler + tick labels                 — ~14 px strip
//   mode segment legend (CW / data / phone)       — ~14 px strip
//   privilege hatching (overlayed on everything)  — across full height above the ruler
//   VFO cursor (if known)                         — vertical line

// Layout base constants at 100% font scale. draw() multiplies text sizes and
// the vertical strip heights by fontScale so the whole bandspread grows together.
const RULER_H_BASE = 14;
const MODE_STRIP_H_BASE = 14;
const BOTTOM_PAD = 4;
const LABEL_ROW_H_BASE = 11;
const LABEL_PAD = 2;
const MARKER_HEAD_BASE = 6;  // triangle tick height just above ruler
const LEFT_PAD = 6;
const RIGHT_PAD = 6;
const RULER_FONT_BASE = 10;
const MODE_FONT_BASE = 9;
const LABEL_FONT_BASE = 10;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function bandKhzRange(name) {
  const b = BANDS[name];
  if (!b) return null;
  return { lo: b.lower * 1000, hi: b.upper * 1000 };
}

function freqToX(freqKhz, left, right, lo, hi) {
  return left + ((freqKhz - lo) / (hi - lo)) * (right - left);
}

function xToFreq(x, left, right, lo, hi) {
  return lo + ((x - left) / (right - left)) * (hi - lo);
}

// Merge overlapping [lo,hi] ranges
function unionRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const [lo, hi] = sorted[i];
    if (lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// For mode-segment shading: union of cw_digi and phone ranges across ALL US license classes
// intersected with the current band. 'all' ranges contribute to neither (they're open).
function computeModeSegmentsForBand(bandLo, bandHi) {
  const cw = [];
  const ph = [];
  // Use US classes as the mode-layout reference; Canadian Honours is 'all' everywhere
  // so wouldn't contribute here anyway.
  for (const cls of ['us_extra', 'us_general', 'us_technician']) {
    const ranges = PRIVILEGE_MAP[cls] || [];
    for (const [lo, hi, kind] of ranges) {
      if (hi < bandLo || lo > bandHi) continue;
      const clo = Math.max(lo, bandLo);
      const chi = Math.min(hi, bandHi);
      if (kind === 'cw_digi') cw.push([clo, chi]);
      else if (kind === 'phone') ph.push([clo, chi]);
    }
  }
  return { cw: unionRanges(cw), phone: unionRanges(ph) };
}

// For the current license class: returns permitted and forbidden ranges within the band.
// Forbidden = (band) minus (permitted-any-mode).
function computeUserPrivsForBand(bandLo, bandHi, cls) {
  if (!cls || cls === 'none') return { permitted: [[bandLo, bandHi]], forbidden: [] };
  const ranges = PRIVILEGE_MAP[cls];
  if (!ranges) return { permitted: [[bandLo, bandHi]], forbidden: [] };
  const perm = [];
  for (const [lo, hi] of ranges) {
    if (hi < bandLo || lo > bandHi) continue;
    perm.push([Math.max(lo, bandLo), Math.min(hi, bandHi)]);
  }
  const permitted = unionRanges(perm);
  const forbidden = [];
  let cursor = bandLo;
  for (const [lo, hi] of permitted) {
    if (lo > cursor) forbidden.push([cursor, lo]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < bandHi) forbidden.push([cursor, bandHi]);
  return { permitted, forbidden };
}

// Pick a spot's "best mode" for classification: prefer explicit `mode`, else infer from freq via privileges.
function spotMode(s) {
  return (s.mode || '').toUpperCase();
}

// --- Spot filtering + label layout ---
function filteredSpotsForBand(bandLo, bandHi) {
  return allSpots.filter(s => {
    if (!s) return false;
    const fkhz = parseFloat(s.frequency);
    if (!isFinite(fkhz)) return false;
    return fkhz >= bandLo && fkhz <= bandHi;
  });
}

// Simple interval packing: assign each label to the lowest row index where it doesn't horizontally overlap
// any earlier label in the same row. Returns [{spot, x, width, row}].
function layoutLabels(spots, xForFreq, ctx, labelText) {
  const items = spots.map(s => ({
    spot: s,
    text: labelText(s),
    x: xForFreq(parseFloat(s.frequency)),
  })).sort((a, b) => a.x - b.x);
  const rows = []; // each row = array of {left, right}
  for (const it of items) {
    it.width = ctx.measureText(it.text).width + 6;
    const left = it.x - it.width / 2;
    const right = it.x + it.width / 2;
    let placed = -1;
    for (let r = 0; r < rows.length; r++) {
      const tail = rows[r][rows[r].length - 1];
      if (!tail || tail.right + 2 < left) {
        rows[r].push({ left, right });
        placed = r;
        break;
      }
    }
    if (placed === -1) {
      rows.push([{ left, right }]);
      placed = rows.length - 1;
    }
    it.row = placed;
  }
  return items;
}

function sourceColor(src) {
  switch (src) {
    case 'pota': return cssVar('--source-pota');
    case 'sota': return cssVar('--source-sota');
    case 'dxc':  return cssVar('--source-dxc');
    case 'rbn':  return cssVar('--source-rbn');
    case 'net':  return cssVar('--source-net');
    case 'wwff': return cssVar('--source-wwff');
    case 'pskr': return cssVar('--source-pskr');
    default:     return cssVar('--text-secondary');
  }
}

function pickTickStep(spanKhz) {
  if (spanKhz <= 80) return 5;
  if (spanKhz <= 250) return 10;
  if (spanKhz <= 600) return 25;
  if (spanKhz <= 2500) return 100;
  if (spanKhz <= 6000) return 250;
  return 1000;
}

// Re-layout cache for hit testing
let lastLayout = null; // { spots: [{spot, x, row, cx}], lo, hi, left, right, labelBaseY, rowH }

function draw() {
  resizeCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  ctx.fillStyle = cssVar('--bg-primary');
  ctx.fillRect(0, 0, w, h);

  const view = currentView();
  if (!view) return;
  const { lo, hi } = view;

  // Scale the layout constants with the user's font size.
  const sc = fontScale;
  const RULER_H = Math.round(RULER_H_BASE * sc);
  const MODE_STRIP_H = Math.round(MODE_STRIP_H_BASE * sc);
  const LABEL_ROW_H = Math.round(LABEL_ROW_H_BASE * sc);
  const MARKER_HEAD = Math.round(MARKER_HEAD_BASE * sc);
  const RULER_FONT = Math.max(8, Math.round(RULER_FONT_BASE * sc));
  const MODE_FONT = Math.max(7, Math.round(MODE_FONT_BASE * sc));
  const LABEL_FONT = Math.max(8, Math.round(LABEL_FONT_BASE * sc));

  const left = LEFT_PAD;
  const right = w - RIGHT_PAD;
  const rulerY = h - BOTTOM_PAD - MODE_STRIP_H - RULER_H;
  const modeStripY = h - BOTTOM_PAD - MODE_STRIP_H;
  const spotsBottomY = rulerY;
  const spotsTopY = 8;
  const xOf = (f) => freqToX(f, left, right, lo, hi);

  // Mode segments (union across US classes)
  const segs = computeModeSegmentsForBand(lo, hi);

  // 1. Background mode stripe (subtle) above the ruler — shows where CW/digital and phone live.
  const tintCw = cssVar('--accent-blue');
  const tintPhone = cssVar('--source-sota');
  ctx.globalAlpha = 0.08;
  for (const [a, b] of segs.cw) {
    ctx.fillStyle = tintCw;
    ctx.fillRect(xOf(a), spotsTopY, xOf(b) - xOf(a), spotsBottomY - spotsTopY);
  }
  for (const [a, b] of segs.phone) {
    ctx.fillStyle = tintPhone;
    ctx.fillRect(xOf(a), spotsTopY, xOf(b) - xOf(a), spotsBottomY - spotsTopY);
  }
  ctx.globalAlpha = 1;

  // 2. User privilege overlay — hatch forbidden regions
  const privs = computeUserPrivsForBand(lo, hi, licenseClass);
  if (privs.forbidden.length) {
    for (const [a, b] of privs.forbidden) {
      const x0 = xOf(a);
      const x1 = xOf(b);
      // Dim fill
      ctx.fillStyle = cssVar('--bg-primary');
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x0, spotsTopY, x1 - x0, spotsBottomY - spotsTopY);
      ctx.globalAlpha = 1;
      // Diagonal hatch
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, spotsTopY, x1 - x0, spotsBottomY - spotsTopY);
      ctx.clip();
      ctx.strokeStyle = cssVar('--text-dim');
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      const step = 6;
      for (let x = x0 - (spotsBottomY - spotsTopY); x < x1 + (spotsBottomY - spotsTopY); x += step) {
        ctx.beginPath();
        ctx.moveTo(x, spotsTopY);
        ctx.lineTo(x + (spotsBottomY - spotsTopY), spotsBottomY);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // 3. Frequency ruler ticks + labels
  ctx.fillStyle = cssVar('--bg-secondary');
  ctx.fillRect(left, rulerY, right - left, RULER_H);
  ctx.strokeStyle = cssVar('--border-primary');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, rulerY + 0.5);
  ctx.lineTo(right, rulerY + 0.5);
  ctx.stroke();

  const spanKhz = hi - lo;
  const tickStep = pickTickStep(spanKhz);
  ctx.fillStyle = cssVar('--text-tertiary');
  ctx.font = RULER_FONT + 'px -apple-system, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  const startTick = Math.ceil(lo / tickStep) * tickStep;
  for (let f = startTick; f <= hi; f += tickStep) {
    const x = xOf(f);
    ctx.strokeStyle = cssVar('--text-dim');
    ctx.beginPath();
    ctx.moveTo(x + 0.5, rulerY);
    ctx.lineTo(x + 0.5, rulerY + 4);
    ctx.stroke();
    // Label in MHz
    ctx.fillText((f / 1000).toFixed(f % 1000 === 0 ? 0 : 3), x, rulerY + 4);
  }

  // 4. Mode segment legend strip (below ruler)
  ctx.fillStyle = cssVar('--bg-secondary');
  ctx.fillRect(left, modeStripY, right - left, MODE_STRIP_H);
  // Draw CW segments
  for (const [a, b] of segs.cw) {
    const x0 = xOf(a), x1 = xOf(b);
    ctx.fillStyle = cssVar('--accent-blue');
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x0, modeStripY + 2, x1 - x0, MODE_STRIP_H - 4);
    ctx.globalAlpha = 1;
    if (x1 - x0 > 24) {
      ctx.fillStyle = cssVar('--text-primary');
      ctx.font = MODE_FONT + 'px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CW/Data', (x0 + x1) / 2, modeStripY + MODE_STRIP_H / 2);
    }
  }
  for (const [a, b] of segs.phone) {
    const x0 = xOf(a), x1 = xOf(b);
    ctx.fillStyle = cssVar('--source-sota');
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x0, modeStripY + 2, x1 - x0, MODE_STRIP_H - 4);
    ctx.globalAlpha = 1;
    if (x1 - x0 > 20) {
      ctx.fillStyle = cssVar('--text-primary');
      ctx.font = MODE_FONT + 'px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Phone', (x0 + x1) / 2, modeStripY + MODE_STRIP_H / 2);
    }
  }

  // 5. Spot markers + stacked labels
  const spots = filteredSpotsForBand(lo, hi);
  updateSpotCount(spots.length);

  ctx.font = LABEL_FONT + 'px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const labelText = (s) => s.callsign + (s.mode ? ' ' + s.mode : '');
  const items = layoutLabels(spots, xOf, ctx, labelText);

  const maxRows = Math.max(1, Math.floor((spotsBottomY - spotsTopY - MARKER_HEAD - 6) / (LABEL_ROW_H + LABEL_PAD)));
  const layoutItems = [];
  for (const it of items) {
    const row = Math.min(it.row, maxRows - 1);
    const labelBaseY = spotsBottomY - MARKER_HEAD - 4 - row * (LABEL_ROW_H + LABEL_PAD);
    // Tick from label down to ruler
    const color = sourceColor(it.spot.source);
    const oop = (function () {
      // Basic out-of-privilege check for dim+strike
      if (licenseClass === 'none') return false;
      const fkhz = parseFloat(it.spot.frequency);
      for (const [rlo, rhi] of privs.permitted) if (fkhz >= rlo && fkhz <= rhi) return false;
      return true;
    })();

    ctx.globalAlpha = oop ? 0.45 : 1;
    // Vertical tick
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(it.x + 0.5, labelBaseY + 1);
    ctx.lineTo(it.x + 0.5, spotsBottomY - 1);
    ctx.stroke();
    // Triangle just above ruler
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(it.x, spotsBottomY - MARKER_HEAD);
    ctx.lineTo(it.x - 3, spotsBottomY);
    ctx.lineTo(it.x + 3, spotsBottomY);
    ctx.closePath();
    ctx.fill();
    // Label background (so overlapping ticks don't obscure text)
    const tw = it.width;
    const tx = it.x - tw / 2;
    ctx.fillStyle = cssVar('--bg-primary');
    ctx.globalAlpha = oop ? 0.45 : 0.9;
    ctx.fillRect(tx, labelBaseY - LABEL_ROW_H, tw, LABEL_ROW_H);
    ctx.globalAlpha = oop ? 0.45 : 1;
    // Label text
    ctx.fillStyle = color;
    ctx.fillText(it.text, it.x, labelBaseY - 1);
    if (oop) {
      // strike-through
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(tx + 2, labelBaseY - LABEL_ROW_H / 2);
      ctx.lineTo(tx + tw - 2, labelBaseY - LABEL_ROW_H / 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    layoutItems.push({
      spot: it.spot,
      cx: it.x,
      labelTop: labelBaseY - LABEL_ROW_H,
      labelBottom: labelBaseY,
      labelLeft: tx,
      labelRight: tx + tw,
    });
  }
  lastLayout = { spots: layoutItems, lo, hi, left, right, spotsBottomY };

  // 6. VFO cursor — solid red line through the whole strip plus a small
  // pennant at the top so the user can see exactly where the radio is tuned
  // even when the cursor sits between two spot ticks.
  if (currentVfoKhz >= lo && currentVfoKhz <= hi) {
    const x = xOf(currentVfoKhz);
    const xs = Math.round(x) + 0.5;
    ctx.strokeStyle = cssVar('--accent-red');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xs, 0);
    ctx.lineTo(xs, modeStripY + MODE_STRIP_H);
    ctx.stroke();

    // Pennant: small filled rectangle at the top with the freq in MHz.
    const label = (currentVfoKhz / 1000).toFixed(3);
    ctx.font = (RULER_FONT + 1) + 'px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const padX = 4;
    const padY = 2;
    const tw = ctx.measureText(label).width;
    const boxW = tw + padX * 2;
    const boxH = RULER_FONT + padY * 2 + 2;
    let bx = xs;
    if (bx + boxW > right) bx = xs - boxW; // flip left at right edge
    ctx.fillStyle = cssVar('--accent-red');
    ctx.fillRect(bx, 0, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, bx + padX, padY);
  }

  // 7. Border around the whole spots area
  ctx.strokeStyle = cssVar('--border-primary');
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, spotsTopY + 0.5, right - left - 1, rulerY - spotsTopY - 1);
}

function updateSpotCount(n) {
  if (typeof n !== 'number') return;
  const base = n === 1 ? '1 spot' : `${n} spots`;
  const zoomed = viewLo != null || viewHi != null;
  if (zoomed) {
    const v = currentView();
    if (v) {
      infoEl.textContent = `${base} · ${(v.lo / 1000).toFixed(3)}–${(v.hi / 1000).toFixed(3)} MHz (dbl-click: reset)`;
      return;
    }
  }
  infoEl.textContent = base;
}

// --- Click-to-tune ---
function hitTest(clientX, clientY) {
  if (!lastLayout) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = null;
  let bestDist = Infinity;
  for (const it of lastLayout.spots) {
    // Hit if inside label box, or within 6px of the vertical tick
    const inLabel = x >= it.labelLeft && x <= it.labelRight && y >= it.labelTop && y <= it.labelBottom;
    const inTick = y >= it.labelBottom && y <= lastLayout.spotsBottomY && Math.abs(x - it.cx) <= 4;
    if (inLabel || inTick) {
      const d = Math.abs(x - it.cx);
      if (d < bestDist) { bestDist = d; best = it; }
    }
  }
  return best;
}

// --- Pointer interaction: left-click tunes, left-drag pans, hover shows tooltip ---
const DRAG_THRESHOLD_PX = 4;
let pressX = null;
let pressY = null;
let pressStartLo = 0;
let pressStartHi = 0;
let pressButton = -1;
let isPanning = false;

function setCursor(kind) {
  canvas.style.cursor = kind;
}

function clampViewToBand(newLo, newHi, view) {
  if (newLo < view.bandLo) { newHi += (view.bandLo - newLo); newLo = view.bandLo; }
  if (newHi > view.bandHi) { newLo -= (newHi - view.bandHi); newHi = view.bandHi; }
  newLo = Math.max(view.bandLo, newLo);
  newHi = Math.min(view.bandHi, newHi);
  return { lo: newLo, hi: newHi };
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  e.preventDefault();
  const view = currentView();
  if (!view) return;
  pressX = e.clientX;
  pressY = e.clientY;
  pressStartLo = view.lo;
  pressStartHi = view.hi;
  pressButton = e.button;
  isPanning = false;
  // Capture pointer so drag continues even if cursor leaves the canvas.
  if (canvas.setPointerCapture && e.pointerId != null) {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  }
});

window.addEventListener('mouseup', (e) => {
  if (pressButton === -1) return;
  const wasPanning = isPanning;
  const startedAt = { x: pressX, y: pressY };
  const btn = pressButton;
  pressX = null;
  pressY = null;
  pressButton = -1;
  isPanning = false;
  setCursor(hoverCursorForPoint(e.clientX, e.clientY));
  // Only fire tune on left-button click (no drag) — middle button is pan-only.
  if (btn === 0 && !wasPanning && startedAt.x != null) {
    const dx = e.clientX - startedAt.x;
    const dy = e.clientY - startedAt.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        const freq = parseFloat(hit.spot.frequency);
        window.api.tune(freq, hit.spot.mode || '');
      }
    }
  }
});

function hoverCursorForPoint(clientX, clientY) {
  if (isPanning) return 'grabbing';
  const hit = hitTest(clientX, clientY);
  if (hit) return 'pointer';
  const view = currentView();
  const zoomed = view && (view.hi - view.lo) < (view.bandHi - view.bandLo - 0.001);
  return zoomed ? 'grab' : 'crosshair';
}

canvas.addEventListener('mousemove', (e) => {
  // If a button is held and we've moved past the drag threshold, pan.
  if (pressX != null && !isPanning) {
    const dx = e.clientX - pressX;
    const dy = e.clientY - pressY;
    if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      isPanning = true;
      tooltipEl.classList.remove('visible');
      setCursor('grabbing');
    }
  }

  if (isPanning && lastLayout) {
    const view = currentView();
    if (!view) return;
    const span = pressStartHi - pressStartLo;
    const dx = e.clientX - pressX;
    const khzPerPx = span / (lastLayout.right - lastLayout.left);
    const tentativeLo = pressStartLo - dx * khzPerPx;
    const tentativeHi = pressStartHi - dx * khzPerPx;
    const clamped = clampViewToBand(tentativeLo, tentativeHi, view);
    viewLo = clamped.lo;
    viewHi = clamped.hi;
    draw();
    return;
  }

  // Normal hover — tooltip + cursor feedback.
  const hit = hitTest(e.clientX, e.clientY);
  setCursor(hoverCursorForPoint(e.clientX, e.clientY));
  if (!hit) {
    tooltipEl.classList.remove('visible');
    return;
  }
  const s = hit.spot;
  const parts = [];
  parts.push(`<b>${escapeHtml(s.callsign || '')}</b>`);
  if (s.mode) parts.push(escapeHtml(s.mode));
  if (s.frequency) parts.push((parseFloat(s.frequency) / 1000).toFixed(3) + ' MHz');
  const refParts = [];
  if (s.reference) refParts.push(s.reference);
  if (s.parkName) refParts.push(s.parkName);
  const line2 = refParts.join(' — ');
  tooltipEl.innerHTML = parts.join(' · ') + (line2 ? '<br>' + escapeHtml(line2) : '');
  const rect = wrap.getBoundingClientRect();
  let x = e.clientX - rect.left + 10;
  let y = e.clientY - rect.top + 10;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top = y + 'px';
  tooltipEl.classList.add('visible');
  const tw = tooltipEl.offsetWidth;
  if (x + tw > rect.width - 4) tooltipEl.style.left = (rect.width - tw - 4) + 'px';
});

canvas.addEventListener('mouseleave', () => {
  if (!isPanning) tooltipEl.classList.remove('visible');
});

// --- Wheel zoom (anchored at cursor) ---
canvas.addEventListener('wheel', (e) => {
  // Ctrl+wheel resizes the font instead of zooming the band.
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    nudgeFontScale(e.deltaY < 0 ? 1 : -1);
    return;
  }
  e.preventDefault();
  const view = currentView();
  if (!view || !lastLayout) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  // Use the most recent layout's left/right for the freq anchor math.
  const anchorFreq = lastLayout.lo + ((x - lastLayout.left) / (lastLayout.right - lastLayout.left)) * (lastLayout.hi - lastLayout.lo);
  // Wheel up = zoom in, wheel down = zoom out. Shift+wheel pans horizontally.
  if (e.shiftKey) {
    const span = view.hi - view.lo;
    const panKhz = (e.deltaY / 100) * span * 0.15;
    let newLo = view.lo + panKhz;
    let newHi = view.hi + panKhz;
    if (newLo < view.bandLo) { newHi += (view.bandLo - newLo); newLo = view.bandLo; }
    if (newHi > view.bandHi) { newLo -= (newHi - view.bandHi); newHi = view.bandHi; }
    newLo = Math.max(view.bandLo, newLo);
    newHi = Math.min(view.bandHi, newHi);
    viewLo = newLo;
    viewHi = newHi;
  } else {
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    let newLo = anchorFreq - (anchorFreq - view.lo) * factor;
    let newHi = anchorFreq + (view.hi - anchorFreq) * factor;
    // Min zoom span
    if (newHi - newLo < MIN_ZOOM_SPAN_KHZ) {
      const mid = (newLo + newHi) / 2;
      newLo = mid - MIN_ZOOM_SPAN_KHZ / 2;
      newHi = mid + MIN_ZOOM_SPAN_KHZ / 2;
    }
    // Clamp to band; if we hit an edge, shift rather than squish.
    if (newLo < view.bandLo) { newHi += (view.bandLo - newLo); newLo = view.bandLo; }
    if (newHi > view.bandHi) { newLo -= (newHi - view.bandHi); newHi = view.bandHi; }
    newLo = Math.max(view.bandLo, newLo);
    newHi = Math.min(view.bandHi, newHi);
    // If we're back at (or wider than) full band, treat as unzoomed.
    if (newLo <= view.bandLo && newHi >= view.bandHi) {
      viewLo = null;
      viewHi = null;
    } else {
      viewLo = newLo;
      viewHi = newHi;
    }
  }
  draw();
}, { passive: false });

// Double-click empty area resets zoom.
canvas.addEventListener('dblclick', (e) => {
  const hit = hitTest(e.clientX, e.clientY);
  if (hit) return; // dbl-click on a spot → let the click handler tune
  resetZoom();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Resize ---
const ro = new ResizeObserver(() => draw());
ro.observe(wrap);

// --- Bootstrap ---
(async function init() {
  settings = await window.api.getSettings();
  if (settings.lightMode) document.documentElement.setAttribute('data-theme', 'light');
  licenseClass = settings.licenseClass || 'none';
  selectedBand = settings.bandspreadBand && BANDS[settings.bandspreadBand] ? settings.bandspreadBand : '20m';
  const savedScale = parseFloat(settings.bandspreadFontScale);
  applyFontScale(isFinite(savedScale) && savedScale > 0 ? savedScale : 1.0, { persist: false });

  buildBandSelect();

  updateSpotCount(0);
  draw();
})();
