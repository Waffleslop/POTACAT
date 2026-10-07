// Structured per-operation details for the DXpedition feed.
//
// Two inputs, two confidence levels:
//   - NG3K ADXO items: a fixed "--"-delimited description
//       "<dates> -- <entity> -- <CALL> -- QSL: <x> -- Source: <y> -- <free text>"
//     parsed field by field.
//   - News articles (DX-World, DXNews): free text, mined best-effort. Dates
//     found here are marked datesFrom: "article".
//
// Each source's parse is stored on the record under _d[source] and the
// public fields are combined at output time (combineDetails), NG3K first.
// DXCC entity/number come from the callsign via cty.csv (cty-data.js).

import { ENTITIES, PREFIXES, CALLS } from './cty-data.js';

// ---------- Callsigns ----------

// Bare callsign shapes:
//   1) Letter[Letter|Digit] Digit [Letter]{1,4}    — K3SBP, M0CFW, DL2SBY, WF2A
//   2) Digit Letter[Letter|Digit] [Digit] [Letter]{1,4}
//      — 3G0Z, 3B9KW, 4U1ITU, 9V1AB
const BARE_CALL_RE_1 = /^[A-Z][A-Z0-9]?\d[A-Z]{1,4}$/;
const BARE_CALL_RE_2 = /^\d[A-Z][A-Z0-9]?\d?[A-Z]{1,4}$/;

export function isBareCall(s) {
  if (!s || s.length < 3 || s.length > 8) return false;
  return BARE_CALL_RE_1.test(s) || BARE_CALL_RE_2.test(s);
}

// Portable / operating-condition suffixes that say nothing about location.
const SUFFIXES = new Set(['P', 'M', 'QRP', 'A', 'LH', 'LGT', 'J', 'R']);

// Callsign -> { entity, dxcc, continent } via cty.csv, or null.
// Slash forms: the prefix side decides (FP/WF2A -> St Pierre, 3B9/M0CFW ->
// Rodriguez); /MM and /AM are not on land; a lone digit (W1AW/4) keeps the
// base call's entity.
export function resolveEntity(call) {
  if (!call) return null;
  const c = String(call).toUpperCase().trim();
  if (CALLS[c] != null) return entityAt(CALLS[c]);
  let parts = c.split('/').filter(Boolean);
  if (parts.some((p) => p === 'MM' || p === 'AM')) return null;
  parts = parts.filter((p) => !SUFFIXES.has(p) && !/^\d$/.test(p));
  if (!parts.length) return null;
  let base;
  if (parts.length === 1) base = parts[0];
  else {
    // Prefix side = the part that isn't a full callsign, else the shorter.
    const nonCalls = parts.filter((p) => !isBareCall(p));
    base = nonCalls.length ? nonCalls[0] : parts.slice().sort((a, b) => a.length - b.length)[0];
  }
  if (CALLS[base] != null) return entityAt(CALLS[base]);
  for (let n = Math.min(base.length, 7); n >= 1; n--) {
    const idx = PREFIXES[base.slice(0, n)];
    if (idx != null) return entityAt(idx);
  }
  return null;
}

function entityAt(idx) {
  const e = ENTITIES[idx];
  return e ? { entity: e[0], dxcc: e[1], continent: e[2] } : null;
}

const nameKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(of|the|i|is|island|islands)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
const ENTITY_BY_NAME = new Map(ENTITIES.map((e, i) => [nameKey(e[0]), i]));

// NG3K writes short entity names ("Solomon Is", "Dem Rep Congo").
export function resolveEntityName(name) {
  const idx = ENTITY_BY_NAME.get(nameKey(name));
  return idx == null ? null : entityAt(idx);
}

// ---------- Dates ----------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const monthNum = (s) => MONTHS[String(s).toLowerCase().slice(0, 3)] || MONTHS[String(s).toLowerCase().slice(0, 4)];

function iso(y, m, d) {
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCDate() !== d) return null; // Feb 30 etc.
  return dt.toISOString().slice(0, 10);
}

// NG3K date field: "Oct 1-7, 2026", "Aug 25-Oct 10, 2026",
// "Dec 23, 2026-Jan 6, 2027", "Oct 7, 2026".
export function parseNg3kDates(s) {
  const t = String(s || '').trim();
  let m = t.match(new RegExp(`^${MON}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s*-\\s*(?:${MON}\\s+)?(\\d{1,2}),\\s*(\\d{4})$`, 'i'));
  if (m) {
    const m1 = monthNum(m[1]);
    const m2 = m[4] ? monthNum(m[4]) : m1;
    const y2 = +m[6];
    const y1 = m[3] ? +m[3] : (m1 > m2 ? y2 - 1 : y2);
    return { start: iso(y1, m1, +m[2]), end: iso(y2, m2, +m[5]) };
  }
  m = t.match(new RegExp(`^${MON}\\s+(\\d{1,2}),\\s*(\\d{4})$`, 'i'));
  if (m) {
    const d = iso(+m[3], monthNum(m[1]), +m[2]);
    return { start: d, end: d };
  }
  return { start: null, end: null };
}

