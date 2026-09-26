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
/* actmap-popout.js — Activation window: map of the park + logged contacts,
   the activation log beside it, and Save / Copy image of the map.
   NO4D 2026-09-25: "Is there a way to see the activation log while in FT8?
   ... is there a way to export the map of an activation?" */

let accentGreen = '#4ecca3'; // updated by colorblind mode

// --- Titlebar ---
if (window.api.platform === 'darwin') {
  document.body.classList.add('platform-darwin');
} else {
  document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('tb-close').addEventListener('click', () => window.api.close());
}

// --- Helpers ---

function greatCircleArc(lat1, lon1, lat2, lon2, numPoints) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const p1 = lat1 * toRad, l1 = lon1 * toRad;
  const p2 = lat2 * toRad, l2 = lon2 * toRad;
  const d = Math.acos(
    Math.min(1, Math.max(-1,
      Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(l2 - l1)
    ))
  );
  if (d < 1e-10) return [[lat1, lon1], [lat2, lon2]];
  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    points.push([
      Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg,
      Math.atan2(y, x) * toDeg,
    ]);
  }
  return points;
}

function wrapLon(refLon, lon) {
  let best = lon, bestDist = Math.abs(lon - refLon);
  for (const offset of [-360, 360]) {
    const wrapped = lon + offset;
    if (Math.abs(wrapped - refLon) < bestDist) {
      best = wrapped;
      bestDist = Math.abs(wrapped - refLon);
    }
  }
  return best;
}

function drawArc(map, lat1, lon1, lat2, lon2) {
  const arcPoints = greatCircleArc(lat1, lon1, lat2, lon2, 50);
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
    layers.push(
      L.polyline(seg, {
        color: '#4fc3f7', weight: 1.5, opacity: 0.5, dashArray: '6,4', interactive: false,
      }).addTo(map)
    );
  }
  return layers;
}

function gridToLatLon(grid) {
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

// --- State ---

let map = null;
let parkMarker = null;
let parkLat = null, parkLon = null;
let contactMarkers = []; // { marker, arcs[] }
let usedPositions = [];
let contactCount = 0;
const counterEl = document.getElementById('qso-counter');
let contacts = [];                 // the activation's contacts, in log order
let parkInfo = { refs: [], name: '', locationDesc: '', program: 'POTA', startedAt: 0 };
let myCallsign = '';
const POTA_VALID_QSOS = 10;

let _pendingData = null;
let _pendingContacts = [];

// --- Map Init ---

function initMap(centerLat, centerLon, zoom) {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([centerLat || 39.8, centerLon || -98.5], zoom || 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
    className: 'dark-tiles',
  }).addTo(map);
}

// --- Park Marker ---

