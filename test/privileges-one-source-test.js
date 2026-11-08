#!/usr/bin/env node
'use strict';
// GitHub #250 step 1: lib/privileges.js is the ONE copy of the licence tables.
// It used to exist three times (lib, renderer/app.js's spot filter, the
// bandspread pop-out's overlay), so every new class meant three edits. Now the
// renderer loads the lib file as window.Privileges, and each class carries
// `verified` and `source`. An unverified class filters spots but never refuses
// a key-down (Casey, 2026-11-08).
//
// "No behaviour change" is proved against frozen copies of master's code
// (test/fixtures/privileges-before-250/, master at 804095e1), cell by cell
// over a grid of frequencies x modes x classes.
// Run: node test/privileges-one-source-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib', 'privileges.js');
const P = require(LIB);
const BEFORE = require('./fixtures/privileges-before-250/lib-privileges');
const BEFORE_FILTER = require('./fixtures/privileges-before-250/renderer-app-filter');
const BEFORE_BANDSPREAD = require('./fixtures/privileges-before-250/bandspread-table');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// ---- The grid ----------------------------------------------------------------
const CLASS_KEYS = Object.keys(BEFORE.PRIVILEGE_MAP);
const CLASSES_TO_PROBE = [...CLASS_KEYS, 'none', '', undefined, null, 'bogus_class'];
const freqSet = new Set([0, -5, 100, 1799.5, 30000, 60000, 70200, 2000000, NaN]);
for (const ranges of Object.values(BEFORE.PRIVILEGE_MAP)) {
  for (const [lo, hi] of ranges) {
    for (const f of [lo - 1, lo - 0.5, lo, lo + 0.5, (lo + hi) / 2, hi - 0.5, hi, hi + 0.5, hi + 1]) freqSet.add(f);
  }
}
const FREQS_KHZ = [...freqSet];
const MODES = [...new Set([
  ...BEFORE.CW_DIGI_MODES, ...BEFORE.PHONE_MODES, ...BEFORE_FILTER.CW_DIGI_MODES,
  'cw', 'ft8', 'usb', 'Cw-R', 'CW-L', 'CW-U', 'SSTV', 'IMAGE', 'FAX', 'DIGITALVOICE', 'FREEDV',
  'C4FM', 'DSTAR', 'DMR', 'XYZ', ' USB ', '', undefined, null,
])];
const cellName = (f, m, c) => `${f} kHz ${JSON.stringify(m)} ${JSON.stringify(c)}`;

test(`grid is large enough to mean something (${FREQS_KHZ.length} freqs x ${MODES.length} modes x ${CLASSES_TO_PROBE.length} classes)`, () => {
  assert.ok(FREQS_KHZ.length > 200 && MODES.length > 50);
});

test('the tables are unchanged: PRIVILEGE_MAP and CLASS_LABELS equal master', () => {
  assert.deepStrictEqual(P.PRIVILEGE_MAP, BEFORE.PRIVILEGE_MAP);
  assert.deepStrictEqual(P.CLASS_LABELS, BEFORE.CLASS_LABELS);
  assert.deepStrictEqual(Object.keys(P.PRIVILEGE_MAP), Object.keys(BEFORE.PRIVILEGE_MAP), 'same order');
  assert.deepStrictEqual([...P.CW_DIGI_MODES], [...BEFORE.CW_DIGI_MODES]);
  assert.deepStrictEqual([...P.PHONE_MODES], [...BEFORE.PHONE_MODES]);
});

test('isOutOfPrivilege (spot filter, main side): every grid cell equals master', () => {
  let n = 0;
  for (const c of CLASSES_TO_PROBE) for (const f of FREQS_KHZ) for (const m of MODES) {
    const was = BEFORE.isOutOfPrivilege(f, m, c);
    const now = P.isOutOfPrivilege(f, m, c);
    assert.strictEqual(now, was, cellName(f, m, c));
    n++;
  }
  assert.ok(n > 10000, n);
});

