#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Yaesu SCU-LAN10 (experimental): how the transport is wired into POTACAT.
// The rules that matter on the air are pinned here:
//   - it is a normal, visible choice in the rig editor (Casey: "turn it on by
//     default so folks don't have to hunt for it"), connecting only for a rig
//     that uses it;
//   - voice PTT (VFO window, ECHOCAT) sends its mic over the LAN, JTCAT and
//     Tune their buffer (#227); every other key-down with the LAN as the
//     audio source is refused: never a silent carrier;
//   - RX audio feeds JTCAT, SSTV and ECHOCAT, and the sound-card capture
//     yields to it only while it is actually arriving;
//   - the password is a stored secret like every other CAT password.
// Run: node test/sculan10-wiring-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => readSrc(path.join(root, f));
const main = read('main.js');
const app = read('renderer/app.js');
const html = read('renderer/index.html');
const popout = read('renderer/jtcat-popout.js');
const vfo = read('renderer/vfo-popout.html');
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
  for (const words of ['close PCC-LAN10 first', 'Tailscale or a VPN', "Voice from the VFO window's PTT or ECHOCAT is transmitted over the LAN"]) {
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

test('the family offers LAN audio or the local sound card', () => {
  assert.strictEqual(RigFamily.familyFromCatTarget({ type: 'yaesu-lan' }), 'yaesu-lan');
  assert.strictEqual(RigFamily.familyFromRadioType('yaesu-lan'), 'yaesu-lan');
  assert.deepStrictEqual(RigFamily.audioSourcesFor('yaesu-lan').map((o) => o.value), ['yaesu-lan', 'dax']);
  assert.ok(/SCU-LAN10/.test(RigFamily.audioSourcesFor('yaesu-lan')[0].label));
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
  const r = bodyOf(main, 'function yaesuLanTxRefusal(asking = null) {', '\n}');
  assert.ok(/return _yaesuLanTx\.refusal\(\{ route: yaesuLanVoiceRoute\(\), asking \}\);/.test(r), r);
  const ptt = bodyOf(main, 'function handleRemotePtt(state, opts = {}) {', '\nfunction ');
  const refuse = ptt.indexOf('if (state && yaesuLanTxRefusal(opts.lanOwner || null)) {');
  const target = ptt.indexOf('const target = settings.catTarget;');
  assert.ok(refuse > 0 && refuse < target, 'refused before any keying route');
  const block = ptt.slice(refuse, target);
  assert.ok(/return false;\n\s*\}\s*$/.test(block), 'it returns without keying, and says it refused');
  assert.ok(/if \(!_yaesuLanTx\.owner && \(jtcatAnyTxActive\(\) \|\| jtcatTuneState\.active\)\) jtcatHaltTxNow\(/.test(block), 'JTCAT stops trying only when nothing holds the LAN');
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
  // #243: either branch may also take the WebSDR feed.
  assert.ok(/audioSource === 'smartsdr' \|\| audioSource === 'yaesu-lan'( \|\| audioSource === 'websdr')?\) \{/.test(popout), 'the JTCAT pop-out takes the frames');
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
  assert.ok(/\(!native && !icom && !flex && !sculan && !k4 && !kenwood\)\)\) return 'sdr';/.test(kind), 'the radio\'s own scope wins over an SDR unless preferSdr');
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

// ---- the independent review's findings (2026-11-05) -------------------------

test('review 2 (high): a CAT key-down from any path is refused at gatedSetTransmit too; the external-ATU carrier stays allowed', () => {
  const g = bodyOf(main, 'function gatedSetTransmit(state, emission) {', '\n}\n');
  const gate = g.indexOf('if (state && yaesuLanTxRefusal(YaesuLanTx.ANY_HOLDER) && !_externalAtuActive) {');
  assert.ok(gate > 0 && gate < g.indexOf('if (passEnforcement && state)'), 'first thing it checks');
  assert.ok(/return false;/.test(g.slice(gate, gate + 600)));
  // the radio's own ATU (RigController.startTune) never keys through here
  const st = bodyOf(read('lib/rig-controller.js'), '  startTune() {', '\n  }\n');
  assert.ok(!/gatedSetTransmit|setTransmit\(true/.test(st));
});

test('review 2 (high): a custom CAT string holding TX1; or TX2; is refused; TX0; and reads pass', () => {
  const m = main.match(/const RAW_CAT_KEYDOWN_RE = (\/.*\/i);/);
  assert.ok(m, 'the pattern exists');
  const re = eval(m[1]); // eslint-disable-line no-eval
  for (const s of ['TX1;', 'TX2;', 'tx1;', 'FA014074000;TX1;', 'MD0C;TX2', ' TX1 ;']) assert.ok(re.test(s), 'keys: ' + s);
  for (const s of ['TX0;', 'TX;', 'FA;', 'EX0301261;', 'KYTX1 TEST;']) assert.ok(!re.test(s), 'passes: ' + s);
  const c = bodyOf(main, "case 'send-custom-cat': {", 'break;\n      }');
  assert.ok(/if \(yaesuLanTxRefusal\(\) && RAW_CAT_KEYDOWN_RE\.test\(cmd\)\) \{[\s\S]*?break;/.test(c));
  assert.ok(c.indexOf('RAW_CAT_KEYDOWN_RE') < c.indexOf('cat.sendRaw(cmd)'), 'before the send');
});

test('review low: the Winlink shim and logger CAT report a refused key-down, never a false success', () => {
  const w = bodyOf(main, '    setPtt: (on) => {', 'handleRemotePtt(true,');
  assert.ok(/if \(yaesuLanTxRefusal\(\)\) \{ winlinkLog\(.*\); return false; \}/.test(w));
  assert.ok(w.indexOf('yaesuLanTxRefusal()') < w.indexOf('winlinkTxActive = true'), 'refused before it is marked active');
  const l = bodyOf(main, "} else if (typeof a.ptt === 'boolean') {", 'handleRemotePtt(a.ptt);');
  assert.ok(/if \(a\.ptt && yaesuLanTxRefusal\(\)\) \{[\s\S]*?_loggerCatPtt = false;[\s\S]*?return;/.test(l));
});

test('review 7: a scope window opened before the first frame starts the LAN scope when frames arrive', () => {
  const h = bodyOf(main, 'function sculanScopeOnTransportFrame(f) {', '\n}\n');
  assert.ok(/if \(yaesuScopeWanted\(\) && !sculanScopeOn\) \{\s*stopYaesuScope\([^)]*\);\s*yaesuScopeRestarts = 0;\s*startYaesuScope\(\);/.test(h));
});

test('review low: a yaesu-lan rig with no audio source saved gets the family default, not the previous rig\'s', () => {
  const b = bodyOf(main, "} else if (target.type === 'yaesu-lan') {", "} else if (target.type === 'icom-network') {");
  assert.ok(/activeRig\.catTarget\.type === 'yaesu-lan' && !activeRig\.audioSource\)/.test(b));
  assert.ok(/settings\.audioSource = def;/.test(b));
  assert.strictEqual(RigFamily.defaultAudioSourceFor('yaesu-lan'), 'yaesu-lan');
  assert.ok(b.indexOf('settings.audioSource = def;') < b.indexOf('transport.connect('), 'decided before connecting');
});

test('review low: the rig editor refuses a login the unit cannot take, by the same rule as the protocol module', () => {
  const src = bodyOf(app, 'function yaesuLanLoginProblem(value, what) {', '\n}\n') + '\n}';
  const fn = new Function(src + '\nreturn yaesuLanLoginProblem;')(); // eslint-disable-line no-new-func
  for (const v of ['defaultuser', 'x'.repeat(32), 'x'.repeat(33), 'pässwörd', 'with space', '\u{1F600}', '']) {
    assert.strictEqual(fn(v, 'password') === null, P.loginFieldProblem(v, 'password') === null, JSON.stringify(v));
  }
  assert.ok(/yaesuLanLoginProblem\(catTarget\.username, 'user'\) \|\| yaesuLanLoginProblem\(catTarget\.password, 'password'\)/.test(app));
});


test('#227: voice PTT from the VFO window and ECHOCAT takes the LAN, opens the stream, then keys in USB/LSB', () => {
  const naked = bodyOf(main, "ipcMain.on('naked-ptt', (_e, state) => {", '\n  });');
  assert.ok(/if \(yaesuLanVoicePtt\(!!state, 'VFO window PTT', 'vfo'\)\) return;/.test(naked), naked);
  assert.ok(naked.indexOf('icomNetworkVoiceTx') < naked.indexOf('yaesuLanVoicePtt'), 'the Icom route keeps its place');
  assert.ok(/\} else if \(yaesuLanVoicePtt\(state, 'ECHOCAT phone PTT', 'echocat'\)\) \{/.test(main), 'ECHOCAT');
  const v = bodyOf(main, 'function yaesuLanVoicePtt(state, who, where) {', '\n}\n');
  const claim = v.indexOf("if (claimYaesuLanTx('voice', who, [where])) return true;");
  const open = v.indexOf('t.startVoiceTx();');
  const key = v.indexOf("handleRemotePtt(true, { audio: true, lanOwner: 'voice' }) === false");
  assert.ok(claim > 0 && claim < open && open < key, 'claimed before the stream, the stream before the key-down');
  assert.ok(!/forceDataMode/.test(v), 'no DATA mode for Yaesu voice');
  assert.ok(/if \(!t \|\| !t\.txReady\) \{[\s\S]*?return true;/.test(v), 'not connected: not keyed');
  assert.ok(/new mercuryAudioBridge\.StreamingResampler\(24000, Sculan10\.TX_AUDIO_RATE\)/.test(v), '24 kHz mic -> 16 kHz');
  assert.ok(/if \(_yaesuLanTx\.owner !== 'voice'\) \{[\s\S]*?if \(!_yaesuLanTx\.owner\) handleRemotePtt\(false\);/.test(v), 'a release while another holds the LAN leaves it keyed');
  assert.ok(/_yaesuLanTxChunkCount > 0\) return;[\s\S]*?yaesuLanVoiceStop\('no mic audio'\);\n\s*handleRemotePtt\(false\);/.test(v), 'no mic within 1 s: unkeyed');
  assert.ok(/const YAESU_LAN_VOICE_NO_MIC_MS = 1000;/.test(main));
});

test('#227: one transmitter at a time: a second owner is refused before PTT, a release cancels only its own', () => {
  assert.ok(/const _yaesuLanTx = new YaesuLanTx\.YaesuLanTxGate\(\);/.test(main));
  const rel = bodyOf(main, 'function releaseYaesuLanTx(owner, reason) {', '\n}');
  assert.ok(/if \(!_yaesuLanTx\.release\(owner\)\) return false;/.test(rel), 'not the holder: nothing cancelled');
  const end = bodyOf(main, 'function endYaesuLanTx(owner, reason) {', '\n}');
  assert.ok(/releaseYaesuLanTx\(owner, reason\);\n\s*if \(yaesuLanMayUnkey\(owner, reason\)\) handleRemotePtt\(false\);/.test(end));
  assert.ok(!/releaseYaesuLanTx\([^)]*takes over/.test(main), 'no owner takes over another');
  assert.ok(!/_yaesuLanBufferTxClaim/.test(main), 'the boolean claim is gone');
});

test('#227: the mic reaches the LAN: dax-tx-chunk routes it, both windows stream it, the stuck-TX limit closes it', () => {
  const chunk = bodyOf(main, "ipcMain.on('dax-tx-chunk', (_e, buf) => {", 'if (!smartSdrAudio || !smartSdrAudio.txReady) return;');
  assert.ok(/if \(lan && lan\.voiceTxActive\) \{[\s\S]*pushYaesuLanVoiceChunk\(mic\);\n\s*return;/.test(chunk));
  const cfg = bodyOf(main, 'function _buildAudioBridgeConfig() {', 'return {');
  assert.ok(/\n\s*yaesuLanVoiceRoute\(\);/.test(cfg), 'ECHOCAT bridge: daxTxDirect by route, not readiness');
  assert.ok(/\(s\.audioSource === 'yaesu-lan' && s\.catTarget && s\.catTarget\.type === 'yaesu-lan'\)/.test(vfo), 'VFO window: direct mic path');
  assert.ok(/if \(settings\.audioSource === 'yaesu-lan'\) releaseAllYaesuLanTx\('stuck-TX limit'\);/.test(main));
});

test('#227: JTCAT sends its buffer over the LAN: no session or a busy LAN, no key-down; every end path gives the LAN back', () => {
  const start = bodyOf(main, "ft8Engine.on('tx-start', (data) => {", "ft8Engine.on('tx-end'");
  assert.ok(/const yaesuLanDirectTxOk = settings\.audioSource === 'yaesu-lan' && yaesuLanBufferTxReady\(\);/.test(start));
  const abort = start.indexOf('JTCAT TX aborted before PTT: the LAN session is not up');
  const claim = start.indexOf("const busy = claimYaesuLanTx('jtcat', 'JTCAT TX', ['jtcat']);");
  const key = start.indexOf("lanOwner: yaesuLanDirectTxOk ? 'jtcat' : undefined });");
  assert.ok(abort > 0 && claim > abort && key > claim, 'refused before the claim, the claim before the key-down');
  assert.ok(/if \(busy\) \{\n\s*if \(ft8Engine && ft8Engine\._txActive\) setTimeout\(\(\) => jtcatRefuseTx\(busy\), 0\);\n\s*return;/.test(start), 'a busy LAN skips the slot');
  assert.ok(/\} else if \(yaesuLanDirectTxOk\) \{[\s\S]*?t\.sendTxAudio\(txAudio\.samples, \{ offsetMs: data\.offsetMs \|\| 0, inputSampleRate: 12000, startDelayMs, tailSilenceMs: 200 \}\)/.test(start));
  assert.ok(/txAudio\.outputPeak < 0\.01\)[\s\S]{0,300}endYaesuLanTx\('jtcat', 'silent waveform'\)/.test(start), 'a silent waveform is never keyed on');
  assert.ok(/if \(e && e\.message === 'TX cancelled'\) return;/.test(start));
  for (const why of ['JTCAT tx-end', 'JTCAT stop', 'JTCAT failsafe']) {
    assert.ok(main.includes(`endYaesuLanTx('jtcat', '${why}')`), 'given back and unkeyed (if allowed) on ' + why);
  }
  const halt = bodyOf(main, 'function jtcatHaltTxNow(reason, opts = {}) {', '\n}\n');
  assert.ok(/releaseYaesuLanTx\('jtcat', 'JTCAT halt'\);\n\s*if \(yaesuLanMayUnkey\('jtcat', 'JTCAT halt'\)\) \{/.test(halt), 'Halt never drops a voice over');
});

test('#227: Tune plays its tone over the LAN, refused with no LAN session or a busy LAN', () => {
  const tune = bodyOf(main, 'function startJtcatTune(opts = {}) {', '\nfunction stopJtcatTune');
  assert.ok(/const directYaesuReady = settings\.audioSource === 'yaesu-lan' && yaesuLanBufferTxReady\(\);/.test(tune));
  assert.ok(tune.indexOf('Tune blocked: the LAN session is not up') < tune.indexOf('handleRemotePtt(true'), 'blocked before any key-down');
  assert.ok(tune.indexOf("claimYaesuLanTx('tune'") < tune.indexOf('handleRemotePtt(true'), 'claimed before the key-down');
  assert.ok(/const lan = yaesuLanTransport\(\);\n\s*if \(!lan\) \{/.test(tune), 'null-checked');
  assert.ok(/\} else if \(jtcatTuneState\.directYaesu\) \{[\s\S]*?lan\.sendTxAudio\(/.test(tune));
  assert.ok(main.includes("endYaesuLanTx('tune', 'Tune OFF');"));
});

test('#227: SSTV sends its picture over the LAN; HALT and tx-complete stop it on the wire', () => {
  const enc = bodyOf(main, "sstvEngine.on('encode-complete', (data) => {", "sstvEngine.on('rx-vis'");
  assert.ok(/const useYaesuLanTx = settings\.audioSource === 'yaesu-lan' && yaesuLanBufferTxReady\(\);/.test(enc));
  const claim = enc.indexOf("claimYaesuLanTx('sstv', 'SSTV picture', ['sstv', 'echocat'])");
  assert.ok(enc.indexOf('Yaesu LAN TX blocked before PTT') < claim && claim < enc.indexOf('handleRemotePtt(true,'));
  assert.ok(/if \(useYaesuLanTx\) releaseYaesuLanTx\('sstv', 'SSTV refused'\);/.test(enc) && /if \(useYaesuLanTx\) releaseYaesuLanTx\('sstv', 'SSTV not keyed'\);/.test(enc));
  assert.ok(/const t = yaesuLanTransport\(\);\n\s*if \(!t\) \{/.test(enc), 'null-checked');
  assert.ok(/t\.sendTxAudio\(txAudio\.samples, \{ offsetMs: 0, inputSampleRate: SSTV_SAMPLE_RATE, startDelayMs: 100, tailSilenceMs: 200 \}\)/.test(enc));
  const halt = bodyOf(main, 'function sstvHaltTxNow() {', '\n}');
  assert.ok(/if \(settings\.audioSource === 'yaesu-lan'\) \{ try \{ endYaesuLanTx\('sstv', 'SSTV halt'\);/.test(halt));
  const done = bodyOf(main, "ipcMain.on('sstv-tx-complete', () => {", '\n  });');
  assert.ok(/if \(settings\.audioSource === 'yaesu-lan'\) endYaesuLanTx\('sstv', 'SSTV tx-complete'\);/.test(done));
});

test('#227: a voice macro goes over the LAN: main keys it, sends it and unkeys it at the end itself', () => {
  const app = read('renderer/app.js');
  assert.ok(/if \(s\.audioSource === 'yaesu-lan' && s\.catTarget && s\.catTarget\.type === 'yaesu-lan' && window\.api\.voiceMacroLan\) \{\s*playVoiceAudioLan\(/.test(app));
  assert.ok(/function playVoiceAudioLan\(bytes, idx, btn, label\) \{\s*voicePlaybackCtx = new AudioContext\(\{ sampleRate: 16000 \}\);/.test(app), 'the browser resamples, filtered');
  const lan = bodyOf(main, "ipcMain.on('voice-macro-lan', (_e, payload) => {", '\n  });');
  assert.ok(lan.indexOf('if (!yaesuLanBufferTxReady())') < lan.indexOf("claimYaesuLanTx('macro'"));
  assert.ok(lan.indexOf("claimYaesuLanTx('macro'") < lan.indexOf("handleRemotePtt(true, { audio: true, lanOwner: 'macro' })"), 'claim before the key-down');
  assert.ok(/\.then\(\(\) => \{ endYaesuLanTx\('macro', 'voice macro done'\); stop\(\); \}\)/.test(lan), 'unkeyed in main, then the window is told');
  assert.ok(/endYaesuLanTx\('macro', 'voice macro failed'\);\n\s*stop\(\);/.test(lan));
  assert.ok(/if \(!state && yaesuLanVoiceRoute\(\)\) \{ endYaesuLanTx\('macro', 'voice macro stop'\); return; \}/.test(main), 'the window\'s stop ends the stream');
  assert.ok(/voiceMacroLan: \(payload\) => ipcRenderer\.send\('voice-macro-lan', payload\)/.test(read('preload.js')));
});

test('#227: a radio that may be left keyed is said: log, app notice, VFO window and ECHOCAT, and a dialog at quit', () => {
  const b = bodyOf(main, "} else if (target.type === 'yaesu-lan') {", "} else if (target.type === 'icom-network') {");
  assert.ok(/transport\.on\('unkey-unreachable', \(\{ message \}\) => \{[\s\S]*?'app-notice'[\s\S]*?'tune-blocked'[\s\S]*?type: 'tune-blocked'/.test(b));
  const quit = bodyOf(main, "app.on('before-quit', (e) => {", 'gracefulCleanup();');
  assert.ok(/if \(!lan\.connected && lan\.mayBeKeyed\) \{[\s\S]*?dialog\.showMessageBoxSync\(\{ type: 'warning', title: 'POTACAT', message: 'POTACAT could not reach the radio to unkey it\. It may still be transmitting\.'/.test(quit));
});

test('#227: CW text on a LAN rig skips the local CW Key Port and uses the keyer memory over CAT', () => {
  const b = bodyOf(main, "const lanRig = !!(settings.catTarget && settings.catTarget.type === 'yaesu-lan');", '// Serial CAT (Kenwood/Yaesu/Icom)');
  assert.ok(/if \(!lanRig && \(cwCaps\.textMethod === 'dtr-key-port' \|\| settings\.cwKeyPort\)\) \{/.test(b), 'the key-port branch is skipped');
  const { getModel } = require('../lib/rig-models');
  const cw = getModel('FT-710').cw;
  assert.strictEqual(cw.kyMode, 'km');
  assert.strictEqual(cw.kmMemory, 1);
  assert.strictEqual(cw.kmPlay, 'KY01;', 'the form keyed on the air over the LAN');
});


test('speaker monitor: an opt-in per rig (FT-710 only for now), its saved values persisted per rig, put back before quit', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.ok(/id="yaesu-lan-mute-monitor-row"[^>]*>\s*<input type="checkbox" id="set-yaesu-lan-mute-monitor">/.test(html));
  assert.ok(/muteMonitor: !!\(document\.getElementById\('set-yaesu-lan-mute-monitor'\) \|\| \{\}\)\.checked,/.test(app), 'saved with the target');
  assert.ok(/set-yaesu-lan-mute-monitor'\)\.checked = !!currentTarget\.muteMonitor;\n\s*syncYaesuLanMuteMonitorRow\(\);/.test(app), 'loaded with the target');
  assert.ok(/const ok = !!rigModelSelect && rigModelSelect\.value === 'FT-710';/.test(app), 'offered on the FT-710 only');
  const b = bodyOf(main, "} else if (target.type === 'yaesu-lan') {", "} else if (target.type === 'icom-network') {");
  assert.ok(/const muteMonitor = !!target\.muteMonitor && modelName === 'FT-710';/.test(b), 'and honoured on the FT-710 only');
  assert.ok(/muteMonitor,\s*monitorSaved: \(settings\.yaesuLanMonitorSaved \|\| \{\}\)\[_ylMonKey\] \|\| null,/.test(b));
  assert.ok(/transport\.on\('monitor-saved'[\s\S]*?saveSettings\(settings\)/.test(b) && /transport\.on\('monitor-restored'[\s\S]*?delete settings\.yaesuLanMonitorSaved\[_ylMonKey\]/.test(b));
  const quit = bodyOf(main, "app.on('before-quit', (e) => {", 'gracefulCleanup();');
  assert.ok(/lan\.mayBeKeyed \|\| Object\.keys\(lan\.monitorSaved\)\.length/.test(quit));
  assert.ok(/try \{ closed = lan\.disconnect\(\); \} catch \{\}\n\s*Promise\.race\(\[Promise\.resolve\(closed\), new Promise\(\(r\) => setTimeout\(r, 5000\)\)\]\)/.test(quit), 'waits for the paced restore, at most 5 s');
});

test('setup note: the FT-710 menu setting for LAN transmit audio lives in lib/rig-setup-notes.js', () => {
  const { NOTES } = require('../lib/rig-setup-notes');
  const n = NOTES.find((x) => x.id === 'ft710-scu-lan10-ssb-mod-source');
  assert.ok(n && n.applies.radioTypes.join() === 'yaesu-lan' && n.applies.models.join() === 'FT-710');
  assert.strictEqual(n.source, 'DA2PK, FT-710, 2026-11-11');
  assert.ok(!/SSB MOD SOURCE/.test(read('renderer/index.html')) && !/SSB MOD SOURCE/.test(read('renderer/app.js')), 'the help texts point to the note');
});

console.log(`\nSCU-LAN10 wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
