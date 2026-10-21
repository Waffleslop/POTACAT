#!/usr/bin/env node
'use strict';
// G8LIY (2026-10-20): "STATION_CALLSIGN = the callsign used over the air
// (G8LIY, G8LIY/P, GM8LIY); OPERATOR = the logging person; OWNER_CALLSIGN =
// the station owner." POTACAT wrote both OPERATOR and STATION_CALLSIGN as the
// Station callsign and never wrote OWNER_CALLSIGN. Now: an activation's
// on-air callsign (activator bar, settings.activatorOnAirCallsign) becomes
// STATION_CALLSIGN on the activation's records only; OPERATOR stays the
// Station callsign; OWNER_CALLSIGN comes from Settings > Station when set.
// Run: node test/onair-callsign-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildAdifFields } = require('../lib/adif-writer');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('On-air callsign / owner callsign');
const main = R('main.js'), app = R('renderer/app.js'), html = R('renderer/index.html');

test('ADIF writer: OWNER_CALLSIGN written only when present, next to STATION_CALLSIGN', () => {
  const base = { callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: '20261020', timeOn: '120000', operator: 'G8LIY', stationCallsign: 'G8LIY/P' };
  const f = buildAdifFields({ ...base, ownerCallsign: 'G8LIY' });
  assert.strictEqual(f.OPERATOR, 'G8LIY');
  assert.strictEqual(f.STATION_CALLSIGN, 'G8LIY/P');
  assert.strictEqual(f.OWNER_CALLSIGN, 'G8LIY');
  assert.ok(!('OWNER_CALLSIGN' in buildAdifFields(base)), 'blank → not written');
});

test('saveQsoRecord: activation records take the on-air callsign, hunter records keep the Station callsign', () => {
  const fn = main.slice(main.indexOf('// Inject operator callsign from settings'), main.indexOf('// Activation record: MY_GRIDSQUARE'));
  assert.ok(/qsoData\.operator = ops\.myCallsign\.toUpperCase\(\);/.test(fn), 'OPERATOR = Station callsign');
  assert.ok(/const onAir = String\(ops\.activatorOnAirCallsign \|\| ''\)\.trim\(\)\.toUpperCase\(\);\n\s*qsoData\.stationCallsign = \(onAir && qsoData\.mySigInfo\) \? onAir : ops\.myCallsign\.toUpperCase\(\);/.test(fn), 'STATION_CALLSIGN = on-air call only on an activation record (MY_SIG_INFO present)');
  assert.ok(/if \(ops\.ownerCallsign && !qsoData\.ownerCallsign\) \{\n\s*qsoData\.ownerCallsign = String\(ops\.ownerCallsign\)\.trim\(\)\.toUpperCase\(\);/.test(fn), 'OWNER_CALLSIGN from settings');
  const logAsIdx = fn.indexOf('if (logAs) {');
  assert.ok(logAsIdx > fn.indexOf('const onAir'), 'Log as still overrides both afterwards');
  assert.ok(/ownerCallsign: raw\.OWNER_CALLSIGN \|\| '',/.test(main), 'a resend keeps OWNER_CALLSIGN');
});

test('activator bar: on-air callsign field, remembered, cleaned to A-Z 0-9 /', () => {
  assert.ok(/id="activator-oncall"/.test(html));
  assert.ok(/onAirInput\.value = \(s && s\.activatorOnAirCallsign\) \|\| '';/.test(app), 'restored from settings');
  assert.ok(/onAirInput\.placeholder = String\(s\.myCallsign\)\.toUpperCase\(\);/.test(app), 'placeholder shows what blank means');
  assert.ok(/replace\(\/\[\^A-Z0-9\/\]\/g, ''\)/.test(app) && /saveSettings\(\{ activatorOnAirCallsign: v \}\)/.test(app), 'saved on change');
});

test('Settings > Station: owner callsign populated and saved', () => {
  assert.ok(/id="set-owner-callsign"/.test(html));
  assert.ok(/setOwnerCallsign\.value = s\.ownerCallsign \|\| '';/.test(app));
  assert.ok(/ownerCallsign: setOwnerCallsign \? setOwnerCallsign\.value\.trim\(\)\.toUpperCase\(\) : '',/.test(app));
});

test('ECHOCAT wire: set-activator-park.onAirCallsign in, activator-state.onAirCallsign out, capability advertised', () => {
  const srv = R('lib/remote-server.js'), proto = R('lib/echocat-protocol.js'), pre = R('preload.js');
  assert.ok(/onAirCallsign: typeof msg\.onAirCallsign === 'string' \? msg\.onAirCallsign : undefined,/.test(srv), 'absent stays undefined (leave alone), "" clears');
  assert.ok(/'activation-onair-call',/.test(srv), 'capability');
  assert.ok(/'set-activator-park': \{[^\n]*onAirCallsign: f\.optString/.test(proto), 'registry field');
  assert.ok(/if \(typeof onAirCallsign === 'string'\) \{\n\s*settings\.activatorOnAirCallsign = cleanOnAirCallsign\(onAirCallsign\);/.test(main), 'main stores it cleaned');
  assert.ok(/function cleanOnAirCallsign\(v\) \{\n\s*return String\(v \|\| ''\)\.toUpperCase\(\)\.replace\(\/\[\^A-Z0-9\/\]\/g, ''\)\.slice\(0, 12\);/.test(main));
  assert.ok(/onAirCallsign: settings\.activatorOnAirCallsign \|\| '',/.test(main), 'activator-state carries it (also replayed at connect)');
  assert.ok(/\(has\('activatorOnAirCallsign'\) && newSettings\.activatorOnAirCallsign !== settings\.activatorOnAirCallsign\)/.test(main), 'a desktop edit pushes to the device');
  assert.ok(/onActivatorOnAirCallsign:/.test(pre) && /window\.api\.onActivatorOnAirCallsign\(\(v\) => \{ onAirInput\.value = v \|\| ''; \}\);/.test(app), 'a device edit shows on the desktop bar');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