test('txPrivilegeRefusal (key-down): every grid cell equals master, refusal text included', () => {
  let refused = 0;
  for (const c of CLASSES_TO_PROBE) for (const f of FREQS_KHZ) for (const m of MODES) {
    const args = { freqHz: f * 1000, mode: m, licenseClass: c };
    const was = BEFORE.txPrivilegeRefusal(args);
    assert.strictEqual(P.txPrivilegeRefusal(args), was, cellName(f, m, c));
    if (was) refused++;
  }
  assert.ok(refused > 1000, 'the grid exercises refusals too: ' + refused);
});

test('emissionOf: every mode equals master', () => {
  for (const m of MODES) assert.strictEqual(P.emissionOf(m), BEFORE.emissionOf(m), JSON.stringify(m));
});

test('bandspread overlay: the shared table equals the pop-out\'s old copy', () => {
  assert.deepStrictEqual(P.PRIVILEGE_MAP, BEFORE_BANDSPREAD.PRIVILEGE_MAP);
});

// The spot filter in renderer/app.js had drifted from lib: its mode lists were
// shorter (no DATA, DIGU, USB-D, JTTY, CW-R ...), so a spot with one of those
// modes read as out of privilege inside a CW/data segment. Using the shared
// module, the only cells that change are those: old "out", now "in".
// Everything else is identical.
test('renderer spot filter: identical to its old copy except modes the copy lacked, which now only ever show MORE spots', () => {
  assert.deepStrictEqual(BEFORE_FILTER.PRIVILEGE_RANGES, P.PRIVILEGE_MAP, 'same tables');
  const lacked = new Set([...P.CW_DIGI_MODES].filter((m) => !BEFORE_FILTER.CW_DIGI_MODES.has(m)));
  let changed = 0;
  for (const c of CLASSES_TO_PROBE) for (const f of FREQS_KHZ) for (const m of MODES) {
    const was = BEFORE_FILTER.isOutOfPrivilege(f, m, c);
    const now = P.isOutOfPrivilege(f, m, c);
    if (now === was) continue;
    changed++;
    const up = String(m).toUpperCase();
    assert.ok(was === true && now === false, 'a change may only un-hide: ' + cellName(f, m, c));
    assert.ok(lacked.has(up), 'only a mode the old copy lacked: ' + cellName(f, m, c));
  }
  console.log('       (' + changed + ' cells now shown that the old renderer copy hid; modes: ' + [...lacked].join(' ') + ')');
});

// ---- verified / source -------------------------------------------------------
test('every class has label, country, ranges, verified (boolean) and a source', () => {
  for (const [k, c] of Object.entries(P.CLASSES)) {
    assert.ok(typeof c.label === 'string' && c.label, k + ' label');
    assert.ok(typeof c.country === 'string' && c.country, k + ' country');
    assert.ok(Array.isArray(c.ranges) && c.ranges.length, k + ' ranges');
    assert.strictEqual(typeof c.verified, 'boolean', k + ' verified');
    assert.ok(typeof c.source === 'string' && c.source.trim().length >= 5, k + ' source');
    assert.strictEqual(P.PRIVILEGE_MAP[k], c.ranges, k + ' PRIVILEGE_MAP is derived from CLASSES');
    assert.strictEqual(P.CLASS_LABELS[k], c.label, k + ' CLASS_LABELS is derived from CLASSES');
  }
});
test('every existing US and CA class is verified, citing FCC or ISED', () => {
  for (const k of CLASS_KEYS) {
    assert.strictEqual(P.CLASSES[k].verified, true, k);
    assert.strictEqual(P.isVerified(k), true, k);
  }
  for (const k of ['us_extra', 'us_advanced', 'us_general', 'us_technician']) assert.strictEqual(P.CLASSES[k].source, 'FCC Part 97.301/97.305');
  for (const k of ['ca_basic', 'ca_honours']) assert.strictEqual(P.CLASSES[k].source, 'ISED RBR-4');
  assert.deepStrictEqual(Object.keys(P.CLASSES), CLASS_KEYS, 'no class added in step 1');
  assert.strictEqual(P.isVerified('none'), false);
  assert.strictEqual(P.isVerified('toString'), false);
});

