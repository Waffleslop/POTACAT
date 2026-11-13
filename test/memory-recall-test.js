// A Channels entry can name the radio's own memory channel; a tap recalls it,
// offset and tone included, and any later tune leaves memory mode first
// (lib/memory-recall.js, GitHub #308).
// Run: node test/memory-recall-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const M = require('../lib/memory-recall');
const Channels = require('../lib/channels');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? i + 4000 : j);
}

console.log('memory recall (#308)');

test('memory numbers: whole numbers 0..9999, anything else is none', () => {
  assert.strictEqual(M.memNumber(0), 0);
  assert.strictEqual(M.memNumber('12'), 12);
  assert.strictEqual(M.memNumber(9999), 9999);
  for (const bad of [null, undefined, '', -1, 10000, 1.5, 'abc', 'C1']) assert.strictEqual(M.memNumber(bad), null, String(bad));
  assert.strictEqual(Channels.memNumber('7'), 7, 'the dual-mode copy agrees');
  assert.strictEqual(Channels.memNumber('x'), null);
});

test('Icom: the channel in big-endian BCD, one byte below 100 and two from 100 (Hamlib icom_set_mem)', () => {
  assert.deepStrictEqual(M.icomMemoryBcd(1), [0x01]);
  assert.deepStrictEqual(M.icomMemoryBcd(12), [0x12]);
  assert.deepStrictEqual(M.icomMemoryBcd(99), [0x99]);
  assert.deepStrictEqual(M.icomMemoryBcd(100), [0x01, 0x00]);
  assert.deepStrictEqual(M.icomMemoryBcd(345), [0x03, 0x45]);
  assert.throws(() => M.icomMemoryBcd(-1));
});

test('Icom codec: 08 (memory mode), then 08 + channel; 07 back to VFO', () => {
  const { CivCodec } = require('../lib/codecs/civ-codec');
  const frames = [];
  const c = Object.create(CivCodec.prototype);
  c._radioAddr = 0x94; c._ctrlAddr = 0xE0;
  c._write = (f) => frames.push(Buffer.from(f).toString('hex'));
  c.selectMemory(12);
  c.selectVfoMode();
  assert.deepStrictEqual(frames, ['fefe94e008fd', 'fefe94e00812fd', 'fefe94e007fd']);
});

test('rigctld: V MEM then E <ch>, each its own line (each gets its own reply entry); V VFOA back', () => {
  assert.deepStrictEqual(M.rigctldRecallLines(5), ['V MEM\n', 'E 5\n']);
  assert.strictEqual(M.RIGCTLD_VFO_LINE, 'V VFOA\n');
  const src = readSrc(path.join(root, 'lib', 'codecs', 'rigctld-codec.js'));
  assert.ok(/for \(const line of MemoryRecall\.rigctldRecallLines\(ch\)\) this\._write\(line\);/.test(src));
});

test('the read-back: within 1 kHz is the channel; elsewhere names both frequencies and what to fix', () => {
  const ch = { name: 'W4XYZ', khz: 146940, mem: 12 };
  assert.strictEqual(M.recallVerdict({ channel: ch, gotHz: 146940000 }).ok, true);
  assert.strictEqual(M.recallVerdict({ channel: ch, gotHz: 146940600 }).ok, true);
  const bad = M.recallVerdict({ channel: ch, gotHz: 147300000 });
  assert.strictEqual(bad.ok, false);
  assert.ok(/147\.300\.00 MHz, not W4XYZ's 146\.940\.00 MHz/.test(bad.text) && /memory number in Directory > Channels/.test(bad.text));
  assert.strictEqual(M.recallVerdict({ channel: ch, gotHz: 0 }).ok, null);
});

test('rig controller: only a link whose codec has both commands can recall', () => {
  const { RigController } = require('../lib/rig-controller');
  const rc = Object.create(RigController.prototype);
  rc._codec = { selectMemory() {}, selectVfoMode() {} };
  assert.strictEqual(rc.canRecallMemory, true);
  rc._codec = { selectMemory() {} };
  assert.strictEqual(rc.canRecallMemory, false);
  rc._codec = {};
  assert.strictEqual(rc.canRecallMemory, false);
});

test('channels keep the memory number; a CHIRP import keeps Location only when asked', () => {
  assert.strictEqual(Channels.sanitizeChannel({ khz: 146940, mem: '12' }).mem, 12);
  assert.strictEqual(Channels.sanitizeChannel({ khz: 146940 }).mem, null);
  const csv = 'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,Mode,TStep,Skip,Comment\n'
    + '12,W4XYZ,146.940000,-,0.600000,Tone,100.0,100.0,023,NN,FM,5.00,,Net Tuesdays\n'
    + '13,K4ABC,444.100000,+,5.000000,TSQL,88.5,123.0,023,NN,FM,5.00,,\n';
  const plain = Channels.parseChirpCsv(csv, {});
  assert.strictEqual(plain.hasLocation, true);
  assert.deepStrictEqual(plain.channels.map((c) => c.mem), [null, null], 'a RepeaterBook file: its Location is only list order');
  const mine = Channels.parseChirpCsv(csv, { keepMemory: true });
  assert.deepStrictEqual(mine.channels.map((c) => c.mem), [12, 13]);
  assert.strictEqual(mine.channels[0].offsetKhz, -600);
  assert.strictEqual(mine.channels[0].tone, '100.0');
  assert.strictEqual(mine.channels[1].tone, '123.0', 'TSQL takes the CTCSS tone');
  assert.strictEqual(Channels.parseChirpCsv('Name,Frequency\nA,146.52\n', { keepMemory: true }).hasLocation, false);
});

test('a RepeaterBook-style CHIRP export (no URCALL/RPT columns, Tone Squelch) imports with offset and tone', () => {
  // The shape RepeaterBook's CHIRP export is reported to have (it once lacked
  // URCALL, RPT1CALL, RPT2CALL, DVCODE; chirpmyradio.com/issues/6783).
  const csv = 'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,Mode,TStep,Skip,Comment\r\n'
    + '1,W4XYZ,146.94000,-,0.60000,TSQL,88.5,100.0,023,NN,FM,5.00,,"Anytown, Repeater"\r\n';
  const r = Channels.parseChirpCsv(csv, {});
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.channels.length, 1);
  const c = r.channels[0];
  assert.strictEqual(c.khz, 146940);
  assert.strictEqual(c.offsetKhz, -600);
  assert.strictEqual(c.tone, '100.0');
  assert.strictEqual(c.note, 'Anytown, Repeater');
  assert.strictEqual(c.mem, null);
});

