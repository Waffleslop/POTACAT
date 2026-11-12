// Band Scope pop-out — the FT-710's own spectrum, read over USB.
//
// main.js supervises the helper, talks CAT and streams decoded frames here;
// this window draws them: a spectrum trace with the spots in it, and the shared
// WebGL waterfall (renderer/waterfall.js). Axis maths is lib/scope-axis.js,
// the same code main and the ECHOCAT web client use, so click-to-tune lands
// where the label says. It asks main for exactly four things: enable
// SCU-LAN10, restart, change the signal source, change the frame rate.
function _applyPopoutTheme(payload) {
  const theme = typeof payload === 'string' ? payload : ((payload && payload.theme) || 'dark');
  const variant = (payload && typeof payload === 'object' && payload.variant) || 'navy';
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark' && variant !== 'navy') document.documentElement.setAttribute('data-dark-variant', variant);
  else document.documentElement.removeAttribute('data-dark-variant');
}
'use strict';

const A = window.ScopeAxis;
const BINS = A.BINS;

const $ = (id) => document.getElementById(id);
const traceCanvas = $('sc-trace');
const freqCanvas = $('sc-freq');
const wfCanvas = $('sc-wf');

// ─── State ─────────────────────────────────────────────────────────────────
let state = { status: 'stopped', kind: 0, spanHz: 0, anchor: 'center', speed: null, scuLan: null, diag: null };
let centerHz = 0;
let axis = A.scopeAxis({ centerHz: 0, spanHz: 0 });
let latest = null;            // Uint8Array(850), newest RAW frame (before the level window)
// Averaging and peak hold run on the RAW levels, so the cursor readout reads
// the source's own value; the level window is applied when drawing.
let smooth = new Float32Array(BINS);
let peak = new Float32Array(BINS);
let spots = [];
let showSpots = true;
let peakHold = false;
const V = window.ScopeView;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } };
// Reference level + range (plan item 4): the window of levels the trace shows.
// The bottom IS the old Floor ('scope-floor', same key), so a saved floor
// carries over unchanged; the top is new and starts at full scale.
let range = V.clampRange(Number(lsGet('scope-floor', 0)) || 0, Number(lsGet('scope-top', 255)) || 255);
let avgMode = V.AVERAGING[lsGet('scope-avg', 'light')] ? lsGet('scope-avg', 'light') : 'light';
let peakDecay = V.PEAK_DECAY[lsGet('scope-peak-decay', 'slow')] != null ? lsGet('scope-peak-decay', 'slow') : 'slow';
let showSUnits = lsGet('scope-sunits', '0') === '1';
// Licence-privilege shading (plan item 10): on by default (Casey 10/28).
let showPrivileges = lsGet('scope-privileges', '1') !== '0';
let drawPending = false;

// ─── Waterfall ─────────────────────────────────────────────────────────────
const savedColormap = (() => { try { return localStorage.getItem('scope-colormap') || 'turbo'; } catch { return 'turbo'; } })();
// crop: resizing the window shows more or less history at the same scale,
// never squeezes it (Scott 2026-09-25). History = the tallest screen, so a
// full-height window is never short of rows.
const WF_HISTORY_ROWS = Math.min(2160, Math.max(512, Math.ceil((window.screen && window.screen.height) || 1080)));
const wf = new Waterfall(wfCanvas, { bins: BINS, historyRows: WF_HISTORY_ROWS, colormap: savedColormap, gamma: 0.6, crop: true });
if (!wf.supported) $('sc-unsupported').style.display = 'flex';
// Colours: the machine's waterfall palette (lib/waterfall-palettes.js).
// 'Standard' keeps this window's own map (Turbo, or the Classic picked here
// before palettes existed); a palette also colours the trace.
let traceColor = null;
WaterfallPalettes.fillSelect($('sc-colormap'), 'auto');
WaterfallPalettes.follow(window.api, (id, o) => {
  $('sc-colormap').value = id;
  traceColor = wf.setPalette(id, o);
  scheduleDraw();
});

// ─── Axis + labels ─────────────────────────────────────────────────────────
function recomputeAxis() {
  axis = A.scopeAxis({ centerHz: A.axisCenterFor(state, centerHz), spanHz: state.spanHz, anchor: state.anchor });
  const rxBin = centerHz ? A.hzToBin(axis, centerHz) : null;
  const marks = rxBin == null ? [] : [{ pos: rxBin / (BINS - 1), color: '#e94560', kind: 'rx' }];
  wf.setMarkers(marks.concat(V.passbandMarkers(state.passband, centerHz, axis)));
  scheduleDraw();
}