// A fresh instance of the module, so the fake class never leaks into the others.
function freshModule() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(readSrc(LIB), sandbox, { filename: LIB });
  return sandbox.module.exports;
}
function addFakeClass(M, key, ranges, verified) {
  M.CLASSES[key] = { label: 'XX Fake', country: 'XX', ranges, verified, source: 'test fixture' };
  M.PRIVILEGE_MAP[key] = ranges;
  M.CLASS_LABELS[key] = 'XX Fake';
}

test('an UNVERIFIED class filters spots but never refuses a key-down', () => {
  const M = freshModule();
  addFakeClass(M, 'xx_fake', [[28000, 29700, 'all'], [144000, 146000, 'all']], false);
  // The spot filter applies: 20 m is outside the fake class.
  assert.strictEqual(M.isOutOfPrivilege(14074, 'FT8', 'xx_fake'), true);
  assert.strictEqual(M.isOutOfPrivilege(14250, 'SSB', 'xx_fake'), true);
  assert.strictEqual(M.isOutOfPrivilege(28074, 'FT8', 'xx_fake'), false);
  // The key-down never refuses, anywhere, any emission.
  for (const f of FREQS_KHZ) for (const m of ['FT8', 'USB', 'CW', 'SSTV', 'DIGU']) {
    assert.strictEqual(M.txPrivilegeRefusal({ freqHz: f * 1000, mode: m, licenseClass: 'xx_fake' }), null, cellName(f, m, 'xx_fake'));
  }
  // The same table, verified, does refuse: the flag is what stops it.
  addFakeClass(M, 'xx_fake_v', [[28000, 29700, 'all'], [144000, 146000, 'all']], true);
  assert.ok(M.txPrivilegeRefusal({ freqHz: 14074000, mode: 'FT8', licenseClass: 'xx_fake_v' }));
  assert.strictEqual(M.txPrivilegeRefusal({ freqHz: 28074000, mode: 'FT8', licenseClass: 'xx_fake_v' }), null);
});
test('un-verifying a real class stops its refusals, and only those', () => {
  const M = freshModule();
  assert.ok(M.txPrivilegeRefusal({ freqHz: 14074000, mode: 'FT8', licenseClass: 'us_technician' }));
  M.CLASSES.us_technician.verified = false;
  assert.strictEqual(M.txPrivilegeRefusal({ freqHz: 14074000, mode: 'FT8', licenseClass: 'us_technician' }), null);
  assert.strictEqual(M.isOutOfPrivilege(14074, 'FT8', 'us_technician'), true, 'still filtered');
  assert.ok(M.txPrivilegeRefusal({ freqHz: 14074000, mode: 'FT8', licenseClass: 'ca_basic' }), 'other classes untouched');
});

// ---- One source: the renderer uses the shared module -------------------------
test('lib/privileges.js runs as a page script and sets window.Privileges with the same tables', () => {
  const win = {};
  win.self = win;
  vm.runInNewContext(readSrc(LIB), win, { filename: LIB });
  assert.ok(win.Privileges, 'window.Privileges set');
  assert.ok(!win.module, 'no module object leaked');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(win.Privileges.PRIVILEGE_MAP)), BEFORE.PRIVILEGE_MAP);
  assert.strictEqual(win.Privileges.isOutOfPrivilege(14074, 'FT8', 'us_technician'), true);
  assert.strictEqual(typeof win.Privileges.txPrivilegeRefusal, 'function');
});
test('lib/privileges.js declares nothing at column 0 (one shared page scope)', () => {
  const src = readSrc(LIB);
  assert.ok(!/^(?:const|let|var|class|function)\b/m.test(src), 'a column-0 declaration would clash on the page');
});

