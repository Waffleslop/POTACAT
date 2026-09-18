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

console.log('\n=== #13 {call}: the most recently changed field, on any surface ===');
const { TypedCallTracker } = require('../lib/typed-call');
test('tracker: latest non-empty field wins; a cleared field drops out and the next most recent stands in', () => {
  const t = new TypedCallTracker();
  assert.strictEqual(t.current(), '');
  t.set('web:vf', 'w1aw ');
  assert.strictEqual(t.current(), 'W1AW');
  t.set('main:log', 'K3SBP');
  assert.strictEqual(t.current(), 'K3SBP', 'newer field wins over an older one');
  t.set('main:log', '');
  assert.strictEqual(t.current(), 'W1AW', 'cleared: the older still-filled field stands in');
  t.set('popout', 'N2XYZ');
  t.clear('popout');
  assert.strictEqual(t.current(), 'W1AW');
  t.set('web:vf', '');
  assert.strictEqual(t.current(), '', 'nothing left');
});
test('main: one setter broadcasts the winner to the window, the VFO pop-out and ECHOCAT; pop-out close clears; web reports arrive', () => {
  assert.ok(/const typedCalls = new TypedCallTracker\(\);/.test(main));
  const fn = main.slice(main.indexOf('function setTypedCall'), main.indexOf('function setTypedCall') + 700);
  assert.ok(/if \(now === prev\) return;/.test(fn), 'no broadcast when the winner is unchanged');
  assert.ok(/win\.webContents\.send\('log-popout-callsign', now\)/.test(fn) && /vfoPopoutWin\.webContents\.send\('log-popout-callsign', now\)/.test(fn) && /remoteServer\.sendTypedCall\(now\)/.test(fn));
  assert.ok(/ipcMain\.on\('log-popout-callsign', \(_e, call, source\) => \{/.test(main));
  assert.ok(/logPopoutWin = null;\n\s+setTypedCall\('popout', ''\);/.test(main));
  assert.ok(/vfoPopoutWin\.webContents\.send\('log-popout-callsign', typedCalls\.current\(\)\);/.test(main), 'VFO pop-out hydrated on open');
  assert.ok(/remoteServer\.on\('typed-call', \(\{ call, source \}\) => setTypedCall\('web:' \+ \(source \|\| 'log'\), call\)\);/.test(main));
});
test('protocol + server: typed-call is registered both ways, demuxed, and hydrated at connect', () => {
  const proto = require('../lib/echocat-protocol');
  const reg = proto.MESSAGES || proto.REGISTRY || proto.messages || proto;
  const entry = (reg && reg['typed-call']) || (proto.get && proto.get('typed-call'));
  assert.ok(entry, 'registry entry');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/case 'typed-call':\n[\s\S]{0,300}this\.emit\('typed-call', \{ call: String\(msg\.call \|\| ''\), source: String\(msg\.source \|\| ''\) \}\);/.test(srv));
  assert.ok(/sendTypedCall\(call\) \{\n\s+this\._typedCall = String\(call \|\| ''\);/.test(srv));
  assert.ok(/if \(this\._typedCall\) this\._sendTo\(ws, \{ type: 'typed-call', call: this\._typedCall \}\);/.test(srv), 'hydrated');
});
test('web: every call field reports (typed, filled, cleared) and {call} prefers the shared winner', () => {
  for (const src of ['ql', 'lt', 'log']) assert.ok(new RegExp(`reportTypedCall\\('${src}', ${src}Call\\.value\\)`).test(web), src + ' typing');
  assert.ok(/reportTypedCall\('vf', v\);/.test(web), 'VFO-panel box');
  assert.ok(/logCall\.value = p\.callsign \|\| '';\n\s+reportTypedCall\('log', logCall\.value\);/.test(web), 'sheet open (code-set)');
  assert.ok(/function closeLogSheet\(\) \{\n\s+reportTypedCall\('log', ''\);/.test(web), 'sheet close');
  assert.ok(/qlCall\.value = '';\n\s+reportTypedCall\('ql', ''\);/.test(web), 'quick log cleared after logging');
  assert.ok(/case 'typed-call':\n\s+sharedTypedCall = /.test(web));
  const mc = web.slice(web.indexOf('function macroCallsign'), web.indexOf('function macroCallsign') + 900);
  assert.ok(/if \(sharedTypedCall\) return sharedTypedCall;/.test(mc), 'shared winner first');
});
test('desktop: every call field reports with its source; the expander prefers the shared winner, then live fields', () => {
  assert.ok(/reportLogCallsign\(v, 'main:log'\)/.test(app));
  assert.ok(/reportLogCallsign\(blCallsign\.value\.trim\(\)\.toUpperCase\(\), 'main:banner'\)/.test(app));
  assert.ok(/reportLogCallsign\(activatorCallsignInput\.value\.trim\(\)\.toUpperCase\(\), 'main:activator'\)/.test(app));
  assert.ok((app.match(/reportLogCallsign\('', 'main:activator'\)/g) || []).length >= 1, 'activator clears report');
  assert.ok(/logDialog\.addEventListener\('close', \(\) => \{ report\(''\); if \(logCallEl\) logCallEl\.value = ''; \}\);/.test(app), 'dialog close clears the field too');
  const ex = app.slice(app.indexOf('function expandDesktopCwMacros'), app.indexOf('function expandDesktopCwMacros') + 900);
  assert.ok(/const call = _logPopoutCallsign \|\| live/.test(ex));
  assert.ok(/'log-callsign', 'activator-callsign', 'bl-callsign'/.test(ex), 'all three local fields are read live');
});
test('log pop-out: reports on code-set values as well as typing; preloads carry the source', () => {
  const lp = R('log-popout.js');
  assert.ok((lp.match(/reportCall\(\);/g) || []).length >= 3, 'clearForm + both prefills report');
  assert.ok(/ipcRenderer\.send\('log-popout-callsign', call, 'popout'\)/.test(fs.readFileSync(path.join(__dirname, '..', 'preload-log-popout.js'), 'utf8')));
  assert.ok(/reportLogCallsign: \(call, source\) => ipcRenderer\.send\('log-popout-callsign', call, source\)/.test(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')));
  assert.ok(/text\.replace\(\/\\\{call\\\}\/gi, cwTypedCall \|\| cwTunedCall \|\| ''\)/.test(vfo), 'VFO pop-out free text expands {call}');
});

console.log('\n=== round 4b (his 2026-09-18 reply) ===');
const P = require('../renderer/jtcat-parser');
test('JTCAT: a hash-bracketed CQ call is answerable once the brackets come off; an unresolved <...> is refused', () => {
  assert.deepStrictEqual(P.inferReplyStep({ text: 'CQ <SP9ABC/P> KO02' }, 'LZ3AW'), { step: 'reply-cq', call: 'SP9ABC/P', theirGrid: 'KO02' });
  assert.deepStrictEqual(P.parseCq('CQ POTA <GB13COL> IO91'), { call: 'GB13COL', grid: 'IO91' });
  assert.strictEqual(P.inferReplyStep({ text: 'CQ <...> KO02' }, 'LZ3AW'), null);
  assert.deepStrictEqual(P.inferReplyStep({ text: '<LZ3AW> SP9ABC/P' }, 'LZ3AW'), { step: 'reply-cq', call: 'SP9ABC/P' }, 'our own hashed call still reads as addressed to us');
});
test('CW Key Port: key-as-I-type APPENDS to the DTR queue instead of cancelling it, and holds the TX flag', () => {
  const fn = main.slice(main.indexOf('function sendCwTextViaDtrKey'), main.indexOf('function sendCwTextToRadio'));
  assert.ok(/if \(live && queueActive\) \{\n\s+\/\/ Append/.test(fn), 'append branch');
  assert.ok(/t = Math\.max\(0, _cwDtrQueueEndAt - Date\.now\(\)\);/.test(fn), 'starts where the queue ends');
  assert.ok(/_cwDtrQueueEndAt = Date\.now\(\) \+ t;/.test(fn));
  assert.ok(/cat\.noteTransmitting\(t \+ 200\)/.test(fn), 'the link watchdog is told');
  assert.ok(/sendCwTextViaDtrKey\(expanded, wpm, txtPins, \{ live \}\)/.test(main), 'the live flag reaches the key port');
  assert.ok(/remoteServer\.setCwKeyerOutput\(\(\{ down \}\) => \{\n[\s\S]{0,500}if \(down && cat && typeof cat\.noteTransmitting === 'function'\) cat\.noteTransmitting\(2000\);/.test(main), 'paddle edges hold TX too');
});
test('manual entry: desktop New QSO and the web Log tab take a UTC date and time', () => {
  const html = R('qso-popout.html'), js = R('qso-popout.js');
  assert.ok(/id="qso-new-date"/.test(html) && /id="qso-new-time"/.test(html));
  assert.ok(/stampNewQsoNow\(\);/.test(js.slice(js.indexOf("newQsoBtn.addEventListener('click'"), js.indexOf("newQsoBtn.addEventListener('click'") + 400)), 'pre-filled with now on open');
  assert.ok(/const qsoDate = \(\(newQsoDate && newQsoDate\.value\) \|\| nowIso\.slice\(0, 10\)\)\.replace\(\/-\/g, ''\);/.test(js));
  const rh = R('remote.html');
  assert.ok(/id="lt-date"/.test(rh) && /id="lt-time"/.test(rh));
  assert.ok(/if \(ltDate && ltTime && ltDate\.value && ltTime\.value\) \{\n\s+const ms = Date\.parse\(ltDate\.value \+ 'T' \+ ltTime\.value \+ ':00Z'\);\n\s+if \(Number\.isFinite\(ms\)\) baseData\.qsoAt = ms;/.test(web), 'blank = now, filled = past');
});

console.log(`\nLZ3AW web parity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
