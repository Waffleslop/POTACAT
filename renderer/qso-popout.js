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
/* POTACAT — QSO Log Pop-out Window */
'use strict';

let accentGreen = '#4ecca3'; // updated by colorblind mode

// --- Band lookup (duplicated from app.js — no Node in renderer) ---
const BAND_RANGES = [
  [1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'],
  [7000, 7300, '40m'], [10100, 10150, '30m'], [14000, 14350, '20m'],
  [18068, 18168, '17m'], [21000, 21450, '15m'], [24890, 24990, '12m'],
  [28000, 29700, '10m'], [50000, 54000, '6m'], [70000, 70500, '4m'], [144000, 148000, '2m'],
  [420000, 450000, '70cm'],
];
function freqKhzToBand(khz) {
  const f = parseFloat(khz);
  for (const [lo, hi, band] of BAND_RANGES) {
    if (f >= lo && f <= hi) return band;
  }
  return '';
}
function freqMhzToBandLocal(mhz) {
  return freqKhzToBand(parseFloat(mhz) * 1000);
}

// --- Grid to lat/lon (duplicated — no Node in renderer) ---
function gridToLatLonLocal(grid) {
  if (!grid || grid.length < 4) return null;
  const g = grid.toUpperCase();
  const lonField = g.charCodeAt(0) - 65;
  const latField = g.charCodeAt(1) - 65;
  const lonSquare = parseInt(g[2], 10);
  const latSquare = parseInt(g[3], 10);
  let lon = lonField * 20 + lonSquare * 2 - 180;
  let lat = latField * 10 + latSquare * 1 - 90;
  if (grid.length >= 6) {
    const lonSub = g.charCodeAt(4) - 65;
    const latSub = g.charCodeAt(5) - 65;
    lon += lonSub * (2 / 24) + (1 / 24);
    lat += latSub * (1 / 24) + (1 / 48);
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

// --- Columns ---
// The logbook was a fixed table: sixteen <th> in the HTML, a positional
// cells[] array, an EDITABLE map keyed by INDEX, and colours applied by
// nth-child. Every one of those broke the moment a column could be hidden or
// moved, so the whole thing is defined here instead and the header, the rows
// and the CSS classes all come from this one list (LZ3AW item 8: MY_SIG_INFO,
// resize, arrange, and a right-click picker like the Spots table has).
//
//   key    — stable id, used for prefs, the CSS class (.col-<key>) and dedupe
//   label  — header text
//   sort   — ADIF field to sort on (omit for a column that can't be sorted)
//   field  — ADIF field this cell EDITS in place (omit for read-only)
//   get    — cell text from a QSO record
//   w      — default width in px
//   off    — true to start hidden (the operator opts in from the picker)
const ALL_COLUMNS = [
  { key: 'QSO_DATE', label: 'Date', sort: 'QSO_DATE', field: 'QSO_DATE', w: 82,
    get: (q) => (q.QSO_DATE ? q.QSO_DATE.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '') },
  { key: 'TIME_ON', label: 'Time', sort: 'TIME_ON', field: 'TIME_ON', w: 52,
    get: (q) => (q.TIME_ON ? q.TIME_ON.slice(0, 2) + ':' + q.TIME_ON.slice(2, 4) : '') },
  { key: 'CALL', label: 'Callsign', sort: 'CALL', field: 'CALL', w: 92, get: (q) => q.CALL || '' },
  { key: 'FREQ', label: 'Freq', sort: 'FREQ', field: 'FREQ', w: 72, get: (q) => q.FREQ || '' },
  { key: 'MODE', label: 'Mode', sort: 'MODE', field: 'MODE', w: 56, get: (q) => q.MODE || '' },
  { key: 'BAND', label: 'Band', sort: 'BAND', w: 52, get: (q) => q.BAND || '' },
  { key: 'TX_PWR', label: 'Pwr', sort: 'TX_PWR', field: 'TX_PWR', w: 46, get: (q) => q.TX_PWR || '' },
  { key: 'RST_SENT', label: 'RST S', field: 'RST_SENT', w: 48, get: (q) => q.RST_SENT || '' },
  { key: 'RST_RCVD', label: 'RST R', field: 'RST_RCVD', w: 48, get: (q) => q.RST_RCVD || '' },
  { key: 'SIG_INFO', label: 'Park', sort: 'SIG_INFO', field: 'SIG_INFO', w: 86, get: (q) => q.SIG_INFO || '' },
  // THEIR park is SIG_INFO; MY park — the reference being activated — is
  // MY_SIG_INFO (MY_POTA_REF on older logs). An activator's own log has
  // SIG_INFO empty on every ordinary QSO, so without this column their own
  // activations are invisible in their logbook.
  { key: 'MY_SIG_INFO', label: 'My Park', sort: 'MY_SIG_INFO', field: 'MY_SIG_INFO', w: 86, off: true,
    get: (q) => q.MY_SIG_INFO || q.MY_POTA_REF || '' },
  { key: 'GRIDSQUARE', label: 'Grid', sort: 'GRIDSQUARE', field: 'GRIDSQUARE', w: 62, get: (q) => q.GRIDSQUARE || '' },
  { key: 'STATE', label: 'State', sort: 'STATE', field: 'STATE', w: 52, get: (q) => q.STATE || '' },
  { key: 'COUNTRY', label: 'Country', sort: 'COUNTRY', field: 'COUNTRY', w: 110, get: (q) => q.COUNTRY || '' },
  { key: 'QSL', label: 'QSL', sort: 'LOTW_QSL_SENT', w: 56, get: (q) => qslMarks(q),
    title: 'QSL status: L = uploaded to LoTW, L✓ = LoTW confirmed, P = paper QSL received. Double-click to toggle paper QSL.' },
  { key: 'COMMENT', label: 'Notes', field: 'COMMENT', w: 150, get: (q) => q.COMMENT || '' },
];

const COL_PREFS_KEY = 'potacat-log-cols-v1';
let colPrefs = { order: [], hidden: [], shown: [], widths: {} };
try {
  const saved = JSON.parse(localStorage.getItem(COL_PREFS_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    colPrefs = {
      order: Array.isArray(saved.order) ? saved.order : [],
      hidden: Array.isArray(saved.hidden) ? saved.hidden : [],
      shown: Array.isArray(saved.shown) ? saved.shown : [],
      widths: (saved.widths && typeof saved.widths === 'object') ? saved.widths : {},
    };
  }
} catch { /* corrupt prefs are not worth a broken logbook */ }

function saveColPrefs() {
  try { localStorage.setItem(COL_PREFS_KEY, JSON.stringify(colPrefs)); } catch { /* private mode */ }
}

/** Columns in the operator's order. Unknown saved keys are dropped and columns
 *  a later release ADDS are appended, so prefs never freeze the column set. */
function orderedColumns() {
  const byKey = new Map(ALL_COLUMNS.map((c) => [c.key, c]));
  const out = [];
  for (const key of colPrefs.order) {
    const c = byKey.get(key);
    if (c && !out.includes(c)) out.push(c);
  }
  for (const c of ALL_COLUMNS) if (!out.includes(c)) out.push(c);
  return out;
}

/** Hidden = explicitly hidden, or off-by-default and never opted into. Two
 *  lists rather than one so a column added by a later release keeps its own
 *  default instead of inheriting a decision the operator never made. */
function isColHidden(c) {
  if (colPrefs.hidden.includes(c.key)) return true;
  if (c.off) return !colPrefs.shown.includes(c.key);
  return false;
}

function visibleColumns() {
  return orderedColumns().filter((c) => !isColHidden(c));
}

function colWidth(c) {
  const w = Number(colPrefs.widths[c.key]);
  return Number.isFinite(w) && w >= 24 ? w : c.w;
}

// QSL column marks: L = uploaded to LoTW (Phase 1.5 stamps it after each
// successful upload), L + check = LoTW confirmed (Phase 3 download), P =
// paper card received (manual dblclick toggle).
function qslMarks(q) {
  const marks = [];
  if (String(q.LOTW_QSL_RCVD || '').toUpperCase() === 'Y') marks.push('L✓');
  else if (String(q.LOTW_QSL_SENT || '').toUpperCase() === 'Y') marks.push('L');
  if (String(q.QSL_RCVD || '').toUpperCase() === 'Y') marks.push('P');
  return marks.join(' ');
}

// --- State ---
let allQsos = [];
let filtered = [];
let sortCol = 'QSO_DATE';
let sortAsc = false;
let searchText = '';
let toastTimer = null;
let callsignInfo = {}; // { CALL: { lat, lon, continent, name } }
let homeGrid = '';

// --- Filter state ---
let filterBand = '';
let filterMode = '';
let filterRegion = '';
let filterFrom = '';
let filterTo = '';

// --- Selection state ---
let selectedIdxs = new Set(); // QSO idx values currently selected
let lastClickedIdx = null;    // for shift-click range select

// --- Map state ---
let map = null;
let mapMarkers = [];
let homeMarker = null;
let mapVisible = false;
let hoverArcs = []; // Leaflet polyline layers for hover arcs
let parkLocationCache = {}; // { 'K-1234': { lat, lon } }

// --- Elements ---
const tbody = document.getElementById('qso-tbody');
const table = document.getElementById('qso-table');
const emptyMsg = document.getElementById('qso-empty');
const countEl = document.getElementById('qso-count');
const searchInput = document.getElementById('qso-search');
const filterBandEl = document.getElementById('qso-filter-band');
const filterModeEl = document.getElementById('qso-filter-mode');
const filterRegionEl = document.getElementById('qso-filter-region');
const filterFromEl = document.getElementById('qso-filter-from');
const filterToEl = document.getElementById('qso-filter-to');
const mapToggleBtn = document.getElementById('qso-map-toggle');
const mapContainer = document.getElementById('qso-map-container');
const mapSplitter = document.getElementById('qso-map-splitter');

// --- Toast ---
function toast(msg) {
  const el = document.getElementById('qso-toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// --- Stats ---
function updateStats(list) {
  document.getElementById('qso-stat-total').textContent = `${list.length} QSOs`;
  document.getElementById('qso-stat-calls').textContent =
    `${new Set(list.map(q => (q.CALL || '').toUpperCase())).size} calls`;

  const bandCounts = {};
  for (const q of list) if (q.BAND) bandCounts[q.BAND] = (bandCounts[q.BAND] || 0) + 1;
  const topBands = Object.entries(bandCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById('qso-stat-bands').textContent =
    topBands.map(([b, c]) => `${b}: ${c}`).join(', ') || '-';

  const modeCounts = {};
  for (const q of list) if (q.MODE) modeCounts[q.MODE] = (modeCounts[q.MODE] || 0) + 1;
  const topModes = Object.entries(modeCounts).sort((a, b) => b[1] - a[1]).slice(0, 4);
  document.getElementById('qso-stat-modes').textContent =
    topModes.map(([m, c]) => `${m}: ${c}`).join(', ') || '-';
}

// --- Check if any filter is active ---
function hasActiveFilters() {
  return searchText || filterBand || filterMode || filterRegion || filterFrom || filterTo;
}

function updateResendLabel() {
  const btn = document.getElementById('qso-resend');
  if (selectedIdxs.size > 0) {
    btn.textContent = `Resend ${selectedIdxs.size} to Logbook`;
  } else {
    btn.textContent = 'Resend to Logbook';
  }
}

function clearSelection() {
  selectedIdxs.clear();
  lastClickedIdx = null;
  _virt.invalidate();
  updateResendLabel();
}

// --- Render ---
function render() {
  const search = searchText.toLowerCase();
  filtered = allQsos;

  // Text search
  if (search) {
    filtered = filtered.filter(q => {
      const hay = [q.CALL, q.SIG_INFO, q.COMMENT, q.MODE, q.BAND].join(' ').toLowerCase();
      return hay.includes(search);
    });
  }

  // Band filter
  if (filterBand) {
    filtered = filtered.filter(q => (q.BAND || '') === filterBand);
  }

  // Mode filter
  if (filterMode) {
    filtered = filtered.filter(q => (q.MODE || '').toUpperCase() === filterMode);
  }

  // Region filter (continent from cty.dat)
  if (filterRegion) {
    filtered = filtered.filter(q => {
      const info = callsignInfo[(q.CALL || '').toUpperCase()];
      return info && info.continent === filterRegion;
    });
  }

  // Date range (YYYYMMDD string compare)
  if (filterFrom) {
    const from = filterFrom.replace(/-/g, '');
    filtered = filtered.filter(q => (q.QSO_DATE || '') >= from);
  }
  if (filterTo) {
    const to = filterTo.replace(/-/g, '');
    filtered = filtered.filter(q => (q.QSO_DATE || '') <= to);
  }

  // Sort
  const dir = sortAsc ? 1 : -1;
  filtered.sort((a, b) => {
    let va = (a[sortCol] || ''), vb = (b[sortCol] || '');
    if (sortCol === 'FREQ') return (parseFloat(va) - parseFloat(vb)) * dir;
    if (sortCol === 'QSO_DATE') {
      const ka = (a.QSO_DATE || '') + (a.TIME_ON || '');
      const kb = (b.QSO_DATE || '') + (b.TIME_ON || '');
      return ka.localeCompare(kb) * dir;
    }
    return va.localeCompare(vb) * dir;
  });

  // Count
  countEl.textContent = hasActiveFilters()
    ? `${filtered.length} / ${allQsos.length} QSOs`
    : `${allQsos.length} QSOs`;

  updateStats(filtered);

  if (allQsos.length === 0) {
    table.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    updateMap();
    return;
  }
  table.classList.remove('hidden');
  emptyMsg.classList.add('hidden');

  // Sort indicators
  table.querySelectorAll('th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortCol) {
      th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
    }
  });

  // Virtual scrolling — only render visible rows
  _virt.filtered = filtered;
  _virt.lastStart = -1; // invalidate cache so renderVisible() always re-renders on data change
  _virt.renderVisible();

  // Prune selection to only include QSOs still in filtered view
  for (const idx of selectedIdxs) {
    if (!filtered.some(q => q.idx === idx)) selectedIdxs.delete(idx);
  }
  updateResendLabel();

  updateMap();
}

// --- Virtual scroll engine ---
const _virt = {
  ROW_HEIGHT: 26, // px — matches CSS padding + line-height
  BUFFER: 20,     // extra rows above/below viewport
  filtered: [],
  scrollEl: document.getElementById('qso-body'),
  topSpacer: null,
  botSpacer: null,
  lastStart: -1,
  lastEnd: -1,

  init() {
    // Create spacer elements
    this.topSpacer = document.createElement('tr');
    this.topSpacer.style.cssText = 'height:0;border:none;padding:0;';
    this.botSpacer = document.createElement('tr');
    this.botSpacer.style.cssText = 'height:0;border:none;padding:0;';
    this.scrollEl.addEventListener('scroll', () => this.renderVisible());
  },

  renderVisible() {
    const total = this.filtered.length;
    if (total === 0) { tbody.innerHTML = ''; return; }

    const scrollTop = this.scrollEl.scrollTop;
    const viewH = this.scrollEl.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / this.ROW_HEIGHT) - this.BUFFER);
    const end = Math.min(total, Math.ceil((scrollTop + viewH) / this.ROW_HEIGHT) + this.BUFFER);

    // Skip re-render if range unchanged
    if (start === this.lastStart && end === this.lastEnd) return;
    this.lastStart = start;
    this.lastEnd = end;

    const frag = document.createDocumentFragment();

    // Top spacer
    this.topSpacer.style.height = (start * this.ROW_HEIGHT) + 'px';
    frag.appendChild(this.topSpacer);

    // Visible rows
    for (let i = start; i < end; i++) {
      frag.appendChild(this.buildRow(this.filtered[i]));
    }

    // Bottom spacer
    this.botSpacer.style.height = ((total - end) * this.ROW_HEIGHT) + 'px';
    frag.appendChild(this.botSpacer);

    tbody.innerHTML = '';
    tbody.appendChild(frag);
  },

  buildRow(q) {
    const tr = document.createElement('tr');
    tr.dataset.idx = q.idx;
    if (selectedIdxs.has(q.idx)) tr.classList.add('selected');

    for (const c of visibleColumns()) {
      const td = document.createElement('td');
      const text = c.get(q);
      td.textContent = text;
      td.className = 'col-' + c.key;   // colour follows the column, not its position
      td.style.width = colWidth(c) + 'px';
      if (c.field) {
        td.dataset.field = c.field;
        td.classList.add('editable');
      }
      if (c.key === 'QSL') {
        td.classList.add('qsl-cell');
        td.title = (text ? text + ' — ' : '') + 'double-click to toggle paper QSL';
      }
      tr.appendChild(td);
    }

    const tdDel = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'log-delete-btn';
    btn.textContent = '\u00D7';
    btn.title = 'Delete QSO';
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);

    return tr;
  },

  // Force re-render (e.g. after selection change)
  invalidate() { this.lastStart = -1; this.lastEnd = -1; this.renderVisible(); },
};
_virt.init();

// --- Header: sort, resize, drag-to-arrange, right-click picker ---
const headRow = document.getElementById('qso-head-row');

function renderHead() {
  headRow.innerHTML = '';
  for (const c of visibleColumns()) {
    const th = document.createElement('th');
    th.textContent = c.label;
    th.dataset.key = c.key;
    th.className = 'col-' + c.key;
    th.style.width = colWidth(c) + 'px';
    if (c.title) th.title = c.title;
    if (c.sort) {
      th.dataset.sort = c.sort;
      if (sortCol === c.sort) th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
      th.addEventListener('click', (e) => {
        if (e.target.classList.contains('col-resize')) return; // dragging the edge
        if (sortCol === c.sort) sortAsc = !sortAsc;
        else { sortCol = c.sort; sortAsc = c.sort !== 'QSO_DATE'; }
        render();
      });
    }

    // Drag to arrange. Header only — rows are virtualised and keep their own
    // click/dblclick editing behaviour.
    th.draggable = true;
    th.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', c.key);
      e.dataTransfer.effectAllowed = 'move';
      th.classList.add('col-dragging');
    });
    th.addEventListener('dragend', () => th.classList.remove('col-dragging'));
    th.addEventListener('dragover', (e) => { e.preventDefault(); th.classList.add('col-drop'); });
    th.addEventListener('dragleave', () => th.classList.remove('col-drop'));
    th.addEventListener('drop', (e) => {
      e.preventDefault();
      th.classList.remove('col-drop');
      const from = e.dataTransfer.getData('text/plain');
      if (!from || from === c.key) return;
      const order = orderedColumns().map((x) => x.key);
      order.splice(order.indexOf(from), 1);
      order.splice(order.indexOf(c.key), 0, from);
      colPrefs.order = order;
      saveColPrefs();
      renderHead();
      _virt.invalidate();
    });

    // Resize grip on the trailing edge.
    const grip = document.createElement('span');
    grip.className = 'col-resize';
    grip.addEventListener('click', (e) => e.stopPropagation());
    grip.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidth(c);
      const onMove = (ev) => {
        const w = Math.max(28, Math.round(startW + (ev.clientX - startX)));
        colPrefs.widths[c.key] = w;
        th.style.width = w + 'px';
        syncTableWidth();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveColPrefs();
        _virt.invalidate();   // cells carry their own width
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    th.appendChild(grip);
    headRow.appendChild(th);
  }
  // Trailing delete-button column — not arrangeable, not hideable.
  const thDel = document.createElement('th');
  thDel.className = 'col-actions';
  headRow.appendChild(thDel);
  syncTableWidth();
}

/** table-layout is fixed, so the table needs a width of its own — otherwise
 *  the last column absorbs the slack and a resize looks like it did nothing. */
function syncTableWidth() {
  const total = visibleColumns().reduce((n, c) => n + colWidth(c), 0) + 34;
  table.style.width = total + 'px';
}

// Right-click the header for the column picker — the same gesture the Spots
// table uses, so there is one thing to learn.
const colMenu = document.getElementById('qso-col-menu');
function closeColMenu() { colMenu.classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!colMenu.contains(e.target)) closeColMenu(); });
headRow.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  colMenu.innerHTML = '';
  for (const c of orderedColumns()) {
    const row = document.createElement('label');
    row.className = 'qso-col-menu-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !isColHidden(c);
    cb.addEventListener('change', () => {
      colPrefs.hidden = colPrefs.hidden.filter((k) => k !== c.key);
      colPrefs.shown = colPrefs.shown.filter((k) => k !== c.key);
      if (cb.checked) { if (c.off) colPrefs.shown.push(c.key); }
      else if (!c.off) colPrefs.hidden.push(c.key);
      saveColPrefs();
      renderHead();
      _virt.invalidate();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + c.label));
    colMenu.appendChild(row);
  }
  const reset = document.createElement('button');
  reset.className = 'qso-col-menu-reset';
  reset.textContent = 'Reset columns';
  reset.addEventListener('click', () => {
    colPrefs = { order: [], hidden: [], shown: [], widths: {} };
    saveColPrefs();
    closeColMenu();
    renderHead();
    _virt.invalidate();
  });
  colMenu.appendChild(reset);
  colMenu.style.left = Math.min(e.clientX, window.innerWidth - 190) + 'px';
  colMenu.style.top = e.clientY + 'px';
  colMenu.classList.remove('hidden');
});

