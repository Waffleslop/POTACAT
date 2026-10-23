// Source guards for the Winlink integration (docs/winlink-integration-plan.md).
// The pure modules have their own tests; these pin the invariants that live
// in main.js / remote-server.js / packaging and would otherwise rot:
//   - a radio session starts only from an operator's Connect (never a timer);
//   - Pat and ardopcf never get flags that answer or key unattended;
//   - PTT from Pat goes through handleRemotePtt; the shim is loopback-only;
//   - the mailbox is the owner's (Guest Pass refused, no hydration);
//   - the password is a registered secret; shutdown unkeys before CAT goes.
// Run: node test/winlink-main-wiring-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const server = read('lib/remote-server.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  // The body starts at ") {" — a destructured parameter list has its own braces.
  let depth = 0, j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

console.log('operating rules');
test('the internet auto-check can only start a telnet session', () => {
  const body = fnBody(main, 'winlinkArmAutoCheck');
  const calls = body.match(/winlinkStartSession\(\{[^}]*\}/g) || [];
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(/mode: 'telnet'/.test(c), c);
});
test('winlinkStartSession is reached only from Connect paths and the auto-check', () => {
  const callers = main.split('\n').filter((l) => /winlinkStartSession\(/.test(l) && !/function winlinkStartSession/.test(l));
  const allowed = [/origin: 'mail window'/, /origin: 'ECHOCAT device'/, /mode: 'telnet', origin: 'auto-check/];
  for (const l of callers) assert.ok(allowed.some((r) => r.test(l)), 'unexpected caller: ' + l.trim());
});
test('Pat never gets --listen / --send-only; ardopcf never gets a PTT or CAT flag', () => {
  const { buildPatArgs } = require('../lib/winlink-pat');
  assert.ok(!buildPatArgs({ configPath: 'x' }).some((a) => /listen|send-only/.test(a)));
  assert.ok(!/--listen|'-l'/.test(fnBody(main, 'spawnPat')));
  const { FORBIDDEN_FLAGS } = require('../lib/ardop-process');
  const spawnArdop = fnBody(main, 'spawnArdop') + fnBody(main, 'spawnArdopSocket');
  for (const f of FORBIDDEN_FLAGS) assert.ok(!spawnArdop.includes(`'${f}'`), f);
  assert.ok(/ArdopProcess\.buildArdopArgs\(/.test(spawnArdop), 'args come from the guarded builder');
  assert.ok(/return spawnArdopSocket\(\);/.test(fnBody(main, 'spawnArdop')), 'the one launch path is the socket one');
});

test('Dire Wolf\'s config comes from the guarded builder and keys through the shim port', () => {
  const sd = fnBody(main, 'spawnDirewolf');
  assert.ok(/DirewolfProcess\.buildDirewolfConfig\(/.test(sd) && /shimPort: _winlinkShimPort/.test(sd));
  assert.ok(!/PTT (COM|RTS|DTR|GPIO|VOX)/i.test(sd));
});

test('both modems take their audio from POTACAT at their own rate; neither picks a sound device', () => {
  // One readiness path for every socket-audio modem: the server at the modem's
  // rate, the radio's audio link up, the bridge window holding both devices.
  const ready = fnBody(main, 'winlinkModemAudioReady');
  assert.ok(/winlinkAudio\.modemRate !== modemRate\) await startWinlinkAudio\(\{ modemRate \}\)/.test(ready), 'the server is rebuilt when the next modem wants another rate');
  assert.ok(/if \(!winlinkIpAudioRoute\(\)\) \{[\s\S]*?modemBridgeReady\(10000\)[\s\S]*?throw new Error\(modemBridge\.error/.test(ready), 'waits for the bridge and fails with its reason');
  const ardop = fnBody(main, 'spawnArdopSocket');
  assert.ok(/winlinkModemAudioReady\(\{ modemRate: ModemAudioServerMod\.MODEM_RATE, modemName: 'ardop' \}\)/.test(ardop), 'ardopcf at 12 kHz');
  const dw = fnBody(main, 'spawnDirewolf');
  assert.ok(/winlinkModemAudioReady\(\{ modemRate: DirewolfProcess\.DIREWOLF_RATE, modemName: 'direwolf' \}\)/.test(dw), 'Dire Wolf at its ARATE');
  assert.ok(/audioPort: winlinkAudio\.port/.test(dw), 'Dire Wolf gets the socket, not device names');
  for (const fn of ['spawnArdop', 'spawnArdopSocket', 'spawnDirewolf']) {
    const b = fnBody(main, fn);
    assert.ok(!/resolveArdopDevices\(|listArdopDevices\(|proposeArdopDevices\(|winlinkAutoAudio\(/.test(b), fn + ' never resolves a sound device');
  }
  assert.ok(!/has no macOS build/.test(main), 'the macOS refusal is gone from main (both modems build there now)');
  assert.ok(/m\.id === 'ardop' \|\| m\.id === 'packet'/.test(fnBody(main, 'modemBridgeWanted')), 'the bridge serves packet as well as ARDOP');
  // The old operator-facing pick survives only for the hand-built-modem IPC and keeps its rig key.
  assert.ok(/ArdopProcess\.proposeArdopDevices\(/.test(fnBody(main, 'winlinkAutoAudio')));
  assert.ok(/const SETUP_KEYS = \[[^\]]*'winlinkAudio'/.test(main), 'a pick saved by main survives the main window\'s older rig list');
});

test('PTT off waits for the modem\'s last samples to clear POTACAT\'s pipeline; the session end does not wait', () => {
  const shim = fnBody(main, 'startWinlinkShim');
  assert.ok(/if \(!on\) \{[\s\S]*?_winlinkUnkeyTimer = setTimeout\(\(\) => \{ _winlinkUnkeyTimer = null; winlinkUnkeyNow\(\); \}, winlinkUnkeyDrainMs\(\)\)/.test(shim), 'PTT off is deferred by the drain time');
  assert.ok(/getPtt: \(\) => winlinkTxActive && !_winlinkUnkeyTimer/.test(shim), 'the shim reports the REQUESTED PTT (Hamlib re-reads it after a set)');
  assert.ok(/if \(_winlinkUnkeyTimer\) \{[\s\S]*?clearTimeout\(_winlinkUnkeyTimer\); _winlinkUnkeyTimer = null;[\s\S]*?armWinlinkTxFailsafe\(\)/.test(shim), 'keyed again inside the hold stays keyed');
  const now = fnBody(main, 'winlinkUnkeyNow');
  assert.ok(/clearWinlinkTxFailsafe\(\)/.test(now) && /handleRemotePtt\(false\)/.test(now));
  assert.ok(/clearTimeout\(_winlinkUnkeyTimer\)/.test(fnBody(main, 'winlinkEndSession')), 'session end unkeys at once');
  assert.ok(/const WINLINK_UNKEY_DRAIN_BRIDGE_MS = 250;/.test(main) && /const WINLINK_UNKEY_DRAIN_IP_MS = 120;/.test(main));
  // The modems pace themselves like a sound card and wait out their own clock before asking for PTT off.
  const dwTcp = read('third_party/direwolf/src/audio_tcp.c');
  assert.ok(/TCPAUDIO_LEAD_MS/.test(dwTcp) && /void tcpaudio_wait \(void\)/.test(dwTcp), 'Dire Wolf backend paces and drains');
  const patch = read('third_party/direwolf/potacat-socket-audio.patch');
  for (const f of ['src/audio.c', 'src/audio_win.c', 'src/audio_portaudio.c']) {
    assert.ok(patch.includes(`+++ b/${f}`), `${f} is hooked`);
  }
  assert.strictEqual((patch.match(/\+\s*tcpaudio_wait \(\);/g) || []).length, 3, 'audio_wait drains on all three backends');
  assert.ok(patch.includes('+  audio_tcp.c') && patch.includes('+	AUDIO_IN_TYPE_TCP };'), 'source list and enum');
});

test('the macOS modem builds: ardopcf against the ALSA stand-in, Dire Wolf with the socket patch, bundled and arch-checked', () => {
  const script = read('scripts/build-winlink-helpers.sh');
  assert.ok(/make ardopcf CC=cc CFLAGS="-g -MMD -std=gnu17 -I\$ROOT\/helpers\/alsa-stub" LDFLAGS="" LDLIBS="-lm -lpthread"/.test(script), 'mac ardopcf: stub include, no -lasound, no GNU-ld map flag');
  assert.ok(/git -C "\$WORK\/direwolf" apply --ignore-whitespace "\$ROOT\/third_party\/direwolf\/potacat-socket-audio\.patch"/.test(script), 'Dire Wolf gets the socket patch');
  assert.ok(/cp "\$ROOT\/third_party\/direwolf\/src\/audio_tcp\.c" "\$ROOT\/third_party\/direwolf\/src\/audio_tcp\.h" "\$WORK\/direwolf\/src\/"/.test(script));
  assert.ok(/sed -i\.bak 's\/\[ \\t\]\*\$\/\/' src\/audio\.c src\/audio_win\.c src\/audio_portaudio\.c src\/audio\.h src\/CMakeLists\.txt/.test(script), 'trailing blanks stripped the way the generator did');
  assert.ok(!/no macOS build|not built on macOS yet/.test(script), 'no macOS skip left');
  assert.ok(/bundle-mac-deps\.js" --expect-arch="\$\(uname -m\)" "\$OUT\/direwolf"/.test(script), 'Dire Wolf dylibs bundled and arch-checked');
  assert.ok(/otool -L "\$OUT\/direwolf" \| grep -qi 'libhamlib'/.test(script), 'the mac build still refuses a Dire Wolf without Hamlib');
  const stub = read('helpers/alsa-stub/alsa/asoundlib.h');
  for (const sym of ['snd_pcm_open', 'snd_pcm_readi', 'snd_pcm_writei', 'snd_card_next', 'snd_pcm_hw_params_set_rate', 'snd_strerror']) assert.ok(stub.includes(sym + '('), sym);
  assert.ok(!/snd_pcm_open[\s\S]{0,200}return 0;/.test(stub), 'opening a device always fails cleanly');
  const rel = read('.github/workflows/release.yml');
  assert.strictEqual((rel.match(/bash scripts\/build-winlink-helpers\.sh pat ardop direwolf/g) || []).length, 4, 'all four non-Windows release jobs build both modems (Windows builds them in two steps)');
  assert.ok(/brew install portaudio hidapi/.test(rel), 'the mac jobs install what Dire Wolf\'s CMake requires');
  const pkg = JSON.parse(read('package.json'));
  const dw = pkg.build.extraResources.find((r) => r.from === 'assets/direwolf');
  assert.ok(dw && dw.filter.includes('*.dylib'), 'the mac dylibs ship beside direwolf');
  const helpers = read('.github/workflows/winlink-helpers.yml');
  assert.ok(/brew install portaudio hidapi hamlib/.test(helpers) && /pat ardop direwolf/.test(helpers.split('mac:')[1] || ''), 'the helper workflow builds both on macOS');
  assert.ok(/'scripts\/gen-direwolf-patch\.py'/.test(helpers) && /'helpers\/alsa-stub\/\*\*'/.test(helpers), 'and reruns when the patch generator or stub changes');
});

test('a Flex keys the modem\'s DAX audio, not the silent mic, and gets its mic back', () => {
  assert.ok(/winlinkFlexDaxOn\(\);/.test(fnBody(main, 'winlinkStartSession')));
  assert.ok(/winlinkFlexDaxRestore\(\);/.test(fnBody(main, 'winlinkEndSession')));
  const on = fnBody(main, 'winlinkFlexDaxOn');
  assert.ok(/_sendFlexTxDax\(true\)/.test(on) && !/claimTxStream/.test(on), 'sets dax=1 but never takes the DAX program\'s stream');
});

test('modem audio rides POTACAT\'s radio link on Flex Direct / Icom Network — no DAX', () => {
  assert.ok(/winlinkFeedRx\(pcm, sampleRate\)/.test(main.slice(main.indexOf("smartSdrAudio.on('audio-frame'"), main.indexOf("smartSdrAudio.on('audio-frame'") + 300)), 'Flex dax_rx frames feed the modem');
  assert.ok(/if \(!meta\.silence\) winlinkFeedRx\(pcm, sampleRate\)/.test(fnBody(main, 'handleIcomNetworkPacedRxFrame')), 'Icom paced frames feed the modem');
  const sock = fnBody(main, 'spawnArdopSocket');
  assert.ok(/capture: dev, playback: dev/.test(sock) && /tcp:\$\{winlinkAudio\.port\}/.test(fnBody(main, 'winlinkModemAudioReady')), 'ardopcf gets tcp:<port> for both devices');
  assert.ok(/return spawnArdopSocket\(\); \/\/ every rig/.test(fnBody(main, 'spawnArdop')), 'ardopcf is always on the socket');
  const tx = fnBody(main, 'startWinlinkAudio');
  assert.ok(/if \(!winlinkTxActive\) return;/.test(tx) && /pushTxAudioChunk\(mono24k\)/.test(tx) && /pushIcomNetworkVoiceChunk\(mono24k\)/.test(tx), 'modem TX goes to dax_tx / RS-BA1 only while keyed');
  assert.ok(/icomNetworkVoiceTx\(true, 'Winlink'\)/.test(fnBody(main, 'startWinlinkShim')), 'Icom voice TX opens with the key-down');
  assert.ok(/new ModemAudioServer\(/.test(tx) && /listen\(0\)/.test(tx));
});

test('a gateway pick tunes the radio only outside a session, and the dial goes back', () => {
  const q = fnBody(main, 'winlinkPreviewQsy');
  assert.ok(/if \(winlinkSessionActive\(\)\) return \{ ok: false/.test(q));
  assert.ok(/if \(isRemoteMode\(\)\) return \{ ok: false/.test(q));
  assert.ok(/tuneRadio\(khz, mode === 'packet' \? 'FM' : 'DIGU'/.test(q));
  assert.ok(/returnTo: radio \? \(_winlinkPreviewReturnTo \|\|/.test(fnBody(main, 'winlinkStartSession')), 'the session returns to the pre-pick dial');
  assert.ok(/winlinkPreviewRestore\('window closed'\)/.test(main), 'closing the window with no session puts the dial back');
});

test('the mail window acknowledges audio frames, or main pauses the waterfall every 120 frames', () => {
  const pre = read('preload-winlink-popout.js');
  assert.ok(/ipcRenderer\.send\('audio-ack', \{ channel: 'winlink-audio-frame', count: _ackCount \}\)/.test(pre));
  assert.ok(/setInterval\(flush, \d+\)/.test(pre), 'a periodic flush so a slow handler cannot freeze the credit');
});

console.log('radio control');
test('the shim binds loopback and keys through handleRemotePtt with audio', () => {
  const shim = fnBody(main, 'startWinlinkShim');
  assert.ok(/createRigctldServer\(/.test(shim) && /host: '127\.0\.0\.1'/.test(shim));
  assert.ok(/handleRemotePtt\(true, \{ audio: true, forceDataMode: icom \}\)/.test(shim));
  assert.ok(/radioOwner !== 'winlink'/.test(shim), 'refuses outside a session');
  assert.ok(/_swrTripped/.test(shim), 'honours the SWR latch');
  assert.ok(/armWinlinkTxFailsafe\(\)/.test(shim), 'arms the failsafe on key-down');
});
test('a radio session takes the radio owner and gives it back', () => {
  assert.ok(/acquireRadio\('winlink'\)/.test(fnBody(main, 'winlinkStartSession')));
  assert.ok(/releaseRadio\('winlink'\)/.test(fnBody(main, 'winlinkEndSession')));
  assert.ok(/d\.preempted === 'winlink'\) winlinkAbortSession/.test(main));
  assert.ok(require('../lib/radio-owner').OWNERS.includes('winlink'));
});
test('shutdown ends the session before the CAT link goes', () => {
  const g = fnBody(main, 'gracefulCleanup');
  const w = g.indexOf('disconnectWinlink({ quit: true })');
  const r = g.indexOf('killRigctld();');
  assert.ok(w > 0 && r > 0 && w < r);
});

console.log('owner only');
test('every winlink-* request refuses a Guest Pass before main hears it', () => {
  const i = server.indexOf("case 'winlink-list':");
  const block = server.slice(i, server.indexOf('break;', server.indexOf("this.emit('winlink-request'", i)));
  assert.ok(/if \(ws\._passSession\) \{ this\._sendTo\(ws, \{ type: 'winlink-refused', reason: 'guest-pass'/.test(block));
  const proto = require('../lib/echocat-protocol');
  const c2s = Object.keys(proto.MESSAGES).filter((t) => t.startsWith('winlink-') && proto.MESSAGES[t].dir === 'c2s');
  for (const t of c2s) assert.ok(server.includes(`case '${t}':`), `${t} is in the guarded block`);
});
test('pushes and hydration skip Guest Pass sockets', () => {
  assert.ok(/_sendToOwners\(obj\) \{\n\s+for \(const c of this\._openClients\(\)\) if \(!c\._passSession\)/.test(server));
  assert.ok(/_sendWinlinkHydration\(ws\) \{\n\s+if \(!ws \|\| ws\._passSession/.test(server));
  assert.ok(server.includes("'winlink',"), 'hello capability');
});
test('the remote listener is attached through onRemoteServer', () => {
  assert.ok(/onRemoteServer\(\(rs\) => \{\n\s+rs\.on\('winlink-request'/.test(main));
});

console.log('secrets + packaging');
test('the Winlink password is a registered secret; machine paths are global', () => {
  assert.ok(require('../lib/settings-secrets').SECRET_KEYS.includes('winlinkPassword'));
  for (const k of ['winlinkPatPath', 'winlinkArdopPath', 'winlinkArdopPort', 'winlinkVaraPort']) assert.ok(main.includes(`'${k}',`), k);
  assert.ok(/mode: 0o600/.test(fnBody(main, 'writePatConfig')), 'pat-config.json written owner-only');
});
test('Pat and ardopcf are packaged, attributed and pinned', () => {
  const pkg = JSON.parse(read('package.json'));
  const from = pkg.build.extraResources.map((r) => r.from);
  assert.ok(from.includes('assets/pat') && from.includes('assets/ardopcf'));
  const notice = read('NOTICE');
  assert.ok(/Pat \(Winlink client\)/.test(notice) && /ardopcf \(ARDOP modem\)/.test(notice));
  const script = read('scripts/build-winlink-helpers.sh');
  const ver = (f) => read(f).split('\n')[1].replace('commit ', '').trim();
  assert.ok(script.includes(`PAT_SHA=${ver('third_party/pat/VERSION.txt')}`), 'Pat pin matches VERSION.txt');
  assert.ok(script.includes(`ARDOP_SHA=${ver('third_party/ardopcf/VERSION.txt')}`), 'ardopcf pin matches VERSION.txt');
  assert.ok(script.includes(`DIREWOLF_SHA=${ver('third_party/direwolf/VERSION.txt')}`), 'Dire Wolf pin matches VERSION.txt');
  assert.ok(from.includes('assets/direwolf') && /Dire Wolf \(AX\.25 packet software TNC\)/.test(notice));
  assert.ok(/ldd "\$OUT\/direwolf\$EXE" \| grep -qi 'libhamlib'/.test(script), 'the build refuses a Dire Wolf without Hamlib');
  assert.ok(read('.github/workflows/release.yml').split('build-winlink-helpers.sh').length > 5, 'every release job builds them');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

console.log('power and SWR in the mail window');
test('the mail window gets the RF power setting, forward power and SWR, and sets power through rig-control', () => {
  // The same payload the JTCAT window gets, pushed from broadcastRigState and on load.
  assert.ok(/function pushWinlinkRigPower\(force\)[\s\S]*jtcatPopoutRigPowerPayload\(\)[\s\S]*'winlink-rig-power'/.test(main));
  assert.ok(/pushJtcatPopoutRigPower\(\);\n\s*pushWinlinkRigPower\(\);/.test(main), 'pushed beside the JTCAT window\'s');
  assert.ok(/pushWinlinkRigPower\(true\);/.test(main), 'pushed on did-finish-load');
  for (const ch of ['cat-fwd-power', 'cat-swr', 'cat-swr-ratio']) {
    assert.ok(main.includes(`winlinkPopoutWin.webContents.send('${ch}'`), `${ch} reaches the mail window`);
  }
  const pre = read('preload-winlink-popout.js');
  assert.ok(/rigControl: \(d\) => ipcRenderer\.invoke\('rig-control', d\)/.test(pre), 'power is set through the ONE dispatcher');
  const popout = read('renderer/winlink-popout.js');
  assert.ok(/action: 'set-tx-power'/.test(popout));
  assert.ok(/onCatSwrRatio/.test(popout) && /onCatFwdPower/.test(popout));
  // Position and size: saved on move/resize as well as close.
  assert.ok(/winlinkPopoutWin\.on\('resize', saveWinlinkBounds\);\n\s*winlinkPopoutWin\.on\('move', saveWinlinkBounds\);/.test(main));
  assert.ok(/settings\.winlinkPopoutBounds = winlinkPopoutWin\.getBounds\(\); saveSettings\(settings\);/.test(main));
});

console.log('waterfall for ECHOCAT devices');
test('winlink-watch subscribes a device; the shack computes bins and the Busy verdict and pushes winlink-spectrum', () => {
  const proto = require('../lib/echocat-protocol');
  assert.ok(proto.MESSAGES['winlink-watch'] && proto.MESSAGES['winlink-spectrum'], 'both on the wire');
  const server = read('lib/remote-server.js');
  assert.ok(/case 'winlink-watch':[\s\S]*?ws\._passSession[\s\S]*?winlink-refused/.test(server), 'a Guest Pass never sees the shack audio');
  assert.ok(/broadcastWinlinkSpectrum\(frame\)[\s\S]*?bufferedAmount > 8192\) continue/.test(server), 'frames are dropped, never queued');
  assert.ok(/_onClientGone\(ws\) \{\n\s*const watchedWinlink = !!ws\._winlinkWatch;/.test(server), 'a vanished watcher is recounted');
  assert.ok(/rs\.on\('winlink-watch', \(\{ count \} = \{\}\) => winlinkSetRemoteWatch\(count\)\);/.test(main), 'wired inside onRemoteServer');
  assert.ok(/function winlinkSpectrumPublish\(mags\)[\s\S]*?WinlinkSpectrum\.busyVerdict\(mags, band\.lo, band\.hi, _winlinkBusySt, now\)[\s\S]*?broadcastWinlinkSpectrum\(\{ bins: WinlinkSpectrum\.wireBins\(mags\), busy: v\.busy/.test(main), 'the verdict is decided on the shack');
  assert.ok(/if \(_winlinkRemoteWatchers > 0\) winlinkSpecAcc\(\)\.push\(pcm, sampleRate\);/.test(main), 'fed from the socket routes only while watched');
  assert.ok(/winlink-spectrum-mags[\s\S]*?winlinkSocketAudioRoute\(\)\) return;/.test(main), 'the window relays only on a sound-device rig');
});

console.log('SWR guard');
test('an SWR-guard trip aborts a running Winlink session with the reason in session.error', () => {
  const trip = fnBody(main, 'tripSwrGuard');
  assert.ok(/if \(winlinkSessionActive\(\)\) winlinkAbortSession\(`SWR \$\{swr\.toFixed\(1\)\}:1/.test(trip), 'tripSwrGuard stops the session');
  assert.ok(/_winlinkSessionError = `Stopped: \$\{why\}`;/.test(fnBody(main, 'winlinkAbortSession')), 'the reason reaches session.error');
});

test('the session-end dial restore and Pat\'s QSX wait for a running ATU tune; the guard counts every frame', () => {
  const restore = fnBody(main, 'winlinkRestoreDial');
  assert.ok(/if \(_atuTuneEpisode && waitedMs < 30000\)/.test(restore), 'held while the episode runs');
  assert.ok(/setTimeout\(\(\) => winlinkRestoreDial\(s\.returnTo\), 1500\);/.test(main), 'winlinkEndSession restores through it');
  const shim = fnBody(main, 'startWinlinkShim');
  assert.ok(/if \(_atuTuneEpisode && Math\.abs\(hz - \(_currentFreqHz \|\| 0\)\) > 100\)/.test(shim), 'the shim holds a QSY under a tune');
  assert.ok(/g\.suppressed\+\+/.test(main) && /SWR guard did not trip:/.test(main), 'the RF summary says why the guard stayed quiet');
});

console.log('the account from a device');
test('account check / set-password / register / recovery email are on the wire, demuxed, handled, and never echo the password', () => {
  const proto = require('../lib/echocat-protocol');
  for (const t of ['winlink-account-check', 'winlink-set-password', 'winlink-register', 'winlink-recovery-email-get', 'winlink-recovery-email-set', 'winlink-account', 'winlink-recovery-email']) {
    assert.ok(proto.MESSAGES[t], t + ' registered');
    assert.strictEqual(proto.MESSAGES[t].feature, 'winlink');
  }
  const server = read('lib/remote-server.js');
  for (const t of ['winlink-account-check', 'winlink-set-password', 'winlink-register', 'winlink-recovery-email-get', 'winlink-recovery-email-set']) {
    assert.ok(server.includes(`      case '${t}':`), t + ' demuxed with the other winlink-* (Guest Pass refusal first)');
    assert.ok(main.includes(`      case '${t}'`), t + ' handled in winlinkHandleRemote');
  }
  assert.ok(/'winlink-account',/.test(server), 'hello capability');
  // The password is saved and never said back.
  const fns = ['winlinkSetPassword', 'winlinkRegister'].map((n) => fnBody(main, n)).join('\n');
  assert.ok(!/winlinkLog\([^)]*\bpw\b/.test(fns), 'no log line carries the password');
  assert.ok(!/password: settings\.winlinkPassword/.test(fnBody(main, 'winlinkPayload')), 'winlink-state carries hasPassword only');
  assert.ok(/hasPassword: !!settings\.winlinkPassword/.test(fnBody(main, 'winlinkPayload')));
  // Settings IPC and the device share one implementation.
  assert.ok(/ipcMain\.handle\('winlink-register', \(_e, o = \{\}\) => winlinkRegister\(o, (\(o && o\.origin\) \|\| )?'Settings'\)\);/.test(main));
  // session.errorKind rides beside the text.
  assert.ok(/errorKind: state === 'error' \? \(_winlinkSessionErrorKind \|\| 'failed'\) : ''/.test(main));
  assert.ok(/_winlinkSessionErrorKind = 'login-failed'/.test(main));
});

console.log('the release announcement');
test('What\'s New carries the Winlink card once per profile, with a working opt-in checkbox', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  assert.ok(/id="whats-new-feature"/.test(html) && /id="whats-new-winlink-settings"/.test(html) && !/whats-new-winlink-enable/.test(html));
  assert.ok(/Over the internet:<\/b> Windows, Linux and Mac/.test(html) && /Over the radio \(ARDOP\):<\/b> Windows and Linux/.test(html), 'the platform claim is exactly what ships');
  const fn = fnBody(app, 'renderWinlinkAnnounce');
  assert.ok(/if \(s\.winlinkAnnounced\)/.test(fn), 'once per profile');
  assert.ok(/saveSettings\(\{ winlinkAnnounced:/.test(fn), 'stamped when shown');
  assert.ok(!/enableWinlink/.test(fn), 'no opt-in: Winlink is always available');
  assert.ok(/await renderWinlinkAnnounce\(\);\n\s*dialog\.showModal\(\);/.test(app), 'rendered before the dialog opens');
  // A partial save of enableWinlink must start Pat (the save handler's relaunch gate).
  assert.ok(/const winlinkChanged = \['enableWinlink'/.test(main));
});

test('Winlink is always available and Pat starts on first use', () => {
  assert.ok(!/settings\.enableWinlink/.test(main), 'no code path in main is gated on enableWinlink');
  assert.ok(/enabled: true,\n\s*patStarted: !!patClient,/.test(fnBody(main, 'winlinkPayload')));
  assert.ok(/ipcMain\.on\('winlink-popout-open', \(\) => \{ openWinlinkPopout\(\); winlinkEnsureStarted\(\); \}\);/.test(main), 'the mail window starts it');
  assert.ok(/if \(type !== 'winlink-watch'\) winlinkEnsureStarted\(\);/.test(fnBody(main, 'winlinkHandleRemote')), 'a device request starts it');
  assert.ok(/if \(settings\.winlinkPassword\) connectWinlink\(\);/.test(main), 'an account holder has it running from launch');
  for (const f of ['winlinkAccountCheck', 'winlinkSetPassword', 'winlinkRegister', 'winlinkStartSession']) {
    assert.ok(/await winlinkEnsureStarted\(\)/.test(fnBody(main, f)), f + ' starts Pat first');
  }
});

console.log('account setup in the mail window and the web Mail tab');
test('with no Winlink password, the mail window and the web Mail tab offer check / create / save right there', () => {
  const html = read('renderer/winlink-popout.html');
  const js = read('renderer/winlink-popout.js');
  const pre = read('preload-winlink-popout.js');
  assert.ok(/id="wl-acct-card"/.test(html) && /id="wl-acct-go"/.test(html));
  assert.ok(/var need = !!\(s && s\.patReady && !s\.hasPassword\);/.test(js), 'shown until the shack has a password');
  assert.ok(/window\.api\.register\(\{ password: pw, recoveryEmail:/.test(js) && /window\.api\.setPassword\(pw\)/.test(js));
  assert.ok(/setPassword: \(pw\) => ipcRenderer\.invoke\('winlink-cmd-set-password', pw\)/.test(pre));
  assert.ok(/ipcMain\.handle\('winlink-cmd-set-password', \(_e, pw\) => winlinkSetPassword\(pw, 'mail window'\)\);/.test(main));
  const web = read('renderer/remote.js');
  assert.ok(/mailSend\(\{ type: 'winlink-account-check' \}\)/.test(web) && /mailSend\(\{ type: 'winlink-register', password: pw/.test(web) && /mailSend\(\{ type: 'winlink-set-password', password: pw \}\)/.test(web));
});

console.log('the modem audio bridge (every rig, no device picker for ARDOP)');
test('on a sound-device rig the bridge window carries the modem audio; the modem never opens a device', () => {
  assert.ok(/function winlinkSocketAudioRoute\(\) \{ return true; \}/.test(main), 'every rig is a socket rig');
  assert.ok(/function winlinkIpAudioRoute\(\)/.test(main));
  const srv = fnBody(main, 'startWinlinkAudio');
  assert.ok(/audioSafeSend\(modemBridgeWin\.webContents, 'modem-bridge-tx', \{ pcm: mono24k \}\)/.test(srv), 'TX goes to the bridge window on a sound-device rig');
  const spawn = fnBody(main, 'winlinkModemAudioReady');
  assert.ok(/if \(!winlinkIpAudioRoute\(\)\) \{[\s\S]*?modemBridgeReady\(10000\)[\s\S]*?throw new Error\(modemBridge\.error/.test(spawn), 'the session waits for the bridge and fails with its reason');
  assert.ok(/ipcMain\.on\('modem-bridge-rx'[\s\S]{0,400}winlinkFeedRx\(pcm, /.test(main), 'bridge RX feeds the server (and the waterfall)');
  assert.ok(/if \(s\.captureEnded && winlinkSessionActive\(\)\) winlinkAbortSession\(modemBridge\.error\);/.test(main), 'an unplugged device ends the session');
  assert.ok(/try \{ stopModemBridge\('quit'\); \} catch \{\}/.test(main), 'stopped at quit');
  const start = fnBody(main, 'startModemBridge');
  assert.ok(/backgroundThrottling: false/.test(start), 'a throttled worklet starves the modem');
  const page = read('renderer/modem-audio-bridge.js');
  assert.ok(/deviceId: \{ exact: c\.inputId \}/.test(page) && /microphone was NOT used/.test(page), 'the chosen device exactly, never the default mic');
  assert.ok(/playCtx\.setSinkId\(c\.outputId\)/.test(page), 'TX plays to the chosen output');
  // Nothing in the repo ships, downloads or bundles a device-opening modem path for ARDOP.
  assert.ok(!/proposeArdopDevices\(/.test(fnBody(main, 'spawnArdop')), 'no device pick for ARDOP');
});
