// VARA HF / VARA FM — the operator's own copy, on Windows, through a virtual
// audio cable POTACAT bridges to the radio (docs/vara-integration-plan.md,
// docs/modem-audio-bridge-plan.md phase 4). Pure rules in lib/vara-process.js
// and lib/winlink-modes.js; the probe against a fake VARA; Pat's varafm shape;
// and source guards on main.js / the bridge window: VARA is never bundled,
// never killed, never given PTT, and its TX audio reaches the radio only
// while it has PTT through Pat and the shim.
// Run: node test/winlink-vara-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const V = require('../lib/vara-process');
const M = require('../lib/winlink-modes');
const W = require('../lib/winlink-pat');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0, j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

(async () => {
  console.log('vara-process');
  await test('paths: the operator\'s own first, then where VARA installs itself; ports: 8300 HF / 8310 FM by default', () => {
    const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\k3sbp\\AppData\\Local' };
    const hf = V.varaPathCandidates({ settings: { winlinkVaraHfPath: 'D:\\Ham\\VARA\\VARA.exe' }, kind: 'hf', env });
    assert.strictEqual(hf[0], 'D:\\Ham\\VARA\\VARA.exe');
    assert.strictEqual(hf[1], 'C:\\VARA\\VARA.exe');
    assert.ok(hf.includes('C:\\Program Files (x86)\\VARA\\VARA.exe'));
    const fm = V.varaPathCandidates({ settings: {}, kind: 'fm', env });
    assert.strictEqual(fm[0], 'C:\\VARA FM\\VARAFM.exe');
    assert.ok(!fm.some((p) => /VARA\\VARA\.exe$/.test(p)), 'FM never points at the HF program');
    assert.strictEqual(V.varaPortFor({}, 'hf'), 8300);
    assert.strictEqual(V.varaPortFor({}, 'fm'), 8310);
    assert.strictEqual(V.varaPortFor({ winlinkVaraFmPort: '8400' }, 'fm'), 8400);
    assert.strictEqual(V.varaPortFor({ winlinkVaraPort: 'x' }, 'hf'), 8300);
    assert.strictEqual(V.kindOfMode('varafm'), 'fm');
    assert.strictEqual(V.kindOfMode('vara'), 'hf');
    assert.strictEqual(V.kindOfMode('ardop'), null);
    assert.strictEqual(V.varaModeId('fm'), 'varafm');
  });
  await test('launch options: detached, its own window, nothing piped — and never a kill anywhere in main', () => {
    const o = V.varaSpawnOptions();
    assert.strictEqual(o.detached, true);
    assert.strictEqual(o.stdio, 'ignore');
    assert.strictEqual(o.windowsHide, false);
    assert.strictEqual(V.parseVaraVersion('VERSION VARA HF v4.8.7'), 'VARA HF v4.8.7');
    assert.strictEqual(V.parseVaraVersion('PTT ON'), null);
    assert.ok(!/\bvaraProc\b|\bkillVara\b|VARA\.exe.*kill/i.test(main), 'POTACAT never holds a VARA process to kill');
    const ready = fnBody(main, 'winlinkVaraReady');
    assert.ok(/VaraProcess\.varaSpawnOptions\(\)/.test(ready) && /child\.unref\(\)/.test(ready), 'started detached and let go');
    assert.ok(!/\.kill\(/.test(ready));
  });
  await test('probe: VERSION from a fake VARA; a connection refused is "not running"; a silent open port still counts', async () => {
    const fake = net.createServer((sock) => {
      sock.on('data', (d) => { if (/VERSION/i.test(d.toString())) sock.write('VERSION VARA HF v4.8.7\r'); });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = fake.address().port;
    const p = await V.probeVaraPort(port);
    assert.deepStrictEqual(p, { ok: true, version: 'VARA HF v4.8.7' });
    fake.close();
    await new Promise((r) => setTimeout(r, 30));
    const gone = await V.probeVaraPort(port, { timeoutMs: 1000 });
    assert.strictEqual(gone.ok, false);
    assert.strictEqual(gone.error, 'refused');
    const quiet = net.createServer(() => {});
    await new Promise((r) => quiet.listen(0, '127.0.0.1', r));
    const q = await V.probeVaraPort(quiet.address().port, { timeoutMs: 200 });
    assert.strictEqual(q.ok, true);
    assert.strictEqual(q.silent, true);
    quiet.close();
    assert.ok(/VARA HF on, found at C:\\VARA\\VARA\.exe, running \(VARA HF v4\.8\.7\)/.test(V.describeVara('hf', { enabled: true, found: true, path: 'C:\\VARA\\VARA.exe', probe: p })));
    assert.strictEqual(V.describeVara('fm', { enabled: false }), 'VARA FM off');
  });

  console.log('winlink-modes');
  await test('VARA is listed only when the operator turned it on; Windows only; the cable lifts the Flex Direct / Icom Network reason', () => {
    const base = { rigFamily: 'serial', audioSource: 'dax', platform: 'win32', mercuryEnabled: true, mercuryPort: 8300, ardopFound: true, direwolfFound: true, ardopSocketAudio: true };
    assert.deepStrictEqual(M.winlinkModesFor(base).map((m) => m.id), ['telnet', 'ardop', 'packet', 'mercury'], 'off = not listed');
    const on = M.winlinkModesFor({ ...base, varaHf: { enabled: true, port: 8301, cable: false }, varaFm: { enabled: true, port: 8310, cable: false } });
    assert.deepStrictEqual(on.map((m) => [m.id, m.available]), [['telnet', true], ['ardop', true], ['packet', true], ['mercury', true], ['vara', true], ['varafm', true]]);
    assert.strictEqual(M.LABELS.varafm, 'VARA FM (VHF/UHF radio, your own VARA FM)');
    const mac = M.winlinkModesFor({ ...base, platform: 'darwin', varaHf: { enabled: true, port: 8301 } });
    assert.ok(!mac[4].available && /Windows program/.test(mac[4].reason));
    const flex = M.winlinkModesFor({ ...base, rigFamily: 'flex', audioSource: 'smartsdr', varaHf: { enabled: true, port: 8301, cable: false }, varaFm: { enabled: true, port: 8310, cable: false } });
    assert.ok(!flex[4].available && /virtual audio cable/.test(flex[4].reason) && /Flex Direct/.test(flex[4].reason));
    assert.ok(!flex[5].available && /virtual audio cable/.test(flex[5].reason));
    const flexCable = M.winlinkModesFor({ ...base, rigFamily: 'flex', audioSource: 'smartsdr', varaHf: { enabled: true, port: 8301, cable: true }, varaFm: { enabled: true, port: 8310, cable: true } });
    assert.ok(flexCable[4].available && flexCable[5].available, 'with the cable, VARA works on Flex Direct');
    assert.ok(!flexCable[3].available, 'Mercury still needs a device');
    const icomCable = M.winlinkModesFor({ ...base, rigFamily: 'icom-network', audioSource: 'icom-network', varaHf: { enabled: true, port: 8301, cable: true } });
    assert.ok(icomCable[4].available);
    assert.ok(!M.winlinkModesFor({ ...base, remote: true, varaHf: { enabled: true, port: 8301, cable: true } })[4].available, 'never from a laptop driving a shack');
    assert.ok(!M.winlinkModesFor({ ...base, rigFamily: 'none', varaHf: { enabled: true, port: 8301, cable: true } })[4].available, 'needs CAT');
  });
  await test('port clashes are named: VARA HF vs Mercury, VARA FM vs VARA HF', () => {
    const base = { rigFamily: 'serial', audioSource: 'dax', platform: 'win32', mercuryEnabled: true, mercuryPort: 8300, ardopSocketAudio: true };
    const clash = M.winlinkModesFor({ ...base, varaHf: { enabled: true, port: 8300 } });
    assert.ok(!clash[4].available && /same port \(8300\)/.test(clash[4].reason));
    const fmClash = M.winlinkModesFor({ ...base, varaHf: { enabled: true, port: 8301 }, varaFm: { enabled: true, port: 8301 } });
    assert.ok(fmClash[4].available, 'HF is fine');
    assert.ok(!fmClash[5].available && /VARA FM and VARA HF are set to the same port \(8301\)/.test(fmClash[5].reason));
    const fmAlone = M.winlinkModesFor({ ...base, varaHf: { enabled: false, port: 8301 }, varaFm: { enabled: true, port: 8301 } });
    assert.ok(fmAlone[4].id === 'varafm' && fmAlone[4].available, 'no clash with a VARA HF that is off');
    assert.ok(M.isRadioMode('varafm') && M.isFmMode('varafm') && M.isFmMode('packet') && !M.isFmMode('vara'));
  });

  console.log('winlink-pat');
  await test('Pat gets a varafm section on its own port, keyed through the shim; the FM URL carries no bw', () => {
    const c = W.buildPatConfig({ mycall: 'K3SBP', httpPort: 8591, shimPort: 4541, transport: { varaFmAddr: '127.0.0.1:8310' } });
    assert.deepStrictEqual(c.varafm, { addr: '127.0.0.1:8310', rig: 'potacat', ptt_ctrl: true });
    assert.strictEqual(W.buildPatConfig({ mycall: 'K3SBP', httpPort: 8591, shimPort: 4541 }).varafm.addr, '127.0.0.1:8310', 'default port');
    assert.ok(!W.buildPatConfig({ mycall: 'K3SBP', httpPort: 8591 }).varafm, 'phase-1 shape has no modems');
    assert.strictEqual(W.connectUrl({ mode: 'varafm', gateway: 'N3MEL-11', dialKhz: 145050, bw: 2300 }), 'varafm:///N3MEL-11?freq=145050');
    assert.ok(W.WINLINK_MODES.includes('varafm'));
  });

  console.log('main.js wiring');
  await test('a VARA session probes/starts VARA and readies its audio before Pat connects; VARA FM QSYs to FM', () => {
    const s = fnBody(main, 'winlinkStartSession');
    assert.ok(/if \(mode === 'vara' \|\| mode === 'varafm'\) \{\s*await winlinkVaraReady\(mode\);\s*if \(!live\(\)\) throw cancelled\(\);\s*await winlinkVaraAudioReady\(\);/.test(s));
    assert.ok(s.indexOf('await winlinkVaraReady(mode)') < s.indexOf('await patClient.connect(url)'), 'before the connect');
    assert.ok(/WinlinkModes\.isFmMode\(mode\) \? 'FM' : 'DIGU'/.test(s), 'FM for packet and VARA FM, USB data for the rest');
    assert.ok(/mode === 'varafm' \? 'varafm' : 'varahf'/.test(fnBody(main, 'winlinkGateways')), 'the gateway list asks Pat for varafm');
    assert.ok(/varaFmAddr: `127\.0\.0\.1:\$\{_winlinkVaraFmPort\(\)\}`/.test(fnBody(main, 'writePatConfig')));
    assert.ok(/if \(mode === 'varafm'\) return `VARA FM is not answering/.test(fnBody(main, 'winlinkTransportDownText')));
  });
  await test('a VARA whose port Pat holds from the last session is reused, not refused (W7RTA)', () => {
    const s = fnBody(main, 'winlinkVaraReady');
    const reuse = s.indexOf("_patHoldsVara[kind] === patProc && await varaProcessRunning(kind)");
    assert.ok(reuse > 0, 'reuse check');
    assert.ok(reuse < s.indexOf('is open on the shack PC but is not answering'), 'before the not-answering refusal');
    assert.ok(/_patHoldsVara\[kind\] = patProc;[^\n]*\n\s*winlinkLog\(`\$\{name\} ready on/.test(s), 'marked when Pat is handed VARA');
  });
  await test('VARA\'s transmit audio reaches the radio only while it has PTT, through the one TX dispatch; the radio reaches VARA through the cable playback', () => {
    const rx = main.slice(main.indexOf("ipcMain.on('modem-bridge-cable-rx'"), main.indexOf("ipcMain.on('modem-bridge-cable-status'"));
    assert.ok(/if \(!winlinkTxActive\) return;/.test(rx), 'idle hiss never reaches the transmitter');
    assert.ok(/winlinkDispatchTx\(out\)/.test(rx));
    assert.ok(/e\.sender !== modemBridgeWin\.webContents/.test(rx), 'only the bridge window may feed it');
    const feed = fnBody(main, 'winlinkFeedRx');
    assert.ok(/modemBridge\.cable\.state === 'ok'[\s\S]*?audioSafeSend\(modemBridgeWin\.webContents, 'modem-bridge-cable-tx'/.test(feed), 'the radio\'s RX goes to VARA over the cable');
    const dispatch = fnBody(main, 'winlinkDispatchTx');
    assert.ok(/pushTxAudioChunk\(mono24k\)/.test(dispatch) && /pushIcomNetworkVoiceChunk\(mono24k\)/.test(dispatch) && /'modem-bridge-tx'/.test(dispatch), 'Flex, Icom Network, radio-side bridge');
    assert.ok(/winlinkDispatchTx\(mono24k\)/.test(fnBody(main, 'startWinlinkAudio')), 'the socket modems use the same dispatch');
    const ready = fnBody(main, 'winlinkVaraAudioReady');
    assert.ok(/if \(!winlinkCableConfigured\(\)\) \{[\s\S]*?winlinkIpAudioRoute\(\)[\s\S]*?set up the virtual audio cable/.test(ready), 'no cable on Flex Direct / Icom Network is refused with the fix');
    assert.ok(/startModemBridgeCable\(\);[\s\S]*?modemBridgeCableReady\(10000\)/.test(ready));
    assert.ok(/stopModemBridgeCable\(\);/.test(fnBody(main, 'winlinkEndSession')), 'the cable side ends with the session');
  });
  await test('the bridge window has a cable side: same device rules, its own channels, stopped with the session', () => {
    const page = read('renderer/modem-audio-bridge.js');
    assert.ok(/deviceId: \{ exact: c\.inputId \}/.test(page) && /playCtx\.setSinkId\(c\.outputId\)/.test(page), 'exact devices, never the default');
    assert.ok(/window\.bridge\.onCableStart\(/.test(page) && /window\.bridge\.onCableTx\(/.test(page) && /window\.bridge\.onCableStop\(/.test(page));
    assert.ok(/what: 'virtual cable', where: 'Settings > Station > Winlink \(VARA\)'/.test(page), 'cable errors name the cable and the Settings that fix it');
    const pre = read('preload-modem-audio-bridge.js');
    for (const ch of ['modem-bridge-cable-start', 'modem-bridge-cable-stop', 'modem-bridge-cable-rx', 'modem-bridge-cable-status', 'modem-bridge-cable-tx']) assert.ok(pre.includes(`'${ch}'`), ch);
    assert.ok(/ackedChannel\('modem-bridge-cable-tx'/.test(pre), 'cable TX is ACK-credited like the radio side');
  });
  await test('settings: the cable lives on the rig and survives an older rig list; VARA paths/ports are machine keys; nothing of VARA ships', () => {
    assert.ok(/const SETUP_KEYS = \[[^\]]*'modemCable'/.test(main));
    const gk = main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf('const CLOUD_TUNNEL_CONFIG_FILENAME'));
    for (const k of ['winlinkVaraPort', 'winlinkVaraFmPort', 'winlinkVaraHfPath', 'winlinkVaraFmPath', 'winlinkVaraAutoLaunch']) assert.ok(gk.includes(`'${k}'`), k);
    assert.ok(/'winlinkVaraFmPort',/.test(main.slice(main.indexOf('const winlinkChanged = ['), main.indexOf('const winlinkChanged = [') + 300)), 'a new FM port relaunches Pat');
    const app = read('renderer/app.js');
    assert.ok(/r\.modemCable = \(inputId \|\| outputId\) \? \{ inputId, outputId \} : null;/.test(app), 'the renderer stamps the cable on the active rig at save');
    assert.ok(/winlinkVaraSection\.classList\.toggle\('hidden', window\.api\.platform !== 'win32'\)/.test(app), 'the VARA section shows on Windows only');
    const pkg = JSON.parse(read('package.json'));
    const text = JSON.stringify(pkg.build) + read('scripts/build-winlink-helpers.sh') + read('NOTICE');
    assert.ok(!/vara\.exe|varafm\.exe|rosmodem/i.test(text), 'never bundled, fetched or attributed as shipped');
    assert.ok(!/licen[cs]e key|VARA_KEY|varaLicen/i.test(main + app), 'POTACAT never touches a VARA licence');
    const html = read('renderer/index.html');
    assert.ok(/PTT = <b>VOX<\/b>/.test(html) && /Without a licence it runs at reduced speed/.test(html));
    assert.ok(!/PTT to <b>None<\/b>/.test(html), 'VARA has no "None"; the dialog says VOX');
  });

  console.log('Set up VARA for me (lib/vara-setup.js)');
  const S = require('../lib/vara-setup');
  const DEV = (kind, label, id) => ({ kind, label, deviceId: id });
  const CABLES = [
    DEV('audiooutput', 'Speakers (Realtek(R) Audio)', 'spk'),
    DEV('audiooutput', 'CABLE Input (VB-Audio Virtual Cable)', 'cab-in'),
    DEV('audioinput', 'CABLE Output (VB-Audio Virtual Cable)', 'cab-out'),
    // Windows (WASAPI, what the renderer sees) names the Hi-Fi Cable's playback
    // end "Speakers (…)"; VARA's MME list calls it "Hi-Fi Cable Input" — seen
    // on K3SBP's PC 2026-10-23. Pairing is by family, direction by kind.
    DEV('audiooutput', 'Speakers (VB-Audio Hi-Fi Cable)', 'hifi-in'),
    DEV('audioinput', 'Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)', 'hifi-out'),
    DEV('audioinput', 'Voicemeeter Output (VB-Audio Voicemeeter VAIO)', 'vm-out'),
    DEV('audiooutput', 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)', 'vm-in'),
    DEV('audioinput', 'default', 'default'),
  ];
  const MME = {
    capture: [{ name: 'Mic In (Elgato Wave:3)' }, { name: 'Hi-Fi Cable Output (VB-Audio Hi' }, { name: 'CABLE Output (VB-Audio Virtual ' }, { name: 'DAX Audio RX 1 (FlexRadio Syste' }],
    playback: [{ name: 'Hi-Fi Cable Input (VB-Audio Hi-' }, { name: 'CABLE Input (VB-Audio Virtual C' }, { name: 'Headphones (Elgato Wave:3)' }],
  };
  await test('VARA\'s names come from the MME listing, where the Hi-Fi Cable is not called Speakers', () => {
    const p = S.planCables(CABLES, { mme: MME });
    assert.strictEqual(p.vara.fromListing, true);
    assert.strictEqual(p.vara.inputName, 'CABLE Output (VB-Audio Virtual ');
    assert.strictEqual(p.vara.outputName, 'Hi-Fi Cable Input (VB-Audio Hi-');
    assert.deepStrictEqual(S.mmeNamesFor('CABLE-A', MME, { captureLabel: 'CABLE-A Output (VB-Audio Cable A)', playbackLabel: 'CABLE-A Input (VB-Audio Cable A)' }), { capture: 'CABLE-A Output (VB-Audio Cable ', playback: 'CABLE-A Input (VB-Audio Cable A', fromListing: false }, 'not in the listing: the 31-char label, flagged');
    assert.strictEqual(S.cableFamily('Speakers (VB-Audio Hi-Fi Cable)'), 'Hi-Fi Cable');
    assert.strictEqual(S.cableFamily('CABLE Input (VB-Audio Virtual Cable)'), 'CABLE');
    assert.strictEqual(S.cableFamily('CABLE-B Output (VB-Audio Cable B)'), 'CABLE-B');
    assert.strictEqual(S.cableFamily('Voicemeeter Input (VB-Audio Voicemeeter VAIO)'), null);
    assert.strictEqual(S.cableFamily('Speakers (Realtek(R) Audio)'), null);
  });
  await test('K3SBP PC: both cables have a playback end called "Speakers (…)", and VB-CABLE 45 16-channel end is never the one picked', () => {
    const real = [
      DEV('audiooutput', 'CABLE In 16 Ch (VB-Audio Virtual Cable)', 'c16'),
      DEV('audiooutput', 'Speakers (VB-Audio Virtual Cable)', 'cab-in'),
      DEV('audiooutput', 'Speakers (VB-Audio Hi-Fi Cable)', 'hifi-in'),
      DEV('audioinput', 'CABLE Output (VB-Audio Virtual Cable)', 'cab-out'),
      DEV('audioinput', 'Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)', 'hifi-out'),
    ];
    const mme = { capture: [{ name: 'Hi-Fi Cable Output (VB-Audio Hi' }, { name: 'CABLE Output (VB-Audio Virtual ' }], playback: [{ name: 'CABLE Input (VB-Audio Virtual C' }, { name: 'Hi-Fi Cable Input (VB-Audio Hi-' }, { name: 'CABLE In 16ch (VB-Audio Virtual' }] };
    const p = S.planCables(real, { mme });
    assert.deepStrictEqual([p.potacat.outputId, p.potacat.inputId], ['cab-in', 'hifi-out'], 'the plain two-channel end, whichever Windows listed first');
    assert.deepStrictEqual(p.vara, { inputName: 'CABLE Output (VB-Audio Virtual ', outputName: 'Hi-Fi Cable Input (VB-Audio Hi-', fromListing: true });
    const only16 = S.planCables(real.filter((d) => d.deviceId !== 'cab-in'), { mme });
    assert.strictEqual(only16.potacat.outputId, 'c16', 'with nothing else the 16-channel end still pairs');
  });
  await test('two cables are paired by name and direction; Voicemeeter is seen but never used', () => {
    const p = S.planCables(CABLES);
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.found, 2);
    assert.strictEqual(p.voicemeeter, true);
    assert.strictEqual(p.toVara.name, 'CABLE');
    assert.strictEqual(p.fromVara.name, 'Hi-Fi Cable');
    // No MME listing given: the WASAPI labels cut to 31, flagged as a guess.
    assert.strictEqual(p.vara.inputName, 'CABLE Output (VB-Audio Virtual ');
    assert.strictEqual(p.vara.outputName, 'Speakers (VB-Audio Hi-Fi Cable)');
    assert.strictEqual(p.vara.fromListing, false);
    // POTACAT plays into cable 1's Input end and records cable 2's Output end.
    assert.deepStrictEqual([p.potacat.outputId, p.potacat.inputId], ['cab-in', 'hifi-out']);
  });
  await test('the A+B pack wins over the free pair, A before B', () => {
    const p = S.planCables(CABLES.concat([
      DEV('audiooutput', 'CABLE-B Input (VB-Audio Cable B)', 'b-in'), DEV('audioinput', 'CABLE-B Output (VB-Audio Cable B)', 'b-out'),
      DEV('audiooutput', 'CABLE-A Input (VB-Audio Cable A)', 'a-in'), DEV('audioinput', 'CABLE-A Output (VB-Audio Cable A)', 'a-out'),
    ]));
    assert.deepStrictEqual([p.toVara.name, p.fromVara.name], ['CABLE-A', 'CABLE-B']);
    assert.strictEqual(p.vara.inputName, 'CABLE-A Output (VB-Audio Cable ');
  });
  await test('one cable or none: the advice names the free second cable and where it is; a half cable is not a cable', () => {
    const one = S.planCables(CABLES.filter((d) => !/Hi-Fi/.test(d.label)));
    assert.strictEqual(one.ok, false);
    assert.ok(/One virtual cable found \(CABLE\)/.test(one.advice) && /Hi-Fi Cable/.test(one.advice) && /vb-audio\.com\/Cable/.test(one.advice));
    const none = S.planCables(CABLES.filter((d) => !/cable/i.test(d.label)));
    assert.ok(/No virtual audio cable found/.test(none.advice) && /Voicemeeter is installed/.test(none.advice));
    const half = S.planCables([DEV('audiooutput', 'CABLE Input (VB-Audio Virtual Cable)', 'x'), DEV('audiooutput', 'Speakers (VB-Audio Hi-Fi Cable)', 'y')]);
    assert.strictEqual(half.found, 0);
  });
  await test('VARA.ini is patched on its named lines only, CRLF kept, missing keys added under their section', () => {
    const ini = '[Soundcard]\r\nInput Device Name=DAX RX 1 (FlexRadio DAX)\r\nOutput Device Name=DAX TX (FlexRadio DAX)\r\nALC Drive Level=-5\r\n[PTT]\r\nRig=52\r\nPTTPort=COM1\r\nVia=3\r\n[Setup]\r\nRegistration Code=\r\nTCP Command Port=8300\r\n[Position]\r\nTop Position=3375\r\n';
    const r = S.planVaraIniPatch(ini, { inputName: 'CABLE Output (VB-Audio Virtual Cable)', outputName: 'Hi-Fi Cable Input (VB-Audio Hi-Fi Cable)', port: 8300 });
    assert.ok(r.text.includes('\r\nInput Device Name=CABLE Output (VB-Audio Virtual \r\n'), 'input, 31 chars');
    assert.ok(r.text.includes('\r\nOutput Device Name=Hi-Fi Cable Input (VB-Audio Hi-\r\n'));
    assert.ok(r.text.includes('\r\nVia=' + S.VARA_PTT_VIA_VOX + '\r\n'));
    assert.ok(r.text.includes('ALC Drive Level=-5') && r.text.includes('Rig=52') && r.text.includes('Registration Code=') && r.text.includes('Top Position=3375'), 'every other line passes through');
    assert.ok(!/\n(?!\r)/.test(r.text.replace(/\r\n/g, '\r\n')) || /\r\n/.test(r.text), 'CRLF kept');
    assert.deepStrictEqual(r.changes.map((c) => c.key), ['Input Device Name', 'Output Device Name', 'Via']);
    const again = S.planVaraIniPatch(r.text, { inputName: 'CABLE Output (VB-Audio Virtual Cable)', outputName: 'Hi-Fi Cable Input (VB-Audio Hi-Fi Cable)', port: 8300 });
    assert.strictEqual(again.changes.length, 0, 'idempotent');
    assert.strictEqual(again.text, r.text);
    const empty = S.planVaraIniPatch('', { inputName: 'A Output', outputName: 'B Input', port: 8310 });
    assert.ok(/\[Soundcard\]\nInput Device Name=A Output\nOutput Device Name=B Input\n\n\[PTT\]\nVia=1\n\n\[Setup\]\nTCP Command Port=8310\n/.test(empty.text), 'built from nothing: ' + JSON.stringify(empty.text));
  });
  await test('the rig layer decides the route: network-audio rigs get cables, every other rig is direct, PTT is VOX everywhere', () => {
    assert.strictEqual(S.varaRouteFor({ audioSource: 'smartsdr' }).route, 'cable');
    assert.strictEqual(S.varaRouteFor({ audioSource: 'icom-network' }).route, 'cable');
    for (const src of ['dax', 'device', 'usb', '', undefined]) assert.strictEqual(S.varaRouteFor({ audioSource: src }).route, 'direct', 'direct for ' + src);
    const d = S.planDirect({ capture: 'Microphone (USB Audio CODEC)', playback: 'Speakers (USB Audio CODEC)' });
    assert.strictEqual(d.ok, true);
    assert.deepStrictEqual(d.vara, { inputName: 'Microphone (USB Audio CODEC)', outputName: 'Speakers (USB Audio CODEC)' });
    assert.strictEqual(S.planDirect({ capture: 'DAX Audio RX 1 (FlexRadio Systems DAX)', playback: 'x' }).vara.inputName, 'DAX Audio RX 1 (FlexRadio Syste');
    assert.ok(/Settings > My Rigs/.test(S.planDirect({}).advice));
    const txt = S.describeSetup({ kind: 'hf', plan: d, path: 'C:\\VARA\\VARA.exe', port: 8300, version: 'VARA HF 4.8.9', iniChanged: true });
    assert.ok(/uses the radio's sound card directly/.test(txt) && /No cable/.test(txt));
    const saved = S.planCablesFromSaved({ inputId: 'hifi-out', outputId: 'cab-in', inputLabel: 'Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)', outputLabel: 'CABLE Input (VB-Audio Virtual Cable)', varaInputName: 'CABLE Output (VB-Audio Virtual ', varaOutputName: 'Hi-Fi Cable Input (VB-Audio Hi-' });
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual([saved.toVara.name, saved.fromVara.name, saved.vara.inputName, saved.vara.outputName], ['CABLE', 'Hi-Fi Cable', 'CABLE Output (VB-Audio Virtual ', 'Hi-Fi Cable Input (VB-Audio Hi-']);
    assert.ok(/Click Set up VARA for me once/.test(S.planCablesFromSaved({ inputId: 'x' }).advice));
    // A plan saved with the two ids and labels but without VARA's names (an
    // earlier shape) is still configured: the names come from the labels.
    const old = S.planCablesFromSaved({ inputId: 'hifi-out', outputId: 'cab-in', inputLabel: 'Hi-Fi Cable Output (VB-Audio Hi-Fi Cable)', outputLabel: 'CABLE Input (VB-Audio Virtual Cable)' });
    assert.strictEqual(old.ok, true, 'ids + labels are a configured cable route');
    assert.strictEqual(old.vara.inputName, 'CABLE Output (VB-Audio Virtual ');
    assert.strictEqual(old.vara.outputName, 'Hi-Fi Cable Input (VB-Audio Hi-');
    assert.strictEqual(old.vara.fromListing, false);
    assert.strictEqual(S.planCablesFromSaved({ inputId: 'a', outputId: 'b' }).ok, false, 'no labels, no names: not configured');
  });
  await test('VARA\'s log names the device it could not open', () => {
    assert.strictEqual(S.varaLogDeviceProblem('2026-10-23 12:00:00    WARNING: VARA is not connected to any App via TCP Port 8300\n'), '');
    const old = 'x\n2026-09-30 18:30:27    Soundcard Output Device missing in action !\n2026-09-30 18:30:27    Soundcard Input Device missing in action !\n';
    assert.ok(/input and output device/.test(S.varaLogDeviceProblem(old)));
    assert.ok(/^VARA could not open its output device/.test(S.varaLogDeviceProblem('Soundcard Output Device missing in action !')));
    // K3SBP 2026-10-23: September's lines at the tail of an untouched log are not today's verdict.
    const launched = new Date(2026, 9, 23, 14, 49, 1).getTime();
    assert.strictEqual(S.varaLogDeviceProblem(old, launched), '', 'lines before the launch do not count');
    assert.ok(/input device/.test(S.varaLogDeviceProblem(old + '2026-10-23 14:49:09    Soundcard Input Device missing in action !\n', launched)), 'a line after the launch does');
    assert.strictEqual(S.varaLogDeviceProblem('Soundcard Output Device missing in action !', launched), '', 'an undated line cannot be placed, so it does not count against this launch');
    // The exact 31st character: a trimmed listing name is restored from the label it was cut from.
    const MME2 = { capture: [{ name: 'CABLE Output (VB-Audio Virtual' }], playback: [{ name: 'CABLE Input (VB-Audio Virtual C' }] };
    const n = S.mmeNamesFor('CABLE', MME2, { captureLabel: 'CABLE Output (VB-Audio Virtual Cable)', playbackLabel: 'Speakers (VB-Audio Virtual Cable)' });
    assert.strictEqual(n.capture, 'CABLE Output (VB-Audio Virtual ', 'trailing space restored');
    assert.strictEqual(n.capture.length, 31);
    assert.strictEqual(n.playback, 'CABLE Input (VB-Audio Virtual C', 'already 31: unchanged');
  });
  await test('wiring: the button, the IPC, the preload, the ini written only while VARA is closed, a backup first', () => {
    const html = read('renderer/index.html');
    assert.ok(/id="vara-setup-hf"/.test(html) && /id="vara-setup-fm"/.test(html) && /Set up VARA HF for me/.test(html));
    assert.ok(/vb-audio\.com\/Cable\//.test(html) && /Hi-Fi Cable/.test(html), 'the two free cables are named and linked');
    const fn = fnBody(main, 'winlinkVaraConfigure');
    assert.ok(/VaraSetup\.varaRouteFor\(\{ audioSource: settings\.audioSource \}\)/.test(fn), 'the route is the rig layer\'s');
    assert.ok(/const a = await winlinkAutoAudio\(\{ inputLabel, outputLabel \}\);/.test(fn), 'direct route = the radio\'s own devices, the ARDOP pick');
    assert.ok(/rig\.modemCable = null;/.test(fn), 'direct route leaves no cable on the rig');
    assert.ok(/if \(probe\.ok\) return \{ ok: false, step: 'running'/.test(fn), 'never written under a running VARA');
    const ready = fnBody(main, 'winlinkVaraReady');
    assert.ok(/const c = await winlinkVaraConfigure\(\{ kind, quiet: true \}\);/.test(ready), 'a session configures VARA for the radio before starting it');
    assert.ok(/winlinkVaraConfigure\(\{ kind, quiet: true \}\)\.then/.test(main), 'a rig switch re-syncs a closed VARA');
    assert.ok(!/PTT set to None/.test(main), 'VARA has no None: VOX');
    assert.ok(/fs\.copyFileSync\(iniPath, iniPath \+ '\.potacat-'/.test(fn), 'backup before the write');
    assert.ok(/VaraSetup\.planVaraIniPatch\(iniText, \{ inputName: plan\.vara\.inputName, outputName: plan\.vara\.outputName, port \}\)/.test(fn));
    assert.ok(/rig\.modemCable = \{ inputId: plan\.potacat\.inputId, outputId: plan\.potacat\.outputId, inputLabel: plan\.potacat\.inputLabel, outputLabel: plan\.potacat\.outputLabel, varaInputName: plan\.vara\.inputName, varaOutputName: plan\.vara\.outputName \}/.test(fn), 'POTACAT\'s side and VARA\'s names saved on the rig for later syncs');
    assert.ok(/const l = await listArdopDevices\(\); if \(l && l\.ok\) mme = l\.devices;/.test(fn) && /VaraSetup\.planCables\(devices, \{ mme \}\)/.test(fn), 'VARA\'s names come from the MME listing');
    assert.ok(/VaraSetup\.varaLogDeviceProblem\(/.test(fnBody(main, 'winlinkVaraSetup')), 'VARA\'s log is the verdict');
    assert.ok(/ipcMain\.handle\('winlink-vara-setup'/.test(main));
    assert.ok(/winlinkVaraSetup: \(kind, devices, labels\) => ipcRenderer\.invoke\('winlink-vara-setup'/.test(read('preload.js')));
    assert.ok(/window\.api\.winlinkVaraSetup\(kind, devs, labels\)/.test(read('renderer/app.js')), 'the button hands over the rig\'s device labels');
    assert.ok(!/kill\(|taskkill/.test(fn + fnBody(main, 'winlinkVaraSetup')), 'POTACAT never closes VARA');
    assert.ok(/A radio with a USB sound card needs no cable/.test(html), 'the copy says the radio decides');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