function applyState(s) {
  state = s || state;
  if (s && s.centerHz && !centerHz) centerHz = s.centerHz;
  const pill = $('sc-status');
  pill.className = 'sc-pill ' + (state.status || 'stopped');
  pill.textContent = ({ stopped: 'Stopped', starting: 'Starting', live: 'Live', blocked: 'Blocked', error: 'Error', unavailable: 'Unavailable' })[state.status] || state.status;
  $('sc-synth-badge').style.display = state.kind === 1 ? '' : 'none';
  // The sweep speed and SCU-LAN10 rows are the FT-710's ('radio', or the
  // SCU-LAN10 box): every other source (an SDR, a Flex or K4 panadapter, an
  // Icom, a Kenwood) has neither.
  const sdr = state.source === 'sdr' && state.kind !== 1;
  const yaesuSource = !state.source || state.source === 'radio' || state.source === 'sculan10';
  const notYaesu = !yaesuSource && state.kind !== 1;
  $('sc-sdr-badge').style.display = sdr ? '' : 'none';
  $('sc-speed-wrap').style.display = notYaesu ? 'none' : '';
  // Over the SCU-LAN10 itself (source 'sculan10') the unit is plainly on:
  // that row is the FT-710 USB bridge's menu, so it is hidden there too.
  $('sc-sculan-wrap').style.display = (notYaesu || state.source === 'sculan10') ? 'none' : '';
  $('sc-span').textContent = A.formatSpan(state.spanHz);
  // Zoom: only when the source offers steps (the Flex panadapter today).
  const spans = Array.isArray(state.spans) ? state.spans : [];
  $('sc-zoom-out').classList.toggle('hidden', spans.length < 2);
  $('sc-zoom-in').classList.toggle('hidden', spans.length < 2);
  $('sc-mode').textContent = state.modeLabel || (state.anchor ? ScopeAxis.anchorLabel(state.anchor) : '—');
  $('sc-speed').textContent = state.speed || '—';
  $('sc-sculan').textContent = state.scuLan === '1' ? 'ON' : state.scuLan === '0' ? 'OFF' : '—';
  const needEnable = state.scuLan === '0' || (state.diag && state.diag.key === 'silent');
  $('sc-enable').style.display = needEnable && state.kind !== 1 ? '' : 'none';
  // The button says what it does on this radio (an Icom: its scope; the FT-710: SCU-LAN10).
  const enableText = state.enableLabel || 'Enable SCU-LAN10 on the radio';
  $('sc-enable').textContent = enableText;
  $('sc-diag-enable').textContent = enableText;
  $('sc-enable').title = state.enableTitle || 'Sends EX0301261; to the radio. POTACAT turns it back off when the scope closes.';
  $('sc-synth').checked = !!state.synth;
  if (s && s.fps) $('sc-fps').value = String(s.fps);
  $('sc-sunits-row').classList.toggle('hidden', !(state.levelScale && state.levelScale.unit === 'dBm'));

  const diag = $('sc-diag');
  if (state.diag && state.status !== 'live') {
    diag.className = 'sc-diag show ' + (state.diag.severity || 'error');
    $('sc-diag-head').textContent = state.diag.headline || '';
    $('sc-diag-detail').textContent = state.diag.detail || '';
    $('sc-diag-action').textContent = state.diag.action || '';
    $('sc-diag-enable').style.display = needEnable && state.kind !== 1 ? '' : 'none';
  } else {
    diag.className = 'sc-diag';
  }
  recomputeAxis();
}

// ─── Drawing ───────────────────────────────────────────────────────────────
function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { w, h, dpr };
}

function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; drawTrace(); drawFreq(); });
}

function drawTrace() {
  const { w, h, dpr } = sizeCanvas(traceCanvas);
  // The one trace painter (lib/scope-view.js); ECHOCAT Web draws with it too.
  ScopeView.drawTrace(traceCanvas.getContext('2d'),
    { bins: latest ? V.applyRange(smooth, range.lo, range.hi) : null, peak: peakHold ? V.applyRange(peak, range.lo, range.hi) : null },
    { w, h, dpr, axis, dialHz: centerHz, spanHz: state.spanHz, anchor: state.anchor, peakHold,
      scale: V.displayScale(state.levelScale, range.lo, range.hi), gutter: true, sUnits: showSUnits, traceColor,
      overlay: { passband: state.passband, txHz: state.txHz, bandPlan: state.bandPlan, privileges: showPrivileges } });
  drawSpots(traceCanvas.getContext('2d'), w, h, dpr);
  drawFavorites(traceCanvas.getContext('2d'), w, h, dpr);
}

