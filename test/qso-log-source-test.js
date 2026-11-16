'use strict';
// #634 (based on w5lee's PR): a contact logged from ECHOCAT (phone or Web)
// carries ADIF APP_POTACAT_LOG_SOURCE=ECHOCAT; one logged at the station or
// by a POTACAT desktop client carries nothing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { logSourceForPlatform } = require('../lib/qso-log-source');
const { buildAdifFields } = require('../lib/adif-writer');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); }
}

t('phone and ECHOCAT Web platforms are ECHOCAT', () => {
  assert.strictEqual(logSourceForPlatform('ios 18.1 iPhone'), 'ECHOCAT');
  assert.strictEqual(logSourceForPlatform('ios 17.4 iPad'), 'ECHOCAT');
  assert.strictEqual(logSourceForPlatform('android 34 android'), 'ECHOCAT');
  assert.strictEqual(logSourceForPlatform('web'), 'ECHOCAT');
});
t('a desktop client, an unknown client or none is unmarked', () => {
  for (const p of ['desktop-win32', 'desktop-darwin', 'unknown', 'node', '', null, undefined, 'iosfoo', 'webby']) {
    assert.strictEqual(logSourceForPlatform(p), '', String(p));
  }
});
t('ADIF carries APP_POTACAT_LOG_SOURCE only when set', () => {
  const base = { callsign: 'K3SBP', frequency: '14074', mode: 'FT8', qsoDate: '20261115', timeOn: '1200' };
  assert.strictEqual(buildAdifFields({ ...base, logSource: 'ECHOCAT' }).APP_POTACAT_LOG_SOURCE, 'ECHOCAT');
  assert.ok(!('APP_POTACAT_LOG_SOURCE' in buildAdifFields(base)));
});

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
t('ECHOCAT log form and remote JTCAT mark the source; the JTCAT window does not', () => {
  assert.ok(/logSource: opts\?\.fromWindow \? '' : echoCatLogSource\(\)/.test(main), 'jtcatAutoLog');
  assert.ok(/logSource: echoCatLogSource\(\),/.test(main), 'remote log form');
  assert.ok(/QsoLogSource\.logSourceForPlatform\(/.test(main), 'rule lives in lib/qso-log-source.js');
});
t('rebuilt records and Cloud pull keep the source', () => {
  assert.ok(/logSource: raw\.APP_POTACAT_LOG_SOURCE \|\| ''/.test(main), 'rawQsoToQsoData');
  assert.ok(/logSource: q\.APP_POTACAT_LOG_SOURCE \|\| ''/.test(main), 'Cloud pull forward');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function buildActivationAdifQsos('), app.indexOf('function buildActivationAdifQsos(') + 1500);
  assert.ok(/logSource: c\.logSource \|\| ''/.test(fn), 'Past Activations export');
});
t('Logbook Source column: off by default, not editable', () => {
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'qso-popout.js'), 'utf8');
  const i = pop.indexOf("key: 'APP_POTACAT_LOG_SOURCE'");
  assert.ok(i > 0);
  const col = pop.slice(i, pop.indexOf('},', i));
  assert.ok(/label: 'Source'/.test(col) && /off: true/.test(col) && !/field:/.test(col), col);
});

console.log(`\nLog source (#634): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
