// The grid's position for Pat's forms (#346): a GPSd stand-in on 127.0.0.1.
//
// Casey 2026-11-19: "geolocation answered from POTACAT's grid". The Winlink
// forms never ask the browser for the location; Pat fills their {Latitude},
// {Longitude}, {GridSquare}, {GPS...} insertion tags from GPSd only
// (internal/forms/forms.go gpsPos, builder.go insertionTagReplacer). So
// POTACAT answers Pat as a GPSd would, with the centre of the Settings grid.
//
// What Pat v1.0.1's client does (github.com/la5nta/pat at 2ad31e8,
// internal/gpsd/gpsd.go and objects.go): Dial reads one JSON object first and
// needs release != "" and proto_major >= 3; Watch(true) sends
// ?WATCH={"class":"WATCH","enable":true,"json":true} (no terminator) and reads
// lines until a WATCH object; NextPosTimeout(3 s) reads TPV/SKY lines until a
// TPV with mode > 1 (HasFix); Close sends ?WATCH={..."enable":false...}.
// Run: node test/winlink-gpsd-test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readSrc } = require('./_src');
const G = require('../lib/winlink-gpsd');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0, skip = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const NOW = new Date('2026-11-19T23:00:00Z');

test('the first line is a VERSION Pat accepts (release set, proto_major 3)', () => {
  const v = JSON.parse(G.versionLine());
  assert.strictEqual(v.class, 'VERSION');
  assert.ok(v.release);
  assert.ok(v.proto_major >= 3);
  assert.ok(G.versionLine().endsWith('\n'));
});

test('commands: Pat\'s ?WATCH= with no terminator, split across reads, and others', () => {
  const w = '?WATCH={"class":"WATCH","enable":true,"json":true}';
  assert.deepStrictEqual(G.parseCommands(w), { commands: [{ name: 'WATCH', params: { class: 'WATCH', enable: true, json: true } }], rest: '' });
  assert.deepStrictEqual(G.parseCommands(w.slice(0, 20)), { commands: [], rest: w.slice(0, 20) }, 'half a command waits for the rest');
  const two = G.parseCommands('?WATCH={"enable":false};\n?DEVICES;?POLL;');
  assert.deepStrictEqual(two.commands.map((c) => c.name), ['WATCH', 'DEVICES', 'POLL']);
  assert.strictEqual(two.commands[0].params.enable, false);
  assert.deepStrictEqual(G.parseCommands('?WATCH={"a":"}{"}').commands[0].params, { a: '}{' }, 'braces inside strings');
  assert.deepStrictEqual(G.parseCommands('garbage?VERSION;').commands.map((c) => c.name), ['VERSION']);
  assert.strictEqual(G.parseCommands('x'.repeat(5000)).rest.length <= 4096, true, 'a flood is not kept');
});

test('a fix from the grid: the grid square\'s centre, mode 2, its accuracy', () => {
  const t = JSON.parse(G.tpvLine('FN20xr', NOW));
  assert.deepStrictEqual([t.class, t.mode, t.lat, t.lon, t.epx, t.epy, t.time], ['TPV', 2, 40.72917, -74.04167, 5000, 5000, '2026-11-19T23:00:00.000Z']);
  assert.deepStrictEqual([JSON.parse(G.tpvLine('FN20', NOW)).lat, JSON.parse(G.tpvLine('FN20', NOW)).lon, JSON.parse(G.tpvLine('FN20', NOW)).epx], [40.5, -75, 100000]);
});

test('no grid: no fix (mode 1, no position), nothing invented', () => {
  for (const g of ['', null, undefined, 'nonsense']) {
    const t = JSON.parse(G.tpvLine(g, NOW));
    assert.strictEqual(t.mode, 1, String(g));
    assert.ok(!('lat' in t) && !('lon' in t), 'no position at all');
  }
});

