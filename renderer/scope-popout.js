// Band Scope pop-out — the FT-710's own spectrum, read over USB.
//
// main.js supervises the helper, talks CAT and streams decoded frames here;
// this window draws them: a spectrum trace, a spot strip, and the shared
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
const spotsCanvas = $('sc-spots');
const wfCanvas = $('sc-wf');

// ─── State ─────────────────────────────────────────────────────────────────
let state = { status: 'stopped', kind: 0, spanHz: 0, anchor: 'center', speed: null, scuLan: null, diag: null };
let centerHz = 0;
let axis = A.scopeAxis({ centerHz: 0, spanHz: 0 });
let latest = null;            // Uint8Array(850), newest frame
let smooth = new Float32Array(BINS);
let peak = new Float32Array(BINS);
let spots = [];
let showSpots = true;
let peakHold = false;
let floor = (() => { try { return Number(localStorage.getItem('scope-floor')) || 0; } catch { return 0; } })();
let drawPending = false;

// ─── Waterfall ─────────────────────────────────────────────────────────────
const savedColormap = (() => { try { return localStorage.getItem('scope-colormap') || 'turbo'; } catch { return 'turbo'; } })();
// crop: resizing the window shows more or less history at the same scale,
// never squeezes it (Scott 2026-09-25). History = the tallest screen, so a
// full-height window is never short of rows.
const WF_HISTORY_ROWS = Math.min(2160, Math.max(512, Math.ceil((window.screen && window.screen.height) || 1080)));
const wf = new Waterfall(wfCanvas, { bins: BINS, historyRows: WF_HISTORY_ROWS, colormap: savedColormap, gamma: 0.6, crop: true });
if (!wf.supported) $('sc-unsupported').style.display = 'flex';
$('sc-colormap').value = savedColormap;

// ─── Axis + labels ─────────────────────────────────────────────────────────
function recomputeAxis() {
  axis = A.scopeAxis({ centerHz, spanHz: state.spanHz, anchor: state.anchor });
  $('sc-ax-lo').textContent = axis.known || (centerHz && state.spanHz) ? A.formatHz(axis.startHz) : '—';
  $('sc-ax-c').textContent = centerHz ? A.formatHz(centerHz) : '—';
  $('sc-ax-hi').textContent = axis.known || (centerHz && state.spanHz) ? A.formatHz(axis.endHz) : '—';
  const rxBin = centerHz ? A.hzToBin(axis, centerHz) : null;
  wf.setMarkers(rxBin == null ? [] : [{ pos: rxBin / (BINS - 1), color: '#e94560', kind: 'rx' }]);
  scheduleDraw();
}

function applyState(s) {
  state = s || state;
  if (s && s.centerHz && !centerHz) centerHz = s.centerHz;
  const pill = $('sc-status');
  pill.className = 'sc-pill ' + (state.status || 'stopped');
  pill.textContent = ({ stopped: 'Stopped', starting: 'Starting', live: 'Live', blocked: 'Blocked', error: 'Error', unavailable: 'Unavailable' })[state.status] || state.status;
  $('sc-synth-badge').style.display = state.kind === 1 ? '' : 'none';
  $('sc-span').textContent = A.formatSpan(state.spanHz);
  $('sc-mode').textContent = state.anchor ? state.anchor.toUpperCase() + (state.anchor !== 'center' ? ' (axis assumed)' : '') : '—';
  $('sc-speed').textContent = state.speed || '—';
  $('sc-sculan').textContent = state.scuLan === '1' ? 'ON' : state.scuLan === '0' ? 'OFF' : '—';
  const needEnable = state.scuLan === '0' || (state.diag && state.diag.key === 'silent');
  $('sc-enable').style.display = needEnable && state.kind !== 1 ? '' : 'none';
  $('sc-synth').checked = !!state.synth;
  if (s && s.fps) $('sc-fps').value = String(s.fps);

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
  requestAnimationFrame(() => { drawPending = false; drawTrace(); drawSpots(); });
}

function drawTrace() {
  const { w, h, dpr } = sizeCanvas(traceCanvas);
  const ctx = traceCanvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  // Grid: ten divisions, brighter at the centre where the dial sits.
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const x = Math.round(i * w / 10) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let i = 1; i < 4; i++) {
    const y = Math.round(i * h / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  if (latest) {
    const toY = (v) => h - (v / 255) * (h - 6 * dpr) - 3 * dpr;
    if (peakHold) {
      ctx.strokeStyle = 'rgba(240,165,0,0.55)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      for (let i = 0; i < BINS; i++) {
        const x = i * (w - 1) / (BINS - 1);
        if (i === 0) ctx.moveTo(x, toY(peak[i])); else ctx.lineTo(x, toY(peak[i]));
      }
      ctx.stroke();
    }
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(79,195,247,0.55)');
    grad.addColorStop(1, 'rgba(79,195,247,0.05)');
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < BINS; i++) ctx.lineTo(i * (w - 1) / (BINS - 1), toY(smooth[i]));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < BINS; i++) {
      const x = i * (w - 1) / (BINS - 1);
      if (i === 0) ctx.moveTo(x, toY(smooth[i])); else ctx.lineTo(x, toY(smooth[i]));
    }
    ctx.stroke();
  }

  // Dial marker.
  const rxBin = centerHz ? A.hzToBin(axis, centerHz) : null;
  if (rxBin != null) {
    const x = Math.round(rxBin * (w - 1) / (BINS - 1)) + 0.5;
    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  if (!axis.known && state.spanHz && state.anchor !== 'center') {
    ctx.fillStyle = 'rgba(240,165,0,0.9)';
    ctx.font = `${11 * dpr}px sans-serif`;
    ctx.fillText(`${state.anchor.toUpperCase()} mode — the radio does not report this window's edges; axis assumed around the dial`, 8 * dpr, 14 * dpr);
  }
}

