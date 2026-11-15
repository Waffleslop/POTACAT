'use strict';
// #603: a VoiceOver user could not tell which rig a radio button selects or
// which rig the delete button removes. Every control in the Settings rig list
// (and the Welcome rig row, and ECHOCAT Web's rig picker) carries a spoken
// name that includes the rig's name.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const remoteHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.html'), 'utf8');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

const start = app.indexOf('function renderRigList(');
assert(start > 0, 'renderRigList not found');
const body = app.slice(start, app.indexOf('\nfunction ', start + 10));

t('the "None" radio has a spoken name', () => {
  assert(/name="active-rig"[^>]*aria-label="No radio connected"/.test(body));
});
t('each rig radio is named "Use <rig name>"', () => {
  assert(/radio\.setAttribute\('aria-label', 'Use ' \+ rigLabel\)/.test(body));
});
t('Edit names the rig', () => {
  assert(/editBtn\.setAttribute\('aria-label', 'Edit ' \+ rigLabel\)/.test(body));
});
t('the delete cross names the rig', () => {
  assert(/deleteBtn\.setAttribute\('aria-label', 'Delete ' \+ rigLabel\)/.test(body));
});
t('the Welcome rig row remove cross names the rig', () => {
  const w = app.slice(app.indexOf('function showWelcomeRigItem('));
  assert(/removeBtn\.setAttribute\('aria-label', 'Remove ' \+/.test(w.slice(0, 1500)));
});
t('ECHOCAT Web rig picker label is tied to its select', () => {
  assert(/<label class="so-label" for="rig-select">Rig<\/label>/.test(remoteHtml));
});

console.log(`rig-list-a11y-test: ${passed} passed`);
