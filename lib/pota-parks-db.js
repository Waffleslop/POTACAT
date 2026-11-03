'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// Map callsign prefix -> POTA program code
// Callsign prefix -> POTA program prefix. POTA's program prefixes are ISO
// 3166 country codes (https://api.pota.app/programs; park refs read FI-0003,
// DE-0001). This table used the old ITU-style codes (OH, DL, F, I, EA, JA,
// VK...) until 2026-11-01: those return ZERO parks from /program/parks/<code>,
// and some are now other countries (PA = Panama, SM = San Marino, LA = Laos),
// so most operators outside North America and the UK had an empty or wrong
// parks list (OG3E, Discord 2026-11-01: "it cant find any parks").
// Every value here is checked against the live programs list by
// test/pota-parks-db-test.js's fixture.
const PREFIX_TO_PROGRAM = {
  // United States and territories
  'K': 'US', 'W': 'US', 'N': 'US', 'AA': 'US', 'AB': 'US', 'AC': 'US', 'AD': 'US', 'AE': 'US', 'AF': 'US', 'AG': 'US',
  'AH': 'US', 'AI': 'US', 'AJ': 'US', 'AK': 'US', 'AL': 'US', 'KH6': 'US', 'KL7': 'US',
  'KP2': 'VI', 'KP3': 'PR', 'KP4': 'PR', 'NP2': 'VI', 'NP3': 'PR', 'NP4': 'PR', 'WP2': 'VI', 'WP3': 'PR', 'WP4': 'PR',
  'KH2': 'GU', 'NH2': 'GU', 'WH2': 'GU', 'AH2': 'GU',
  // Canada, Mexico
  'VE': 'CA', 'VA': 'CA', 'VY': 'CA', 'VO': 'CA', 'CF': 'CA', 'CG': 'CA', 'CH': 'CA', 'CI': 'CA', 'CJ': 'CA', 'CK': 'CA', 'CY': 'CA', 'CZ': 'CA', 'XL': 'CA', 'XM': 'CA', 'XN': 'CA', 'XO': 'CA',
  'XE': 'MX', 'XA': 'MX', 'XB': 'MX', 'XC': 'MX', 'XD': 'MX', 'XF': 'MX', '4A': 'MX', '4B': 'MX', '4C': 'MX', '6D': 'MX', '6E': 'MX', '6F': 'MX', '6G': 'MX', '6H': 'MX', '6I': 'MX', '6J': 'MX',
  // United Kingdom (England, Scotland, Wales, Northern Ireland: one program)
  'G': 'GB', 'M': 'GB', '2E': 'GB', '2I': 'GB', '2M': 'GB', '2W': 'GB', '2D': 'GB', '2J': 'GB', '2U': 'GB',
  // Europe
  'DA': 'DE', 'DB': 'DE', 'DC': 'DE', 'DD': 'DE', 'DE': 'DE', 'DF': 'DE', 'DG': 'DE', 'DH': 'DE', 'DJ': 'DE', 'DK': 'DE', 'DL': 'DE', 'DM': 'DE', 'DN': 'DE', 'DO': 'DE', 'DP': 'DE', 'DQ': 'DE', 'DR': 'DE',
  'F': 'FR', 'TM': 'FR',
  'I': 'IT', 'IK': 'IT', 'IU': 'IT', 'IW': 'IT', 'IZ': 'IT', 'IQ': 'IT', 'IR': 'IT',
  'EA': 'ES', 'EB': 'ES', 'EC': 'ES', 'ED': 'ES', 'EE': 'ES', 'EF': 'ES', 'EG': 'ES', 'EH': 'ES',
  'PA': 'NL', 'PB': 'NL', 'PC': 'NL', 'PD': 'NL', 'PE': 'NL', 'PF': 'NL', 'PG': 'NL', 'PH': 'NL', 'PI': 'NL',
  'ON': 'BE', 'OO': 'BE', 'OP': 'BE', 'OQ': 'BE', 'OR': 'BE', 'OS': 'BE', 'OT': 'BE',
  'OZ': 'DK', 'OU': 'DK', 'OV': 'DK', '5P': 'DK', '5Q': 'DK',
  'SM': 'SE', 'SA': 'SE', 'SB': 'SE', 'SC': 'SE', 'SD': 'SE', 'SE': 'SE', 'SF': 'SE', 'SG': 'SE', 'SH': 'SE', 'SI': 'SE', 'SJ': 'SE', 'SK': 'SE', 'SL': 'SE', '7S': 'SE', '8S': 'SE',
  'LA': 'NO', 'LB': 'NO', 'LC': 'NO', 'LD': 'NO', 'LE': 'NO', 'LF': 'NO', 'LG': 'NO', 'LH': 'NO', 'LI': 'NO', 'LJ': 'NO', 'LK': 'NO', 'LL': 'NO', 'LM': 'NO', 'LN': 'NO',
  'OF': 'FI', 'OG': 'FI', 'OH': 'FI', 'OI': 'FI', 'OJ': 'FI', 'OH0': 'AX',
  'OE': 'AT',
  'HB': 'CH', 'HE': 'CH',
  'OK': 'CZ', 'OL': 'CZ',
  'SP': 'PL', 'SN': 'PL', 'SO': 'PL', 'SQ': 'PL', 'SR': 'PL', '3Z': 'PL', 'HF': 'PL',
  'HA': 'HU', 'HG': 'HU',
  'YO': 'RO', 'YP': 'RO', 'YQ': 'RO', 'YR': 'RO',
  'LZ': 'BG',
  'S5': 'SI',
  '9A': 'HR',
  'OY': 'FO',
  'TF': 'IS',
  'EI': 'IE', 'EJ': 'IE',
  'CT': 'PT', 'CQ': 'PT', 'CR': 'PT', 'CS': 'PT',
  'SV': 'GR', 'SW': 'GR', 'SX': 'GR', 'SY': 'GR', 'SZ': 'GR', 'J4': 'GR',
  'YT': 'RS', 'YU': 'RS',
  // Asia / Pacific
  'JA': 'JP', 'JE': 'JP', 'JF': 'JP', 'JG': 'JP', 'JH': 'JP', 'JI': 'JP', 'JJ': 'JP', 'JK': 'JP', 'JL': 'JP', 'JM': 'JP', 'JN': 'JP', 'JO': 'JP', 'JP': 'JP', 'JQ': 'JP', 'JR': 'JP', 'JS': 'JP',
  '7J': 'JP', '7K': 'JP', '7L': 'JP', '7M': 'JP', '7N': 'JP', '8J': 'JP', '8N': 'JP',
  'VK': 'AU', 'VH': 'AU', 'VI': 'AU', 'VJ': 'AU', 'VL': 'AU', 'VM': 'AU', 'VN': 'AU', 'VZ': 'AU',
  'ZL': 'NZ', 'ZK': 'NZ', 'ZM': 'NZ',
  'HL': 'KR', 'DS': 'KR', 'DT': 'KR', '6K': 'KR', '6L': 'KR', '6M': 'KR', '6N': 'KR',
  'BV': 'TW', 'BM': 'TW', 'BN': 'TW', 'BO': 'TW', 'BP': 'TW', 'BQ': 'TW', 'BU': 'TW', 'BW': 'TW', 'BX': 'TW',
  'HS': 'TH', 'E2': 'TH',
  // South America, Africa
  'PY': 'BR', 'PP': 'BR', 'PQ': 'BR', 'PR': 'BR', 'PS': 'BR', 'PT': 'BR', 'PU': 'BR', 'PV': 'BR', 'PW': 'BR', 'PX': 'BR', 'ZV': 'BR', 'ZW': 'BR', 'ZX': 'BR', 'ZY': 'BR', 'ZZ': 'BR',
  'LU': 'AR', 'LO': 'AR', 'LP': 'AR', 'LQ': 'AR', 'LR': 'AR', 'LS': 'AR', 'LT': 'AR', 'LV': 'AR', 'LW': 'AR', 'AY': 'AR', 'AZ': 'AR', 'L2': 'AR', 'L3': 'AR', 'L4': 'AR', 'L5': 'AR', 'L6': 'AR', 'L7': 'AR', 'L8': 'AR', 'L9': 'AR',
  'CE': 'CL', 'CA': 'CL', 'CB': 'CL', 'CC': 'CL', 'CD': 'CL', 'XQ': 'CL', 'XR': 'CL', '3G': 'CL',
  'CX': 'UY', 'CV': 'UY', 'CW': 'UY',
  'HK': 'CO', 'HJ': 'CO', '5J': 'CO', '5K': 'CO',
  'ZS': 'ZA', 'ZR': 'ZA', 'ZT': 'ZA', 'ZU': 'ZA',
};

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Map a callsign to a POTA program code.
 * Tries longest prefix first (e.g. KP2 before K).
 */
