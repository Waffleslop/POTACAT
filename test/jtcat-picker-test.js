#!/usr/bin/env node
'use strict';
// The JTCAT window for older eyes (Casey 2026-11-02): one band-and-mode button
// and picker, buttons that are the actions.
// Run: node test/jtcat-picker-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the band and mode selects stay in the DOM as the sources of truth', () => {
  for (const id of ['jp-band', 'jp-mode', 'jp-auto-cq', 'jp-enable-tx']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(/class="jp-src-selects" hidden/.test(html));
  assert.ok(/id="jp-enable-tx" class="jp-btn" hidden/.test(html));
});
test('picker: taps only pick; Switch drives the selects; hidden bands stay out', () => {
  assert.ok(/if \(bo\.hidden && band !== curBand\) return;/.test(js), 'rig-bands filter');
  const apply = js.slice(js.indexOf('function pkApply('), js.indexOf('function pkApply(') + 1100);
  assert.ok(/modeSelect\.dispatchEvent\(new Event\('change'\)\)/.test(apply) && /selectBand\(opt, true\)/.test(apply));
  const render = js.slice(js.indexOf('function pkRender('), js.indexOf('function pkOpen('));
  assert.ok(!/selectBand|window\.api\.tune/.test(render), 'a tap must not retune');
});
test('a voice or CW tune that stops the engine reaches the window, and the picker restarts it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const stop = main.slice(main.indexOf('stopping FT8/FT4 engine'), main.indexOf('stopping FT8/FT4 engine') + 300);
  assert.ok(stop.includes('jtcatWindowStopped()'), 'tune path tells the window');
  assert.ok(/send\('jtcat-engine-stopped'\)/.test(main));
  assert.ok(/var same = !engineStopped && /.test(js), 'Switch stays live while stopped');
  const apply = js.slice(js.indexOf('function pkApply('), js.indexOf('function pkApply(') + 600);
  assert.ok(apply.indexOf('jtcatStart(pk.mode)') < apply.indexOf('selectBand(opt, true)'), 'start before the tune, which sets the dial anchor');
  assert.ok(/state === 'running'\) setEngineStopped\(false\)/.test(js), 'a start from a phone clears it');
});
test('the button follows paths that assign the mode with no change event', () => {
  assert.ok(/Object\.defineProperty\(modeSelect, 'value'/.test(js));
});
test('controls: the buttons are the actions', () => {
  for (const id of ['jp-cq', 'jp-hunt-btn', 'jp-hunt-target', 'jp-halt-tx', 'jp-tune', 'jp-atu', 'jp-full-auto-cq', 'jp-cq-preview']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(html.includes('>Logbook</button>'));
  assert.ok(html.includes('whichever half is free'));
  assert.ok(js.includes("'<option value=\"\">everyone</option>'"));
});
test('every QSO step is outlined', () => {
  assert.ok(/\.jp-qso-step \{[^}]*border: 1px solid var\(--border-primary\)/.test(html));
});

test('Hunt targets: each reads its one flag, and only from a CQ', () => {
  const { matchesHuntFilter: m } = require('../lib/jtcat-state-machine');
  for (const [mode, flag] of [['wanted-country', 'countryWanted'], ['dx', 'isDx'], ['chase', 'chaseMatch'], ['watchlist', 'watched']]) {
    assert.strictEqual(m('CQ K2ABC FN20', mode, { [flag]: true }), true, mode);
    assert.strictEqual(m('CQ K2ABC FN20', mode, { [flag]: false }), false, mode);
    assert.strictEqual(m('CQ K2ABC FN20', mode), false, mode);
    assert.strictEqual(m('W1AW K2ABC -10', mode, { [flag]: true }), false, mode + ' never a non-CQ');
  }
});
test('Hunt targets reach every surface', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('chaseMatch: !settings.jtcatChaseTarget || !!d.chaseMatch'), 'Call = everyone hunts anyone');
  const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.html'), 'utf8');
  for (const v of ['wanted-country', 'dx', 'chase', 'watchlist']) {
    assert.ok(html.includes('<option value="' + v + '"'), 'popout ' + v);
    assert.ok(web.includes('<option value="' + v + '"'), 'web ' + v);
  }
  const rs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  assert.ok(rs.includes("'hunt-targets'"), 'capability');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