function drawFreq() {
  const { w, h, dpr } = sizeCanvas(freqCanvas);
  ScopeView.drawFreqScale(freqCanvas.getContext('2d'), { w, h, dpr, axis, dialHz: centerHz });
}

const SPOT_COLORS = { pota: '#4ecca3', sota: '#f0a500', wwff: '#7ec8e3', dxc: '#e040fb', rbn: '#ff8a65', pskr: '#b39ddb', net: '#ffd54f' };
let spotHits = [];   // [{x0, x1, y0, y1, spot}] in CSS px over the trace
let spotChips = [];  // [{x0, x1, y0, y1, spots}]: the "+N" chips

function spotHz(s) {
  const k = parseFloat(s.frequency);
  return Number.isFinite(k) ? Math.round(k * 1000) : null;
}

// SmartSDR's spots (Casey 2026-10-28): labels inside the panadapter, stacked
// up from its bottom edge in lanes (lib/scope-view.js spotLanes), "+N" above a
// pile-up. Every spot keeps a short tick at its exact frequency on the bottom
// edge, shown or not. A label never sits in the level scale on the left.
const SPOT_LABEL_PX = 15, SPOT_LANE_PX = 17;
function drawSpots(ctx, w, h, dpr) {
  spotHits = [];
  spotChips = [];
  if (!showSpots || !axis.known) return;
  ctx.font = `600 ${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textBaseline = 'middle';
  const inWindow = spots
    .map((s) => ({ s, hz: spotHz(s) }))
    .filter((e) => e.hz != null && A.hzToBin(axis, e.hz) != null);
  const xs = inWindow.map((e) => A.hzToBin(axis, e.hz) * (w - 1) / (BINS - 1));
  // Up to four lanes, never more than about 40% of the trace's height.
  const maxLanes = Math.max(1, Math.min(4, Math.floor((h * 0.4) / (SPOT_LANE_PX * dpr)) - 1));
  const lay = V.spotLanes(inWindow.map((e, i) => ({ x: xs[i], w: ctx.measureText(e.s.callsign || '').width + 8 * dpr })),
    { width: w, minX: V.GUTTER_PX * dpr, maxLanes, gap: 3 * dpr });
  const color = (s) => SPOT_COLORS[s.source] || '#4fc3f7';
  const boxH = SPOT_LABEL_PX * dpr;
  const laneTop = (lane) => h - 5 * dpr - boxH - lane * SPOT_LANE_PX * dpr;
  inWindow.forEach((e, i) => {
    ctx.fillStyle = color(e.s);
    ctx.fillRect(Math.round(xs[i]), h - 4 * dpr, Math.max(1, Math.round(dpr)), 4 * dpr);
  });
  for (const p of lay.placed) {
    const s = inWindow[p.i].s;
    const y0 = laneTop(p.lane);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(p.x0, y0, p.x1 - p.x0, boxH);
    ctx.fillStyle = color(s);
    ctx.fillText(s.callsign || '', p.x0 + 4 * dpr, y0 + boxH / 2 + 0.5 * dpr);
    spotHits.push({ x0: p.x0 / dpr, x1: p.x1 / dpr, y0: y0 / dpr, y1: (y0 + boxH) / dpr, spot: s });
  }
  for (const c of lay.overflow) {
    const text = '+' + c.hidden.length;
    const tw = ctx.measureText(text).width + 8 * dpr;
    const x0 = Math.max(V.GUTTER_PX * dpr, Math.min(w - tw, (c.x0 + c.x1) / 2 - tw / 2));
    const y0 = laneTop(c.lane);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x0, y0, tw, boxH);
    ctx.fillStyle = '#e0e6ee';
    ctx.fillText(text, x0 + 4 * dpr, y0 + boxH / 2 + 0.5 * dpr);
    spotChips.push({ x0: x0 / dpr, x1: (x0 + tw) / dpr, y0: y0 / dpr, y1: (y0 + boxH) / dpr, spots: c.hidden.map((i) => inWindow[i].s) });
  }
}
// Favourites (#329, lib/favorites.js): the Landmarks and Channels starred in
// Directory, marked along the TOP edge (spots own the bottom): a small
// downward notch at the exact frequency and the name beside it, in POTACAT
// blue (the theme's --accent-blue). A click tunes it. Drawn whether or not
// spot labels are shown: they are the operator's own stations.
let favItems = [];
let favHits = [];   // [{x0, x1, y0, y1, fav}] in CSS px
function favColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-blue').trim();
  return v || '#4fc3f7';
}
function drawFavorites(ctx, w, h, dpr) {
  favHits = [];
  if (!axis.known || !favItems.length) return;
  const inSpan = favItems
    .map((f) => ({ f, bin: A.hzToBin(axis, Math.round(Number(f.khz) * 1000)) }))
    .filter((e) => e.bin != null);
  if (!inSpan.length) return;
  const col = favColor();
  ctx.font = `600 ${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textBaseline = 'middle';
  const boxH = 15 * dpr, top = 3 * dpr;
  let lastRight = -Infinity;
  for (const e of inSpan) {
    const x = e.bin * (w - 1) / (BINS - 1);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x - 4 * dpr, 0); ctx.lineTo(x + 4 * dpr, 0); ctx.lineTo(x, 6 * dpr); ctx.closePath(); ctx.fill();
    const label = e.f.name || '';
    const tw = ctx.measureText(label).width + 8 * dpr;
    let x0 = Math.max(V.GUTTER_PX * dpr, Math.min(w - tw, x + 6 * dpr));
    if (x0 < lastRight + 3 * dpr) continue;   // a crowded span keeps the notch, drops the label
    const y0 = top + 6 * dpr;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x0, y0, tw, boxH);
    ctx.fillStyle = col;
    ctx.fillText(label, x0 + 4 * dpr, y0 + boxH / 2 + 0.5 * dpr);
    lastRight = x0 + tw;
    favHits.push({ x0: Math.min(x0, x - 5 * dpr) / dpr, x1: (x0 + tw) / dpr, y0: 0, y1: (y0 + boxH) / dpr, fav: e.f });
  }
}
function favText(f) {
  const mhz = (Number(f.khz) / 1000).toFixed(f.khz % 1 ? 4 : 3);
  return [f.name, mhz + ' MHz', f.mode, f.note].filter(Boolean).join(' · ');
}
function applyFavorites(st) { favItems = st && Array.isArray(st.items) ? st.items : []; scheduleDraw(); }
if (window.api.favoritesGet) window.api.favoritesGet().then(applyFavorites).catch(() => {});
if (window.api.onFavorites) window.api.onFavorites(applyFavorites);