// Article text, best effort. Looks for a range first ("October 9-20",
// "9-20 October", "from October 9 to October 20", "between 9 and 20
// October"), then a start plus an "until <date>". Years come from the text
// or are inferred from the publish date (a month well before it means next
// year).
export function parseArticleDates(text, publishedAt) {
  const s = String(text || '').replace(/(\d)(?:st|nd|rd|th)\b/g, '$1').replace(/\s+/g, ' ');
  const pub = new Date(Date.parse(publishedAt) || Date.now());
  const yearFor = (mon, explicit) => {
    if (explicit) return +explicit;
    const y = pub.getUTCFullYear();
    return mon < pub.getUTCMonth() + 1 - 2 ? y + 1 : y;
  };
  const D = '(\\d{1,2})';
  const Y = '(?:,?\\s*(\\d{4}))?';
  const SEP = '\\s*(?:-|–|—|to|until|till|thru|through|and)\\s*';
  const tries = [
    // October 9 - October 20, 2026 / October 9-20, 2026 / Oct 9/10 - 20
    [new RegExp(`${MON}\\s+${D}(?:/\\d{1,2})?${Y}${SEP}(?:${MON}\\s+)?${D}${Y}`, 'i'),
      (m) => [monthNum(m[1]), +m[2], m[3], m[4] ? monthNum(m[4]) : monthNum(m[1]), +m[5], m[6]]],
    // 9 October - 20 October 2026 / 9-20 October 2026
    [new RegExp(`\\b${D}(?:\\s+${MON})?${Y}${SEP}${D}\\s+${MON}${Y}`, 'i'),
      (m) => [m[2] ? monthNum(m[2]) : monthNum(m[5]), +m[1], m[3], monthNum(m[5]), +m[4], m[6]]],
  ];
  for (const [re, pick] of tries) {
    const m = s.match(re);
    if (!m) continue;
    const [m1, d1, y1x, m2, d2, y2x] = pick(m);
    if (!m1 || !m2 || d1 > 31 || d2 > 31) continue;
    const y2 = yearFor(m2, y2x || y1x);
    const y1 = y1x ? +y1x : (m1 > m2 ? y2 - 1 : y2);
    const start = iso(y1, m1, d1);
    const end = iso(y2, m2, d2);
    if (start && end && start <= end) return { start, end };
  }
  // "on October 9/10 ... until October 20"
  const startM = s.match(new RegExp(`\\b(?:on|from|starting|start(?:s|ing)? on|arriv\\w*(?: on)?)\\s+${MON}\\s+${D}${Y}`, 'i'));
  const endM = s.match(new RegExp(`\\b(?:until|till|through|to)\\s+${MON}\\s+${D}${Y}`, 'i'));
  if (startM || endM) {
    let start = null;
    let end = null;
    if (startM) { const mo = monthNum(startM[1]); start = iso(yearFor(mo, startM[3]), mo, +startM[2]); }
    if (endM) { const mo = monthNum(endM[1]); end = iso(yearFor(mo, endM[3]), mo, +endM[2]); }
    if (start && end && start > end) end = null;
    return { start, end };
  }
  return { start: null, end: null };
}

// ---------- Bands / modes / refs ----------

const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm'];
const RANGE_SKIP = new Set(['60m', '4m']); // only when named outright

export function parseBands(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/\b(160|80|60|40|30|20|17|15|12|10|6|4|2)\s*-\s*(160|80|60|40|30|20|17|15|12|10|6|4|2)\s*m\b/gi)) {
    let a = BANDS.indexOf(`${m[1]}m`);
    let b = BANDS.indexOf(`${m[2]}m`);
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i++) if (i === a || i === b || !RANGE_SKIP.has(BANDS[i])) out.add(BANDS[i]);
  }
  // Lists like "80 40 60m", "40, 20 & 10m", "20/15/10m" — the "m" sits on
  // the last number only.
  for (const m of s.matchAll(/\b((?:(?:160|80|60|40|30|20|17|15|12|10|6|4|2)\s*(?:,|\/|&|and|\s)\s*)+)(160|80|60|40|30|20|17|15|12|10|6|4|2)\s*m\b/gi)) {
    for (const n of m[1].match(/\d+/g) || []) out.add(`${n}m`);
    out.add(`${m[2]}m`);
  }
  for (const m of s.matchAll(/\b(160|80|60|40|30|20|17|15|12|10|6|4|2)\s?m(?:eters?|tr)?\b/gi)) out.add(`${m[1]}m`);
  if (/\b70\s?cm\b/i.test(s)) out.add('70cm');
  return BANDS.filter((b) => out.has(b));
}