test('main: a tap recalls when the channel has a memory and the link can, else tunes and says what is not set', () => {
  const go = fnBody(main, 'channelGo');
  assert.ok(/mem == null \|\| !cat \|\| !cat\.connected \|\| !cat\.canRecallMemory/.test(go));
  assert.ok(/tuneRadio\(c\.khz, Channels\.tuneMode\(c\.mode\)/.test(go), 'the old path for everything else');
  assert.ok(/receive frequency only — set the/.test(go), 'a repeater tuned by frequency says offset and tone are not set');
  assert.ok(/MemoryRecall\.recallVerdict\(\{ channel: c, gotHz: _currentFreqHz \}\)/.test(go) && /v\.ok === false/.test(go) && /'app-notice'/.test(go) && /'tune-blocked'/.test(go), 'a wrong memory is said on the screen and the phone');
  assert.ok(go.indexOf('_memoryRecalled = null;') < go.indexOf('cat.selectMemory(mem)'), 'memory to memory stays in memory mode');
});

test('main: every tune leaves a recalled memory for VFO mode before the frequency is written', () => {
  const t = fnBody(main, 'tuneRadio');
  const leave = t.indexOf("if (_memoryRecalled) channelLeaveMemory(");
  assert.ok(leave > 0 && leave < t.indexOf('kiwiClient.tune(') && leave < t.indexOf('smartSdr.tuneSlice(') && leave < t.indexOf('cat.tune('), 'before any frequency write');
  assert.ok(leave < t.indexOf('REJECTED implausible frequency'), 'even for a rejected tune');
  const leaveFn = fnBody(main, 'channelLeaveMemory');
  assert.ok(/_memoryRecalled = null;/.test(leaveFn) && /cat\.selectVfoMode\(\)/.test(leaveFn));
});

test('ECHOCAT: a channel tap names its channel; the shack recalls, an older app still tunes', () => {
  const web = readSrc(path.join(root, 'renderer', 'remote.js'));
  assert.ok(/type: 'tune', freqKhz: String\(c\.khz\), mode: channelTuneMode\(c\.mode\), channelId: c\.id/.test(web));
  const srv = readSrc(path.join(root, 'lib', 'remote-server.js'));
  assert.ok(/channelId: typeof msg\.channelId === 'string' \? msg\.channelId\.slice\(0, 64\) : undefined/.test(srv));
  const i = main.indexOf("remoteServer.on('tune', ({ freqKhz, mode, bearing, channelId, pickSideband }) => {");
  assert.ok(i > 0);
  const head = main.slice(i, i + 700);
  assert.ok(/channelMemoryOf\(String\(channelId\)\) != null && cat && cat\.connected && cat\.canRecallMemory/.test(head) && /channelGo\(String\(channelId\), 'ECHOCAT'\)/.test(head));
});

test('desktop Channels: the M badge, the editor field, the import question, and the tap', () => {
  const v = readSrc(path.join(root, 'renderer', 'channels-view.js'));
  assert.ok(/if \(c\.mem != null && api && api\.channelGo\) \{ api\.channelGo\(c\.id\); return; \}/.test(v));
  assert.ok(/id="chn-f-mem"/.test(v) && /mem: C\.memNumber\(String\(el\('chn-f-mem'\)\.value\)\.trim\(\)\)/.test(v));
  assert.ok(/>M\$\{c\.mem\}<\/span>/.test(v));
  assert.ok(/channelGo: \(id\) => ipcRenderer\.invoke\('channel-go', \{ id \}\)/.test(readSrc(path.join(root, 'preload.js'))));
  assert.ok(/Did this file come from programming your radio\?/.test(main) && /defaultId: 0, cancelId: 0/.test(main), 'asked; the default keeps no numbers');
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/memory-recall-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
