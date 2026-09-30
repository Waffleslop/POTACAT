// Theme applier — handles both legacy string payloads ('light'/'dark')
// and the v1.9+ {theme, variant} object form so older + newer senders
// both work. Sets data-theme and (in charcoal dark variant only) the
// data-dark-variant attribute on <html>.
function _applyPopoutTheme(payload) {
  const theme = typeof payload === 'string'
    ? payload
    : ((payload && payload.theme) || 'dark');
  const variant = (payload && typeof payload === 'object' && payload.variant) || 'navy';
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark' && variant !== 'navy') {
    document.documentElement.setAttribute('data-dark-variant', variant);
  } else {
    document.documentElement.removeAttribute('data-dark-variant');
  }
}
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
// wf-canvas is driven by the WebGL Waterfall component (see drawWaterfallLine)
// — no 2D context here: WebGL2 can't be obtained on a canvas that has one.
const rxInfo = document.getElementById('rx-info');
const modeSelect = document.getElementById('mode-select');
const loadBtn = document.getElementById('load-btn');
const txBtn = document.getElementById('tx-btn');
const progressBar = document.getElementById('progress-bar');
const txGainSlider = document.getElementById('tx-gain');
const gallery = document.getElementById('gallery');
const galleryCount = document.getElementById('gallery-count');
const openFolderBtn = document.getElementById('open-folder-btn');
const audioInputSelect = document.getElementById('audio-input');
const audioOutputSelect = document.getElementById('audio-output');
const statusBar = document.getElementById('status-bar');
const textLayersEl = document.getElementById('text-layers'); // gone in the redesign; text is edited on the picture
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
let rxSlantPx = 0;        // user-applied horizontal shear in px (top→bottom)

// Re-render the last decoded image onto rx-canvas with a horizontal shear.
// Each row y gets shifted by Math.round(slantPx * y / (h-1)) pixels, so:
//   slantPx = 0   →  no change
//   slantPx > 0   →  bottom rows shifted right (corrects top-right→bottom-left slant)
//   slantPx < 0   →  bottom rows shifted left (corrects top-left→bottom-right slant)
// Pixels that fall outside the source row are filled black.
function renderSlantedImage(rxImage, slantPx) {
  if (!rxImage || !rxImage.imageData) return;
  const w = rxImage.width, h = rxImage.height;
  rxCanvas.width = w; rxCanvas.height = h;
  if (!slantPx) {
    rxCtx.putImageData(new ImageData(new Uint8ClampedArray(rxImage.imageData), w, h), 0, 0);
    return;
  }
  const src = rxImage.imageData;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dx = Math.round(slantPx * y / (h - 1));
    for (let x = 0; x < w; x++) {
      const srcX = x - dx;
      const di = (y * w + x) * 4;
      if (srcX < 0 || srcX >= w) {
        out[di] = 0; out[di + 1] = 0; out[di + 2] = 0; out[di + 3] = 255;
      } else {
        const si = (y * w + srcX) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
      }
    }
  }
  rxCtx.putImageData(new ImageData(out, w, h), 0, 0);
}

// Wire the slant slider once the DOM is ready.
(function wireSlantSlider() {
  const slider = document.getElementById('rx-slant-slider');
  const valueEl = document.getElementById('rx-slant-value');
  const resetBtn = document.getElementById('rx-slant-reset');
  if (!slider || !valueEl) return;
  slider.addEventListener('input', () => {
    rxSlantPx = parseInt(slider.value, 10) || 0;
    valueEl.textContent = (rxSlantPx > 0 ? '+' : '') + rxSlantPx + ' px';
    if (lastRxImage) renderSlantedImage(lastRxImage, rxSlantPx);
  });
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      slider.value = 0;
      rxSlantPx = 0;
      valueEl.textContent = '0 px';
      if (lastRxImage) renderSlantedImage(lastRxImage, 0);
    });
  }
  // Redecode: replay the last transmission from the worker's raw-audio
  // buffer, converting the display-shear slider into a real timing
  // correction (a shear of N px across the full image ≈ N/(width·height)
  // of a line per line = that many ppm·1e6 of sample-clock error).
  const redecodeBtn = document.getElementById('rx-redecode');
  if (redecodeBtn) {
    redecodeBtn.addEventListener('click', () => {
      let ppm = 0;
      if (rxSlantPx && lastRxImage && lastRxImage.width && lastRxImage.height) {
        ppm = Math.round((rxSlantPx / (lastRxImage.width * lastRxImage.height)) * 1e6);
      }
      statusBar.textContent = 'Redecoding from buffer' + (ppm ? ' (slant ' + ppm + ' ppm)…' : '…');
      window.api.sstvRedecode({ slantPpm: ppm });
    });
  }
})();
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
  scottie2: { w: 320, h: 256 },
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

  // What the templates fill in, the station's look, and any style pack.
  try { await refreshContext(); } catch (e) { console.error('[SSTV] Context error:', e); }
  try { await loadActivePack(); } catch (e) { console.error('[SSTV] Pack load error:', e); }
  rebuildLook();
  try { const on = document.getElementById('op-name'); if (on) on.value = settings.sstvOperatorName || ''; } catch {}
  try { await refreshPacks(); } catch (e) { console.error('[SSTV] Packs list error:', e); }

  // Load saved templates
  try {
    templates = settings.sstvTemplates || [];
    renderTemplateStrip();
  } catch (e) { console.error('[SSTV] Template restore error:', e); }

  // Fill auto-labels (call/grid use current settings, not saved values)
  try { syncAutoLabels(); renderTextLayers(); } catch (e) { console.error('[SSTV] Text layers error:', e); }

  // Update canvas size for mode
  try { updateCanvasSize(); } catch {}

  // The last starter template (CQ SSTV on a first run); a station that built
  // its own compose before the redesign keeps it, on a fresh pattern.
  try {
    const last = settings.sstvLastStarter || (settings.sstvTextElements && settings.sstvTextElements.length ? null : 'cq');
    if (last && window.SstvTemplates.starter(last)) applyStarter(last, { keepTexts: !!(settings.sstvTextElements && settings.sstvTextElements.length && settings.sstvTextElements.some(t => t.tpl)) });
    else generateRandomPattern();
  } catch (e) { console.error('[SSTV] Starter error:', e); try { generateRandomPattern(); } catch {} }
  renderTemplateStrip();

  // Populate audio devices
  try { await populateAudioDevices(); } catch (e) { console.error('[SSTV] Audio device error:', e); }

  // Start RX audio capture
  try { await startRxAudio(); } catch (e) { console.error('[SSTV] RX audio error:', e); }

  // Load gallery
  try { await loadGallery(); } catch (e) { console.error('[SSTV] Gallery load error:', e); }

  // Set theme
  try { applyTheme(settings.lightMode ? 'light' : 'dark'); } catch {}

  // Fonts load asynchronously; redraw once they are here so the first
  // picture isn't in the fallback face.
  try {
    await Promise.race([
      Promise.all(['400 30px "Bungee"', '400 30px "Archivo Black"', '400 30px "Russo One"', '800 30px "Rubik"', '400 30px "Rye"'].map(f => document.fonts.load(f).catch(() => null))),
      new Promise(r => setTimeout(r, 2500)),
    ]);
    if (activeStarterId) rerenderStarterScene();
    renderTxPreview(); renderTemplateStrip();
  } catch {}
  try { window.api.sstvRigStateGet && window.api.sstvRigStateGet(); } catch {}
  showRigScopedControls();
  fitCanvases();

  // Auto-QSY to the selected SSTV frequency on open, or to the one main
  // asked for (idle SSTV picks the day/night band).
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('freqKhz')) selectAndTune(q.get('freqKhz'), q.get('mode'));
    else {
      const initOpt = freqSelect.options[freqSelect.selectedIndex];
      tuneToFreq(freqSelect.value, initOpt && initOpt.dataset.mode);
    }
  } catch (e) { console.error('[SSTV] Auto-QSY error:', e); }

})();

// --- Refocus from main (user re-opened SSTV from the view menu) ---
// Re-tune to the currently selected SSTV frequency so the radio QSYs back
// from whatever spot the user last clicked.
window.api.onRefocusQsy((target) => {
  try {
    if (target && target.freqKhz) selectAndTune(target.freqKhz, target.mode);
    else {
      const opt = freqSelect.options[freqSelect.selectedIndex];
      tuneToFreq(freqSelect.value, opt && opt.dataset.mode);
    }
  } catch (e) { console.error('[SSTV] Refocus QSY error:', e); }
  refreshRxDevice();
});

// The radio's audio device can change while this window is open (a rig
// switch, or a new input picked in My Rigs). Re-read it on focus and reopen
// the capture when the device SSTV should use is no longer the one it has.
async function refreshRxDevice() {
  try {
    const fresh = await window.api.getSettings();
    if ((fresh.remoteAudioInput || '') === (settings.remoteAudioInput || '')
        && (fresh.sstvAudioInput || '') === (settings.sstvAudioInput || '')
        && (fresh.audioSource || '') === (settings.audioSource || '')) return;
    settings = fresh;
    await populateAudioDevices();
    await startRxAudio();
  } catch (e) { console.error('[SSTV] Audio device refresh error:', e); }
}
window.addEventListener('focus', () => { refreshRxDevice(); });

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
  _applyPopoutTheme(theme);
}
window.api.onPopoutTheme(applyTheme);

// --- Window controls ---
document.getElementById('min-btn').addEventListener('click', () => window.api.minimize());
document.getElementById('max-btn').addEventListener('click', () => window.api.maximize());
document.getElementById('close-btn').addEventListener('click', () => window.api.close());

