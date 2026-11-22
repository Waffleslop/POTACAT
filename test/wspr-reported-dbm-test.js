'use strict';
// The power a WSPR beacon reports, in dBm — GitHub #268, follow-up 2026-11-13.
//
// Since #268 the beacon runs at the level the operator sets while it is armed
// (5 W on an IC-7100 at 2 m, where 1 W makes nothing). The dBm it put in its
// message was still capped at 30 (1 W), so a 5 W beacon told WSPRnet "1 W".
// The report now follows the beacon's RF power by default (Auto), or a fixed
// value the operator picks, anywhere in WSPR's 0..60 dBm.
//
// These tests pin: the WSPR values, watts -> dBm (never above what is set),
// the control rules (a client from before Auto never turns it off), the menu
// the JTCAT window and ECHOCAT Web both draw, the drive scaling, and the
// main.js / renderer / wire wiring.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const D = require('../lib/wspr/dbm');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

console.log('WSPR values');
t('0..60 dBm, only values ending in 0, 3 or 7', () => {
  assert.deepStrictEqual(D.LEVELS, [0, 3, 7, 10, 13, 17, 20, 23, 27, 30, 33, 37, 40, 43, 47, 50, 53, 57, 60]);
  assert.ok(D.isValid(37) && D.isValid(60) && D.isValid(0));
  assert.ok(!D.isValid(36) && !D.isValid(61) && !D.isValid(-3) && !D.isValid('30'));
});
t('each value stands for a round wattage', () => {
  assert.strictEqual(D.nominalWatts(30), 1);
  assert.strictEqual(D.nominalWatts(33), 2);
  assert.strictEqual(D.nominalWatts(37), 5);
  assert.strictEqual(D.nominalWatts(40), 10);
  assert.strictEqual(D.nominalWatts(50), 100);
  assert.strictEqual(D.nominalWatts(60), 1000);
  assert.ok(Math.abs(D.nominalWatts(23) - 0.2) < 1e-12);
  assert.ok(Math.abs(D.nominalWatts(0) - 0.001) < 1e-12);
});

console.log('dbmForWatts (Auto)');
t('the default 1 W beacon still reports 30 dBm', () => {
  assert.strictEqual(D.dbmForWatts(1), 30);
});
t('a 5 W beacon reports 37 dBm, not 30 (the bug) and not 33 (37 dBm is 5.01 W)', () => {
  assert.strictEqual(D.dbmForWatts(5), 37);
});
t('never above what is set: 4 W -> 33 (2 W), 1.5 W -> 30, 9 W -> 37', () => {
  assert.strictEqual(D.dbmForWatts(4), 33);
  assert.strictEqual(D.dbmForWatts(1.5), 30);
  assert.strictEqual(D.dbmForWatts(9), 37);
});
t('the radio\'s range: 10, 50, 100, 200 W, 1 kW and beyond', () => {
  assert.strictEqual(D.dbmForWatts(10), 40);
  assert.strictEqual(D.dbmForWatts(50), 47);
  assert.strictEqual(D.dbmForWatts(100), 50);
  assert.strictEqual(D.dbmForWatts(200), 53);
  assert.strictEqual(D.dbmForWatts(1000), 60);
  assert.strictEqual(D.dbmForWatts(1500), 60);
});
t('milliwatts and garbage', () => {
  assert.strictEqual(D.dbmForWatts(0.5), 27);
  assert.strictEqual(D.dbmForWatts(0.0005), 0);
  assert.strictEqual(D.dbmForWatts(0), 0);
  assert.strictEqual(D.dbmForWatts(NaN), 0);
});

console.log('reportedDbm / normalizeManual');
t('Auto is the default (no saved flag), and follows the beacon watts', () => {
  assert.strictEqual(D.reportedDbm({ auto: undefined, manualDbm: 30, beaconWatts: 5 }), 37);
  assert.strictEqual(D.reportedDbm({ auto: true, manualDbm: 20, beaconWatts: 1 }), 30);
});
t('a fixed pick is reported as chosen, up to 60, whatever the radio is set to', () => {
  assert.strictEqual(D.reportedDbm({ auto: false, manualDbm: 23, beaconWatts: 5 }), 23);
  assert.strictEqual(D.reportedDbm({ auto: false, manualDbm: 47, beaconWatts: 1 }), 47);
  assert.strictEqual(D.reportedDbm({ auto: false, manualDbm: 60, beaconWatts: 1 }), 60);
});
t('a fixed value snaps down to a WSPR value inside 0..60', () => {
  assert.strictEqual(D.normalizeManual(36), 33);
  assert.strictEqual(D.normalizeManual(99), 60);
  assert.strictEqual(D.normalizeManual(-5), 0);
  assert.strictEqual(D.normalizeManual('37'), 37);
  assert.strictEqual(D.normalizeManual(undefined), 30);
});
t('every value saved before (0..30) comes through unchanged', () => {
  for (const d of [0, 7, 10, 13, 17, 20, 23, 27, 30]) assert.strictEqual(D.normalizeManual(d), d);
});

