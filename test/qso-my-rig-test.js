'use strict';
// #633 (based on w5lee's PR): the radio a contact was logged on is ADIF MY_RIG.
// The active rig's name is captured in logContact; an external logger
// (WSJT-X bridge) keeps its own value; rebuilt records carry it through.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildAdifFields } = require('../lib/adif-writer');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); }
}

const base = { callsign: 'K3SBP', frequency: '14074', mode: 'FT8', qsoDate: '20261115', timeOn: '1200' };

t('MY_RIG written when the record has a rig', () => {
  assert.strictEqual(buildAdifFields({ ...base, myRig: 'FT-710' }).MY_RIG, 'FT-710');
});
t('MY_RIG left out when there is no rig', () => {
  assert.ok(!('MY_RIG' in buildAdifFields({ ...base })));
  assert.ok(!('MY_RIG' in buildAdifFields({ ...base, myRig: '' })));
});

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const lc = main.slice(main.indexOf('async function logContact('), main.indexOf('async function logContact(') + 2500);
t('logContact captures the active rig, not for the WSJT-X bridge or a remote client', () => {
  assert.ok(/const myRig = entry\.myRig \|\|/.test(lc), 'myRig capture');
  assert.ok(/wsjtx-bridge/.test(lc) && /isRemoteMode\(\)/.test(lc), 'external logger and remote mode keep blank');
  assert.ok(/stationSetupRigById\(\)\?\.name/.test(lc), 'active rig name');
  assert.ok(/\{ \.\.\.entry, myRig \}/.test(lc), 'carried into the record');
});
t('WSJT-X bridge, rebuilt records and Cloud pull read MY_RIG', () => {
  assert.ok(/myRig: f\.MY_RIG \|\| ''/.test(main), 'WSJT-X bridge');
  assert.ok(/myRig: raw\.MY_RIG \|\| ''/.test(main), 'rawQsoToQsoData');
  assert.ok(/myRig: q\.MY_RIG \|\| ''/.test(main), 'Cloud pull forward');
});
t('Past Activations export carries the rig', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function buildActivationAdifQsos('), app.indexOf('function buildActivationAdifQsos(') + 1500);
  assert.ok(/myRig: c\.myRig \|\| ''/.test(fn));
});
t('Logbook has a Rig column, editable, off by default', () => {
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'qso-popout.js'), 'utf8');
  const line = pop.split(/\r?\n/).find(l => /key: 'MY_RIG'/.test(l)) || '';
  assert.ok(/label: 'Rig'/.test(line) && /field: 'MY_RIG'/.test(line) && /off: true/.test(line), line);
});

console.log(`\nMY_RIG (#633): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