/** The favourite, spot label or "+N" chip under a pointer event on the trace, if any. */
function spotAt(e) {
  const r = traceCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const inBox = (b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  const fav = favHits.find(inBox);
  if (fav) return { fav: fav.fav };
  const hit = spotHits.find(inBox);
  if (hit) return { spot: hit.spot };
  const chip = spotChips.find(inBox);
  return chip ? { chip } : null;
}
function spotText(s) {
  const ref = s.reference || s.ref || '';
  const t = s.spotTime ? Date.parse(/Z$|[+-]dd:?dd$/.test(String(s.spotTime)) ? s.spotTime : s.spotTime + 'Z') : NaN;
  const mins = Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
  const hz = spotHz(s);
  return [s.callsign, ref, s.mode, hz ? (hz / 1e6).toFixed(4) + ' MHz' : '', mins != null && mins >= 0 ? mins + ' min ago' : '']
    .filter(Boolean).join(' · ');
}
function tuneSpot(s) {
  const hz = spotHz(s);
  if (hz) window.api.tune((hz / 1000).toFixed(3), s.mode || null);
}

// ─── Split: the panadapter / waterfall proportion ───────────────────────────
// SmartSDR keeps about three quarters for the panadapter. The frequency scale
// between them is the divider; the split is this device's (localStorage).
const SPLIT_DEFAULT = 0.75;
let split = Math.max(0.2, Math.min(0.9, Number(lsGet('scope-split', SPLIT_DEFAULT)) || SPLIT_DEFAULT));
function applySplit() {
  const free = traceCanvas.parentElement.clientHeight - freqCanvas.offsetHeight;
  if (!(free > 0)) return;
  const h = Math.round(Math.max(80, Math.min(free - 60, free * split)));
  if (traceCanvas.style.height !== h + 'px') traceCanvas.style.height = h + 'px';
  wf.resize();
  scheduleDraw();
}

// ─── Frames ────────────────────────────────────────────────────────────────
window.api.onScopeFrame((f) => {
  const raw = f && f.bins;
  if (!raw || raw.length !== BINS) return;
  latest = raw;
  V.smoothInto(smooth, raw, V.AVERAGING[avgMode]);
  V.peakInto(peak, raw, V.PEAK_DECAY[peakDecay]);
  // The waterfall gets the level window too, as it got the floor (Phase 5
  // gives it its own Auto black level).
  if (wf.supported) wf.pushFrame(V.applyRange(raw, range.lo, range.hi));
  scheduleDraw();
  if (readoutAt) showReadout(readoutAt.el, readoutAt.x, readoutAt.y);
});

window.api.onScopeState(applyState);
// The dial is shown where the operator put it the moment a drag, wheel or key
// tunes (the VFO window's _freqSuppressTarget pattern): a readback from just
// before the tune is ignored until the radio arrives within 25 Hz, or 1.5 s pass.
let dialTarget = { hz: 0, until: 0 };
window.api.onCatFrequency((hz) => {
  if (!(hz > 0)) return;
  if (dialTarget.hz && Date.now() < dialTarget.until) {
    if (Math.abs(hz - dialTarget.hz) > 25) return;
    dialTarget = { hz: 0, until: 0 };
  }
  centerHz = hz; recomputeAxis();
});
window.api.onSpots((list) => { spots = Array.isArray(list) ? list : []; scheduleDraw(); });
window.api.onPopoutTheme(_applyPopoutTheme);
// The tuning step shared with the VFO window and ECHOCAT (settings.tuneStepHz).
// Held here for the scope's wheel tuning (docs/scope-improvements-plan.md item 12a).
let tuneStepHz = 1000;
if (window.api.onTuneStep) window.api.onTuneStep((hz) => { if (hz > 0) tuneStepHz = hz; });
if (window.api.tuneStepGet) window.api.tuneStepGet().then((hz) => { if (hz > 0) tuneStepHz = hz; }).catch(() => {});

// ─── Interaction ───────────────────────────────────────────────────────────
function tuneToFraction(frac) {
  if (!axis.known) return;
  const hz = A.snapTapHz(A.binToHz(axis, Math.max(0, Math.min(1, frac)) * (BINS - 1)), state.spanHz);
  window.api.tune((hz / 1000).toFixed(3), null);
}
// ─── Level window: drag the level scale (left edge) to move it, wheel to widen ──
// A drag that starts in the gutter never tunes; neither does a click that moved.
let gutterDrag = null;     // { y0, range0 }
let suppressClick = false;
function inGutter(e) {
  const r = traceCanvas.getBoundingClientRect();
  return e.clientX - r.left <= V.GUTTER_PX;
}
function setRange(next, from) {
  range = V.clampRange(next.lo, next.hi);
  lsSet('scope-floor', range.lo);
  lsSet('scope-top', range.hi);
  if (from !== 'floor') floorEl.value = String(Math.min(Number(floorEl.max), range.lo));
  if (from !== 'bottom') $('sc-bottom').value = String(range.lo);
  if (from !== 'top') $('sc-top').value = String(range.hi);
  scheduleDraw();
}
// ─── Phase 4: tune with the mouse, wheel and keys (plan items 11-13) ────────
// Every gesture ends in window.api.tune — the one tune path.
function tuneDial(hz) {
  if (!(hz > 0)) return;
  dialTarget = { hz, until: Date.now() + 1500 };
  centerHz = hz;
  recomputeAxis();
  window.api.tune((hz / 1000).toFixed(3), null);
}
const liveTune = V.throttleLast(tuneDial, 66);   // ~15 tunes a second while the passband is dragged
function passbandCssPx(el) {
  const pb = V.passbandHz(state.passband, centerHz);
  const r = el.getBoundingClientRect();
  const k = V.hzPerPx(axis, r.width);
  if (!pb || !k) return null;
  return { x0: (pb.loHz - axis.startHz) / k, x1: (pb.hiHz - axis.startHz) / k };
}
let tuneDrag = null;       // { el, kind, x0, dial0, moved, pointerId }
function slidePreview(dx) {
  const t = dx ? `translateX(${dx}px)` : '';
  traceCanvas.style.transform = t;
  wfCanvas.style.transform = t;
}
function startTuneDrag(el, e) {
  if (e.button !== 0 || !axis.known || !centerHz) return false;
  const r = el.getBoundingClientRect();
  const kind = V.dragKind(axis, e.clientX - r.left, el === traceCanvas ? passbandCssPx(el) : null);
  if (kind === 'none') return false;
  tuneDrag = { el, kind, x0: e.clientX, dial0: centerHz, width: r.width, moved: false };
  try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  return true;
}
function moveTuneDrag(e) {
  if (!tuneDrag) return;
  const dx = e.clientX - tuneDrag.x0;
  if (!tuneDrag.moved && Math.abs(dx) < 4) return;
  tuneDrag.moved = true;
  suppressClick = true;
  if (tuneDrag.kind === 'passband') liveTune.push(V.dragDialHz('passband', tuneDrag.dial0, dx, axis, tuneDrag.width));
  else slidePreview(dx);   // CENTER: the trace slides; the radio tunes on release
}
function endTuneDrag(e) {
  const d = tuneDrag;
  if (!d) return;
  tuneDrag = null;
  try { d.el.releasePointerCapture(e.pointerId); } catch { /* released */ }
  if (!d.moved) return;
  if (d.kind === 'passband') { liveTune.flush(); return; }
  slidePreview(0);
  if (e.type !== 'pointercancel') tuneDial(V.dragDialHz('pan', d.dial0, e.clientX - d.x0, axis, d.width));
}
function wheelTune(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { zoomStep(e.deltaY > 0 ? +1 : -1); return; }
  if (!axis.known || !centerHz) return;
  const step = V.wheelStepHz(tuneStepHz, e.deltaY, e.shiftKey);
  if (step) tuneDial(centerHz + step);
}
// The waterfall: the same drag (pan only — no passband handle there) and wheel.
let wfSuppressClick = false;
wf.onClick((frac) => { if (wfSuppressClick) { wfSuppressClick = false; return; } tuneToFraction(frac); });
wfCanvas.addEventListener('pointerdown', (e) => { wfSuppressClick = false; startTuneDrag(wfCanvas, e); });
wfCanvas.addEventListener('pointermove', (e) => { moveTuneDrag(e); if (tuneDrag && tuneDrag.moved) wfSuppressClick = true; });
wfCanvas.addEventListener('pointerup', endTuneDrag);
wfCanvas.addEventListener('pointercancel', endTuneDrag);
wfCanvas.addEventListener('wheel', wheelTune, { passive: false });

traceCanvas.addEventListener('pointermove', (e) => {
  traceCanvas.classList.toggle('in-gutter', !!gutterDrag || inGutter(e));
  moveTuneDrag(e);
  if (!gutterDrag) return;
  const r = traceCanvas.getBoundingClientRect();
  const plotH = Math.max(1, r.height - 6);
  const d = (e.clientY - gutterDrag.y0) * (gutterDrag.range0.hi - gutterDrag.range0.lo) / plotH;
  if (Math.abs(e.clientY - gutterDrag.y0) > 2) suppressClick = true;
  // Dragging down moves the trace down: the window slides up the levels.
  setRange(V.shiftRange(gutterDrag.range0, d));
});
let spotPress = null;
traceCanvas.addEventListener('pointerdown', (e) => {
  suppressClick = false;
  spotPress = e.button === 0 ? spotAt(e) : null;
  if (spotPress) return;
  if (e.button === 0 && !inGutter(e)) { startTuneDrag(traceCanvas, e); return; }
  if (e.button !== 0 || !inGutter(e)) return;
  gutterDrag = { y0: e.clientY, range0: { ...range } };
  suppressClick = true;
  try { traceCanvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
});
const endGutterDrag = (e) => {
  endTuneDrag(e);
  if (gutterDrag) { gutterDrag = null; try { traceCanvas.releasePointerCapture(e.pointerId); } catch { /* released */ } }
};
traceCanvas.addEventListener('pointerup', endGutterDrag);
traceCanvas.addEventListener('pointercancel', endGutterDrag);
traceCanvas.addEventListener('wheel', (e) => {
  if (!inGutter(e)) { wheelTune(e); return; }   // over the trace: tune (Ctrl = zoom)
  e.preventDefault();
  setRange(V.zoomRange(range, e.deltaY > 0 ? 1.12 : 1 / 1.12));
}, { passive: false });
traceCanvas.addEventListener('click', (e) => {
  if (spotPress) {
    const p = spotPress;
    spotPress = null;
    // A label tunes to the spot with its mode; a "+N" chip only lists (hover).
    if (p.spot) tuneSpot(p.spot);
    if (p.fav) window.api.tune(String(p.fav.khz), p.fav.mode || null);
    return;
  }
  if (suppressClick) { suppressClick = false; return; }
  const r = traceCanvas.getBoundingClientRect();
  if (r.width > 0) tuneToFraction((e.clientX - r.left) / r.width);
});
let splitDrag = null;     // { y0, h0, moved }
let splitClickEaten = false;
freqCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  splitDrag = { y0: e.clientY, h0: traceCanvas.offsetHeight, moved: false };
  try { freqCanvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
});
freqCanvas.addEventListener('pointermove', (e) => {
  if (!splitDrag) return;
  const dy = e.clientY - splitDrag.y0;
  if (!splitDrag.moved && Math.abs(dy) < 3) return;
  splitDrag.moved = true;
  const free = traceCanvas.parentElement.clientHeight - freqCanvas.offsetHeight;
  if (free > 0) { split = Math.max(0.2, Math.min(0.9, (splitDrag.h0 + dy) / free)); applySplit(); }
});
const endSplitDrag = (e) => {
  if (!splitDrag) return;
  if (splitDrag.moved) { lsSet('scope-split', split.toFixed(3)); splitClickEaten = true; }
  splitDrag = null;
  try { freqCanvas.releasePointerCapture(e.pointerId); } catch { /* released */ }
};
freqCanvas.addEventListener('pointerup', endSplitDrag);
freqCanvas.addEventListener('pointercancel', endSplitDrag);
freqCanvas.addEventListener('dblclick', () => { split = SPLIT_DEFAULT; lsSet('scope-split', split); applySplit(); });
freqCanvas.addEventListener('click', (e) => {
  if (splitClickEaten) { splitClickEaten = false; return; }
  const r = freqCanvas.getBoundingClientRect();
  if (r.width > 0) tuneToFraction((e.clientX - r.left) / r.width);
});

// ─── Cursor readout: frequency + level under the pointer (plan item 3) ──────
const readoutEl = $('sc-readout');
let readoutAt = null;      // { el, x, y } while the pointer is over a scope surface
function showReadout(el, clientX, clientY) {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !axis.hzPerBin) { readoutEl.classList.remove('show'); return; }
  const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const hz = A.binToHz(axis, frac * (BINS - 1));
  let text = V.formatReadout(hz, latest ? V.levelAt(smooth, frac) : null, state.levelScale, state.spanHz);
  if (!axis.known) text += ' (axis assumed)';
  readoutEl.textContent = text;
  readoutEl.classList.add('show');
  const stage = readoutEl.parentElement.getBoundingClientRect();
  const w = readoutEl.offsetWidth;
  let x = clientX - stage.left + 12;
  if (x + w > stage.width - 4) x = clientX - stage.left - w - 12;
  readoutEl.style.left = Math.max(4, x) + 'px';
  readoutEl.style.top = Math.max(2, clientY - stage.top - 26) + 'px';
}
function showSpotReadout(hit, clientX, clientY) {
  readoutEl.textContent = hit.fav ? favText(hit.fav) : hit.spot ? spotText(hit.spot)
    : hit.chip.spots.length + ' more: ' + hit.chip.spots.map((s) => s.callsign).filter(Boolean).join(', ');
  readoutEl.classList.add('show');
  const stage = readoutEl.parentElement.getBoundingClientRect();
  const w = readoutEl.offsetWidth;
  let x = clientX - stage.left + 12;
  if (x + w > stage.width - 4) x = clientX - stage.left - w - 12;
  readoutEl.style.left = Math.max(4, x) + 'px';
  readoutEl.style.top = Math.max(2, clientY - stage.top - 26) + 'px';
}
function hideReadout() { readoutAt = null; readoutEl.classList.remove('show'); }
let holdTimer = null;
for (const el of [traceCanvas, wfCanvas]) {
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && !readoutAt) return;   // touch: only after a hold
    if (el === traceCanvas && (gutterDrag || inGutter(e))) { hideReadout(); return; }
    const onSpot = el === traceCanvas && !tuneDrag ? spotAt(e) : null;
    if (el === traceCanvas) traceCanvas.classList.toggle('on-spot', !!onSpot);
    if (onSpot) { readoutAt = null; showSpotReadout(onSpot, e.clientX, e.clientY); return; }
    readoutAt = { el, x: e.clientX, y: e.clientY };
    showReadout(el, e.clientX, e.clientY);
  });
  el.addEventListener('pointerleave', hideReadout);
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    clearTimeout(holdTimer);
    const x = e.clientX, y = e.clientY;
    holdTimer = setTimeout(() => { readoutAt = { el, x, y }; showReadout(el, x, y); }, 400);
  });
  el.addEventListener('pointerup', () => clearTimeout(holdTimer));
}
$('sc-enable').addEventListener('click', () => window.api.enableOnRadio());
$('sc-diag-enable').addEventListener('click', () => window.api.enableOnRadio());
$('sc-retry').addEventListener('click', () => window.api.restart());
$('sc-diag-retry').addEventListener('click', () => window.api.restart());
$('sc-spots-toggle').addEventListener('click', (e) => {
  showSpots = !showSpots;
  e.currentTarget.classList.toggle('on', showSpots);
  scheduleDraw();
});

