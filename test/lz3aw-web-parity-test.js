// LZ3AW round 4, the three web/desktop parity items (#14, #12, #7).
//
// Neither renderer can be require()'d, so the renderer half is source-text
// guards over the exact lines that were wrong; the mode normalization and
// the worked-QSO map are real code under test.
//
// Run: node test/lz3aw-web-parity-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeMode, parseWorkedQsos } = require('../lib/adif');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
// Line endings vary per file (main.js and remote.js are CRLF); the guards are written for LF.
const R = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8').replace(/\r\n/g, '\n');
const app = R('app.js'), web = R('remote.js'), vfo = R('vfo-popout.html');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('=== #14 worked mark = call + BAND + MODE ===');
test('normalizeMode: USB/LSB are SSB; a family MODE with a SUBMODE is the submode', () => {
  assert.strictEqual(normalizeMode('USB'), 'SSB');
  assert.strictEqual(normalizeMode('lsb'), 'SSB');
  assert.strictEqual(normalizeMode('MFSK', 'FT4'), 'FT4');
  assert.strictEqual(normalizeMode('PSK', 'PSK31'), 'PSK31');
  assert.strictEqual(normalizeMode('FT8'), 'FT8');
  assert.strictEqual(normalizeMode('CW', 'CW'), 'CW', 'a non-family MODE keeps its own name');
  assert.strictEqual(normalizeMode(''), '');
});
test('parseWorkedQsos stores the spot-style mode, so FT4-as-MFSK and USB match their spots', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-worked-')), 'log.adi');
  fs.writeFileSync(f, '<EOH>\n<CALL:4>W1AW <BAND:3>20m <MODE:4>MFSK <SUBMODE:3>FT4 <QSO_DATE:8>20260101 <EOR>\n' +
    '<CALL:4>W1AW <BAND:3>40m <MODE:3>USB <QSO_DATE:8>20260102 <EOR>\n');
  const m = parseWorkedQsos(f);
  assert.deepStrictEqual(m.get('W1AW').map((e) => [e.band, e.mode]), [['20M', 'FT4'], ['40M', 'SSB']]);
});
test('main.js: live QSOs enter the worked map with the same normalized mode', () => {
  assert.ok(/normalizeMode: normalizeLogMode \} = require\('\.\/lib\/adif'\)/.test(main));
  assert.strictEqual((main.match(/normalizeLogMode\(qso(?:Data)?\.mode, qso(?:Data)?\.submode\)/g) || []).length, 2, 'both live-add sites');
  assert.ok(!/mode: \(qsoData\.mode \|\| ''\)\.toUpperCase\(\)/.test(main), 'the raw upper-case form is gone');
});
test('desktop: every check-mark site asks hasWorkedOnBandMode, never workedQsos.has(call)', () => {
  assert.ok(/function hasWorkedOnBandMode\(spot\)/.test(app));
  assert.ok(/const worked = hasWorkedOnBandMode\(s\);/.test(app), 'map marker');
  assert.ok(/isWorked: hasWorkedOnBandMode\(s\),/.test(app), 'pop-out spot payload');
  assert.ok(/const isWorked = hasWorkedOnBandMode\(s\);/.test(app), 'table row');
  assert.ok(!/workedQsos\.has\(s\.callsign\.toUpperCase\(\)\)/.test(app), 'call-only check gone');
  // DIGI spots name no single mode; they match on the call + band alone.
  assert.ok(/if \(m === 'DIGI' \|\| m === 'DATA' \|\| m === 'DIGITAL'\) return '';/.test(app));
});
test('web: the spot row uses hasWorkedOnBandMode', () => {
  assert.ok(/function hasWorkedOnBandMode\(s\)/.test(web));
  assert.ok(/const workedEver = !workedToday && hasWorkedOnBandMode\(s\);/.test(web));
  assert.ok(!/function hasWorkedCallsign/.test(web));
});

console.log('\n=== #12 web log follows the dial ===');
test('quick log: follows freq and mode from updateStatus unless the operator typed over it', () => {
  assert.ok(/function quickLogFollowRadio\(\)/.test(web));
  assert.ok(/logSheetFollowRadio\(\);\n\s+quickLogFollowRadio\(\);/.test(web), 'called on every frequency update');
  assert.ok(/currentMode = s\.mode;\n\s+quickLogFollowRadio\(\);/.test(web), 'and on every mode update');
  assert.ok(/qlFreq\.addEventListener\('input', \(\) => \{ qlFreqDirty = true; \}\)/.test(web), 'typing pins it');
  assert.ok(/qlMode\.addEventListener\('change', \(\) => \{\n\s+qlModeDirty = true;/.test(web));
  assert.strictEqual((web.match(/qlFreqDirty = false; qlModeDirty = false;/g) || []).length, 2, 'tab open and submit un-pin it');
});
test('log sheet: a spot-frozen frequency thaws once the radio arrives within 500 Hz', () => {
  assert.ok(/logFreqPinnedKhz = Number\(p\.freqKhz\) \|\| 0;/.test(web));
  assert.ok(/Math\.abs\(currentFreqKhz - logFreqPinnedKhz\) < 0\.5\) \{\n\s+logFreqDirty = false;/.test(web));
  assert.ok(/logFreq\.addEventListener\('input', \(\) => \{ logFreqDirty = true; logFreqPinnedKhz = 0; \}\)/.test(web), 'a typed value stays frozen');
});

console.log('\n=== #7 custom CAT toggle ===');
test('web editor: a blur INSIDE the editor is ignored, and saving never rebuilds the editor', () => {
  assert.ok(/editor\.addEventListener\('focusout', function\(ev\) \{\n\s+if \(ev && ev\.relatedTarget && editor\.contains\(ev\.relatedTarget\)\) return;/.test(web));
  assert.ok(/renderCustomCatButtons\(\{ keepEditor: true \}\);\n\s+saveCustomCatButtons\(\);/.test(web));
  assert.ok(/if \(customCatEditing && !\(opts && opts\.keepEditor\)\) renderCustomCatEditor\(\);/.test(web));
});
test('web: toggle state survives a settings push for unchanged slots', () => {
  const fn = web.slice(web.indexOf('function loadCustomCatButtons'), web.indexOf('function loadCustomCatButtons') + 1200);
  assert.ok(/sig\(before\[i\]\) === sig\(customCatData\[i\]\)/.test(fn));
  assert.ok(!/customToggleState = \{\};\n\s+renderCustomCatButtons\(\);/.test(fn), 'no blanket reset');
});
test('web VFO widget copy: refreshed after a toggle press and shows the lit state', () => {
  assert.ok(/this\.classList\.toggle\('rc-custom-cat-on', goingOn\);\n\s+\/\/ The VFO panel's copy[\s\S]{0,200}window\.__vfRenderCustomCat\(\);/.test(web));
  assert.ok(/if \(srcBtn\.classList\.contains\('rc-custom-cat-on'\)\) btn\.classList\.add\('active'\);/.test(web));
});
test('desktop VFO pop-out: a toggle alternates On and Off commands; sliders are not drawn as buttons', () => {
  assert.ok(/b\.type !== 'slider'\)/.test(vfo));
  assert.ok(/const cmd = String\(\(goingOn \? b\.command : b\.commandOff\) \|\| ''\)\.trim\(\);/.test(vfo));
  assert.ok(/btn\.textContent = b\.name \+ ' ' \+ \(on \? 'On' : 'Off'\);/.test(vfo));
});

console.log(`\nLZ3AW web parity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
