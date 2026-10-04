'use strict';
// JTTY source coding: text <-> 34-bit frames.
//
// A port of WSJT-X lib/jtty/jtty_source_codec.f90 and the pack_jtty /
// unpack_jtty / normalize_jtty_message routines of lib/jtty/jtty_mod.f90, at
// tag v3.2.0-rc1 (GPL-3.0, Joe Taylor K1JT and the WSJT-X team). The
// normative description is lib/jtty/jtty_source_encoding.txt in that tree;
// its "Representative 34-bit vectors" are test/jtty-codec-test.js's golden
// cases. JTTY is a release candidate: the wire format changed once during
// development with no discriminator, so this file is pinned to the tag below
// and must be re-checked against 3.2.0 final.
//
// A frame is 34 bits: a 32-bit source word, a reserved bit (always 0) and an
// end-of-message bit. The 32-bit word's two LOW bits select the type:
//   i2=0,1  call actions   28-bit standard callsign (FT8's pack28) + 2-bit
//                          action (CQ <call> CQ, <call>, TU <call> CQ,
//                          <call> TU, <call> AGN?, TU NOW <call>)
//   i2=2    STRUCT30       27-bit family body + 3-bit family selector
//   i2=3    TEXT5          five six-bit characters of ALPHABET
// Frames here are strings of 34 '0'/'1' characters, MSB first, exactly as the
// Fortran's character(len=34), so the two can be compared byte for byte.

const JTTY_SPEC_TAG = 'v3.2.0-rc1';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-./?!"#$%,&*()_\'=[]{}<>|:;';
if (ALPHABET.length !== 64) throw new Error('JTTY alphabet must have 64 symbols');

const MAX_FRAMES = 16;
const MAX_MESSAGE = 80; // character*80 in the reference

const ATOM = { CALL: 0, EXCH_NUM: 1, EXCH_LOC: 2, EXCH_PAIR: 3, EXCH_NUM_TIME: 4, CONTROL: 5, GRID4: 6, TEXT5: 7 };
const CALL = { CQ: 0, CALL: 1, TU_CQ: 2, CALL_TU: 3, CALL_AGN: 4, TU_NOW: 5 };
const ROLE = { FIELD_ONLY: 0, FULL: 1 };
const NUM = { SERIAL: 0, CQ_ZONE: 1, ITU_ZONE: 2, AGE: 3, POWER: 4, CHECK: 5, LICENSE_YEAR: 6, GENERIC: 7 };
const LOC = { STATE_PROVINCE: 0, SECTION: 1, COUNTRY_PREFIX: 2, QTH: 3, ADMIN_CODE: 4 };
const PAIR = { ZONE_LOC3: 0, CLASS_SECTION: 1 };
const MISC = { CONTROL: 0, GRID4: 1 };
const PROFILE = { UNKNOWN: 0, FIELD_DAY: 1, RTTY: 2 };

const CONTROL_TEXT = ['AGN?', 'CALL?', 'AGN CALL', 'NR?', 'AGN NR', 'EXCH?', 'STATE?', 'SECTION?',
  'ZONE?', 'GRID?', 'RPRT?', 'QSL TU', 'TU', 'QRZ?', 'QSO B4', 'WAIT', 'NIL?', 'OK?'];

// PACK77_ARRL_SECTIONS at v3.2.0-rc1 (lib/77bit/packjt77_grammar.f90): 86
// entries, 1-indexed on the wire. NOT the 84-entry FT8 table in
// lib/ft8_native (GH/NS/TER replace GTA/MAR/NT; PE and NB are appended), so
// the index is kept here verbatim rather than shared.
const ARRL_SECTIONS = [
  'AB', 'AK', 'AL', 'AR', 'AZ', 'BC', 'CO', 'CT', 'DE', 'EB',
  'EMA', 'ENY', 'EPA', 'EWA', 'GA', 'GH', 'IA', 'ID', 'IL', 'IN',
  'KS', 'KY', 'LA', 'LAX', 'NS', 'MB', 'MDC', 'ME', 'MI', 'MN',
  'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NFL', 'NH', 'NL', 'NLI',
  'NM', 'NNJ', 'NNY', 'TER', 'NTX', 'NV', 'OH', 'OK', 'ONE', 'ONN',
  'ONS', 'OR', 'ORG', 'PAC', 'PR', 'QC', 'RI', 'SB', 'SC', 'SCV',
  'SD', 'SDG', 'SF', 'SFL', 'SJV', 'SK', 'SNJ', 'STX', 'SV', 'TN',
  'UT', 'VA', 'VI', 'VT', 'WCF', 'WI', 'WMA', 'WNY', 'WPA', 'WTX',
  'WV', 'WWA', 'WY', 'DX', 'PE', 'NB',
];
const NSEC = ARRL_SECTIONS.length;