// --- Mode change ---
modeSelect.addEventListener('change', () => {
  const oldH = txCanvas.height, oldW = txCanvas.width;
  updateCanvasSize();
  // A starter is drawn for the mode's size: redraw its scene and move its
  // text for the new height (Robot modes are 240 lines, the rest 256) and
  // width (PD 240/290 are 640 wide: x and lettering double).
  if (activeStarterId) {
    const k = txCanvas.height / (oldH || 256);
    const kx = txCanvas.width / (oldW || 320);
    if (k !== 1 || kx !== 1) textElements.forEach(t => { t.y = Math.round(t.y * k); t.x = Math.round(t.x * kx); t.fontSize = Math.max(6, Math.round((t.fontSize || 14) * kx)); });
    activeSlot = window.SstvTemplates.replySlot(activeStarterId, txCanvas.height, txCanvas.width);
    rerenderStarterScene();
  }
  renderTxPreview();
  fitCanvases();
  updateTxState();
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

// The sideband SSTV uses on a frequency: LSB below 10 MHz except 60 m,
// which is USB by regulation. The ECHOCAT app uses the same rule.
function getFreqMode(freqKhz) {
  const k = parseInt(freqKhz);
  if (k >= 5250 && k <= 5450) return 'USB';
  return k < 10000 ? 'LSB' : 'USB';
}

// Show a frequency main chose in the dropdown (or the custom box) and tune it.
function selectAndTune(freqKhz, mode) {
  const v = String(Math.round(Number(freqKhz)));
  const opt = Array.from(freqSelect.options).find(o => o.value === v);
  if (opt) { freqSelect.value = v; freqInput.value = ''; }
  else freqInput.value = v;
  tuneToFreq(v, mode || (opt && opt.dataset.mode));
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
  if (!textLayersEl) return;
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
  textInput.placeholder = isAutoLabel(t) ? getTextDisplayName(t) + ' (auto)' : 'Text… ({MYCALL} {CALL} {RSV} {GRID} {PARK} {UTC})';
  textInput.title = 'Use {MYCALL}, {CALL}, {RSV}, {GRID}, {PARK}, {NAME}, {RIG} or {UTC} and POTACAT fills them in';
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

  // Hide, delete (text you added, or a template line), done.
  const hideBtn = document.createElement('button');
  hideBtn.className = 'tp-toggle' + (t.visible ? '' : ' active');
  hideBtn.textContent = t.visible ? '\u25C9' : '\u25CB';
  hideBtn.title = t.visible ? 'Hide this text' : 'Show this text';
  hideBtn.addEventListener('click', () => { t.visible = !t.visible; onTextChanged(); renderTextProps(); });
  textPropsEl.appendChild(hideBtn);
  if (t.key.startsWith('user-') || t.tpl) {
    const del = document.createElement('button');
    del.className = 'tp-toggle';
    del.textContent = '\u2715';
    del.title = 'Remove this text';
    del.addEventListener('click', () => {
      const i = textElements.indexOf(t);
      if (i >= 0) textElements.splice(i, 1);
      selectedText = null; textPropsEl.style.display = 'none';
      onTextChanged();
    });
    textPropsEl.appendChild(del);
  }
  const done = document.createElement('button');
  done.className = 'tp-toggle';
  done.style.width = 'auto'; done.style.padding = '0 6px';
  done.textContent = 'Done';
  done.addEventListener('click', () => { selectedText = null; textPropsEl.style.display = 'none'; renderTxPreview(); });
  textPropsEl.appendChild(done);
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
  const texts = textElements.map(t => {
    const b = textBox(t);
    return {
      key: t.key, label: b.label || '',
      x: Math.round(b.x0), y: t.y, fontSize: b.size,
      bold: !!t.bold || !!t.tpl, italic: !!t.italic,
      color: b.color, rotation: t.rotation || 0,
      visible: t.visible !== false,
    };
  });
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
    align: t.align, outline: !!t.outline, role: t.role, tpl: !!t.tpl,
    fit: !!t.fit, fontCss: t.fontCss, fontWeight: t.fontWeight,
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
      activeStarterId = null; // the photo replaces the starter's scene; its text stays
      renderTemplateStrip();
      renderTxPreview();
    };
    img.src = result.dataUrl;
  }
});

// Random pattern generator — kept for templates saved before the redesign
// (they store bgParams). The Random button is gone; the Test pattern starter
// replaces it.

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

  // Reply inset (PiP) — in the template's picture slot when it has one,
  // otherwise bottom-right; draggable, wheel-resizable, rotatable.
  if (replyImage) {
    const margin = 6;
    let insetW, insetH;
    if (replyInset.w) { insetW = replyInset.w; insetH = replyInset.h; }
    else if (activeSlot) { insetW = activeSlot.w; insetH = activeSlot.h; }
    else { insetW = Math.round(w * replyInset.scale); insetH = Math.round(h * replyInset.scale); }
    const ix = replyInset.x >= 0 ? replyInset.x : (activeSlot ? activeSlot.x : w - insetW - margin);
    const iy = replyInset.y >= 0 ? replyInset.y : (activeSlot ? activeSlot.y : h - insetH - margin);
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
    drawReplyThumb();
  }

  // Draw the text layers
  for (const t of textElements) {
    if (!t.visible || !t.label) continue;
    drawTextLayer(txCtx, t);
  }

  // Draw rotation handle on selected text
  if (selectedText && selectedText.visible && selectedText.label && !isTx) {
    const t = selectedText;
    txCtx.save();
    const box = textBox(t);
    const rot = t.rotation || 0;
    const metrics = { width: box.width };
    // Handle position: right edge of text, vertically centered
    const hx = (box.x0 - t.x) + box.width + 8;
    const hy = -box.size / 2;
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
  const box = textBox(t);
  const hx = (box.x0 - t.x) + box.width + 8;
  const hy = -box.size / 2;
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
    const box = textBox(t);
    const textW = box.width;
    const textH = box.size;
    const off = box.x0 - t.x; // centred text starts left of its anchor
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
    // Local bounding box: off..off+textW horizontally, -textH..+2 vertically
    if (lx >= off && lx <= off + textW && ly >= -textH && ly <= 2) {
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
    // Keep the size it has now while it moves out of its slot.
    if (!replyInset.w) { replyInset.w = replyInset._drawW; replyInset.h = replyInset._drawH; }
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
    renderTxPreview();
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
    const f = e.deltaY < 0 ? 1.08 : 0.93;
    const cw = replyInset._drawW || 90, ch = replyInset._drawH || 72;
    const nw = Math.max(30, Math.min(txCanvas.width, Math.round(cw * f)));
    replyInset.w = nw; replyInset.h = Math.round(nw * ch / cw);
    if (replyInset.x < 0) { replyInset.x = replyInset._drawX; replyInset.y = replyInset._drawY; }
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
  if (templates.length >= 24) {
    statusBar.textContent = 'You have 24 templates of your own. Delete one first.';
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
  if (bgImage && !bgParams) bgDataUrl = templatePhotoDataUrl(bgImage);

  const tpl = {
    bgParams: bgParams ? JSON.parse(JSON.stringify(bgParams)) : null,
    bgDataUrl,
    // Frozen: the words, lettering and colours as they look now, so a later
    // Shuffle or pack never changes a template you saved. Placeholders stay.
    texts: textElements.map(t => {
      const base = { key: t.key, x: t.x, y: t.y, fontSize: t.fontSize, bold: t.bold, italic: t.italic, color: t.color, rotation: t.rotation || 0, visible: t.visible, label: t.label, align: t.align, outline: !!t.outline, role: t.role, fit: !!(t.tpl || t.fit), fontCss: t.fontCss, fontWeight: t.fontWeight };
      if (t.tpl) {
        const st = T.textStyle(t, currentLook);
        Object.assign(base, { label: st.label, color: st.color, fontCss: st.fontCss, fontWeight: st.weight, outline: true });
      }
      return base;
    }),
    category: activeStarterId ? ((T.starter(activeStarterId) || {}).category || 'mine') : 'mine',
    thumbnail,
    // Where a reply's picture goes, so a saved reply template keeps its slot.
    slot: activeSlot ? Object.assign({}, activeSlot) : null,
    name: activeStarterId ? (window.SstvTemplates.starter(activeStarterId) || {}).name + ' (mine)' : 'My template',
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
    align: saved.align, outline: !!saved.outline, role: saved.role, tpl: !!saved.tpl,
    fit: !!saved.fit, fontCss: saved.fontCss, fontWeight: saved.fontWeight,
  }));
  activeStarterId = null;
  activeSlot = tpl.slot || null;
  replyInset.x = -1; replyInset.y = -1; replyInset.w = 0; replyInset.h = 0;

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
  // Starters first (drawn in the station's look), then the operator's own,
  // then the + button that saves the current picture.
  while (tplStrip.firstChild !== tplSaveBtn) {
    tplStrip.removeChild(tplStrip.firstChild);
  }
  tplCount.textContent = String(window.SstvTemplates.STARTERS.length + templates.length);
  renderTplCats();
  const defReply = defaultReplyId();
  const cat = tplCategory;
  for (const st of window.SstvTemplates.STARTERS) {
    if (cat === 'mine' || (cat !== 'all' && st.category !== cat)) continue;
    const div = document.createElement('div');
    div.className = 'sstv-tpl' + (st.id === activeStarterId ? ' active' : '');
    div.title = st.name + ' — ' + st.why + (st.reply ? ' Right-click to make it your default reply.' : '');
    div.appendChild(starterThumb(st.id));
    if (st.reply) {
      const b = document.createElement('span');
      b.className = 'tpl-badge';
      b.textContent = st.id === defReply ? '\u21A9 default' : '\u21A9';
      div.appendChild(b);
    }
    const nm = document.createElement('div');
    nm.className = 'tpl-name';
    nm.textContent = st.name;
    div.appendChild(nm);
    div.addEventListener('click', () => applyStarter(st.id));
    if (st.reply) {
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, st.name, [
          { label: 'Use for replies', action: () => { setDefaultReply(st.id); } },
          { label: 'Compose with it', action: () => applyStarter(st.id) },
        ]);
      });
    }
    tplStrip.insertBefore(div, tplSaveBtn);
  }
  const mineShown = templates.some(t => cat === 'all' || cat === 'mine' || (t.category || 'mine') === cat);
  if (mineShown && cat !== 'mine') {
    const sep = document.createElement('div');
    sep.className = 'tray-sep';
    tplStrip.insertBefore(sep, tplSaveBtn);
  }
  for (let i = 0; i < templates.length; i++) {
    if (!(cat === 'all' || cat === 'mine' || (templates[i].category || 'mine') === cat)) continue;
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

// Abort the current TX: stop audio, release PTT, reset UI. Used both when
// the operator taps HALT on the desktop and when ECHOCAT halts remotely.
function abortTxLocal(reason) {
  if (txAudioCtx) { try { txAudioCtx.close(); } catch {} txAudioCtx = null; }
  txPlaying = false;
  isTx = false;
  try { window.api.sstvTxComplete(); } catch {}
  txBtn.textContent = replyImage ? 'REPLY' : 'TRANSMIT';
  txBtn.classList.remove('transmitting');
  progressBar.classList.remove('tx');
  progressBar.style.width = '0%';
  statusBar.textContent = reason || 'TX cancelled';
}

// Remote abort from ECHOCAT: tear down audio here without re-calling PTT
// release (main already did that).
window.api.onSstvAbortTx(() => {
  if (txAudioCtx) { try { txAudioCtx.close(); } catch {} txAudioCtx = null; }
  txPlaying = false;
  isTx = false;
  txBtn.textContent = replyImage ? 'REPLY' : 'TRANSMIT';
  txBtn.classList.remove('transmitting');
  progressBar.classList.remove('tx');
  progressBar.style.width = '0%';
  statusBar.textContent = 'TX halted by ECHOCAT';
});

txBtn.addEventListener('click', () => {
  if (isTx) {
    abortTxLocal('TX halted');
    return;
  }
  const mode = modeSelect.value;
  const res = MODE_RES[mode] || { w: 320, h: 256 };
  // A selected text draws an editing handle on the picture; never send it.
  // Redraw first so {UTC} is the time of this transmission.
  if (selectedText) { selectedText = null; textPropsEl.style.display = 'none'; }
  renderTxPreview();
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
  txBtn.textContent = 'HALT TX';
  txBtn.classList.add('transmitting');
  progressBar.style.width = '0%';
  progressBar.classList.add('tx');
  statusBar.textContent = 'Encoding...';
});

// TX audio received — play it
window.api.onSstvTxAudio(async (data) => {
  // Mark TX active — stops decoder from hearing our own audio
  isTx = true;
  txBtn.textContent = 'HALT TX';
  txBtn.classList.add('transmitting');
  progressBar.style.width = '0%';
  progressBar.classList.add('tx');

  // Flex Direct: main is streaming the audio to the radio over dax_tx; we
  // must NOT play it through Web Audio (no DAX TX device exists, and it
  // would just blast the PC speakers). Show the progress bar for the
  // duration, then reset UI. PTT is owned by main on this path, so don't
  // call sstvTxComplete here. K3SBP 2026-05-28.
  if (data && data.daxTx) {
    const durationSec = data.durationSec || 0;
    statusBar.textContent = 'Transmitting ' + modeSelect.value + ' via Flex Direct... ' + durationSec.toFixed(0) + 's';
    const startTime = Date.now();
    const iv = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - startTime) / 1000 / durationSec) * 100);
      progressBar.style.width = pct + '%';
      if (pct >= 100) clearInterval(iv);
    }, 200);
    setTimeout(() => {
      clearInterval(iv);
      progressBar.style.width = '100%';
      isTx = false;
      txBtn.textContent = replyImage ? 'REPLY' : 'TRANSMIT';
      txBtn.classList.remove('transmitting');
      progressBar.classList.remove('tx');
      setTimeout(() => { progressBar.style.width = '0%'; }, 1000);
      statusBar.textContent = 'TX complete';
      noteReplySent();
    }, (durationSec + 1) * 1000);
    return;
  }

  const samplesArray = data.samples || data;
  const gainLevel = (txGainSlider.value / 100) || 0.5;

  try {
    // The radio's output (My Rigs > Audio) unless this window chose one; a
    // configured device that cannot be opened REFUSES the transmission (the
    // catch below unkeys) instead of playing the picture out of the PC
    // speakers with the radio keyed (lib/sstv-audio-device.js).
    const txSettings = await window.api.getSettings();
    const outputs = (_sstvAudioDevices.outputs || []);
    const out = window.SstvAudioDevice.resolveSstvAudio({
      sstvId: txSettings.sstvAudioOutput || '', rigId: txSettings.remoteAudioOutput || '',
      devices: outputs, kind: 'output',
    });
    if (!out.ok) throw new Error(out.message);
    const outputDeviceId = out.deviceId;
    if (!txAudioCtx || txAudioCtx.state === 'closed') {
      txAudioCtx = new AudioContext({ sampleRate: 48000 });
    }
    if (txAudioCtx.state === 'suspended') await txAudioCtx.resume();

    if (outputDeviceId && txAudioCtx.setSinkId) {
      try { await txAudioCtx.setSinkId(outputDeviceId); } catch (e) {
        throw new Error(`could not open the TX audio output (${out.label || 'configured device'}): ${e.message}`);
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
      // A reply stays after it is sent, so the 73 is one pick away.
      noteReplySent();
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
    statusBar.textContent = data.guestCall
      ? 'Transmitting a picture from guest ' + data.guestCall + ' (' + data.mode + ')'
      : 'ECHOCAT TX: ' + data.mode + ' (' + w + 'x' + h + ')';
    rxInfo.textContent = data.guestCall ? 'TX from guest ' + data.guestCall : 'TX from the ECHOCAT app — ' + data.mode;
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
  } else if (data.state === 'stopped' && !multiActive) {
    // Say so: "Listening..." over a stopped decoder was the report.
    rxInfo.textContent = 'Decoder stopped';
    statusBar.textContent = 'The SSTV decoder is stopped. Close and reopen this window to restart it.';
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
          theirCall: img.theirCall || '',
          fskCall: img.fskCall || '',
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
  galleryCount.textContent = String(galleryImages.length);
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
    const qrg = entryQrgHz(entry) ? ' · ' + fmtQrg(entryQrgHz(entry)) : '';
    info.textContent = dateStr + ' ' + (entry.mode || '') + qrg;
    thumb.appendChild(info);

    if (entry.theirCall) info.textContent = entry.theirCall + ' · ' + (entry.mode || '') + qrg;
    thumb.title = 'Click to view · double-click to reply · right-click for more';
    // Click views it full size, unless a second click makes it a double-click
    // (which replies): the old immediate viewer covered the thumbnail and
    // swallowed the double-click.
    let clickTimer = null;
    thumb.addEventListener('click', () => {
      if (clickTimer) return;
      clickTimer = setTimeout(() => { clickTimer = null; viewImageFullscreen(entry.dataUrl); }, 260);
    });
    thumb.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      startReply(entry);
    });
    thumb.addEventListener('contextmenu', ((idx) => (e) => {
      e.preventDefault();
      openImageMenu(e.clientX, e.clientY, entry, idx);
    })(i));

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
  replyInset.w = 0; replyInset.h = 0;
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
      replyInset._canvasDirty = true;
      updateTxButton();
      renderTxPreview();
    };
    img.src = entry.dataUrl;
    return;
  }
  updateTxButton();
  renderTxPreview();
}

