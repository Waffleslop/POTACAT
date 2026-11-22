#!/usr/bin/env node
'use strict';
// APRS phase 5: the beacon over APRS-IS, end to end against a local fake
// APRS-IS server (nothing reaches the real one), and as wired in main.js and
// the APRS window (source-text guards; CRLF and LF both pass).
// Run: node test/aprs-beacon-wiring-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AprsIsClient } = require('../lib/aprs-is');
const { AprsIsFeed } = require('../lib/aprs-is-feed');
const AprsParser = require('../lib/aprs-parser');
const B = require('../lib/aprs-beacon');
const { startFakeAprsIs } = require('./fixtures/fake-aprs-is-server');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return fn(); }
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};

(async () => {
  await test('end to end: the beacon goes up a verified login and comes back over the read-only feed', async () => {
    const srv = await startFakeAprsIs();
    const feed = new AprsIsFeed({ call: 'K3ABC', host: '127.0.0.1', port: srv.port, lat: 41.7, lon: -72.7, km: 150 });
    const back = [];
    feed.on('line', (l) => back.push(AprsParser.parse(l)));
    feed.start();
    const up = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    up.connect();
    await until(() => up.verified && feed.state === 'connected');
    const b = B.buildBeacon({ settingsCall: 'K3ABC', lat: 41.7123, lon: -72.6543, symbol: 'house', comment: 'POTACAT', approx: true });
    assert.ok(up.send(b.packet));
    assert.ok(await until(() => back.some((p) => p && B.isOwnBeacon(p, 'K3ABC-10'))), 'came back');
    const p = back.find((x) => x && B.isOwnBeacon(x, 'K3ABC-10'));
    assert.strictEqual(p.type, 'position');
    assert.strictEqual(p.ambiguity, 2);
    assert.strictEqual(p.symbolTable + p.symbol, '/-');
    assert.strictEqual(p.comment, 'POTACAT');
    up.disconnect(); feed.stop();
    await srv.close();
  });

  await test('an unverified login sends nothing', async () => {
    const srv = await startFakeAprsIs({ refuseVerify: true });
    const up = new AprsIsClient({ call: 'K3ABC-10', host: '127.0.0.1', port: srv.port, version: '1' });
    up.connect();
    await until(() => up.state === 'unverified');
    assert.strictEqual(up.send(B.buildBeacon({ settingsCall: 'K3ABC', lat: 41, lon: -72, approx: true }).packet), false);
    await wait(150);
    assert.strictEqual(srv.received.filter((r) => r.line[0] !== '#').length, 0);
    up.disconnect();
    await srv.close();
  });

  const main = read('main.js');
  const html = read('renderer/aprs-popout.html');

  await test('main.js: verified login only; refusals in one sentence; the one uplink', async () => {
    const send = fnBody(main, 'aprsBeaconSend');
    assert.ok(/const b = AprsBeacon\.buildBeacon\(/.test(send));
    assert.ok(/if \(!b\.ok\) \{ aprsBeaconRefuse\(b\.sentence\); return; \}/.test(send), 'no callsign, placeholder, no position');
    assert.ok(/if \(!u \|\| !u\.verified\) \{/.test(send));
    assert.ok(/did not verify the login for \$\{b\.call\}, so nothing was sent\./.test(send));
    assert.ok(send.indexOf('u.send(b.packet)') > send.indexOf('if (!u || !u.verified)'), 'sent only after the verified check');
    assert.ok(/aprsUplinkWant\('beacon', true\)/.test(send));
    assert.strictEqual((main.match(/new AprsIsClient\(/g) || []).length, 1, 'one connection');
    assert.ok(!/showMessageBox|dialog\./.test(send + fnBody(main, 'aprsBeaconRefuse')), 'no pop-ups');
  });

  await test('main.js: the timer runs only while the window is open, never under 10 minutes', async () => {
    const sch = fnBody(main, 'aprsBeaconSchedule');
    assert.ok(/const min = AprsBeacon\.intervalMinutes\(settings\.aprsBeaconIntervalMin\);/.test(sch));
    assert.ok(/if \(!aprsWin \|\| aprsWin\.isDestroyed\(\) \|\| !min\)/.test(sch));
    assert.ok(/AprsBeacon\.nextDueMs\(/.test(sch));
    assert.ok(/aprsBeaconStop\(\); \/\/ phase 5: the beacon timer runs only while the window is open/.test(main));
    assert.ok(/clearTimeout\(aprsBeacon\.timer\)/.test(fnBody(main, 'aprsBeaconStop')));
  });

  await test('main.js: a pick or an open never beacons at once, and the last beacon survives a restart (Casey 2026-11-19)', async () => {
    const sch = fnBody(main, 'aprsBeaconSchedule');
    assert.ok(/function aprsBeaconSchedule\(\{ arm = false \} = \{\}\)/.test(sch));
    assert.ok(/if \(arm\) aprsBeacon\.armedAt = Date\.now\(\);/.test(sch), 'the pick or the open is the start');
    assert.ok(/armedAt: aprsBeacon\.armedAt/.test(sch), 'the timer counts from it');
    assert.ok(/aprsBeaconSchedule\(\{ arm: true \}\); \/\/ phase 5: the timer \(if set\) starts with the window/.test(main), 'open arms');
    assert.ok(/aprsBeaconSchedule\(\{ arm: true \}\);/.test(fnBody(main, 'aprsBeaconSet')), 'a pick arms');
    const send = fnBody(main, 'aprsBeaconSend');
    assert.ok(/settings\.aprsBeaconLastAt = aprsBeacon\.lastAt;/.test(send) && /saveSettings\(settings\)/.test(send), 'persisted when sent');
    assert.ok(/aprsBeacon\.lastAt = AprsBeacon\.lastBeaconAt\(settings, Date\.now\(\)\)/.test(main), 'read back at start');
    assert.ok(/^\s*'aprsBeaconLastAt',/m.test(main), 'a machine setting');
  });

  await test('main.js: the window\'s changes are only the beacon\'s own settings keys, cleaned', async () => {
    assert.ok(/const o = AprsBeacon\.settingsPatch\(patch\);/.test(fnBody(main, 'aprsBeaconSet')));
    assert.ok(/ipcMain\.on\('aprs-beacon-set'/.test(main) && /ipcMain\.on\('aprs-beacon-now'/.test(main));
  });

  await test('main.js: our beacon coming back over the feed is marked (it is on the map with the rest)', async () => {
    assert.ok(/AprsBeacon\.isOwnBeacon\(p, login\.call\)\) \{ aprsBeacon\.backAt = Date\.now\(\);/.test(main));
    assert.ok(/if \(p && aprsBatch\) aprsBatch\.push\(p\);/.test(main));
  });

  // The window redesign (2026-11-19) renamed "Beacon now" to "Beacon on the internet"
  // (the approved mock-up) and moved the controls from the beacon bar to aprs-window.js.
  await test('the window: Beacon on the internet, the timer choices, the symbols, a 43-character comment, Approximate position, the map point', async () => {
    // 2026-11-20: a real button, its short line under it (aprs-beacon-now-sub), not inside it.
    assert.ok(/id="aprs-beacon-now"[^>]*>Beacon on the internet<\/button>\s*<div class="aprs-bcn-sub" id="aprs-beacon-now-sub">/.test(html));
    const sel = html.slice(html.indexOf('id="aprs-beacon-interval"'), html.indexOf('</select>', html.indexOf('id="aprs-beacon-interval"')));
    assert.deepStrictEqual([...sel.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)].map((m) => m[1] + ':' + m[2]), ['0:Off', '10:10 min', '20:20 min', '30:30 min']);
    assert.ok(/id="aprs-beacon-comment" maxlength="43"/.test(html));
    // 2026-11-20: "Approximate position" became the APRS settings panel's Position precision
    // (grid 4 / grid 6 to the minute, exact not): the same aprsBeaconApprox, set with the choice.
    assert.ok(/id="aprs-precision" role="radiogroup"/.test(html));
    assert.ok(/o\.aprsBeaconApprox = x\.precision !== 'exact'/.test(read('lib/aprs-beacon.js')));
    assert.ok(/id="aprs-beacon-pick"[^>]*>Pick on map<\/button>/.test(html));
    assert.ok(html.indexOf('../lib/aprs-beacon.js') < html.indexOf('aprs-window.js'));
    const bar = read('renderer/aprs-window.js');
    assert.ok(/AprsIcons\.svg\(sym\.icon, 18\)/.test(bar), 'the phase 1 icons');
    assert.ok(!/alert\(|confirm\(/.test(bar));
    assert.ok(/window\.aprsMapApi = \{ map: map \};/.test(read('renderer/aprs-popout.js')));
    const ivLine = read('renderer/aprs-window.js').split("$('aprs-beacon-interval').addEventListener")[1].split(String.fromCharCode(10))[0];
    assert.ok(/beaconSet\(\{ intervalMin: /.test(ivLine) && !/beaconNow|rfSend/.test(ivLine), 'picking a timer only sets it');
  });

  console.log(`\nAPRS beacon wiring: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