/** 1-based section index, or -1 (pack77_arrl_section_index). */
function sectionIndex(token) {
  const t = String(token || '');
  if (t.length < 2) return -1;
  const i = ARRL_SECTIONS.indexOf(t.length > 3 ? t.slice(0, 3) : t);
  return i < 0 ? -1 : i + 1;
}

// ---------------------------------------------------------------------------
// The FT8 28-bit standard-callsign codec (lib/77bit/packjt77.f90 pack28 /
// unpack28), standard calls only. JTTY never hashes a call: a token that is
// not a standard call is sent as TEXT5, so the hash paths are not ported.
const PACK77_NTOKENS = 2063592;
const PACK77_MAX22 = 4194304;
const A1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const A2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const A3 = '0123456789';
const A4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const isDigit = (c) => c >= '0' && c <= '9';
const isLetter = (c) => c >= 'A' && c <= 'Z';

/** pack77_c28_standard_shape: can this token ride the 28-bit standard field? */
function c28StandardShape(token) {
  const n = token.length;
  if (n < 3 || n > 6) return false;
  for (const c of token) if (!isLetter(c) && !isDigit(c)) return false;
  let iarea = 0; // 1-based position of the last digit, searched down to position 2
  for (let i = n; i >= 2; i--) if (isDigit(token[i - 1])) { iarea = i; break; }
  if (iarea !== 2 && iarea !== 3) return false;
  let npdig = 0, nplet = 0;
  for (let i = 1; i < iarea; i++) { if (isDigit(token[i - 1])) npdig++; else nplet++; }
  if (nplet === 0 || npdig >= iarea - 1) return false;
  let nslet = 0;
  for (let i = iarea + 1; i <= n; i++) { if (!isLetter(token[i - 1])) return false; nslet++; }
  return nslet <= 3;
}

/** chkcall for a token with no '/': base-call syntax. */
function chkcall(w) {
  const n1 = w.length;
  if (n1 > 11 || /[.+\-?]/.test(w)) return false;
  if (n1 > 6 && w.indexOf('/') < 0) return false;
  if (w.indexOf('/') >= 0) return false; // JTTY standard_call rejects compound calls anyway
  const bc = w.slice(0, 6);
  const nbc = bc.length;
  if (!isLetter(bc[0] || '') && !isLetter(bc[1] || '')) return false;
  if (bc[0] === 'Q' && bc.slice(0, 5) !== 'QU1RK') return false;
  let i1 = 0;
  if (isDigit(bc[1] || '')) i1 = 2;
  if (isDigit(bc[2] || '')) i1 = 3;
  if (i1 === 0) return false;
  if (i1 === nbc) return false;
  let n = 0;
  for (let i = i1 + 1; i <= nbc; i++) { if (!isLetter(bc[i - 1])) return false; n++; }
  return n >= 1 && n <= 3;
}

/** callok (packjt77.f90): what unpack28 accepts back. */
function callok(w) {
  const n = w.length;
  if (n < 3 || w[0] === 'Q') return false;
  let i0 = 0;
  for (let i = n; i >= 1; i--) if (isDigit(w[i - 1])) { i0 = i; break; }
  if (i0 !== 2 && i0 !== 3) return false;
  const pfx = w.slice(0, i0 - 1);
  let nlp = 0, ndp = 0;
  for (const c of pfx) { if (isDigit(c)) ndp++; if (isLetter(c)) nlp++; }
  if (nlp + ndp !== pfx.length || nlp === 0) return false;
  const ns = n - i0;
  if (ns < 1 || ns > 3) return false;
  for (let i = i0 + 1; i <= n; i++) if (!isLetter(w[i - 1])) return false;
  return true;
}