renderHead();

// --- Search ---
searchInput.addEventListener('input', () => {
  searchText = searchInput.value.trim();
  render();
});

// External search trigger — used by the ragchew log pop-out's
// "View all in Logbook →" link. Sets the search box and re-renders.
if (window.api && window.api.onSetSearch) {
  window.api.onSetSearch((q) => {
    searchInput.value = q || '';
    searchText = (q || '').trim();
    render();
    searchInput.focus();
  });
}

// --- Filter bar events ---
filterBandEl.addEventListener('change', () => { filterBand = filterBandEl.value; render(); });
filterModeEl.addEventListener('change', () => { filterMode = filterModeEl.value; render(); });
filterRegionEl.addEventListener('change', () => { filterRegion = filterRegionEl.value; render(); });
filterFromEl.addEventListener('change', () => { filterFrom = filterFromEl.value; render(); });
filterToEl.addEventListener('change', () => { filterTo = filterToEl.value; render(); });

// --- Clear filters ---
document.getElementById('qso-filter-clear').addEventListener('click', () => {
  searchInput.value = '';
  searchText = '';
  filterBandEl.value = '';
  filterBand = '';
  filterModeEl.value = '';
  filterMode = '';
  filterRegionEl.value = '';
  filterRegion = '';
  filterFromEl.value = '';
  filterFrom = '';
  filterToEl.value = '';
  filterTo = '';
  render();
});

