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

// --- Editable columns ---
const EDITABLE = {
  2: 'CALL', 3: 'FREQ', 4: 'MODE',
  6: 'RST_SENT', 7: 'RST_RCVD', 8: 'SIG_INFO', 9: 'COMMENT',
};

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

    const date = q.QSO_DATE ? q.QSO_DATE.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '';
    const time = q.TIME_ON ? q.TIME_ON.slice(0, 2) + ':' + q.TIME_ON.slice(2, 4) : '';

    const cells = [
      date, time, q.CALL || '', q.FREQ || '', q.MODE || '',
      q.BAND || '', q.RST_SENT || '', q.RST_RCVD || '',
      q.SIG_INFO || '', q.COMMENT || '',
    ];

    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td');
      td.textContent = cells[i];
      if (EDITABLE[i]) {
        td.dataset.field = EDITABLE[i];
        td.classList.add('editable');
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

// --- Column sorting ---
table.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortCol === col) sortAsc = !sortAsc;
    else { sortCol = col; sortAsc = col !== 'QSO_DATE'; }
    render();
  });
});

// --- Search ---
searchInput.addEventListener('input', () => {
  searchText = searchInput.value.trim();
  render();
});

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
  const origins = new Map(); // key → {lat,lon}
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

// --- Inline edit (dblclick) ---
tbody.addEventListener('dblclick', (e) => {
  const td = e.target.closest('td.editable');
  if (!td || td.querySelector('input')) return;
  const tr = td.closest('tr');
  const idx = parseInt(tr.dataset.idx, 10);
  const field = td.dataset.field;
  const original = td.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  function cancel() { td.textContent = original; }

  async function save() {
    const newVal = input.value.trim();
    if (newVal === original) { cancel(); return; }

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
const newQsoPark = document.getElementById('qso-new-park');
const newQsoComment = document.getElementById('qso-new-comment');

newQsoBtn.addEventListener('click', () => {
  newQsoForm.classList.toggle('hidden');
  if (!newQsoForm.classList.contains('hidden')) newQsoCall.focus();
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
  const freqMhz = freqKhz ? (parseFloat(freqKhz) / 1000).toFixed(6) : '';
  const mode = newQsoMode.value;
  const park = newQsoPark.value.trim().toUpperCase();

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
  if (park) {
    qsoData.sig = 'POTA';
    qsoData.sigInfo = park;
  }
  // Get station callsign from settings
  const s = await window.api.getSettings();
  if (s.myCallsign) qsoData.stationCallsign = s.myCallsign.toUpperCase();
  if (s.grid) qsoData.myGridsquare = s.grid;

  await window.api.saveQso(qsoData);

  // Clear form and refresh
  newQsoCall.value = '';
  newQsoFreq.value = '';
  newQsoRstS.value = '59';
  newQsoRstR.value = '59';
  newQsoPark.value = '';
  newQsoComment.value = '';
  newQsoForm.classList.add('hidden');

  // Reload QSOs
  allQsos = await window.api.getAllQsos();
  allQsos.forEach((q, i) => { q.idx = i; });
  render();
  showToast('QSO logged: ' + call);
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
  document.documentElement.setAttribute('data-theme', theme);
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
  if (settings.lightMode) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
  if (settings.colorblindMode) accentGreen = '#4fc3f7';
  homeGrid = settings.grid || '';

  allQsos = await window.api.getAllQsos();
  await resolveAllCallsigns();
  await resolveAllParkLocations();
  render();
  showLogPath();
})();
