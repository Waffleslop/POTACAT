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

// --- Frequency to band mapping ---
const BAND_EDGES = [
  [1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'],
  [7000, 7300, '40m'], [10100, 10150, '30m'], [14000, 14350, '20m'],
  [18068, 18168, '17m'], [21000, 21450, '15m'], [24890, 24990, '12m'],
  [28000, 29700, '10m'], [50000, 54000, '6m'],
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
      <td>${s.reference || ''}</td>
      <td style="max-width:160px;">${s.parkName || ''}</td>
      <td>${s.locationDesc || ''}</td>
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

// F12 DevTools
document.addEventListener('keydown', e => {
  if (e.key === 'F12') {
    // Handled by main process before-input-event
  }
});
