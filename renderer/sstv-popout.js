'use strict';
// ---------------------------------------------------------------------------
// SSTV Pop-out — UI logic for compose, gallery, audio I/O, TX/RX
// ---------------------------------------------------------------------------

// --- DOM refs ---
const rxCanvas = document.getElementById('rx-canvas');
const txCanvas = document.getElementById('tx-canvas');
const wfCanvas = document.getElementById('wf-canvas');
const rxCtx = rxCanvas.getContext('2d');
const txCtx = txCanvas.getContext('2d');
const wfCtx = wfCanvas.getContext('2d');
const rxInfo = document.getElementById('rx-info');
const modeSelect = document.getElementById('mode-select');
const loadBtn = document.getElementById('load-btn');
const randomBtn = document.getElementById('random-btn');
const clearReplyBtn = document.getElementById('clear-reply-btn');
const txBtn = document.getElementById('tx-btn');
const progressBar = document.getElementById('progress-bar');
const txGainSlider = document.getElementById('tx-gain');
const gallery = document.getElementById('gallery');
const galleryCount = document.getElementById('gallery-count');
const openFolderBtn = document.getElementById('open-folder-btn');
const audioInputSelect = document.getElementById('audio-input');
const audioOutputSelect = document.getElementById('audio-output');
const statusBar = document.getElementById('status-bar');
const textLayersEl = document.getElementById('text-layers');
const textPropsEl = document.getElementById('text-props');
const addTextBtn = document.getElementById('add-text-btn');

// --- State ---
let settings = {};
let callsign = '';
let grid = '';
let isTx = false;
let bgImage = null;       // loaded/generated background Image or ImageData
let bgParams = null;      // pattern generator params (for template save)
let replyImage = null;    // received image for PiP reply (ImageData)
let lastRxImage = null;   // most recent decode, for the "Reply with this" button on rx-canvas
let replyInset = { x: -1, y: -1, scale: 0.28, rotation: 0 }; // -1 = auto position (bottom-right)
let galleryImages = [];   // [{filename, timestamp, mode, dataUrl}]
let sstvAudioCtx = null;
let sstvStream = null;
let sstvWorkletNode = null;
let txAudioCtx = null;
let txPlaying = false;
let templates = [];       // saved templates [{bgParams, bgDataUrl, texts, thumbnail}]
let activeTemplateIdx = -1;

// Draggable text elements — positions in canvas coords (320x256)
// key: 'cq'|'call'|'grid' are special (auto-filled), 'user-N' are user-created
let textElements = [
  { key: 'cq',   label: 'CQ SSTV', x: 8, y: 22, fontSize: 18, bold: true,  italic: false, color: '#ffffff', rotation: 0, visible: true },
  { key: 'call', label: '',         x: 8, y: 44, fontSize: 20, bold: true,  italic: false, color: '#ffffff', rotation: 0, visible: true },
  { key: 'grid', label: '',         x: 8, y: 66, fontSize: 14, bold: false, italic: false, color: '#ffffff', rotation: 0, visible: true },
];
let selectedText = null; // currently selected text element (for property editing)
let dragTarget = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let rotateTarget = null; // text element being rotated
let userTextCounter = 0;

// SSTV mode resolutions
const MODE_RES = {
  martin1:  { w: 320, h: 256 },
  scottie1: { w: 320, h: 256 },
  robot36:  { w: 320, h: 240 },
  robot72:  { w: 320, h: 240 },
};

// --- Init ---
(async function init() {
  try {
    settings = await window.api.getSettings();
  } catch (e) {
    console.error('[SSTV] Failed to load settings:', e);
    settings = {};
  }
  callsign = settings.myCallsign || '';
  grid = settings.grid || '';
  try { if (settings.sstvMode) modeSelect.value = settings.sstvMode; } catch {}
  try { txGainSlider.value = Math.round((settings.sstvTxGain || 0.5) * 100); } catch {}

  // Restore saved text elements if available
  try {
    if (settings.sstvTextElements && settings.sstvTextElements.length) {
      textElements = settings.sstvTextElements;
      userTextCounter = textElements.filter(t => t.key.startsWith('user-')).length;
    }
  } catch (e) { console.error('[SSTV] Text elements restore error:', e); }

  // Load saved templates
  try {
    templates = settings.sstvTemplates || [];
    renderTemplateStrip();
  } catch (e) { console.error('[SSTV] Template restore error:', e); }

  // Fill auto-labels (call/grid use current settings, not saved values)
  try { syncAutoLabels(); renderTextLayers(); } catch (e) { console.error('[SSTV] Text layers error:', e); }

  // Update canvas size for mode
  try { updateCanvasSize(); } catch {}

  // Generate initial random pattern
  try { generateRandomPattern(); } catch (e) { console.error('[SSTV] Pattern error:', e); }

  // Populate audio devices
  try { await populateAudioDevices(); } catch (e) { console.error('[SSTV] Audio device error:', e); }

  // Start RX audio capture
  try { await startRxAudio(); } catch (e) { console.error('[SSTV] RX audio error:', e); }

  // Load gallery
  try { await loadGallery(); } catch (e) { console.error('[SSTV] Gallery load error:', e); }

  // Set theme
  try { applyTheme(settings.lightMode ? 'light' : 'dark'); } catch {}

  // Auto-QSY to the selected SSTV frequency on open
  try {
    const initOpt = freqSelect.options[freqSelect.selectedIndex];
    tuneToFreq(freqSelect.value, initOpt && initOpt.dataset.mode);
  } catch (e) { console.error('[SSTV] Auto-QSY error:', e); }

})();

// --- Refocus from main (user re-opened SSTV from the view menu) ---
// Re-tune to the currently selected SSTV frequency so the radio QSYs back
// from whatever spot the user last clicked.
window.api.onRefocusQsy(() => {
  try {
    const opt = freqSelect.options[freqSelect.selectedIndex];
    tuneToFreq(freqSelect.value, opt && opt.dataset.mode);
  } catch (e) { console.error('[SSTV] Refocus QSY error:', e); }
});

// --- Radio frequency sync ---
window.api.onCatFrequency((hz) => {
  const khz = Math.round(hz / 1000);
  // Update dropdown if a matching option exists
  for (let i = 0; i < freqSelect.options.length; i++) {
    if (parseInt(freqSelect.options[i].value) === khz) {
      freqSelect.selectedIndex = i;
      return;
    }
  }
  // No exact match — show in custom input
  freqInput.value = khz;
});

// --- Theme ---
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}
window.api.onPopoutTheme(applyTheme);

// --- Window controls ---
document.getElementById('min-btn').addEventListener('click', () => window.api.minimize());
document.getElementById('max-btn').addEventListener('click', () => window.api.maximize());
document.getElementById('close-btn').addEventListener('click', () => window.api.close());

// --- Mode change ---
modeSelect.addEventListener('change', () => {
  updateCanvasSize();
  renderTxPreview();
  window.api.saveSettings({ sstvMode: modeSelect.value });
});

function updateCanvasSize() {
  const res = MODE_RES[modeSelect.value] || { w: 320, h: 256 };
  rxCanvas.width = res.w;
  rxCanvas.height = res.h;
  txCanvas.width = res.w;
  txCanvas.height = res.h;
}

// --- Frequency selector ---
const freqSelect = document.getElementById('freq-select');
const freqInput = document.getElementById('freq-input');
const tuneBtn = document.getElementById('tune-btn');

function getFreqMode(freqKhz) {
  return parseInt(freqKhz) < 10000 ? 'LSB' : 'USB';
}

function tuneToFreq(freq, mode) {
  const m = mode || getFreqMode(freq);
  window.api.tune(freq, m);
  statusBar.textContent = 'Tuned to ' + freq + ' kHz ' + m;
}

// Dropdown change QSYs immediately with correct mode
freqSelect.addEventListener('change', () => {
  freqInput.value = '';
  const opt = freqSelect.options[freqSelect.selectedIndex];
  tuneToFreq(freqSelect.value, opt && opt.dataset.mode);
});

// Tune button: for custom frequency input
tuneBtn.addEventListener('click', () => {
  const custom = freqInput.value.trim();
  if (custom && !isNaN(custom)) {
    tuneToFreq(custom);
  }
});

// Enter in custom input tunes
freqInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const freq = freqInput.value.trim();
    if (freq && !isNaN(freq)) {
      tuneToFreq(freq);
    }
  }
});

// --- Text Layer Editor ---

// Auto-fill labels for special keys (callsign/grid always use current settings)
function syncAutoLabels() {
  const callEl = textElements.find(t => t.key === 'call');
  if (callEl) callEl.label = callsign ? 'de ' + callsign.toUpperCase() : '';
  const gridEl = textElements.find(t => t.key === 'grid');
  if (gridEl) gridEl.label = grid ? grid.toUpperCase() : '';
}

function getTextDisplayName(t) {
  if (t.key === 'cq') return 'CQ SSTV';
  if (t.key === 'call') return 'Callsign';
  if (t.key === 'grid') return 'Grid';
  return t.label || '(empty)';
}

function isAutoLabel(t) {
  return t.key === 'call' || t.key === 'grid';
}

