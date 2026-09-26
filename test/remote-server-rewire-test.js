#!/usr/bin/env node
'use strict';
// connectRemote() removes every listener from the old RemoteServer and builds
// a new one. Anything main.js wires onto the server must therefore live
// inside connectRemote() or go through onRemoteServer(), which re-runs on
// every rebuild. A pair-request listener attached once at startup is how a
// fresh install that enabled ECHOCAT after launch got "asking for approval"
// on the mobile device and no window on the desktop until a restart
// (2026-09-26). Run: node test/remote-server-rewire-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');
const start = lines.findIndex((l) => /^function connectRemote\(\) \{/.test(l));
const end = lines.findIndex((l) => /^function disconnectRemote\(\) \{/.test(l));

console.log('remote server rewire');

test('connectRemote runs every onRemoteServer hook on the new server', () => {
  assert.ok(start > 0 && end > start, 'connectRemote/disconnectRemote not found');
  const body = lines.slice(start, end).join('\n');
  assert.ok(/remoteServer = new RemoteServer\(\);\n\s*for \(const hook of _remoteServerHooks\)/.test(body));
});

test('no listener or one-time setter is attached to remoteServer outside connectRemote', () => {
  const offenders = [];
  lines.forEach((l, i) => {
    if (i >= start && i < end) return;
    if (/^\s*\/\//.test(l)) return;
    if (/\bremoteServer\.on\(/.test(l) || /\bremoteServer\.set(PassValidator|PassAuthCallback)\(/.test(l)) {
      offenders.push(`main.js:${i + 1}: ${l.trim()}`);
    }
  });
  assert.deepStrictEqual(offenders, [], 'use onRemoteServer((rs) => rs.on(...)):\n' + offenders.join('\n'));
});

test('pairing, Guest Pass and VFO lock are wired through onRemoteServer', () => {
  assert.ok(/onRemoteServer\(\(rs\) => \{\n\s*rs\.on\('pair-request'/.test(src), 'pair-request');
  assert.ok(/onRemoteServer\(\(rs\) => \{\n\s*rs\.setPassValidator\(/.test(src), 'pass validator');
  assert.ok(/rs\.setPassAuthCallback\(/.test(src), 'pass auth callback');
  assert.ok(/rs\.on\('vfo-set-lock'/.test(src), 'vfo lock');
});

test('onRemoteServer applies to the current server immediately and to later ones', () => {
  const m = src.match(/const _remoteServerHooks = \[\];\nfunction onRemoteServer\(fn\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'registry not found');
  // eslint-disable-next-line no-new-func
  const make = new Function('let remoteServer = null;\n' + m[0] +
    '\nreturn { on: onRemoteServer, hooks: _remoteServerHooks, set: (s) => { remoteServer = s; } };');
  const r = make();
  const seen = [];
  r.set('A');
  r.on((s) => seen.push(s));
  r.hooks.forEach((h) => h('B')); // what connectRemote does on a rebuild
  assert.deepStrictEqual(seen, ['A', 'B']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
