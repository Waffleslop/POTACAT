// Hamlib rotctld rotor backend (KD9WI 2026-09-13). Pure mapping/parsing,
// a fake rotctld on a real socket (runs everywhere, CI included), and — when
// the bundled Hamlib rotctld is present — the real thing driving the Dummy
// rotor.
'use strict';
const assert = require('assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  RotctldClient, mapAzimuth, parseDumpState, parsePosition, parseRotorList, buildRotctldArgs, hamlibErrorText,
} = require('../lib/rotctld-client');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function waitFor(emitter, ev, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no '${ev}' in ${ms} ms`)), ms);
    emitter.once(ev, (v) => { clearTimeout(timer); resolve(v); });
  });
}

(async () => {
  console.log('rotctld client');

  // --- pure ---
  await t('mapAzimuth: plain 0..360 rotor', () => {
    assert.deepStrictEqual(mapAzimuth(270, { minAz: 0, maxAz: 360 }), { az: 270 });
    assert.deepStrictEqual(mapAzimuth(-10, { minAz: 0, maxAz: 360 }), { az: 350 });
    assert.deepStrictEqual(mapAzimuth(725, { minAz: 0, maxAz: 360 }), { az: 5 });
  });
  await t('mapAzimuth: south-centre -180..180 rotor gets -90 for west', () => {
    assert.deepStrictEqual(mapAzimuth(270, { minAz: -180, maxAz: 180 }), { az: -90 });
    assert.deepStrictEqual(mapAzimuth(90, { minAz: -180, maxAz: 180 }), { az: 90 });
  });
  await t('mapAzimuth: overlap rotor prefers the plain compass bearing', () => {
    assert.deepStrictEqual(mapAzimuth(30, { minAz: 0, maxAz: 450 }), { az: 30 });
  });
  await t('mapAzimuth: a limited rotor refuses what it cannot reach, with a reason', () => {
    const r = mapAzimuth(200, { minAz: 0, maxAz: 180 });
    assert.ok(r.error && /outside this rotor's range \(0° to 180°\)/.test(r.error), r.error);
    assert.ok(mapAzimuth('x').error);
  });
  await t('mapAzimuth: no limits known = 0..360', () => {
    assert.deepStrictEqual(mapAzimuth(123.4, null), { az: 123.4 });
    // limits rotctld did not report arrive as null — must not become 0..0
    assert.deepStrictEqual(mapAzimuth(123, { minAz: null, maxAz: null }), { az: 123 });
  });
  await t('parseDumpState reads the EFFECTIVE limits', () => {
    const lim = parseDumpState(['dump_state:', 'rotctld Protocol Ver: 1', 'Rotor Model: 601',
      'Minimum Azimuth: -180.000000', 'Maximum Azimuth: 180.000000', 'Minimum Elevation: 0.000000', 'Maximum Elevation: 90.000000', 'done']);
    assert.deepStrictEqual(lim, { minAz: -180, maxAz: 180, minEl: 0, maxEl: 90, model: 601 });
  });
  await t('parsePosition', () => {
    assert.deepStrictEqual(parsePosition(['get_pos:', 'Azimuth: 12.50', 'Elevation: 0.00']), { az: 12.5, el: 0 });
    assert.strictEqual(parsePosition(['get_pos:']), null);
  });
  await t('parseRotorList splits on header columns (long Mfg names)', () => {
    const txt = [
      ' Rot #  Mfg                    Model                   Version         Status        Macro',
      '     1  Hamlib                 Dummy                   20220531.0      Stable        ROT_MODEL_DUMMY',
      '     4  csntechnologies.net    S.A.T. Satellite ctl    20240609.0      Untested      ROT_MODEL_SATROTCTL',
      '   601  Yaesu                  GS-232A                 20220109.0      Stable        ROT_MODEL_GS232A',
    ].join('\n');
    assert.deepStrictEqual(parseRotorList(txt), [
      { id: 1, mfg: 'Hamlib', model: 'Dummy', status: 'Stable' },
      { id: 4, mfg: 'csntechnologies.net', model: 'S.A.T. Satellite ctl', status: 'Untested' },
      { id: 601, mfg: 'Yaesu', model: 'GS-232A', status: 'Stable' },
    ]);
    assert.deepStrictEqual(parseRotorList('garbage'), []);
  });
  await t('buildRotctldArgs: loopback only, serial speed only with a device', () => {
    assert.deepStrictEqual(buildRotctldArgs({ model: 601, device: 'COM7', baud: 9600, port: 4533 }),
      ['-m', '601', '-T', '127.0.0.1', '-t', '4533', '-r', 'COM7', '-s', '9600']);
    assert.deepStrictEqual(buildRotctldArgs({ model: 1, port: 4600, baud: 9600 }),
      ['-m', '1', '-T', '127.0.0.1', '-t', '4600']);
    assert.deepStrictEqual(buildRotctldArgs({ model: 601, device: 'COM7', conf: ' min_az=-180,max_az=180 ' }).slice(-1),
      ['--set-conf=min_az=-180,max_az=180']);
  });
  await t('hamlibErrorText names the out-of-limits error', () => {
    assert.match(hamlibErrorText(-21), /outside the rotor's limits/);
    assert.match(hamlibErrorText(-99), /Hamlib error 99/);
  });

  // --- fake rotctld on a real socket ---
  function fakeRotctld({ minAz = 0, maxAz = 360, refuse = false } = {}) {
    const state = { az: 0, el: 0, sets: [], conns: 0 };
    const server = net.createServer((sock) => {
      state.conns++;
      // A client disconnect mid-poll is a TCP reset on Windows; the fake must not crash on it.
      sock.on('error', () => {});
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line === '+\\dump_state') sock.write(`dump_state:\nrotctld Protocol Ver: 1\nRotor Model: 601\nMinimum Azimuth: ${minAz}.000000\nMaximum Azimuth: ${maxAz}.000000\nMinimum Elevation: 0.000000\nMaximum Elevation: 90.000000\ndone\nRPRT 0\n`);
          else if (line === '+\\get_info') sock.write('get_info:\nInfo: Fake GS-232\nRPRT 0\n');
          else if (line === '+p') sock.write(`get_pos:\nAzimuth: ${state.az.toFixed(2)}\nElevation: ${state.el.toFixed(2)}\nRPRT 0\n`);
          else if (line.startsWith('+P ')) {
            const [, az, el] = line.split(/\s+/);
            state.sets.push(Number(az));
            if (refuse || Number(az) < minAz || Number(az) > maxAz) sock.write(`set_pos: ${az} ${el}\nRPRT -21\n`);
            else { sock.write(`set_pos: ${az} ${el}\nRPRT 0\n`); setTimeout(() => { state.az = Number(az); }, 150); }
          } else if (line === '+S') sock.write('stop:\nRPRT 0\n');
          else sock.write('RPRT -4\n');
        }
      });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
  }
  const fastOpts = { pollIntervalMs: 50, stableReads: 2, reconnectMinMs: 50, reconnectMaxMs: 200 };

  await t('connects, reads limits, turns a south-centre rotor to -90 for west, settles arrived', async () => {
    const f = await fakeRotctld({ minAz: -180, maxAz: 180 });
    const c = new RotctldClient(fastOpts);
    const logs = []; c.on('log', m => logs.push(m));
    c.connect({ host: '127.0.0.1', port: f.port });
    await waitFor(c, 'status');
    assert.strictEqual(c.limits.minAz, -180);
    assert.ok(logs.some(l => /connected to .*Fake GS-232.*-180° to 180°/.test(l)), logs.join('\n'));
    c.rotate(270);
    const s = await waitFor(c, 'settled');
    assert.deepStrictEqual(f.state.sets, [-90]);
    assert.strictEqual(s.arrived, true);
    assert.strictEqual(s.target, -90);
    c.disconnect(); f.server.close();
  });

  await t('a rotor refusal is logged with the Hamlib meaning, not swallowed', async () => {
    const f = await fakeRotctld({ refuse: true });
    const c = new RotctldClient(fastOpts);
    const logs = []; c.on('log', m => logs.push(m));
    c.connect({ host: '127.0.0.1', port: f.port });
    await waitFor(c, 'status');
    c.rotate(45);
    await wait(200);
    assert.ok(logs.some(l => /refused: RPRT -21 \(position outside the rotor's limits\)/.test(l)), logs.join('\n'));
    c.disconnect(); f.server.close();
  });

  await t('rapid QSYs coalesce to the newest bearing', async () => {
    const f = await fakeRotctld();
    const c = new RotctldClient(fastOpts);
    c.connect({ host: '127.0.0.1', port: f.port });
    await waitFor(c, 'status');
    c.rotate(10); c.rotate(20); c.rotate(30); c.rotate(40);
    await wait(300);
    assert.strictEqual(f.state.sets[0], 10);
    assert.strictEqual(f.state.sets[f.state.sets.length - 1], 40);
    assert.ok(f.state.sets.length <= 2, 'sent ' + f.state.sets.join(','));
    c.disconnect(); f.server.close();
  });

  await t('a bearing requested while rotctld is down goes out when it answers', async () => {
    // Reserve a port, then start the server on it only after the request.
    const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    const c = new RotctldClient(fastOpts);
    const logs = []; c.on('log', m => logs.push(m));
    c.connect({ host: '127.0.0.1', port });
    c.rotate(123);
    await wait(120);
    assert.ok(logs.some(l => /no answer at/.test(l)), logs.join('\n'));
    assert.strictEqual(logs.filter(l => /no answer at/.test(l)).length, 1, 'refusal logged once, not per retry');
    const state = { sets: [] };
    const server = net.createServer((sock) => {
      // A client disconnect mid-poll is a TCP reset on Windows; the fake must not crash on it.
      sock.on('error', () => {});
      let buf = '';
      sock.on('data', (d) => {
        buf += d; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line.startsWith('+P ')) { state.sets.push(Number(line.split(/\s+/)[1])); sock.write('set_pos:\nRPRT 0\n'); }
          else if (line === '+p') sock.write('get_pos:\nAzimuth: 123.00\nElevation: 0.00\nRPRT 0\n');
          else sock.write('RPRT 0\n');
        }
      });
    });
    await new Promise(r => server.listen(port, '127.0.0.1', r));
    await waitFor(c, 'status', 3000);
    await wait(150);
    assert.deepStrictEqual(state.sets, [123]);
    c.disconnect(); server.close();
  });

  // --- the real bundled rotctld, Dummy rotor ---
  const bin = path.join(__dirname, '..', 'assets', 'hamlib', process.platform === 'win32' ? 'rotctld.exe' : 'rotctld');
  if (!fs.existsSync(bin)) {
    console.log('  (skipped: no bundled rotctld at assets/hamlib — live Hamlib check)');
  } else {
    await t('real rotctld (Dummy rotor, limited to -180..180): limits read, west sent as -90, rotor arrives', async () => {
      const port = 45330 + Math.floor(Math.random() * 500);
      const proc = spawn(bin, buildRotctldArgs({ model: 1, port, conf: 'min_az=-180,max_az=180' }), { stdio: 'ignore' });
      try {
        await wait(700);
        const c = new RotctldClient({ pollIntervalMs: 250, stableReads: 2, reconnectMinMs: 200 });
        c.connect({ host: '127.0.0.1', port });
        await waitFor(c, 'status', 5000);
        assert.strictEqual(c.limits.minAz, -180);
        assert.strictEqual(c.limits.maxAz, 180);
        c.rotate(270);
        const s = await waitFor(c, 'settled', 60000);
        assert.strictEqual(s.target, -90);
        assert.strictEqual(s.arrived, true, JSON.stringify(s));
        c.disconnect();
      } finally { proc.kill(); }
    });
  }

  // --- wiring guards (the pieces that fail silently if one is missing) ---
  await t('main.js wires rotctld at startup, on settings save, on quit, and on every bearing', () => {
    // Whitespace-insensitive so CRLF checkouts and reindents don't break it.
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\s+/g, ' ');
    const has = (snippet) => assert.ok(main.includes(snippet.replace(/\s+/g, ' ')), 'main.js is missing: ' + snippet);
    has("if (settings.rotorType === 'rotctld') { syncRotctld(); if (rotctldClient) rotctldClient.rotate(azimuth);");
    has("'rotctldPort', 'rotctldHost', 'rotctldConf', 'rotctldPath'].some(has)) { syncRotctld(); }");
    has('// Same for rotctld: start it (or connect to it) before the first QSY. syncRotctld();');
    has('killRigctld(); try { stopRotctld(); } catch {}');
    has("ipcMain.handle('rotctld-list-models'");
  });
  await t('release builds ship rotctld beside rigctld on macOS and Linux; Windows has it in assets', () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    const count = (snippet) => yml.split(snippet).length - 1;
    assert.strictEqual(count('cp "$HAMLIB_PREFIX/bin/rotctld" assets/hamlib/rotctld'), 2, 'macOS jobs copy rotctld');
    assert.strictEqual(count('cp /usr/local/bin/rotctld assets/hamlib/rotctld'), 2, 'Linux jobs copy rotctld');
    assert.strictEqual(count('--expect-arch=arm64 assets/hamlib/rigctld assets/hamlib/rotctld')
      + count('--expect-arch=x86_64 assets/hamlib/rigctld assets/hamlib/rotctld'), 2, 'macOS jobs bundle rotctld dylibs');
    assert.strictEqual(count('chmod 755 assets/hamlib/rigctld assets/hamlib/rotctld'), 2, 'Linux jobs make rotctld 755 (Squirrel.Mac lesson)');
    assert.strictEqual(count("patchelf --set-rpath '$ORIGIN' assets/hamlib/rotctld"), 2, 'Linux jobs set rotctld RPATH');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'hamlib', 'rotctld.exe')), 'assets/hamlib/rotctld.exe (Windows ships the committed copy)');
  });

  console.log(`rotctld client: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
