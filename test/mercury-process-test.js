// Unit tests for lib/mercury-process.js — pure Mercury launch helpers.
// Run: node test/mercury-process-test.js
'use strict';

const assert = require('assert');
const {
  MERCURY_DEFAULTS,
  mercuryBinaryName,
  mercuryPathCandidates,
  mercuryConfig,
  mercuryPorts,
  buildMercuryArgs,
  buildMercuryIni,
} = require('../lib/mercury-process');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---- binary name ----
test('binary name is platform-correct', () => {
  assert.strictEqual(mercuryBinaryName('win32'), 'mercury.exe');
  assert.strictEqual(mercuryBinaryName('linux'), 'mercury');
  assert.strictEqual(mercuryBinaryName('darwin'), 'mercury');
});

// ---- path candidates ----
test('override path is first candidate', () => {
  const c = mercuryPathCandidates({ settings: { mercuryPath: '/custom/mercury' }, appDir: '/app', platform: 'linux' });
  assert.strictEqual(c[0], '/custom/mercury');
});

test('dev bundled path uses appDir/third_party/mercury', () => {
  const c = mercuryPathCandidates({ appDir: '/app', isPackaged: false, platform: 'linux' });
  assert.strictEqual(c[0], '/app/third_party/mercury/mercury');
});

test('packaged bundled path uses resourcesPath', () => {
  const c = mercuryPathCandidates({ isPackaged: true, resourcesPath: '/res', platform: 'linux' });
  assert.strictEqual(c[0], '/res/third_party/mercury/mercury');
});

test('windows bundled path + common dirs use backslashes and .exe', () => {
  const c = mercuryPathCandidates({ appDir: 'C:\\app', platform: 'win32' });
  assert.strictEqual(c[0], 'C:\\app\\third_party\\mercury\\mercury.exe');
  assert.ok(c.includes('C:\\Program Files\\Mercury\\mercury.exe'));
  assert.ok(c.every((p) => p.endsWith('.exe')));
});

test('bare name is NOT in the candidate list (PATH fallback handled by caller)', () => {
  const c = mercuryPathCandidates({ appDir: '/app', platform: 'linux' });
  assert.ok(!c.includes('mercury'));
});

// ---- config defaulting ----
test('config falls back to defaults on empty settings', () => {
  const c = mercuryConfig({});
  assert.strictEqual(c.basePort, MERCURY_DEFAULTS.basePort);
  assert.strictEqual(c.soundSystem, 'auto');
  assert.strictEqual(c.captureChannel, 'left');
  assert.strictEqual(c.txGainDb, 0);
});

test('tx gain is clamped to +/-20 dB', () => {
  assert.strictEqual(mercuryConfig({ mercuryTxGainDb: 99 }).txGainDb, 20);
  assert.strictEqual(mercuryConfig({ mercuryTxGainDb: -99 }).txGainDb, -20);
  assert.strictEqual(mercuryConfig({ mercuryTxGainDb: 3.5 }).txGainDb, 3.5);
});

test('invalid ports fall back to defaults', () => {
  assert.strictEqual(mercuryConfig({ mercuryBasePort: 'nope' }).basePort, 8300);
  assert.strictEqual(mercuryConfig({ mercuryBasePort: 0 }).basePort, 8300);
  assert.strictEqual(mercuryConfig({ mercuryBasePort: 99999 }).basePort, 8300);
});

test('ports derive control/data/broadcast correctly', () => {
  const p = mercuryPorts({ mercuryBasePort: 8400 });
  assert.deepStrictEqual(p, { control: 8400, data: 8401, broadcast: 8100 });
});

// ---- CLI args ----
test('args omit radio-control flags entirely (POTACAT keeps PTT)', () => {
  const args = buildMercuryArgs({ mercurySoundSystem: 'wasapi', mercuryInputDevice: 'IN', mercuryOutputDevice: 'OUT' }, '/tmp/m.ini');
  assert.ok(!args.includes('-R'));
  assert.ok(!args.includes('-A'));
  assert.ok(!args.includes('-S'));
});

test('args carry ini path, base/broadcast ports, sound system, devices', () => {
  const args = buildMercuryArgs({ mercuryBasePort: 8300, mercurySoundSystem: 'wasapi', mercuryInputDevice: 'IN', mercuryOutputDevice: 'OUT' }, '/tmp/m.ini');
  const joined = args.join(' ');
  assert.ok(joined.includes('-C /tmp/m.ini'));
  assert.ok(joined.includes('-p 8300'));
  assert.ok(joined.includes('-b 8100'));
  assert.ok(joined.includes('-x wasapi'));
  assert.ok(joined.includes('-i IN'));
  assert.ok(joined.includes('-o OUT'));
});

test('auto sound system and empty devices are omitted', () => {
  const args = buildMercuryArgs({}, '/tmp/m.ini');
  assert.ok(!args.includes('-x'));
  assert.ok(!args.includes('-i'));
  assert.ok(!args.includes('-o'));
  assert.ok(!args.includes('-k')); // left = default, omitted
});

// ---- ini generation ----
test('ini pins radio_model=-1 and disables the mercury UI', () => {
  const ini = buildMercuryIni({});
  assert.ok(/radio_model = -1/.test(ini), 'radio_model must be -1 so Mercury never keys the rig');
  assert.ok(/ui_enabled = false/.test(ini));
  assert.ok(/\[audio\][\s\S]*tx_gain_db = 0\.0/.test(ini));
});

test('ini reflects configured ports and gain', () => {
  const ini = buildMercuryIni({ mercuryBasePort: 8500, mercuryTxGainDb: -6 });
  assert.ok(/arq_tcp_base_port = 8500/.test(ini));
  assert.ok(/tx_gain_db = -6\.0/.test(ini));
});

test('args/ini honor a resolved FIFO audio config (-x fifo + fifo paths)', () => {
  const audio = { soundSystem: 'fifo', inputDevice: '/ud/mercury-rx.fifo', outputDevice: '/ud/mercury-tx.fifo' };
  const args = buildMercuryArgs({}, '/tmp/m.ini', audio).join(' ');
  assert.ok(args.includes('-x fifo'));
  assert.ok(args.includes('-i /ud/mercury-rx.fifo'));
  assert.ok(args.includes('-o /ud/mercury-tx.fifo'));
  const ini = buildMercuryIni({}, audio);
  assert.ok(/sound_system = fifo/.test(ini));
  assert.ok(/input_device = \/ud\/mercury-rx\.fifo/.test(ini));
  assert.ok(/output_device = \/ud\/mercury-tx\.fifo/.test(ini));
});

console.log(`\nMercury process helpers: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
