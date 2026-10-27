#!/usr/bin/env node
'use strict';
// "Log as" another operator (KD9WI 2026-10-16: two hams sharing one shack PC,
// taking turns on the radio, each QSO into its own operator's logbook and
// QRZ without switching operators). Policy is lib/log-as.js; main.js writes
// into the other operator's profile logbook with their settings and journals
// the change under their cloud account. Run: node test/log-as-test.js
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LogAs = require('../lib/log-as');
const { ownerIdFor } = require('../lib/cloud-ipc');
const P = require('../lib/echocat-protocol');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Log as another operator');

const ctx = { activeCall: 'KD9WI', profiles: ['KD9WI', 'W9XYZ', 'LZ3AW/P'] };

test('no request = the active operator', () => {
  assert.strictEqual(LogAs.resolveLogAs('', ctx), null);
  assert.strictEqual(LogAs.resolveLogAs(undefined, ctx), null);
  assert.strictEqual(LogAs.resolveLogAs(null, ctx), null);
});
test('naming the active operator = the active operator (nothing special to do)', () => {
  assert.strictEqual(LogAs.resolveLogAs('kd9wi', ctx), null);
  assert.strictEqual(LogAs.resolveLogAs(' KD9WI ', ctx), null);
});
test('another operator on this machine resolves, case-insensitively', () => {
  assert.deepStrictEqual(LogAs.resolveLogAs('w9xyz', ctx), { call: 'W9XYZ' });
  assert.deepStrictEqual(LogAs.resolveLogAs('lz3aw/p', ctx), { call: 'LZ3AW/P' });
});
test('an operator not set up here is refused with a sentence that says where to add them', () => {
  const r = LogAs.resolveLogAs('N0CALL', ctx);
  assert.ok(r && r.error, 'refused');
  assert.ok(/N0CALL/.test(r.error) && /Add operator/.test(r.error), r.error);
});
test('no profiles at all (pre-migration install): any other call is refused, never written somewhere', () => {
  const r = LogAs.resolveLogAs('W9XYZ', { activeCall: 'KD9WI', profiles: [] });
  assert.ok(r && r.error);
});

test('operatorSettings: profile under global, global wins, callsign and log path defaulted', () => {
  const s = LogAs.operatorSettings(
    { myCallsign: 'w9xyz', qrzApiKey: 'their-key', rigs: 'profile-copy', grid: 'EN51' },
    { rigs: 'machine-list', activeProfile: 'KD9WI' },
    { call: 'W9XYZ', profileLogPath: '/p/W9XYZ/potacat_qso_log.adi' }
  );
  assert.strictEqual(s.rigs, 'machine-list', 'global key wins, as loadSettings does for the active operator');
  assert.strictEqual(s.qrzApiKey, 'their-key');
  assert.strictEqual(s.grid, 'EN51');
  assert.strictEqual(s.adifLogPath, '/p/W9XYZ/potacat_qso_log.adi', 'never the active operator\'s file');
  assert.strictEqual(s.myCallsign, 'w9xyz', 'a set callsign is left as stored');
  const blank = LogAs.operatorSettings({}, {}, { call: 'W9XYZ', profileLogPath: '/p/W9XYZ/potacat_qso_log.adi' });
  assert.strictEqual(blank.myCallsign, 'W9XYZ', 'a hand-edited profile with no call logs under the profile call');
  assert.strictEqual(blank.adifLogPath, '/p/W9XYZ/potacat_qso_log.adi');
});
test('logAsSuffix', () => {
  assert.strictEqual(LogAs.logAsSuffix(''), '');
  assert.strictEqual(LogAs.logAsSuffix('w9xyz'), ' for W9XYZ');
});

