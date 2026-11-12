'use strict';
// When the ISS is next above the horizon (Casey 2026-11-11: "tune into the
// ISS via a SDR and decode SSTV"). The SSTV window shows the next pass, how
// long it lasts and how high it climbs, so the operator knows when to listen.
//
// The orbit comes from the ISS's two-line element set (CelesTrak, NORAD
// 25544), propagated with SGP4 (satellite.js, MIT). Pure: main.js fetches
// and caches the TLE, this only computes.

const sat = require('satellite.js');

const ISS_NORAD = 25544;
const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle';
const TLE_MAX_AGE_MS = 24 * 3600 * 1000;   // fetched again after a day

/** A CelesTrak TLE answer -> { name, line1, line2 }, or null when it is not one. */
function parseTle(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (/^1 \d{5}/.test(lines[i]) && lines[i + 1] && /^2 \d{5}/.test(lines[i + 1])) {
      const name = i > 0 && !/^[12] \d{5}/.test(lines[i - 1]) ? lines[i - 1].trim() : 'ISS';
      return { name, line1: lines[i], line2: lines[i + 1] };
    }
  }
  return null;
}

/** Look angles of the satellite from an observer at a moment. */
function lookAt(satrec, observer, date) {
  const pv = sat.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position !== 'object') return null;
  const gmst = sat.gstime(date);
  const ecf = sat.eciToEcf(pv.position, gmst);
  const obs = {
    latitude: sat.degreesToRadians(observer.lat),
    longitude: sat.degreesToRadians(observer.lon),
    height: (Number(observer.heightM) || 0) / 1000,
  };
  const la = sat.ecfToLookAngles(obs, ecf);
  return { elDeg: la.elevation * 180 / Math.PI, azDeg: ((la.azimuth * 180 / Math.PI) + 360) % 360, rangeKm: la.rangeSat };
}

/**
 * The next passes above `minElDeg`, starting at `from`, within `hours`.
 * Each pass: { aos, los, tca (Date), maxElDeg, durationS, aosAzDeg, losAzDeg }.
 * A pass already under way at `from` starts at `from`.
 */
function nextPasses(tle, observer, { from = new Date(), hours = 24, minElDeg = 0, max = 5 } = {}) {
  if (!tle || !tle.line1 || !tle.line2 || !observer) return [];
  const satrec = sat.twoline2satrec(tle.line1, tle.line2);
  const start = from.getTime();
  const end = start + hours * 3600 * 1000;
  const STEP = 20 * 1000;          // a LEO pass lasts minutes; 20 s finds every one
  const passes = [];
  let prev = lookAt(satrec, observer, new Date(start));
  if (!prev) return [];
  let cur = null;
  if (prev.elDeg > minElDeg) cur = { aos: new Date(start), maxElDeg: prev.elDeg, tca: new Date(start), aosAzDeg: prev.azDeg };
  for (let t = start + STEP; t <= end && passes.length < max; t += STEP) {
    const la = lookAt(satrec, observer, new Date(t));
    if (!la) break;
    if (!cur && la.elDeg > minElDeg) {
      const aos = refineCrossing(satrec, observer, t - STEP, t, minElDeg);
      cur = { aos, maxElDeg: la.elDeg, tca: new Date(t), aosAzDeg: lookAt(satrec, observer, aos).azDeg };
    } else if (cur && la.elDeg > cur.maxElDeg) {
      cur.maxElDeg = la.elDeg; cur.tca = new Date(t);
    } else if (cur && la.elDeg <= minElDeg) {
      const los = refineCrossing(satrec, observer, t - STEP, t, minElDeg);
      cur.los = los;
      cur.losAzDeg = lookAt(satrec, observer, los).azDeg;
      cur.durationS = Math.round((los - cur.aos) / 1000);
      cur.maxElDeg = Math.round(cur.maxElDeg * 10) / 10;
      passes.push(cur);
      cur = null;
    }
  }
  return passes;
}

/** The moment between t0 and t1 the elevation crosses minEl, to within a second. */
function refineCrossing(satrec, observer, t0, t1, minEl) {
  const above0 = lookAt(satrec, observer, new Date(t0)).elDeg > minEl;
  let lo = t0, hi = t1;
  while (hi - lo > 1000) {
    const mid = Math.round((lo + hi) / 2);
    const above = lookAt(satrec, observer, new Date(mid)).elDeg > minEl;
    if (above === above0) lo = mid; else hi = mid;
  }
  return new Date(hi);
}

/** The sentence the SSTV window shows for a pass, in UTC. */
function passLine(p, now = new Date()) {
  if (!p) return '';
  const hhmm = (d) => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  const min = Math.max(1, Math.round(p.durationS / 60));
  const inPass = p.aos <= now && now < p.los;
  if (inPass) return `The ISS is up now: until ${hhmm(p.los)} UTC, highest ${Math.round(p.maxElDeg)}°`;
  const inMin = Math.round((p.aos - now) / 60000);
  const when = inMin < 60 ? `in ${inMin} min` : `at ${hhmm(p.aos)} UTC`;
  return `Next ISS pass ${when}${inMin < 60 ? ` (${hhmm(p.aos)} UTC)` : ''}, ${min} min, highest ${Math.round(p.maxElDeg)}°`;
}

module.exports = { ISS_NORAD, TLE_URL, TLE_MAX_AGE_MS, parseTle, lookAt, nextPasses, passLine };
