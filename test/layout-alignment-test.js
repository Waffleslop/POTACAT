'use strict';
// Rendered row-alignment test (2026-10-22). Two layout bugs reached users in
// 1.11.7–1.13.0 while every test passed, because no test looked at a page:
//   - a CW speed added a SECOND grid cell to some spot rows, shifting every
//     later column and the S/H/L buttons;
//   - FT4's dB reached the screen as "+10.9874995727539", widening its cell.
// This renders the real row builders (lib/spot-row.js, lib/decode-row.js)
// with the real stylesheets in hidden Electron windows (test/layout/harness.js)
// and checks that every column starts at the same x on every row, no row
// wraps, and every number on screen is formatted.
//
// Needs Electron (devDependency) and, on Linux CI, a display: the CI job runs
// it under xvfb-run with LAYOUT_REQUIRED=1, which turns "could not run" into a
// failure. Locally without Electron it says SKIP.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const required = process.env.LAYOUT_REQUIRED === '1';
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

// ---------------------------------------------------------------------------
// 1. The pages must use the shared builders — a fork is a row the test cannot see.
// ---------------------------------------------------------------------------
const web = fs.readFileSync(path.join(ROOT, 'renderer', 'remote.js'), 'utf8');
const webHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'remote.html'), 'utf8');
const pop = fs.readFileSync(path.join(ROOT, 'renderer', 'jtcat-popout.js'), 'utf8');
const popHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'jtcat-popout.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'lib', 'remote-server.js'), 'utf8');

