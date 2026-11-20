#!/usr/bin/env node
'use strict';
// A FlexRadio's GPS (lib/flex-gps.js) and the APRS position source
// (lib/aprs-position.js). The no-fix line is the one a FLEX-8600M sent on
// 2026-11-20 with its GPS antenna unpowered; the fix line is made up, at the
// Washington Monument (38.8895 N, 77.0353 W, grid FM18lv).
// Run: node test/flex-gps-test.js
const assert = require('assert');
const G = require('../lib/flex-gps');
const P = require('../lib/aprs-position');
const B = require('../lib/aprs-beacon');
const { gridToLatLon } = require('../lib/grid');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const NO_FIX = 'S4A2B1C3D|gps lat=0#lon=0#grid=#altitude=0 m#tracked=0#visible=12#speed=0 kts#freq_error=0 ppb#status=Warming Up#time=04:49:39Z#track=0.0';
const ANT = 'S4A2B1C3D|gps gnss_powered_ant=false';
const FIX = 'S4A2B1C3D|gps lat=38.889500#lon=-77.035300#grid=FM18lv#altitude=12 m#tracked=9#visible=12#speed=0 kts#freq_error=0 ppb#status=Fine Lock#time=05:10:02Z#track=0.0';

test('parser: # separates the pairs; a value keeps its spaces', () => {
  const r = G.parseGpsBody(G.gpsBodyOf(NO_FIX));
  assert.strictEqual(r.altitude, '0 m');
  assert.strictEqual(r.status, 'Warming Up');
  assert.strictEqual(r.speed, '0 kts');
  assert.strictEqual(r.freq_error, '0 ppb');
  assert.strictEqual(r.grid, '');
  assert.strictEqual(r.visible, '12');
  assert.strictEqual(r.time, '04:49:39Z');
});

test('parser: only gps status lines are gps', () => {
  assert.strictEqual(G.gpsBodyOf('S4A2B1C3D|interlock state=READY'), null);
  assert.strictEqual(G.gpsBodyOf('R12|0|gps=Present'), null);
  assert.strictEqual(G.gpsBodyOf(ANT), 'gnss_powered_ant=false');
});

test('no fix: the 8600M line is installed, no fix, no position, no grid', () => {
  const t = G.createGpsTracker();
  assert.ok(t.line(NO_FIX));
  const s = t.state();
  assert.strictEqual(s.installed, true);
  assert.strictEqual(s.fix, false);
  assert.strictEqual(s.lat, null);
  assert.strictEqual(s.lon, null);
  assert.strictEqual(s.grid, '');
  assert.strictEqual(s.tracked, 0);
  assert.strictEqual(s.visible, 12);
  assert.strictEqual(s.status, 'Warming Up');
  assert.strictEqual(G.statusLine(s), 'Warming Up, 0 of 12 satellites');
});

test('delta merge: a later line changes only its keys', () => {
  const t = G.createGpsTracker();
  t.line(NO_FIX);
  t.line(ANT);
  let s = t.state();
  assert.strictEqual(s.antennaPowered, false);
  assert.strictEqual(s.status, 'Warming Up', 'the antenna line keeps the status');
  assert.strictEqual(s.visible, 12);
  t.line('S4A2B1C3D|gps tracked=3#status=Acquiring');
  s = t.state();
  assert.strictEqual(s.tracked, 3);
  assert.strictEqual(s.visible, 12, 'visible kept from the first line');
  assert.strictEqual(s.altitude, '0 m');
  assert.strictEqual(s.status, 'Acquiring');
});

test('fix: 9 tracked and a real point is a fix, at that point, with the radio grid', () => {
  const t = G.createGpsTracker();
  t.line(NO_FIX); t.line(FIX);
  const s = t.state();
  assert.strictEqual(s.fix, true);
  assert.strictEqual(s.lat, 38.8895);
  assert.strictEqual(s.lon, -77.0353);
  assert.strictEqual(s.grid, 'FM18lv');
  assert.strictEqual(s.altitude, '12 m');
  assert.strictEqual(G.statusLine(s), 'Fine Lock, 9 of 12 satellites');
});

test('fix rule: fewer than 4 tracked is no fix, whatever the point', () => {
  const s = G.gpsState(G.parseGpsBody('lat=38.8895#lon=-77.0353#tracked=3#visible=12#status=Fine Lock'));
  assert.strictEqual(s.fix, false);
  assert.strictEqual(s.lat, null);
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=38.8895#lon=-77.0353#tracked=4#visible=12')).fix, true);
});

test('fix rule: 0,0 (or a 0 on either axis) is never a fix', () => {
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=0#lon=0#tracked=12#status=Fine Lock')).fix, false);
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=38.8895#lon=0#tracked=12')).fix, false);
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=#lon=#tracked=12')).fix, false);
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=95#lon=-77#tracked=12')).fix, false, 'out of range');
});

