// An empty Propagation table says WHY it is empty (lib/prop-empty-state.js).
// K3SBP 2026-09-23: a blank table during a PSKReporter HTTP 526 outage looked
// exactly like "nobody heard you".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describeEmptyProp } = require('../lib/prop-empty-state');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok ' + name); }

const T = (hhmm) => Date.parse('2026-09-24T' + hhmm + ':00Z');
const base = { myCallsign: 'k3sbp', showRbn: true, showPskr: true, hiddenCount: 0, rbn: { connected: true } };

t('no callsign comes first', () => {
  const m = describeEmptyProp({ ...base, myCallsign: '' });
  assert.match(m.title, /callsign/);
});

t('both sources unticked', () => {
  const m = describeEmptyProp({ ...base, showRbn: false, showPskr: false });
  assert.match(m.title, /Both sources are hidden/);
});

t('reports hidden by band/mode filter are counted', () => {
  assert.match(describeEmptyProp({ ...base, hiddenCount: 1 }).title, /^1 report is hidden/);
  assert.match(describeEmptyProp({ ...base, hiddenCount: 4 }).title, /^4 reports are hidden/);
});

t('PSKReporter failing names the error and the retry time', () => {
  const m = describeEmptyProp({ ...base, pskr: { lastOkAt: T('00:22'), lastError: 'HTTP 526', lastErrorAt: T('00:32'), nextPollAt: T('00:37') } });
  assert.match(m.title, /PSKReporter is not answering \(HTTP 526, last tried 00:32z\)/);
  assert.match(m.detail, /Trying again at 00:37z/);
});

t('an error older than the last success is not a failure', () => {
  const m = describeEmptyProp({ ...base, pskr: { lastOkAt: T('00:40'), lastError: 'HTTP 526', lastErrorAt: T('00:32'), nextPollAt: T('00:45') } });
  assert.match(m.title, /Nobody has reported hearing K3SBP in the last 15 minutes/);
});

t('checked and nobody heard: says the cadence with last/next times', () => {
  const m = describeEmptyProp({ ...base, pskr: { lastOkAt: T('00:32'), nextPollAt: T('00:37') } });
  assert.match(m.title, /Nobody has reported hearing K3SBP/);
  assert.match(m.detail, /every 5 minutes \(last 00:32z, next 00:37z\), and again 90 s after you transmit/);
  assert.match(m.detail, /RBN skimmer spots/);
});

t('before the first poll', () => {
  assert.match(describeEmptyProp({ ...base, pskr: {} }).title, /Checking PSKReporter for the first time/);
});

t('RBN reconnecting is said; PSKReporter hidden drops its sentence', () => {
  const m = describeEmptyProp({ ...base, showPskr: false, rbn: { connected: false }, pskr: { lastError: 'HTTP 526', lastErrorAt: T('00:32') } });
  assert.doesNotMatch(m.title + m.detail, /PSKReporter/);
  assert.match(m.detail, /RBN is reconnecting/);
});

t('both surfaces load the module and render the empty row', () => {
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('renderer/index.html'), /lib\/prop-empty-state\.js/);
  assert.match(read('renderer/prop-popout.html'), /lib\/prop-empty-state\.js/);
  assert.match(read('renderer/app.js'), /sorted\.length === 0\) \{ renderRbnEmptyRow\(\)/);
  assert.match(read('renderer/prop-popout.js'), /sorted\.length === 0\) \{ renderEmptyRow\(\)/);
  assert.match(read('main.js'), /\.\.\.pskrMapPollState\(\)/);
});

t('marker layers are featureGroups (the night overlay calls bringToFront)', () => {
  // A layerGroup has no bringToFront: the throw aborted initRbnMap / initMap on
  // the first open, so the table never rendered and the age tick never armed.
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('renderer/app.js'), /rbnMarkerLayer = L\.featureGroup\(\)/);
  assert.match(read('renderer/prop-popout.js'), /markerLayer = L\.featureGroup\(\)/);
});

console.log(`prop-empty-state: ${pass} passed`);