console.log('applyControl');
const AUTO = { auto: true, dbm: 30 };
const FIXED20 = { auto: false, dbm: 20 };
t('dBmAuto true turns Auto on (dBm ignored)', () => {
  assert.deepStrictEqual(D.applyControl(FIXED20, { dBmAuto: true, dBm: 7 }), { auto: true, dbm: 20 });
});
t('dBmAuto false with a dBm is a fixed pick', () => {
  assert.deepStrictEqual(D.applyControl(AUTO, { dBmAuto: false, dBm: 43 }), { auto: false, dbm: 43 });
});
t('a dBm alone is a fixed pick (an older client choosing from its menu)', () => {
  assert.deepStrictEqual(D.applyControl(AUTO, { dBm: 23 }), { auto: false, dbm: 23 });
});
t('a dBm riding an on/off toggle from an older client never turns Auto off', () => {
  assert.deepStrictEqual(D.applyControl(AUTO, { enabled: true, txPct: 20, dBm: 30 }), { auto: true, dbm: 30 });
  assert.deepStrictEqual(D.applyControl(FIXED20, { enabled: true, dBm: 17 }), { auto: false, dbm: 17 });
});
t('no power fields = unchanged; nothing saved = Auto at 30', () => {
  assert.deepStrictEqual(D.applyControl(FIXED20, { txPct: 50 }), FIXED20);
  assert.deepStrictEqual(D.applyControl({}, {}), { auto: true, dbm: 30 });
  assert.deepStrictEqual(D.applyControl(AUTO, { dBm: null, enabled: false }), AUTO);
});

console.log('driveScale');
t('Auto keeps full drive (it reports what the radio is set to)', () => {
  assert.strictEqual(D.driveScale({ auto: true, reportedDbm: 33, beaconWatts: 4 }), 1);
});
t('a fixed report below the radio\'s level turns the drive down toward it, as before', () => {
  assert.ok(Math.abs(D.driveScale({ auto: false, reportedDbm: 20, beaconWatts: 1 }) - Math.sqrt(0.1)) < 1e-9);
  assert.strictEqual(D.driveScale({ auto: false, reportedDbm: 0, beaconWatts: 1 }), 0.05);
});
t('a fixed report at or above the radio\'s level keeps full drive', () => {
  assert.strictEqual(D.driveScale({ auto: false, reportedDbm: 30, beaconWatts: 1 }), 1);
  assert.strictEqual(D.driveScale({ auto: false, reportedDbm: 47, beaconWatts: 5 }), 1);
});

console.log('menu (the JTCAT window and ECHOCAT Web draw this one list)');
t('Auto first, naming what it reports now, then every WSPR value with its watts', () => {
  const m = D.menu({ dBmAuto: true, dBm: 37 });
  assert.strictEqual(m.value, 'auto');
  assert.strictEqual(m.options[0].text, 'Auto: 37 dBm (5 W)');
  assert.strictEqual(m.options.length, 1 + D.LEVELS.length);
  assert.deepStrictEqual(m.options[1], { value: '0', text: '0 dBm (1 mW)' });
  assert.deepStrictEqual(m.options[m.options.length - 1], { value: '60', text: '60 dBm (1 kW)' });
  assert.ok(m.options.some(o => o.text === '23 dBm (200 mW)'));
});
t('a fixed pick selects its value', () => {
  assert.strictEqual(D.menu({ dBmAuto: false, dBm: 43 }).value, '43');
  assert.strictEqual(D.menu({ dBmAuto: false, dBm: 43 }).options[0].text, 'Auto');
});
t('a pick sends Auto or a fixed value', () => {
  assert.deepStrictEqual(D.controlFromMenu('auto'), { dBmAuto: true });
  assert.deepStrictEqual(D.controlFromMenu('37'), { dBmAuto: false, dBm: 37 });
});

