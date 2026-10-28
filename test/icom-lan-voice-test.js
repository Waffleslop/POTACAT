// Voice over an Icom's LAN link: DATA mode at the radio's factory setting,
// plain USB / LSB when the rig says its DATA OFF MOD is LAN (EA1BZN,
// IC-7300MK2, 2026-10-28: forced DATA cost the voice its compressor, and the
// log blamed SSB-over-DATA, which was off).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// Run the real function against a settings object.
function optsFor(rig) {
  const src = main.slice(main.indexOf('function icomLanVoicePttOpts('), main.indexOf('\n}\n', main.indexOf('function icomLanVoicePttOpts(')) + 2);
  const settings = { activeRigId: 'r', rigs: [{ id: 'r', ...rig }] };
  return new Function('settings', src + '\nreturn icomLanVoicePttOpts();')(settings);
}

check('factory setting: the LAN voice PTT keys in DATA mode and says why', () => {
  const o = optsFor({});
  assert.strictEqual(o.forceDataMode, true);
  assert.strictEqual(o.audio, true);
  assert.ok(/DATA OFF MOD/.test(o.dataReason) && /Voice over the LAN stays in USB \/ LSB/.test(o.dataReason));
});
check('DATA OFF MOD = LAN (rig.lanVoiceInSsb): voice stays in USB / LSB', () => {
  const o = optsFor({ lanVoiceInSsb: true });
  assert.strictEqual(o.forceDataMode, undefined);
  assert.strictEqual(o.audio, true);
});
check('both LAN voice paths (ECHOCAT and the VFO window) use it', () => {
  assert.ok(/icomNetworkVoiceTx\(state, 'ECHOCAT phone PTT'\)\) \{\s*handleRemotePtt\(state, icomLanVoicePttOpts\(\)\);/.test(main));
  assert.ok(/icomNetworkVoiceTx\(!!state, 'VFO window PTT'\)\) \{\s*handleRemotePtt\(!!state, icomLanVoicePttOpts\(\)\);/.test(main));
});
check('the log names the real reason; SSB-over-DATA is named only when it is the setting', () => {
  assert.ok(/\(\$\{forceData \? \(opts\.dataReason \|\| 'this audio reaches the radio only in DATA mode'\) : 'SSB-over-DATA: mic disabled'\}\)/.test(main));
});
check('the rig editor shows, loads and saves it for Icom Network rigs only', () => {
  assert.ok(/id="set-lan-voice-ssb"[^>]*> Voice over the LAN stays in USB \/ LSB/.test(html));
  assert.ok(/lanVoiceSsbRow\.classList\.toggle\('hidden', type !== 'icom-network'\)/.test(app));
  assert.ok(/lanVoiceSsbEl\.checked = !!rig\.lanVoiceInSsb/.test(app));
  assert.ok(/if \(rigLanVoiceInSsb\) rig\.lanVoiceInSsb = true; else delete rig\.lanVoiceInSsb;/.test(app));
  assert.ok(/\.\.\.\(rigLanVoiceInSsb \? \{ lanVoiceInSsb: true \} : \{\}\)/.test(app));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