const gearPop = $('sc-gear-pop');
$('sc-gear-btn').addEventListener('click', (e) => { e.stopPropagation(); gearPop.classList.toggle('show'); });
document.addEventListener('click', (e) => { if (!gearPop.contains(e.target)) gearPop.classList.remove('show'); });
$('sc-colormap').addEventListener('change', (e) => {
  window.api.setWaterfallPalette(e.target.value);   // every waterfall window follows
});
$('sc-fps').addEventListener('change', (e) => window.api.setFps(Number(e.target.value)));
const floorEl = $('sc-floor');
// Floor (toolbar) and Bottom (gear) are the same value: the window's bottom.
floorEl.addEventListener('input', (e) => setRange({ lo: Number(e.target.value) || 0, hi: range.hi }, 'floor'));
$('sc-bottom').addEventListener('input', (e) => setRange({ lo: Number(e.target.value) || 0, hi: range.hi }, 'bottom'));
$('sc-top').addEventListener('input', (e) => setRange({ lo: range.lo, hi: Number(e.target.value) || 255 }, 'top'));
$('sc-range-reset').addEventListener('click', () => setRange({ lo: 0, hi: 255 }));
setRange(range);
$('sc-avg').value = avgMode;
$('sc-avg').addEventListener('change', (e) => { avgMode = V.AVERAGING[e.target.value] ? e.target.value : 'light'; lsSet('scope-avg', avgMode); });
$('sc-peak-decay').value = peakDecay;
$('sc-peak-decay').addEventListener('change', (e) => { peakDecay = V.PEAK_DECAY[e.target.value] != null ? e.target.value : 'slow'; lsSet('scope-peak-decay', peakDecay); });
$('sc-privileges').checked = showPrivileges;
$('sc-privileges').addEventListener('change', (e) => { showPrivileges = e.target.checked; lsSet('scope-privileges', showPrivileges ? '1' : '0'); scheduleDraw(); });
$('sc-sunits').checked = showSUnits;
$('sc-sunits').addEventListener('change', (e) => { showSUnits = e.target.checked; lsSet('scope-sunits', showSUnits ? '1' : '0'); scheduleDraw(); });
function applyPeakUi() {
  $('sc-peak-clear').style.display = peakHold ? '' : 'none';
  $('sc-peak-decay-row').classList.toggle('hidden', !peakHold);
}
$('sc-peak').addEventListener('change', (e) => { peakHold = e.target.checked; if (!peakHold) peak.fill(0); applyPeakUi(); scheduleDraw(); });
$('sc-peak-clear').addEventListener('click', () => { peak.fill(0); scheduleDraw(); });
applyPeakUi();
$('sc-synth').addEventListener('change', (e) => window.api.setSynth(e.target.checked));