/** pack28 for a standard call; null when the token is not one. */
function pack28(call) {
  if (!c28StandardShape(call)) return null;
  const n = call.length;
  let iarea = 0;
  for (let i = n; i >= 2; i--) if (isDigit(call[i - 1])) { iarea = i; break; }
  const cs = (iarea === 2 ? ' ' + call.slice(0, 5) : call.slice(0, 6)).padEnd(6, ' ');
  const i1 = A1.indexOf(cs[0]), i2 = A2.indexOf(cs[1]), i3 = A3.indexOf(cs[2]);
  const i4 = A4.indexOf(cs[3]), i5 = A4.indexOf(cs[4]), i6 = A4.indexOf(cs[5]);
  if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0 || i5 < 0 || i6 < 0) return null;
  let n28 = 36 * 10 * 27 * 27 * 27 * i1 + 10 * 27 * 27 * 27 * i2 + 27 * 27 * 27 * i3 + 27 * 27 * i4 + 27 * i5 + i6;
  n28 += PACK77_NTOKENS + PACK77_MAX22;
  return n28 & 0x0FFFFFFF;
}

/** unpack28 for the standard-call range; null for tokens, hashes or an invalid call. */
function unpack28(n28) {
  if (n28 < PACK77_NTOKENS) return null;
  let n = n28 - PACK77_NTOKENS;
  if (n < PACK77_MAX22) return null;
  n -= PACK77_MAX22;
  const i1 = Math.floor(n / (36 * 10 * 27 * 27 * 27)); n -= 36 * 10 * 27 * 27 * 27 * i1;
  const i2 = Math.floor(n / (10 * 27 * 27 * 27)); n -= 10 * 27 * 27 * 27 * i2;
  const i3 = Math.floor(n / (27 * 27 * 27)); n -= 27 * 27 * 27 * i3;
  const i4 = Math.floor(n / (27 * 27)); n -= 27 * 27 * i4;
  const i5 = Math.floor(n / 27);
  const i6 = n - 27 * i5;
  if (i1 > 36 || i2 > 35 || i3 > 9 || i4 > 26 || i5 > 26 || i6 > 26) return null;
  const raw = A1[i1] + A2[i2] + A3[i3] + A4[i4] + A4[i5] + A4[i6];
  const c13 = raw.replace(/^ +/, '');
  const trimmed = c13.replace(/ +$/, '');
  if (!callok(trimmed)) return null;
  const i0 = c13.indexOf(' ');
  if (i0 >= 0 && i0 < trimmed.length) return null; // interior space
  return trimmed;
}

/** jtty_source_codec standard_call: a call the CALL atoms may carry. */
function isStandardCall(call) {
  const w = String(call || '');
  if (!w || w.length > 13) return false;
  if (!chkcall(w)) return false;
  if (w.indexOf('/') >= 0 || w[0] === 'Q') return false;
  if (!/^[A-Z0-9]+$/.test(w)) return false;
  const n28 = pack28(w);
  if (n28 === null) return false;
  return unpack28(n28) === w;
}

// ---------------------------------------------------------------------------
// Atoms. { kind, subtype, role, value, value2, text } as in the Fortran type.
function atom(kind, fields) {
  return Object.assign({ kind, subtype: 0, role: ROLE.FIELD_ONLY, value: 0, value2: 0, text: '' }, fields || {});
}
const callAtom = (action, call) => atom(ATOM.CALL, { subtype: action, text: call });
const exchNumAtom = (role, kind, value) => atom(ATOM.EXCH_NUM, { role, subtype: kind, value });
const exchLocAtom = (role, kind, token) => atom(ATOM.EXCH_LOC, { role, subtype: kind, text: token });
const zoneLocAtom = (zone, token) => atom(ATOM.EXCH_PAIR, { subtype: PAIR.ZONE_LOC3, value: zone, text: token });
const classSectionAtom = (count, cls, secIdx) => atom(ATOM.EXCH_PAIR, { subtype: PAIR.CLASS_SECTION, value: count, value2: secIdx, text: cls });
const exchNumTimeAtom = (role, serial, minute) => atom(ATOM.EXCH_NUM_TIME, { role, value: serial, value2: minute });
const controlAtom = (id) => atom(ATOM.CONTROL, { subtype: id });
const grid4Atom = (role, grid) => atom(ATOM.GRID4, { role, text: grid });
const text5Atom = (text) => atom(ATOM.TEXT5, { text: String(text || '').slice(0, 5).padEnd(5, ' ') });

