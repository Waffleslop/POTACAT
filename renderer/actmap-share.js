/* actmap-share.js — lays out the activation share image (actmap-share.html)
   from the data main sends, then reports ready once the map tiles are in. */
'use strict';

const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands' };
const CA_PROVINCES = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };

/** "US-ME" → "Maine, USA"; "US-ME,US-NH" → "Maine & New Hampshire, USA"; else as given. */
function describeLocation(desc) {
  const parts = String(desc || '').split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return '';
  const names = [];
  let country = '';
  for (const p of parts) {
    const m = p.toUpperCase().match(/^([A-Z0-9]{1,3})-([A-Z0-9]{1,3})$/);
    if (!m) return String(desc);
    if (m[1] === 'US' && US_STATES[m[2]]) { names.push(US_STATES[m[2]]); country = country || 'USA'; }
    else if (m[1] === 'CA' && CA_PROVINCES[m[2]]) { names.push(CA_PROVINCES[m[2]]); country = country || 'Canada'; }
    else return String(desc);
  }
  const list = names.length <= 2 ? names.join(' & ') : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  return country ? `${list}, ${country}` : list;
}

function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  if (!Number.isFinite(d.getTime())) return iso || '';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function el(id) { return document.getElementById(id); }
function text(id, v) { el(id).textContent = v || ''; }

function greatCircleArc(lat1, lon1, lat2, lon2, n) {
  const r = Math.PI / 180, dg = 180 / Math.PI;
  const p1 = lat1 * r, l1 = lon1 * r, p2 = lat2 * r, l2 = lon2 * r;
  const d = Math.acos(Math.min(1, Math.max(-1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(l2 - l1))));
  if (d < 1e-10) return [[lat1, lon1], [lat2, lon2]];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, a = Math.sin((1 - f) * d) / Math.sin(d), b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    out.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * dg, Math.atan2(y, x) * dg]);
  }
  // Keep the line continuous across the antimeridian (points are already
  // wrapped relative to the park by the Activation window).
  for (let i = 1; i < out.length; i++) {
    while (out[i][1] - out[i - 1][1] > 180) out[i][1] -= 360;
    while (out[i][1] - out[i - 1][1] < -180) out[i][1] += 360;
  }
  return out;
}

function render(data) {
  document.body.dataset.format = data.format === 'story' ? 'story' : 'post';
  const program = String(data.program || 'POTA').toUpperCase();
  text('kicker', `${program} activation`);
  text('call', data.callsign || '');
  const park = el('park');
  park.textContent = '';
  const ref = document.createElement('span');
  ref.className = 'ref';
  ref.textContent = (data.parkRefs || []).join(' · ');
  park.appendChild(ref);
  if (data.parkName) park.appendChild(document.createTextNode('  ' + data.parkName));
  text('where', describeLocation(data.locationDesc));

  const stats = el('stats');
  stats.innerHTML = '';
  const addStat = (n, label, small) => {
    const s = document.createElement('div');
    s.className = 'stat' + (small ? ' small' : '');
    s.innerHTML = '<div class="n"></div><div class="l"></div>';
    s.querySelector('.n').textContent = String(n);
    s.querySelector('.l').textContent = label;
    stats.appendChild(s);
  };
  addStat(data.qsos || 0, data.qsos === 1 ? 'QSO' : 'QSOs');
  if (data.p2p) addStat(data.p2p, 'Park to park', true);
  if (data.states) addStat(data.states, data.states === 1 ? 'State' : 'States', true);

  const meta = el('meta');
  meta.textContent = '';
  const bits = [formatDate(data.date), (data.bands || []).join(' '), (data.modes || []).join(' ')].filter(Boolean);
  bits.forEach((b, i) => {
    if (i) { const d = document.createElement('span'); d.className = 'dot'; d.textContent = '·'; meta.appendChild(d); }
    meta.appendChild(document.createTextNode(b));
  });

  // Map: fitted between the two text blocks so no pin hides under the text.
  const map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0.25, fadeAnimation: false, zoomAnimation: false, markerZoomAnimation: false });
  const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, className: 'dark-tiles', crossOrigin: false });
  tiles.addTo(map);

  const park0 = data.park && Number.isFinite(data.park.lat) ? [data.park.lat, data.park.lon] : null;
  const pts = (data.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => [p.lat, p.lon]);
  if (park0) {
    for (const p of pts) {
      L.polyline(greatCircleArc(park0[0], park0[1], p[0], p[1], 64), { color: '#4fc3f7', weight: 3, opacity: 0.65, dashArray: '10,8', interactive: false }).addTo(map);
    }
  }
  for (const p of pts) {
    L.circleMarker(p, { radius: 10, fillColor: '#4fc3f7', color: '#ffffff', weight: 2.5, fillOpacity: 0.95, interactive: false }).addTo(map);
  }
  if (park0) {
    L.circleMarker(park0, { radius: 26, stroke: false, fillColor: '#4ecca3', fillOpacity: 0.25, interactive: false }).addTo(map);
    L.circleMarker(park0, { radius: 14, fillColor: '#4ecca3', color: '#ffffff', weight: 4, fillOpacity: 1, interactive: false }).addTo(map);
  }

  const head = el('head').getBoundingClientRect();
  const foot = el('foot').getBoundingClientRect();
  const H = window.innerHeight;
  const topPad = Math.round(head.bottom + 40);
  const bottomPad = Math.round(H - foot.top + 40);
  const all = park0 ? [park0, ...pts] : pts;
  if (all.length > 1) {
    map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [90, topPad], paddingBottomRight: [90, bottomPad], maxZoom: 8, animate: false });
  } else if (all.length === 1) {
    map.setView(all[0], 6, { animate: false });
    map.panBy([0, (bottomPad - topPad) / 2], { animate: false });
  } else {
    map.setView([39.8, -98.5], 4, { animate: false });
  }

  // A zoomed-out map can be shorter than the image, leaving a hard edge where
  // the world ends above the pole (or below the Antarctic). Forcing a closer
  // zoom pushes pins under the text, so instead the shades extend solid to
  // wherever the edge falls: it reads as the header/footer panel.
  const lng = map.getCenter().lng;
  const northY = map.latLngToContainerPoint([85.0511, lng]).y;
  const southY = map.latLngToContainerPoint([-85.0511, lng]).y;
  const topShade = document.querySelector('.shade.top');
  const botShade = document.querySelector('.shade.bottom');
  if (northY > 0) {
    el('fill-top').style.height = Math.ceil(northY + 1) + 'px';
    topShade.style.top = Math.floor(northY) + 'px';
  }
  if (southY < H) {
    el('fill-bottom').style.height = Math.ceil(H - southY + 1) + 'px';
    botShade.style.bottom = Math.floor(H - southY) + 'px';
  }

  let done = false;
  const ready = () => { if (done) return; done = true; setTimeout(() => window.shareApi.ready(), 250); };
  tiles.on('load', ready);
  setTimeout(ready, 12000); // never hang the export on a slow tile server
}

window.shareApi.onData(render);