// On-canvas Reply button — the latest decode
const rxReplyBtnEl = document.getElementById('rx-reply-btn');
if (rxReplyBtnEl) {
  rxReplyBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lastRxImage) startReply(lastRxImage);
  });
}

openFolderBtn.addEventListener('click', () => window.api.sstvOpenGalleryFolder());

// ===== AUDIO CAPTURE (RX) ==================================================

// The last enumeration, for resolving which device SSTV uses.
let _sstvAudioDevices = { inputs: [], outputs: [] };

function _rigDeviceOptionLabel(list, rigId) {
  if (!rigId) return 'From My Rigs (not set)';
  const d = list.find(x => x.deviceId === rigId);
  return 'From My Rigs (' + (d ? (d.label || rigId.slice(0, 20)) : 'not connected') + ')';
}

async function populateAudioDevices() {
  try {
    const devices = await window.api.enumerateAudioDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    _sstvAudioDevices = { inputs, outputs };

    // "" follows the radio's device (My Rigs > Audio), like FT8 and ECHOCAT.
    audioInputSelect.innerHTML = '';
    { const o = document.createElement('option'); o.value = ''; o.textContent = _rigDeviceOptionLabel(inputs, settings.remoteAudioInput); audioInputSelect.appendChild(o); }
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || d.deviceId.slice(0, 20);
      audioInputSelect.appendChild(opt);
    }
    if (settings.sstvAudioInput) {
      // A saved device that is no longer present stays selected (as a
      // placeholder) so startRxAudio can say so, instead of the select
      // silently falling back to the first option.
      if (!inputs.some(d => d.deviceId === settings.sstvAudioInput)) {
        const o = document.createElement('option'); o.value = settings.sstvAudioInput; o.textContent = 'Saved device (not connected)'; audioInputSelect.appendChild(o);
      }
      audioInputSelect.value = settings.sstvAudioInput;
    }

    audioOutputSelect.innerHTML = '';
    { const o = document.createElement('option'); o.value = ''; o.textContent = _rigDeviceOptionLabel(outputs, settings.remoteAudioOutput); audioOutputSelect.appendChild(o); }
    for (const d of outputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || d.deviceId.slice(0, 20);
      audioOutputSelect.appendChild(opt);
    }
    if (settings.sstvAudioOutput) {
      if (!outputs.some(d => d.deviceId === settings.sstvAudioOutput)) {
        const o = document.createElement('option'); o.value = settings.sstvAudioOutput; o.textContent = 'Saved device (not connected)'; audioOutputSelect.appendChild(o);
      }
      audioOutputSelect.value = settings.sstvAudioOutput;
    }
  } catch (e) {
    console.warn('[SSTV] Audio device enumeration failed:', e);
  }
}

audioInputSelect.addEventListener('change', async () => {
  settings.sstvAudioInput = audioInputSelect.value;
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

  // Direct radio streams (Flex SmartSDR, Icom network) feed the decoder from
  // main; this capture is only their fallback, so the device notices below
  // would be noise for those stations.
  const directStream = settings && ['smartsdr', 'icom-network'].includes(settings.audioSource);
  const pick = window.SstvAudioDevice.resolveSstvAudio({
    sstvId: audioInputSelect.value || '', rigId: settings.remoteAudioInput || '',
    devices: _sstvAudioDevices.inputs, kind: 'input',
  });
  if (!pick.ok) {
    rxInfo.textContent = 'Radio audio not found';
    statusBar.textContent = pick.message;
    console.warn('[SSTV] RX audio refused: ' + pick.message);
    return;
  }
  try {
    const deviceId = pick.deviceId || undefined;
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
      // SmartSDR Direct: the VITA-49 path in main feeds both the decoder
      // and the waterfall (see onSstvVita49Audio handler below), so skip the
      // local Windows-DAX capture — BUT only while VITA audio is actually
      // FLOWING. The old unconditional skip (K3SBP 2026-05-15) meant any
      // smartsdr-flagged state without a live stream (DAX conflict, yielded
      // slot, radio disconnect, the v1.8.15-17 mute outage) starved the
      // decoder completely with no fallback and no error. Recency-gated
      // fallback (2026-07-07): if no VITA frame in 3 s, the local capture
      // resumes feeding decoder + waterfall; the paths stay mutually
      // exclusive by construction. Main mirrors this gate (sstv-feed-gate).
      if (settings && settings.audioSource === 'smartsdr'
          && (Date.now() - _lastVitaAudioTs) < 3000) return;
      _markDecoderAudio(e.data, 'mic');
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
    // Say WHICH device: "RX audio started" alone never showed that SSTV was
    // on the laptop microphone.
    const track = sstvStream.getAudioTracks()[0];
    const heard = (track && track.label) || pick.label || 'default device';
    setStatusDevice(heard, !audioInputSelect.value);
    statusBar.textContent = (pick.notice && !directStream) ? pick.notice : 'Listening (' + actualRate + ' Hz)';
  } catch (err) {
    console.error('[SSTV] RX audio start error:', err);
    rxInfo.textContent = 'No audio input';
    statusBar.textContent = 'Audio error: ' + err.message;
  }
}

// SmartSDR Direct: main forwards VITA-49 dax_rx audio (already 2x-upsampled
// to 48 kHz to match WF_SAMPLE_RATE) so the waterfall renders even though
// the local Windows DAX RX getUserMedia capture is silent on this path.
// The decoder itself is fed by main from the same VITA-49 stream — see the
// `sstv-audio` IPC drop in main when audioSource === 'smartsdr'. K3SBP
// 2026-05-15.
if (window.api && window.api.onSstvVita49Audio) {
  window.api.onSstvVita49Audio((frame) => {
    if (!frame || !frame.pcm || !frame.pcm.length) return;
    if (isTx) return; // don't paint the waterfall during own TX
    const samples = (frame.pcm instanceof Float32Array) ? frame.pcm : new Float32Array(frame.pcm);
    _markDecoderAudio(samples, 'vita');
    feedWaterfall(samples);
  });
}

// ===== RX AUDIO HEALTH =====================================================
// Tracks whether NON-SILENT audio is actually reaching the decoder from any
// ingress (mic/DAX-device capture or main's VITA-49 forward). The 2026-06
// outage taught us dead feeds are invisible: the decoder just never locks
// and the user assumes "SSTV is broken". Surface it in seconds instead.
let _lastDecoderAudioTs = Date.now() + 8000; // grace period after open
let _lastVitaAudioTs = 0; // for the smartsdr mic-fallback gate below
// RX level (WB8IMY 2026-09-18): a feed at -40 dBFS is "alive" to the dead
// check and paints a bright auto-ranged waterfall, yet used to leave the
// decoder in IDLE. The decoder now normalises its input, but below
// RX_LOW_DBFS the boost runs out, so say so — the number is the same one
// the decode log prints as 'in='.
const RX_LOW_DBFS = -50;
let _rxLevelPeak = 0;   // peak |sample| since the last level tick
let _rxLevelHold = 0;   // slow-decaying hold for the badge (no flicker between lines)
function _markDecoderAudio(samples, source) {
  if (source === 'vita') _lastVitaAudioTs = Date.now();
  // Silence check: a live-but-muted feed is just as dead as no feed.
  let peak = 0;
  const step = Math.max(1, samples.length >> 6); // sample ~64 points
  for (let i = 0; i < samples.length; i += step) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1e-4) _lastDecoderAudioTs = Date.now();
  if (peak > _rxLevelPeak) _rxLevelPeak = peak;
}
setInterval(() => {
  const badge = document.getElementById('rx-no-audio');
  if (!badge) return;
  const dead = !isTx && (Date.now() - _lastDecoderAudioTs) > 5000;
  badge.style.display = dead ? '' : 'none';
  // Level readout + low badge
  const peak = _rxLevelPeak;
  _rxLevelPeak = 0;
  _rxLevelHold = Math.max(peak, _rxLevelHold * 0.6); // ~4 dB/s release
  const holdDb = _rxLevelHold > 0 ? 20 * Math.log10(_rxLevelHold) : -120;
  const levelEl = document.getElementById('rx-level');
  if (levelEl) {
    const db = peak > 0 ? 20 * Math.log10(peak) : -120;
    levelEl.textContent = isTx ? '--' : (db <= -100 ? 'no audio' : Math.round(db) + ' dBFS');
    levelEl.style.color = (!isTx && db > -100 && db < RX_LOW_DBFS) ? '#f0a500' : '#8892b0';
  }
  const low = document.getElementById('rx-low-audio');
  if (low) {
    const isLow = !isTx && !dead && holdDb < RX_LOW_DBFS;
    low.style.display = isLow ? '' : 'none';
    if (isLow) low.textContent = 'RX AUDIO LOW (' + Math.round(holdDb) + ' dBFS)';
  }
}, 1000);

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
  <optgroup label="40m"><option value="7165" data-mode="USB">7.165</option><option value="7171" data-mode="USB">7.171</option></optgroup>
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
  closeGear();
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