// --- Map toggle ---
mapToggleBtn.addEventListener('click', () => {
  mapVisible = !mapVisible;
  document.body.classList.toggle('map-visible', mapVisible);
  mapToggleBtn.classList.toggle('active', mapVisible);

  if (mapVisible) {
    if (!map) initMap();
    const saved = parseInt(localStorage.getItem('pota-cat-qso-map-height'), 10);
    mapContainer.style.height = (saved || 250) + 'px';
    setTimeout(() => { map.invalidateSize(); updateMap(); }, 50);
  } else {
    mapContainer.style.height = '';
  }
});

// --- Splitter drag ---
(function setupSplitter() {
  let startY = 0, startH = 0;

  mapSplitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = mapContainer.offsetHeight;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    const delta = startY - e.clientY; // dragging up = bigger map
    const newH = Math.max(80, Math.min(window.innerHeight - 200, startH + delta));
    mapContainer.style.height = newH + 'px';
    if (map) map.invalidateSize();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    localStorage.setItem('pota-cat-qso-map-height', mapContainer.offsetHeight);
  }
})();

// --- Great circle arc (duplicated — no Node in renderer) ---
function greatCircleArc(lat1, lon1, lat2, lon2, numPoints) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const p1 = lat1 * toRad, l1 = lon1 * toRad;
  const p2 = lat2 * toRad, l2 = lon2 * toRad;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2
  ));
  if (d < 1e-10) return [[lat1, lon1]];
  const pts = [];
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg, Math.atan2(y, x) * toDeg]);
  }
  return pts;
}

