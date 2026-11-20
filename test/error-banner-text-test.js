'use strict';
// #806: ECHOCAT Web's red error banner showed only stack frames on an iPhone.
// Safari (and Firefox) leave the message out of error.stack; Chrome puts
// "TypeError: message" first. The banner used the stack in place of the
// message, so iOS users saw "global code@https://host/:1:16" and nothing else.
// lib/error-banner-text.js builds the text; renderer/remote.js shows it.
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const EBT = require('../lib/error-banner-text');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => readSrc(path.join(__dirname, '..', p));

// Error-shaped objects as each engine fills them in.
const safariErr = { name: 'TypeError', message: "undefined is not an object (evaluating 'a.b')",
  stack: 'global code@https://host/:1:16\nonmessage@https://host/:2:3' };
const chromeErr = { name: 'TypeError', message: "Cannot read properties of undefined (reading 'b')",
  stack: "TypeError: Cannot read properties of undefined (reading 'b')\n    at https://host/:1:16" };

t('Safari-shaped error: name and message first, then the stack', () => {
  const s = EBT.formatError(safariErr);
  assert.strictEqual(s, "TypeError: undefined is not an object (evaluating 'a.b')\nglobal code@https://host/:1:16\nonmessage@https://host/:2:3");
});

t('Chrome-shaped error: the message is not doubled', () => {
  const s = EBT.formatError(chromeErr);
  assert.strictEqual(s, chromeErr.stack);
  assert.strictEqual(s.split('Cannot read properties').length, 2, 'message appears once');
});

t('a real Node Error (V8 shape) is shown once, with its frames', () => {
  const s = EBT.formatError(new RangeError('too far'));
  assert.ok(s.startsWith('RangeError: too far\n'), s);
  assert.strictEqual(s.split('too far').length, 2);
});

t('an error with no stack is its name and message', () => {
  assert.strictEqual(EBT.formatError({ name: 'Error', message: 'boom' }), 'Error: boom');
});

t('non-Error rejection reasons are readable', () => {
  assert.strictEqual(EBT.formatRejection('plain string').text, 'plain string');
  assert.strictEqual(EBT.formatRejection('plain string').src, 'unhandledrejection');
  assert.strictEqual(EBT.formatRejection(42).text, '42');
  assert.strictEqual(EBT.formatRejection({ code: 7 }).text, '{"code":7}');
  assert.ok(/undefined/.test(EBT.formatRejection(undefined).text));
  const circ = {}; circ.self = circ;
  assert.strictEqual(typeof EBT.formatRejection(circ).text, 'string');
});

t('error event with no Error object: message plus file, line and column', () => {
  const r = EBT.formatErrorEvent({ message: 'Uncaught SyntaxError: bad', filename: 'https://host/', lineno: 12, colno: 5 });
  assert.deepStrictEqual(r, { src: 'https://host/:12:5', text: 'Uncaught SyntaxError: bad' });
  assert.deepStrictEqual(EBT.formatErrorEvent({}), { src: ':?', text: 'unknown' });
});

// Run the banner code from renderer/remote.js against a fake page, the way an
// iPhone would, and read what the banner says.
function runBanner() {
  const src = read('renderer/remote.js');
  const start = src.indexOf('(function installErrorBanner()');
  assert.ok(start >= 0, 'installErrorBanner found in remote.js');
  const end = src.indexOf('\n})();', start);
  const code = src.slice(start, end + '\n})();'.length);
  const listeners = {};
  function el() {
    return { style: {}, textContent: '', children: [], appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {} };
  }
  const body = el();
  const win = { addEventListener(type, fn) { listeners[type] = fn; } };
  const ctx = { window: win, document: { body, createElement: el, addEventListener() {} }, navigator: {}, location: {}, setTimeout };
  ctx.self = win;
  vm.createContext(ctx);
  vm.runInContext(read('lib/error-banner-text.js'), ctx); // as remote-server inlines it
  ctx.window.ErrorBannerText = ctx.self.ErrorBannerText;
  vm.runInContext(code, ctx);
  const text = () => {
    const banner = body.children[0];
    return banner ? banner.children.find((c) => c.style && c.style.cssText && /pre-wrap/.test(c.style.cssText)).textContent : '';
  };
  return { listeners, text };
}

t('the banner shows the message for a Safari error event', () => {
  const b = runBanner();
  b.listeners.error({ message: "TypeError: undefined is not an object (evaluating 'a.b')", filename: 'https://host/', lineno: 1, colno: 16, error: safariErr });
  const s = b.text();
  assert.ok(s.includes("undefined is not an object (evaluating 'a.b')"), 'message shown: ' + s);
  assert.ok(s.includes('global code@https://host/:1:16'), 'stack shown');
  assert.ok(s.startsWith('https://host/:1:16\n\n'), 'source line first: ' + s);
});

t('the banner shows the message for a Safari rejection and a string rejection', () => {
  const b = runBanner();
  b.listeners.unhandledrejection({ reason: safariErr });
  assert.ok(b.text().includes("TypeError: undefined is not an object"), b.text());
  b.listeners.unhandledrejection({ reason: 'socket closed' });
  assert.ok(b.text().includes('socket closed'), b.text());
});

t('the Chrome banner does not repeat the message', () => {
  const b = runBanner();
  b.listeners.error({ message: 'Uncaught ' + chromeErr.name, filename: 'https://host/', lineno: 1, colno: 16, error: chromeErr });
  assert.strictEqual(b.text().split('Cannot read properties').length, 2, b.text());
});

t('the "Script error." mask is still dropped', () => {
  const b = runBanner();
  b.listeners.error({ message: 'Script error.', filename: '', lineno: 0 });
  assert.strictEqual(b.text(), '');
});

t('remote-server inlines the module into ECHOCAT Web', () => {
  assert.ok(read('renderer/remote.html').includes('<!-- error-banner-text-js -->'));
  assert.ok(read('lib/remote-server.js').includes("['error-banner-text-js', 'error-banner-text.js']"));
});

console.log(`error-banner-text-test: ${passed} passed`);