test('ECHOCAT Web builds spot rows and decode rows only through the shared modules', () => {
  assert.ok(/SpotRow\.spotRowHtml\(/.test(web), 'renderSpots uses SpotRow.spotRowHtml');
  assert.ok(/DecodeRow\.webRowInner\(/.test(web), 'decode rows use DecodeRow.webRowInner');
  assert.strictEqual((web.match(/DecodeRow\.txRowInner\(/g) || []).length, 2, 'both TX rows use DecodeRow.txRowInner');
  assert.ok(!/class="spot-(freq|mode|dist|skip-btn)/.test(web.replace(/\/\/.*$/gm, '')), 'no hand-built spot cells left in remote.js');
  assert.ok(!/class="ft8-(db|dt|df)">/.test(web), 'no hand-built decode number cells left in remote.js');
  assert.ok(/<!-- spot-row-js -->/.test(webHtml) && /<!-- decode-row-js -->/.test(webHtml), 'placeholders in remote.html');
  assert.ok(/\['spot-row-js', 'spot-row\.js'\]/.test(server) && /\['decode-row-js', 'decode-row\.js'\]/.test(server), 'remote-server inlines both');
});

test('the JTCAT window builds decode rows only through DecodeRow', () => {
  assert.ok(/<script src="\.\.\/lib\/decode-row\.js"><\/script>/.test(popHtml), 'jtcat-popout.html loads lib/decode-row.js');
  assert.strictEqual((pop.match(/DecodeRow\.popoutRowInner\(/g) || []).length, 2, 'Band Activity and My Activity rows');
  assert.ok(/DecodeRow\.txRowInner\(data\.message, 'jp'/.test(pop), 'TX row');
  assert.ok(!/class="jp-(db|dt|df)">' \+/.test(pop), 'no hand-built number cells left');
});

test('the server serves the page with both modules inlined (no placeholder left)', () => {
  // Rebuild the inline the way remote-server does, on the real files.
  let html = webHtml;
  for (const [mark, file] of [['spot-row-js', 'spot-row.js'], ['decode-row-js', 'decode-row.js']]) {
    const js = fs.readFileSync(path.join(ROOT, 'lib', file), 'utf8');
    html = html.replace('<!-- ' + mark + ' -->', () => '<script>\n' + js + '\n</script>');
  }
  assert.ok(!/<!-- (spot|decode)-row-js -->/.test(html));
  assert.ok(html.indexOf('root.SpotRow = factory()') < html.indexOf('src="remote.js"') || !/src="remote\.js"/.test(html), 'modules load before remote.js');
});

// ---------------------------------------------------------------------------
// 2. Render and measure.
// ---------------------------------------------------------------------------
let electronPath = null;
try { electronPath = require('electron'); } catch { electronPath = null; }
let data = null;
let skipReason = '';
if (!electronPath || typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  skipReason = 'Electron binary not installed (npm install)';
} else {
  const res = spawnSync(electronPath, [path.join(__dirname, 'layout', 'harness.js'), '--no-sandbox'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const line = String(res.stdout || '').split(/\r?\n/).find(l => l.startsWith('LAYOUT_JSON:'));
  const err = String(res.stdout || '').split(/\r?\n/).find(l => l.startsWith('LAYOUT_ERROR:'));
  if (line) data = JSON.parse(line.slice('LAYOUT_JSON:'.length));
  else skipReason = (err || ('harness produced no result; exit ' + res.status + ' ' + (res.error ? res.error.message : '') + '\n' + String(res.stderr || '').slice(-800))).trim();
}

const PX = 1; // tolerance in px

function columnsAligned(rows, label) {
  const n = rows[0].cells.length;
  for (const r of rows) assert.strictEqual(r.cells.length, n, `${label}: row "${r.id}" has ${r.cells.length} cells, the first row has ${n} — a cell was added or dropped`);
  for (let i = 0; i < n; i++) {
    const x0 = rows[0].cells[i].left;
    for (const r of rows) {
      assert.ok(Math.abs(r.cells[i].left - x0) <= PX,
        `${label}: column ${i + 1} ("${rows[0].cells[i].cls}") starts at x=${r.cells[i].left} on row "${r.id}" but x=${x0} on "${rows[0].id}"`);
    }
  }
}
function oneLine(rows, label) {
  const heights = rows.map(r => r.box.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  for (const r of rows) {
    assert.ok(r.box.height <= median + PX, `${label}: row "${r.id}" is ${r.box.height}px tall, others ${median}px — something wrapped`);
    for (const c of r.cells) {
      assert.ok(c.top < r.box.top + r.box.height - 2, `${label}: cell "${c.cls}" on row "${r.id}" sits below the row's first line`);
    }
  }
}
function cellByPrefix(r, prefix, key) { return r.cells.find(c => c.cls.split(/\s+/).includes(prefix + '-' + key)); }
function decodeColumns(rows, prefix, label) {
  for (const key of ['db', 'dt', 'df', 'msg']) {
    const xs = rows.map(r => ({ id: r.id, c: cellByPrefix(r, prefix, key) }));
    for (const { id, c } of xs) assert.ok(c, `${label}: row "${id}" has no ${prefix}-${key} cell`);
    const x0 = xs[0].c.left;
    for (const { id, c } of xs) {
      assert.ok(Math.abs(c.left - x0) <= PX, `${label}: ${prefix}-${key} starts at x=${c.left} on row "${id}" but x=${x0} on "${xs[0].id}"`);
    }
  }
}
function decodeNumbers(rows, prefix, label) {
  for (const r of rows) {
    const db = cellByPrefix(r, prefix, 'db').text, dt = cellByPrefix(r, prefix, 'dt').text, df = cellByPrefix(r, prefix, 'df').text;
    assert.ok(/^([+-]\d{1,2}|TX)$/.test(db), `${label}: dB "${db}" on row "${r.id}" is not a whole signed number`);
    assert.ok(/^([+-]\d{1,2}\.\d)?$/.test(dt), `${label}: DT "${dt}" on row "${r.id}" is not one-decimal`);
    assert.ok(/^(\d{1,4}|--)?$/.test(df), `${label}: DF "${df}" on row "${r.id}" is not whole Hz`);
  }
}
function spotNumbers(rows, label) {
  for (const r of rows) {
    for (const c of r.cells) {
      if (/spot-freq/.test(c.cls)) assert.ok(/^(\d+\.\d)?$/.test(c.text), `${label}: freq "${c.text}" on "${r.id}"`);
      if (/spot-dist/.test(c.cls)) assert.ok(/^(\d+(mi|km)|\d+(\.\d)?k)?$/.test(c.text), `${label}: distance "${c.text}" on "${r.id}"`);
      if (/spot-zone/.test(c.cls)) assert.ok(/^(\d{1,2}|—)$/.test(c.text), `${label}: zone "${c.text}" on "${r.id}"`);
    }
  }
}

if (!data) {
  const msg = 'rendered checks not run: ' + skipReason;
  if (required) { failures.push('rendered layout'); console.log('  FAIL ' + msg); }
  else console.log('  SKIP ' + msg);
} else {
  const keys = Object.keys(data);
  test('every surface was rendered', () => {
    for (const want of ['spots', 'decodes', 'band', 'mine']) assert.ok(keys.some(k => k.endsWith('-' + want)), 'missing ' + want);
  });
  for (const k of keys.filter(k => k.endsWith('-spots'))) {
    test(`${k}: one cell per column, same x on every row, one line, formatted numbers`, () => {
      columnsAligned(data[k], k); oneLine(data[k], k); spotNumbers(data[k], k);
    });
  }
  for (const k of keys.filter(k => k.endsWith('-decodes'))) {
    test(`${k}: dB/DT/DF/message line up (TX rows too), one line, formatted numbers`, () => {
      decodeColumns(data[k], 'ft8', k); oneLine(data[k], k); decodeNumbers(data[k], 'ft8', k);
    });
  }
  for (const k of keys.filter(k => /-(band|mine)$/.test(k))) {
    test(`${k}: dB/DT/DF/message line up (TX rows too), formatted numbers`, () => {
      decodeColumns(data[k], 'jp', k); decodeNumbers(data[k], 'jp', k);
    });
  }
}

console.log(`\nlayout alignment: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