function drawArc(fromLat, fromLon, toLat, toLon, color) {
  const arcPoints = greatCircleArc(fromLat, fromLon, toLat, toLon, 50);
  // Split at antimeridian discontinuities
  const segments = [[arcPoints[0]]];
  for (let i = 1; i < arcPoints.length; i++) {
    if (Math.abs(arcPoints[i][1] - arcPoints[i - 1][1]) > 180) {
      segments.push([]);
    }
    segments[segments.length - 1].push(arcPoints[i]);
  }
  const layers = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    for (const offset of [-360, 0, 360]) {
      const offsetPts = seg.map(([lat, lon]) => [lat, lon + offset]);
      layers.push(
        L.polyline(offsetPts, {
          color, weight: 1.5, opacity: 0.5, dashArray: '6,4', interactive: false,
        }).addTo(map)
      );
    }
  }
  return layers;
}

function clearHoverArcs() {
  for (const l of hoverArcs) map.removeLayer(l);
  hoverArcs = [];
}

// Determine "from" location for a QSO: park coords if activating, else home QTH
function getQsoOrigin(q) {
  const parkRef = (q.MY_SIG_INFO || '').toUpperCase();
  if (parkRef && parkLocationCache[parkRef]) {
    return parkLocationCache[parkRef];
  }
  // Fall back to home QTH
  if (homeGrid) return gridToLatLonLocal(homeGrid);
  return null;
}

// Show arcs on hover — from origin(s) to the hovered callsign's location
function showArcsForCall(call, toLat, toLon) {
  clearHoverArcs();
  const qsos = filtered.filter(q => (q.CALL || '').toUpperCase() === call);
  // Collect unique origins
  const origins = new Map(); // key -> {lat,lon}
  for (const q of qsos) {
    const origin = getQsoOrigin(q);
    if (!origin) continue;
    const key = `${origin.lat.toFixed(4)},${origin.lon.toFixed(4)}`;
    if (!origins.has(key)) origins.set(key, origin);
  }
  for (const origin of origins.values()) {
    const arcs = drawArc(origin.lat, origin.lon, toLat, toLon, '#4fc3f7');
    hoverArcs.push(...arcs);
  }
}

