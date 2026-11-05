#!/usr/bin/env node
'use strict';
// Yaesu SCU-LAN10 (experimental): how the transport is wired into POTACAT.
// The rules that matter on the air are pinned here:
//   - it is a normal, visible choice in the rig editor (Casey: "turn it on by
//     default so folks don't have to hunt for it"), connecting only for a rig
//     that uses it;
//   - no transmit audio exists yet, so a key-down with the LAN as the audio
//     source is refused: never a silent carrier;
//   - RX audio feeds JTCAT, SSTV and ECHOCAT, and the sound-card capture
//     yields to it only while it is actually arriving;
//   - the password is a stored secret like every other CAT password.
// Run: node test/sculan10-wiring-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const main = read('main.js');
const app = read('renderer/app.js');
const html = read('renderer/index.html');
const popout = read('renderer/jtcat-popout.js');
const RigFamily = require('../lib/rig-family');
const Secrets = require('../lib/settings-secrets');
const P = require('../lib/sculan10-protocol');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
function bodyOf(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, 'missing: ' + startMarker);
  const j = src.indexOf(endMarker, i + startMarker.length);
  return src.slice(i, j > i ? j : i + 4000);
}

test('the rig editor offers it to everyone, labelled experimental, with the unit\'s factory address', () => {
  const m = html.match(/<label class="radio-label"><input type="radio" name="radio-type" value="yaesu-lan">([^<]*)/);
  assert.ok(m, 'a radio-type choice');
  assert.ok(/Yaesu LAN \(SCU-LAN10\), experimental/.test(m[1]), m[1]);
  const before = html.slice(Math.max(0, html.indexOf('value="yaesu-lan"') - 400), html.indexOf('value="yaesu-lan"'));
  assert.ok(!/ultracat|hidden-unless|data-experimental/i.test(before), 'not hidden behind a setting');
  assert.ok(/id="set-yaesu-lan-host"[^>]*value="192\.168\.49\.1"/.test(html), 'factory address prefilled');
  assert.ok(/id="set-yaesu-lan-port"[^>]*value="50000"/.test(html));
  assert.ok(/id="set-yaesu-lan-password" autocomplete="off"/.test(html) && /type="password" id="set-yaesu-lan-password"/.test(html));
  const help = bodyOf(html, 'id="yaesu-lan-config"', 'value="hamlib"');
  for (const words of ['close PCC-LAN10 first', 'Tailscale or a VPN', 'Transmit audio over the LAN is not supported yet']) {
    assert.ok(help.includes(words), 'help says: ' + words);
  }
});

