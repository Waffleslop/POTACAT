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
function runBanner(pageUrl) {
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
  const warned = [];
  const ctx = { window: win, document: { body, createElement: el, addEventListener() {} }, navigator: {},
    location: pageUrl ? { href: pageUrl } : {}, setTimeout,
    console: { warn: (...a) => warned.push(a.join(' ')), log() {}, error() {} } };
  ctx.self = win;
  vm.createContext(ctx);
  vm.runInContext(read('lib/error-banner-text.js'), ctx); // as remote-server inlines it
  ctx.window.ErrorBannerText = ctx.self.ErrorBannerText;
  vm.runInContext(code, ctx);
  const text = () => {
    const banner = body.children[0];
    return banner ? banner.children.find((c) => c.style && c.style.cssText && /pre-wrap/.test(c.style.cssText)).textContent : '';
  };
  return { listeners, text, warned };
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

// #806 follow-up: Brave for iOS (WebKit) injects its own user scripts. When
// one throws, the page gets an error at "https://host/:1" with only
// "global code@https://host/:1:16" in the stack. Line 1 of every page we
// serve is "<!doctype html>" alone, and inline-script lines count from the
// top of the document, so no code of ours can run at line 1: the banner
// ignores it (console.warn only). Anything at line > 1, or in another
// script, is ours and still shows.
const PAGE = 'https://host/';
const braveErr = { name: 'TypeError', message: "undefined is not an object (evaluating 'window.__firefox__.x')",
  stack: 'global code@https://host/:1:16' };

t('isForeignError: a Safari/Brave-shaped line-1 error event is foreign', () => {
  assert.strictEqual(typeof EBT.isForeignError, 'function');
  assert.strictEqual(EBT.isForeignErrorEvent({ message: braveErr.message, filename: PAGE, lineno: 1, colno: 16, error: braveErr }, PAGE), true);
  // Brave's own report: no colno, only the frame; the page URL carries a hash
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'x', filename: 'https://host/', lineno: 1, error: braveErr }, 'https://host/#station'), true);
  // no Error object, no filename (WebKit sometimes leaves it empty), line 1
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'x', filename: '', lineno: 1 }, PAGE), true);
  // query strings are part of the page URL (pop-out ?view=...)
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'x', filename: 'https://host/?view=jtcat', lineno: 1,
    error: { name: 'Error', message: 'x', stack: 'global code@https://host/?view=jtcat:1:16' } }, 'https://host/?view=jtcat'), true);
});

t('isForeignError: an error at line 5000 of the page is ours', () => {
  const ours = { name: 'TypeError', message: 'boom', stack: 'render@https://host/:5000:12\nglobal code@https://host/:1:16' };
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'boom', filename: PAGE, lineno: 5000, colno: 12, error: ours }, PAGE), false);
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'boom', filename: PAGE, lineno: 5000 }, PAGE), false);
  // line 1, but the stack has one of our frames
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'boom', filename: PAGE, lineno: 1, error: ours }, PAGE), false);
});

t('isForeignError: a Chrome-shaped stack with one of our frames is ours', () => {
  const c = { name: 'TypeError', message: 'bad', stack: 'TypeError: bad\n    at https://host/:1:16\n    at onMsg (https://host/:23456:7)' };
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'Uncaught TypeError: bad', filename: PAGE, lineno: 1, colno: 16, error: c }, PAGE), false);
  assert.strictEqual(EBT.isForeignRejection(c, PAGE), false);
});

t('isForeignError: a line-1 frame from another script, or an unknown page, is ours', () => {
  const other = { name: 'Error', message: 'x', stack: 'global code@https://cdn.example/lib.js:1:16' };
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'x', filename: 'https://cdn.example/lib.js', lineno: 1, error: other }, PAGE), false);
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'x', filename: 'https://other/', lineno: 1 }, PAGE), false);
  assert.strictEqual(EBT.isForeignErrorEvent({ message: 'x', filename: PAGE, lineno: 1, error: braveErr }, ''), false, 'no page URL: do not guess');
});

t('isForeignError: a rejection with only line-1 frames is foreign; strings and frameless reasons are ours', () => {
  assert.strictEqual(EBT.isForeignRejection(braveErr, PAGE), true);
  assert.strictEqual(EBT.isForeignRejection({ name: 'Error', message: 'x', stack: 'Error: x\n    at https://host/:1:5\n    at async https://host/:1:99' }, PAGE), true);
  assert.strictEqual(EBT.isForeignRejection({ name: 'Error', message: 'x', stack: '@https://host/:1:5\nforEach@[native code]' }, PAGE), true, 'native frames carry no line');
  assert.strictEqual(EBT.isForeignRejection('socket closed', PAGE), false);
  assert.strictEqual(EBT.isForeignRejection({ name: 'Error', message: 'no stack' }, PAGE), false);
  assert.strictEqual(EBT.isForeignRejection(undefined, PAGE), false);
});

t('the banner ignores a Brave line-1 error and rejection, and console.warns them', () => {
  const b = runBanner(PAGE);
  b.listeners.error({ message: braveErr.message, filename: PAGE, lineno: 1, error: braveErr });
  b.listeners.unhandledrejection({ reason: braveErr });
  assert.strictEqual(b.text(), '', 'no banner');
  assert.strictEqual(b.warned.length, 2, 'both warned: ' + JSON.stringify(b.warned));
  assert.ok(b.warned.every((w) => /ECHOCAT/.test(w) && /global code@https:\/\/host\/:1:16/.test(w)), b.warned.join('|'));
});

t('the banner still shows our own errors at line > 1', () => {
  const b = runBanner(PAGE);
  b.listeners.error({ message: 'boom', filename: PAGE, lineno: 5000, colno: 3,
    error: { name: 'TypeError', message: 'boom', stack: 'render@https://host/:5000:3' } });
  assert.ok(b.text().startsWith('https://host/:5000:3\n\n'), b.text());
  assert.ok(b.text().includes('TypeError: boom'), b.text());
  assert.strictEqual(b.warned.length, 0);
});

// The rule rests on this: no page we serve has a script on line 1.
t('line 1 of the full page, the connect page and the stub page holds no <script>', () => {
  const RS = require('../lib/remote-server');
  const Gate = require('../lib/echocat-web-gate');
  const rs = new (RS.RemoteServer || RS)();
  rs._basePath = path.join(__dirname, '..', 'renderer');
  const pages = {
    full: rs._buildInlinedHtml(false),
    fullTunnel: rs._buildInlinedHtml(true),
    connect: Gate.buildConnectPageHtml(),
    stub: Gate.buildStubHtml(),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(typeof html === 'string' && html.length > 100, name + ' built');
    const first = html.replace(/^﻿/, '').split(/\r?\n/)[0];
    assert.ok(/^<!doctype html>\s*$/i.test(first), name + ' line 1 is the doctype alone: ' + JSON.stringify(first.slice(0, 80)));
    assert.ok(!/<script/i.test(first), name + ' line 1 has no <script>');
  }
});

console.log(`error-banner-text-test: ${passed} passed`);