// --- Map initialization ---
function initMap() {
  map = L.map('qso-map', { zoomControl: true, attributionControl: false }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    className: 'dark-tiles',
    maxZoom: 18,
  }).addTo(map);

  // Home marker
  if (homeGrid) {
    const pos = gridToLatLonLocal(homeGrid);
    if (pos) {
      homeMarker = L.circleMarker([pos.lat, pos.lon], {
        radius: 6, fillColor: '#e94560', color: '#e94560', fillOpacity: 0.9, weight: 2,
      }).addTo(map).bindPopup(`Home: ${homeGrid}`);
    }
  }
}

// --- Map marker update ---
function updateMap() {
  if (!map || !mapVisible) return;

  // Clear old markers and arcs
  clearHoverArcs();
  for (const m of mapMarkers) map.removeLayer(m);
  mapMarkers = [];

  // Group filtered QSOs by callsign for popup aggregation
  const byCall = {};
  for (const q of filtered) {
    const call = (q.CALL || '').toUpperCase();
    if (!call) continue;

    // Determine lat/lon: prefer GRIDSQUARE from QSO, then cty.dat
    let lat = null, lon = null;
    if (q.GRIDSQUARE) {
      const pos = gridToLatLonLocal(q.GRIDSQUARE);
      if (pos) { lat = pos.lat; lon = pos.lon; }
    }
    if (lat == null) {
      const info = callsignInfo[call];
      if (info && info.lat != null) { lat = info.lat; lon = info.lon; }
    }
    if (lat == null) continue;

    if (!byCall[call]) byCall[call] = { lat, lon, qsos: [] };
    byCall[call].qsos.push(q);
  }

  // Create markers
  for (const [call, data] of Object.entries(byCall)) {
    const { lat, lon, qsos } = data;

    // Build popup content
    const lines = qsos.slice(0, 8).map(q => {
      const d = q.QSO_DATE ? q.QSO_DATE.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '';
      const parts = [d, q.FREQ ? q.FREQ + ' MHz' : '', q.MODE || '', q.SIG_INFO || ''].filter(Boolean);
      return parts.join(' &middot; ');
    });
    if (qsos.length > 8) lines.push(`... +${qsos.length - 8} more`);
    const popup = `<b>${call}</b> (${qsos.length} QSO${qsos.length > 1 ? 's' : ''})<br>${lines.join('<br>')}`;

    // World wrapping offsets
    for (const offset of [-360, 0, 360]) {
      const marker = L.circleMarker([lat, lon + offset], {
        radius: 5, fillColor: accentGreen, color: accentGreen, fillOpacity: 0.8, weight: 1,
      }).bindPopup(popup);
      marker.on('mouseover', () => showArcsForCall(call, lat, lon));
      marker.on('mouseout', () => clearHoverArcs());
      marker.addTo(map);
      mapMarkers.push(marker);
    }
  }
}

// --- Paper QSL toggle (dblclick on the QSL cell) ---
tbody.addEventListener('dblclick', async (e) => {
  const td = e.target.closest('td.qsl-cell');
  if (!td) return;
  const tr = td.closest('tr');
  const idx = parseInt(tr.dataset.idx, 10);
  const qso = allQsos.find(q => q.idx === idx);
  if (!qso) return;
  const nowReceived = String(qso.QSL_RCVD || '').toUpperCase() !== 'Y';
  const fields = { QSL_RCVD: nowReceived ? 'Y' : '' };
  // QSLRDATE rides along like LOTW_QSLSDATE does — blanked when untoggled.
  fields.QSLRDATE = nowReceived ? new Date().toISOString().slice(0, 10).replace(/-/g, '') : '';
  const result = await window.api.updateQso({ idx, fields });
  if (result.success) {
    Object.assign(qso, fields);
    render();
    toast(nowReceived ? `Paper QSL received from ${qso.CALL}` : `Paper QSL cleared for ${qso.CALL}`);
  } else {
    toast('Update failed: ' + (result.error || 'unknown error'));
  }
});

