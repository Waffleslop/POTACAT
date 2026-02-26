'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// Map callsign prefix → POTA program code
const PREFIX_TO_PROGRAM = {
  // North America
  'K': 'US', 'W': 'US', 'N': 'US', 'AA': 'US', 'AB': 'US', 'AC': 'US', 'AD': 'US', 'AE': 'US', 'AF': 'US', 'AG': 'US',
  'AH': 'US', 'AI': 'US', 'AJ': 'US', 'AK': 'US', 'AL': 'US', 'KP2': 'US', 'KP4': 'US', 'KH6': 'US',
  'VE': 'CA', 'VA': 'CA', 'VY': 'CA', 'VO': 'CA', 'CF': 'CA', 'CG': 'CA', 'CI': 'CA', 'CJ': 'CA', 'CK': 'CA', 'CY': 'CA', 'CZ': 'CA',
  'XE': 'MX', 'XA': 'MX', 'XB': 'MX', 'XC': 'MX', 'XD': 'MX',
  // Europe
  'G': 'GB', 'M': 'GB', '2E': 'GB',
  'DL': 'DL', 'DA': 'DL', 'DB': 'DL', 'DC': 'DL', 'DD': 'DL', 'DE': 'DL', 'DF': 'DL', 'DG': 'DL', 'DH': 'DL', 'DJ': 'DL', 'DK': 'DL', 'DM': 'DL', 'DN': 'DL', 'DO': 'DL',
  'F': 'F',
  'I': 'I', 'IK': 'I', 'IU': 'I', 'IW': 'I', 'IZ': 'I',
  'EA': 'EA',
  'PA': 'PA', 'PB': 'PA', 'PD': 'PA', 'PE': 'PA', 'PH': 'PA', 'PI': 'PA',
  'ON': 'ON',
  'OZ': 'OZ',
  'SM': 'SM', 'SA': 'SM', 'SB': 'SM', 'SC': 'SM', 'SD': 'SM', 'SE': 'SM', 'SF': 'SM', 'SG': 'SM', 'SH': 'SM', 'SI': 'SM', 'SJ': 'SM', 'SK': 'SM',
  'LA': 'LA', 'LB': 'LA', 'LC': 'LA',
  'OH': 'OH',
  'OE': 'OE',
  'HB': 'HB', 'HB9': 'HB',
  'OK': 'OK', 'OL': 'OK',
  'SP': 'SP', 'SQ': 'SP', 'SO': 'SP', 'SN': 'SP',
  'HA': 'HA', 'HG': 'HA',
  'YO': 'YO',
  'LZ': 'LZ',
  'S5': 'S5',
  '9A': '9A',
  'OY': 'OY',
  'TF': 'TF',
  'EI': 'EI',
  'CT': 'CT',
  'SV': 'SV',
  'YU': 'YU',
  // Asia-Pacific
  'JA': 'JA', 'JH': 'JA', 'JE': 'JA', 'JF': 'JA', 'JG': 'JA', 'JI': 'JA', 'JJ': 'JA', 'JK': 'JA', 'JL': 'JA', 'JM': 'JA', 'JN': 'JA', 'JO': 'JA', 'JP': 'JA', 'JQ': 'JA', 'JR': 'JA', 'JS': 'JA',
  'VK': 'VK',
  'ZL': 'ZL',
  'HL': 'HL', 'DS': 'HL',
  'BV': 'BV',
  'HS': 'HS',
  // South America
  'PY': 'PY', 'PP': 'PY', 'PQ': 'PY', 'PR': 'PY', 'PS': 'PY', 'PT': 'PY', 'PU': 'PY', 'PV': 'PY', 'PW': 'PY', 'PX': 'PY',
  'LU': 'LU',
  'CE': 'CE',
  'CX': 'CX',
  'HK': 'HK',
  // Africa
  'ZS': 'ZS',
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
  callsignToProgram,
  fetchParksForProgram,
  loadParksCache,
  saveParksCache,
  isCacheStale,
  searchParks,
  getPark,
  buildParksMap,
};