// RX canvas size for a lock: the decoder's own mode dimensions (sent with
// every rx-vis since 2026-09-26), else the TX table. MODE_RES lists only the
// five TX-compose modes, so a PD-160 / Robot 24 / Martin 2 lock used to keep
// the PREVIOUS image's canvas and every row was drawn at the wrong width.
function rxResFor(data) {
  if (data && data.width > 0 && data.height > 0) return { w: data.width, h: data.height };
  return MODE_RES[data && data.mode] || null;
}

// Override RX event handlers to support multi-slice routing
window.api.onSstvRxVis((data) => {
  if (data.sliceId && multiActive) {
    const pane = multiRxPanes.get(data.sliceId);
    if (pane) {
      pane.statusEl.textContent = 'Decoding ' + (data.modeName || data.mode) + '...';
      pane.ctx.fillStyle = '#000';
      pane.ctx.fillRect(0, 0, pane.canvas.width, pane.canvas.height);
      const res = rxResFor(data);
      if (res) { pane.canvas.width = res.w; pane.canvas.height = res.h; }
    }
  } else {
    // Single-slice: existing behavior
    rxInfo.textContent = 'Decoding ' + (data.modeName || data.mode) + '...';
    rxCtx.fillStyle = '#000';
    rxCtx.fillRect(0, 0, rxCanvas.width, rxCanvas.height);
    const res = rxResFor(data);
    if (res) { rxCanvas.width = res.w; rxCanvas.height = res.h; }
    statusBar.textContent = 'Decoding ' + (data.modeName || data.mode);
    progressBar.style.width = '0%';
    progressBar.classList.remove('tx');
  }
});

// The decoder let go of a lock (wrong mode, signal gone, new VIS). The
// picture so far stays on the canvas; the status stops claiming a decode.
if (window.api.onSstvRxLockLost) {
  window.api.onSstvRxLockLost((data) => {
    const msg = 'Lost lock on ' + (data.modeName || data.mode) + ' — listening';
    if (data.sliceId && multiActive) {
      const pane = multiRxPanes.get(data.sliceId);
      if (pane) pane.statusEl.textContent = msg;
    } else {
      rxInfo.textContent = msg;
      statusBar.textContent = msg;
      progressBar.style.width = '0%';
    }
  });
}

// One rx-line event is one image row, or TWO for PD modes (a PD audio line
// carries a row pair). ImageData needs the exact row count; a buffer that is
// not a whole number of canvas rows belongs to another lock's canvas and is
// skipped rather than thrown on (it used to throw on every PD line).
function rxRowImage(rgba, w) {
  if (!(w > 0) || rgba.length === 0 || rgba.length % (4 * w) !== 0) return null;
  return new ImageData(rgba, w, rgba.length / (4 * w));
}

window.api.onSstvRxLine((data) => {
  if (data.sliceId && multiActive) {
    const pane = multiRxPanes.get(data.sliceId);
    if (pane) {
      const imgData = rxRowImage(new Uint8ClampedArray(data.rgba), pane.canvas.width);
      if (imgData) pane.ctx.putImageData(imgData, 0, data.line);
      const pct = Math.round((data.line / data.totalLines) * 100);
      pane.statusEl.textContent = 'Line ' + (data.line + 1) + '/' + data.totalLines + ' (' + pct + '%)';
    }
  } else {
    const imgData = rxRowImage(new Uint8ClampedArray(data.rgba), rxCanvas.width);
    if (imgData) rxCtx.putImageData(imgData, 0, data.line);
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
    const weakTag = data.weak ? ' (weak — not saved)' : (data.redecode ? ' (redecoded)' : '');
    rxInfo.textContent = data.mode + weakTag + (data.freqHz ? ' on ' + fmtQrg(data.freqHz) : '') + ' — ' + new Date().toLocaleTimeString();
    progressBar.style.width = '100%';
    setTimeout(() => { progressBar.style.width = '0%'; }, 2000);
    statusBar.textContent = data.redecode
      ? 'Redecoded from buffer: ' + data.mode + (data.weak ? ' (weak)' : '')
      : data.weak
        ? 'Weak decode shown (sync=' + ((data.stats && data.stats.sync) || '?') + '%) — not auto-saved'
        : 'Image decoded: ' + data.mode;
    // Weak-signal badge over the RX canvas
    const weakBadge = document.getElementById('rx-weak-badge');
    if (weakBadge) weakBadge.style.display = data.weak ? '' : 'none';
    // Stash the latest decode so the on-canvas Reply button can grab it
    lastRxImage = {
      imageData: new Uint8ClampedArray(data.imageData),
      width: data.width,
      height: data.height,
      mode: data.mode,
      filename: (data.saved && data.saved.filename) || null,
      theirCall: (data.saved && data.saved.theirCall) || '',
      fskCall: (data.saved && data.saved.fskCall) || '',
      freqHz: data.freqHz || null, rigMode: data.rigMode || '',
      at: Date.now(),
    };
    // Paint the FINAL image (post-processed in main). The progressive
    // rx-line paints are raw; and a redecode arrives with no line events
    // at all, so without this repaint it would be invisible.
    renderSlantedImage(lastRxImage, 0);
    const rxReplyBtn = document.getElementById('rx-reply-btn');
    if (rxReplyBtn) rxReplyBtn.style.display = '';
    ['rx-slant-btn', 'rx-redecode'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
    // Reset slant for the new decode (the slider opens from Fix slant).
    const slantSlider = document.getElementById('rx-slant-slider');
    const slantValue = document.getElementById('rx-slant-value');
    if (slantSlider) slantSlider.value = 0;
    if (slantValue) slantValue.textContent = '0 px';
    rxSlantPx = 0;
  }

  // Add to gallery regardless of mode (redecodes replace the display only —
  // a gallery entry would duplicate the original decode)
  if (data.redecode) return;
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
    weak: !!data.weak, // session-only (weak decodes aren't written to disk)
    filename: (data.saved && data.saved.filename) || null,
    theirCall: (data.saved && data.saved.theirCall) || '',
    fskCall: (data.saved && data.saved.fskCall) || '',
    freqHz: data.freqHz || null, rigMode: data.rigMode || '',
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

// The wf-canvas is rendered by the shared WebGL Waterfall component
// (renderer/waterfall.js) — GPU ring-buffer scroll, in-shader colormap,
// adaptive ranging. feedWaterfall() still owns the FFT and just hands the
// per-bin magnitudes here; the component auto-ranges, so maxMag is unused.
let sstvWaterfall = null;
function drawWaterfallLine(mags) {
  if (!sstvWaterfall) {
    sstvWaterfall = new Waterfall(wfCanvas, {
      bins: WF_BIN_COUNT,
      historyRows: 256,
      colormap: 'classic',
      gamma: 0.4,
    });
    if (!sstvWaterfall.supported) {
      console.warn('[SSTV] WebGL2 unavailable — waterfall disabled');
    }
  }
  if (sstvWaterfall.supported) sstvWaterfall.pushFrame(mags);
}

// ===== DECODE LOG ==========================================================

const decodeLog = document.getElementById('decode-log');

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


// ===========================================================================
// REDESIGN (2026-09-29): starters and looks, replies, tray, top bar,
// settings, tuner + SWR banner, packs. Templates draw through
// lib/sstv-templates.js (window.SstvTemplates).
// ===========================================================================

const T = window.SstvTemplates;
let ctxData = { myCall: '', grid: '', park: '', parkName: '', name: '', rig: '', typedCall: '' };
let currentLook = T.lookFor({ call: 'N0CALL' });
let activePack = null;          // the pack object in use, or null
let packImages = {};            // pack image name -> HTMLImageElement
let packsList = [];             // from main (lib/sstv-packs.js), if present
let activeStarterId = null;     // the starter whose scene is the background
let activeSlot = null;          // where a reply's picture goes, or null

async function refreshContext() {
  if (!window.api.sstvContext) return;
  try { ctxData = Object.assign(ctxData, await window.api.sstvContext()); } catch {}
}

function rebuildLook() {
  currentLook = T.lookFor({ call: callsign || ctxData.myCall || 'N0CALL', shuffle: settings.sstvLookShuffle | 0, pack: activePack });
  const d = document.getElementById('look-desc');
  if (d) d.textContent = T.describeLook(currentLook) + (activePack ? ' · ' + activePack.name + ' pack' : '');
}

function utcStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + 'Z';
}

function templateVars() {
  return {
    MYCALL: (callsign || ctxData.myCall || '').toUpperCase(),
    GRID: (grid || ctxData.grid || '').toUpperCase(),
    CALL: replySession ? (replySession.call || '') : '',
    RSV: replySession ? (replySession.rsv || '595') : '595',
    RPT: (window.SstvHelp && window.SstvHelp.reportText(replySession ? replySession.rsv : '595')) || (replySession ? replySession.rsv : '') || 'RSV 595',
    PARK: ctxData.park || '',
    UTC: utcStamp(),
    NAME: settings.sstvOperatorName || ctxData.name || '',
    RIG: ctxData.rig || '',
  };
}

// How a text layer draws right now: words (placeholders filled, a pack may
// reword a headline), font, fitted size, colour, and where it starts.
function textBox(t, ctx, canvasW) {
  const c = ctx || txCtx;
  const cw = canvasW || txCanvas.width;
  let label = t.label || '';
  let color = t.color || '#ffffff';
  let family = '"Segoe UI", sans-serif';
  let weight = t.bold ? 'bold' : 'normal';
  if (t.tpl) {
    const st = T.textStyle(t, currentLook);
    label = st.label; color = st.color;
    family = st.fontCss + ', "Segoe UI", sans-serif';
    weight = String(st.weight);
  } else if (t.fontCss) {
    // A saved template keeps the lettering it was saved with.
    family = t.fontCss + ', "Segoe UI", sans-serif';
    weight = String(t.fontWeight || 400);
  }
  label = T.fillVars(label, templateVars());
  const italic = t.italic ? 'italic ' : '';
  let size = t.fontSize || 14;
  const font = (sz) => italic + weight + ' ' + sz + 'px ' + family;
  c.font = font(size);
  let width = c.measureText(label).width;
  if (t.tpl || t.fit) {
    const maxW = t.align === 'center' ? cw - 20 : cw - 12 - t.x;
    while (size > 10 && width > maxW) { size -= 1; c.font = font(size); width = c.measureText(label).width; }
  }
  const x0 = t.align === 'center' ? t.x - width / 2 : t.x;
  return { label, font: font(size), size, width, x0, color, outline: !!t.outline };
}

function drawTextLayer(ctx, t, canvasW) {
  const b = textBox(t, ctx, canvasW);
  if (!b.label) return;
  ctx.save();
  ctx.font = b.font;
  const rot = t.rotation || 0;
  const dx = b.x0 - t.x;
  ctx.translate(t.x, t.y);
  if (rot) ctx.rotate(rot);
  if (b.outline) {
    // Brightness contrast survives SSTV; a light outline for dark lettering.
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, b.size / 5);
    ctx.strokeStyle = T.isDark(b.color) ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)';
    ctx.strokeText(b.label, dx, 0);
  } else {
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;
  }
  ctx.fillStyle = b.color;
  ctx.fillText(b.label, dx, 0);
  ctx.restore();
}

