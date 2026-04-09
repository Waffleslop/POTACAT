// Spots pop-out renderer — simplified spot table for activator mode
// Receives enriched spot data from main process via IPC

let allSpots = [];
let sortCol = 'distance';
let sortAsc = true;
let distUnit = 'mi';
let tunedCallsign = '';

const tbody = document.getElementById('spots-body');
const spotCountEl = document.getElementById('spot-count');
const filterBand = document.getElementById('filter-band');
const filterMode = document.getElementById('filter-mode');
const filterContinent = document.getElementById('filter-continent');

// --- Titlebar ---
document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
document.getElementById('tb-close').addEventListener('click', () => window.api.close());

// --- Theme ---
window.api.getSettings().then(s => {
  if (s && s.lightMode) document.documentElement.setAttribute('data-theme', 'light');
  distUnit = s?.distUnit || 'mi';
  // Update dist header
  const distTh = document.querySelector('th[data-sort="distance"]');
  if (distTh) distTh.textContent = `Dist (${distUnit})`;
});

window.api.onTheme(theme => {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
});

const CB_SOURCE_COLORS = {
  pota: '#4fc3f7', sota: '#ffb300', wwff: '#29b6f6',
  llota: '#42a5f5', dxc: '#e040fb', rbn: '#81d4fa', pskr: '#ffa726'
};
function applyColorblindVars(enabled) {
  const root = document.documentElement;
  if (enabled) {
    for (const [src, color] of Object.entries(CB_SOURCE_COLORS)) root.style.setProperty('--source-' + src, color);
  } else {
    for (const src of Object.keys(CB_SOURCE_COLORS)) root.style.removeProperty('--source-' + src);
  }
}
window.api.onColorblindMode(applyColorblindVars);
// Apply on init
window.api.getSettings().then(s => { if (s.colorblindMode) applyColorblindVars(true); });