console.log('wiring (source-text guards)');
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const popJs = readSrc(path.join(root, 'renderer', 'jtcat-popout.js'));
const popHtml = readSrc(path.join(root, 'renderer', 'jtcat-popout.html'));
const webJs = readSrc(path.join(root, 'renderer', 'remote.js'));
const webHtml = readSrc(path.join(root, 'renderer', 'remote.html'));
const rs = readSrc(path.join(root, 'lib', 'remote-server.js'));
const bridge = require('../lib/remote-bridge');
const P = require('../lib/echocat-protocol');
t('main.js has no 30 dBm cap left', () => {
  assert.ok(!/JTCAT_WSPR_MAX_DBM|clampWsprDbm|wsprWattsFromDbm/.test(main));
  assert.ok(!/Math\.min\(30, /.test(main.slice(main.indexOf('function wsprBeaconTick()'), main.indexOf('function remoteJtcatMyCall()'))));
});
t('every beacon frame, arm and identity check reports wsprReportedDbm()', () => {
  assert.ok(main.includes('return WsprDbm.reportedDbm({ auto: wsprDbmAuto(), manualDbm: settings.wsprDbm, beaconWatts: wsprBeaconWatts() });'));
  const tick = main.slice(main.indexOf('function wsprBeaconTick()'), main.indexOf('function setWsprBeacon('));
  assert.ok(tick.includes('const dbm = wsprReportedDbm();'));
  assert.ok(main.includes('encodeWspr(call, grid, wsprReportedDbm(), { baseFreqHz: 1500 });'));
  assert.ok(main.includes('jtcatWsprScheduler.setDbm(wsprReportedDbm());'));
});
t('both control paths go through WsprDbm.applyControl', () => {
  assert.ok(main.includes('const dbmNext = WsprDbm.applyControl(dbmBefore, opts);'));
  assert.ok(main.includes("ipcMain.on('jtcat-wspr-beacon', (_e, opts) => applyWsprBeaconControl(opts));"));
  assert.ok(main.includes("remoteServer.on('jtcat-wspr-beacon', (opts) => applyWsprBeaconControl(opts));"));
  assert.ok(/dBmAuto: msg\.dBmAuto/.test(rs), 'remote-server passes dBmAuto through');
});
t('the beacon state carries dBm, dBmAuto and beaconWatts, and goes out when the power moves', () => {
  assert.ok(main.includes('dBm: wsprReportedDbm(), dBmAuto: wsprDbmAuto(), beaconWatts: wsprBeaconWatts(),'));
  const note = main.slice(main.indexOf('function wsprNoteOperatorPower('), main.indexOf('let _wsprBeaconLevelLogTimer'));
  assert.ok(note.includes('wsprBroadcastBeaconState();'));
});
t('the JTCAT window and ECHOCAT Web draw the menu from lib/wspr/dbm.js', () => {
  assert.ok(popHtml.includes('<script src="../lib/wspr/dbm.js"></script>'));
  assert.ok(webHtml.includes('<!-- wspr-dbm-js -->'));
  assert.ok(rs.includes("['wspr-dbm-js', 'wspr/dbm.js']"));
  assert.ok(popJs.includes('var m = window.WsprDbm.menu(st);'));
  assert.ok(webJs.includes('const m = window.WsprDbm.menu(st);'));
  assert.ok(popJs.includes('window.WsprDbm.controlFromMenu(wsprDbmEl.value)'));
  assert.ok(webJs.includes('window.WsprDbm.controlFromMenu(wsprDbm.value)'));
  assert.ok(!/Math\.min\(30,/.test(popJs) && !/Math\.min\(30,/.test(webJs), 'a renderer still caps at 30 dBm');
  assert.ok(!/capped at 30 dBm/.test(popHtml) && !/capped at 30 dBm/.test(webHtml));
});
t('the remote pop-out bridge carries dBmAuto', () => {
  const r = bridge.OUT['jtcat-wspr-beacon']([{ dBmAuto: false, dBm: 37 }]);
  assert.deepStrictEqual(r.send[0], { type: 'jtcat-wspr-beacon', dBm: 37, dBmAuto: false });
});
t('the ECHOCAT schema knows the new fields', () => {
  assert.ok(P.validate({ type: 'jtcat-wspr-beacon', dBmAuto: true }, P.Dir.C2S).ok);
  assert.ok(!P.validate({ type: 'jtcat-wspr-beacon', dBmAuto: 'yes' }, P.Dir.C2S).ok);
  assert.ok(P.validate({ type: 'jtcat-wspr-beacon-state', enabled: true, dBm: 37, dBmAuto: true, beaconWatts: 5 }, P.Dir.S2C).ok);
});
t('no transmit band limit was added with this', () => {
  const ctl = main.slice(main.indexOf('function applyWsprBeaconControl('), main.indexOf('function remoteJtcatMyCall()'));
  assert.ok(!/band/i.test(ctl));
});

console.log(`\nWSPR reported dBm: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