// --- Inline edit (dblclick) ---
tbody.addEventListener('dblclick', (e) => {
  const td = e.target.closest('td.editable');
  if (!td || td.querySelector('input')) return;
  const tr = td.closest('tr');
  const idx = parseInt(tr.dataset.idx, 10);
  const field = td.dataset.field;
  const original = td.textContent;

  const input = document.createElement('input');
  if (field === 'QSO_DATE') {
    input.type = 'date';
    input.value = original; // already YYYY-MM-DD display format
  } else if (field === 'TIME_ON') {
    input.type = 'time';
    input.value = original; // already HH:MM display format
  } else {
    input.type = 'text';
    input.value = original;
  }
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  if (input.type === 'text') input.select();

  function cancel() { td.textContent = original; }

  async function save() {
    let newVal = input.value.trim();
    if (newVal === original) { cancel(); return; }

    // Convert display formats back to storage formats
    if (field === 'QSO_DATE') newVal = newVal.replace(/-/g, ''); // YYYY-MM-DD -> YYYYMMDD
    if (field === 'TIME_ON') newVal = newVal.replace(/:/g, '') + '00'; // HH:MM -> HHMM00

    // AG5B: pasting "US-1595, US-4567, US-4581, US-4582" into the SIG_INFO
    // cell is a request to split a 1-park QSO into the N-fer it actually
    // was. POTA needs separate records to credit each park. Offer the
    // split; on No, save the comma list as-is (legacy behavior).
    if (field === 'SIG_INFO' && newVal.includes(',')) {
      const refs = newVal.split(',').map(r => r.trim().toUpperCase()).filter(Boolean);
      if (refs.length >= 2) {
        const ok = confirm(
          `Split this QSO into ${refs.length} POTA records?\n\n` +
          refs.map(r => `  • ${r}`).join('\n') +
          '\n\nOK = create ' + (refs.length - 1) + ' additional QSO row' +
          (refs.length - 1 === 1 ? '' : 's') + '.\nCancel = save as a single row.'
        );
        if (ok) {
          const result = await window.api.expandQsoMultipark({ idx, refs });
          if (result.success) {
            allQsos = await window.api.getAllQsos();
            render();
            toast(`Split into ${refs.length} QSOs`);
          } else {
            cancel();
            toast('Split failed: ' + (result.error || 'unknown error'));
          }
          return;
        }
        // User chose "save as single row" — fall through and write the
        // raw comma string. Uppercase the input for consistency.
        newVal = refs.join(',');
      }
    }

    const fields = { [field]: newVal };
    if (field === 'FREQ') fields.BAND = freqMhzToBandLocal(newVal);

    const result = await window.api.updateQso({ idx, fields });
    if (result.success) {
      const qso = allQsos.find(q => q.idx === idx);
      if (qso) Object.assign(qso, fields);
      render();
      toast(`Updated ${qso ? qso.CALL : 'QSO'}`);
    } else {
      cancel();
      toast('Update failed: ' + (result.error || 'unknown error'));
    }
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', save);
});

// --- Row selection (click / ctrl+click / shift+click) ---
tbody.addEventListener('click', (e) => {
  // Skip clicks on delete buttons, editable inputs, or inline-edit cells being edited
  if (e.target.closest('.log-delete-btn') || e.target.closest('input')) return;
  const tr = e.target.closest('tr');
  if (!tr || tr.dataset.idx == null) return;
  const idx = parseInt(tr.dataset.idx, 10);

  if (e.ctrlKey || e.metaKey) {
    // Toggle single row
    if (selectedIdxs.has(idx)) { selectedIdxs.delete(idx); tr.classList.remove('selected'); }
    else { selectedIdxs.add(idx); tr.classList.add('selected'); }
    lastClickedIdx = idx;
  } else if (e.shiftKey && lastClickedIdx != null) {
    // Range select from lastClickedIdx to this row
    const idxList = filtered.map(q => q.idx);
    const from = idxList.indexOf(lastClickedIdx);
    const to = idxList.indexOf(idx);
    if (from !== -1 && to !== -1) {
      const lo = Math.min(from, to), hi = Math.max(from, to);
      selectedIdxs.clear();
      for (let i = lo; i <= hi; i++) selectedIdxs.add(idxList[i]);
      tbody.querySelectorAll('tr').forEach(r => {
        const rIdx = parseInt(r.dataset.idx, 10);
        r.classList.toggle('selected', selectedIdxs.has(rIdx));
      });
    }
  } else {
    // Single select (clear others)
    selectedIdxs.clear();
    selectedIdxs.add(idx);
    tbody.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
    tr.classList.add('selected');
    lastClickedIdx = idx;
  }
  updateResendLabel();
});

// --- Delete (two-click) ---
tbody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.log-delete-btn');
  if (!btn) return;

  if (btn.classList.contains('confirming')) {
    const tr = btn.closest('tr');
    const idx = parseInt(tr.dataset.idx, 10);
    const qso = allQsos.find(q => q.idx === idx);
    const call = qso ? qso.CALL : '?';

    const result = await window.api.deleteQso(idx);
    if (result.success) {
      allQsos = allQsos.filter(q => q.idx !== idx);
      // Re-index to match the rewritten file
      allQsos.forEach((q, i) => { q.idx = i; });
      render();
      toast(`Deleted QSO with ${call}`);
    } else {
      toast('Delete failed: ' + (result.error || 'unknown error'));
    }
  } else {
    btn.classList.add('confirming');
    btn.textContent = 'Sure?';
    setTimeout(() => {
      btn.classList.remove('confirming');
      btn.textContent = '\u00D7';
    }, 3000);
  }
});

// --- New QSO form ---
const newQsoBtn = document.getElementById('qso-new');
const newQsoForm = document.getElementById('qso-new-form');
const newQsoCall = document.getElementById('qso-new-call');
const newQsoFreq = document.getElementById('qso-new-freq');
const newQsoMode = document.getElementById('qso-new-mode');
const newQsoRstS = document.getElementById('qso-new-rst-s');
const newQsoRstR = document.getElementById('qso-new-rst-r');
const newQsoComment = document.getElementById('qso-new-comment');
const newQsoTypeChips = document.getElementById('qso-new-type-chips');
const newQsoRef = document.getElementById('qso-new-ref');
const newQsoRespotLabel = document.getElementById('qso-new-respot-label');
const newQsoRespot = document.getElementById('qso-new-respot');
const newQsoRespotHint = document.getElementById('qso-new-respot-hint');

// Per-type ref placeholder + which programs have a respot endpoint.
// Respot is hidden for SOTA/Tiles/DX (no public spot-submit API today —
// SOTAwatch requires a registered spotter account, Tiles back-end is
// activator-only, DX cluster respots go through a different flow).
const NEW_QSO_TYPE_META = {
  dx:    { placeholder: '',                   canRespot: false, respotHint: '' },
  pota:  { placeholder: 'e.g. US-1234',       canRespot: true,  respotHint: '' },
  sota:  { placeholder: 'e.g. W6/CT-001',     canRespot: false, respotHint: 'SOTA respot needs a registered spotter — submit on sotawatch.org' },
  wwff:  { placeholder: 'e.g. KFF-1234',      canRespot: true,  respotHint: '' },
  llota: { placeholder: 'e.g. US-0001',       canRespot: true,  respotHint: '' },
  tiles: { placeholder: 'Maidenhead grid',    canRespot: false, respotHint: 'Tiles spot-submit API not yet available' },
};
let newQsoSelectedType = 'dx';

function updateNewQsoTypeUI() {
  const meta = NEW_QSO_TYPE_META[newQsoSelectedType] || NEW_QSO_TYPE_META.dx;
  // Ref input shown for any non-DX type
  if (newQsoSelectedType === 'dx') {
    newQsoRef.classList.add('hidden');
    newQsoRef.value = '';
  } else {
    newQsoRef.classList.remove('hidden');
    newQsoRef.placeholder = meta.placeholder;
  }
  // Respot UI visibility — only meaningful for programs we can actually
  // submit spots to. Default-checked stays sticky across type switches
  // so toggling DX→POTA→DX→POTA doesn't keep resetting it.
  if (meta.canRespot) {
    newQsoRespotLabel.classList.remove('hidden');
    newQsoRespotHint.classList.add('hidden');
  } else if (newQsoSelectedType !== 'dx') {
    newQsoRespotLabel.classList.add('hidden');
    if (meta.respotHint) {
      newQsoRespotHint.textContent = meta.respotHint;
      newQsoRespotHint.classList.remove('hidden');
    } else {
      newQsoRespotHint.classList.add('hidden');
    }
  } else {
    newQsoRespotLabel.classList.add('hidden');
    newQsoRespotHint.classList.add('hidden');
  }
  // Update chip active state
  for (const chip of newQsoTypeChips.querySelectorAll('.qnt-chip')) {
    chip.classList.toggle('active', chip.dataset.type === newQsoSelectedType);
  }
}

newQsoTypeChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.qnt-chip');
  if (!chip) return;
  newQsoSelectedType = chip.dataset.type;
  updateNewQsoTypeUI();
  // Move focus into the ref input when a program type is picked so the
  // operator can keep typing without grabbing the mouse.
  if (newQsoSelectedType !== 'dx') newQsoRef.focus();
});