const MODE_PATTERNS = [
  ['CW', /\bCW\b/], ['SSB', /\bSSB\b|\bphone\b/i], ['FT8', /\bFT8\b|\bF\/H\b|\bfox\s*\/?\s*hound\b/i],
  ['FT4', /\bFT4\b/], ['RTTY', /\bRTTY\b/], ['PSK', /\bPSK(?:31|63)?\b/], ['FM', /\bFM\b/],
  ['AM', /\bAM\b(?!\s*\d)/], ['SSTV', /\bSSTV\b/], ['Q65', /\bQ65\b/], ['JT65', /\bJT65\b/],
  ['MSK144', /\bMSK144\b/], ['SAT', /\bSAT\b|\b[Ss]atellite\b|\bQO-100\b/], ['DIGI', /\bdigi(?:tal|modes?)?\b/i],
];

export function parseModes(text) {
  // "QRV in CQWW RTTY Contest" names a contest, not the operation's modes.
  const s = String(text || '').replace(/(?:\S+\s+){0,3}Contest\b/gi, ' ');
  return MODE_PATTERNS.filter(([, re]) => re.test(s)).map(([m]) => m);
}

const IOTA_RE = /\b(AF|AN|AS|EU|NA|OC|SA)-(\d{3})\b/g;
export function parseIota(text) {
  return [...new Set([...String(text || '').matchAll(IOTA_RE)].map((m) => `${m[1]}-${m[2]}`))];
}

// POTA refs only when the text talks about POTA at all; the bare shape
// (XX-1234) also matches WWFF and other programs.
export function parsePota(text) {
  const s = String(text || '');
  if (!/\bPOTA\b|parks on the air/i.test(s)) return [];
  return [...new Set([...s.matchAll(/\b([A-Z]{1,4}-\d{4,5})\b/g)].map((m) => m[1]).filter((r) => !/FF-/.test(r)))];
}

export function parseGrid(text) {
  const s = String(text || '');
  const m = s.match(/\b([A-R]{2}\d{2}[a-x]{2})\b/) || s.match(/\b(?:grid|locator|loc)\s*:?\s*([A-R]{2}\d{2}(?:[a-x]{2})?)\b/i);
  return m ? m[1] : null;
}

// ---------- QSL ----------

// `field` is NG3K's QSL field when there is one; `text` is free text, of
// which only the sentences that mention QSL routing are read.
export function parseQsl(field, text) {
  const bits = [];
  if (field && !/^(TBA|See Info|As Directed)$/i.test(field.trim())) bits.push(field.trim());
  for (const sent of String(text || '').split(/(?<=[.;])\s+|;\s*/)) {
    if (/\bQSL|\bOQRS\b|\bLoTW\b|\bClub ?Log\b/i.test(sent)) bits.push(sent.trim());
  }
  if (!bits.length) return null;
  const raw = [...new Set(bits)].join('; ').slice(0, 300);
  let via = null;
  const viaM = raw.match(/\bQSL\s*(?:via|manager|mgr|:)?\s*:?\s*([A-Z0-9/]{3,12})\b/i);
  if (viaM && isBareCall(viaM[1].toUpperCase().split('/').pop())) via = viaM[1].toUpperCase();
  else if (field) {
    const tok = field.trim().split(/\s+/)[0].toUpperCase();
    if (isBareCall(tok)) via = tok;
  }
  const paren = (raw.match(/\(([Bd](?:\/[Bd])?)\)/) || [])[1] || '';
  return {
    via,
    lotw: /\bLoTW\b/i.test(raw),
    oqrs: /\bOQRS\b/i.test(raw),
    direct: /\bdirect\b/i.test(raw) || /d/.test(paren),
    buro: /\bbur(?:o|eau)\b/i.test(raw) || /B/.test(paren),
    raw,
  };
}

// ---------- Links ----------

const NOT_OP_SITES = /(^|\.)(dx-world\.net|dxnews\.com|ng3k\.com|facebook\.com|twitter\.com|x\.com|google\.[a-z.]+|gravatar\.com|wordpress\.(com|org)|wp\.com|dxengineering\.com|youtube\.com|clublog\.org)$/i;