test('answers: WATCH on gives WATCH then a TPV; off gives WATCH; DEVICES, POLL, unknown', () => {
  const on = G.reply({ name: 'WATCH', params: { enable: true, json: true } }, 'FN20xr', NOW);
  assert.deepStrictEqual(on.lines.map((l) => JSON.parse(l).class), ['DEVICES', 'WATCH', 'TPV']);
  assert.strictEqual(JSON.parse(on.lines[1]).enable, true);
  assert.strictEqual(on.watching, true);
  assert.strictEqual(on.close, false);
  const nofix = G.reply({ name: 'WATCH', params: { enable: true } }, '', NOW);
  assert.strictEqual(JSON.parse(nofix.lines[2]).mode, 1);
  assert.strictEqual(nofix.close, true, 'no fix: say so once and hang up, so Pat does not wait 3 s for one');
  const off = G.reply({ name: 'WATCH', params: { enable: false } }, 'FN20xr', NOW);
  assert.deepStrictEqual(off.lines.map((l) => JSON.parse(l)), [{ class: 'WATCH', enable: false, json: true }]);
  assert.strictEqual(off.watching, false);
  assert.strictEqual(JSON.parse(G.reply({ name: 'DEVICES' }, 'FN20', NOW).lines[0]).class, 'DEVICES');
  const poll = JSON.parse(G.reply({ name: 'POLL' }, 'FN20', NOW).lines[0]);
  assert.strictEqual(poll.class, 'POLL');
  assert.strictEqual(poll.tpv[0].lat, 40.5);
  assert.strictEqual(JSON.parse(G.reply({ name: 'WHAT' }, 'FN20', NOW).lines[0]).class, 'ERROR');
});

test('the server: 127.0.0.1 only, a port chosen at start, Pat\'s exchange end to end', async () => {
  let grid = 'FN20xr';
  const s = G.createGridGpsd({ getGrid: () => grid });
  const port = await s.start();
  try {
    assert.ok(port > 0 && s.port === port);
    assert.strictEqual(s.address, '127.0.0.1');
    const talk = (send) => new Promise((resolve, reject) => {
      const lines = [];
      const c = net.connect(port, '127.0.0.1');
      let buf = '';
      c.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1);
          if (lines.length === 1) c.write(send);
          if (lines.some((l) => l.class === 'TPV')) { c.destroy(); resolve(lines); }
        }
      });
      c.on('close', () => resolve(lines));
      c.on('error', reject);
    });
    const a = await talk('?WATCH={"class":"WATCH","enable":true,"json":true}');
    assert.deepStrictEqual(a.map((l) => l.class), ['VERSION', 'DEVICES', 'WATCH', 'TPV']);
    assert.deepStrictEqual([a[3].lat, a[3].lon], [40.72917, -74.04167]);
    grid = '';
    const b = await talk('?WATCH={"class":"WATCH","enable":true,"json":true}');
    assert.strictEqual(b[b.length - 1].mode, 1, 'the grid is read on every connection');
  } finally { await s.stop(); }
});

test('Pat config: gpsd points at the stand-in and allows forms; nothing else of GPSd is turned on', () => {
  const W = require('../lib/winlink-pat');
  const c = W.buildPatConfig({ mycall: 'N0CALL', httpPort: 8591, gpsdAddr: '127.0.0.1:50123' });
  // cfg/config.go GPSdConfig: enable_http (web GUI proxy), allow_forms, use_server_time, update_locator, addr.
  assert.deepStrictEqual(c.gpsd, { enable_http: false, allow_forms: true, use_server_time: false, update_locator: false, addr: '127.0.0.1:50123' });
  for (const bad of ['localhost:2947', '10.0.0.5:2947', '0.0.0.0:2947', '127.0.0.1', '', undefined]) {
    assert.deepStrictEqual(W.buildPatConfig({ mycall: 'N0CALL', httpPort: 8591, gpsdAddr: bad }).gpsd,
      { enable_http: false, allow_forms: false, use_server_time: false, update_locator: false, addr: '' }, String(bad));
  }
});