function applyStarter(id, opts) {
  const st = T.starter(id);
  if (!st) return;
  const o = opts || {};
  activeStarterId = id;
  const h = txCanvas.height || 256, w = txCanvas.width || 320;
  if (!o.keepTexts) {
    textElements = T.textLayers(id, h, w);
    userTextCounter = 0;
    selectedText = null;
    textPropsEl.style.display = 'none';
  }
  activeSlot = T.replySlot(id, h, w);
  replyInset.x = -1; replyInset.y = -1; replyInset.w = 0; replyInset.h = 0;
  activeTemplateIdx = -1;
  rerenderStarterScene();
  if (replySession && st.reply && rbTpl) rbTpl.value = id;
  window.api.saveSettings({ sstvLastStarter: id });
  saveTextElements();
  renderTemplateStrip();
  renderTxPreview();
  updateTxState();
}

function rerenderStarterScene() {
  if (!activeStarterId) return;
  const c = document.createElement('canvas');
  c.width = txCanvas.width || 320; c.height = txCanvas.height || 256;
  T.renderScene(c, activeStarterId, currentLook, packImages);
  bgImage = c; bgParams = null;
}

// Starter thumbnails, cached per look (a shuffle or pack redraws them).
const _thumbCache = new Map();
function starterThumb(id) {
  const key = id + '|' + (callsign || '') + '|' + (settings.sstvLookShuffle | 0) + '|' + (activePack ? activePack.id + activePack.version : '') + '|' + (replySession ? replySession.call : '');
  let url = _thumbCache.get(key);
  if (!url) {
    const c = document.createElement('canvas'); c.width = 320; c.height = 256;
    const ctx = c.getContext('2d');
    T.renderScene(c, id, currentLook, packImages);
    const slot = T.replySlot(id, 256);
    if (slot) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(slot.x - 3, slot.y - 3, slot.w + 6, slot.h + 6);
      if (replyInset._canvas && replyImage) ctx.drawImage(replyInset._canvas, slot.x, slot.y, slot.w, slot.h);
      else { ctx.fillStyle = '#39415f'; ctx.fillRect(slot.x, slot.y, slot.w, slot.h); }
    }
    for (const t of T.textLayers(id, 256)) drawTextLayer(ctx, t, 320);
    url = c.toDataURL('image/png');
    if (_thumbCache.size > 60) _thumbCache.clear();
    _thumbCache.set(key, url);
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = id;
  return img;
}

function onLookChanged() {
  rebuildLook();
  _thumbCache.clear();
  if (activeStarterId) rerenderStarterScene();
  renderTemplateStrip();
  renderTxPreview();
}

// ---- Reply sessions ----------------------------------------------------------
// Replying is a session with the station: it survives template changes and
// transmissions, and ends on ✕, a reply to another picture, or 15 minutes
// without a transmission.
const REPLY_IDLE_MS = 15 * 60 * 1000;
let replySession = null;
const replybar = document.getElementById('replybar');
const txHead = document.getElementById('tx-head');
const rbCall = document.getElementById('rb-call');
const rbRsv = document.getElementById('rb-rsv');
const rbTpl = document.getElementById('rb-tpl');
const rbSrc = document.getElementById('rb-src');
const rbSent = document.getElementById('rb-sent');

function defaultReplyId() {
  const id = settings.sstvDefaultReply;
  const st = id && T.starter(id);
  return st && st.reply ? id : 'reply';
}
function setDefaultReply(id) {
  settings.sstvDefaultReply = id;
  window.api.saveSettings({ sstvDefaultReply: id });
  renderTemplateStrip();
  statusBar.textContent = 'Double-click now replies with ' + (T.starter(id) || {}).name + '.';
}

async function startReply(entry, starterId) {
  if (!entry) return;
  let call = String(entry.theirCall || entry.fskCall || '').toUpperCase();
  let source = call ? (entry.fskCall && call === String(entry.fskCall).toUpperCase() ? 'FSK' : '') : '';
  if (!call) {
    await refreshContext();
    if (ctxData.typedCall) { call = String(ctxData.typedCall).toUpperCase(); source = 'typed'; }
  }
  replySession = {
    call, source, rsv: cleanReport(rbRsv.value) || '595',
    filename: entry.filename || null, mode: entry.mode || '',
    freqHz: entryQrgHz(entry), rigMode: entry.rigMode || '',
    heardAt: entry.timestamp || entry.at || null,
    startedAt: Date.now(), lastTxAt: 0,
  };
  setReplyImage(entry);
  rbTpl.textContent = '';
  for (const st of T.STARTERS.filter(x => x.reply)) {
    const o = document.createElement('option');
    o.value = st.id; o.textContent = st.name;
    rbTpl.appendChild(o);
  }
  const id = starterId || defaultReplyId();
  rbCall.value = call;
  rbSrc.textContent = call ? source : 'call?';
  rbSrc.title = source === 'FSK' ? 'Read from the FSK ID sent after the picture' : source === 'typed' ? 'The call you last typed in POTACAT' : 'Type their call';
  rbSent.textContent = '';
  showReplyQrg();
  replybar.hidden = false;
  txHead.hidden = true;
  applyStarter(id);
  rbTpl.value = id;
  updateTxButton();
  if (!call) setTimeout(() => rbCall.focus(), 0);
  statusBar.textContent = 'Replying' + (call ? ' to ' + call : '') + '. Change the template any time; the reply stays.';
}

function endReply(why) {
  replySession = null;
  showReplyQrg();
  replyImage = null;
  replybar.hidden = true;
  txHead.hidden = false;
  updateTxButton();
  _thumbCache.clear();
  renderTemplateStrip();
  renderTxPreview();
  if (why) statusBar.textContent = why;
}

function noteReplySent() {
  if (!replySession) return;
  replySession.lastTxAt = Date.now();
  const d = new Date();
  rbSent.textContent = 'sent ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + 'Z';
}

function updateTxButton() {
  if (isTx) return;
  txBtn.textContent = replySession ? 'REPLY' : 'TRANSMIT';
  txBtn.classList.toggle('reply-mode', !!replySession);
}

function drawReplyThumb() {
  const c = document.getElementById('rb-thumb');
  if (!c || !replySession || !replyInset._canvas) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(replyInset._canvas, 0, 0, c.width, c.height);
}

let _saveCallTimer = null;
rbCall.addEventListener('input', () => {
  if (!replySession) return;
  const v = rbCall.value.toUpperCase().replace(/[^A-Z0-9/]/g, '').slice(0, 12);
  if (v !== rbCall.value) rbCall.value = v;
  replySession.call = v;
  rbSrc.textContent = v ? '' : 'call?';
  renderTxPreview();
  // Saved with the picture, so a later reply to it is already filled in.
  const fn = replySession.filename;
  if (fn && window.api.sstvGallerySetCall) {
    clearTimeout(_saveCallTimer);
    _saveCallTimer = setTimeout(() => {
      window.api.sstvGallerySetCall(fn, v);
      const g = galleryImages.find(x => x.filename === fn);
      if (g) { g.theirCall = v; renderGallery(); }
    }, 600);
  }
});
// A report is RSV (595) or the P scale (P5), answered in the style they used.
function cleanReport(text) {
  const v = String(text || '').toUpperCase().replace(/[^0-9P]/g, '');
  return /^P/.test(v) ? v.slice(0, 2) : v.replace(/P/g, '').slice(0, 3);
}
function showReportHint() {
  const H = window.SstvHelp;
  const ok = !!(H && H.parseReport(rbRsv.value));
  rbRsv.classList.toggle('bad', !ok && rbRsv.value !== '');
  rbRsv.title = H ? H.explainReport(rbRsv.value) : '';
}
rbRsv.addEventListener('input', () => {
  const v = cleanReport(rbRsv.value);
  if (v !== rbRsv.value) rbRsv.value = v;
  showReportHint();
  if (replySession && window.SstvHelp && window.SstvHelp.parseReport(v)) { replySession.rsv = v; renderTxPreview(); }
});
showReportHint();
rbTpl.addEventListener('change', () => applyStarter(rbTpl.value));
document.getElementById('rb-x').addEventListener('click', () => endReply('Reply ended.'));
document.getElementById('rb-log').addEventListener('click', () => {
  if (!replySession || !window.api.sstvLogContact) return;
  window.api.sstvLogContact({ call: replySession.call, rsvSent: replySession.rsv, freqHz: replySession.freqHz || null, heardAt: replySession.heardAt, sstvMode: replySession.mode });
});
setInterval(() => {
  if (!replySession || isTx) return;
  const since = replySession.lastTxAt || replySession.startedAt;
  if (Date.now() - since > REPLY_IDLE_MS) endReply('Reply ended after 15 minutes without a transmission.');
}, 30000);