const validRole = (r) => r === ROLE.FIELD_ONLY || r === ROLE.FULL;
function validNumber(kind, value) {
  if (!(kind >= 0 && kind <= 7 && value >= 0 && value <= 131071)) return false;
  if (kind === NUM.CQ_ZONE) return value >= 1 && value <= 40;
  if (kind === NUM.ITU_ZONE) return value >= 1 && value <= 90;
  if (kind === NUM.LICENSE_YEAR) return value <= 9999;
  return true;
}

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function packBase36(token) {
  if (token.length !== 2 && token.length !== 3) return null;
  let v = 0;
  for (const c of token) { const d = B36.indexOf(c); if (d < 0) return null; v = 36 * v + d; }
  if (token.length === 3 && v < 36 * 36) return null;
  return v;
}
function unpackBase36(value, n) {
  let w = value, out = '';
  for (let i = 0; i < n; i++) { out = B36[w % 36] + out; w = Math.floor(w / 36); }
  return out;
}
function grid4ToIndex(grid) {
  if (grid.length !== 4) return null;
  const a = grid.charCodeAt(0) - 65, b = grid.charCodeAt(1) - 65, c = grid.charCodeAt(2) - 48, d = grid.charCodeAt(3) - 48;
  if (a < 0 || a >= 18 || b < 0 || b >= 18 || c < 0 || c >= 10 || d < 0 || d >= 10) return null;
  return ((a * 18 + b) * 10 + c) * 10 + d;
}
function indexToGrid4(idx) {
  const d = idx % 10, c = Math.floor(idx / 10) % 10, b = Math.floor(idx / 100) % 18, a = Math.floor(idx / 1800);
  return String.fromCharCode(65 + a, 65 + b, 48 + c, 48 + d);
}

// 32-bit words are built in BigInt: body<<5 reaches bit 31 and JS bit ops are
// signed 32-bit.
const bi = (x) => BigInt(x);
const finishStruct = (body, family) => 4n * (8n * body + bi(family)) + 2n;

/** pack_jtty_atom: atom -> 34-char frame, or null when the atom is invalid. */
function packAtom(a, eom) {
  let n32 = null;
  switch (a.kind) {
    case ATOM.CALL: {
      if (a.subtype < 0 || a.subtype > 5) return null;
      if (!isStandardCall(a.text)) return null;
      const n28 = pack28(a.text);
      const i2 = a.subtype <= 3 ? 0 : 1, n2 = a.subtype <= 3 ? a.subtype : a.subtype - 4;
      n32 = (bi(n28) << 4n) + bi(4 * n2 + i2);
      break;
    }
    case ATOM.EXCH_NUM: {
      if (!validRole(a.role) || !validNumber(a.subtype, a.value)) return null;
      n32 = finishStruct((bi(a.role) << 26n) + (bi(a.subtype) << 22n) + (bi(a.value) << 5n), 0);
      break;
    }
    case ATOM.EXCH_LOC: {
      if (!validRole(a.role) || a.subtype < 0 || a.subtype > 4) return null;
      const t = a.text.replace(/ +$/, '');
      const tv = packBase36(t);
      if (tv === null) return null;
      n32 = finishStruct((bi(a.role) << 26n) + (bi(a.subtype) << 22n) + (bi(t.length - 2) << 21n) + (bi(tv) << 5n), 1);
      break;
    }
    case ATOM.EXCH_PAIR: {
      let pair;
      if (a.subtype === PAIR.ZONE_LOC3) {
        if (a.value < 1 || a.value > 40) return null;
        const t = a.text.replace(/ +$/, '');
        const tv = packBase36(t);
        if (tv === null) return null;
        pair = (bi(a.value) << 17n) + (bi(t.length - 2) << 16n) + bi(tv);
      } else if (a.subtype === PAIR.CLASS_SECTION) {
        if (a.value < 1 || a.value > 32) return null;
        if (a.value2 < 1 || a.value2 > NSEC || a.text.replace(/ +$/, '').length !== 1) return null;
        const cls = a.text.charCodeAt(0) - 65;
        if (cls < 0 || cls > 5) return null;
        pair = (bi(a.value) << 17n) + (bi(cls) << 14n) + (bi(a.value2) << 7n);
      } else return null;
      n32 = finishStruct((bi(a.subtype) << 24n) + (pair << 1n), 2);
      break;
    }
    case ATOM.EXCH_NUM_TIME: {
      if (!validRole(a.role) || a.value < 0 || a.value > 16383 || a.value2 < 0 || a.value2 > 1439) return null;
      n32 = finishStruct((bi(a.role) << 26n) + (bi(a.value) << 12n) + (bi(a.value2) << 1n), 3);
      break;
    }
    case ATOM.CONTROL: {
      if (a.subtype < 0 || a.subtype > 17) return null;
      n32 = finishStruct((bi(MISC.CONTROL) << 23n) + (bi(a.subtype) << 16n), 4);
      break;
    }
    case ATOM.GRID4: {
      if (!validRole(a.role)) return null;
      const gi = grid4ToIndex(a.text.replace(/ +$/, ''));
      if (gi === null) return null;
      n32 = finishStruct((bi(MISC.GRID4) << 23n) + (bi(a.role) << 22n) + (bi(gi) << 7n), 4);
      break;
    }
    case ATOM.TEXT5: {
      const t5 = a.text.slice(0, 5).padEnd(5, ' ');
      let top30 = 0n;
      for (const c of t5) { const i = ALPHABET.indexOf(c); if (i < 0) return null; top30 = 64n * top30 + bi(i); }
      n32 = 4n * top30 + 3n;
      break;
    }
    default: return null;
  }
  return n32.toString(2).padStart(32, '0') + '0' + (eom ? '1' : '0');
}