const SPOT_COLORS = { pota: '#4ecca3', sota: '#f0a500', wwff: '#7ec8e3', dxc: '#e040fb', rbn: '#ff8a65', pskr: '#b39ddb', net: '#ffd54f' };
let spotHits = [];   // [{x0, x1, spot}] in CSS px for click hit-testing

function spotHz(s) {
  const k = parseFloat(s.frequency);
  return Number.isFinite(k) ? Math.round(k * 1000) : null;
}

function drawSpots() {
  const { w, h, dpr } = sizeCanvas(spotsCanvas);
  const ctx = spotsCanvas.getContext('2d');
  ctx.fillStyle = '#06060e';
  ctx.fillRect(0, 0, w, h);
  spotHits = [];
  if (!showSpots || !axis.known) return;
  ctx.font = `${10 * dpr}px sans-serif`;
  ctx.textBaseline = 'middle';
  const placed = [];
  const inWindow = spots
    .map((s) => ({ s, hz: spotHz(s) }))
    .filter((e) => e.hz != null && A.hzToBin(axis, e.hz) != null)
    .sort((a, b) => a.hz - b.hz);
  for (const { s, hz } of inWindow) {
    const x = A.hzToBin(axis, hz) * (w - 1) / (BINS - 1);
    const label = s.callsign || '';
    const tw = ctx.measureText(label).width + 8 * dpr;
    let x0 = Math.max(0, Math.min(w - tw, x - tw / 2));
    // One row: skip a label that would sit on top of another; the tick still marks it.
    const collides = placed.some((p) => x0 < p.x1 + 2 * dpr && x0 + tw > p.x0 - 2 * dpr);
    const color = SPOT_COLORS[s.source] || '#4fc3f7';
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), 0, Math.max(1, Math.round(dpr)), h);
    if (collides) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x0, 2 * dpr, tw, h - 4 * dpr);
    ctx.fillStyle = color;
    ctx.fillText(label, x0 + 4 * dpr, h / 2);
    placed.push({ x0, x1: x0 + tw });
    spotHits.push({ x0: x0 / dpr, x1: (x0 + tw) / dpr, spot: s });
  }
}

// ─── Frames ────────────────────────────────────────────────────────────────
window.api.onScopeFrame((f) => {
  const raw = f && f.bins;
  if (!raw || raw.length !== BINS) return;
  const bins = A.applyFloor(raw, floor);   // display floor, shared maths with the web client
  latest = bins;
  for (let i = 0; i < BINS; i++) {
    smooth[i] = smooth[i] * 0.45 + bins[i] * 0.55;
    peak[i] = Math.max(peak[i] - 0.6, bins[i]);
  }
  if (wf.supported) wf.pushFrame(bins);
  scheduleDraw();
});

window.api.onScopeState(applyState);
window.api.onCatFrequency((hz) => { if (hz > 0) { centerHz = hz; recomputeAxis(); } });
window.api.onSpots((list) => { spots = Array.isArray(list) ? list : []; scheduleDraw(); });
window.api.onPopoutTheme(_applyPopoutTheme);

// ─── Interaction ───────────────────────────────────────────────────────────
function tuneToFraction(frac) {
  if (!axis.known) return;
  const hz = A.snapTapHz(A.binToHz(axis, Math.max(0, Math.min(1, frac)) * (BINS - 1)), state.spanHz);
  window.api.tune((hz / 1000).toFixed(3), null);
}
wf.onClick(tuneToFraction);
traceCanvas.addEventListener('click', (e) => {
  const r = traceCanvas.getBoundingClientRect();
  if (r.width > 0) tuneToFraction((e.clientX - r.left) / r.width);
});
spotsCanvas.addEventListener('click', (e) => {
  const r = spotsCanvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const hit = spotHits.find((h) => x >= h.x0 && x <= h.x1);
  if (hit) {
    const hz = spotHz(hit.spot);
    if (hz) window.api.tune((hz / 1000).toFixed(3), hit.spot.mode || null);
  } else if (r.width > 0) {
    tuneToFraction(x / r.width);
  }
});

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
  wf.setColormap(e.target.value);
  try { localStorage.setItem('scope-colormap', e.target.value); } catch { /* private mode */ }
});
$('sc-fps').addEventListener('change', (e) => window.api.setFps(Number(e.target.value)));
const floorEl = $('sc-floor');
floorEl.value = String(floor);
floorEl.addEventListener('input', (e) => {
  floor = Number(e.target.value) || 0;
  try { localStorage.setItem('scope-floor', String(floor)); } catch { /* private mode */ }
});
$('sc-peak').addEventListener('change', (e) => { peakHold = e.target.checked; if (!peakHold) peak.fill(0); scheduleDraw(); });
$('sc-synth').addEventListener('change', (e) => window.api.setSynth(e.target.checked));

// ─── Window chrome ─────────────────────────────────────────────────────────
if (window.api.platform === 'darwin') document.body.classList.add('platform-darwin');
$('min-btn').addEventListener('click', () => window.api.minimize());
$('max-btn').addEventListener('click', () => window.api.maximize());
$('close-btn').addEventListener('click', () => window.api.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { gearPop.classList.remove('show'); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) window.api.setZoom(Math.min(2, window.api.getZoom() + 0.1));
  if ((e.ctrlKey || e.metaKey) && e.key === '-') window.api.setZoom(Math.max(0.6, window.api.getZoom() - 0.1));
  if ((e.ctrlKey || e.metaKey) && e.key === '0') window.api.setZoom(1);
});
window.addEventListener('resize', () => { wf.resize(); scheduleDraw(); });
applyState(state);