// FSK ID after a picture names the station (see lib/sstv-fskid.js).
if (window.api.onSstvRxFskid) {
  window.api.onSstvRxFskid((d) => {
    const call = String((d && d.call) || '').toUpperCase();
    if (!call) return;
    addLogEntry(logTime() + ' FSK ID ' + call);
    if (lastRxImage && Date.now() - (lastRxImage.at || 0) < 30000) {
      lastRxImage.fskCall = call;
      if (!lastRxImage.theirCall) lastRxImage.theirCall = call;
      const g = galleryImages.find(x => x.filename && x.filename === lastRxImage.filename) || galleryImages[0];
      if (g && !g.theirCall) { g.theirCall = call; g.fskCall = call; renderGallery(); }
    }
    rxInfo.textContent = (lastRxImage ? lastRxImage.mode + ' — ' : '') + 'from ' + call;
  });
}

// The live picture: double-click replies, right-click for more.
const rxBox = document.getElementById('rx-box');
rxBox.addEventListener('dblclick', (e) => {
  if (e.target.closest('.over-actions')) return;
  if (lastRxImage) startReply(lastRxImage);
});
rxBox.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (lastRxImage) openImageMenu(e.clientX, e.clientY, lastRxImage, -1);
});
document.getElementById('rx-slant-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const row = document.getElementById('rx-slant-row');
  row.style.display = row.style.display === 'flex' ? 'none' : 'flex';
  fitCanvases();
});

// ---- Menus -------------------------------------------------------------------
const ctxMenu = document.getElementById('ctx-menu');
function closeMenu() { ctxMenu.hidden = true; }
function openMenu(x, y, header, items) {
  ctxMenu.textContent = '';
  if (header) { const h = document.createElement('div'); h.className = 'h'; h.textContent = header; ctxMenu.appendChild(h); }
  for (const it of items) {
    if (it === '-') { ctxMenu.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (it.danger) b.className = 'danger';
    b.append(it.label);
    if (it.note) { const sm = document.createElement('small'); sm.textContent = it.note; b.appendChild(sm); }
    b.addEventListener('click', () => { closeMenu(); it.action(); });
    ctxMenu.appendChild(b);
  }
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  const first = ctxMenu.querySelector('button');
  if (first) first.focus();
}
document.addEventListener('mousedown', (e) => { if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeGear(); closeFreqPop(); } });

function openImageMenu(x, y, entry, galleryIdx) {
  const call = entry.theirCall || entry.fskCall || '';
  const def = defaultReplyId();
  const items = T.STARTERS.filter(st => st.reply).map(st => ({
    label: 'Reply with ' + st.name.replace(/^Reply( with|:)?\s*/i, ''),
    note: st.id === def ? 'double-click' : '',
    action: () => startReply(entry, st.id),
  }));
  items.push('-');
  // Log without replying (the contact happened, or they answered someone else's
  // reply you want to log): their call, where and when it was heard, the mode.
  items.push({ label: 'Log a contact with ' + (call || 'this station') + '…', action: () => {
    if (!window.api.sstvLogContact) return;
    window.api.sstvLogContact({ call, rsvSent: '', freqHz: entryQrgHz(entry), heardAt: entry.timestamp || entry.at || null, sstvMode: entry.mode || '' });
  } });
  if (entry.dataUrl) items.push({ label: 'View full size', action: () => viewImageFullscreen(entry.dataUrl) });
  items.push({ label: 'Open the pictures folder', action: () => window.api.sstvOpenGalleryFolder() });
  if (galleryIdx >= 0) {
    items.push({ label: 'Delete', danger: true, action: async () => {
      if (entry.filename) await window.api.sstvDeleteImage(entry.filename);
      galleryImages.splice(galleryIdx, 1);
      renderGallery();
      statusBar.textContent = 'Picture deleted';
    } });
  }
  openMenu(x, y, (call || 'Unknown call') + (entry.mode ? ' · ' + entry.mode : ''), items);
}

// ---- Tray tabs ------------------------------------------------------------------
const trayTabs = Array.from(document.querySelectorAll('.tab'));
let showTab = function (t) {
  trayTabs.forEach(b => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll('.tray-body').forEach(b => { b.hidden = b.dataset.body !== t; });
  document.getElementById('open-folder-btn').hidden = t !== 'rx';
  document.getElementById('log-copy-btn').hidden = t !== 'log';
  if (t === 'packs') {
    const dot = document.getElementById('packs-dot');
    if (dot) dot.textContent = '';
    try { localStorage.setItem('sstv-packs-seen', packsSeenKey()); } catch {}
    renderPacksStrip();
  }
  if (t === 'log') decodeLog.scrollTop = decodeLog.scrollHeight;
};
trayTabs.forEach(b => b.addEventListener('click', () => showTab(b.dataset.t)));
showTab('rx');

// ---- Top bar: bands and the frequency picker -----------------------------------
const BAND_OF = (khz) => khz < 4000 ? '80' : khz < 8000 ? '40' : khz < 15000 ? '20' : khz < 19000 ? '17' : khz < 22000 ? '15' : khz < 25500 ? '12' : khz < 30000 ? '10' : '6';
const bandsEl = document.getElementById('bands');
(function buildBands() {
  const groups = Array.from(freqSelect.querySelectorAll('optgroup'));
  for (const g of groups) {
    const band = g.label.replace('m', '');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'band jtcat-band-btn'; b.textContent = band; b.dataset.band = band;
    b.title = g.label + ' SSTV';
    b.addEventListener('click', () => {
      // The calling frequency when the band has one, else its first.
      const opts = Array.from(g.querySelectorAll('option'));
      const opt = opts.find(o => /calling/i.test(o.textContent)) || opts[0];
      freqSelect.value = opt.value;
      freqInput.value = '';
      tuneToFreq(opt.value, opt.dataset.mode);
      showFreq(opt.value, opt.dataset.mode);
    });
    bandsEl.appendChild(b);
  }
})();
function showFreq(khz, mode) {
  const k = Number(khz);
  if (!Number.isFinite(k) || k <= 0) return;
  document.getElementById('freq-label').textContent = (k / 1000).toFixed(3);
  document.getElementById('freq-mode').textContent = (mode || getFreqMode(k)) + ' \u25BE';
  const band = BAND_OF(k);
  bandsEl.querySelectorAll('.band').forEach(b => b.classList.toggle('active', b.dataset.band === band));
}
const freqPop = document.getElementById('freq-pop');
function closeFreqPop() { freqPop.hidden = true; }
document.getElementById('freq-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  freqPop.hidden = !freqPop.hidden;
  if (!freqPop.hidden) freqSelect.focus();
});
document.addEventListener('mousedown', (e) => { if (!freqPop.hidden && !freqPop.contains(e.target) && !e.target.closest('#freq-btn')) closeFreqPop(); });
freqSelect.addEventListener('change', () => {
  const opt = freqSelect.options[freqSelect.selectedIndex];
  showFreq(freqSelect.value, opt && opt.dataset.mode);
  closeFreqPop();
});
freqInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { showFreq(freqInput.value.trim()); closeFreqPop(); } });
tuneBtn.addEventListener('click', () => { showFreq(freqInput.value.trim()); closeFreqPop(); });
window.api.onCatFrequency((hz) => { if (hz > 0) showFreq(Math.round(hz / 1000)); });
{ const o = freqSelect.options[freqSelect.selectedIndex]; showFreq(freqSelect.value, o && o.dataset.mode); }

// ---- Settings popover --------------------------------------------------------------
const gearPop = document.getElementById('gear-pop');
function closeGear() { gearPop.hidden = true; }
document.getElementById('gear-btn').addEventListener('click', (e) => { e.stopPropagation(); gearPop.hidden = !gearPop.hidden; });
document.addEventListener('mousedown', (e) => { if (!gearPop.hidden && !gearPop.contains(e.target) && !e.target.closest('#gear-btn')) closeGear(); });
document.getElementById('look-shuffle').addEventListener('click', () => shuffleLook());
function shuffleLook() {
  if (settings.sstvLookLocked) { statusBar.textContent = 'Your look is kept. Unlock it in ⚙ to shuffle.'; return; }
  settings.sstvLookShuffle = (settings.sstvLookShuffle | 0) + 1;
  window.api.saveSettings({ sstvLookShuffle: settings.sstvLookShuffle });
  onLookChanged();
  statusBar.textContent = 'New look: ' + T.describeLook(currentLook);
}
function setLookLocked(on) {
  settings.sstvLookLocked = !!on;
  window.api.saveSettings({ sstvLookLocked: settings.sstvLookLocked });
  showLookLock();
  statusBar.textContent = on ? 'Look kept: ' + T.describeLook(currentLook) : 'Shuffle is back on.';
}
function showLookLock() {
  const lockBtn = document.getElementById('look-lock');
  const shuf = document.getElementById('look-shuffle');
  if (lockBtn) lockBtn.textContent = settings.sstvLookLocked ? 'Unlock look' : 'Keep this look';
  if (shuf) shuf.disabled = !!settings.sstvLookLocked;
}
document.getElementById('look-lock').addEventListener('click', () => setLookLocked(!settings.sstvLookLocked));
document.getElementById('op-name').addEventListener('change', (e) => {
  settings.sstvOperatorName = e.target.value.trim();
  window.api.saveSettings({ sstvOperatorName: settings.sstvOperatorName });
  _thumbCache.clear(); renderTxPreview(); renderTemplateStrip();
});
document.getElementById('tpl-export').addEventListener('click', async () => {
  if (!window.api.sstvTemplatesExport) return;
  const r = await window.api.sstvTemplatesExport();
  if (r && r.ok) statusBar.textContent = 'Exported ' + r.count + ' template(s), your look and your packs.';
  else if (r && r.error) statusBar.textContent = r.error;
});
document.getElementById('tpl-import').addEventListener('click', async () => {
  if (!window.api.sstvTemplatesImport) return;
  const r = await window.api.sstvTemplatesImport();
  if (r && r.ok) {
    settings = await window.api.getSettings();
    templates = settings.sstvTemplates || [];
    rebuildLook(); _thumbCache.clear(); renderTemplateStrip();
    statusBar.textContent = 'Imported ' + r.added + ' template(s)' + (r.skipped ? ' (' + r.skipped + ' over the limit of 24 were left out)' : '') + '.';
    showTab('tpl');
  } else if (r && r.error) statusBar.textContent = r.error;
});
document.getElementById('log-copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(decodeLog.value).then(() => { statusBar.textContent = 'Decode log copied'; }).catch(() => {});
});

// Flex-only controls stay hidden on other radios (lib/rig-family.js).
function showRigScopedControls() {
  let flex = false;
  try {
    const rig = (settings.rigs || []).find(r => r && r.id === settings.activeRigId);
    flex = rig ? window.RigFamily.isFlex(rig) : window.RigFamily.familyFromCatTarget(settings.catTarget || {}) === 'flex';
  } catch {}
  document.getElementById('multi-row').hidden = !flex && !multiActive;
}

function setStatusDevice(label, fromRigs) {
  const el = document.getElementById('status-device');
  el.textContent = '';
  el.append('Listening on ');
  const b = document.createElement('b'); b.textContent = label; el.appendChild(b);
  el.append(fromRigs ? ' (from My Rigs)' : ' (chosen for SSTV)');
}