const bits = (v, pos, len) => Number((v >> bi(pos)) & ((1n << bi(len)) - 1n));

/** unpack_jtty_atom: frame -> { atom, eom } or null when structurally invalid. */
function unpackAtom(frame) {
  if (!/^[01]{34}$/.test(frame) || frame[32] !== '0') return null;
  if (/^0{32}/.test(frame)) return null;
  const word = BigInt('0b' + frame.slice(0, 32));
  const top30 = word >> 2n, i2 = Number(word & 3n);
  let a;
  if (i2 === 0 || i2 === 1) {
    const n28 = Number(word >> 4n), n2 = Number((word >> 2n) & 3n);
    if (i2 === 1 && n2 > 1) return null;
    const call = unpack28(n28);
    if (call === null || !isStandardCall(call)) return null;
    a = callAtom(i2 === 0 ? n2 : n2 + 4, call);
  } else if (i2 === 2) {
    const family = Number(top30 & 7n), body = top30 >> 3n;
    switch (family) {
      case 0: {
        a = exchNumAtom(bits(body, 26, 1), bits(body, 22, 4), bits(body, 5, 17));
        if (bits(body, 0, 5) !== 0 || !validNumber(a.subtype, a.value)) return null;
        break;
      }
      case 1: {
        const role = bits(body, 26, 1), kind = bits(body, 22, 4), n = bits(body, 21, 1) + 2;
        const tv = bits(body, 5, 16);
        if (bits(body, 0, 5) !== 0 || kind > 4 || tv >= 36 ** n) return null;
        if (n === 3 && tv < 36 * 36) return null;
        a = exchLocAtom(role, kind, unpackBase36(tv, n));
        break;
      }
      case 2: {
        const sub = bits(body, 24, 3), pair = (body >> 1n) & ((1n << 23n) - 1n);
        if (bits(body, 0, 1) !== 0) return null;
        if (sub === PAIR.ZONE_LOC3) {
          const zone = bits(pair, 17, 6), n = bits(pair, 16, 1) + 2, tv = bits(pair, 0, 16);
          if (zone < 1 || zone > 40 || tv >= 36 ** n) return null;
          if (n === 3 && tv < 36 * 36) return null;
          a = zoneLocAtom(zone, unpackBase36(tv, n));
        } else if (sub === PAIR.CLASS_SECTION) {
          const count = bits(pair, 17, 6), cls = bits(pair, 14, 3), sec = bits(pair, 7, 7);
          if (count < 1 || count > 32 || cls > 5 || sec < 1 || sec > NSEC || bits(pair, 0, 7) !== 0) return null;
          a = classSectionAtom(count, String.fromCharCode(65 + cls), sec);
        } else return null;
        break;
      }
      case 3: {
        a = exchNumTimeAtom(bits(body, 26, 1), bits(body, 12, 14), bits(body, 1, 11));
        if (bits(body, 0, 1) !== 0 || a.value2 > 1439) return null;
        break;
      }
      case 4: {
        const sub = bits(body, 23, 4), data = body & ((1n << 23n) - 1n);
        if (sub === MISC.CONTROL) {
          a = controlAtom(bits(data, 16, 7));
          if (bits(data, 0, 16) !== 0 || a.subtype > 17) return null;
        } else if (sub === MISC.GRID4) {
          const role = bits(data, 22, 1), gi = bits(data, 7, 15);
          if (bits(data, 0, 7) !== 0 || gi >= 32400) return null;
          a = grid4Atom(role, indexToGrid4(gi));
        } else return null;
        break;
      }
      default: return null;
    }
  } else {
    let t = '';
    for (let i = 0; i < 5; i++) t += ALPHABET[Number((top30 >> bi(6 * (4 - i))) & 63n)];
    a = text5Atom(t);
  }
  return { atom: a, eom: frame[33] === '1' };
}