function renderTextLayers() {
  textLayersEl.innerHTML = '';
  for (let i = 0; i < textElements.length; i++) {
    const t = textElements[i];
    const row = document.createElement('div');
    row.className = 'sstv-text-layer' + (t === selectedText ? ' selected' : '');

    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.className = 'tl-vis';
    vis.checked = t.visible;
    vis.title = 'Show/hide';
    vis.addEventListener('change', () => { t.visible = vis.checked; onTextChanged(); });
    row.appendChild(vis);

    const swatch = document.createElement('span');
    swatch.style.cssText = 'width:10px;height:10px;border-radius:2px;border:1px solid rgba(255,255,255,0.2);flex-shrink:0;';
    swatch.style.background = t.color || '#ffffff';
    row.appendChild(swatch);

    const lbl = document.createElement('span');
    lbl.className = 'tl-label';
    const style = (t.bold ? 'B' : '') + (t.italic ? 'I' : '');
    lbl.textContent = getTextDisplayName(t) + (style ? ' [' + style + ']' : '') + ' ' + t.fontSize + 'px';
    row.appendChild(lbl);

    // Delete button (only for user-created text)
    if (t.key.startsWith('user-')) {
      const del = document.createElement('button');
      del.className = 'tl-del';
      del.textContent = '\u2715';
      del.title = 'Remove text';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        textElements.splice(i, 1);
        if (selectedText === t) { selectedText = null; textPropsEl.style.display = 'none'; }
        onTextChanged();
      });
      row.appendChild(del);
    }

    row.addEventListener('click', (e) => {
      if (e.target === vis) return;
      selectedText = t;
      renderTextLayers();
      renderTextProps();
    });
    textLayersEl.appendChild(row);
  }
}

function renderTextProps() {
  const t = selectedText;
  if (!t) { textPropsEl.style.display = 'none'; return; }
  textPropsEl.style.display = 'flex';
  textPropsEl.innerHTML = '';

  // Text content input
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = isAutoLabel(t) ? '' : t.label;
  textInput.placeholder = isAutoLabel(t) ? getTextDisplayName(t) + ' (auto)' : 'Text...';
  textInput.disabled = isAutoLabel(t);
  textInput.style.opacity = isAutoLabel(t) ? '0.5' : '1';
  textInput.addEventListener('input', () => { t.label = textInput.value; onTextChanged(); });
  textPropsEl.appendChild(textInput);

  // Font size
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.value = t.fontSize;
  sizeInput.min = 8;
  sizeInput.max = 100;
  sizeInput.title = 'Font size';
  sizeInput.addEventListener('change', () => { t.fontSize = Math.max(8, Math.min(100, parseInt(sizeInput.value) || 14)); onTextChanged(); renderTextLayers(); });
  textPropsEl.appendChild(sizeInput);

  // Bold toggle
  const boldBtn = document.createElement('button');
  boldBtn.className = 'tp-toggle' + (t.bold ? ' active' : '');
  boldBtn.textContent = 'B';
  boldBtn.style.fontWeight = '900';
  boldBtn.title = 'Bold';
  boldBtn.addEventListener('click', () => { t.bold = !t.bold; boldBtn.classList.toggle('active', t.bold); onTextChanged(); renderTextLayers(); });
  textPropsEl.appendChild(boldBtn);

  // Italic toggle
  const italicBtn = document.createElement('button');
  italicBtn.className = 'tp-toggle' + (t.italic ? ' active' : '');
  italicBtn.textContent = 'I';
  italicBtn.style.fontStyle = 'italic';
  italicBtn.title = 'Italic';
  italicBtn.addEventListener('click', () => { t.italic = !t.italic; italicBtn.classList.toggle('active', t.italic); onTextChanged(); renderTextLayers(); });
  textPropsEl.appendChild(italicBtn);

  // Color picker
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = t.color || '#ffffff';
  colorInput.title = 'Text color';
  colorInput.addEventListener('input', () => { t.color = colorInput.value; onTextChanged(); renderTextLayers(); });
  textPropsEl.appendChild(colorInput);

  // Rotation angle display/input
  const rotLabel = document.createElement('span');
  rotLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-left:4px;';
  rotLabel.textContent = 'Rot';
  textPropsEl.appendChild(rotLabel);
  const rotInput = document.createElement('input');
  rotInput.type = 'number';
  rotInput.value = Math.round((t.rotation || 0) * 180 / Math.PI);
  rotInput.min = -180;
  rotInput.max = 180;
  rotInput.title = 'Rotation (degrees)';
  rotInput.style.width = '46px';
  rotInput.addEventListener('change', () => {
    t.rotation = (parseInt(rotInput.value) || 0) * Math.PI / 180;
    onTextChanged();
  });
  textPropsEl.appendChild(rotInput);
  const degLabel = document.createElement('span');
  degLabel.style.cssText = 'font-size:10px;color:var(--text-dim);';
  degLabel.textContent = '\u00B0';
  textPropsEl.appendChild(degLabel);

  // Reset rotation button
  if (t.rotation) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'tp-toggle';
    resetBtn.textContent = '\u21BA';
    resetBtn.title = 'Reset rotation';
    resetBtn.style.fontSize = '13px';
    resetBtn.addEventListener('click', () => { t.rotation = 0; onTextChanged(); renderTextProps(); });
    textPropsEl.appendChild(resetBtn);
  }
}

function onTextChanged() {
  activeTemplateIdx = -1;
  renderTemplateStrip();
  renderTxPreview();
  saveTextElements();
  // No automatic push to the phone — the phone pulls the current compose
  // state when its SSTV tab opens. Auto-pushing would race against phone-
  // side actions (template taps, manual edits) and overwrite them.
}

// --- Live compose sync to ECHOCAT phone ---
// Serialize the current TX compose (background + text layers) and push it
// over the WebSocket via main.js so the phone's compose view mirrors what
// the user built here. Debounced because text edits fire a lot.
let _pushComposeTimer = null;
function schedulePushComposeState() {
  if (_pushComposeTimer) clearTimeout(_pushComposeTimer);
  _pushComposeTimer = setTimeout(pushComposeStateNow, 400);
}
function pushComposeStateNow() {
  _pushComposeTimer = null;
  if (!window.api || !window.api.sstvComposeState) return;
  let bgDataUrl = null;
  if (bgImage) {
    try {
      const srcW = bgImage.width || bgImage.naturalWidth || 320;
      const srcH = bgImage.height || bgImage.naturalHeight || 256;
      const c = document.createElement('canvas');
      c.width = srcW;
      c.height = srcH;
      const cc = c.getContext('2d');
      if (bgImage instanceof ImageData) {
        cc.putImageData(bgImage, 0, 0);
      } else {
        cc.drawImage(bgImage, 0, 0);
      }
      // JPEG at 0.82 quality — ~15-40 kB for 320×256, fits comfortably over WS
      bgDataUrl = c.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      console.warn('[SSTV] bg serialize error:', e.message);
    }
  }
  const texts = textElements.map(t => ({
    key: t.key, label: t.label || '',
    x: t.x, y: t.y, fontSize: t.fontSize,
    bold: !!t.bold, italic: !!t.italic,
    color: t.color, rotation: t.rotation || 0,
    visible: t.visible !== false,
  }));
  window.api.sstvComposeState({ bgDataUrl, texts, mode: modeSelect.value });
}
// Main asks for current state (triggered by phone sstv-open / sstv-get-compose)
if (window.api && window.api.onSstvSendComposeState) {
  window.api.onSstvSendComposeState(() => pushComposeStateNow());
}

function saveTextElements() {
  window.api.saveSettings({ sstvTextElements: textElements.map(t => ({
    key: t.key, label: isAutoLabel(t) ? '' : t.label,
    x: t.x, y: t.y, fontSize: t.fontSize, bold: t.bold, italic: t.italic, color: t.color, rotation: t.rotation || 0, visible: t.visible,
  }))});
}

// Add custom text layer
addTextBtn.addEventListener('click', () => {
  userTextCounter++;
  const newY = textElements.length > 0 ? textElements[textElements.length - 1].y + 20 : 22;
  const t = {
    key: 'user-' + userTextCounter,
    label: 'Text ' + userTextCounter,
    x: 8, y: Math.min(newY, 240),
    fontSize: 14, bold: false, italic: false, color: '#ffffff', rotation: 0, visible: true,
  };
  textElements.push(t);
  selectedText = t;
  onTextChanged();
  renderTextLayers();
  renderTextProps();
});

// --- TX Gain ---
txGainSlider.addEventListener('change', () => {
  window.api.saveSettings({ sstvTxGain: txGainSlider.value / 100 });
});

// ===== IMAGE LOADING =======================================================

// Load from file
loadBtn.addEventListener('click', async () => {
  const result = await window.api.sstvLoadFile();
  if (result && result.dataUrl) {
    const img = new Image();
    img.onload = () => {
      bgImage = img;
      bgParams = null; // photo, not a pattern
      activeTemplateIdx = -1;
      renderTemplateStrip();
      renderTxPreview();
    };
    img.src = result.dataUrl;
  }
});

// Random pattern generator — params are stored for template reproducibility
randomBtn.addEventListener('click', () => {
  generateRandomPattern();
  activeTemplateIdx = -1;
  renderTemplateStrip();
});

function generateRandomPattern(params) {
  const res = MODE_RES[modeSelect.value] || { w: 320, h: 256 };
  const w = res.w, h = res.h;
  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');

  const patternNames = ['plasma', 'gradient', 'waves', 'geometric'];
  const patternType = params ? params.type : patternNames[Math.floor(Math.random() * patternNames.length)];
  let seed;

  if (patternType === 'plasma') {
    seed = params ? params.seed : {
      f1: 0.02 + Math.random() * 0.04, f2: 0.02 + Math.random() * 0.04,
      f3: 0.01 + Math.random() * 0.03, p1: Math.random() * Math.PI * 2,
      p2: Math.random() * Math.PI * 2, p3: Math.random() * Math.PI * 2,
      hue: Math.random() * 360,
    };
    generatePlasma(ctx, w, h, seed);
  } else if (patternType === 'gradient') {
    seed = params ? params.seed : {
      corners: Array.from({ length: 4 }, () => [
        Math.floor(Math.random() * 200 + 30), Math.floor(Math.random() * 200 + 30),
        Math.floor(Math.random() * 200 + 30),
      ]),
    };
    generateGradientMesh(ctx, w, h, seed);
  } else if (patternType === 'waves') {
    seed = params ? params.seed : {
      waves: Array.from({ length: 3 + Math.floor(Math.random() * 3) }, () => ({
        fx: 0.01 + Math.random() * 0.05, fy: 0.01 + Math.random() * 0.05,
        phase: Math.random() * Math.PI * 2,
        r: Math.floor(Math.random() * 150 + 50), g: Math.floor(Math.random() * 150 + 50),
        b: Math.floor(Math.random() * 150 + 50),
      })),
    };
    generateWaves(ctx, w, h, seed);
  } else {
    seed = params ? params.seed : {
      cx: w / 2 + (Math.random() - 0.5) * w * 0.3,
      cy: h / 2 + (Math.random() - 0.5) * h * 0.3,
      rings: 8 + Math.floor(Math.random() * 8), hue: Math.random() * 360,
    };
    generateGeometric(ctx, w, h, seed);
  }

  bgParams = { type: patternType, seed };
  bgImage = offscreen;
  renderTxPreview();
}