const APP = readSrc(path.join(ROOT, 'renderer', 'app.js'));
const BS = readSrc(path.join(ROOT, 'renderer', 'bandspread-popout.js'));
const INDEX = readSrc(path.join(ROOT, 'renderer', 'index.html'));
const BS_HTML = readSrc(path.join(ROOT, 'renderer', 'bandspread-popout.html'));
const scriptIndex = (html, src) => html.indexOf(`<script src="${src}"></script>`);

test('index.html loads ../lib/privileges.js before app.js', () => {
  const lib = scriptIndex(INDEX, '../lib/privileges.js');
  assert.ok(lib > 0, 'loaded');
  assert.ok(lib < scriptIndex(INDEX, 'app.js'), 'before app.js');
});
test('bandspread-popout.html loads ../lib/privileges.js before bandspread-popout.js', () => {
  const lib = scriptIndex(BS_HTML, '../lib/privileges.js');
  assert.ok(lib > 0, 'loaded');
  assert.ok(lib < scriptIndex(BS_HTML, 'bandspread-popout.js'), 'before the pop-out script');
});
test('renderer/app.js has no table or filter of its own; every spot check goes to Privileges', () => {
  assert.ok(!/PRIVILEGE_RANGES/.test(APP), 'no PRIVILEGE_RANGES');
  assert.ok(!/^function isOutOfPrivilege\b/m.test(APP), 'no own isOutOfPrivilege');
  assert.ok(!/^const (CW_DIGI_MODES|PHONE_MODES)\b/m.test(APP), 'no own privilege mode lists');
  const calls = APP.match(/isOutOfPrivilege\(/g) || [];
  const shared = APP.match(/Privileges\.isOutOfPrivilege\(/g) || [];
  assert.strictEqual(calls.length, shared.length, 'every call is Privileges.isOutOfPrivilege');
  assert.ok(shared.length >= 4, 'filter, map pin, table row, ECHOCAT push: ' + shared.length);
  assert.ok(/if \(hideOutOfBand && Privileges\.isOutOfPrivilege\(parseFloat\(s\.frequency\), s\.mode, licenseClass\)\) return false;/.test(APP), 'the Hide out-of-privilege filter');
});
test('renderer/bandspread-popout.js has no table of its own; the overlay reads Privileges.PRIVILEGE_MAP', () => {
  assert.ok(!/^const PRIVILEGE_MAP\b/m.test(BS), 'no own table');
  const uses = BS.match(/PRIVILEGE_MAP\[/g) || [];
  const shared = BS.match(/Privileges\.PRIVILEGE_MAP\[/g) || [];
  assert.ok(uses.length >= 2 && uses.length === shared.length, `${shared.length}/${uses.length}`);
});

// ---- The License Class selects are unchanged ---------------------------------
const SELECT_ON_MASTER = `
          <option value="none">None (no filtering)</option>
          <optgroup label="United States">
            <option value="us_extra">US Extra</option>
            <option value="us_advanced">US Advanced</option>
            <option value="us_general">US General</option>
            <option value="us_technician">US Technician</option>
          </optgroup>
          <optgroup label="Canada">
            <option value="ca_honours">CA Advanced / Basic with Honours</option>
            <option value="ca_basic">CA Basic</option>
          </optgroup>
        `;
for (const id of ['set-license-class', 'welcome-license-class']) {
  test(`#${id} is unchanged, and every option is a class in the shared module with the same label`, () => {
    const m = INDEX.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`));
    assert.ok(m, 'select found');
    assert.strictEqual(m[1], SELECT_ON_MASTER);
    for (const [, v, label] of m[1].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)) {
      if (v === 'none') continue;
      assert.ok(P.CLASSES[v], v + ' is a class');
      assert.strictEqual(P.CLASSES[v].label, label, v + ' label');
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
