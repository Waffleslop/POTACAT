// Rig family resolution + per-family audio source table (rig-scoped UI).
// Guards the single source of truth that replaced the copy-pasted
// `tcp + port 5002-5005` Flex checks. Run: node test/rig-family-test.js
'use strict';

const assert = require('assert');
const {
  familyFromCatTarget, familyFromRadioType, rigFamily, isFlex,
  audioSourcesFor, defaultAudioSourceFor, audioSourceValidFor,
} = require('../lib/rig-family');

let passed = 0, failed = 0;
function eq(a, b, label) {
  if (a === b) { passed++; console.log('  ✓ ' + label + ' → ' + JSON.stringify(a)); }
  else { failed++; console.log('  ✗ FAIL: ' + label + ' → ' + JSON.stringify(a) + ' (expected ' + JSON.stringify(b) + ')'); }
}

console.log('familyFromCatTarget:');
eq(familyFromCatTarget(null), 'none', 'null target');
eq(familyFromCatTarget({}), 'none', 'no type');
eq(familyFromCatTarget({ type: 'tcp', host: '127.0.0.1', port: 5002 }, ), 'flex', 'SmartSDR shim slice A');
eq(familyFromCatTarget({ type: 'tcp', port: 5005 }), 'flex', 'shim slice D, host omitted');
eq(familyFromCatTarget({ type: 'tcp', host: 'localhost', port: 5003 }), 'flex', 'shim, localhost');
eq(familyFromCatTarget({ type: 'tcp', host: '192.168.1.9', port: 5002 }), 'generic', 'remote host + shim port = generic IP CAT');
eq(familyFromCatTarget({ type: 'tcp', host: '127.0.0.1', port: 5006 }), 'generic', 'local + non-shim port');
eq(familyFromCatTarget({ type: 'k4-network', host: 'k4' }), 'k4', 'K4 network');
eq(familyFromCatTarget({ type: 'serial', path: 'COM5' }), 'serial', 'serial CAT');
eq(familyFromCatTarget({ type: 'icom', path: 'COM7' }), 'icom', 'Icom CI-V USB');
eq(familyFromCatTarget({ type: 'civ-tcp', host: 'pi' }), 'icom', 'raw CI-V TCP bridge');
eq(familyFromCatTarget({ type: 'icom-network', host: 'ic705' }), 'icom-network', 'RS-BA1 UDP');
eq(familyFromCatTarget({ type: 'rigctld', rigId: 1035 }), 'hamlib', 'hamlib rigctld');
eq(familyFromCatTarget({ type: 'rigctldnet', host: 'pi' }), 'rigctld', 'rigctld network');
eq(familyFromCatTarget({ type: 'somethingnew' }), 'generic', 'unknown type → generic, never Flex');

console.log('rigFamily (rig profile shape):');
eq(rigFamily(null), 'none', 'null rig');
eq(rigFamily({ catTarget: { type: 'icom', path: 'COM7' } }), 'icom', 'IC-7300 rig');
eq(rigFamily({ catTarget: { type: 'tcp', host: '127.0.0.1', port: 5002 } }), 'flex', 'Flex shim rig');
eq(rigFamily({ flexApiHost: '192.168.1.50', catTarget: { type: 'tcp', host: '127.0.0.1', port: 5002 } }), 'flex', 'Flex Direct rig');
eq(rigFamily({ flexApiHost: '192.168.1.50', catTarget: null }), 'flex', 'flexApiHost wins even with no catTarget');
eq(rigFamily({ type: 'serial', path: 'COM5' }), 'serial', 'bare catTarget passed as rig');
eq(isFlex({ catTarget: { type: 'tcp', host: '127.0.0.1', port: 5004 } }), true, 'isFlex true');
eq(isFlex({ catTarget: { type: 'icom', path: 'COM7' } }), false, 'isFlex false for Icom');

console.log('familyFromRadioType (rig editor radio buttons):');
eq(familyFromRadioType('flex'), 'flex', 'flex');
eq(familyFromRadioType('tcpcat'), 'generic', 'tcpcat');
eq(familyFromRadioType('k4network'), 'k4', 'k4network');
eq(familyFromRadioType('serialcat'), 'serial', 'serialcat');
eq(familyFromRadioType('icom'), 'icom', 'icom');
eq(familyFromRadioType('civ-tcp'), 'icom', 'civ-tcp');
eq(familyFromRadioType('icom-network'), 'icom-network', 'icom-network');
eq(familyFromRadioType('hamlib'), 'hamlib', 'hamlib');
eq(familyFromRadioType('rigctldnet'), 'rigctld', 'rigctldnet');
eq(familyFromRadioType('none'), 'none', 'none');

console.log('audio source table:');
eq(audioSourcesFor('flex').map(o => o.value).join(','), 'smartsdr,dax', 'flex offers Flex Direct + local/DAX');
eq(audioSourcesFor('icom-network').map(o => o.value).join(','), 'icom-network,dax', 'RS-BA1 offers network + local');
eq(audioSourcesFor('icom').map(o => o.value).join(','), 'dax', 'plain Icom: local only');
eq(audioSourcesFor('serial').map(o => o.value).join(','), 'dax', 'serial: local only');
eq(audioSourcesFor('k4').map(o => o.value).join(','), 'dax', 'K4: local only (network audio rides CAT)');
eq(audioSourcesFor('none').map(o => o.value).join(','), 'dax', 'no rig: local only');
eq(defaultAudioSourceFor('flex'), 'smartsdr', 'flex default = Flex Direct');
eq(defaultAudioSourceFor('icom-network'), 'icom-network', 'RS-BA1 default = network audio');
eq(defaultAudioSourceFor('icom'), 'dax', 'Icom default = local');
// No non-Flex family may ever surface a DAX/SmartSDR-worded option (the bug).
for (const fam of ['icom', 'icom-network', 'serial', 'hamlib', 'rigctld', 'k4', 'generic', 'none']) {
  const flexWorded = audioSourcesFor(fam).some(o => /flex|smartsdr/i.test(o.label) || o.value === 'smartsdr');
  eq(flexWorded, false, `${fam}: no Flex-worded audio option`);
}

console.log('audioSourceValidFor:');
eq(audioSourceValidFor('flex', 'smartsdr'), true, 'flex + smartsdr valid');
eq(audioSourceValidFor('flex', 'dax'), true, 'flex + dax valid (DAX-program users)');
eq(audioSourceValidFor('icom', 'smartsdr'), false, 'icom + smartsdr invalid');
eq(audioSourceValidFor('icom-network', 'icom-network'), true, 'RS-BA1 + icom-network valid');
eq(audioSourceValidFor('serial', 'icom-network'), false, 'serial + icom-network invalid');

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'rig-family tests failed');
