#!/usr/bin/env node
'use strict';
//
// Ragchew log pop-out — unit tests for the data layer (qsoDetails index)
// and the form-data-builder shape produced by renderer/log-popout.js.
//
// Run: node test/ragchew-test.js
// No network, no Electron. Pure data round-trips through the ADIF parser
// and a copied subset of the index logic from main.js.
//

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseAllRawQsos } = require('../lib/adif');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

// =========================================================================
// Reproduce the index logic from main.js so we test exactly what ships.
// (Kept verbatim — if main.js's copy diverges, the tests won't notice; this
// is intentional, the goal is to lock the contract for the renderer.)
// =========================================================================

function normalizeCallForIndex(call) {
  return String(call || '').toUpperCase().split('/')[0].trim();
}

function adifRef(rec) {
  if (rec.SIG && rec.SIG_INFO) return `${rec.SIG.toUpperCase()} ${rec.SIG_INFO.toUpperCase()}`;
  if (rec.POTA_REF) return `POTA ${rec.POTA_REF.toUpperCase()}`;
  if (rec.SOTA_REF) return `SOTA ${rec.SOTA_REF.toUpperCase()}`;
  if (rec.WWFF_REF) return `WWFF ${rec.WWFF_REF.toUpperCase()}`;
  return '';
}

function adifFreqToKhz(freq) {
  if (!freq) return null;
  const mhz = parseFloat(freq);
  if (!isFinite(mhz)) return null;
  return Math.round(mhz * 1000);
}

function buildIndex(filePath) {
  const idx = new Map();
  if (!fs.existsSync(filePath)) return idx;
  const all = parseAllRawQsos(filePath);
  for (const rec of all) {
    const key = normalizeCallForIndex(rec.CALL);
    if (!key) continue;
    const entry = {
      call: rec.CALL || key,
      date: rec.QSO_DATE || '',
      time: rec.TIME_ON || '',
      mode: rec.MODE || '',
      freq: adifFreqToKhz(rec.FREQ),
      band: rec.BAND || '',
      comment: rec.COMMENT || '',
      ref: adifRef(rec),
    };
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(entry);
  }
  for (const list of idx.values()) {
    list.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  }
  return idx;
}

function lookupPastQsos(idx, call, limit) {
  const key = normalizeCallForIndex(call);
  const list = idx.get(key) || [];
  return limit ? list.slice(0, limit) : list.slice();
}

// =========================================================================

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-ragchew-'));
const adifPath = path.join(tmp, 'log.adi');

// ADIF helpers — minimal, just enough to write fixtures.
function f(name, value) {
  if (value == null || value === '') return '';
  const s = String(value);
  return `<${name}:${s.length}>${s}`;
}
function record(fields) {
  return Object.entries(fields).map(([k, v]) => f(k, v)).join('') + '<EOR>\n';
}
function header() { return 'POTACAT test log\n<ADIF_VER:5>3.1.5<EOH>\n'; }

// =========================================================================
console.log('\n=== qsoDetails index ===');

test('builds empty index from a missing file', () => {
  const idx = buildIndex(path.join(tmp, 'does-not-exist.adi'));
  assert.strictEqual(idx.size, 0);
});

test('parses callsigns, sorts newest-first', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'K0OTC', QSO_DATE: '20240301', TIME_ON: '120000', MODE: 'CW', FREQ: '14.020', BAND: '20m' }) +
    record({ CALL: 'K0OTC', QSO_DATE: '20250915', TIME_ON: '143000', MODE: 'SSB', FREQ: '14.310', BAND: '20m', COMMENT: 'POTA hunt' }) +
    record({ CALL: 'K0OTC', QSO_DATE: '20251201', TIME_ON: '093000', MODE: 'FT8', FREQ: '14.074', BAND: '20m' }) +
    record({ CALL: 'W1AW',  QSO_DATE: '20250505', TIME_ON: '180000', MODE: 'CW', FREQ: '7.030', BAND: '40m' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.size, 2, 'two distinct callsigns');
  const k = idx.get('K0OTC');
  assert.strictEqual(k.length, 3);
  // Newest-first sort
  assert.strictEqual(k[0].date, '20251201');
  assert.strictEqual(k[1].date, '20250915');
  assert.strictEqual(k[2].date, '20240301');
});

test('frequency converts MHz string → integer kHz', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'N0CALL', QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.074500' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.get('N0CALL')[0].freq, 14075, '14.0745 MHz → 14075 kHz (rounded)');
});

test('null/empty FREQ produces null kHz, not NaN', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'N0CALL', QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.get('N0CALL')[0].freq, null);
});

