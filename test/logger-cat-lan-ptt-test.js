'use strict';
// #770: an outside program keyed over Logger CAT on the Yaesu SCU-LAN10.
// Casey's four conditions, one block each: the VFO button's path, a hard
// transmit timeout, release on disconnect, off by default.
const assert = require('assert');
const net = require('net');
const path = require('path');
const { readSrc } = require('./_src');
const { LoggerCatLanPtt } = require('../lib/logger-cat-lan-ptt');
const T = require('../lib/ts2000-cat-server');
let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

// A fake world: the window's presses, the log, a timer the test fires by hand.
function rig({ enabled = true, window = true, maxMs = 180000 } = {}) {
  const w = { presses: [], logs: [], timers: [], enabled, window };
  w.ptt = new LoggerCatLanPtt({
    enabled: () => w.enabled,
    press: (on) => { if (on && !w.window) return false; w.presses.push(on); return true; },
    log: (l) => w.logs.push(l),
    maxMs: () => maxMs,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; w.timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  });
  w.fire = () => { const t = w.timers.find((x) => x.live); assert.ok(t, 'a timer is running'); t.live = false; t.fn(); };
  return w;
}

(async () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const vfo = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
  const preload = readSrc(path.join(__dirname, '..', 'preload-vfo-popout.js'));

  // ---- 1. Same PTT path and checks as the VFO button ----------------------
  {
    const w = rig();
    assert.strictEqual(w.ptt.key(true, 'A'), true);
    assert.strictEqual(w.ptt.key(false, 'A'), false);
    assert.deepStrictEqual(w.presses, [true, false], 'key-down and release are the window\'s presses');
    const w2 = rig({ window: false });
    assert.strictEqual(w2.ptt.key(true, 'A'), false, 'no VFO window: refused');
    assert.ok(/open the VFO window/.test(w2.logs[0]));
    assert.strictEqual(w2.ptt.keyed, false);
  }
  // The window's handler is the button's own pttStart/pttStop: the same mic,
  // the same nakedPtt → yaesuLanVoicePtt → handleRemotePtt refusals (SWR guard,
  // licence class and Guest Pass, LAN owner such as JTCAT, Tune or Winlink).
  assert.ok(/window\.api\.onExternalPtt\(\(d\) => \{ if \(d && d\.on\) pttStart\(\); else pttStop\(\); \}\);/.test(vfo), 'the window presses its own PTT');
  assert.ok(/pttBtn\.addEventListener\('mousedown', \(e\) => \{ e\.preventDefault\(\); pttStart\(\); \}\);/.test(vfo), 'the button uses the same pttStart');
  assert.ok(/onExternalPtt: \(cb\) => ipcRenderer\.on\('external-ptt', \(_e, d\) => cb\(d\)\),/.test(preload));
  const lanBlock = main.slice(main.indexOf('const _loggerCatLan = new LoggerCatLanPtt('), main.indexOf('function loggerCatState('));
  assert.ok(/webContents\.send\('external-ptt', \{ on, who: 'logger CAT' \}\)/.test(lanBlock), 'presses go to the VFO window');
  assert.ok(!/handleRemotePtt\(true|startVoiceTx/.test(lanBlock), 'no key-down of its own');
  assert.ok(/if \(yaesuLanVoiceRoute\(\)\) \{ _loggerCatLan\.key\(a\.ptt, client\); return; \}/.test(main), 'Logger CAT on the LAN goes through the module');
  ok('1. a key-down is the VFO window\'s own PTT press, refused without the window');

  // ---- 2. A hard transmit timeout -----------------------------------------
  {
    const w = rig({ maxMs: 180000 });
    w.ptt.key(true, 'A');
    assert.strictEqual(w.timers[0].ms, 180000);
    w.fire();
    assert.deepStrictEqual(w.presses, [true, false], 'released at the limit');
    assert.strictEqual(w.ptt.keyed, false);
    assert.ok(/on air longer than 180 s \(PTT Safety Timeout\) — PTT released/.test(w.logs.join('\n')), 'and says why');
    assert.strictEqual(w.ptt.key(true, 'A'), false, 'the stuck program cannot key straight back');
    assert.ok(/hit the transmit time limit/.test(w.logs[w.logs.length - 1]));
    w.ptt.key(false, 'A');
    assert.strictEqual(w.ptt.key(true, 'A'), true, 'after its PTT off it may key again');
    assert.strictEqual(w.timers.filter((t) => t.live).length, 1, 'with a fresh limit');
    w.ptt.key(false, 'A');
    assert.strictEqual(w.timers.filter((t) => t.live).length, 0, 'a release stops the timer');
  }
  assert.ok(/maxMs: \(\) => \(Number\(settings\.remotePttTimeout\) \|\| 180\) \* 1000/.test(main), 'the limit is the PTT Safety Timeout, 180 s by default');
  ok('2. released after the PTT Safety Timeout, logged, no re-key until PTT off');

  // ---- 3. Release on disconnect -------------------------------------------
  {
    const w = rig();
    w.ptt.key(true, 'A');
    w.ptt.disconnect('B');
    assert.strictEqual(w.ptt.keyed, true, 'another program closing does not release');
    w.ptt.key(false, 'B');
    assert.strictEqual(w.ptt.keyed, true, 'nor does its PTT off');
    assert.strictEqual(w.ptt.key(true, 'B'), false, 'one program keys at a time');
    w.ptt.disconnect('A');
    assert.deepStrictEqual(w.presses, [true, false]);
    assert.ok(/disconnected while transmitting — PTT released/.test(w.logs.join('\n')));
    assert.strictEqual(w.timers.filter((t) => t.live).length, 0);
    w.ptt.key(true, 'A'); w.ptt.stop('the VFO window closed');
    assert.deepStrictEqual(w.presses, [true, false, true, false], 'the window closing releases too');
  }
  // Over a real socket: the connection that sent TX; closes → released at once.
  {
    const w = rig();
    const srv = T.createTs2000Server({
      getState: () => ({ freqHz: 14074000, mode: 'DIGU', ptt: w.ptt.keyed, smeter: 0, powerW: 10, wpm: 20 }),
      onAction: (a, sock) => { if (typeof a.ptt === 'boolean') w.ptt.key(a.ptt, sock); },
      onClient: (sock) => sock.on('close', () => w.ptt.disconnect(sock)),
    }, { host: '127.0.0.1', port: 0 });
    await new Promise((r) => srv.on('listening', r));
    const port = srv.address().port;
    const open = () => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => r(s)); });
    const a = await open(), b = await open();
    a.write('TX;');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(w.ptt.keyed, true);
    b.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(w.ptt.keyed, true, 'the other connection dropping leaves it');
    a.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(w.ptt.keyed, false, 'the keying connection dropping releases');
    assert.deepStrictEqual(w.presses, [true, false]);
    srv.close();
  }
  assert.ok(/hooks\.onAction\(r\.action, sock\)/.test(readSrc(path.join(__dirname, '..', 'lib', 'ts2000-cat-server.js'))), 'the server says which connection');
  assert.ok(/sock\.on\('close', \(\) => \{[\s\S]{0,200}_loggerCatLan\.disconnect\(sock\);/.test(main), 'main releases on that connection\'s close');
  assert.ok(/function stopLoggerCat\(\) \{\s*_loggerCatLan\.stop\('Logger CAT stopped'\);/.test(main), 'stopping Logger CAT releases');
  assert.ok(/vfoPopoutWin = null;\s*_loggerCatLan\.stop\('the VFO window closed'\);/.test(main), 'the window closing releases');
  assert.ok(/if \(on\) return false;\s*\/\/[^\n]*\n\s*yaesuLanVoicePtt\(false, 'logger CAT', 'vfo'\);/.test(lanBlock), 'without the window the release still reaches the radio');
  ok('3. the keying program\'s connection dropping releases at once; others do not');

  // ---- 4. Off by default --------------------------------------------------
  {
    const w = rig({ enabled: false });
    assert.strictEqual(w.ptt.key(true, 'A'), false);
    assert.deepStrictEqual(w.presses, [], 'nothing pressed');
    assert.ok(/is off\. Turn it on in Settings/.test(w.logs[0]));
  }
  assert.ok(/enabled: \(\) => settings\.loggerCatLanTx === true,/.test(main), 'only an explicit true turns it on (missing = off)');
  assert.ok(/has\('loggerCatLanTx'\) && newSettings\.loggerCatLanTx !== true\) _loggerCatLan\.stop\(/.test(main), 'turning it off releases');
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(/<input type="checkbox" id="set-logger-cat-lan-tx">/.test(html), 'a setting, unchecked in the page');
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(/lt\.checked = s\.loggerCatLanTx === true;/.test(app), 'shown unchecked unless saved on');
  assert.ok(/loggerCatLanTx: document\.getElementById\('set-logger-cat-lan-tx'\)\.checked/.test(app), 'saved from the checkbox');
  ok('4. off by default: refused until the operator turns it on');

  console.log(`Logger CAT LAN PTT: ${n} passed, 0 failed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