// --- Frequency to band mapping ---
const BAND_EDGES = [
  [1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'],
  [7000, 7300, '40m'], [10100, 10150, '30m'], [14000, 14350, '20m'],
  [18068, 18168, '17m'], [21000, 21450, '15m'], [24890, 24990, '12m'],
  [28000, 29700, '10m'], [50000, 54000, '6m'], [70000, 70500, '4m'], [144000, 148000, '2m'],
  [420000, 450000, '70cm'],
];

function freqToBand(freqKhz) {
  const f = parseFloat(freqKhz);
  for (const [lo, hi, band] of BAND_EDGES) {
    if (f >= lo && f <= hi) return band;
  }
  return '';
}

// --- Age formatting ---
function formatAge(spotTime) {
  if (!spotTime) return '';
  let t = spotTime;
  if (typeof t === 'string') {
    if (!t.endsWith('Z') && !t.includes('+')) t += 'Z';
    t = new Date(t).getTime();
  }
  const diffMs = Date.now() - t;
  if (diffMs < 0) return '0m';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function latLonToGridLocal(lat, lon) {
  let lng = lon + 180;
  let la = lat + 90;
  const A = 'A'.charCodeAt(0);
  const a = 'a'.charCodeAt(0);
  const field1 = String.fromCharCode(A + Math.floor(lng / 20));
  const field2 = String.fromCharCode(A + Math.floor(la / 10));
  lng %= 20;
  la %= 10;
  const sq1 = Math.floor(lng / 2);
  const sq2 = Math.floor(la / 1);
  lng -= sq1 * 2;
  la -= sq2 * 1;
  const sub1 = String.fromCharCode(a + Math.floor(lng / (2 / 24)));
  const sub2 = String.fromCharCode(a + Math.floor(la / (1 / 24)));
  return `${field1}${field2}${sq1}${sq2}${sub1}${sub2}`;
}

// --- Filtering ---
function getFilteredSpots() {
  const band = filterBand.value;
  const mode = filterMode.value;
  const continent = filterContinent.value;

  return allSpots.filter(s => {
    if (band !== 'all' && freqToBand(s.frequency) !== band) return false;
    if (mode !== 'all') {
      const sm = (s.mode || '').toUpperCase();
      if (mode === 'SSB') {
        if (sm !== 'SSB' && sm !== 'USB' && sm !== 'LSB') return false;
      } else if (sm !== mode) return false;
    }
    if (continent !== 'all' && s.continent !== continent) return false;
    return true;
  });
}

// --- Sorting ---
function compareSpots(a, b) {
  let va, vb;
  switch (sortCol) {
    case 'frequency':
    case 'distance':
      va = parseFloat(a[sortCol]) || 0;
      vb = parseFloat(b[sortCol]) || 0;
      break;
    case 'spotTime': {
      const ta = typeof a.spotTime === 'number' ? a.spotTime : new Date(a.spotTime + (typeof a.spotTime === 'string' && !a.spotTime.endsWith('Z') ? 'Z' : '')).getTime();
      const tb = typeof b.spotTime === 'number' ? b.spotTime : new Date(b.spotTime + (typeof b.spotTime === 'string' && !b.spotTime.endsWith('Z') ? 'Z' : '')).getTime();
      va = ta; vb = tb;
      break;
    }
    case 'grid':
      va = (a.lat != null && a.lon != null) ? latLonToGridLocal(a.lat, a.lon).slice(0, 4) : '';
      vb = (b.lat != null && b.lon != null) ? latLonToGridLocal(b.lat, b.lon).slice(0, 4) : '';
      break;
    default:
      va = (a[sortCol] || '').toString().toLowerCase();
      vb = (b[sortCol] || '').toString().toLowerCase();
      break;
  }
  if (va < vb) return sortAsc ? -1 : 1;
  if (va > vb) return sortAsc ? 1 : -1;
  return 0;
}

// --- Render ---
function render() {
  const spots = getFilteredSpots();
  spots.sort(compareSpots);

  spotCountEl.textContent = `${spots.length} spot${spots.length !== 1 ? 's' : ''}`;

  const frag = document.createDocumentFragment();
  for (const s of spots) {
    const tr = document.createElement('tr');
    const band = freqToBand(s.frequency);
    const sourceClass = {
      pota: 'spot-source-pota', sota: 'spot-source-sota',
      dxc: 'spot-source-dxc', rbn: 'spot-source-rbn',
      wwff: 'spot-source-wwff', llota: 'spot-source-llota',
      pskr: 'spot-source-pskr',
    }[s.source] || '';
    if (sourceClass) tr.classList.add(sourceClass);
    if (s.callsign === tunedCallsign) tr.classList.add('tuned');

    // Click row to tune
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.log-cell-btn')) return;
      tunedCallsign = s.callsign;
      window.api.tune(s.frequency, s.mode, s.bearing);
      render();
    });

    const freq = parseFloat(s.frequency);
    const freqStr = freq ? freq.toFixed(1) : s.frequency;
    const dist = s.distance != null ? Math.round(s.distance) : '';

    tr.innerHTML = `
      <td><a class="call-link" href="#" title="${s.callsign}">${s.callsign}</a></td>
      <td>${freqStr}</td>
      <td>${s.mode || ''}</td>
      <td>${(s.source || '').toUpperCase()}</td>
      <td>${s.reference && s.source !== 'net' ? `<a class="park-link" href="#" data-ref="${s.reference}" data-source="${s.source || ''}">${s.reference}</a>` : (s.reference || '')}</td>
      <td style="max-width:160px;">${s.reference && s.source !== 'net' && s.parkName ? `<a class="park-link" href="#" data-ref="${s.reference}" data-source="${s.source || ''}">${s.parkName}</a>` : (s.parkName || '')}</td>
      <td>${s.locationDesc || ''}</td>
      <td>${(s.lat != null && s.lon != null) ? latLonToGridLocal(s.lat, s.lon).slice(0, 4) : ''}</td>
      <td>${dist}</td>
      <td>${formatAge(s.spotTime)}</td>
      <td style="max-width:180px;">${s.comments || ''}</td>
      <td><button class="log-cell-btn" title="Log QSO">Log</button></td>
    `;

    // QRZ link
    const callLink = tr.querySelector('.call-link');
    callLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.api.openExternal(`https://www.qrz.com/db/${s.callsign}`);
    });

    // Park links
    tr.querySelectorAll('.park-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ref = a.dataset.ref;
        const src = a.dataset.source;
        let url;
        if (src === 'sota') url = `https://www.sotadata.org.uk/en/summit/${ref}`;
        else if (src === 'wwff') url = `https://wwff.co/directory/?showRef=${ref}`;
        else if (src === 'llota') url = `https://llota.app/lighthouse/${ref}`;
        else url = `https://pota.app/#/park/${ref}`;
        window.api.openExternal(url);
      });
    });

    // Log button
    const logBtn = tr.querySelector('.log-cell-btn');
    logBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.openLogDialog(s);
    });

    frag.appendChild(tr);
  }

  tbody.textContent = '';
  tbody.appendChild(frag);
}

// --- Sort headers ---
document.querySelectorAll('.spots-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortCol === col) sortAsc = !sortAsc;
    else { sortCol = col; sortAsc = col === 'spotTime' ? false : true; }
    // Update sort arrows
    document.querySelectorAll('.spots-table th[data-sort]').forEach(h => {
      const arrow = h.querySelector('.sort-arrow');
      if (arrow) arrow.remove();
    });
    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    arrow.textContent = sortAsc ? '\u25B2' : '\u25BC';
    th.appendChild(arrow);
    render();
  });
});

// --- Filter change ---
filterBand.addEventListener('change', render);
filterMode.addEventListener('change', render);
filterContinent.addEventListener('change', render);

// --- Receive spots from main ---
window.api.onSpotsData(data => {
  allSpots = data || [];
  render();
});

// Refresh age display periodically
setInterval(render, 30000);

// --- VFO Lock: tune-blocked toast ---
window.api.onTuneBlocked((msg) => {
  let t = document.getElementById('tune-blocked-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'tune-blocked-toast';
    t.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#e94560;color:#fff;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:bold;z-index:9999;pointer-events:none;box-shadow:0 4px 20px rgba(233,69,96,0.5);opacity:0;transition:opacity 0.2s';
    document.body.appendChild(t);
  }
  t.textContent = msg || 'VFO Locked — Unlock VFO to change frequency';
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2000);
});

// F12 DevTools
document.addEventListener('keydown', e => {
  if (e.key === 'F12') {
    // Handled by main process before-input-event
  }
});