test('grid: computed from the fix when the radio gives none or only 4 characters', () => {
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=38.8895#lon=-77.0353#grid=#tracked=8')).grid, 'FM18lv');
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=38.8895#lon=-77.0353#grid=FM18#tracked=8')).grid, 'FM18lv');
  assert.strictEqual(G.gpsState(G.parseGpsBody('lat=38.8895#lon=-77.0353#grid=fm18LV#tracked=8')).grid, 'FM18lv', 'case cleaned');
});

test('installed: Not Present in the status or in the info reply means no GPS', () => {
  assert.strictEqual(G.gpsState(G.parseGpsBody('status=Not Present')).installed, false);
  assert.strictEqual(G.gpsState({}, 'Not Present').installed, false);
  assert.strictEqual(G.gpsState({}, null).installed, false, 'nothing heard yet: not shown');
  assert.strictEqual(G.infoGpsValue('model="FLEX-8600M",chassis_serial="x",gps="Not Present",atu_present=1'), 'Not Present');
  assert.strictEqual(G.infoGpsValue('model=FLEX-6600,gps=Present'), 'Present');
  const t = G.createGpsTracker();
  t.info('model="FLEX-6600",gps="Not Present"');
  t.line(NO_FIX);
  assert.strictEqual(t.state().installed, false);
  assert.strictEqual(G.statusLine(t.state()), 'No GPS in this radio');
});

test('changed(): the same state twice is one change', () => {
  const t = G.createGpsTracker();
  t.line(NO_FIX);
  assert.ok(t.changed());
  t.line(NO_FIX);
  assert.strictEqual(t.changed(), null);
  t.line(FIX);
  assert.ok(t.changed());
});

// ── The position source both beacons use ──
const fixState = (() => { const t = G.createGpsTracker(); t.line(FIX); return t.state(); })();
const noFixState = (() => { const t = G.createGpsTracker(); t.line(NO_FIX); return t.state(); })();

test('provider: GPS chosen with a fix is the GPS position', () => {
  const p = P.beaconPositionFrom({ source: 'gps', gps: fixState, lat: 41.5, lon: -72.1, grid: 'FN31pr', gridToLatLon });
  assert.deepStrictEqual(p, { ok: true, lat: 38.8895, lon: -77.0353, source: 'gps' });
});

test('provider: the chosen precision still applies to the GPS position', () => {
  const p = P.beaconPositionFrom({ source: 'gps', gps: fixState, gridToLatLon });
  const approx = B.buildBeacon({ settingsCall: 'K3ABC', lat: p.lat, lon: p.lon, symbol: 'car', comment: '', approx: true });
  const exact = B.buildBeacon({ settingsCall: 'K3ABC', lat: p.lat, lon: p.lon, symbol: 'car', comment: '', approx: false });
  assert.ok(approx.ok && exact.ok);
  assert.ok(approx.packet.includes(':!3853.  N/07702.  W>'), approx.packet);
  assert.ok(exact.packet.includes(':!3853.37N/07702.12W>'), exact.packet);
});

test('provider: GPS chosen with no fix refuses in a sentence, never another position', () => {
  const p = P.beaconPositionFrom({ source: 'gps', gps: noFixState, lat: 41.5, lon: -72.1, grid: 'FN31pr', gridToLatLon });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'gps-no-fix');
  assert.strictEqual(p.sentence, "Your radio's GPS has no fix yet (Warming Up, 0 of 12 satellites), so nothing was sent.");
  assert.ok(!('lat' in p) && !('lon' in p));
  const none = P.beaconPositionFrom({ source: 'gps', gps: null, grid: 'FN31pr', gridToLatLon });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.reason, 'gps-none');
});

test('provider: never 0,0, even when a state says fix', () => {
  const bad = { installed: true, fix: true, lat: 0, lon: 0, tracked: 9, visible: 12, status: 'Fine Lock' };
  assert.strictEqual(P.beaconPositionFrom({ source: 'gps', gps: bad, gridToLatLon }).ok, false);
});

test('provider: the refusal reaches both packet builders as their sentence', () => {
  const p = P.beaconPositionFrom({ source: 'gps', gps: noFixState, gridToLatLon });
  const b = B.buildBeacon({ settingsCall: 'K3ABC', lat: null, lon: null, symbol: 'house', comment: '', approx: true, positionSentence: p.sentence });
  assert.deepStrictEqual(b, { ok: false, reason: 'position', sentence: p.sentence });
  const RF = require('../lib/aprs-rf-beacon');
  const r = RF.buildRfBeacon({ settingsCall: 'K3ABC', band: '30m', lat: null, lon: null, symbol: 'house', comment: '', approx: true, positionSentence: p.sentence });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.sentence, p.sentence);
});