test('main.js: the stand-in starts before Pat\'s config is written and is the only gpsd address Pat gets', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  const body = (n) => { const i = main.indexOf(`function ${n}(`); return main.slice(i, main.indexOf('\n}\n', i)); };
  assert.ok(/gpsdAddr: _winlinkGpsd \? `127\.0\.0\.1:\$\{_winlinkGpsd\.port\}` : ''/.test(body('writePatConfig')));
  for (const f of ['connectWinlink', 'winlinkRestartPat']) {
    const b = body(f);
    assert.ok(b.indexOf('await startWinlinkGpsd()') > 0 && b.indexOf('await startWinlinkGpsd()') < b.indexOf('writePatConfig('), f);
  }
  assert.ok(/getGrid: \(\) => settings\.grid/.test(body('startWinlinkGpsd')), 'the Settings grid, read when Pat asks');
  assert.ok(/stopWinlinkGpsd\(\);/.test(body('disconnectWinlink')));
});

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

test('a real Pat (offline): a form\'s position tags are the grid\'s centre; with no grid Pat\'s own empty values', async () => {
  const W = require('../lib/winlink-pat');
  const bin = process.env.POTACAT_TEST_PAT || path.join(ROOT, 'assets', 'pat', W.patBinaryName());
  if (!fs.existsSync(bin)) { skip++; return 'skip'; }
  const { patTestEnv } = require('./modem-loopback/pat-env');
  let grid = 'FN20xr';
  const gps = G.createGridGpsd({ getGrid: () => grid });
  await gps.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-gpsd-'));
  const port = await freePort();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(W.buildPatConfig({ mycall: 'N0CALL', grid: 'FN20xr', httpPort: port, gpsdAddr: `127.0.0.1:${gps.port}` }), null, 2));
  const forms = path.join(dir, 'forms', 'Test Forms');
  fs.mkdirSync(forms, { recursive: true });
  fs.mkdirSync(path.join(dir, 'mailbox'), { recursive: true });
  fs.writeFileSync(path.join(forms, 'Where.txt'), 'Form: Where_Input.html\nTo: N0CALL\nSubject: Where\nMsg:\nLat <var Lat>\n');
  fs.writeFileSync(path.join(forms, 'Where_Input.html'), '<html><body><p id="lat">{Latitude}</p><p id="lon">{Longitude}</p><p id="grid">{GridSquare}</p><p id="valid">{GPSValid}</p></body></html>');
  const args = W.buildPatArgs({ configPath: cfgPath, mboxDir: path.join(dir, 'mailbox'), logPath: path.join(dir, 'pat.log'), eventLogPath: path.join(dir, 'ev.json'), formsDir: path.join(dir, 'forms') });
  const proc = spawn(bin, args, { stdio: 'ignore', env: patTestEnv(dir, ['N0CALL']), windowsHide: true });
  const url = `http://127.0.0.1:${port}/api/forms?template=${encodeURIComponent('Test Forms/Where.txt')}`;
  try {
    let page = '';
    for (let i = 0; i < 60 && !page; i++) { try { const r = await fetch(url); if (r.ok) page = await r.text(); } catch { await new Promise((r) => setTimeout(r, 250)); } }
    assert.ok(page, 'Pat answered');
    const tag = (id, p) => (p.match(new RegExp(`<p id="${id}">([^<]*)</p>`)) || [])[1];
    assert.deepStrictEqual([tag('lat', page), tag('lon', page), tag('grid', page), tag('valid', page)], ['40.7292', '-74.0417', 'FN20XR', 'YES']);
    grid = '';
    const t0 = Date.now();
    const none = await (await fetch(url)).text();
    assert.ok(Date.now() - t0 < 2500, 'no fix is said at once, not after Pat\'s 3 s wait');
    assert.deepStrictEqual([tag('lat', none), tag('lon', none), tag('valid', none)], ['0.0000', '0.0000', 'NO'], 'Pat\'s own empty values, nothing invented');
  } finally {
    try { proc.kill(); } catch {}
    await gps.stop();
  }
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(ROOT, 'scripts', 'run-tests.js')).includes("'test/winlink-gpsd-test.js'"));
});

(async () => {
  console.log('The grid\'s position for Pat\'s forms: a GPSd stand-in (#346)');
  for (const [name, fn] of queue) {
    try {
      const r = await fn();
      if (r === 'skip') console.log('  skip ' + name + ' (no Pat binary: assets/pat or POTACAT_TEST_PAT)');
      else { pass++; console.log('  ok  ' + name); }
    } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exitCode = fail ? 1 : 0;
})();
