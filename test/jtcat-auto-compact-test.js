'use strict';
// #857: the JTCAT window picks a compact layout by itself when it is short
// (a 1366x768 laptop). lib/jtcat-layout.js decides; renderer/jtcat-popout.js
// applies it as body.jp-compact and never moves or resizes the window.
// Options > The picture > Layout: Automatic (default), Full, Compact.
// An explicit Full or Compact always wins over the automatic pick.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

let L = null;
try { L = require('../lib/jtcat-layout'); } catch (e) { L = null; }
function lib() { assert.ok(L, 'lib/jtcat-layout.js exists'); return L; }

const js = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.js'));
const html = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.html'));
const main = readSrc(path.join(ROOT, 'main.js'));
const doc = readSrc(path.join(ROOT, 'docs', 'JTCAT.md'));

function extract(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i !== -1, name + ' exists');
  let depth = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}

// ---------------------------------------------------------------------------
// The thresholds come from the layout (measured, see the lib's header).
// ---------------------------------------------------------------------------
test('thresholds: compact below 800 px, full again from 840 px (40 px of hysteresis)', () => {
  const { COMPACT_BELOW, FULL_FROM } = lib();
  assert.strictEqual(COMPACT_BELOW, 800);
  assert.strictEqual(FULL_FROM, 840);
  assert.ok(FULL_FROM > COMPACT_BELOW, 'a band between the two edges');
});

test('Automatic: below the threshold goes compact', () => {
  const { pick } = lib();
  for (const h of [480, 600, 700, 720, 799]) {
    assert.strictEqual(pick({ choice: 'auto', height: h, current: 'full' }), 'compact', h + ' px');
  }
});

test('Automatic: above the threshold stays (or goes) full', () => {
  const { pick } = lib();
  for (const h of [840, 900, 1080, 1400]) {
    assert.strictEqual(pick({ choice: 'auto', height: h, current: 'full' }), 'full', h + ' px from full');
    assert.strictEqual(pick({ choice: 'auto', height: h, current: 'compact' }), 'full', h + ' px from compact');
  }
  assert.strictEqual(pick({ choice: 'auto', height: 800, current: 'full' }), 'full', '800 is not below 800');
});

test('hysteresis: inside 800..839 the layout keeps what it shows, so it never flickers at the edge', () => {
  const { pick } = lib();
  for (const h of [800, 810, 825, 839]) {
    assert.strictEqual(pick({ choice: 'auto', height: h, current: 'compact' }), 'compact', h + ' px stays compact');
    assert.strictEqual(pick({ choice: 'auto', height: h, current: 'full' }), 'full', h + ' px stays full');
  }
  // A drag that wobbles across 800 switches once, not on every pixel.
  let cur = 'full';
  const seen = [];
  for (const h of [805, 799, 801, 798, 802, 830, 839, 838, 841, 836, 845]) {
    const next = pick({ choice: 'auto', height: h, current: cur });
    if (next !== cur) seen.push(h + ':' + next);
    cur = next;
  }
  assert.deepStrictEqual(seen, ['799:compact', '841:full']);
});

test('an explicit choice always wins over the automatic pick', () => {
  const { pick } = lib();
  for (const h of [480, 600, 799, 820, 900, 1400]) {
    for (const cur of ['full', 'compact']) {
      assert.strictEqual(pick({ choice: 'full', height: h, current: cur }), 'full', 'Full at ' + h);
      assert.strictEqual(pick({ choice: 'compact', height: h, current: cur }), 'compact', 'Compact at ' + h);
    }
  }
});

test('no height yet (a window still opening): keep what is shown, full by default', () => {
  const { pick } = lib();
  assert.strictEqual(pick({ choice: 'auto', height: 0 }), 'full');
  assert.strictEqual(pick({ choice: 'auto', height: NaN, current: 'compact' }), 'compact');
  assert.strictEqual(pick({ choice: 'auto' }), 'full');
});

// ---------------------------------------------------------------------------
// Migration of saved choices: there was no layout setting before #857. A
// missing or unknown value is Automatic; a saved Full or Compact is kept as it
// is. The automatic pick is never written back, so it never turns into a choice.
// ---------------------------------------------------------------------------
test('migration: no saved jtcatLayout (every install before #857) reads as Automatic', () => {
  const { normalizeChoice, DEFAULT_CHOICE } = lib();
  assert.strictEqual(DEFAULT_CHOICE, 'auto');
  for (const v of [undefined, null, '', 'AUTO ', 'big', 0, 1, true, false, {}, []]) {
    assert.strictEqual(normalizeChoice(v), 'auto', JSON.stringify(v));
  }
});

test('migration: an operator who explicitly chose a layout keeps it', () => {
  const { normalizeChoice, pick } = lib();
  assert.strictEqual(normalizeChoice('full'), 'full');
  assert.strictEqual(normalizeChoice('compact'), 'compact');
  assert.strictEqual(normalizeChoice('auto'), 'auto');
  // A saved Full on a short laptop stays full; a saved Compact on a tall screen stays compact.
  assert.strictEqual(pick({ choice: normalizeChoice('full'), height: 700, current: 'full' }), 'full');
  assert.strictEqual(pick({ choice: normalizeChoice('compact'), height: 1200, current: 'full' }), 'compact');
});

