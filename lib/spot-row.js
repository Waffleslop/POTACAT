/**
 * ECHOCAT Web spot-table rows — the grid, the per-column cells and the
 * formatters, in one module the page uses (inlined by remote-server like
 * scope-axis) and the layout test renders (test/layout-alignment-test.js).
 *
 * Why it exists (2026-10-22): the CW speed was added as a SECOND grid cell on
 * some rows, so every later column, the S/H/L buttons included, moved one
 * track right on those rows. The rule this module keeps: **every column key
 * produces exactly one element**, and every number is formatted here.
 *
 * Dual-mode: require() in Node/tests, window.SpotRow in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotRow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Per-column grid-track widths (px). Callsign is always the first column.
  // Every .spot-card shares the same grid-template-columns, so each column
  // lands on the same x on every row — as long as each key emits ONE element.
  const SPOT_COL_WIDTHS = {
    call: 120, freq: 80, mode: 56, band: 48,
    dist: 60, ref: 84, name: 150, region: 56,
    src: 56, age: 52, skip: 40, hide: 40, log: 40,
    spotter: 84, cqz: 34, ituz: 34,
  };
  const DEFAULT_COL_ORDER = ['freq', 'mode', 'band', 'dist', 'ref', 'name', 'region', 'cqz', 'ituz', 'src', 'age', 'spotter', 'skip', 'hide', 'log'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function computeSpotGrid(colOrder, colShow) {
    const parts = [SPOT_COL_WIDTHS.call + 'px'];
    for (const key of colOrder) {
      if (!colShow[key]) continue;
      const w = SPOT_COL_WIDTHS[key];
      if (w) parts.push(w + 'px');
    }
    return parts.join(' ');
  }

  function formatSpotFreq(kHz) {
    const n = parseFloat(kHz);
    if (isNaN(n)) return kHz == null ? '' : String(kHz);
    return n.toFixed(1);
  }

  const MI_TO_KM = 1.60934;
  function formatSpotDist(miles, unit) {
    if (miles == null || miles === '' || !Number.isFinite(Number(miles))) return '';
    const km = unit === 'km';
    const d = km ? Math.round(miles * MI_TO_KM) : Math.round(miles);
    if (d >= 10000) return (d / 1000).toFixed(0) + 'k';
    if (d >= 1000) return (d / 1000).toFixed(1) + 'k';
    return d + (km ? 'km' : 'mi');
  }

  const COUNTRY_ABBR = {
    'United States':'USA','Canada':'CAN','Mexico':'MEX','Japan':'JPN','China':'CHN',
    'Australia':'AUS','New Zealand':'NZL','Brazil':'BRA','Argentina':'ARG',
    'Germany':'DEU','Fed. Rep. of Germany':'DEU','France':'FRA','Italy':'ITA',
    'Spain':'ESP','United Kingdom':'GBR','England':'ENG','Scotland':'SCO',
    'Wales':'WAL','Netherlands':'NLD','Belgium':'BEL','Switzerland':'CHE',
    'Austria':'AUT','Poland':'POL','Sweden':'SWE','Norway':'NOR','Denmark':'DNK',
    'Finland':'FIN','Portugal':'PRT','Czech Republic':'CZE','Hungary':'HUN',
    'Romania':'ROU','Greece':'GRC','Turkey':'TUR','Israel':'ISR',
    'South Korea':'KOR','India':'IND','Russia':'RUS',
    'European Russia':'RUS','Asiatic Russia':'RUS',
    'South Africa':'ZAF','Thailand':'THA','Philippines':'PHL',
    'Indonesia':'IDN','Colombia':'COL','Chile':'CHL','Peru':'PER',
    'Hawaii':'HI','Alaska':'AK','Puerto Rico':'PR',
    'Guadeloupe':'GLP','Curacao':'CUR','Bermuda':'BMU',
    'Turks & Caicos Islands':'TCA','Cayman Islands':'CYM',
    'US Virgin Islands':'USVI','British Virgin Islands':'BVI',
    'Trinidad & Tobago':'TTO','Dominican Republic':'DOM',
    'Costa Rica':'CRI','Panama':'PAN','Venezuela':'VEN',
    'Ukraine':'UKR','Ireland':'IRL','Croatia':'HRV','Serbia':'SRB',
    'Bulgaria':'BGR','Slovakia':'SVK','Slovenia':'SVN','Lithuania':'LTU',
    'Latvia':'LVA','Estonia':'EST','Iceland':'ISL','Luxembourg':'LUX',
    'Malta':'MLT','Cyprus':'CYP','Taiwan':'TWN','Singapore':'SGP',
    'Malaysia':'MYS','Vietnam':'VNM','Pakistan':'PAK','Bangladesh':'BGD',
    'Sri Lanka':'LKA','Egypt':'EGY','Morocco':'MAR','Kenya':'KEN',
    'Nigeria':'NGA','Ghana':'GHA','Algeria':'DZA','Tunisia':'TUN',
  };
  function abbreviateCountry(name) {
    const n = String(name || '');
    return COUNTRY_ABBR[n] || n.slice(0, 4);
  }

  /** A whole number for a zone, or the dash. */
  function zoneText(z) {
    const n = Number(z);
    return (z == null || z === '' || !Number.isFinite(n)) ? '—' : String(Math.round(n));
  }

  /**
   * One cell per column key — ALWAYS exactly one top-level element.
   * `v` carries what the page decided for this spot (see spotRowHtml).
   */
  function spotCellHtml(key, s, v) {
    switch (key) {
      case 'freq': return `<span class="spot-freq">${esc(formatSpotFreq(s.frequency))}</span>`;
      case 'mode': {
        // The CW speed sits INSIDE the Mode cell (it was a sibling cell: 1.11.7–1.13.0).
        const wpm = Number(s.wpm);
        const showWpm = Number.isFinite(wpm) && wpm > 0 && String(s.mode || '').toUpperCase() === 'CW';
        const title = 'CW speed' + (s.wpmFrom === 'skimmer' ? ' measured by a skimmer' : '');
        return `<span class="spot-mode">${esc(s.mode || '')}${showWpm ? ` <span class="spot-wpm" title="${title}">${Math.round(wpm)}</span>` : ''}</span>`;
      }
      case 'band': return `<span class="spot-band">${esc(s.band || '')}</span>`;
      case 'dist': return `<span class="spot-dist">${esc(formatSpotDist(s.distance, v.distUnit))}</span>`;
      case 'ref': return `<span class="spot-ref ${v.refClass || ''}">${esc(v.ref)}</span>`;
      case 'name': return `<span class="spot-name">${esc(v.spotName || '')}</span>`;
      case 'region': {
        const full = s.locationDesc || '';
        const rgn = full.length > 6 ? abbreviateCountry(full) : full;
        return rgn ? `<span class="spot-region" title="${esc(full)}">${esc(rgn)}</span>` : '<span class="spot-region">—</span>';
      }
      case 'src': return `<span class="spot-src source-${esc(v.src)}">${esc(String(v.src).toUpperCase())}</span>`;
      case 'age': return `<span class="spot-age">${esc(v.age || '')}</span>`;
      case 'spotter': return `<span class="spot-spotter" title="Spotted by ${esc(s.spotter || '')}">${esc(s.spotter || '—')}</span>`;
      case 'cqz': return `<span class="spot-zone" title="CQ zone">${zoneText(s.cqZone)}</span>`;
      case 'ituz': return `<span class="spot-zone" title="ITU zone">${zoneText(s.ituZone)}</span>`;
      case 'skip': return v.isNet ? '<span class="spot-btn-empty"></span>'
        : `<button type="button" class="spot-skip-btn" data-skipfreq="${esc(String(s.frequency))}" data-skipcall="${esc(s.callsign)}">${v.isSkipped ? 'U' : 'S'}</button>`;
      case 'hide': return (v.isNet || !s.band) ? '<span class="spot-btn-empty"></span>'
        : `<button type="button" class="spot-hide-btn" data-hidecall="${esc(s.callsign)}" data-hideband="${esc(s.band)}" title="Hide ${esc(s.callsign)} on ${esc(s.band)} until QSY">H</button>`;
      case 'log': return v.isNet ? '<span class="spot-btn-empty"></span>' : '<button type="button" class="spot-log-btn">L</button>';
      default: return '';
    }
  }

  /**
   * One spot card. `v` = what the page knows about this spot:
   *   { tuned, newPark, workedToday, workedEver, workedOther (tooltip text of the
   *     dim "worked today on another band/mode" check), isSkipped, dxe ('', 'contest',
   *     'dxpedition'), dxeTitle, opName, age, donor, creator, distUnit }
   * `opts` = { colOrder, colShow }.
   */
  /**
   * "Worked today, on another band or mode" (Casey 2026-10-23). The checkmark
   * means worked on THIS band and mode — a new band is a new POTA credit, so
   * the spot must stay workable — but an activator who moved after the QSO
   * looked never-worked. This names what was worked today instead, for a dim
   * second checkmark. entries = the call's worked-QSO list ({date, band,
   * mode, ref}), band/mode already normalized the way the checkmark compares,
   * todayUtc = 'YYYYMMDD'. Returns labels like ['20M SSB'] (empty = none).
   */
  function workedElsewhereToday(entries, band, mode, todayUtc) {
    if (!Array.isArray(entries) || !todayUtc) return [];
    const b = String(band || '').toUpperCase(), m = String(mode || '').toUpperCase();
    const out = [];
    for (const e of entries) {
      if (!e || e.date !== todayUtc) continue;
      const eb = String(e.band || '').toUpperCase(), em = String(e.mode || '').toUpperCase();
      if ((!b || eb === b) && (!m || em === m)) return []; // worked HERE: the real checkmark applies
      const label = [eb, em].filter(Boolean).join(' ') || 'another band';
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }
  function workedElsewhereTitle(labels) {
    return labels && labels.length
      ? `Worked today on ${labels.join(', ')} — this band/mode is a new contact`
      : '';
  }

  function spotRowHtml(s, v0, opts) {
    const v = Object.assign({}, v0);
    const o = opts || {};
    const colOrder = o.colOrder || DEFAULT_COL_ORDER;
    const colShow = o.colShow || {};
    v.src = s.source || 'pota';
    v.isNet = s.source === 'net';
    v.ref = s.reference || '—';
    v.refClass = s.source === 'sota' ? 'sota' : s.source === 'dxc' ? 'dxc' : '';
    if (v.isNet) v.age = s.comments || '';
    v.spotName = v.opName || s.parkName || s.comments || '';
    const cls = 'spot-card source-' + esc(v.src) + (v.tuned ? ' tuned' : '') + (v.newPark ? ' new-park' : '') +
      (v.workedToday ? ' worked-today' : v.workedEver ? ' worked' : '') + (v.isSkipped ? ' scan-skipped' : '');
    const check = (v.workedToday || v.workedEver) ? '<span class="worked-check">✓</span>'
      : (v.workedOther ? `<span class="worked-check other" title="${esc(v.workedOther)}">✓</span>` : '');
    const badges = (v.newPark ? '<span class="new-badge">N</span>' : '') +
      (v.dxe ? `<span class="dxe-badge${v.dxe === 'contest' ? ' contest' : ''}" title="${esc(v.dxeTitle || '')}">${v.dxe === 'contest' ? 'CONTEST' : 'DXP'}</span>` : '');
    const paws = (v.donor ? '<span class="donor-paw" title="POTACAT Supporter">🐾</span>' : '') +
      (v.creator ? '<span class="donor-paw" title="POTACAT Creator">🐈‍⬛</span>' : '');
    const cells = colOrder.map(k => (colShow[k] ? spotCellHtml(k, s, v) : '')).join('');
    const ref = (k, attr) => (s[k] ? ` ${attr}="${esc(s[k])}"` : '');
    return `<div class="${cls}" data-freq="${esc(String(s.frequency))}" data-mode="${esc(s.mode || '')}" data-bearing="${esc(String(s.bearing || ''))}" data-call="${esc(s.callsign)}" data-ref="${esc(v.ref)}" data-src="${esc(v.src)}"` +
      `${ref('potaReference', 'data-pota-ref')}${ref('sotaReference', 'data-sota-ref')}${ref('wwffReference', 'data-wwff-ref')}${ref('llotaReference', 'data-llota-ref')}>` +
      `<span class="spot-call">${check}${esc(s.callsign)}${paws}${badges}</span>${cells}</div>`;
  }

  return { SPOT_COL_WIDTHS, DEFAULT_COL_ORDER, esc, computeSpotGrid, formatSpotFreq, formatSpotDist, abbreviateCountry, spotCellHtml, spotRowHtml, workedElsewhereToday, workedElsewhereTitle };
});
