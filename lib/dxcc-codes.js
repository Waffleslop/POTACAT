'use strict';
// cty.dat entity name -> ADIF DXCC entity code (GitHub #554).
//
// Source of the codes: the ADIF Specification, version 3.1.8 (updated
// 2026-10-12), section III.B.8 "DXCC Entity Code Enumeration"
// (Enumeration_DXCC_Entity_Code), https://adif.org/318/ADIF_318.htm, fetched
// 2026-11-14 into data/adif-dxcc-entities.json. When a new ADIF version adds
// or renames an entity, refresh that file from the same table.
//
// cty.dat (AD1C) names entities its own way ("United States", "European
// Russia", "Easter Island"); ADIF names them in capitals with its own
// abbreviations ("UNITED STATES OF AMERICA", "EUROPEAN RUSSIA", "EASTER I.").
// Most names match once both are normalised (case, punctuation, "Island" as
// "I.", "Islands" as "IS.", "St." as "Saint"). The rest are listed in
// CTY_ALIASES by hand, each with its code.
//
// cty.dat also carries six entities that are on the CQ WAE list but are not
// DXCC entities (marked "*" in cty.dat). Each sits inside one DXCC entity, so
// it takes that entity's code: a Sicily contact is DXCC 248, Italy, which is
// what LoTW and QRZ give it. They are in WAE_PARENT. NOT_DXCC holds a name
// that must deliberately get no code; it is empty for the cty.dat we ship,
// and test/dxcc-codes-test.js fails when a cty.dat name is in neither place.

const TABLE = require('../data/adif-dxcc-entities.json');

// cty.dat name -> code, where normalising the two names does not make them equal.
const CTY_ALIASES = Object.freeze({
  'United States': 291,             // UNITED STATES OF AMERICA
  'Sov Mil Order of Malta': 246,    // SOVEREIGN MILITARY ORDER OF MALTA
  'Agalega & St. Brandon': 4,       // AGALEGA & ST. BRANDON IS.
  'Rodriguez Island': 207,          // RODRIGUES I.
  'Vietnam': 293,                   // VIET NAM
  'Dem. Rep. of the Congo': 414,    // DEMOCRATIC REPUBLIC OF THE CONGO
  'Fed. Rep. of Germany': 230,      // FEDERAL REPUBLIC OF GERMANY
  'Vatican City': 295,              // VATICAN
  'US Virgin Islands': 285,         // VIRGIN IS.
  'DPR of Korea': 344,              // DEMOCRATIC PEOPLE'S REP. OF KOREA
  'St. Peter & St. Paul': 253,      // ST. PETER & ST. PAUL ROCKS
  'Western Kiribati': 301,          // W. KIRIBATI (GILBERT IS. )
  'Central Kiribati': 31,           // C. KIRIBATI (BRITISH PHOENIX IS.)
  'Eastern Kiribati': 48,           // E. KIRIBATI (LINE IS.)
  'Banaba Island': 490,             // BANABA I. (OCEAN I.)
  'Asiatic Turkey': 390,            // TURKEY
  'Central African Republic': 408,  // CENTRAL AFRICA
  'North Macedonia': 502,           // NORTH MACEDONIA (REPUBLIC OF)
  'Republic of South Sudan': 521,   // SOUTH SUDAN (REPUBLIC OF)
  'UK Base Areas on Cyprus': 283,   // UK SOVEREIGN BASE AREAS ON CYPRUS
  'N.Z. Subantarctic Is.': 16,      // NEW ZEALAND SUBANTARCTIC ISLANDS
  'South Africa': 462,              // REPUBLIC OF SOUTH AFRICA
  'Pr. Edward & Marion Is.': 201,   // PRINCE EDWARD & MARION IS.
  'Trindade & Martim Vaz': 273,     // TRINDADE & MARTIM VAZ IS.
  'Austral Islands': 508,           // AUSTRAL I.
  'Tristan da Cunha & Gough': 274,  // TRISTAN DA CUNHA & GOUGH I.
});

// cty.dat's WAE-only entities -> the DXCC entity each lies in.
const WAE_PARENT = Object.freeze({
  'Vienna Intl Ctr': 206,   // 4U1V: AUSTRIA (4U1VIC counts for Austria)
  'Shetland Islands': 279,  // GM/s: SCOTLAND
  'African Italy': 248,     // IG9: ITALY
  'Sicily': 248,            // IT9: ITALY
  'Bear Island': 259,       // JW/b: SVALBARD
  'European Turkey': 390,   // TA1: TURKEY
});

// cty.dat names that deliberately get no DXCC code.
const NOT_DXCC = Object.freeze([]);

function normName(s) {
  return String(s || '').toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\bISLANDS\b/g, 'IS')
    .replace(/\bISLAND\b/g, 'I')
    .replace(/\bST\b\.?/g, 'SAINT')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const BY_CODE = new Map();
const BY_NORM = new Map();
for (const [code, name, deleted] of TABLE.entities) {
  BY_CODE.set(code, { code, name, deleted: !!deleted });
  // Current entities only: a deleted entity never names a new contact.
  if (!deleted) BY_NORM.set(normName(name), code);
}

/**
 * The ADIF DXCC entity code for a cty.dat entity name (or an ADIF entity
 * name), or null when it has none or the name is unknown.
 */
function dxccCodeForEntity(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (Object.prototype.hasOwnProperty.call(CTY_ALIASES, n)) return CTY_ALIASES[n];
  if (Object.prototype.hasOwnProperty.call(WAE_PARENT, n)) return WAE_PARENT[n];
  if (NOT_DXCC.includes(n)) return null;
  const code = BY_NORM.get(normName(n));
  return code == null ? null : code;
}

/** The ADIF entity record for a code: { code, name, deleted }, or null. */
function adifEntity(code) {
  return BY_CODE.get(Number(code)) || null;
}

module.exports = { dxccCodeForEntity, adifEntity, normName, CTY_ALIASES, WAE_PARENT, NOT_DXCC, ADIF_SOURCE: TABLE.source };