export function classifyLinks(urls) {
  let website = null;
  let qrz = null;
  for (const u of urls) {
    let host;
    try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; }
    if (/(^|\.)qrz\.com$/i.test(host)) { if (!qrz && /\/db\//i.test(u)) qrz = u; continue; }
    if (NOT_OP_SITES.test(host)) continue;
    if (/\.(png|jpe?g|gif|webp|pdf)(\?|$)/i.test(u)) continue;
    if (!website) website = u;
  }
  return { website, qrz };
}

// ---------- Per-source parses ----------

// NG3K: raw <description> plus the item link.
export function parseNg3kItem(rawDescription, link) {
  const parts = String(rawDescription || '').split(/\s*--\s*/).map((p) => p.trim());
  const [dates, entityName, , qslField, , ...rest] = parts;
  const notes = rest.join(' -- ').trim();
  const { start, end } = parseNg3kDates(dates);
  const opsM = notes.match(/^By\s+(.+?)(?:\s+fm\b|;|$)/i);
  const operators = opsM
    ? [...new Set(opsM[1].toUpperCase().split(/[\s,&]+/).filter((t) => isBareCall(t.split('/').pop())))]
    : [];
  return {
    entityName: entityName || null,
    start,
    end,
    qsl: parseQsl((qslField || '').replace(/^QSL:\s*/i, ''), notes),
    ...classifyLinks(link ? [link] : []),
    iota: parseIota(notes),
    pota: parsePota(notes),
    grid: parseGrid(notes),
    bands: parseBands(notes),
    modes: parseModes(notes),
    operators,
    notes: notes || null,
  };
}

// News article: plain text body plus the hrefs found in it.
export function parseArticle(text, hrefs, publishedAt) {
  const { start, end } = parseArticleDates(text, publishedAt);
  return {
    entityName: null,
    start,
    end,
    qsl: parseQsl(null, text),
    ...classifyLinks(hrefs || []),
    iota: parseIota(text),
    pota: parsePota(text),
    grid: parseGrid(text),
    bands: parseBands(text),
    modes: parseModes(text),
    operators: [],
    notes: null,
  };
}

// Article page -> { text, hrefs }. WordPress body sits in .entry-content
// (DX-World); falls back to <article>, then the whole page.
export function extractArticle(html) {
  const h = String(html || '');
  let body = '';
  const i = h.indexOf('entry-content');
  if (i >= 0) {
    const start = h.indexOf('>', i) + 1;
    const stopAt = ['post-footer', 'sharedaddy', '</article>'].map((k) => h.indexOf(k, start)).filter((n) => n > 0);
    body = h.slice(start, stopAt.length ? Math.min(...stopAt) : start + 20000);
  } else {
    const m = h.match(/<article\b[\s\S]*?<\/article>/i);
    body = m ? m[0] : h.slice(0, 20000);
  }
  body = body.replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, ' ');
  // Links whose anchor is only an image are sponsor banners.
  const hrefs = [];
  for (const m of body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (/^\s*<img\b[^>]*>\s*$/i.test(m[2])) continue;
    if (/^https?:/i.test(m[1])) hrefs.push(m[1].replace(/&amp;/g, '&'));
  }
  const text = body
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { text: text.slice(0, 6000), hrefs };
}

// ---------- Combine ----------

const DETAIL_ORDER = ['ng3k', 'dx-world', 'dxnews'];

// Public fields for one record from its per-source parses. Scalars: first
// source in DETAIL_ORDER that has a value. Lists: NG3K's if non-empty,
// else the union of the articles'. Dates come as a pair from one source.
export function combineDetails(call, d) {
  const srcs = DETAIL_ORDER.filter((k) => d && d[k]).map((k) => [k, d[k]]);
  const first = (f) => { for (const [, v] of srcs) if (v[f] != null && v[f] !== '') return v[f]; return null; };
  const list = (f) => {
    for (const [k, v] of srcs) if (k === 'ng3k' && v[f] && v[f].length) return v[f];
    return [...new Set(srcs.flatMap(([, v]) => v[f] || []))];
  };
  let start = null;
  let end = null;
  let datesFrom = null;
  for (const [k, v] of srcs) {
    if (v.start || v.end) { start = v.start; end = v.end; datesFrom = k === 'ng3k' ? 'ng3k' : 'article'; break; }
  }
  const byCall = resolveEntity(call);
  const ngName = first('entityName');
  // NG3K's named entity overrides the prefix guess when it resolves (TO,
  // FO, VP8 and friends are ambiguous by prefix alone).
  const byName = ngName ? resolveEntityName(ngName) : null;
  const ent = byName || byCall;
  const bands = list('bands');
  const modes = list('modes');
  return {
    entity: ent ? ent.entity : ngName,
    dxcc: ent ? ent.dxcc : null,
    continent: ent ? ent.continent : null,
    start,
    end,
    datesFrom,
    qsl: first('qsl'),
    website: first('website'),
    qrz: first('qrz'),
    iota: list('iota'),
    pota: list('pota'),
    grid: first('grid'),
    bands,
    modes,
    operators: list('operators'),
    notes: first('notes'),
  };
}
