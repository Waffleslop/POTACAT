// #672: the Small VFO's frequency can be typed and clicked again (Casey
// 2026-11-16: "When I click the freq to edit, no dialpad opens and I can't
// overwrite the numbers on it ... Rethink this.").
// Before: the keypad opened inside the hidden pane, and digits + Enter tuned
// the radio to a number the operator never saw.
// Run: node test/vfo-freq-entry-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const E = require('../lib/vfo-freq-entry');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const html = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
const between = (a, n) => { const i = html.indexOf(a); assert.ok(i >= 0, 'missing: ' + a); return html.slice(i, i + n); };

console.log('VFO frequency entry at both sizes (#672)');

test('a click: the Small VFO grows to the keypad, the Large VFO opens it, the lock wins', () => {
  assert.strictEqual(E.clickRoute({ mini: true }), 'grow-keypad');
  assert.strictEqual(E.clickRoute({ mini: false }), 'keypad');
  assert.strictEqual(E.clickRoute({ mini: true, locked: true }), 'locked');
  assert.strictEqual(E.clickRoute({ mini: false, locked: true }), 'locked');
});

test('Small VFO typing goes to the strip when the frequency is on it, else grows to the keypad', () => {
  const st = { mini: true, freqInStrip: true };
  for (const k of ['0', '7', '9', '.', ',']) assert.strictEqual(E.keyRoute(k, st), 'strip-type', k);
  assert.strictEqual(E.keyRoute('1', { mini: true, freqInStrip: false }), 'grow-type');
  assert.strictEqual(E.keyRoute('1', { mini: true, freqInStrip: true, locked: true }), 'locked');
  assert.strictEqual(E.keyRoute('Backspace', { ...st, entryOpen: true }), 'strip-back');
  assert.strictEqual(E.keyRoute('Enter', { ...st, entryOpen: true }), 'strip-go');
  assert.strictEqual(E.keyRoute('Escape', { ...st, entryOpen: true }), 'cancel');
  assert.strictEqual(E.keyRoute('a', st), 'none');
});

test('Enter never tunes a buffer the operator cannot see', () => {
  // The Small VFO with the keypad pane "active" but hidden: nothing.
  assert.strictEqual(E.keyRoute('Enter', { mini: true, keypadShown: true }), 'none');
  assert.strictEqual(E.keyRoute('Enter', { mini: true, keypadShown: true, freqInStrip: true }), 'none');
  assert.strictEqual(E.keyRoute('Backspace', { mini: true, keypadShown: true }), 'none');
  // An entry that is not on the strip (hidden for width): nothing.
  assert.strictEqual(E.keyRoute('Enter', { mini: true, entryOpen: true, freqInStrip: false }), 'none');
  // Large VFO, keypad closed: nothing; open: Tune.
  assert.strictEqual(E.keyRoute('Enter', { mini: false, keypadShown: false }), 'none');
  assert.strictEqual(E.keyRoute('Enter', { mini: false, keypadShown: true }), 'keypad-go');
});

test('the Large VFO is unchanged: typing opens the keypad, Backspace and Enter work in it', () => {
  assert.strictEqual(E.keyRoute('1', { mini: false }), 'keypad-type');
  assert.strictEqual(E.keyRoute('.', { mini: false, locked: true }), 'keypad-type', 'locked: Tune reminds, as before');
  assert.strictEqual(E.keyRoute('Backspace', { mini: false, keypadShown: true }), 'keypad-back');
  assert.strictEqual(E.keyRoute('Backspace', { mini: false }), 'none');
});

test('a paste: strip, grow, or keypad', () => {
  assert.strictEqual(E.pasteRoute({ mini: true, freqInStrip: true }), 'strip');
  assert.strictEqual(E.pasteRoute({ mini: true, freqInStrip: false }), 'grow');
  assert.strictEqual(E.pasteRoute({ mini: false }), 'keypad');
});

test('keys build the text as the keypad does: 10 characters, one point', () => {
  let b = '';
  for (const k of '14.07.4') b = E.addKey(b, k);
  assert.strictEqual(b, '14.074');
  assert.strictEqual(E.addKey('1407', ','), '1407.');
  assert.strictEqual(E.addKey('1234567890', '1'), '1234567890');
  assert.strictEqual(E.addKey('14', 'x'), '14');
});

test('page: the lib is loaded and the click routes through it (Small VFO grows to the keypad)', () => {
  assert.ok(html.includes('<script src="../lib/vfo-freq-entry.js"></script>'));
  const click = between("freqDisplay.addEventListener('click'", 400);
  assert.ok(/VfoFreqEntry\.clickRoute\(\{ mini: vfoMini, locked: vfoLocked \}\)/.test(click));
  assert.ok(/route === 'locked'\) \{ stripClose\(\); window\.api\.setVfoLock\(true\); return; \}/.test(click), 'the lock wins');
  assert.ok(/route === 'grow-keypad'\) \{ kpGrowFromMini\(\); return; \}/.test(click));
});