function generatePlasma(ctx, w, h, s) {
  const imgData = ctx.createImageData(w, h);
  const d = imgData.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (Math.sin(x * s.f1 + s.p1) + Math.sin(y * s.f2 + s.p2) + Math.sin((x + y) * s.f3 + s.p3)) / 3;
      const hue = (s.hue + v * 120 + 360) % 360;
      const [r, g, b] = hslToRgb(hue / 360, 0.7, 0.35 + v * 0.2);
      const idx = (y * w + x) * 4;
      d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function generateGradientMesh(ctx, w, h, s) {
  const imgData = ctx.createImageData(w, h);
  const d = imgData.data;
  for (let y = 0; y < h; y++) {
    const ty = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const tx = x / (w - 1);
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s.corners[0][c] * (1 - tx) + s.corners[1][c] * tx;
        const bot = s.corners[2][c] * (1 - tx) + s.corners[3][c] * tx;
        d[idx + c] = Math.round(top * (1 - ty) + bot * ty);
      }
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function generateWaves(ctx, w, h, s) {
  const imgData = ctx.createImageData(w, h);
  const d = imgData.data;
  const numWaves = s.waves.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 20, g = 20, b = 30;
      for (const wave of s.waves) {
        const v = (Math.sin(x * wave.fx + y * wave.fy + wave.phase) + 1) / 2;
        r += wave.r * v / numWaves;
        g += wave.g * v / numWaves;
        b += wave.b * v / numWaves;
      }
      const idx = (y * w + x) * 4;
      d[idx] = Math.min(255, Math.round(r));
      d[idx + 1] = Math.min(255, Math.round(g));
      d[idx + 2] = Math.min(255, Math.round(b));
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function generateGeometric(ctx, w, h, s) {
  ctx.fillStyle = '#0a0a18';
  ctx.fillRect(0, 0, w, h);
  const maxR = Math.max(w, h) * 0.6;
  for (let i = s.rings; i >= 1; i--) {
    const r = maxR * (i / s.rings);
    const hue = (s.hue + i * 25) % 360;
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, r, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue}, 60%, 30%, 0.3)`;
    ctx.fill();
  }
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1/3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

// ===== TX COMPOSE / PREVIEW ================================================

function renderTxPreview() {
  const res = MODE_RES[modeSelect.value] || { w: 320, h: 256 };
  const w = res.w, h = res.h;
  txCanvas.width = w;
  txCanvas.height = h;

  // Clear
  txCtx.fillStyle = '#0a0a18';
  txCtx.fillRect(0, 0, w, h);

  // Draw background image (scaled to fit)
  if (bgImage) {
    const srcW = bgImage.width || bgImage.naturalWidth;
    const srcH = bgImage.height || bgImage.naturalHeight;
    if (srcW && srcH) {
      const scale = Math.max(w / srcW, h / srcH);
      const sw = w / scale, sh = h / scale;
      const sx = (srcW - sw) / 2, sy = (srcH - sh) / 2;
      txCtx.drawImage(bgImage, sx, sy, sw, sh, 0, 0, w, h);
    }
  }

  // Reply inset (PiP) — draggable, resizable, rotatable
  if (replyImage) {
    const insetW = Math.round(w * replyInset.scale);
    const insetH = Math.round(h * replyInset.scale);
    const margin = 6;
    // Auto-position if not set
    const ix = replyInset.x >= 0 ? replyInset.x : w - insetW - margin;
    const iy = replyInset.y >= 0 ? replyInset.y : h - insetH - margin;
    // Cache for hit testing
    replyInset._drawX = ix; replyInset._drawY = iy;
    replyInset._drawW = insetW; replyInset._drawH = insetH;
    // Create temp canvas from ImageData
    if (!replyInset._canvas || replyInset._canvasDirty) {
      const tmpC = document.createElement('canvas');
      tmpC.width = replyImage.width; tmpC.height = replyImage.height;
      tmpC.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(replyImage.data), replyImage.width, replyImage.height), 0, 0);
      replyInset._canvas = tmpC;
      replyInset._canvasDirty = false;
    }
    txCtx.save();
    if (replyInset.rotation) {
      txCtx.translate(ix + insetW / 2, iy + insetH / 2);
      txCtx.rotate(replyInset.rotation);
      txCtx.fillStyle = '#ffffff';
      txCtx.fillRect(-insetW / 2 - 2, -insetH / 2 - 2, insetW + 4, insetH + 4);
      txCtx.drawImage(replyInset._canvas, 0, 0, replyImage.width, replyImage.height, -insetW / 2, -insetH / 2, insetW, insetH);
    } else {
      txCtx.fillStyle = '#ffffff';
      txCtx.fillRect(ix - 2, iy - 2, insetW + 4, insetH + 4);
      txCtx.drawImage(replyInset._canvas, 0, 0, replyImage.width, replyImage.height, ix, iy, insetW, insetH);
    }
    txCtx.restore();
  }

  // Draw draggable text elements
  for (const t of textElements) {
    if (!t.visible || !t.label) continue;
    txCtx.save();
    txCtx.shadowColor = '#000';
    txCtx.shadowBlur = 3;
    txCtx.shadowOffsetX = 1;
    txCtx.shadowOffsetY = 1;
    txCtx.fillStyle = t.color || '#ffffff';
    txCtx.font = textFont(t);
    const rot = t.rotation || 0;
    if (rot) {
      txCtx.translate(t.x, t.y);
      txCtx.rotate(rot);
      txCtx.fillText(t.label, 0, 0);
    } else {
      txCtx.fillText(t.label, t.x, t.y);
    }
    txCtx.restore();
  }

  // Draw rotation handle on selected text
  if (selectedText && selectedText.visible && selectedText.label && !isTx) {
    const t = selectedText;
    txCtx.save();
    txCtx.font = textFont(t);
    const metrics = txCtx.measureText(t.label);
    const rot = t.rotation || 0;
    // Handle position: right edge of text, vertically centered
    const hx = metrics.width + 8;
    const hy = -t.fontSize / 2;
    let handleX, handleY;
    if (rot) {
      const cos = Math.cos(rot), sin = Math.sin(rot);
      handleX = t.x + hx * cos - hy * sin;
      handleY = t.y + hx * sin + hy * cos;
    } else {
      handleX = t.x + hx;
      handleY = t.y + hy;
    }
    // Small circle handle
    txCtx.beginPath();
    txCtx.arc(handleX, handleY, 4, 0, Math.PI * 2);
    txCtx.fillStyle = '#4fc3f7';
    txCtx.fill();
    txCtx.strokeStyle = '#fff';
    txCtx.lineWidth = 1;
    txCtx.stroke();
    // Dashed line from text anchor to handle
    txCtx.beginPath();
    const lineStartX = rot ? t.x + metrics.width * Math.cos(rot) : t.x + metrics.width;
    const lineStartY = rot ? t.y + metrics.width * Math.sin(rot) : t.y;
    txCtx.moveTo(lineStartX, lineStartY - (rot ? t.fontSize/2 * Math.cos(rot + Math.PI/2) : t.fontSize/2));
    txCtx.setLineDash([2, 2]);
    txCtx.strokeStyle = 'rgba(79,195,247,0.5)';
    txCtx.stroke();
    txCtx.setLineDash([]);
    txCtx.restore();
  }
}

// ===== DRAG / ROTATE TEXT ON TX CANVAS =====================================

function textFont(t) {
  return (t.italic ? 'italic ' : '') + (t.bold ? 'bold ' : '') + t.fontSize + 'px "Segoe UI", sans-serif';
}

function canvasToImageCoords(e) {
  const rect = txCanvas.getBoundingClientRect();
  const scaleX = txCanvas.width / rect.width;
  const scaleY = txCanvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

// Get the rotation handle position for a text element
function getRotateHandle(t) {
  txCtx.font = textFont(t);
  const metrics = txCtx.measureText(t.label);
  const hx = metrics.width + 8;
  const hy = -t.fontSize / 2;
  const rot = t.rotation || 0;
  if (rot) {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return { x: t.x + hx * cos - hy * sin, y: t.y + hx * sin + hy * cos };
  }
  return { x: t.x + hx, y: t.y + hy };
}

// Hit-test the rotation handle of the selected text (small circle)
function hitTestRotateHandle(mx, my) {
  if (!selectedText || !selectedText.visible || !selectedText.label) return false;
  const h = getRotateHandle(selectedText);
  const dx = mx - h.x, dy = my - h.y;
  return dx * dx + dy * dy <= 64; // 8px radius for easy grabbing
}

// Hit-test text body (supports rotation via inverse transform)
function hitTestText(mx, my) {
  for (let i = textElements.length - 1; i >= 0; i--) {
    const t = textElements[i];
    if (!t.visible || !t.label) continue;
    txCtx.font = textFont(t);
    const metrics = txCtx.measureText(t.label);
    const textW = metrics.width;
    const textH = t.fontSize;
    const rot = t.rotation || 0;
    // Transform mouse coords into the text element's local space
    let lx, ly;
    if (rot) {
      const dx = mx - t.x, dy = my - t.y;
      const cos = Math.cos(-rot), sin = Math.sin(-rot);
      lx = dx * cos - dy * sin;
      ly = dx * sin + dy * cos;
    } else {
      lx = mx - t.x;
      ly = my - t.y;
    }
    // Local bounding box: 0..textW horizontally, -textH..+2 vertically
    if (lx >= 0 && lx <= textW && ly >= -textH && ly <= 2) {
      return t;
    }
  }
  return null;
}

let replyDrag = false;

function hitTestReplyInset(mx, my) {
  if (!replyImage || replyInset._drawW == null) return false;
  return mx >= replyInset._drawX && mx <= replyInset._drawX + replyInset._drawW &&
         my >= replyInset._drawY && my <= replyInset._drawY + replyInset._drawH;
}

txCanvas.addEventListener('mousedown', (e) => {
  if (isTx) return;
  const pos = canvasToImageCoords(e);

  // Check reply inset drag
  if (hitTestReplyInset(pos.x, pos.y)) {
    replyDrag = true;
    dragOffsetX = pos.x - replyInset._drawX;
    dragOffsetY = pos.y - replyInset._drawY;
    e.preventDefault();
    return;
  }

  // Check rotation handle first (only for selected element)
  if (hitTestRotateHandle(pos.x, pos.y)) {
    rotateTarget = selectedText;
    e.preventDefault();
    return;
  }

  const hit = hitTestText(pos.x, pos.y);
  if (hit) {
    dragTarget = hit;
    dragOffsetX = pos.x - hit.x;
    dragOffsetY = pos.y - hit.y;
    selectedText = hit;
    renderTextLayers();
    renderTextProps();
    e.preventDefault();
  } else {
    if (selectedText) {
      selectedText = null;
      renderTextLayers();
      renderTextProps();
      renderTxPreview();
    }
  }
});

txCanvas.addEventListener('mousemove', (e) => {
  const pos = canvasToImageCoords(e);

  if (replyDrag) {
    replyInset.x = Math.max(0, Math.min(txCanvas.width - replyInset._drawW, pos.x - dragOffsetX));
    replyInset.y = Math.max(0, Math.min(txCanvas.height - replyInset._drawH, pos.y - dragOffsetY));
    renderTxPreview();
    return;
  }

  if (rotateTarget) {
    const dx = pos.x - rotateTarget.x;
    const dy = pos.y - rotateTarget.y;
    rotateTarget.rotation = Math.atan2(dy, dx);
    renderTxPreview();
    return;
  }

  if (dragTarget) {
    dragTarget.x = Math.max(0, Math.min(txCanvas.width - 10, pos.x - dragOffsetX));
    dragTarget.y = Math.max(dragTarget.fontSize, Math.min(txCanvas.height, pos.y - dragOffsetY));
    renderTxPreview();
  } else {
    // Cursor feedback
    if (hitTestReplyInset(pos.x, pos.y)) {
      txCanvas.style.cursor = 'move';
    } else if (hitTestRotateHandle(pos.x, pos.y)) {
      txCanvas.style.cursor = 'grab';
    } else {
      const hit = hitTestText(pos.x, pos.y);
      txCanvas.style.cursor = hit ? 'move' : 'crosshair';
    }
  }
});

txCanvas.addEventListener('mouseup', () => {
  if (replyDrag) { replyDrag = false; return; }
  if (rotateTarget) {
    rotateTarget = null;
    onTextChanged();
    renderTextLayers();
    renderTextProps();
    return;
  }
  if (dragTarget) {
    dragTarget = null;
    onTextChanged();
    renderTextLayers();
  }
});

// Scroll to resize reply inset
txCanvas.addEventListener('wheel', (e) => {
  if (!replyImage) return;
  const pos = canvasToImageCoords(e);
  if (hitTestReplyInset(pos.x, pos.y)) {
    e.preventDefault();
    replyInset.scale = Math.max(0.1, Math.min(0.8, replyInset.scale + (e.deltaY < 0 ? 0.03 : -0.03)));
    renderTxPreview();
  }
}, { passive: false });

txCanvas.addEventListener('mouseleave', () => {
  dragTarget = null;
  rotateTarget = null;
  replyDrag = false;
});

// ===== TEMPLATES ===========================================================

const tplStrip = document.getElementById('tpl-strip');
const tplSaveBtn = document.getElementById('tpl-save-btn');
const tplCount = document.getElementById('tpl-count');

tplSaveBtn.addEventListener('click', () => {
  if (templates.length >= 12) {
    statusBar.textContent = 'Max 12 templates — delete one first';
    return;
  }
  // Generate thumbnail from current TX canvas
  const thumbC = document.createElement('canvas');
  const thumbScale = 70 / txCanvas.width;
  thumbC.width = 70;
  thumbC.height = Math.round(txCanvas.height * thumbScale);
  const thumbCtx = thumbC.getContext('2d');
  thumbCtx.drawImage(txCanvas, 0, 0, thumbC.width, thumbC.height);
  const thumbnail = thumbC.toDataURL('image/png');

  // Save background as data URL if it's a photo (not a pattern)
  let bgDataUrl = null;
  if (bgImage && !bgParams) {
    // Photo background — save as data URL
    const c = document.createElement('canvas');
    c.width = bgImage.width || bgImage.naturalWidth;
    c.height = bgImage.height || bgImage.naturalHeight;
    c.getContext('2d').drawImage(bgImage, 0, 0);
    bgDataUrl = c.toDataURL('image/jpeg', 0.85);
  }

  const tpl = {
    bgParams: bgParams ? JSON.parse(JSON.stringify(bgParams)) : null,
    bgDataUrl,
    texts: textElements.map(t => ({ key: t.key, x: t.x, y: t.y, fontSize: t.fontSize, bold: t.bold, italic: t.italic, color: t.color, rotation: t.rotation || 0, visible: t.visible, label: t.label })),
    thumbnail,
  };
  templates.push(tpl);
  activeTemplateIdx = templates.length - 1;
  saveTemplates();
  renderTemplateStrip();
  statusBar.textContent = 'Template saved (' + templates.length + ')';
});

function loadTemplate(idx) {
  const tpl = templates[idx];
  if (!tpl) return;
  activeTemplateIdx = idx;

  // Rebuild textElements from template — restore all layers including user-created
  textElements = tpl.texts.map(saved => ({
    key: saved.key,
    label: saved.label || '',
    x: saved.x, y: saved.y,
    fontSize: saved.fontSize || 14,
    bold: !!saved.bold,
    italic: !!saved.italic,
    color: saved.color || '#ffffff',
    rotation: saved.rotation || 0,
    visible: saved.visible !== false,
  }));

  // Re-fill auto-labels with current callsign/grid
  syncAutoLabels();

  // Update user text counter
  userTextCounter = textElements.filter(t => t.key.startsWith('user-')).length;

  selectedText = null;
  textPropsEl.style.display = 'none';

  // Restore background
  if (tpl.bgParams) {
    generateRandomPattern(tpl.bgParams);
  } else if (tpl.bgDataUrl) {
    const img = new Image();
    img.onload = () => { bgImage = img; bgParams = null; renderTxPreview(); };
    img.src = tpl.bgDataUrl;
  }

  renderTextLayers();
  renderTemplateStrip();
  renderTxPreview();
}

function deleteTemplate(idx) {
  templates.splice(idx, 1);
  if (activeTemplateIdx === idx) activeTemplateIdx = -1;
  else if (activeTemplateIdx > idx) activeTemplateIdx--;
  saveTemplates();
  renderTemplateStrip();
}

function saveTemplates() {
  window.api.saveSettings({ sstvTemplates: templates });
}

function renderTemplateStrip() {
  // Remove all template thumbnails (keep the + button)
  while (tplStrip.firstChild !== tplSaveBtn) {
    tplStrip.removeChild(tplStrip.firstChild);
  }
  tplCount.textContent = templates.length ? '(' + templates.length + ')' : '';
  for (let i = 0; i < templates.length; i++) {
    const tpl = templates[i];
    const div = document.createElement('div');
    div.className = 'sstv-tpl' + (i === activeTemplateIdx ? ' active' : '');
    const img = document.createElement('img');
    img.src = tpl.thumbnail;
    div.appendChild(img);
    // Delete button
    const del = document.createElement('button');
    del.className = 'sstv-tpl-del';
    del.textContent = '\u2715';
    del.title = 'Delete template';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTemplate(i); });
    div.appendChild(del);
    // Click to load
    div.addEventListener('click', () => loadTemplate(i));
    tplStrip.insertBefore(div, tplSaveBtn);
  }
}

// ===== TX ==================================================================

txBtn.addEventListener('click', () => {
  if (isTx) {
    // Cancel TX — stop audio playback and release PTT
    if (txAudioCtx) { try { txAudioCtx.close(); } catch {} txAudioCtx = null; }
    txPlaying = false;
    isTx = false;
    window.api.sstvTxComplete();
    txBtn.textContent = replyImage ? 'REPLY' : 'TRANSMIT';
    txBtn.classList.remove('transmitting');
    progressBar.classList.remove('tx');
    progressBar.style.width = '0%';
    statusBar.textContent = 'TX cancelled';
    return;
  }
  const mode = modeSelect.value;
  const res = MODE_RES[mode] || { w: 320, h: 256 };
  // Get final composited image data from TX canvas
  const imageData = txCtx.getImageData(0, 0, res.w, res.h);
  // Send to main process for encoding
  window.api.sstvEncode({
    imageData: Array.from(imageData.data),
    width: res.w,
    height: res.h,
    mode: mode,
  });
  isTx = true;
  txBtn.textContent = 'TRANSMITTING...';
  txBtn.classList.add('transmitting');
  progressBar.style.width = '0%';
  progressBar.classList.add('tx');
  statusBar.textContent = 'Encoding...';
});

// TX audio received — play it
window.api.onSstvTxAudio(async (data) => {
  // Mark TX active — stops decoder from hearing our own audio
  isTx = true;
  txBtn.textContent = 'TRANSMITTING...';
  txBtn.classList.add('transmitting');
  progressBar.style.width = '0%';
  progressBar.classList.add('tx');

  const samplesArray = data.samples || data;
  const gainLevel = (txGainSlider.value / 100) || 0.5;

  try {
    const outputDeviceId = (await window.api.getSettings()).sstvAudioOutput || '';
    if (!txAudioCtx || txAudioCtx.state === 'closed') {
      txAudioCtx = new AudioContext({ sampleRate: 48000 });
    }
    if (txAudioCtx.state === 'suspended') await txAudioCtx.resume();

    if (outputDeviceId && txAudioCtx.setSinkId) {
      try { await txAudioCtx.setSinkId(outputDeviceId); } catch (e) {
        console.warn('[SSTV] Could not set TX output device:', e.message);
      }
    }

    const samples = new Float32Array(samplesArray);
    const buffer = txAudioCtx.createBuffer(1, samples.length, 48000);
    buffer.getChannelData(0).set(samples);

    const source = txAudioCtx.createBufferSource();
    source.buffer = buffer;
    const gain = txAudioCtx.createGain();
    gain.gain.value = gainLevel;
    source.connect(gain);
    gain.connect(txAudioCtx.destination);

    txPlaying = true;
    const durationSec = buffer.duration;
    statusBar.textContent = 'Transmitting ' + modeSelect.value + '... ' + durationSec.toFixed(0) + 's';

    // Progress animation
    const startTime = Date.now();
    const progressInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      const pct = Math.min(100, (elapsed / durationSec) * 100);
      progressBar.style.width = pct + '%';
    }, 200);

    let txDone = false;
    function finishTx() {
      if (txDone) return;
      txDone = true;
      txPlaying = false;
      clearInterval(progressInterval);
      progressBar.style.width = '100%';
      window.api.sstvTxComplete();
      isTx = false;
      txBtn.textContent = replyImage ? 'REPLY' : 'TRANSMIT';
      txBtn.classList.remove('transmitting');
      progressBar.classList.remove('tx');
      setTimeout(() => { progressBar.style.width = '0%'; }, 1000);
      statusBar.textContent = 'TX complete';
      // Clear reply after successful TX
      if (replyImage) {
        replyImage = null;
        clearReplyBtn.style.display = 'none';
        txBtn.classList.remove('reply-mode');
        renderTxPreview();
      }
    }

    source.onended = finishTx;
    source.start(0);

    // Safety timeout
    setTimeout(() => {
      if (!txDone) {
        console.warn('[SSTV] TX safety timeout');
        finishTx();
      }
    }, (durationSec + 5) * 1000);

  } catch (err) {
    console.error('[SSTV] TX playback error:', err);
    isTx = false;
    txBtn.textContent = 'TRANSMIT';
    txBtn.classList.remove('transmitting');
    window.api.sstvTxComplete();
    statusBar.textContent = 'TX error: ' + err.message;
  }
});

// TX status updates
window.api.onSstvTxStatus((data) => {
  if (data.state === 'rx') {
    isTx = false;
    txBtn.textContent = replyImage ? 'REPLY' : 'TRANSMIT';
    txBtn.classList.remove('transmitting');
  }
});

// Paint the TX canvas when ECHOCAT sends a photo — so the operator at the
// desktop sees what their phone is transmitting. This replaces any local
// compose with the phone's rendered image for the duration of the TX.
window.api.onSstvTxImage((data) => {
  try {
    const w = data.width, h = data.height;
    txCanvas.width = w; txCanvas.height = h;
    const rgba = new Uint8ClampedArray(data.imageData);
    const imgData = new ImageData(rgba, w, h);
    txCtx.putImageData(imgData, 0, 0);
    statusBar.textContent = 'ECHOCAT TX: ' + data.mode + ' (' + w + 'x' + h + ')';
    rxInfo.textContent = 'TX from phone — ' + data.mode;
  } catch (err) {
    console.error('[SSTV] TX image display error:', err);
  }
});

// ===== RX ==================================================================
// RX event handlers are registered in the MULTI-SLICE section below,
// which handles both single-slice and multi-slice routing.

// Engine status
window.api.onSstvStatus((data) => {
  if (data.state === 'running' && !multiActive) {
    rxInfo.textContent = 'Listening...';
  }
});

// ===== GALLERY =============================================================

async function loadGallery() {
  try {
    const images = await window.api.sstvGetGallery();
    if (images && images.length) {
      for (const img of images) {
        galleryImages.push({
          filename: img.filename,
          dataUrl: img.dataUrl,
          mode: img.mode,
          timestamp: img.timestamp,
          width: img.width || 320,
          height: img.height || 256,
        });
      }
      renderGallery();
    }
  } catch (e) {
    console.warn('[SSTV] Gallery load error:', e);
  }
}

function renderGallery() {
  gallery.innerHTML = '';
  // Sort by timestamp descending (newest first)
  galleryImages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  galleryCount.textContent = '(' + galleryImages.length + ')';
  for (let i = 0; i < galleryImages.length; i++) {
    const entry = galleryImages[i];
    const thumb = document.createElement('div');
    thumb.className = 'sstv-thumb';
    const img = document.createElement('img');
    img.src = entry.dataUrl;
    img.alt = entry.mode;
    thumb.appendChild(img);
    const info = document.createElement('div');
    info.className = 'sstv-thumb-info';
    const d = entry.timestamp ? new Date(entry.timestamp) : null;
    const dateStr = d ? d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    info.textContent = dateStr + ' ' + (entry.mode || '');
    thumb.appendChild(info);

    // Click to view fullscreen
    thumb.addEventListener('click', () => viewImageFullscreen(entry.dataUrl));
    // Double-click to set as reply
    thumb.addEventListener('dblclick', (e) => { e.stopPropagation(); setReplyImage(entry); });
    // Right-click to delete
    thumb.addEventListener('contextmenu', ((idx, fn) => (e) => {
      e.preventDefault();
      showImageContextMenu(e.clientX, e.clientY, idx, fn);
    })(i, entry.filename));

    // Reply button — overlaid on the thumbnail so the feature is discoverable
    // without relying on the double-click shortcut
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.textContent = '↩ Reply';
    replyBtn.title = 'Use this as the PiP reply inset on your next TX';
    replyBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(233,69,96,0.92);color:#fff;border:none;border-radius:3px;font-size:10px;font-weight:700;padding:3px 6px;cursor:pointer;z-index:2;';
    replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setReplyImage(entry);
    });
    thumb.style.position = thumb.style.position || 'relative';
    thumb.appendChild(replyBtn);

    gallery.appendChild(thumb);
  }
}

function showImageContextMenu(x, y, idx, filename) {
  // Remove any existing context menu
  const old = document.getElementById('sstv-ctx-menu');
  if (old) old.remove();

  const menu = document.createElement('div');
  menu.id = 'sstv-ctx-menu';
  menu.style.cssText = 'position:fixed;z-index:10000;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);padding:4px 0;min-width:120px;';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const deleteItem = document.createElement('div');
  deleteItem.textContent = 'Delete';
  deleteItem.style.cssText = 'padding:6px 14px;font-size:13px;color:#e94560;cursor:pointer;';
  deleteItem.addEventListener('mouseenter', () => { deleteItem.style.background = 'var(--bg-hover)'; });
  deleteItem.addEventListener('mouseleave', () => { deleteItem.style.background = ''; });
  deleteItem.addEventListener('click', async () => {
    menu.remove();
    if (filename) await window.api.sstvDeleteImage(filename);
    galleryImages.splice(idx, 1);
    renderGallery();
    statusBar.textContent = 'Image deleted';
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', function closeCtx() {
      menu.remove();
      document.removeEventListener('click', closeCtx);
    }, { once: true });
  }, 10);
}

function viewImageFullscreen(src) {
  if (!src) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer;';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:95%;max-height:95%;image-rendering:pixelated;border-radius:4px;box-shadow:0 4px 20px rgba(0,0,0,0.5);';
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function setReplyImage(entry) {
  // Reset inset position/scale for new reply
  replyInset.x = -1; replyInset.y = -1; replyInset.scale = 0.28; replyInset.rotation = 0;
  replyInset._canvasDirty = true;
  if (entry.imageData) {
    replyImage = {
      data: new Uint8ClampedArray(entry.imageData),
      width: entry.width,
      height: entry.height,
    };
  } else if (entry.dataUrl) {
    // Load from data URL
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx2 = c.getContext('2d');
      ctx2.drawImage(img, 0, 0);
      const idata = ctx2.getImageData(0, 0, img.width, img.height);
      replyImage = {
        data: idata.data,
        width: img.width,
        height: img.height,
      };
      clearReplyBtn.style.display = '';
      txBtn.textContent = 'REPLY';
      txBtn.classList.add('reply-mode');
      renderTxPreview();
    };
    img.src = entry.dataUrl;
    return;
  }
  clearReplyBtn.style.display = '';
  txBtn.textContent = 'REPLY';
  txBtn.classList.add('reply-mode');
  renderTxPreview();
}

clearReplyBtn.addEventListener('click', () => {
  replyImage = null;
  clearReplyBtn.style.display = 'none';
  txBtn.textContent = 'TRANSMIT';
  txBtn.classList.remove('reply-mode');
  renderTxPreview();
});

// On-canvas "Reply with this" button — uses the latest decode directly
const rxReplyBtnEl = document.getElementById('rx-reply-btn');
if (rxReplyBtnEl) {
  rxReplyBtnEl.addEventListener('click', () => {
    if (!lastRxImage) return;
    setReplyImage({
      imageData: lastRxImage.imageData,
      width: lastRxImage.width,
      height: lastRxImage.height,
      mode: lastRxImage.mode,
    });
  });
}

openFolderBtn.addEventListener('click', () => window.api.sstvOpenGalleryFolder());

// ===== AUDIO CAPTURE (RX) ==================================================

async function populateAudioDevices() {
  try {
    const devices = await window.api.enumerateAudioDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');

    audioInputSelect.innerHTML = '<option value="">Default</option>';
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || d.deviceId.slice(0, 20);
      audioInputSelect.appendChild(opt);
    }
    if (settings.sstvAudioInput) audioInputSelect.value = settings.sstvAudioInput;

    audioOutputSelect.innerHTML = '<option value="">Default</option>';
    for (const d of outputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || d.deviceId.slice(0, 20);
      audioOutputSelect.appendChild(opt);
    }
    if (settings.sstvAudioOutput) audioOutputSelect.value = settings.sstvAudioOutput;
  } catch (e) {
    console.warn('[SSTV] Audio device enumeration failed:', e);
  }
}

audioInputSelect.addEventListener('change', async () => {
  await window.api.saveSettings({ sstvAudioInput: audioInputSelect.value });
  await startRxAudio();
});

audioOutputSelect.addEventListener('change', () => {
  window.api.saveSettings({ sstvAudioOutput: audioOutputSelect.value });
});

async function startRxAudio() {
  // Stop existing capture
  if (sstvWorkletNode) { try { sstvWorkletNode.disconnect(); } catch {} sstvWorkletNode = null; }
  if (sstvStream) { sstvStream.getTracks().forEach(t => t.stop()); sstvStream = null; }
  if (sstvAudioCtx) { try { sstvAudioCtx.close(); } catch {} sstvAudioCtx = null; }

  try {
    const deviceId = audioInputSelect.value || undefined;
    const constraints = { audio: { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };

    sstvStream = await navigator.mediaDevices.getUserMedia(constraints);
    sstvAudioCtx = new AudioContext({ sampleRate: 48000 });
    await sstvAudioCtx.audioWorklet.addModule('sstv-audio-worklet.js');

    const source = sstvAudioCtx.createMediaStreamSource(sstvStream);
    sstvWorkletNode = new AudioWorkletNode(sstvAudioCtx, 'sstv-processor');
    source.connect(sstvWorkletNode);
    sstvWorkletNode.connect(sstvAudioCtx.destination); // needed to keep processing

    sstvWorkletNode.port.onmessage = (e) => {
      // Send audio samples to main process for SSTV decoder (skip during TX to avoid self-decode)
      if (!isTx) window.api.sstvAudio(e.data);
      // Feed waterfall
      feedWaterfall(e.data);
    };

    // Report actual sample rate to the engine (may differ from requested 48000)
    const actualRate = sstvAudioCtx.sampleRate;
    if (actualRate !== 48000) {
      console.warn('[SSTV] Audio sample rate: ' + actualRate + ' Hz (expected 48000)');
    }
    window.api.sstvSetSampleRate(actualRate);

    rxInfo.textContent = 'Listening...';
    statusBar.textContent = 'RX audio started (' + actualRate + ' Hz)';
  } catch (err) {
    console.error('[SSTV] RX audio start error:', err);
    rxInfo.textContent = 'No audio input';
    statusBar.textContent = 'Audio error: ' + err.message;
  }
}

// ===== MULTI-SLICE =========================================================

const multiPanel = document.getElementById('multi-panel');
const multiSlicesEl = document.getElementById('multi-slices');
const multiBtn = document.getElementById('multi-btn');
const multiAddBtn = document.getElementById('multi-add');
const multiStartBtn = document.getElementById('multi-start');
const multiStopBtn = document.getElementById('multi-stop');
const rxGrid = document.getElementById('rx-grid');
const panesContainer = document.querySelector('.sstv-panes');
const singleRxPane = document.querySelector('.sstv-panes .sstv-pane:first-child');
const txPane = document.querySelector('.sstv-panes .sstv-pane:last-child');

let multiActive = false;
let multiSliceConfigs = JSON.parse(localStorage.getItem('sstv-multi-slices') || '[]');
let multiAudioStreams = new Map(); // sliceId -> {ctx, stream, worklet}
let multiRxPanes = new Map();     // sliceId -> {canvas, ctx, wfCanvas, wfCtx, statusEl}
let multiAudioDeviceList = [];

const SLICE_NAMES = { 5002: 'A', 5003: 'B', 5004: 'C', 5005: 'D' };

const SSTV_FREQS_OPTIONS = `
  <optgroup label="80m"><option value="3730" data-mode="LSB">3.730 (EU)</option><option value="3845" data-mode="LSB">3.845 (NA)</option></optgroup>
  <optgroup label="40m"><option value="7165" data-mode="LSB">7.165</option><option value="7171" data-mode="LSB">7.171</option></optgroup>
  <optgroup label="20m"><option value="14227" data-mode="USB">14.227</option><option value="14230" data-mode="USB">14.230</option><option value="14233" data-mode="USB">14.233</option></optgroup>
  <optgroup label="17m"><option value="18161" data-mode="USB">18.161</option></optgroup>
  <optgroup label="15m"><option value="21340" data-mode="USB">21.340</option></optgroup>
  <optgroup label="12m"><option value="24975" data-mode="USB">24.975</option></optgroup>
  <optgroup label="10m"><option value="28680" data-mode="USB">28.680</option></optgroup>
  <optgroup label="6m"><option value="50680" data-mode="USB">50.680</option></optgroup>`;

function saveMultiSliceConfigs() {
  localStorage.setItem('sstv-multi-slices', JSON.stringify(multiSliceConfigs));
}

multiBtn.addEventListener('click', () => {
  multiPanel.classList.toggle('hidden');
  multiBtn.classList.toggle('active', !multiPanel.classList.contains('hidden'));
  if (!multiPanel.classList.contains('hidden')) {
    if (multiSliceConfigs.length === 0) {
      multiSliceConfigs = [
        { sliceId: 'slice-a', slicePort: 5002, freqKhz: 14230, audioDeviceId: '' },
        { sliceId: 'slice-b', slicePort: 5003, freqKhz: 14233, audioDeviceId: '' },
      ];
    }
    refreshMultiAudioDevices();
  }
});

function refreshMultiAudioDevices() {
  window.api.enumerateAudioDevices().then((devices) => {
    multiAudioDeviceList = devices.filter(d => d.kind === 'audioinput');
    renderMultiSlices();
  });
}

function renderMultiSlices() {
  multiSlicesEl.innerHTML = '';
  multiSliceConfigs.forEach((cfg, idx) => {
    const row = document.createElement('div');
    row.className = 'sstv-multi-row';

    // Slice port selector (A/B/C/D)
    const sliceSel = document.createElement('select');
    [5002, 5003, 5004, 5005].forEach(p => {
      const o = document.createElement('option');
      o.value = p; o.textContent = 'Slice ' + SLICE_NAMES[p];
      sliceSel.appendChild(o);
    });
    sliceSel.value = cfg.slicePort;
    sliceSel.addEventListener('change', () => {
      cfg.slicePort = parseInt(sliceSel.value);
      cfg.sliceId = 'slice-' + SLICE_NAMES[cfg.slicePort].toLowerCase();
      saveMultiSliceConfigs();
    });
    row.appendChild(sliceSel);

    // Frequency selector
    const freqSel = document.createElement('select');
    freqSel.className = 'multi-freq';
    freqSel.innerHTML = SSTV_FREQS_OPTIONS;
    freqSel.value = cfg.freqKhz;
    freqSel.addEventListener('change', () => {
      cfg.freqKhz = parseInt(freqSel.value);
      saveMultiSliceConfigs();
    });
    row.appendChild(freqSel);

    // Audio device selector
    const audioSel = document.createElement('select');
    audioSel.className = 'multi-audio';
    const defOpt = document.createElement('option');
    defOpt.value = ''; defOpt.textContent = 'Default';
    audioSel.appendChild(defOpt);
    multiAudioDeviceList.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || d.deviceId.slice(0, 25);
      audioSel.appendChild(o);
    });
    audioSel.value = cfg.audioDeviceId;
    audioSel.addEventListener('change', () => {
      cfg.audioDeviceId = audioSel.value;
      saveMultiSliceConfigs();
    });
    row.appendChild(audioSel);

    // Delete button
    if (multiSliceConfigs.length > 1) {
      const del = document.createElement('button');
      del.className = 'multi-del'; del.textContent = '\u2715';
      del.addEventListener('click', () => {
        multiSliceConfigs.splice(idx, 1);
        saveMultiSliceConfigs();
        renderMultiSlices();
      });
      row.appendChild(del);
    }

    multiSlicesEl.appendChild(row);
  });
}

multiAddBtn.addEventListener('click', () => {
  if (multiSliceConfigs.length >= 4) { statusBar.textContent = 'Max 4 slices'; return; }
  const usedPorts = multiSliceConfigs.map(c => c.slicePort);
  const nextPort = [5002, 5003, 5004, 5005].find(p => !usedPorts.includes(p)) || 5005;
  multiSliceConfigs.push({
    sliceId: 'slice-' + SLICE_NAMES[nextPort].toLowerCase(),
    slicePort: nextPort, freqKhz: 14230, audioDeviceId: '',
  });
  saveMultiSliceConfigs();
  renderMultiSlices();
});

multiStartBtn.addEventListener('click', async () => {
  multiActive = true;
  multiStartBtn.style.display = 'none';
  multiStopBtn.style.display = '';

  // Normalize sliceIds based on port
  multiSliceConfigs.forEach(c => {
    c.sliceId = 'slice-' + SLICE_NAMES[c.slicePort].toLowerCase();
  });
  saveMultiSliceConfigs();

  // Tune each Flex slice to its SSTV frequency (creates the slice if needed)
  for (const cfg of multiSliceConfigs) {
    window.api.tune(String(cfg.freqKhz), cfg.freqKhz < 10000 ? 'LSB' : 'USB', undefined, cfg.slicePort);
  }

  // Build decode panes
  buildRxGrid();

  // Start engines in main process
  window.api.sstvStartMulti(multiSliceConfigs);

  // Start per-slice audio capture
  await startMultiAudio();

  statusBar.textContent = 'Multi-slice monitoring: ' + multiSliceConfigs.length + ' slices';
});

multiStopBtn.addEventListener('click', () => {
  multiActive = false;
  multiStartBtn.style.display = '';
  multiStopBtn.style.display = 'none';

  // Stop engines
  window.api.sstvStopMulti();
  stopMultiAudio();

  // Restore single-pane layout
  singleRxPane.style.display = '';
  rxGrid.classList.add('hidden');
  rxGrid.style.display = 'none';
  rxGrid.innerHTML = '';
  // Remove any inline multi-panes that were inserted into the panes container
  panesContainer.querySelectorAll('.sstv-rx-pane-inline').forEach(el => el.remove());
  multiRxPanes.clear();

  statusBar.textContent = 'Multi-slice stopped';
});

function buildMultiPane(cfg) {
  const pane = document.createElement('div');
  pane.className = 'sstv-rx-pane';

  const label = document.createElement('div');
  label.className = 'sstv-rx-pane-label';
  label.textContent = SLICE_NAMES[cfg.slicePort] + ': ' + (cfg.freqKhz / 1000).toFixed(3) + ' MHz';
  pane.appendChild(label);

  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 256;
  canvas.style.cssText = 'display:block;width:100%;height:auto;image-rendering:pixelated;';
  pane.appendChild(canvas);

  const wfCanvas = document.createElement('canvas');
  wfCanvas.width = 320; wfCanvas.height = 40;
  wfCanvas.className = 'sstv-wf-mini';
  wfCanvas.style.cssText = 'display:block;width:100%;height:40px;image-rendering:pixelated;';
  pane.appendChild(wfCanvas);

  const statusEl = document.createElement('div');
  statusEl.className = 'sstv-rx-pane-status';
  statusEl.textContent = 'Listening...';
  pane.appendChild(statusEl);

  multiRxPanes.set(cfg.sliceId, {
    canvas, ctx: canvas.getContext('2d'),
    wfCanvas, wfCtx: wfCanvas.getContext('2d'),
    statusEl,
  });
  return pane;
}

function buildRxGrid() {
  rxGrid.innerHTML = '';
  multiRxPanes.clear();
  // Remove any previous inline panes
  panesContainer.querySelectorAll('.sstv-rx-pane-inline').forEach(el => el.remove());

  if (multiSliceConfigs.length === 1) {
    // Single slice: replace the RX pane content inline, keeping side-by-side with TX
    singleRxPane.style.display = 'none';
    rxGrid.style.display = 'none';
    const pane = buildMultiPane(multiSliceConfigs[0]);
    pane.classList.add('sstv-rx-pane-inline');
    pane.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
    panesContainer.insertBefore(pane, txPane);
  } else {
    // 2+ slices: use grid below the TX compose pane
    singleRxPane.style.display = 'none';
    rxGrid.classList.remove('hidden');
    rxGrid.style.display = 'grid';
    rxGrid.className = 'sstv-rx-grid cols-2';
    for (const cfg of multiSliceConfigs) {
      rxGrid.appendChild(buildMultiPane(cfg));
    }
  }
}

async function startMultiAudio() {
  stopMultiAudio();

  // Check for duplicate or missing audio devices — each slice needs a different DAX channel
  const usedDevices = new Set();
  let warnDupes = false;
  for (const cfg of multiSliceConfigs) {
    const devId = cfg.audioDeviceId || '(default)';
    if (usedDevices.has(devId)) warnDupes = true;
    usedDevices.add(devId);
  }
  if (warnDupes) {
    statusBar.textContent = 'Warning: multiple slices share the same audio device — select a different DAX channel for each';
  }

  for (const cfg of multiSliceConfigs) {
    const pane = multiRxPanes.get(cfg.sliceId);
    try {
      if (!cfg.audioDeviceId) {
        // No device selected — show warning on this pane
        if (pane) pane.statusEl.textContent = 'No audio device selected — pick a DAX channel';
        continue;
      }

      const constraints = { audio: { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: cfg.audioDeviceId } } };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule('sstv-audio-worklet.js');

      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'sstv-processor');
      source.connect(worklet);
      worklet.connect(ctx.destination);

      // Closure captures sliceId for this worklet
      worklet.port.onmessage = ((id) => (e) => {
        window.api.sstvSliceAudio(id, e.data);
        feedSliceWaterfall(id, e.data);
      })(cfg.sliceId);

      multiAudioStreams.set(cfg.sliceId, { ctx, stream, worklet });
      if (pane) pane.statusEl.textContent = 'Listening...';
    } catch (err) {
      console.error('[SSTV Multi] Audio start error for ' + cfg.sliceId + ':', err.message);
      if (pane) pane.statusEl.textContent = 'Audio error: ' + err.message;
    }
  }
}

function stopMultiAudio() {
  for (const [, entry] of multiAudioStreams) {
    try { entry.worklet.disconnect(); } catch {}
    try { entry.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { entry.ctx.close(); } catch {}
  }
  multiAudioStreams.clear();
}

// Route multi-slice waterfall data (per-slice accumulator)
const sliceWfAccum = new Map(); // sliceId -> []

function feedSliceWaterfall(sliceId, samples) {
  const pane = multiRxPanes.get(sliceId);
  if (!pane) return;
  if (!sliceWfAccum.has(sliceId)) sliceWfAccum.set(sliceId, []);
  const accum = sliceWfAccum.get(sliceId);
  for (let i = 0; i < samples.length; i++) accum.push(samples[i]);

  while (accum.length >= WF_FFT_SIZE) {
    const block = accum.splice(0, WF_FFT_SIZE);
    const re = new Float64Array(WF_FFT_SIZE);
    const im = new Float64Array(WF_FFT_SIZE);
    for (let i = 0; i < WF_FFT_SIZE; i++) {
      re[i] = block[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WF_FFT_SIZE - 1)));
    }
    fft(re, im);
    const mags = new Float64Array(WF_BIN_COUNT);
    let maxMag = 0;
    for (let b = 0; b < WF_BIN_COUNT; b++) {
      const bi = b + WF_BIN_LO;
      const mag = Math.sqrt(re[bi] * re[bi] + im[bi] * im[bi]);
      mags[b] = mag;
      if (mag > maxMag) maxMag = mag;
    }
    drawSliceWfLine(pane, mags, maxMag);
  }
}

function drawSliceWfLine(pane, mags, maxMag) {
  const w = pane.wfCanvas.width, h = pane.wfCanvas.height;
  const imgData = pane.wfCtx.getImageData(0, 0, w, h);
  pane.wfCtx.putImageData(imgData, 0, 1);
  const lineData = pane.wfCtx.createImageData(w, 1);
  const d = lineData.data;
  const norm = maxMag > 0 ? maxMag : 1;
  for (let x = 0; x < w; x++) {
    const binIdx = Math.floor(x * WF_BIN_COUNT / w);
    const val = Math.log10(1 + mags[binIdx] / norm * 9);
    const [r, g, b] = wfColor(val);
    const idx = x * 4;
    d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = 255;
  }
  pane.wfCtx.putImageData(lineData, 0, 0);
}

// Handle multi-slice decode events — route to correct pane
const _origOnRxVis = window.api.onSstvRxVis;
const _origOnRxLine = window.api.onSstvRxLine;
const _origOnRxImage = window.api.onSstvRxImage;

// Override RX event handlers to support multi-slice routing
window.api.onSstvRxVis((data) => {
  if (data.sliceId && multiActive) {
    const pane = multiRxPanes.get(data.sliceId);
    if (pane) {
      pane.statusEl.textContent = 'Decoding ' + (data.modeName || data.mode) + '...';
      pane.ctx.fillStyle = '#000';
      pane.ctx.fillRect(0, 0, pane.canvas.width, pane.canvas.height);
      const res = MODE_RES[data.mode];
      if (res) { pane.canvas.width = res.w; pane.canvas.height = res.h; }
    }
  } else {
    // Single-slice: existing behavior
    rxInfo.textContent = 'Decoding ' + (data.modeName || data.mode) + '...';
    rxCtx.fillStyle = '#000';
    rxCtx.fillRect(0, 0, rxCanvas.width, rxCanvas.height);
    const res = MODE_RES[data.mode];
    if (res) { rxCanvas.width = res.w; rxCanvas.height = res.h; }
    statusBar.textContent = 'Decoding ' + (data.modeName || data.mode);
    progressBar.style.width = '0%';
    progressBar.classList.remove('tx');
  }
});

window.api.onSstvRxLine((data) => {
  if (data.sliceId && multiActive) {
    const pane = multiRxPanes.get(data.sliceId);
    if (pane) {
      const rgba = new Uint8ClampedArray(data.rgba);
      const imgData = new ImageData(rgba, pane.canvas.width, 1);
      pane.ctx.putImageData(imgData, 0, data.line);
      const pct = Math.round((data.line / data.totalLines) * 100);
      pane.statusEl.textContent = 'Line ' + (data.line + 1) + '/' + data.totalLines + ' (' + pct + '%)';
    }
  } else {
    const rgba = new Uint8ClampedArray(data.rgba);
    const w = rxCanvas.width;
    const imgData = new ImageData(rgba, w, 1);
    rxCtx.putImageData(imgData, 0, data.line);
    const pct = Math.round((data.line / data.totalLines) * 100);
    rxInfo.textContent = 'Line ' + (data.line + 1) + '/' + data.totalLines + ' (' + pct + '%)';
    progressBar.style.width = pct + '%';
  }
});

window.api.onSstvRxImage((data) => {
  if (data.sliceId && multiActive) {
    const pane = multiRxPanes.get(data.sliceId);
    if (pane) {
      pane.statusEl.textContent = data.mode + ' — ' + new Date().toLocaleTimeString();
    }
  } else {
    rxInfo.textContent = data.mode + ' — ' + new Date().toLocaleTimeString();
    progressBar.style.width = '100%';
    setTimeout(() => { progressBar.style.width = '0%'; }, 2000);
    statusBar.textContent = 'Image decoded: ' + data.mode;
    // Stash the latest decode so the on-canvas Reply button can grab it
    lastRxImage = {
      imageData: new Uint8ClampedArray(data.imageData),
      width: data.width,
      height: data.height,
      mode: data.mode,
    };
    const rxReplyBtn = document.getElementById('rx-reply-btn');
    if (rxReplyBtn) rxReplyBtn.style.display = '';
  }

  // Add to gallery regardless of mode
  const w = data.width, h = data.height;
  const tmpC = document.createElement('canvas');
  tmpC.width = w; tmpC.height = h;
  const tmpCtx = tmpC.getContext('2d');
  const imgData = new ImageData(new Uint8ClampedArray(data.imageData), w, h);
  tmpCtx.putImageData(imgData, 0, 0);
  const dataUrl = tmpC.toDataURL('image/png');
  const entry = {
    dataUrl, mode: data.mode, timestamp: Date.now(),
    width: w, height: h, imageData: Array.from(data.imageData),
    sliceId: data.sliceId || null,
  };
  galleryImages.unshift(entry);
  renderGallery();
});

// ===== WATERFALL ===========================================================

// Simple radix-2 FFT (in-place, complex arrays)
function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  // FFT butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i + j + halfLen] - curIm * im[i + j + halfLen];
        const tIm = curRe * im[i + j + halfLen] + curIm * re[i + j + halfLen];
        re[i + j + halfLen] = re[i + j] - tRe;
        im[i + j + halfLen] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

const WF_FFT_SIZE = 4096;  // larger FFT = better frequency resolution (~12 Hz/bin)
const WF_SAMPLE_RATE = 48000;
// SSTV frequency range: 1000-2500 Hz
const WF_FREQ_LO = 1000;
const WF_FREQ_HI = 2500;
const WF_BIN_LO = Math.floor(WF_FREQ_LO * WF_FFT_SIZE / WF_SAMPLE_RATE);
const WF_BIN_HI = Math.ceil(WF_FREQ_HI * WF_FFT_SIZE / WF_SAMPLE_RATE);
const WF_BIN_COUNT = WF_BIN_HI - WF_BIN_LO;
// Adaptive noise floor for waterfall contrast
let wfNoiseFloor = 0;      // running estimate of noise floor magnitude
let wfPeakLevel = 1;       // running estimate of peak signal magnitude
let wfAccum = [];
let wfImageData = null;

// Color map: black -> blue -> cyan -> green -> yellow -> white
function wfColor(val) {
  // val: 0-1, dark blue -> blue -> cyan -> yellow -> white
  const v = Math.max(0, Math.min(1, val));
  if (v < 0.15) return [0, 0, Math.round(v / 0.15 * 100 + 10)];                     // black -> dark blue
  if (v < 0.35) return [0, Math.round((v - 0.15) / 0.2 * 160), Math.round(100 + (v - 0.15) / 0.2 * 155)]; // dark blue -> cyan
  if (v < 0.55) return [0, Math.round(160 + (v - 0.35) / 0.2 * 95), Math.round(255 - (v - 0.35) / 0.2 * 80)]; // cyan -> green
  if (v < 0.75) return [Math.round((v - 0.55) / 0.2 * 255), 255, Math.round(175 - (v - 0.55) / 0.2 * 175)]; // green -> yellow
  return [255, 255, Math.round((v - 0.75) / 0.25 * 255)];                            // yellow -> white
}

function feedWaterfall(samples) {
  // Accumulate samples, run FFT every WF_FFT_SIZE samples
  for (let i = 0; i < samples.length; i++) wfAccum.push(samples[i]);

  while (wfAccum.length >= WF_FFT_SIZE) {
    const block = wfAccum.splice(0, WF_FFT_SIZE);
    const re = new Float64Array(WF_FFT_SIZE);
    const im = new Float64Array(WF_FFT_SIZE);
    // Apply Hann window
    for (let i = 0; i < WF_FFT_SIZE; i++) {
      re[i] = block[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WF_FFT_SIZE - 1)));
    }
    fft(re, im);

    // Extract magnitude for SSTV frequency range
    const mags = new Float64Array(WF_BIN_COUNT);
    let maxMag = 0;
    for (let b = 0; b < WF_BIN_COUNT; b++) {
      const bi = b + WF_BIN_LO;
      const mag = Math.sqrt(re[bi] * re[bi] + im[bi] * im[bi]);
      mags[b] = mag;
      if (mag > maxMag) maxMag = mag;
    }

    drawWaterfallLine(mags, maxMag);

    // Throttled send to main process for ECHOCAT waterfall (~5 lines/sec)
    wfRemoteCounter = (wfRemoteCounter || 0) + 1;
    if (wfRemoteCounter % 10 === 0) {
      const norm = maxMag > 0 ? maxMag : 1;
      const bins = new Array(WF_BIN_COUNT);
      for (let b = 0; b < WF_BIN_COUNT; b++) {
        bins[b] = Math.round(Math.log10(1 + mags[b] / norm * 9) * 255);
      }
      window.api.sstvWfBins(bins);
    }
  }
}
let wfRemoteCounter = 0;

function drawWaterfallLine(mags, maxMag) {
  const w = wfCanvas.width;
  const h = wfCanvas.height;

  // Adapt noise floor and peak level slowly for good contrast
  // Median magnitude as noise floor estimate
  const sorted = Array.from(mags).sort((a, b) => a - b);
  const medianMag = sorted[Math.floor(sorted.length * 0.5)];
  wfNoiseFloor = wfNoiseFloor * 0.95 + medianMag * 0.05;  // slow tracking
  wfPeakLevel = Math.max(wfPeakLevel * 0.98, maxMag);       // fast attack, slow decay
  const range = Math.max(wfPeakLevel - wfNoiseFloor, wfNoiseFloor * 0.5 || 1);

  // Scroll existing waterfall down by 1 pixel
  wfCtx.drawImage(wfCanvas, 0, 0, w, h, 0, 1, w, h - 1);

  // Draw new line at top
  const lineData = wfCtx.createImageData(w, 1);
  const d = lineData.data;
  for (let x = 0; x < w; x++) {
    // Interpolate between bins for smoother display
    const binF = x * WF_BIN_COUNT / w;
    const bin0 = Math.floor(binF);
    const bin1 = Math.min(bin0 + 1, WF_BIN_COUNT - 1);
    const frac = binF - bin0;
    const mag = mags[bin0] * (1 - frac) + mags[bin1] * frac;
    // Normalize against adaptive range
    const normalized = Math.max(0, (mag - wfNoiseFloor) / range);
    // Apply log scale with more contrast
    const val = Math.pow(normalized, 0.4); // gamma curve for better contrast
    const [r, g, b] = wfColor(val);
    const idx = x * 4;
    d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = 255;
  }
  wfCtx.putImageData(lineData, 0, 0);
}

// ===== DECODE LOG ==========================================================

const decodeLog = document.getElementById('decode-log');
const logWrap = document.getElementById('log-wrap');
const logToggle = document.getElementById('log-toggle');
let logVisible = true;

logToggle.addEventListener('click', () => {
  logVisible = !logVisible;
  // Only collapse the textarea — the header (with this toggle) stays visible
  // so users can click it again to re-open. Previously the whole log-wrap
  // was hidden, which also hid the toggle itself.
  logWrap.classList.toggle('collapsed', !logVisible);
  logToggle.querySelector('span').textContent = logVisible ? '(click to hide)' : '(click to show)';
});

document.getElementById('log-copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(decodeLog.value).then(() => {
    statusBar.textContent = 'Decode log copied to clipboard';
  });
});

const logLines = [];
const LOG_MAX = 300;

function addLogEntry(text) {
  logLines.push(text);
  if (logLines.length > LOG_MAX) logLines.shift();
  decodeLog.value = logLines.join('\n');
  decodeLog.scrollTop = decodeLog.scrollHeight;
}

function logTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

window.api.onSstvRxDebug((data) => {
  const sliceTag = data.sliceId ? '[' + data.sliceId + '] ' : '';
  const freqTag = data.avgFreq ? ' ' + data.avgFreq + ' Hz' : '';
  const detail = data.detail ? ' ' + data.detail : '';
  addLogEntry(logTime() + ' ' + sliceTag + data.state + freqTag + detail);
});

// ===== KEYBOARD ============================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'F12') {
    // DevTools handled by main process
  }
  // Ctrl+/- zoom
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    window.api.setZoom(Math.min(3, window.api.getZoom() + 0.1));
  }
  if (e.ctrlKey && e.key === '-') {
    e.preventDefault();
    window.api.setZoom(Math.max(0.5, window.api.getZoom() - 0.1));
  }
  if (e.ctrlKey && e.key === '0') {
    e.preventDefault();
    window.api.setZoom(1);
  }
});