test('provider: the default source is the Settings position, as before', () => {
  assert.deepStrictEqual(P.beaconPositionFrom({ source: undefined, gps: fixState, lat: 41.5, lon: -72.1, grid: 'FN31pr', gridToLatLon }), { ok: true, lat: 41.5, lon: -72.1, source: 'map' });
  assert.strictEqual(P.beaconPositionFrom({ source: 'settings', gps: fixState, grid: 'FN31pr', gridToLatLon }).source, 'grid');
  const none = P.beaconPositionFrom({ source: 'settings', gps: fixState, grid: '', gridToLatLon });
  assert.deepStrictEqual(none, { ok: false, reason: 'position', sentence: B.SENTENCES.position });
});

test('settings: the source is saved as gps or settings, nothing else', () => {
  assert.strictEqual(B.beaconSettings({}).source, 'settings');
  assert.strictEqual(B.beaconSettings({ aprsBeaconSource: 'gps' }).source, 'gps');
  assert.deepStrictEqual(B.settingsPatch({ source: 'gps' }), { aprsBeaconSource: 'gps' });
  assert.deepStrictEqual(B.settingsPatch({ source: 'moon' }), { aprsBeaconSource: 'settings' });
});

test('provider: a grid precision sends the centre of the GPS grid square, never the fix', () => {
  const g6 = P.beaconPositionFrom({ source: 'gps', precision: 'grid6', gps: fixState, lat: 41.5, lon: -72.1, grid: 'FN31pr', gridToLatLon });
  assert.deepStrictEqual(g6, Object.assign({ ok: true }, gridToLatLon('FM18lv'), { source: 'gps' }));
  const g4 = P.beaconPositionFrom({ source: 'gps', precision: 'grid4', gps: fixState, grid: 'FN31pr', gridToLatLon });
  assert.deepStrictEqual(g4, Object.assign({ ok: true }, gridToLatLon('FM18'), { source: 'gps' }));
  const ex = P.beaconPositionFrom({ source: 'gps', precision: 'exact', gps: fixState, gridToLatLon });
  assert.deepStrictEqual(ex, { ok: true, lat: 38.8895, lon: -77.0353, source: 'gps' });
  assert.strictEqual(P.beaconPositionFrom({ source: 'gps', precision: 'grid4', gps: noFixState, grid: 'FN31pr', gridToLatLon }).ok, false, 'no fix: no grid either');
});

test('provider: the Settings source keeps the precision rule (a grid never uses a picked point)', () => {
  const p = P.beaconPositionFrom({ source: 'settings', precision: 'grid4', lat: 41.5, lon: -72.1, grid: 'FN31pr', gridToLatLon });
  assert.deepStrictEqual(p, Object.assign({ ok: true }, gridToLatLon('FN31'), { source: 'grid' }));
});

// ── The APRS settings panel ──
const W = require('../lib/aprs-window-state');
const withGps = (gps, settings) => ({ grid: 'FN31PR', settings: Object.assign({ approx: true, precision: null, source: 'settings' }, settings || {}), gps: Object.assign({ line: G.statusLine(gps) }, gps) });

test('panel: no GPS in the radio, no choice shown', () => {
  assert.strictEqual(W.sourceChoices(withGps({ installed: false, fix: false })), null);
  assert.strictEqual(W.sourceChoices({ settings: { source: 'settings' } }), null);
});

test('panel: a GPS with no fix shows the choice, disabled, with the status line', () => {
  const c = W.sourceChoices(withGps(noFixState));
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].checked, true);
  assert.strictEqual(c[1].label, "From my radio's GPS");
  assert.strictEqual(c[1].disabled, true);
  assert.ok(c[1].note.includes('Warming Up, 0 of 12 satellites'), c[1].note);
});

test('panel: with a fix the choice can be picked; once chosen it stays shown and checked', () => {
  const c = W.sourceChoices(withGps(fixState));
  assert.strictEqual(c[1].disabled, false);
  assert.ok(c[1].note.includes('FM18lv'));
  const lost = W.sourceChoices(withGps({ installed: false, fix: false }, { source: 'gps' }));
  assert.ok(lost && lost[1].checked, 'the radio dropped: still shown so it can be changed back');
});

test('panel: with the GPS chosen, the precision choices name the GPS grid', () => {
  const c = W.precisionChoices(withGps(fixState, { source: 'gps', precision: 'grid6' }));
  assert.ok(c[0].label.includes('FM18'), c[0].label);
  assert.ok(c[1].label.includes('FM18lv'), c[1].label);
  assert.ok(c[1].checked);
  assert.ok(/GPS/.test(c[2].note));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