test('migration: only the operator\'s own choice is saved, never the automatic pick', () => {
  const saves = js.match(/saveSettings\(\{\s*jtcatLayout\b[^)]*\)/g) || [];
  assert.strictEqual(saves.length, 1, 'one place writes jtcatLayout: ' + JSON.stringify(saves));
  const apply = extract(js, 'applyJpLayout');
  assert.ok(!/saveSettings/.test(apply), 'applyJpLayout (the automatic pick) never saves');
  const setChoice = extract(js, 'setJpLayoutChoice');
  assert.ok(/if \(persist\) window\.api\.saveSettings\(\{ jtcatLayout: layoutChoice \}\)/.test(setChoice), 'saved only when persist (the select)');
  assert.ok(/layoutSelect\.addEventListener\('change', function\(\) \{ setJpLayoutChoice\(layoutSelect\.value, true\); \}\)/.test(js), 'the select is the one persisting caller');
  assert.ok(/setJpLayoutChoice\(s\.jtcatLayout, false\)/.test(js), 'settings load applies without saving');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
test('wiring: the window loads lib/jtcat-layout.js before jtcat-popout.js', () => {
  const a = html.indexOf('<script src="../lib/jtcat-layout.js"></script>');
  const b = html.indexOf('<script src="jtcat-popout.js"></script>');
  assert.ok(a !== -1, 'script tag');
  assert.ok(a < b, 'before jtcat-popout.js');
});

test('wiring: Options > The picture has Layout with Automatic (default), Full and Compact', () => {
  const m = /<select id="jp-layout"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(m, '#jp-layout select');
  const opts = [...m[1].matchAll(/<option value="(\w+)"( selected)?>([^<]+)<\/option>/g)].map((x) => [x[1], !!x[2], x[3]]);
  assert.deepStrictEqual(opts.map((o) => o[0]), ['auto', 'full', 'compact']);
  assert.deepStrictEqual(opts.map((o) => o[2]), ['Automatic', 'Full', 'Compact']);
  assert.ok(opts[0][1], 'Automatic is selected by default');
  const picture = html.indexOf('<div class="jp-opt-section">The picture</div>');
  const special = html.indexOf('<div class="jp-opt-section">Special events only</div>');
  const at = html.indexOf('id="jp-layout"');
  assert.ok(picture < at && at < special, 'inside The picture');
});

test('wiring: the compact layout is CSS on body.jp-compact and shrinks the chrome, not the text', () => {
  assert.ok(/body\.jp-compact \.jp-waterfall \{[^}]*height: 48px/.test(html), 'a shorter waterfall');
  assert.ok(/body\.jp-compact \.jp-btn\.jp-big \{[^}]*height: 34px/.test(html), 'shorter big buttons');
  assert.ok(/body\.jp-compact \.jp-row \{[^}]*padding: 1px 10px/.test(html), 'tighter decode rows');
  const rules = (html.match(/body\.jp-compact[^{]*\{[^}]*\}/g) || []).join('\n');
  const sizes = [...rules.matchAll(/font-size: (\d+)px/g)].map((x) => Number(x[1]));
  assert.ok(sizes.every((n) => n >= 13), 'no text under 13 px in compact: ' + sizes.join(','));
});

test('wiring: the window applies the pick on load and on resize, and sizes the waterfall after a switch', () => {
  const apply = extract(js, 'applyJpLayout');
  assert.ok(/JtcatLayout\.pick\(\{ choice: layoutChoice, height: window\.innerHeight, current: layoutNow \}\)/.test(apply), 'pick from the window height');
  assert.ok(/document\.body\.classList\.toggle\('jp-compact', next === 'compact'\)/.test(apply), 'body class');
  assert.ok(/resizeWaterfall\(\)/.test(apply), 'the canvas follows its new height');
  assert.ok(/window\.addEventListener\('resize', function\(\) \{[^}]*applyJpLayout/.test(js.replace(/\n\s*/g, ' ')), 'resize listener');
});

test('wiring: changing the layout never moves or resizes the window', () => {
  const block = js.slice(js.indexOf('// #857 Layout:'), js.indexOf('// end #857'));
  assert.ok(block.length > 200, 'the #857 block is marked');
  assert.ok(!/setBounds|setSize|resizeTo|resizeBy|moveTo|moveBy|setZoom/.test(block), 'no window geometry or zoom calls');
});

test('wiring: the automatic switch says so once, and only for Automatic', () => {
  const apply = extract(js, 'applyJpLayout');
  assert.ok(/next === 'compact' && layoutChoice === 'auto'\) tellCompactOnce\(\)/.test(apply));
  const tell = extract(js, 'tellCompactOnce');
  assert.ok(/localStorage\.getItem\('jtcat-compact-told'\)/.test(tell) && /localStorage\.setItem\('jtcat-compact-told', '1'\)/.test(tell), 'remembered once');
  assert.ok(/Options > Layout/.test(tell), 'names where to change it');
});

test('wiring: jtcatLayout is a machine-wide display setting, documented', () => {
  assert.ok(/'jtcatLayout',/.test(main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf('const GLOBAL_KEYS') + 6000)), 'GLOBAL_KEYS');
  assert.ok(/jtcatLayout/.test(doc), 'docs/JTCAT.md');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