// ---- Radio: meters, tuner, SWR trip ----------------------------------------------
const atuBtn = document.getElementById('atu-btn');
const tripEl = document.getElementById('trip');
let rigHasAtu = false;
function setMeter(id, pct, text, color) {
  const el = document.getElementById(id);
  if (!el) return;
  const i = el.querySelector('i');
  i.style.setProperty('--v', Math.max(0, Math.min(100, pct)) + '%');
  if (color) i.style.setProperty('--c', color);
  el.querySelector('b').textContent = text;
}
function showSwr(ratio) {
  if (!(ratio > 0)) return;
  const color = ratio <= 1.5 ? '#4ecca3' : ratio <= 2 ? '#ffd740' : ratio <= 3 ? '#f0a500' : '#e94560';
  setMeter('m-swr', (ratio - 1) / 3 * 100, ratio < 10 ? ratio.toFixed(1) : '>10', color);
}
if (window.api.onCatSwr) window.api.onCatSwr((v) => { if (v > 0) showSwr(1 + v / 60); });
if (window.api.onCatSwrRatio) window.api.onCatSwrRatio((r) => showSwr(r));
let _pwrMax = 100;
if (window.api.onCatFwdPower) window.api.onCatFwdPower((w) => {
  const v = Number(w) || 0;
  if (v > _pwrMax) _pwrMax = v;
  setMeter('m-pwr', v / _pwrMax * 100, v ? Math.round(v) + ' W' : '—');
});
async function runAtu(btn) {
  if (!window.api.sstvAtuTune) return;
  const label = btn.textContent;
  btn.classList.add('busy'); btn.textContent = 'Tuning…'; btn.disabled = true;
  const r = await window.api.sstvAtuTune();
  setTimeout(() => { btn.classList.remove('busy'); btn.textContent = label; btn.disabled = false; }, 2500);
  statusBar.textContent = r && r.ok ? 'Tuning the antenna. Transmit unlocks when the radio reports a match.' : 'Tune failed: ' + ((r && r.error) || 'no answer');
}
atuBtn.addEventListener('click', () => runAtu(atuBtn));
document.getElementById('trip-atu').addEventListener('click', (e) => runAtu(e.currentTarget));
document.getElementById('trip-override').addEventListener('click', () => { if (window.api.swrGuardOverride) window.api.swrGuardOverride(); });
if (window.api.onSstvRigState) window.api.onSstvRigState((st) => {
  rigHasAtu = !!(st && st.atu);
  atuBtn.hidden = !rigHasAtu;
  document.getElementById('trip-atu').hidden = !rigHasAtu;
  const tripped = !!(st && st.swrTripped);
  tripEl.hidden = !tripped;
  if (tripped) {
    document.getElementById('trip-msg').textContent = st.swrMessage || 'The SWR guard stopped the transmission.';
    // The picture was stopped by main; make sure this window agrees.
    if (isTx) abortTxLocal('Stopped: SWR over the limit');
  }
  updateTxState();
  fitCanvases();
});

// ---- Status lines over the pictures ------------------------------------------------
const MODE_SECONDS = { martin1: 114, martin2: 58, martin3: 57, martin4: 29, scottie1: 110, scottie2: 71, scottieDx: 269, robot24: 24, robot36: 36, robot72: 72, pd90: 90, pd120: 126, pd160: 161, pd180: 187, pd240: 248 };
function updateTxState() {
  const el = document.getElementById('tx-state');
  if (!el) return;
  const st = activeStarterId ? T.starter(activeStarterId) : null;
  el.textContent = (st ? st.name + ' · ' : '') + (MODE_SECONDS[modeSelect.value] || '?') + ' s';
}

// ---- Fit the pictures to the window (no scrolling) --------------------------------
function fitOne(canvas, area) {
  if (!canvas || !area) return;
  const aw = area.clientWidth, ah = area.clientHeight;
  if (!aw || !ah) return;
  const aspect = (canvas.width || 320) / (canvas.height || 256);
  let w = Math.min(aw - 2, (ah - 2) * aspect);
  w = Math.max(80, Math.floor(w));
  canvas.style.width = w + 'px';
  canvas.style.height = Math.round(w / aspect) + 'px';
}
function fitCanvases() {
  fitOne(rxCanvas, document.getElementById('rx-area'));
  fitOne(txCanvas, document.getElementById('tx-area'));
}
try {
  const ro = new ResizeObserver(() => fitCanvases());
  ro.observe(document.getElementById('rx-area'));
  ro.observe(document.getElementById('tx-area'));
} catch { window.addEventListener('resize', fitCanvases); }
// Keep the fit right when a decode changes the RX picture's shape.
window.api.onSstvRxVis(() => setTimeout(fitCanvases, 0));

// ---- Style packs ----------------------------------------------------------------------
function packsSeenKey() { return packsList.filter(p => p.inSeason).map(p => p.id + '@' + p.version).join(','); }
async function refreshPacks() {
  if (!window.api.sstvPacksList) return;
  try { packsList = (await window.api.sstvPacksList()) || []; } catch { packsList = []; }
  const sel = document.getElementById('pack-select');
  if (sel) {
    const cur = settings.sstvActivePack || '';
    sel.textContent = '';
    const none = document.createElement('option'); none.value = ''; none.textContent = 'None'; sel.appendChild(none);
    for (const p of packsList.filter(x => x.claimed || x.bundled || x.installed)) {
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.inSeason ? '' : ' (out of season)'); sel.appendChild(o);
    }
    sel.value = cur;
  }
  // A "new" dot, once, for in-season packs not yet looked at.
  let seen = '';
  try { seen = localStorage.getItem('sstv-packs-seen') || ''; } catch {}
  const dot = document.getElementById('packs-dot');
  if (dot) dot.textContent = packsList.some(p => p.inSeason && !p.claimed) && seen !== packsSeenKey() ? '\u25CF new' : '';
  if (!document.querySelector('[data-body="packs"]').hidden) renderPacksStrip();
}
async function loadActivePack() {
  activePack = null; packImages = {};
  const id = settings.sstvActivePack;
  if (!id || !window.api.sstvPackGet) return;
  const got = await window.api.sstvPackGet(id);
  if (!got || !got.pack) return;
  // Pack fonts arrive as bytes and are registered here (no network).
  for (const f of (got.fonts || [])) {
    try { const face = new FontFace(f.family, f.bytes); await face.load(); document.fonts.add(face); } catch (e) { console.warn('[SSTV] pack font', f.family, e.message); }
  }
  const imgs = (got.pack.images && typeof got.pack.images === 'object') ? got.pack.images : {};
  await Promise.all(Object.keys(imgs).map(name => new Promise((res) => {
    const im = new Image(); im.onload = () => { packImages[name] = im; res(); }; im.onerror = () => res(); im.src = imgs[name];
  })));
  activePack = got.pack;
}
async function setActivePack(id) {
  if (window.api.sstvPackSetActive) {
    const r = await window.api.sstvPackSetActive(id || null);
    if (r && r.ok === false) { statusBar.textContent = r.error || 'Could not use that pack.'; return; }
  }
  settings.sstvActivePack = id || null;
  await loadActivePack();
  onLookChanged();
  await refreshPacks();
  statusBar.textContent = id ? 'Style pack: ' + (activePack ? activePack.name : id) : 'Style pack off';
}
document.getElementById('pack-select').addEventListener('change', (e) => setActivePack(e.target.value));
function renderPacksStrip() {
  const strip = document.getElementById('packs-strip');
  strip.textContent = '';
  if (!window.api.sstvPacksList) {
    const n = document.createElement('div'); n.style.cssText = 'font-size:12px;color:var(--text-dim);padding:8px;line-height:1.5;';
    n.textContent = 'Style packs are not available in this build.';
    strip.appendChild(n); return;
  }
  if (!packsList.length) {
    const n = document.createElement('div'); n.style.cssText = 'font-size:12px;color:var(--text-dim);padding:8px;';
    n.textContent = 'No packs yet. New ones appear here when potacat.com publishes them.';
    strip.appendChild(n); return;
  }
  for (const p of packsList) {
    const card = document.createElement('div');
    card.className = 'pack-card' + (p.compatible === false ? ' soon' : '');
    const c = document.createElement('canvas'); c.width = 320; c.height = 256;
    drawPackPreview(c, p);
    const nm = document.createElement('div'); nm.className = 'pack-name';
    const state = p.id === settings.sstvActivePack ? 'in use' : (p.claimed || p.installed || p.bundled) ? 'use' : 'get';
    nm.textContent = p.name + ' · ' + state;
    card.title = p.name + (p.by ? ' by ' + p.by : '') + (p.inSeason ? ' — in season' : ' — out of season, still yours to use') + (p.compatible === false ? '. Needs a newer POTACAT.' : '');
    card.append(c, nm);
    card.addEventListener('click', async () => {
      if (p.compatible === false) { statusBar.textContent = p.name + ' needs a newer version of POTACAT.'; return; }
      if (p.id === settings.sstvActivePack) { await setActivePack(null); return; }
      if (!(p.claimed || p.installed || p.bundled) && window.api.sstvPackClaim) {
        statusBar.textContent = 'Getting ' + p.name + '…';
        const r = await window.api.sstvPackClaim(p.id);
        if (!r || !r.ok) { statusBar.textContent = (r && r.error) || 'Could not get that pack.'; return; }
      }
      await setActivePack(p.id);
    });
    strip.appendChild(card);
  }
}
const _packPreviewCache = new Map();
async function drawPackPreview(canvas, p) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1b1512'; ctx.fillRect(0, 0, 320, 256);
  try {
    let pack = _packPreviewCache.get(p.id + '@' + p.version);
    if (!pack && (p.bundled || p.installed || p.claimed) && window.api.sstvPackGet) {
      const got = await window.api.sstvPackGet(p.id);
      pack = got && got.pack;
      if (pack) _packPreviewCache.set(p.id + '@' + p.version, pack);
    }
    if (pack && pack.backgrounds && pack.backgrounds.length) {
      T.drawRecipe(ctx, pack, pack.backgrounds[0], pack.palettes[0], T.rnd(77), {});
    } else {
      ctx.fillStyle = '#2c3a4f'; ctx.fillRect(0, 0, 320, 256);
    }
    ctx.font = '700 34px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineJoin = 'round';
    ctx.strokeText(p.name, 160, 236); ctx.fillStyle = '#ffffff'; ctx.fillText(p.name, 160, 236);
  } catch {}
}
if (window.api.onSstvPacksChanged) window.api.onSstvPacksChanged(async (list) => {
  packsList = list || packsList;
  await refreshPacks();
});


// ---- Template categories (tray chips) ------------------------------------------
let tplCategory = 'all';
try { tplCategory = localStorage.getItem('sstv-tpl-category') || 'all'; } catch {}
function renderTplCats() {
  const box = document.getElementById('tpl-cats');
  if (!box) return;
  box.textContent = '';
  for (const c of T.CATEGORIES) {
    if (c.id === 'mine' && !templates.length) continue;
    if (c.id !== 'all' && c.id !== 'mine' && !T.STARTERS.some(s => s.category === c.id) && !templates.some(t => t.category === c.id)) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (c.id === tplCategory ? ' on' : ''); b.textContent = c.name;
    b.addEventListener('click', () => {
      tplCategory = c.id;
      try { localStorage.setItem('sstv-tpl-category', c.id); } catch {}
      renderTemplateStrip();
    });
    box.appendChild(b);
  }
}
{
  const _showTab = showTab;
  // The chips only show on the Templates tab.
  showTab = function (t) { _showTab(t); const box = document.getElementById('tpl-cats'); if (box) box.hidden = t !== 'tpl'; };
}

