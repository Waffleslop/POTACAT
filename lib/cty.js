'use strict';

const fs = require('fs');

/**
 * Parse a cty.dat file into a database of DXCC entities and prefix mappings.
 *
 * cty.dat format (per entity block):
 *   Line 1: Name: CQ-Zone: ITU-Zone: Continent: Lat: Lon: UTC-offset: Primary-Prefix:
 *   Line 2+: Comma-separated prefix list ending with semicolon
 *   Prefixes starting with '=' are exact-match callsigns
 *   Prefixes may have modifiers in parentheses/brackets (ignored here)
 */
function loadCtyDat(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const entities = [];
  const prefixMap = {};  // prefix → entity number
  const exactMap = {};   // exact callsign → entity number

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    // Entity header lines start in column 1 (not whitespace)
    if (!line || line.startsWith(' ') || line.startsWith('\t')) {
      i++;
      continue;
    }

    // Parse entity header: fields separated by colons
    const parts = line.split(':').map((s) => s.trim());
    if (parts.length < 8) {
      i++;
      continue;
    }

    const entity = {
      name: parts[0],
      cqZone: parseInt(parts[1], 10),
      ituZone: parseInt(parts[2], 10),
      continent: parts[3],
      lat: parseFloat(parts[4]),
      lon: -parseFloat(parts[5]),  // cty.dat stores West longitude as positive
      utcOffset: parseFloat(parts[6]),
      prefix: parts[7].replace('*', ''),  // primary prefix, strip * marker
    };

    // Entity number = index in array (we'll assign DXCC numbers from prefix lookups)
    const entIdx = entities.length;
    entities.push(entity);

    // Primary prefix maps to this entity
    prefixMap[entity.prefix.toUpperCase()] = entIdx;

    // Collect prefix lines (indented, ending with semicolon)
    i++;
    let prefixBlock = '';
    while (i < lines.length) {
      const pl = lines[i];
      if (!pl.startsWith(' ') && !pl.startsWith('\t') && pl.trim().length > 0 && !pl.trim().startsWith(',')) {
        break;
      }
      prefixBlock += pl;
      const done = pl.trimEnd().endsWith(';');
      i++;
      if (done) break;
    }

    // Parse prefix list
    prefixBlock = prefixBlock.replace(/;$/, '');
    const prefixes = prefixBlock.split(',').map((p) => p.trim()).filter(Boolean);

    for (const raw of prefixes) {
      // Strip modifiers in parentheses and brackets: (CQ-zone), [ITU-zone], etc.
      let clean = raw.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '').trim();
      if (!clean) continue;

      if (clean.startsWith('=')) {
        // Exact match callsign
        exactMap[clean.substring(1).toUpperCase()] = entIdx;
      } else {
        prefixMap[clean.toUpperCase()] = entIdx;
      }
    }
  }

  return { entities, prefixMap, exactMap };
}

/**
 * Resolve a callsign to a DXCC entity index using the cty.dat database.
 * Returns the entity object or null.
 */
function resolveCallsign(call, db) {
  if (!call || !db) return null;
  const uc = call.toUpperCase().replace(/\/P$|\/M$|\/QRP$|\/MM$|\/AM$/i, '');

  // Check exact match first
  if (db.exactMap[uc] != null) {
    return db.entities[db.exactMap[uc]];
  }

  // Longest prefix match
  let best = null;
  let bestLen = 0;
  for (let len = uc.length; len >= 1; len--) {
    const prefix = uc.substring(0, len);
    if (db.prefixMap[prefix] != null) {
      if (len > bestLen) {
        bestLen = len;
        best = db.prefixMap[prefix];
      }
      break;  // Since we're going from longest to shortest, first match wins
    }
  }

  return best != null ? db.entities[best] : null;
}

/**
 * Get all entities sorted by name.
 */
function getAllEntities(db) {
  return db.entities.slice().sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { loadCtyDat, resolveCallsign, getAllEntities };
