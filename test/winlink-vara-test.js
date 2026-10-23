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
    assert.ok(/if \(mode === 'vara' \|\| mode === 'varafm'\) \{ await winlinkVaraReady\(mode\); await winlinkVaraAudioReady\(\); \}/.test(s));
    assert.ok(s.indexOf('await winlinkVaraReady(mode)') < s.indexOf('await patClient.connect(url)'), 'before the connect');
    assert.ok(/WinlinkModes\.isFmMode\(mode\) \? 'FM' : 'DIGU'/.test(s), 'FM for packet and VARA FM, USB data for the rest');
    assert.ok(/mode === 'varafm' \? 'varafm' : 'varahf'/.test(fnBody(main, 'winlinkGateways')), 'the gateway list asks Pat for varafm');
    assert.ok(/varaFmAddr: `127\.0\.0\.1:\$\{_winlinkVaraFmPort\(\)\}`/.test(fnBody(main, 'writePatConfig')));
    assert.ok(/if \(mode === 'varafm'\) return `VARA FM is not answering/.test(fnBody(main, 'winlinkTransportDownText')));
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
    assert.ok(/set PTT to <b>None<\/b>/.test(html) && /Without a licence VARA runs at reduced speed/.test(html));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