function callsignToProgram(callsign) {
  if (!callsign) return '';
  const upper = callsign.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Try 3-char, 2-char, then 1-char prefixes
  for (let len = 3; len >= 1; len--) {
    const prefix = upper.substring(0, len);
    if (PREFIX_TO_PROGRAM[prefix]) return PREFIX_TO_PROGRAM[prefix];
  }
  return '';
}

/**
 * The POTA program a park reference belongs to: the part before the dash
 * (FI-0003 -> FI, US-1234 -> US). '' for anything that is not shaped like a
 * reference. This, not the operator's callsign, decides which country's park
 * list answers a lookup, so a traveller activating abroad is not stuck with
 * their home list.
 */
function programOfRef(ref) {
  const m = /^\s*([A-Z0-9]{1,4})-[A-Z0-9]+\s*$/i.exec(String(ref || ''));
  return m ? m[1].toUpperCase() : '';
}

/** POTA's practice reference (K-TEST, US-TEST): never in any park list. */
function isTestRef(ref) {
  return /^\s*[A-Z0-9]{1,4}-TEST\s*$/i.test(String(ref || ''));
}

/**
 * Fetch all parks for a POTA program from the API.
 */
function fetchParksForProgram(programCode) {
  return new Promise((resolve, reject) => {
    const url = `https://api.pota.app/program/parks/${encodeURIComponent(programCode)}`;
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`POTA API returned ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parks = JSON.parse(data);
          resolve(parks);
        } catch (e) {
          reject(new Error('Failed to parse parks JSON: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Get the cache file path for a program.
 */
function parksCachePath(userDataPath, programCode) {
  return path.join(userDataPath, `parks-${programCode}.json`);
}

/**
 * Load parks cache from disk.
 * Returns { parks: [...], updatedAt: timestamp } or null if not found.
 */
function loadParksCache(userDataPath, programCode) {
  const filePath = parksCachePath(userDataPath, programCode);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save parks cache to disk.
 */
function saveParksCache(userDataPath, programCode, parks) {
  const filePath = parksCachePath(userDataPath, programCode);
  const data = { parks, updatedAt: Date.now() };
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

/**
 * Check if cache is stale (>30 days old).
 */
function isCacheStale(updatedAt) {
  if (!updatedAt) return true;
  return (Date.now() - updatedAt) > CACHE_MAX_AGE_MS;
}

/**
 * Search parks array by reference or name substring.
 * Returns top 10 matches, prioritizing exact reference prefix match.
 */
function searchParks(parksArray, query) {
  if (!query || !parksArray) return [];
  const q = query.toUpperCase().trim();
  if (q.length < 2) return [];

  const refMatches = [];
  const nameMatches = [];

  for (const park of parksArray) {
    const ref = (park.reference || '').toUpperCase();
    const name = (park.name || '').toUpperCase();
    const loc = (park.locationDesc || '').toUpperCase();

    if (ref.startsWith(q)) {
      refMatches.push(park);
    } else if (ref.includes(q) || name.includes(q) || loc.includes(q)) {
      nameMatches.push(park);
    }

    // Early exit once we have enough
    if (refMatches.length >= 10) break;
  }

  return [...refMatches, ...nameMatches].slice(0, 10);
}

/**
 * Parks sorted by distance from a point — powers "Parks near me" one-tap
 * selection (activator-mode-plan.md Phase 1 item 8 / Phase 2 items 8-9).
 * Returns up to `limit` of [{...park, distanceMi, bearingDeg}], nearest
 * first. Parks without coordinates are skipped.
 */
function nearbyParks(parksArray, lat, lon, limit = 15) {
  if (!parksArray || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const { haversineDistanceMiles, bearing } = require('./grid');
  const out = [];
  for (const park of parksArray) {
    const plat = parseFloat(park.latitude);
    const plon = parseFloat(park.longitude);
    if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
    out.push({ park, d: haversineDistanceMiles(lat, lon, plat, plon), plat, plon });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, Math.max(1, limit)).map(({ park, d, plat, plon }) => ({
    ...park,
    distanceMi: Math.round(d * 10) / 10,
    bearingDeg: Math.round(bearing(lat, lon, plat, plon)),
  }));
}

/**
 * Get a single park by exact reference from a Map.
 */
function getPark(parksMap, reference) {
  if (!parksMap || !reference) return null;
  return parksMap.get(reference.toUpperCase()) || null;
}

/**
 * Build a Map<reference, parkData> from an array.
 */
function buildParksMap(parksArray) {
  const map = new Map();
  if (!parksArray) return map;
  for (const park of parksArray) {
    if (park.reference) {
      map.set(park.reference.toUpperCase(), park);
    }
  }
  return map;
}

module.exports = {
  PREFIX_TO_PROGRAM,
  callsignToProgram,
  programOfRef,
  isTestRef,
  fetchParksForProgram,
  loadParksCache,
  saveParksCache,
  isCacheStale,
  searchParks,
  nearbyParks,
  getPark,
  buildParksMap,
};