// Live rig frequency in kHz. Pushed by main on every cat-frequency
// update (sendCatFrequency in main.js). Used to auto-fill the Freq
// field on "+ New QSO" — N4DWJ 2026-06-09 ("cruising frequencies
// looking for DX contacts, one less field to type per QSO").
let _currentRigFreqKhz = null;
if (window.api.onCatFrequency) {
  window.api.onCatFrequency((hz) => {
    if (typeof hz === 'number' && hz > 0) {
      _currentRigFreqKhz = Math.round(hz / 1000);
    }
  });
}

newQsoBtn.addEventListener('click', () => {
  newQsoForm.classList.toggle('hidden');
  if (!newQsoForm.classList.contains('hidden')) {
    updateNewQsoTypeUI();
    // Auto-fill freq with the rig's current frequency unless the user
    // already typed something (manual edit wins). Only fires when we
    // actually have a frequency cached — opening the form before the
    // rig connects leaves the field empty to type into.
    if (_currentRigFreqKhz && !newQsoFreq.value.trim()) {
      newQsoFreq.value = String(_currentRigFreqKhz);
    }
    newQsoCall.focus();
  }
});

document.getElementById('qso-new-cancel').addEventListener('click', () => {
  newQsoForm.classList.add('hidden');
});

document.getElementById('qso-new-save').addEventListener('click', async () => {
  const call = newQsoCall.value.trim().toUpperCase();
  if (!call) { newQsoCall.focus(); return; }
  const now = new Date();
  const qsoDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeOn = now.toISOString().slice(11, 16).replace(/:/g, '');
  const freqKhz = newQsoFreq.value.trim();
  const mode = newQsoMode.value;
  const ref = newQsoRef.value.trim().toUpperCase();
  const type = newQsoSelectedType;
  const respotChecked = newQsoRespot && newQsoRespot.checked;

  const qsoData = {
    callsign: call,
    frequency: freqKhz,
    mode,
    qsoDate,
    timeOn,
    rstSent: newQsoRstS.value.trim() || '59',
    rstRcvd: newQsoRstR.value.trim() || '59',
    comment: newQsoComment.value.trim(),
  };
  // Map the type chip + ref to the ADIF SIG/SIG_INFO + the per-program
  // respot fields saveQsoRecord() understands. POTA uses the canonical
  // sig/sigInfo path (sig:'POTA' + qsoData.respot triggers postPotaRespot).
  // WWFF/LLOTA/Tiles are tracked as their own SIG and have separate
  // <type>Respot / <type>Reference fields — see main.js:saveQsoRecord.
  if (ref) {
    if (type === 'pota') {
      qsoData.sig = 'POTA';
      qsoData.sigInfo = ref;
      qsoData.respot = !!respotChecked;
    } else if (type === 'sota') {
      qsoData.sig = 'SOTA';
      qsoData.sigInfo = ref;
    } else if (type === 'wwff') {
      qsoData.sig = 'WWFF';
      qsoData.sigInfo = ref;
      qsoData.wwffReference = ref;
      qsoData.wwffRespot = !!respotChecked;
    } else if (type === 'llota') {
      qsoData.sig = 'LLOTA';
      qsoData.sigInfo = ref;
      qsoData.llotaReference = ref;
      qsoData.llotaRespot = !!respotChecked;
    } else if (type === 'tiles') {
      qsoData.sig = 'TILES';
      qsoData.sigInfo = ref; // grid square is the activation reference
    }
  }
  // Get station callsign from settings
  const s = await window.api.getSettings();
  if (s.myCallsign) qsoData.stationCallsign = s.myCallsign.toUpperCase();
  if (s.grid) qsoData.myGridsquare = s.grid;

  const result = await window.api.saveQso(qsoData);

  // Clear form and refresh
  newQsoCall.value = '';
  newQsoFreq.value = '';
  newQsoRstS.value = '59';
  newQsoRstR.value = '59';
  newQsoRef.value = '';
  newQsoComment.value = '';
  newQsoSelectedType = 'dx';
  updateNewQsoTypeUI();
  newQsoForm.classList.add('hidden');

  // Reload QSOs
  allQsos = await window.api.getAllQsos();
  allQsos.forEach((q, i) => { q.idx = i; });
  render();
  // Surface respot errors via the toast so the user knows the QSO was
  // saved but the spot didn't post (rate limit, network, etc.).
  if (result && (result.respotError || result.wwffRespotError || result.llotaRespotError)) {
    const which = result.respotError ? 'POTA' : result.wwffRespotError ? 'WWFF' : 'LLOTA';
    showToast(`QSO logged — ${which} respot failed: ${result.respotError || result.wwffRespotError || result.llotaRespotError}`);
  } else {
    showToast('QSO logged: ' + call);
  }
});

// Enter key in callsign field submits
newQsoCall.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('qso-new-save').click();
});

// --- Import ADIF ---
document.getElementById('qso-import').addEventListener('click', async () => {
  try {
    const result = await window.api.importAdif();
    if (!result) return; // cancelled
    if (result.success) {
      allQsos = await window.api.getAllQsos();
      await resolveAllCallsigns();
      await resolveAllParkLocations();
      render();
      toast(`Imported ${result.imported} QSOs (${result.unique} calls)`);
    } else {
      toast('Import failed: ' + (result.error || 'unknown error'));
    }
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
});

// --- Export ADIF ---
document.getElementById('qso-export').addEventListener('click', async () => {
  if (!filtered.length) { toast('No QSOs to export'); return; }
  try {
    const result = await window.api.exportAdif(filtered);
    if (!result) return;
    if (result.success) {
      const name = result.filePath.split(/[/\\]/).pop();
      toast(`Exported ${result.count} QSOs to ${name}`);
    } else {
      toast('Export failed: ' + (result.error || 'unknown error'));
    }
  } catch (err) {
    toast('Export failed: ' + err.message);
  }
});

// --- Resend to Logbook ---
document.getElementById('qso-resend').addEventListener('click', async () => {
  // If rows are selected, resend only those; otherwise resend all filtered
  const toSend = selectedIdxs.size > 0
    ? filtered.filter(q => selectedIdxs.has(q.idx))
    : filtered;
  if (!toSend.length) { toast('No QSOs to resend'); return; }
  const label = selectedIdxs.size > 0
    ? `${toSend.length} selected QSO${toSend.length === 1 ? '' : 's'}`
    : hasActiveFilters() ? `${toSend.length} filtered QSOs` : `all ${toSend.length} QSOs`;
  if (!confirm(`Resend ${label} to configured logbook?`)) return;
  try {
    const result = await window.api.resendQsosToLogbook(toSend);
    if (result.success) {
      toast(`Sent ${result.sent} of ${result.total} QSOs to logbook`);
      clearSelection();
    } else {
      toast('Resend failed: ' + (result.error || 'unknown error'));
    }
  } catch (err) {
    toast('Resend failed: ' + err.message);
  }
});

// --- Titlebar ---
(function setupTitlebar() {
  if (window.api.platform === 'darwin') {
    document.body.classList.add('platform-darwin');
  }
  document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('tb-close').addEventListener('click', () => window.api.close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (selectedIdxs.size > 0) { clearSelection(); return; }
      window.api.close();
    }
    // Ctrl+A: select all visible rows (if not typing in search)
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement !== searchInput) {
      e.preventDefault();
      selectedIdxs.clear();
      for (const q of filtered) selectedIdxs.add(q.idx);
      tbody.querySelectorAll('tr').forEach(r => r.classList.add('selected'));
      updateResendLabel();
    }
  });
})();

