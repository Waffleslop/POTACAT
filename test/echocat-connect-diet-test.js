#!/usr/bin/env node
'use strict';
// What an ECHOCAT connect costs (Casey's BUG-K3SBP-20261024-0CD289, desktop
// half): meters are gated, nothing in the connect burst goes out twice, voice
// macro audio moves only on request, and the diagnostic names Flex Direct.
// Run: node test/echocat-connect-diet-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const main = read('main.js');
const server = read('lib/remote-server.js');
const proto = read('lib/echocat-protocol.js');

test('Flex TX-bridge meters reach clients only on change, at most every 250 ms, and are kept out of the push log', () => {
  assert.ok(/function remoteMeterPush\(type, value\)/.test(main));
  assert.ok(/if \(m\.v !== null && Math\.abs\(value - m\.v\) < step\) return;/.test(main), 'unchanged values are dropped');
  assert.ok(/if \(value !== 0 && now - m\.at < 250\) return;/.test(main), '250 ms floor, a return to 0 at once');
  assert.ok(!/sendToClient\(\{ type: 'fwd-power'/.test(main) && !/sendToClient\(\{ type: 'swr-ratio'/.test(main), 'no direct meter pushes remain');
  assert.strictEqual((main.match(/remoteMeterPush\('(fwd-power|swr-ratio)'/g) || []).length, 3);
  assert.ok(/'fwd-power', 'swr-ratio',/.test(server.slice(server.indexOf('PUSH_LOG_EXCLUDED = new Set'), server.indexOf('PUSH_LOG_EXCLUDED = new Set') + 400)));
});

test('settings go out once per connect: setRemoteSettings pushes only a CHANGED copy', () => {
  assert.ok(/const changed = json !== this\._remoteSettingsJson;[\s\S]{0,80}this\._remoteSettingsJson = json;[\s\S]{0,40}if \(changed && this\._client/.test(server));
});

test('worked-parks, worked-qsos and activator-state are not sent twice to one client', () => {
  assert.ok(/_sendIfNew\(ws, type, msg, key\)/.test(server));
  assert.ok(/_sendIfNew\(c, 'worked-parks'/.test(server) && /_sendIfNew\(ws, 'worked-parks'/.test(server), 'worked-parks: live send and hydrate share the key');
  assert.ok(/_sendIfNew\(c, 'activator-state'/.test(server) && /_sendIfNew\(ws, 'activator-state'/.test(server));
  assert.ok(/const changed = key !== this\._workedQsosKey;[\s\S]{0,300}if \(changed\) this\._client\._workedQsosSent = false;/.test(server), 'worked-qsos: the per-WS dedupe resets only when the list changed');
});

test('voice macros: a manifest for capable clients, audio on request, the whole set for older ones; main keeps the store current', () => {
  assert.ok(/setVoiceMacros\(store\)/.test(server) && /_sendVoiceMacroHydration\(ws\)/.test(server) && /case 'voice-macro-get':/.test(server));
  assert.ok(/caps\.includes\('voice-macro-manifest'\)/.test(server));
  assert.ok(/'voice-macro-manifest': \{ dir: Dir\.S2C/.test(proto) && /'voice-macro-get': \{ dir: Dir\.C2S/.test(proto));
  assert.ok(/onRemoteServer\(\(\) => voiceMacroStoreSync\(\)\);/.test(main), 'the store survives a server rebuild');
  assert.strictEqual((main.match(/voiceMacroStoreSync\(\);/g) || []).length, 5, 'connect + save/delete from both the desktop and a phone');
  // the connect handler no longer reads every recording
  const h = main.slice(main.indexOf("remoteServer.on('client-connected'"), main.indexOf("remoteServer.on('client-connected'") + 12000);
  assert.ok(!/readFileSync\(p\)\.toString\('base64'\)/.test(h), 'no audio read at connect');
});

test('the diagnostic names the path driving the radio: Flex Direct when the SmartSDR API can tune', () => {
  assert.ok(/const flexDirect = !!\(smartSdr && smartSdr\.canTune && \(smartSdr\.mode === 'self' \|\| !cat \|\| !cat\.connected\)\);/.test(main), 'the tune path\'s own predicate');
  assert.ok(/if \(flexDirect\) return `Flex Direct/.test(main));
  assert.ok(/const catConnected = flexDirect \|\| !!\(cat && cat\.connected\);/.test(main));
});

test('VARA: a running copy that is silent on its port is named, the phone sees the launch wait, failures carry an errorKind, a late reason is kept', () => {
  assert.ok(/function varaProcessRunning\(kind\)/.test(main) && /if \(await varaProcessRunning\(kind\)\)/.test(main));
  assert.ok(/progress\(`Starting \$\{name\} on the shack PC`\)/.test(main));
  for (const k of ['vara-not-answering', 'vara-not-running', 'vara-not-found']) assert.ok(main.includes(`_winlinkSessionErrorKind = '${k}'`), k);
  assert.ok(/_winlinkSessionErrorKind = notConfigured \? 'vara-not-configured' : 'vara-not-answering';/.test(main), 'a missing plan is named when the launch then fails');
  assert.ok(/kept as the reason/.test(main) && /ls\.text = `\$\{ls\.text \|\| 'Session failed'\} — \$\{why\}`/.test(main));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