// ─── Window chrome ─────────────────────────────────────────────────────────
if (window.api.platform === 'darwin') document.body.classList.add('platform-darwin');
$('min-btn').addEventListener('click', () => window.api.minimize());
$('max-btn').addEventListener('click', () => window.api.maximize());
$('close-btn').addEventListener('click', () => window.api.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { gearPop.classList.remove('show'); return; }
  // Keys (plan item 13): Left/Right step the dial by the synced step (Shift
  // = ten), PageUp narrower / PageDown wider. Not while typing in a field.
  const typing = e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && axis.known && centerHz) {
      e.preventDefault();
      tuneDial(centerHz + (e.key === 'ArrowRight' ? 1 : -1) * tuneStepHz * (e.shiftKey ? 10 : 1));
      return;
    }
    if (e.key === 'PageUp') { e.preventDefault(); zoomStep(-1); return; }
    if (e.key === 'PageDown') { e.preventDefault(); zoomStep(+1); return; }
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) window.api.setZoom(Math.min(2, window.api.getZoom() + 0.1));
  if ((e.ctrlKey || e.metaKey) && e.key === '-') window.api.setZoom(Math.max(0.6, window.api.getZoom() - 0.1));
  if ((e.ctrlKey || e.metaKey) && e.key === '0') window.api.setZoom(1);
});
window.addEventListener('resize', applySplit);
applyState(state);
applySplit();

// Zoom: step through scope-state.spans from the one nearest the current span.
function zoomStep(dir) {
  const next = V.zoomSpan(state.spans, state.spanHz, dir);
  if (next) window.api.setSpan(next);
}
$('sc-zoom-out').addEventListener('click', () => zoomStep(+1)); // wider
$('sc-zoom-in').addEventListener('click', () => zoomStep(-1));  // narrower