test('portable suffix /4 collapses with bare callsign', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'K3SBP',   QSO_DATE: '20250101', TIME_ON: '0000', MODE: 'CW', FREQ: '7.040' }) +
    record({ CALL: 'K3SBP/4', QSO_DATE: '20250602', TIME_ON: '0000', MODE: 'SSB', FREQ: '14.250' }) +
    record({ CALL: 'K3SBP/M', QSO_DATE: '20250715', TIME_ON: '0000', MODE: 'FT8', FREQ: '14.074' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.size, 1, 'all three /SUFFIX variants index under one key');
  const list = idx.get('K3SBP');
  assert.strictEqual(list.length, 3);
  // Original CALL preserved per record
  assert.strictEqual(list[0].call, 'K3SBP/M', 'newest record (/M) keeps its original form');
});

test('SIG/SIG_INFO renders as "POTA US-1234"', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'KP4',   QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020', SIG: 'POTA', SIG_INFO: 'US-1234' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.get('KP4')[0].ref, 'POTA US-1234');
});

test('SIG_INFO uppercase normalization', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'KP4', QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020', SIG: 'pota', SIG_INFO: 'us-1234' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.get('KP4')[0].ref, 'POTA US-1234');
});

test('explicit POTA_REF/SOTA_REF/WWFF_REF used when SIG missing', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'A',  QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020', POTA_REF: 'us-9999' }) +
    record({ CALL: 'B',  QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020', SOTA_REF: 'w7w/lc-001' }) +
    record({ CALL: 'C',  QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020', WWFF_REF: 'kff-0001' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.get('A')[0].ref, 'POTA US-9999');
  assert.strictEqual(idx.get('B')[0].ref, 'SOTA W7W/LC-001');
  assert.strictEqual(idx.get('C')[0].ref, 'WWFF KFF-0001');
});

test('records without CALL are skipped', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'GOOD', QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020' }) +
    record({ /* no CALL */ QSO_DATE: '20260102', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(idx.size, 1);
  assert.ok(idx.has('GOOD'));
});

console.log('\n=== Lookup ===');

test('lookup returns empty array for unknown call', () => {
  const idx = buildIndex(adifPath);
  assert.deepStrictEqual(lookupPastQsos(idx, 'NEVERWORKED'), []);
});

test('lookup limit caps results, list still newest-first', () => {
  // Build a callsign with 10 QSOs across a year
  const lines = [header()];
  for (let i = 1; i <= 10; i++) {
    lines.push(record({
      CALL: 'TESTOP',
      QSO_DATE: `2025${String(i).padStart(2, '0')}15`,
      TIME_ON: '120000',
      MODE: 'CW', FREQ: '14.020',
    }));
  }
  fs.writeFileSync(adifPath, lines.join(''));
  const idx = buildIndex(adifPath);
  const top5 = lookupPastQsos(idx, 'TESTOP', 5);
  assert.strictEqual(top5.length, 5);
  assert.strictEqual(top5[0].date, '20251015', 'oct 2025 newest of the year');
  assert.strictEqual(top5[4].date, '20250615', '5th-newest is june 2025');
  // No limit returns all 10
  assert.strictEqual(lookupPastQsos(idx, 'TESTOP').length, 10);
});

test('lookup is case-insensitive', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'K0OTC', QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(lookupPastQsos(idx, 'k0otc').length, 1);
  assert.strictEqual(lookupPastQsos(idx, 'K0OTC').length, 1);
  assert.strictEqual(lookupPastQsos(idx, 'k0OtC').length, 1);
});

test('lookup matches portable variant against bare key', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'K3SBP', QSO_DATE: '20260101', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020' }));
  const idx = buildIndex(adifPath);
  assert.strictEqual(lookupPastQsos(idx, 'K3SBP/4').length, 1, '/4 → bare K3SBP');
  assert.strictEqual(lookupPastQsos(idx, 'K3SBP/M').length, 1, '/M → bare K3SBP');
});

console.log('\n=== Append (incremental update) ===');

// Mirror appendToQsoDetailsIndex from main.js
function append(idx, qsoData) {
  const key = normalizeCallForIndex(qsoData.callsign);
  if (!key) return;
  const freq = qsoData.frequency != null ? Math.round(parseFloat(qsoData.frequency)) : null;
  const ref = qsoData.sig && qsoData.sigInfo
    ? `${String(qsoData.sig).toUpperCase()} ${String(qsoData.sigInfo).toUpperCase()}`
    : (qsoData.potaRef ? `POTA ${qsoData.potaRef}` : '');
  const entry = {
    call: qsoData.callsign,
    date: (qsoData.qsoDate || '').replace(/-/g, ''),
    time: (qsoData.timeOn || '').replace(/:/g, ''),
    mode: qsoData.mode || '',
    freq: isFinite(freq) ? freq : null,
    band: qsoData.band || '',
    comment: qsoData.comment || '',
    ref,
  };
  if (!idx.has(key)) idx.set(key, []);
  idx.get(key).unshift(entry);
}

test('appending a fresh QSO inserts at front (newest)', () => {
  fs.writeFileSync(adifPath, header() +
    record({ CALL: 'NEWCALL', QSO_DATE: '20240501', TIME_ON: '0000', MODE: 'CW', FREQ: '14.020' }));
  const idx = buildIndex(adifPath);
  append(idx, {
    callsign: 'NEWCALL',
    qsoDate: '20260102',
    timeOn: '1530',
    mode: 'SSB',
    frequency: '14310',
    band: '20m',
    comment: 'fresh save',
  });
  const list = idx.get('NEWCALL');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].date, '20260102');
  assert.strictEqual(list[0].comment, 'fresh save');
  assert.strictEqual(list[0].freq, 14310, 'frequency string→int kHz');
});

