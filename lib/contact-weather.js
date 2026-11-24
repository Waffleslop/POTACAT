'use strict';
/**
 * Contact details: the other station's weather (Discord "Jump", 2026-11-23).
 *
 * Open-Meteo (open-meteo.com) is free and needs no key. It is asked for the
 * centre of the station's 4-character grid square (about 110 x 220 km), never
 * the street position, and the request carries no callsign, name or key.
 * Its answer also names the place's time zone, which makes the window's local
 * time exact.
 *
 * Each answer is kept 30 minutes per grid square; a failure is kept 5
 * minutes so a dead network is not asked on every click. Asked only when the
 * Contact details window shows a station, unless the operator turned weather
 * off (main.js, settings.contactWeather === false).
 */
const { gridToLatLon, latLonToGrid } = require('./grid');

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 8000;

// WMO weather interpretation codes (Open-Meteo's weather_code), in plain words.
const CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

function weatherText(code) { return CODES[code] || ''; }

function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * @param {{ fetch?: Function, now?: () => number, ttlMs?: number }} [opts]
 */
function createWeatherClient(opts) {
  const o = opts || {};
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const now = o.now || Date.now;
  const ttl = o.ttlMs || TTL_MS;
  const cache = new Map();   // grid4 -> { at, value, ttl }
  const pending = new Map(); // grid4 -> Promise

  async function ask(grid4) {
    const c = gridToLatLon(grid4);
    const url = `${ENDPOINT}?latitude=${round3(c.lat)}&longitude=${round3(c.lon)}` +
      '&current=temperature_2m,weather_code,is_day&timezone=auto';
    let ctl = null, timer = null;
    try {
      ctl = typeof AbortController === 'function' ? new AbortController() : null;
      if (ctl) timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const res = await doFetch(url, { signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/json' } });
      if (!res || !res.ok) return null;
      const j = await res.json();
      const cur = j && j.current;
      const t = cur && Number(cur.temperature_2m);
      if (!cur || !Number.isFinite(t) || cur.temperature_2m == null) return null;
      const code = Number(cur.weather_code);
      return {
        tempC: t,
        code: Number.isFinite(code) ? code : null,
        text: weatherText(code),
        isDay: cur.is_day === 1 || cur.is_day === true,
        utcOffsetSeconds: Number.isFinite(Number(j.utc_offset_seconds)) ? Number(j.utc_offset_seconds) : null,
        timezone: typeof j.timezone === 'string' ? j.timezone : '',
        grid4,
        fetchedAt: now(),
      };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The current weather at { lat, lon }'s grid square, or null. */
  async function current(pos) {
    if (!doFetch || !pos) return null;
    const lat = Number(pos.lat), lon = Number(pos.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const grid4 = latLonToGrid(lat, lon).slice(0, 4).toUpperCase();
    const hit = cache.get(grid4);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    if (pending.has(grid4)) return pending.get(grid4);
    const p = ask(grid4).then((value) => {
      cache.set(grid4, { at: now(), value, ttl: value ? ttl : FAIL_TTL_MS });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(grid4));
    pending.set(grid4, p);
    return p;
  }

  return { current };
}

module.exports = { createWeatherClient, weatherText, ENDPOINT, SOURCE: 'Open-Meteo (open-meteo.com)' };
