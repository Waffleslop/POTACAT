'use strict';
// POTA.app sign-in (NA4DQ 2026-10-18, macOS): pota.app moved from hash routes
// to paths and signs in from a "Sign In" button (Cognito, back to "/"), so
// POTACAT's `#/user/login` opened "It Seems This Page Went QRT", and the
// window closed as soon as the operator clicked away from it, before they had
// signed in. Source-level: lib/pota-sync.js needs Electron to load.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pota-sync.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

test('opens pota.app itself, never the retired #/user/login route', () => {
  assert.ok(/const LOGIN_URL = 'https:\/\/pota\.app\/';/.test(SRC));
  assert.ok(!/#\/user\/login'/.test(SRC.replace(/^\s*\/\/.*$/gm, '')), 'no live reference to the old route');
});

test('the window closes only once the Cognito id-token cookie exists', () => {
  const i = SRC.indexOf('const maybeAutoClose = async () => {');
  assert.ok(i > 0, 'async auto-close');
  const body = SRC.slice(i, SRC.indexOf('loginDetected = true;', i));
  assert.ok(/signedIn = !!\(await this\._readCognitoCookies\(\)\)/.test(body), 'checks the cookie');
  assert.ok(/if \(!signedIn \|\| loginDetected/.test(body), 'not signed in = stay open');
  assert.ok(/const signedInPoll = setInterval\(maybeAutoClose, 1500\);/.test(SRC), 'polled, not only on navigation');
  assert.ok(/clearInterval\(signedInPoll\);/.test(SRC), 'poll stops with the window');
});

test('the injected Sign In press picks "Sign In", never "Sign Up" or "Sign Out"', () => {
  const i = SRC.indexOf('executeJavaScript(`\n            (() => {');
  assert.ok(i > 0, 'snippet');
  const a = SRC.indexOf('`', i) + 1;
  const j = SRC.indexOf('})()`', i) + 4;
  // eslint-disable-next-line no-eval
  const snippet = eval('`' + SRC.slice(a, j) + '`').trim();
  const run = (labels) => {
    const els = labels.map((t) => ({ textContent: t, click() { this.clicked = true; } }));
    // eslint-disable-next-line no-new-func
    const r = new Function('document', 'return ' + snippet)({ querySelectorAll: () => els });
    return { r, which: (els.find((e) => e.clicked) || {}).textContent };
  };
  assert.deepStrictEqual(run(['Map', 'Sign Up', ' Sign In']), { r: true, which: ' Sign In' }, 'live pota.app label is " Sign In"');
  assert.deepStrictEqual(run(['Sign Up', 'Sign Out', 'Login to add your spot!']), { r: false, which: undefined });
});

console.log(`\nPOTA.app sign-in: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