function setParkMarker(lat, lon, ref, count) {
  if (parkMarker) map.removeLayer(parkMarker);
  parkLat = lat;
  parkLon = lon;
  const parkIcon = L.divIcon({
    className: '',
    html: `<div style="background:${accentGreen};width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 6px rgba(78,204,163,0.6);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  parkMarker = L.marker([lat, lon], { icon: parkIcon, zIndexOffset: 1000 })
    .bindPopup(`<b>${ref}</b><br>${count} contact${count !== 1 ? 's' : ''}`)
    .addTo(map);
}

// --- Contact Marker ---

function addContactMarker(callsign, lat, lon, timeUtc, freqDisplay, mode, name) {
  // Wrap longitude relative to park to avoid antimeridian zoom-out
  const refLon = parkLon ?? -98.5;
  // Jitter: golden angle distribution for overlapping cty.dat positions
  let cLat = lat, cLon = wrapLon(refLon, lon);
  const overlap = usedPositions.filter(p => Math.abs(p[0] - lat) < 0.01 && Math.abs(p[1] - lon) < 0.01).length;
  if (overlap > 0) {
    const angle = (overlap * 137.5) * Math.PI / 180;
    const r = 0.8 + overlap * 0.3;
    cLat += r * Math.cos(angle);
    cLon += r * Math.sin(angle);
  }
  usedPositions.push([lat, lon]);

  const fMhz = freqDisplay || '';
  const popupHtml = `<b>${callsign}</b>${name ? ' — ' + name : ''}<br>${timeUtc || ''} UTC  ${fMhz} ${mode || ''}<br><span style="color:#aaa">${''}</span>`;
  const marker = L.circleMarker([cLat, cLon], {
    radius: 6, fillColor: '#4fc3f7', color: '#fff', weight: 1, fillOpacity: 0.85,
  }).bindPopup(popupHtml).addTo(map);

  let arcs = [];
  if (parkLat != null && parkLon != null) {
    arcs = drawArc(map, parkLat, parkLon, cLat, cLon);
  }
  contactMarkers.push({ callsign, marker, arcs });
}

// --- Update Counter ---

function updateCounter() {
  contactCount = contacts.length;
  const valid = contactCount >= POTA_VALID_QSOS;
  counterEl.textContent = valid
    ? `${contactCount} QSOs`
    : `${contactCount} / ${POTA_VALID_QSOS} QSOs`;
  counterEl.classList.toggle('valid', valid);
}

// --- Log ---

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLog() {
  const body = document.getElementById('act-log-body');
  const empty = document.getElementById('act-log-empty');
  if (!body) return;
  const rows = [];
  for (let i = contacts.length - 1; i >= 0; i--) {   // newest on top, like the main log
    const c = contacts[i] || {};
    const p2p = Array.isArray(c.theirParks) && c.theirParks.length
      ? `<span class="p2p" title="Park to park: ${esc(c.theirParks.join(', '))}">P2P</span>` : '';
    rows.push(`<tr>
      <td class="num">${i + 1}</td>
      <td class="time">${esc(c.timeUtc)}</td>
      <td class="call" title="${esc(c.name || '')}">${esc(c.callsign)}${p2p}</td>
      <td>${esc(c.band || c.freqDisplay)}</td>
      <td>${esc(c.mode)}</td>
      <td>${esc(c.rstSent)}</td>
      <td>${esc(c.rstRcvd)}</td>
      <td>${esc(c.state)}</td>
    </tr>`);
  }
  body.innerHTML = rows.join('');
  if (empty) empty.style.display = contacts.length ? 'none' : '';
  updateCounter();
}

function renderPark() {
  const el = document.getElementById('act-park');
  if (!el) return;
  const refs = parkInfo.refs.join(', ');
  el.textContent = refs ? (parkInfo.name ? `${refs} — ${parkInfo.name}` : refs) : 'No activation';
  el.title = el.textContent;
}

// --- View: Map / Both / Log ---

const VIEW_KEY = 'potacat-actmap-view';
function setView(view) {
  const v = ['map', 'both', 'log'].includes(view) ? view : 'both';
  document.body.dataset.view = v;
  document.querySelectorAll('.act-seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
  if (map) setTimeout(() => map.invalidateSize(), 0);
}
document.querySelectorAll('.act-seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
let _savedView = 'both';
try { _savedView = localStorage.getItem(VIEW_KEY) || 'both'; } catch {}
setView(_savedView);

// --- Save / Copy the shareable image ---
// Main renders it off-screen at an exact social size (renderer/actmap-share.html);
// this window only supplies the facts and the plotted positions.

const FORMAT_KEY = 'potacat-actmap-share-format';
const formatSel = document.getElementById('act-format');
try { const f = localStorage.getItem(FORMAT_KEY); if (f && formatSel) formatSel.value = f; } catch {}
if (formatSel) formatSel.addEventListener('change', () => { try { localStorage.setItem(FORMAT_KEY, formatSel.value); } catch {} });

function bandOrder(b) { const m = String(b).match(/^(\d+(?:\.\d+)?)(c?m)$/i); return m ? -(parseFloat(m[1]) * (m[2].toLowerCase() === 'cm' ? 0.01 : 1)) : 0; }

function shareData() {
  const utcDate = new Date(parkInfo.startedAt || Date.now()).toISOString().slice(0, 10);
  const bands = [...new Set(contacts.map((c) => c.band).filter(Boolean))].sort((x, y) => bandOrder(x) - bandOrder(y));
  const modes = [...new Set(contacts.map((c) => String(c.mode || '').toUpperCase()).filter(Boolean))];
  const p2p = contacts.filter((c) => Array.isArray(c.theirParks) && c.theirParks.length).length;
  const states = new Set(contacts.map((c) => String(c.state || '').toUpperCase()).filter(Boolean)).size;
  return {
    format: formatSel ? formatSel.value : 'post',
    callsign: myCallsign,
    program: parkInfo.program,
    parkRefs: parkInfo.refs,
    parkName: parkInfo.name,
    locationDesc: parkInfo.locationDesc,
    date: utcDate,
    qsos: contacts.length,
    p2p,
    states: states >= 2 ? states : 0,
    bands,
    modes,
    park: parkLat != null ? { lat: parkLat, lon: parkLon } : null,
    points: contactMarkers.map((m) => { const ll = m.marker.getLatLng(); return { lat: ll.lat, lon: ll.lng }; }),
  };
}

async function exportImage(action) {
  const status = document.getElementById('act-status');
  const share = shareData();
  const file = [share.callsign, share.parkRefs.join('+'), share.date, share.format].filter(Boolean).join('_').replace(/[^A-Za-z0-9_+.-]/g, '-') + '.png';
  if (status) status.textContent = 'Rendering image…';
  try {
    const r = await window.api.saveActivationImage({ action, filename: file, share });
    if (status) {
      status.textContent = r && r.ok ? (action === 'copy' ? 'Image copied to the clipboard' : `Saved ${r.path}`)
        : (r && r.cancelled ? '' : 'Could not create the image' + (r && r.error ? ': ' + r.error : ''));
      status.title = status.textContent;
    }
  } catch (err) {
    if (status) status.textContent = 'Could not create the image';
  }
}
document.getElementById('act-save').addEventListener('click', () => exportImage('save'));
document.getElementById('act-copy').addEventListener('click', () => exportImage('copy'));

// --- Full State Push ---

async function handleActivationData(data) {
  // A log-only refresh (an edit or delete in the main window) changes the
  // table and counter and leaves the map's view alone.
  contacts = Array.isArray(data.contacts) ? data.contacts.slice() : [];
  parkInfo.refs = data.parkRefs || [];
  if (data.program) parkInfo.program = data.program;
  if (data.startedAt) parkInfo.startedAt = data.startedAt;
  renderPark();
  renderLog();
  if (data.logOnly) return;
  // Clear existing markers
  for (const cm of contactMarkers) {
    map.removeLayer(cm.marker);
    for (const a of cm.arcs) map.removeLayer(a);
  }
  contactMarkers = [];
  usedPositions = [];
  if (parkMarker) { map.removeLayer(parkMarker); parkMarker = null; }

  const parkRefs = data.parkRefs || [];

  // Resolve park location
  const ref = parkRefs[0] || '';
  let pLat = null, pLon = null;
  if (ref) {
    try {
      const park = await window.api.getPark(ref);
      if (park && park.name) { parkInfo.name = park.name; renderPark(); }
      if (park && park.locationDesc) parkInfo.locationDesc = park.locationDesc;
      if (park && park.latitude && park.longitude) {
        pLat = parseFloat(park.latitude);
        pLon = parseFloat(park.longitude);
      }
    } catch {}
  }

  if (pLat != null && pLon != null) {
    setParkMarker(pLat, pLon, ref, contacts.length);
  }

  // Resolve contact locations
  const callsigns = [...new Set(contacts.map(c => c.callsign).filter(Boolean))];
  let locations = {};
  if (callsigns.length) {
    try {
      locations = await window.api.resolveCallsignLocations(callsigns);
    } catch {}
  }

  const bounds = [];
  const bRefLon = pLon ?? -98.5;
  if (pLat != null && pLon != null) bounds.push([pLat, pLon]);

  for (const c of contacts) {
    // Prefer QRZ grid (precise) over cty.dat (country/call-area level)
    const gridPos = c.grid ? gridToLatLon(c.grid) : null;
    const loc = gridPos || locations[c.callsign];
    if (!loc) continue;
    addContactMarker(c.callsign, loc.lat, loc.lon, c.timeUtc, c.freqDisplay, c.mode, c.name);
    bounds.push([loc.lat, wrapLon(bRefLon, loc.lon)]);
  }

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [30, 30] });
  } else if (pLat != null && pLon != null) {
    map.setView([pLat, pLon], 6);
  }
}

// --- Incremental Contact ---

async function handleContactAdded(data) {
  const contact = data.contact;
  if (!contact) return;

  // If this is a location update (QRZ grid arrived after initial add),
  // replace the existing marker with a precisely positioned one
  if (data.update) {
    const li = contacts.findIndex((c) => c.callsign === contact.callsign && c.timeUtc === contact.timeUtc);
    if (li >= 0) { contacts[li] = contact; renderLog(); }
    const idx = contactMarkers.findIndex(m => m.callsign === contact.callsign);
    if (idx >= 0 && contact.grid) {
      const pos = gridToLatLon(contact.grid);
      if (pos) {
        const old = contactMarkers[idx];
        if (old.marker) map.removeLayer(old.marker);
        if (old.arcs) old.arcs.forEach(a => map.removeLayer(a));
        contactMarkers.splice(idx, 1);
        addContactMarker(contact.callsign, pos.lat, pos.lon, contact.timeUtc, contact.freqDisplay, contact.mode, contact.name);
      }
    }
    return;
  }

  contacts.push(contact);
  renderLog();

  // Update park marker popup count
  if (parkMarker && parkLat != null) {
    const ref = (data.parkRefs || [])[0] || '';
    parkMarker.setPopupContent(`<b>${ref}</b><br>${contactCount} contact${contactCount !== 1 ? 's' : ''}`);
  }

  // Prefer QRZ grid (precise) over cty.dat (country/call-area level)
  let loc = contact.grid ? gridToLatLon(contact.grid) : null;
  if (!loc) {
    try {
      const locs = await window.api.resolveCallsignLocations([contact.callsign]);
      loc = locs[contact.callsign];
    } catch {}
  }

  if (!loc) return;
  addContactMarker(contact.callsign, loc.lat, loc.lon, contact.timeUtc, contact.freqDisplay, contact.mode, contact.name);
}

// --- IPC Listeners (registered before async init for buffering) ---

window.api.onActivationData((data) => {
  // A log-only refresh needs no map.
  if (!map && data && data.logOnly) {
    contacts = Array.isArray(data.contacts) ? data.contacts.slice() : [];
    parkInfo.refs = data.parkRefs || parkInfo.refs;
    renderPark();
    renderLog();
    return;
  }
  if (!map) { _pendingData = data; return; }
  handleActivationData(data);
});

window.api.onContactAdded((data) => {
  if (!map) { _pendingContacts.push(data); return; }
  handleContactAdded(data);
});

window.api.onTheme((theme) => {
  _applyPopoutTheme(theme);
});

window.api.onColorblindMode((enabled) => {
  accentGreen = enabled ? '#4fc3f7' : '#4ecca3';
});

// --- Init ---

async function init() {
  try {
    const settings = await window.api.getSettings();
    _applyPopoutTheme({
      theme: settings.lightMode ? 'light' : 'dark',
      variant: settings.darkVariant || 'navy',
    });
    if (settings.colorblindMode) accentGreen = '#4fc3f7';
    myCallsign = String(settings.myCallsign || '').toUpperCase();
    initMap();
  } catch {
    initMap();
  }

  // Flush buffered data
  if (_pendingData) {
    await handleActivationData(_pendingData);
    _pendingData = null;
  }
  for (const c of _pendingContacts) {
    await handleContactAdded(c);
  }
  _pendingContacts = [];
}

init();