// --- Real-time listeners ---
window.api.onQsoAdded(async (qso) => {
  allQsos = await window.api.getAllQsos();
  // Resolve new callsign if needed
  const call = (qso.CALL || '').toUpperCase();
  if (call && !callsignInfo[call]) {
    const info = await window.api.resolveCallsignLocations([call]);
    if (info[call]) callsignInfo[call] = info[call];
  }
  // Resolve park location if activating
  const parkRef = (qso.MY_SIG_INFO || '').toUpperCase();
  if (parkRef && !parkLocationCache[parkRef]) {
    try {
      const park = await window.api.getPark(parkRef);
      if (park && park.latitude && park.longitude) {
        parkLocationCache[parkRef] = { lat: parseFloat(park.latitude), lon: parseFloat(park.longitude) };
      }
    } catch (_) { /* park not found */ }
  }
  render();
  toast(`Logged ${qso.CALL || 'QSO'}`);
});

window.api.onQsoUpdated(async ({ idx, fields }) => {
  const qso = allQsos.find(q => q.idx === idx);
  if (qso) {
    Object.assign(qso, fields);
    render();
  }
});

window.api.onQsoDeleted(async () => {
  allQsos = await window.api.getAllQsos();
  render();
});

window.api.onRefresh(async () => {
  allQsos = await window.api.getAllQsos();
  await resolveAllCallsigns();
  await resolveAllParkLocations();
  render();
});

// --- Theme ---
window.api.onTheme((theme) => {
  _applyPopoutTheme(theme);
});

window.api.onColorblindMode((enabled) => {
  accentGreen = enabled ? '#4fc3f7' : '#4ecca3';
});

// --- Log path ---
async function showLogPath() {
  const settings = await window.api.getSettings();
  const logPath = settings.adifLogPath || await window.api.getDefaultLogPath();
  const pathName = logPath.split(/[/\\]/).pop();
  const link = document.getElementById('qso-path-link');
  link.textContent = pathName;
  link.onclick = (e) => { e.preventDefault(); window.api.openExternal('file://' + logPath); };
  document.getElementById('qso-path-wrap').title = logPath;
}

// --- Resolve callsigns for region filter + map ---
async function resolveAllCallsigns() {
  const calls = [...new Set(allQsos.map(q => (q.CALL || '').toUpperCase()).filter(Boolean))];
  if (!calls.length) return;
  callsignInfo = await window.api.resolveCallsignLocations(calls);
}

// --- Resolve park locations for arc origins ---
async function resolveAllParkLocations() {
  const refs = [...new Set(
    allQsos.map(q => (q.MY_SIG_INFO || '').toUpperCase()).filter(Boolean)
  )];
  for (const ref of refs) {
    if (parkLocationCache[ref]) continue;
    try {
      const park = await window.api.getPark(ref);
      if (park && park.latitude && park.longitude) {
        parkLocationCache[ref] = { lat: parseFloat(park.latitude), lon: parseFloat(park.longitude) };
      }
    } catch (_) { /* park not found */ }
  }
}

// --- Initial load ---
(async function init() {
  const settings = await window.api.getSettings();
  _applyPopoutTheme({
    theme: settings.lightMode ? 'light' : 'dark',
    variant: settings.darkVariant || 'navy',
  });
  if (settings.colorblindMode) accentGreen = '#4fc3f7';
  homeGrid = settings.grid || '';

  allQsos = await window.api.getAllQsos();
  await resolveAllCallsigns();
  await resolveAllParkLocations();
  render();
  showLogPath();
})();

// ── Zoom (Ctrl+= / Ctrl+- / Ctrl+0, plus Ctrl+wheel) ───────────────────────
// Matches the main window's font scaling (Ctrl+ +/-). By default the Logbook
// inherits the main window's zoom — its "table view font size" — so the two
// stay in sync. The first time the user zooms *here*, we record an override
// under OWN_KEY and the Logbook remembers its own size across close/reopen.
// Ctrl+0 clears the override and re-syncs to the main window.
//
// localStorage is shared across the app's file:// windows, so reading the
// main window's MAIN_KEY ('pota-cat-zoom', written by renderer/app.js) gives
// us its current zoom; we never write that key from here.
(function () {
  const OWN_KEY = 'potacat-qso-popout-zoom';   // popout's remembered override
  const MAIN_KEY = 'pota-cat-zoom';            // main window's zoom (read-only)
  const ZOOM_MIN = 0.6, ZOOM_MAX = 2.0, ZOOM_STEP = 0.1;
  const clamp = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

  // Main window's current zoom, or 1 if it has never been zoomed.
  function mainZoom() {
    const m = parseFloat(localStorage.getItem(MAIN_KEY));
    return isFinite(m) ? clamp(m) : 1;
  }
  // Apply + persist as an explicit popout override.
  function setZoom(z) {
    const clamped = clamp(z);
    window.api.setZoom(clamped);
    try { localStorage.setItem(OWN_KEY, clamped.toFixed(2)); } catch {}
  }

  // Restore on open: own override if set, otherwise follow the main window.
  try {
    const own = parseFloat(localStorage.getItem(OWN_KEY));
    window.api.setZoom(isFinite(own) ? clamp(own) : mainZoom());
  } catch { window.api.setZoom(mainZoom()); }

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      setZoom((window.api.getZoom() || 1) + ZOOM_STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom((window.api.getZoom() || 1) - ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      // Reset = drop the override and snap back to the main window's size.
      try { localStorage.removeItem(OWN_KEY); } catch {}
      window.api.setZoom(mainZoom());
    }
  });

  // Ctrl+wheel zoom — matches every browser convention.
  document.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    setZoom((window.api.getZoom() || 1) + dir * ZOOM_STEP);
  }, { passive: false });
})();