test('page: growing for the keypad goes back to the strip after Tune or Cancel, as the gear does', () => {
  const grow = between('function kpGrowFromMini()', 400);
  assert.ok(/kpFromMini = true;\s*setMini\(false, \{ save: false \}\);\s*showPane\('keypad'\);/.test(grow));
  const show = between('function showPane(name)', 400);
  assert.ok(/else if \(kpFromMini\) \{ kpFromMini = false; setMini\(true, \{ save: false \}\); \}/.test(show));
  // Tune and Cancel both end in showPane('dial').
  assert.ok(/document\.getElementById\('kp-cancel'\)\.addEventListener\('click', \(\) => showPane\('dial'\)\);/.test(html));
  assert.ok(/updateDisplay\(\);\s*showPane\('dial'\);\s*\}\);/.test(between("kpGo.addEventListener('click'", 600)));
  // Switching size by hand clears the round trip and any strip entry.
  assert.ok(/function setMini\(on, \{ save = true \} = \{\}\) \{\s*stripClose\(\);\s*if \(on\) kpFromMini = false;/.test(html));
});

test('page: typed digits show in the strip, marked as being typed, with the hint', () => {
  const r = between('function stripRender()', 700);
  assert.ok(/'<span class="fq-main">' \+ kpBuffer \+ '<span class="fq-caret"/.test(r), 'the typed text is what the strip shows');
  assert.ok(/FreqDots\.fromKhz\(khz\)/.test(r), 'with what Enter will tune');
  assert.ok(r.includes("'Type a frequency, Enter to tune, Esc to cancel'"));
  assert.ok(/freqDisplay\.classList\.add\('entry'\)/.test(between('function stripOpen()', 200)));
  assert.ok(/if \(stripEntry\) stripRender\(\);/.test(between('function updateDisplay()', 200)), 'a poll never overwrites the typing');
  assert.ok(/\.freq-display\.entry \{ box-shadow: 0 0 0 2px var\(--blue\);/.test(html), 'marked with a theme colour');
  assert.ok(/\.fq-caret \{[^}]*background: var\(--blue\)/.test(html));
});

test('page: Enter tunes only through the routed keys; Esc and a click elsewhere cancel', () => {
  const kd = between("document.addEventListener('keydown'", 2400);
  assert.ok(/VfoFreqEntry\.keyRoute\(e\.key, \{\s*mini: vfoMini, entryOpen: stripEntry, keypadShown: kpActive && !vfoMini,/.test(kd), 'the hidden keypad is not "shown"');
  assert.ok(/case 'strip-go': stripGo\(\); break;/.test(kd));
  assert.ok(/case 'keypad-go': kpGo\.click\(\); break;/.test(kd));
  assert.strictEqual((kd.match(/kpGo\.click\(\)/g) || []).length, 1, 'one way to the keypad Tune');
  assert.ok(/case 'cancel':\s*if \(stripEntry\) stripClose\(\); else showPane\('dial'\);/.test(kd));
  assert.ok(/if \(route\.startsWith\('strip-'\)\) e\.preventDefault\(\);/.test(kd), 'Enter never also presses a focused strip button');
  const go = between('function stripGo()', 400);
  assert.ok(/if \(vfoLocked\) \{ stripClose\(\); window\.api\.setVfoLock\(true\); return; \}/.test(go));
  assert.ok(/tuneJumpFromPopout\(khz\);[\s\S]*kpRememberRecent\(khz\);[\s\S]*stripClose\(\);/.test(go));
  assert.ok(/if \(stripEntry && !freqDisplay\.contains\(e\.target\)\) stripClose\(\);/.test(html), 'a click elsewhere cancels');
  assert.ok(/window\.addEventListener\('blur', \(\) => stripClose\(\)\);/.test(html));
});

test('page: the strip entry only opens where it can be seen', () => {
  const f = between('function freqInStrip()', 300);
  assert.ok(/freqDisplay\.parentNode === miniStrip/.test(f));
  assert.ok(/!freqDisplay\.classList\.contains\('mini-hidden'\)/.test(f));
  const paste = between("document.addEventListener('paste'", 1200);
  assert.ok(/VfoFreqEntry\.pasteRoute\(\{ mini: vfoMini, freqInStrip: freqInStrip\(\) \}\)/.test(paste));
  assert.ok(!/kpGo\.click\(\)|stripGo\(\)/.test(paste), 'a paste never tunes by itself');
});

console.log(`\nVFO frequency entry: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