// ---- Right-click the Transmit picture ---------------------------------------------
document.getElementById('tx-box').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (isTx) return;
  const items = [
    { label: 'Save as my template', note: templates.length + '/24', action: () => tplSaveBtn.click() },
    '-',
    { label: settings.sstvLookLocked ? 'Unlock my look' : 'Keep this look', action: () => setLookLocked(!settings.sstvLookLocked) },
  ];
  if (!settings.sstvLookLocked) items.push({ label: 'Shuffle my look', action: () => shuffleLook() });
  items.push('-', { label: 'Add text', action: () => addTextBtn.click() }, { label: 'Use a photo…', action: () => loadBtn.click() });
  openMenu(e.clientX, e.clientY, T.describeLook(currentLook), items);
});
showLookLock();

// ---- Template photos small enough to travel ------------------------------------
// A saved photo used to be the camera original at JPEG 0.85 — several MB,
// which the cloud (150 KB per photo, 2 MB per set) and the ECHOCAT settings
// push both refuse. Nothing SSTV sends is bigger than 640x496 (PD modes), so
// scale to fit that and step the quality down until it is under the cap.
const TEMPLATE_PHOTO_MAX_W = 640, TEMPLATE_PHOTO_MAX_H = 496, TEMPLATE_PHOTO_MAX_CHARS = 140 * 1024;
function templatePhotoDataUrl(img) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) return null;
  let scale = Math.min(1, TEMPLATE_PHOTO_MAX_W / w0, TEMPLATE_PHOTO_MAX_H / h0);
  for (let pass = 0; pass < 4; pass++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * scale));
    c.height = Math.max(1, Math.round(h0 * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      const url = c.toDataURL('image/jpeg', q);
      if (url.length <= TEMPLATE_PHOTO_MAX_CHARS) return url;
    }
    scale *= 0.75;
  }
  return null;
}

// Photo templates saved before this shrink: re-encode them once, in place.
async function shrinkLegacyTemplatePhotos() {
  let changed = false;
  for (const t of templates) {
    if (!t || typeof t.bgDataUrl !== 'string' || t.bgDataUrl.length <= 150 * 1024) continue;
    const img = new Image();
    const ok = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = t.bgDataUrl; });
    if (!ok) continue;
    const small = templatePhotoDataUrl(img);
    if (small) { t.bgDataUrl = small; changed = true; }
  }
  if (changed) saveTemplates();
}
setTimeout(() => { shrinkLegacyTemplatePhotos().catch(() => {}); }, 3000);

// Main stamps ids on every save and merges other machines' templates in.
if (window.api.onSstvTemplatesUpdate) {
  window.api.onSstvTemplatesUpdate((d) => {
    if (!d || !Array.isArray(d.templates)) return;
    const activeId = activeTemplateIdx >= 0 && templates[activeTemplateIdx] ? templates[activeTemplateIdx].id : null;
    templates = d.templates;
    settings.sstvTemplates = templates;
    activeTemplateIdx = activeId ? templates.findIndex((t) => t && t.id === activeId) : activeTemplateIdx;
    if (d.fromCloud) {
      if (d.defaultReply !== undefined) settings.sstvDefaultReply = d.defaultReply;
      if (!!d.lookLocked !== !!settings.sstvLookLocked) { settings.sstvLookLocked = !!d.lookLocked; showLookLock(); }
      if (Number.isFinite(d.lookShuffle) && d.lookShuffle !== settings.sstvLookShuffle) {
        settings.sstvLookShuffle = d.lookShuffle;
        rebuildLook();
        onLookChanged();
      }
      statusBar.textContent = 'Templates updated from your other machines.';
    }
    renderTemplateStrip();
  });
}

// ---- Cloud template sync status (⚙ > Templates) ----------------------------------
function showTemplateSyncState(st) {
  const line = document.getElementById('tpl-sync-line');
  const btn = document.getElementById('tpl-sync-now');
  if (!line || !st) return;
  const at = st.at ? new Date(st.at).toISOString().slice(11, 16) + 'Z' : '';
  const words = {
    'ok': 'Templates synced with your POTACAT Cloud account' + (at ? ' at ' + at : '') + '.',
    'signed-out': 'Sign in to POTACAT Cloud (Settings) and your templates follow you to every computer.',
    'not-ready': 'Cloud template sync is not available yet. Your templates are kept on this computer.',
    'too-large': st.error || 'Your templates are too large to sync.',
    'error': 'Templates did not sync: ' + (st.error || 'unknown error') + '.',
    'idle': 'Templates sync with your POTACAT Cloud account.',
  };
  line.textContent = words[st.status] || words.idle;
  line.style.color = (st.status === 'too-large' || st.status === 'error') ? 'var(--accent-red, #e94560)' : '';
  if (btn) btn.hidden = st.status === 'signed-out' || st.status === 'not-ready';
}
if (window.api.sstvTemplatesSyncState) {
  window.api.sstvTemplatesSyncState().then(showTemplateSyncState).catch(() => {});
  window.api.onSstvTemplatesSyncState(showTemplateSyncState);
  const syncBtn = document.getElementById('tpl-sync-now');
  if (syncBtn) syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    window.api.sstvTemplatesSyncNow().then(showTemplateSyncState).catch(() => {}).finally(() => { syncBtn.disabled = false; });
  });
}

// ---- Where a received picture was heard -------------------------------------------
// Main stamps each picture with the dial when its VIS header arrived. The
// Received tiles show it, and the reply bar offers to go back there: a reply
// sent while tuned elsewhere goes nowhere the other station is listening.
let _dialHz = 0;
let _dialMode = '';
window.api.onCatFrequency((hz) => { if (hz > 0) { _dialHz = hz; showReplyQrg(); } });
if (window.api.onCatMode) window.api.onCatMode((m) => { _dialMode = String(m || ''); showReplyQrg(); });
// The side a mode names: data variants (PKTUSB, USB-D, DIGU) count as their
// sideband; CW/FM/AM name none, and SSTV cannot go out in them.
function sideOf(mode) {
  const m = String(mode || '').toUpperCase();
  if (/LSB|DIGL/.test(m)) return 'LSB';
  if (/USB|DIGU/.test(m)) return 'USB';
  return m ? 'OTHER' : '';
}
function entryQrgHz(e) {
  if (!e) return null;
  if (e.freqHz > 0) return e.freqHz;
  if (e.freqKhz > 0) return e.freqKhz * 1000;
  return null;
}
// Whole kHz first: 7171.5 kHz is 7.172, never a float-rounded 7.171.
function fmtQrg(hz) { return (Math.round(hz / 1000) / 1000).toFixed(3); }
const rbQrg = document.getElementById('rb-qrg');
function showReplyQrg() {
  if (!rbQrg) return;
  const hz = replySession && replySession.freqHz;
  if (!hz) { rbQrg.hidden = true; return; }
  // The right frequency on the wrong sideband (or in CW/FM/AM) is not "on":
  // their picture is heard, but a reply there is not.
  const want = sideOf(replySession.rigMode) === 'LSB' || sideOf(replySession.rigMode) === 'USB' ? sideOf(replySession.rigMode) : getFreqMode(Math.round(hz / 1000));
  const have = sideOf(_dialMode);
  const offFreq = _dialHz > 0 && Math.abs(_dialHz - hz) > 500;
  const offSide = !!have && have !== want;
  const off = offFreq || offSide;
  rbQrg.hidden = false;
  rbQrg.classList.toggle('off', off);
  rbQrg.textContent = off ? 'Go to ' + fmtQrg(hz) + (offSide && !offFreq ? ' ' + want : '') : 'on ' + fmtQrg(hz);
  rbQrg.title = off
    ? 'You heard this picture on ' + fmtQrg(hz) + ' MHz ' + want + '; the radio is on ' + fmtQrg(_dialHz || hz) + (_dialMode ? ' ' + _dialMode : '') + '. Click to go back before replying.'
    : 'Heard on ' + fmtQrg(hz) + ' MHz' + (replySession.rigMode ? ' ' + replySession.rigMode : '');
}
if (rbQrg) rbQrg.addEventListener('click', () => {
  if (!replySession || !replySession.freqHz || !rbQrg.classList.contains('off')) return;
  const khz = Math.round(replySession.freqHz / 1000);
  // Data variants (PKTUSB, USB-D, DIGU) come back as their sideband: SSTV
  // transmit picks the data mode itself where a radio needs it.
  const s = sideOf(replySession.rigMode);
  const mode = s === 'LSB' || s === 'USB' ? s : getFreqMode(khz);
  showFreq(khz, mode);
  tuneToFreq(String(khz), mode);
});

// ---- How SSTV contacts work (⚙ > Help, and the ? by the report) ------------------
function openSstvHelp(focusId) {
  const H = window.SstvHelp;
  if (!H) return;
  let veil = document.getElementById('help-veil');
  if (!veil) {
    veil = document.createElement('div');
    veil.id = 'help-veil'; veil.className = 'help-veil';
    veil.innerHTML = '<div class="help-panel" role="dialog" aria-modal="true" aria-labelledby="help-title"></div>';
    document.body.appendChild(veil);
    const panel = veil.firstChild;
    const h3 = document.createElement('h3');
    h3.id = 'help-title';
    h3.appendChild(document.createTextNode('How SSTV contacts work'));
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '\u2715'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => { veil.hidden = true; });
    h3.appendChild(x);
    panel.appendChild(h3);
    for (const s of H.SECTIONS) {
      const sec = document.createElement('section');
      sec.dataset.id = s.id;
      const h = document.createElement('h4'); h.textContent = s.title; sec.appendChild(h);
      if (s.text) { const p = document.createElement('p'); p.textContent = s.text; sec.appendChild(p); }
      if (s.items) { const ul = document.createElement('ul'); for (const it of s.items) { const li = document.createElement('li'); li.textContent = it; ul.appendChild(li); } sec.appendChild(ul); }
      if (s.table) { const tb = document.createElement('table'); for (const [a, b] of s.table) { const tr = document.createElement('tr'); const ta = document.createElement('td'); ta.textContent = a; const tbd = document.createElement('td'); tbd.textContent = b; tr.appendChild(ta); tr.appendChild(tbd); tb.appendChild(tr); } sec.appendChild(tb); }
      panel.appendChild(sec);
    }
    veil.addEventListener('mousedown', (e) => { if (e.target === veil) veil.hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !veil.hidden) veil.hidden = true; });
  }
  veil.hidden = false;
  const panel = veil.firstChild;
  panel.querySelectorAll('section').forEach((s) => s.classList.toggle('hot', s.dataset.id === focusId));
  const target = focusId && panel.querySelector('section[data-id="' + focusId + '"]');
  panel.scrollTop = target ? target.offsetTop - panel.offsetTop - 8 : 0;
}
document.getElementById('sstv-help-btn').addEventListener('click', () => openSstvHelp());
document.getElementById('rb-help').addEventListener('click', () => openSstvHelp('reports'));
