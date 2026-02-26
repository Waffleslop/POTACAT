/* actmap-popout.js — Pop-out activation map showing park + logged contacts */

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

// --- State ---

let map = null;
let parkMarker = null;
let parkLat = null, parkLon = null;
let contactMarkers = []; // { marker, arcs[] }
let usedPositions = [];
let contactCount = 0;
const counterEl = document.getElementById('qso-counter');

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
    html: '<div style="background:#4ecca3;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 6px rgba(78,204,163,0.6);"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  parkMarker = L.marker([lat, lon], { icon: parkIcon, zIndexOffset: 1000 })
    .bindPopup(`<b>${ref}</b><br>${count} contact${count !== 1 ? 's' : ''}`)
    .addTo(map);
}

// --- Contact Marker ---

function addContactMarker(callsign, lat, lon, timeUtc, freqDisplay, mode, name) {
  // Jitter: golden angle distribution for overlapping cty.dat positions
  let cLat = lat, cLon = lon;
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
  contactMarkers.push({ marker, arcs });
}

// --- Update Counter ---

function updateCounter() {
  counterEl.textContent = contactCount + ' QSO' + (contactCount !== 1 ? 's' : '');
}

// --- Full State Push ---

async function handleActivationData(data) {
  // Clear existing markers
  for (const cm of contactMarkers) {
    map.removeLayer(cm.marker);
    for (const a of cm.arcs) map.removeLayer(a);
  }
  contactMarkers = [];
  usedPositions = [];
  if (parkMarker) { map.removeLayer(parkMarker); parkMarker = null; }

  const parkRefs = data.parkRefs || [];
  const contacts = data.contacts || [];
  contactCount = contacts.length;
  updateCounter();

  // Resolve park location
  const ref = parkRefs[0] || '';
  let pLat = null, pLon = null;
  if (ref) {
    try {
      const park = await window.api.getPark(ref);
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
  if (pLat != null && pLon != null) bounds.push([pLat, pLon]);

  for (const c of contacts) {
    const loc = locations[c.callsign];
    if (!loc) continue;
    addContactMarker(c.callsign, loc.lat, loc.lon, c.timeUtc, c.freqDisplay, c.mode, c.name);
    bounds.push([loc.lat, loc.lon]);
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
  contactCount++;
  updateCounter();

  // Update park marker popup count
  if (parkMarker && parkLat != null) {
    const ref = (data.parkRefs || [])[0] || '';
    parkMarker.setPopupContent(`<b>${ref}</b><br>${contactCount} contact${contactCount !== 1 ? 's' : ''}`);
  }

  // Resolve location for single callsign
  let loc = null;
  try {
    const locs = await window.api.resolveCallsignLocations([contact.callsign]);
    loc = locs[contact.callsign];
  } catch {}

  if (!loc) return;
  addContactMarker(contact.callsign, loc.lat, loc.lon, contact.timeUtc, contact.freqDisplay, contact.mode, contact.name);
}

// --- IPC Listeners (registered before async init for buffering) ---

window.api.onActivationData((data) => {
  if (!map) { _pendingData = data; return; }
  handleActivationData(data);
});

window.api.onContactAdded((data) => {
  if (!map) { _pendingContacts.push(data); return; }
  handleContactAdded(data);
});

window.api.onTheme((theme) => {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
});

// --- Init ---

async function init() {
  try {
    const settings = await window.api.getSettings();
    if (settings.lightMode) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
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
