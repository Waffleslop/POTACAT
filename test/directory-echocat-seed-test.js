// HF Nets / SWL reach a connecting ECHOCAT device from the server's stored
// directory snapshot. connectRemote() builds a new server with an empty one,
// and nothing refilled it until the next 4-hour fetch, so phones connected to
// a blank Directory tab (Android report 2026-10-24).
// Run: node test/directory-echocat-seed-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const rs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('directory echocat seed');

test('every new ECHOCAT server is seeded with the directory', () => {
  assert.ok(/onRemoteServer\(\(rs\) => \{\n\s*if \(!settings\.enableDirectory \|\| \(!directoryNets\.length && !directorySwl\.length\)\) return;\n\s*rs\.broadcastDirectory\(\{ nets: directoryNets, swl: directorySwl, userNets: buildUserNetsForBroadcast\(\) \}\);/.test(src));
});

test('the directory push is not gated on the server listening', () => {
  const at = src.indexOf('function pushDirectoryToRenderer()');
  const body = src.slice(at, at + 800);
  assert.ok(/if \(remoteServer && settings\.enableDirectory\) \{/.test(body));
  assert.ok(!/remoteServer\.running && settings\.enableDirectory/.test(body));
});

test('the server stores the snapshot and hydrates each device from it', () => {
  assert.ok(/broadcastDirectory\(data\) \{\n\s*this\._directoryData = data;/.test(rs));
  assert.ok(/this\._sendTo\(ws, \{ type: 'directory', nets: this\._directoryData\.nets, swl: this\._directoryData\.swl/.test(rs));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