test('ownerIdFor: the other operator\'s cloud account from THEIR settings; signed out = null', () => {
  assert.strictEqual(ownerIdFor({}), null);
  assert.strictEqual(ownerIdFor({ cloudUser: { id: 'u1' } }), null, 'no token = signed out, even with a cached user');
  assert.strictEqual(ownerIdFor({ cloudAccessToken: 'x.y.z', cloudUser: { id: 'u1', email: 'A@B.C' } }), 'u1');
  const payload = Buffer.from(JSON.stringify({ sub: 'sub-42' })).toString('base64url');
  assert.strictEqual(ownerIdFor({ cloudAccessToken: 'h.' + payload + '.s' }), 'sub-42');
  assert.strictEqual(ownerIdFor({ cloudAccessToken: 'not-a-jwt', cloudUser: { email: 'A@B.C' } }), 'a@b.c');
});

// --- Wire ---
test('protocol: S2C operators {active, profiles}; log-qso has no fixed field list so logAs rides through', () => {
  const m = P.MESSAGES ? P.MESSAGES['operators'] : (P.messages && P.messages['operators']);
  assert.ok(m, 'operators registered');
  assert.ok(m.fields && m.fields.active && m.fields.profiles);
  const src = R('lib/echocat-protocol.js');
  assert.ok(/'operators': \{ dir: Dir\.S2C, feature: 'logging'/.test(src));
  assert.ok(/'log-qso': \{ dir: Dir\.C2S, feature: 'logging' \}/.test(src), 'log-qso stays open-shaped');
});
test('server: advertises log-as, hydrates operators at connect, never to a Guest Pass', () => {
  const src = R('lib/remote-server.js');
  assert.ok(/'log-as',/.test(src), 'capability');
  assert.ok(/this\._echoSpotHides\(ws\);\n\s*this\._echoOperators\(ws\);/.test(src), 'hydrated beside spot-hides');
  assert.ok(/_echoOperators\(ws\) \{\n\s*if \(!this\._operators \|\| ws\._passSession\) return;/.test(src), 'guest never gets the list');
});

// --- main.js (source guards: the write path cannot be driven without Electron) ---
const main = R('main.js');
const save = main.slice(main.indexOf('async function saveQsoRecord(qsoData, opts) {'));
const saveBody = save.slice(0, save.indexOf('\n}\n'));
test('saveQsoRecord resolves logAs first and reads identity, logbook and uploads from `ops`', () => {
  assert.ok(/const logAs = resolveLogAsForSave\(qsoData\);/.test(saveBody));
  assert.ok(/const ops = logAs \? logAs\.settings : settings;/.test(saveBody));
  for (const k of ['myCallsign', 'adifLogPath', 'qrzApiKey', 'qrzLogbook', 'sendToLogbook', 'logbookType', 'defaultPower', 'grid', 'extraUdpEnabled']) {
    assert.ok(!new RegExp('\\bsettings\\.' + k + '\\b').test(saveBody), 'settings.' + k + ' must be ops.' + k + ' inside saveQsoRecord');
  }
  assert.ok(/forwardToLogbook\(qsoData, ops\)/.test(saveBody) && /sendToQrzLogbook\(qsoData, ops\)/.test(saveBody));
  assert.ok(/stationLocationFillFor\(qsoData, ops\)/.test(saveBody), 'station fill (activation + own county) reads the operator being logged for');
});
test('the record is the other operator\'s: OPERATOR and STATION_CALLSIGN forced, journaled under their account', () => {
  assert.ok(/if \(logAs\) \{\n\s*qsoData\.operator = logAs\.call;\n\s*qsoData\.stationCallsign = logAs\.call;/.test(saveBody));
  assert.ok(/const sink = logAs \? logAsLogSink\(ops\) : qsoLogSink;/.test(saveBody));
  assert.ok(/function logAsLogSink\(ops\) \{\n\s*return \(changes\) => \{ if \(cloudIpc\) cloudIpc\.recordLogChangesFor\(cloudIpc\.ownerIdFor\(ops\), changes\); \};/.test(main));
});
test('the active operator\'s caches are untouched by a QSO logged for someone else', () => {
  assert.ok(/if \(!logAs && qsoData\.callsign\) \{\n\s*const call = qsoData\.callsign\.toUpperCase\(\);/.test(saveBody), 'worked QSOs');
  assert.ok(/if \(!logAs && loggedParkRef && !workedParks\.has\(loggedParkRef\)\)/.test(saveBody), 'worked parks');
  assert.ok(/if \(!logAs\) checkEventQso\(qsoData\);/.test(saveBody), 'event progress');
  assert.ok(/if \(!logAs\) scheduleContestHistoryRebuild\(\);/.test(saveBody), 'contest history');
  assert.ok(/if \(!logAs && !qsoData\.eventId && qsoData\.callsign\)/.test(saveBody), 'event stamping');
});
test('resolveLogAsForSave strips logAs from the record and checks the profile exists', () => {
  assert.ok(/function resolveLogAsForSave\(qsoData\) \{[\s\S]*?delete qsoData\.logAs;[\s\S]*?profiles: listProfiles\(\),/.test(main));
  assert.ok(/function operatorSettingsFor\(call\) \{[\s\S]*?_readJsonSafe\(profileSettingsPath\(c\), \{\}\)[\s\S]*?_splitSettings\(settings\)\.global/.test(main));
});
test('ECHOCAT log-qso passes logAs through, except for a Guest Pass', () => {
  assert.ok(/if \(data\.logAs && !\(ctxLogAs && ctxLogAs\.passSession\)\) entry\.logAs = Array\.isArray\(data\.logAs\) \? data\.logAs\.map\(String\) : String\(data\.logAs\);/.test(main));
  assert.ok(/remoteServer\.sendOperators\(operatorsPayload\(\)\);/.test(main), 'hydrate copy beside spot-hides');
  assert.ok(/'profiles-add', \(_e, callsign\) => \{ const r = addProfile\(callsign\); pushOperatorsToClients\(\);/.test(main));
  assert.ok(/'profiles-archive', \(_e, callsign\) => \{ const r = archiveProfile\(callsign\); pushOperatorsToClients\(\);/.test(main));
});
test('forwardToLogbook and sendToQrzLogbook take the operator\'s settings', () => {
  assert.ok(/function forwardToLogbook\(qsoData, s = settings\) \{/.test(main));
  assert.ok(/async function sendToQrzLogbook\(qsoData, s = settings\) \{\n\s*const apiKey = s\.qrzApiKey;/.test(main));
});

// --- Surfaces ---
test('desktop Log QSO dialog: chooser, re-read on open, sent as logAs, named on the button and toast', () => {
  const app = R('renderer/app.js');
  const html = R('renderer/index.html');
  assert.ok(/id="log-as-select"/.test(html));
  assert.ok(/refreshLogAsOperators\(\); \/\/ Log as: back to the active operator on every open\n\s*logDialog\.showModal\(\);/.test(app));
  assert.ok(/logAs: logAsChosen\(\),/.test(app));
  assert.ok(/: `Save for \$\{t\.join\(' \+ '\)\}`;/.test(app), 'the button names every operator ticked');
  assert.ok(/showLogToast\(`Logged \$\{displayCalls\}\$\{logAsTail\(\)\}`\)/.test(app));
});
test('Log QSO pop-out: chooser from its own preload, sent as logAs', () => {
  assert.ok(/profilesList: \(\) => ipcRenderer\.invoke\('profiles-list'\)/.test(R('preload-log-popout.js')));
  const js = R('renderer/log-popout.js');
  assert.ok(/logAs: logAsChosen\(\),/.test(js));
  assert.ok(/id="lp-log-as"/.test(R('renderer/log-popout.html')));
});
test('ECHOCAT Web: one choice for the Log tab, the log sheet and the quick log', () => {
  const js = R('renderer/remote.js');
  const html = R('renderer/remote.html');
  for (const id of ['lt-log-as', 'log-log-as', 'ql-log-as']) assert.ok(new RegExp('id="' + id + '"').test(html), id);
  assert.ok(/case 'operators':/.test(js));
  assert.strictEqual((js.match(/if \(logAsCall\) baseData\.logAs = logAsValue\(\);/g) || []).length, 2, 'Log tab + sheet');
  assert.ok(/if \(logAsCall\) data\.logAs = logAsValue\(\);/.test(js), 'quick log');
  assert.ok(/'Logged ' \+ \(msg\.callsign \|\| ''\) \+ logAsTail\(\)/.test(js));
});

// "Log as: both" (KD9WI 2026-10-17): tick both operators, one record each.
test('logAsTargets: array, comma list or one call; unique, order kept', () => {
  assert.deepStrictEqual(LogAs.logAsTargets(['kd9wi', 'W9XYZ', 'KD9WI']), ['KD9WI', 'W9XYZ']);
  assert.deepStrictEqual(LogAs.logAsTargets('KD9WI, w9xyz'), ['KD9WI', 'W9XYZ']);
  assert.deepStrictEqual(LogAs.logAsTargets('W9XYZ'), ['W9XYZ']);
  assert.deepStrictEqual(LogAs.logAsTargets(''), []);
  assert.deepStrictEqual(LogAs.logAsTargets(undefined), []);
});
test('splitForOperators: one copy each; only the first re-spots or keeps the record id', () => {
  const q = { callsign: 'N0OTS', respot: true, wwffRespot: true, dxcRespot: true, gmaRespot: true, llotaRespot: true, wwbotaRespot: true, uuid: 'u-1', sigInfo: 'US-1234', logAs: ['KD9WI', 'W9XYZ'] };
  const [a, b] = LogAs.splitForOperators(q, ['KD9WI', 'W9XYZ']);
  assert.strictEqual(a.logAs, 'KD9WI'); assert.strictEqual(b.logAs, 'W9XYZ');
  assert.strictEqual(a.respot, true); assert.strictEqual(a.uuid, 'u-1');
  for (const k of LogAs.RESPOT_KEYS) assert.ok(!(k in b), 'second copy never re-spots: ' + k);
  assert.ok(!('uuid' in b), 'second copy gets its own record id');
  assert.strictEqual(b.sigInfo, 'US-1234', 'the contact itself is identical');
  assert.strictEqual(q.logAs.length, 2, 'the request is not mutated');
});
test('saveQsoRecord fans out per operator and the duplicate guard is per operator', () => {
  assert.ok(/const targets = qsoData \? LogAs\.logAsTargets\(qsoData\.logAs\) : \[\];\n\s*if \(targets\.length > 1\) \{/.test(main));
  assert.ok(/for \(const q of LogAs\.splitForOperators\(qsoData, targets\)\)/.test(main));
  assert.ok(/const dedupKey = _qsoDedupKey\(qsoData\) \+ '\|' \+ \(logAs \? logAs\.call : ''\);/.test(main),
    "the second operator's copy is not suppressed as a double-fire");
  assert.ok(/'log-as-multi'/.test(R('lib/remote-server.js')), 'capability for clients that send an array');
});
test('desktop dialog and pop-out: a checkbox per operator, active ticked, none = no save', () => {
  for (const js of [R('renderer/app.js'), R('renderer/log-popout.js')]) {
    assert.ok(/type="checkbox" value="/.test(js), 'checkboxes');
    assert.ok(/if \(logAsChosen\(\) === null\) return; \/\/ Log for: nobody ticked/.test(js), 'nobody ticked never saves');
  }
});
test('ECHOCAT Web: a Both / All choice sends every operator', () => {
  const js = R('renderer/remote.js');
  assert.ok(/function logAsValue\(\) \{ return logAsCall === LOG_AS_ALL \? logAsAllCalls\(\) : logAsCall; \}/.test(js));
  assert.ok(/'Both \(' \+ active \+ ' \+ ' \+ others\[0\] \+ '\)'/.test(js));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