test('the editor saves a yaesu-lan target, and only for the three radios the spec covers', () => {
  const b = bodyOf(app, 'function yaesuLanTargetFromForm() {', '\n}');
  assert.ok(/type: 'yaesu-lan'/.test(b) && /port: parseInt\(/.test(b) && /password:/.test(b));
  assert.ok(/radioType === 'yaesu-lan'\) \{\n\s*return yaesuLanTargetFromForm\(\);/.test(app));
  assert.ok(app.includes("const YAESU_LAN_MODELS = ['FTDX10', 'FT-710', 'FTDX101D/MP'];"));
  assert.deepStrictEqual(P.MODELS.slice().sort(), ['FT-710', 'FTDX10', 'FTDX101D/MP'].sort(), 'the same three as the protocol module');
  assert.ok(/catTarget\.type === 'yaesu-lan' && !YAESU_LAN_MODELS\.includes\(model \|\| ''\)/.test(app), 'save refuses another model');
  assert.ok(/brand === 'Yaesu' && getSelectedRadioType\(\) === 'yaesu-lan'/.test(app), 'picking a Yaesu model keeps the LAN connection');
  const { getModel } = require('../lib/rig-models');
  for (const name of P.MODELS) assert.ok(getModel(name) && getModel(name).brand === 'Yaesu', name + ' exists in rig-models');
});

test('the family offers LAN receive audio or the local sound card', () => {
  assert.strictEqual(RigFamily.familyFromCatTarget({ type: 'yaesu-lan' }), 'yaesu-lan');
  assert.strictEqual(RigFamily.familyFromRadioType('yaesu-lan'), 'yaesu-lan');
  assert.deepStrictEqual(RigFamily.audioSourcesFor('yaesu-lan').map((o) => o.value), ['yaesu-lan', 'dax']);
  assert.ok(/receive only/.test(RigFamily.audioSourcesFor('yaesu-lan')[0].label));
});

test('connectCat builds the transport with the Yaesu codec, only for a yaesu-lan rig', () => {
  const b = bodyOf(main, "} else if (target.type === 'yaesu-lan') {", "} else if (target.type === 'icom-network') {");
  assert.ok(/transport = new Sculan10Transport\(\);/.test(b));
  assert.ok(/codec = new KenwoodCodec\(model, \(data\) => transport\.write\(data\)\);/.test(b));
  assert.ok(/transport\.on\('audio-frame', handleYaesuLanAudioFrame\);/.test(b));
  assert.ok(/transport\.on\('log', sendCatLog\);/.test(b));
  assert.ok(/if \(target\.type === 'yaesu-lan'\) return 'yaesu';/.test(bodyOf(main, 'function detectRigType() {', '\n}')), 'every Yaesu-specific rule applies to it');
  assert.ok(!/password[^,]*\$\{/.test(b.replace(/password: target\.password \|\| ''/, '')), 'the password is never in a log template');
  assert.ok(/transport\.connect\(\{[\s\S]*?password: target\.password \|\| '',[\s\S]*?\}\);/.test(b));
});

test('a key-down with the LAN as the audio source is refused: never a silent carrier', () => {
  const r = bodyOf(main, 'function yaesuLanTxRefusal() {', '\n}');
  assert.ok(/t\.type !== 'yaesu-lan' \|\| settings\.audioSource !== 'yaesu-lan'\) return null;/.test(r));
  assert.ok(/silent carrier/.test(r));
  const ptt = bodyOf(main, 'function handleRemotePtt(state, opts = {}) {', '\nfunction ');
  const refuse = ptt.indexOf('if (state && yaesuLanTxRefusal()) {');
  const target = ptt.indexOf('const target = settings.catTarget;');
  assert.ok(refuse > 0 && refuse < target, 'refused before any keying route');
  const block = ptt.slice(refuse, target);
  assert.ok(/return;\n\s*\}\s*$/.test(block), 'it returns without keying');
  assert.ok(/jtcatHaltTxNow\(/.test(block), 'JTCAT stops trying');
  assert.ok(/'tune-blocked'/.test(block) && /'app-notice'/.test(block), 'said where the press happened');
  const fdv = bodyOf(main, "remoteServer.on('freedv-set-tx', ({ enabled }) => {", 'txLimitNote(');
  assert.ok(/if \(enabled && yaesuLanTxRefusal\(\)\) \{[\s\S]*?return;/.test(fdv), 'FreeDV, which keys around the dispatcher, refuses too');
});

test('RX audio feeds ECHOCAT, both JTCAT windows, the decoder and SSTV; the sound card yields only while it arrives', () => {
  const h = bodyOf(main, 'function handleYaesuLanAudioFrame(frame) {', '\nfunction ');
  assert.ok(/if \(settings\.audioSource !== 'yaesu-lan'\) return;/.test(h));
  assert.ok(/'smartsdr-audio-frame'/.test(h), 'ECHOCAT bridge');
  assert.ok(/'jtcat-vita49-audio'/.test(h) && /sampleRate: 24000/.test(h), 'JTCAT windows at 24 kHz');
  assert.ok(/jtcatManager\.feedAudio\('default', mono12k\)/.test(h), 'decoder at 12 kHz');
  assert.ok(/SstvFeedGate\.streamAudioDecision\(\{[^}]*path: 'yaesu-lan'/.test(h) && /sstvEngine\.feedAudio\(out\)/.test(h), 'SSTV at 48 kHz through the gate');
  assert.ok(/if \(yaesuLanAudioActive\(\) && Date\.now\(\) - _lastYaesuLanFeedMs < 3000\) return;/.test(main), 'renderer JTCAT capture yields while fresh');
  assert.ok(/yaesuLanConnected: !!\(settings\.catTarget && settings\.catTarget\.type === 'yaesu-lan'/.test(main), 'SSTV renderer gate knows the stream');
  assert.ok(/audioSource === 'smartsdr' \|\| audioSource === 'yaesu-lan'\) \{/.test(popout), 'the JTCAT pop-out takes the frames');
  assert.ok(/s\.audioSource === 'smartsdr' \|\| s\.audioSource === 'icom-network' \|\| s\.audioSource === 'yaesu-lan'\) \{/.test(app), 'so does the main window');
});

test('the password is a stored secret: exports strip it and an import keeps this machine\'s', () => {
  const settings = { catTarget: { type: 'yaesu-lan', host: '192.168.49.1', port: 50000, username: 'op', password: 'pw1' },
    rigs: [{ id: 'r1', catTarget: { type: 'yaesu-lan', host: '192.168.49.1', password: 'pw1' } }] };
  const out = Secrets.stripSecrets(settings);
  assert.ok(!('password' in out.catTarget) && !('password' in out.rigs[0].catTarget));
  assert.strictEqual(out.catTarget.username, 'op');
});

test('Test Connection logs in and asks ID; and FA;, through its own handler', () => {
  assert.ok(/testYaesuLan: \(config\) => ipcRenderer\.invoke\('test-yaesu-lan', config\)/.test(read('preload.js')));
  const t = bodyOf(main, "handleCatTest('test-yaesu-lan',", "handleCatTest('test-icom-network',");
  assert.ok(/t\.write\('ID;FA;'\)/.test(t));
  assert.ok(/t\.disconnect\(\);/.test(t), 'the test session is always closed');
});

test('band scope: a source of its own, offered only on a yaesu-lan rig while frames arrive, never the FT-710 USB helper', () => {
  const avail = bodyOf(main, 'function sculanScopeAvailable() {', '\n}');
  assert.ok(/settings\.catTarget\.type === 'yaesu-lan' && cat && cat\.connected/.test(avail));
  assert.ok(/Date\.now\(\) - sculanScopeLastFrameAt < 3000/.test(avail), 'only while frames arrive');
  const caps = bodyOf(main, 'function getRigCapabilities(rigType) {', '\nfunction ');
  assert.ok(/if \(caps\.nativeScope === 'yaesu-ft4222'\) delete caps\.nativeScope;\n\s*if \(sculanScopeAvailable\(\)\) caps\.nativeScope = 'yaesu-lan';/.test(caps),
    'an FT-710 on the LAN never spawns the USB bridge helper, and the scope shows only with frames');
  const kind = bodyOf(main, 'function scopeSourceKind() {', '\n}');
  assert.ok(kind.indexOf("if (sculan) return 'sculan10';") > 0 && kind.indexOf("if (sculan) return 'sculan10';") < kind.indexOf("if (native) return 'yaesu';"));
  assert.ok(/\(!native && !icom && !flex && !sculan\)\)\) return 'sdr';/.test(kind), 'the radio\'s own scope wins over an SDR unless preferSdr');
  assert.ok(/if \(kind === 'sculan10'\) \{ startSculanScope\(\); return; \}/.test(main));
  assert.ok(/if \(sculanScopeOn\) \{ stopSculanScope\(why\); return; \}/.test(main));
  const b = bodyOf(main, "} else if (target.type === 'yaesu-lan') {", "} else if (target.type === 'icom-network') {");
  assert.ok(/transport\.on\('scope-frame', sculanScopeOnTransportFrame\);/.test(b));
});

test('band scope: frames go through the shared fan-out, and testers get the first frame described and saved', () => {
  const h = bodyOf(main, 'function sculanScopeOnTransportFrame(f) {', '\n}\n');
  assert.ok(/Sculan10Scope\.describeFrame\(f\.body\)/.test(h), 'first frame: size and boundary marker logged');
  assert.ok(/'sculan10-scope-frame\.bin'/.test(h), 'one raw frame saved for an owner to send');
  assert.ok(/Sculan10Scope\.decodeScopeFrame\(f\.body, sculanScopeTracker\)/.test(h));
  assert.ok(/yaesuScopeOnFrame\(Sculan10Scope\.toScopeFrame\(d\.levels/.test(h), 'the same fan-out as every other source');
  assert.ok(/broadcastRigState\(\)/.test(h), 'clients learn the scope appeared');
  const rd = bodyOf(main, 'async function sculanScopeReadRadio() {', '\n}\n');
  for (const c of ['SS05;', 'SS06;', 'SS00;']) assert.ok(rd.includes(`'${c}'`), c);
  assert.ok(!/EX0|sendRaw/.test(rd), 'never an EX menu read or a raw write: menu numbers differ between these radios');
});

console.log(`\nSCU-LAN10 wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