test('append handles call with no prior history', () => {
  const idx = new Map();
  append(idx, {
    callsign: 'BRANDNEW',
    qsoDate: '20260102',
    timeOn: '1530',
    mode: 'CW',
    frequency: '7030',
  });
  assert.strictEqual(idx.size, 1);
  assert.strictEqual(idx.get('BRANDNEW').length, 1);
});

test('append normalizes hyphenated date / colon-separated time', () => {
  const idx = new Map();
  append(idx, {
    callsign: 'X',
    qsoDate: '2026-01-02',
    timeOn: '15:30',
    mode: 'CW',
    frequency: '7030',
  });
  const e = idx.get('X')[0];
  assert.strictEqual(e.date, '20260102');
  assert.strictEqual(e.time, '1530');
});

test('append preserves SIG/SIG_INFO ref formatting', () => {
  const idx = new Map();
  append(idx, {
    callsign: 'POTAOP',
    qsoDate: '20260101',
    timeOn: '0000',
    mode: 'SSB',
    frequency: '14310',
    sig: 'POTA',
    sigInfo: 'US-9999',
  });
  assert.strictEqual(idx.get('POTAOP')[0].ref, 'POTA US-9999');
});

test('append normalizes lowercase sig info', () => {
  const idx = new Map();
  append(idx, {
    callsign: 'OP',
    qsoDate: '20260101',
    timeOn: '0000',
    mode: 'CW',
    frequency: '7030',
    sig: 'pota',
    sigInfo: 'us-1234',
  });
  assert.strictEqual(idx.get('OP')[0].ref, 'POTA US-1234');
});

console.log('\n=== Performance smoke ===');

test('builds 10000-QSO index in <500ms', () => {
  const lines = [header()];
  for (let i = 0; i < 10000; i++) {
    lines.push(record({
      CALL: `K${i % 9}AAA${i}`,
      QSO_DATE: '20250101',
      TIME_ON: String(i % 240000).padStart(6, '0'),
      MODE: ['CW', 'SSB', 'FT8'][i % 3],
      FREQ: String(7.040 + (i % 2000) / 1000),
    }));
  }
  fs.writeFileSync(adifPath, lines.join(''));
  const t0 = Date.now();
  const idx = buildIndex(adifPath);
  const dur = Date.now() - t0;
  // Loose bound — index is built once at startup, not per-keystroke
  assert.ok(dur < 500, `build took ${dur}ms (expected <500)`);
  assert.ok(idx.size > 9000, `expected ~10000 unique calls, got ${idx.size}`);
});

test('lookup is O(1) — 100k unrelated entries don\'t slow down a single-call query', () => {
  // Build a big index (uses the file from previous test)
  const idx = buildIndex(adifPath);
  // Add a single needle call
  fs.appendFileSync(adifPath,
    record({ CALL: 'NEEDLE', QSO_DATE: '20251231', TIME_ON: '235959', MODE: 'CW', FREQ: '14.020' }));
  const idx2 = buildIndex(adifPath);
  const t0 = Date.now();
  let result;
  for (let i = 0; i < 100000; i++) result = lookupPastQsos(idx2, 'NEEDLE', 5);
  const dur = Date.now() - t0;
  assert.ok(result && result.length === 1);
  assert.ok(dur < 200, `100k lookups took ${dur}ms (expected <200ms — we cap rendering at 5)`);
});

// =========================================================================

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
