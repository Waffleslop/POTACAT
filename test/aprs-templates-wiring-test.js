#!/usr/bin/env node
'use strict';
// APRS A2: message templates as wired in main.js, the preload and the
// Messages view (source-text guards; CRLF and LF both pass). The rules
// themselves are in test/aprs-templates-test.js.
// Run: node test/aprs-templates-wiring-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};
const main = read('main.js');

console.log('APRS message templates: wiring');

test('the context: the running activation (as the beacon comment), else the radio; the Settings callsign', () => {
  const ctx = fnBody(main, 'aprsTemplatesContext');
  assert.ok(/aprsActivationNow\(\)/.test(ctx));
  assert.ok(/AprsActivation\.activationFrequency\(/.test(ctx), 'no activation: the dial and mode');
  assert.ok(/AprsActivation\.freqWord\(/.test(ctx) && /AprsActivation\.modeWord\(/.test(ctx), 'the spot words the beacon uses');
  assert.ok(/settings\.myCallsign/.test(ctx));
});

test('my templates: kept in the profile settings (aprsMsgTemplates), checked again in main', () => {
  const save = fnBody(main, 'aprsTemplatesSave');
  assert.ok(/AprsTemplates\.saveMine\(settings\.aprsMsgTemplates/.test(save));
  assert.ok(/saveSettings\(settings\)/.test(save));
  assert.ok(!/aprsMsgTemplates/.test(main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS')))), 'not a machine-wide key: per profile');
  for (const ch of ["'aprs-templates-get'", "'aprs-templates-save'", "'aprs-templates-delete'"]) assert.ok(main.includes(ch), ch);
});

test('templates never send: no send call in the template glue or the panel', () => {
  const block = main.slice(main.indexOf('// ── APRS A2: message templates'), main.indexOf('// ── APRS phase 7'));
  assert.ok(block.length > 300);
  assert.ok(!/aprsMessageSend|aprsUplink|\.send\(|compose\(/.test(block));
  const panel = read('renderer/aprs-templates-panel.js');
  assert.ok(!/messageSend/.test(panel), 'the panel only fills the box');
  assert.ok(/V\.setCompose\(f\.to, f\.text, hint\)/.test(panel));
  assert.ok(!/\balert\(|\bconfirm\(|\bprompt\(/.test(panel), 'no pop-ups');
});

test('Send waits while a template field is left in the text', () => {
  const view = read('renderer/aprs-messages.js');
  assert.ok(/AprsTemplates\.unfilled\(/.test(view));
  assert.ok(/!left\.length\)/.test(view));
  assert.ok(/'Replace ' \+ left\.join\(' and '\) \+ ' before sending\.'/.test(view));
});

test('preload and window: the channels; the formats load before the panel', () => {
  const pre = read('preload-aprs-popout.js');
  for (const k of ['templatesGet', 'templatesSave', 'templatesDelete', 'onTemplates']) assert.ok(pre.includes(k + ':'), k);
  const html = read('renderer/aprs-popout.html');
  const i = (s) => html.indexOf(s);
  assert.ok(i('aprs-messages.js"') < i('../lib/aprs-templates.js') && i('../lib/aprs-templates.js') < i('aprs-templates-panel.js'));
  assert.ok(html.includes('aprs-templates-panel.css'));
  const css = read('renderer/aprs-templates-panel.css');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css.replace(/var\([^)]*\)/g, '')), 'theme variables only');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