function renderNumber(kind, value) {
  if (kind === NUM.SERIAL) return value < 1000 ? String(value).padStart(3, '0') : String(value);
  if (kind === NUM.CQ_ZONE || kind === NUM.ITU_ZONE || kind === NUM.CHECK) return value < 100 ? String(value).padStart(2, '0') : String(value);
  if (kind === NUM.LICENSE_YEAR) return String(value).padStart(4, '0');
  return String(value);
}
const renderRole = (role, field) => (role === ROLE.FULL ? '599 ' + field : field);

/** render_jtty_atom: canonical text, or null when the atom cannot render. */
function renderAtom(a) {
  switch (a.kind) {
    case ATOM.CALL: {
      const c = a.text.replace(/ +$/, '');
      switch (a.subtype) {
        case CALL.CQ: return 'CQ ' + c + ' CQ';
        case CALL.CALL: return c;
        case CALL.TU_CQ: return 'TU ' + c + ' CQ';
        case CALL.CALL_TU: return c + ' TU';
        case CALL.CALL_AGN: return c + ' AGN?';
        case CALL.TU_NOW: return 'TU NOW ' + c;
        default: return null;
      }
    }
    case ATOM.EXCH_NUM:
      if (!validRole(a.role) || !validNumber(a.subtype, a.value)) return null;
      return renderRole(a.role, renderNumber(a.subtype, a.value));
    case ATOM.EXCH_LOC:
      if (a.subtype < 0 || a.subtype > 4) return null;
      return renderRole(a.role, a.text.replace(/ +$/, ''));
    case ATOM.EXCH_PAIR:
      if (a.subtype === PAIR.ZONE_LOC3) return '599 ' + String(a.value).padStart(2, '0') + ' ' + a.text.replace(/ +$/, '');
      if (a.subtype === PAIR.CLASS_SECTION) {
        if (a.value2 < 1 || a.value2 > NSEC) return null;
        return String(a.value) + a.text[0] + ' ' + ARRL_SECTIONS[a.value2 - 1];
      }
      return null;
    case ATOM.EXCH_NUM_TIME: {
      if (!validRole(a.role) || a.value < 0 || a.value > 16383 || a.value2 < 0 || a.value2 > 1439) return null;
      const hh = String(Math.floor(a.value2 / 60)).padStart(2, '0'), mm = String(a.value2 % 60).padStart(2, '0');
      return renderRole(a.role, renderNumber(NUM.SERIAL, a.value) + ' ' + hh + mm);
    }
    case ATOM.CONTROL:
      if (a.subtype < 0 || a.subtype > 17) return null;
      return CONTROL_TEXT[a.subtype];
    case ATOM.GRID4: return renderRole(a.role, a.text.slice(0, 4));
    case ATOM.TEXT5: return a.text.slice(0, 5);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Messages.

/** normalize_jtty_message: upper-case, alphabet-fold to '#', single spaces. */
function normalizeMessage(raw) {
  let out = '', lastSpace = true;
  const src = String(raw == null ? '' : raw).slice(0, MAX_MESSAGE);
  for (let c of src) {
    if (c === '\0' || c === '~') c = ' ';
    if (c >= 'a' && c <= 'z') c = c.toUpperCase();
    if (ALPHABET.indexOf(c) < 0) c = '#';
    if (c === ' ') { if (lastSpace) continue; out += ' '; lastSpace = true; }
    else { out += c; lastSpace = false; }
  }
  return out.replace(/ +$/, '');
}

function decimalValue(text) {
  if (text.length < 1 || text.length > 6 || !/^[0-9]+$/.test(text)) return null;
  const v = parseInt(text, 10);
  return v <= 131071 ? v : null;
}

/** RTTY Roundup: a decimal token after a "599" token becomes a canonical serial. */
function normalizeSerials(msg) {
  const words = msg.split(' ');
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    if (w === '599' && i + 1 < words.length) {
      const v = decimalValue(words[i + 1]);
      if (v !== null) {
        const r = renderAtom(exchNumAtom(ROLE.FULL, NUM.SERIAL, v));
        if (r === null) return null;
        w = r; i++;
      }
    }
    out.push(w);
  }
  const result = out.join(' ');
  return result.length > MAX_MESSAGE ? null : result;
}

/**
 * pack_jtty: text -> the minimum number of frames (dynamic program over
 * character offsets, exactly the reference's recognition and tie-break
 * policy). Returns { frames, text, atoms } with `text` the canonical message,
 * or { error } when the message cannot be sent (too long after normalization,
 * or > 16 frames).
 */
function packMessage(raw, profile) {
  profile = profile == null ? PROFILE.UNKNOWN : profile;
  if (profile < PROFILE.UNKNOWN || profile > PROFILE.RTTY) return { error: 'invalid exchange profile' };
  let msg = normalizeMessage(raw);
  if (profile === PROFILE.RTTY) {
    msg = normalizeSerials(msg);
    if (msg === null) return { error: 'message exceeds JTTY limits after exchange normalization' };
  }
  const n = msg.length;
  if (n === 0) return { frames: [], text: '', atoms: [] };

  const INF = 999;
  const dp = new Array(n + 2).fill(INF);
  const successor = new Array(n + 2).fill(0);
  const choice = new Array(n + 2).fill(null);
  dp[n + 1] = 0;
  const S = (i, j) => msg.slice(i - 1, j); // Fortran msg(i:j), 1-based inclusive
  const keyOf = (a) => 100 * a.kind + 2 * a.subtype + a.role;
  const rankOf = (a) => (a.kind === ATOM.TEXT5 ? 1 : 0);

  let ipos = 0;
  const consider = (a, next) => {
    const cost = 1 + dp[next];
    if (cost > MAX_FRAMES || cost > dp[ipos]) return;
    if (cost === dp[ipos]) {
      const best = choice[ipos];
      const rank = rankOf(a), bestRank = rankOf(best);
      if (rank > bestRank) return;
      if (rank === bestRank) {
        if (next < successor[ipos]) return;
        if (next === successor[ipos] && keyOf(a) >= keyOf(best)) return;
      }
    }
    dp[ipos] = cost; successor[ipos] = next; choice[ipos] = a;
  };
  const offer = (a) => {
    const frame = packAtom(a, false);
    if (frame === null) return;
    const u = unpackAtom(frame);
    if (u === null) return;
    const rendered = renderAtom(u.atom);
    if (rendered === null || rendered.length === 0) return;
    const last = ipos + rendered.length - 1;
    if (last > n) return;
    if (S(ipos, last) !== rendered) return;
    let next = n + 1;
    if (last < n) {
      if (msg[last] !== ' ') return; // msg(last+1:last+1)
      next = last + 2; // structured frames supply exactly one separator column
    }
    consider(a, next);
  };
  const tryCompact = () => {
    const words = [];
    let first = ipos;
    for (let j = 0; j < 3; j++) {
      if (first > n) break;
      let sp = msg.indexOf(' ', first - 1);
      const last = sp < 0 ? n : sp; // 1-based index of the char before the space
      words.push(S(first, last));
      first = last + 2;
    }
    const nwords = words.length;
    for (let j = 0; j < nwords; j++) {
      if (words[j].length > 13) continue;
      for (let action = CALL.CQ; action <= CALL.TU_NOW; action++) offer(callAtom(action, words[j]));
    }
    for (let j = 0; j < CONTROL_TEXT.length; j++) offer(controlAtom(j));
    for (let role = ROLE.FIELD_ONLY; role <= ROLE.FULL; role++) {
      let field = 0;
      if (role === ROLE.FULL) {
        if (words[0] !== '599' || nwords < 2) continue;
        field = 1;
      }
      const w = words[field], length = w.length;
      const v = decimalValue(w);
      if (v !== null) offer(exchNumAtom(role, NUM.GENERIC, v));
      if (v !== null && role === ROLE.FULL && profile === PROFILE.RTTY) offer(exchNumAtom(role, NUM.SERIAL, v));
      if (length === 4) offer(grid4Atom(role, w.slice(0, 4)));
      if (role !== ROLE.FULL || length < 2 || length > 3) continue;
      if (!/[A-Z]/.test(w)) continue;
      offer(exchLocAtom(role, LOC.QTH, w));
      if (profile === PROFILE.RTTY) offer(exchLocAtom(role, LOC.STATE_PROVINCE, w));
    }
    const length = words[0].length;
    if (nwords < 2 || length < 2 || length > 3) return;
    const count = decimalValue(words[0].slice(0, length - 1));
    if (count === null) return;
    offer(classSectionAtom(count, words[0][length - 1], sectionIndex(words[1])));
  };

  for (ipos = n; ipos >= 1; ipos--) {
    const inext = Math.min(n + 1, ipos + 5);
    consider(text5Atom(S(ipos, inext - 1)), inext);
    if (ipos > 1 && msg[ipos - 2] !== ' ') continue;
    tryCompact();
  }
  if (dp[1] > MAX_FRAMES) return { error: 'message needs more than 16 frames' };

  const atoms = [];
  for (let p = 1; p <= n;) { atoms.push(choice[p]); p = successor[p]; }
  const frames = [];
  for (let i = 0; i < atoms.length; i++) {
    const f = packAtom(atoms[i], i === atoms.length - 1);
    if (f === null) return { error: 'internal: chosen atom failed to pack' };
    frames.push(f);
  }
  return { frames, text: msg, atoms };
}

/**
 * unpack_jtty: frames -> text, as the operator sees it. Returns
 * { text, eom, valid }. TEXT5 spaces are real spaces here (the reference shows
 * them as '~' internally); structured atoms leave one separator column.
 */
function unpackMessage(frames) {
  let text = '', eom = false, valid = frames.length >= 1 && frames.length <= MAX_FRAMES;
  for (const f of frames.slice(0, MAX_FRAMES)) {
    eom = false;
    const u = unpackAtom(f);
    if (u === null) { valid = false; continue; }
    const r = renderAtom(u.atom);
    if (r === null) { valid = false; continue; }
    eom = u.eom;
    text += u.atom.kind === ATOM.TEXT5 ? r : r + ' ';
  }
  return { text: text.replace(/ +$/, ''), eom: eom && valid, valid };
}

/** The 34-bit frame as the spec's hex (nine digits) for the golden vectors. */
const frameHex = (frame) => '0x' + BigInt('0b' + frame).toString(16).toUpperCase().padStart(9, '0');

module.exports = {
  JTTY_SPEC_TAG, ALPHABET, MAX_FRAMES, MAX_MESSAGE, ATOM, CALL, ROLE, NUM, LOC, PAIR, MISC, PROFILE,
  CONTROL_TEXT, ARRL_SECTIONS, sectionIndex,
  pack28, unpack28, isStandardCall,
  callAtom, exchNumAtom, exchLocAtom, zoneLocAtom, classSectionAtom, exchNumTimeAtom, controlAtom, grid4Atom, text5Atom,
  packAtom, unpackAtom, renderAtom, normalizeMessage, packMessage, unpackMessage, frameHex,
};
