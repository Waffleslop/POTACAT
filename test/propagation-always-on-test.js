'use strict';
/**
 * Propagation (RBN + PSKReporter "where am I heard") is always on (Casey
 * 2026-10-27: "always working for everyone ... just work without having to
 * turn stuff on"). Main already collected both whenever a callsign was set;
 * the view, its two source checkboxes and the activator Prop button were
 * still hidden behind enableRbn / enablePskrMap, two Settings boxes most
 * users never found. Those boxes are gone and nothing may gate the view again.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + e.message); }
}
function body(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}

check('the Settings checkboxes are gone', () => {
  assert.ok(!/id="set-enable-rbn"/.test(html));
  assert.ok(!/id="set-enable-pskr-map"/.test(html));
});
check('the Propagation button and its source checkboxes are never hidden by a setting', () => {
  const b = body(app, 'updateRbnButton');
  assert.ok(!/enableRbn|enablePskrMap/.test(b), 'updateRbnButton reads a setting');
  assert.ok(!/classList\.add\('hidden'\)/.test(b));
});
check('the activator Prop button is always offered', () => {
  const b = body(app, 'updateActivatorRbnButton');
  assert.ok(!/enableRbn|enablePskrMap/.test(b));
});
check('a restored Propagation view is not refused', () => {
  assert.ok(/viewState\.lastView === 'rbn'\) \{/.test(app));
});
check('main collects both whenever a callsign is set', () => {
  assert.ok(/if \(settings\.myCallsign\) connectRbn\(\);/.test(main));
  assert.ok(/if \(settings\.myCallsign\) connectPskrMap\(\);/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
