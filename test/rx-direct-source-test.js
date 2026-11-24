'use strict';
// #936 (78hawkeye, IC-7610 over Icom Network, macOS): the JTCAT pop-out opened
// the Mac's default input instead of main's Icom network frames, and SSTV
// painted its waterfall from that local capture on top of the Icom frames.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

let R = null;
try { R = require('../lib/rx-direct-source'); } catch (e) { R = null; }

test('lib/rx-direct-source.js exists', () => {
  assert.ok(R, 'lib/rx-direct-source.js is missing');
});

if (R) {
  test('JTCAT pop-out uses main\'s feed for icom-network (the bug)', () => {
    assert.strictEqual(R.jtcatPopoutUsesMainFeed('icom-network'), true);
  });
  test('the sources that already used main\'s feed still do', () => {
    for (const s of ['smartsdr', 'yaesu-lan', 'websdr', 'tci']) {
      assert.strictEqual(R.jtcatPopoutUsesMainFeed(s), true, s);
    }
  });
  test('sound-card sources still open a local capture', () => {
    for (const s of [undefined, '', 'device', 'default', 'rigctld']) {
      assert.strictEqual(R.jtcatPopoutUsesMainFeed(s), false, String(s));
    }
  });
  test('feed options: Icom network gets the main window\'s jitter buffer', () => {
    assert.deepStrictEqual(R.jtcatPopoutFeedOptions('icom-network'),
      { sourceRate: 24000, bufferMs: 600, startBufferMs: 150, resumeBufferMs: 200 });
    assert.deepStrictEqual(R.jtcatPopoutFeedOptions('smartsdr'), { sourceRate: 24000 });
    assert.deepStrictEqual(R.jtcatPopoutFeedOptions('yaesu-lan'), { sourceRate: 24000 });
    assert.deepStrictEqual(R.jtcatPopoutFeedOptions('websdr'), { sourceRate: 12000 });
    assert.deepStrictEqual(R.jtcatPopoutFeedOptions('tci'), { sourceRate: 12000 });
  });
  test('the Icom options match what the main window uses (renderer/app.js)', () => {
    assert.ok(/s\.audioSource === 'icom-network'\s*\?\s*\{ sourceRate: 24000, bufferMs: 600, startBufferMs: 150, resumeBufferMs: 200 \}/.test(read('renderer/app.js')),
      'app.js Icom-network worklet options changed; keep lib/rx-direct-source.js in step');
  });
  test('SSTV local capture yields to a live Icom network stream (the bug)', () => {
    assert.strictEqual(R.sstvLocalCaptureYields('icom-network', 10000, 11000), true);
  });
  test('SSTV local capture takes over when the Icom stream goes quiet or never came', () => {
    assert.strictEqual(R.sstvLocalCaptureYields('icom-network', 10000, 13000), false);
    assert.strictEqual(R.sstvLocalCaptureYields('icom-network', 0, 11000), false);
  });
  test('SSTV SmartSDR gate unchanged', () => {
    assert.strictEqual(R.sstvLocalCaptureYields('smartsdr', 10000, 12999), true);
    assert.strictEqual(R.sstvLocalCaptureYields('smartsdr', 10000, 13000), false);
    assert.strictEqual(R.sstvLocalCaptureYields('smartsdr', 0, 11000), false);
  });
  test('SSTV sound-card sources never yield', () => {
    for (const s of [undefined, '', 'device', 'tci']) {
      assert.strictEqual(R.sstvLocalCaptureYields(s, 10000, 10001), false, String(s));
    }
  });
  test('#951 SSTV yields to a live Yaesu SCU-LAN10 stream, not to a quiet one', () => {
    assert.strictEqual(R.sstvLocalCaptureYields('yaesu-lan', 10000, 11000), true);
    assert.strictEqual(R.sstvLocalCaptureYields('yaesu-lan', 10000, 13000), false);
    assert.strictEqual(R.sstvLocalCaptureYields('yaesu-lan', 0, 11000), false);
  });
}

test('JTCAT pop-out loads the module and picks its branch with it', () => {
  assert.ok(/<script src="\.\.\/lib\/rx-direct-source\.js"><\/script>/.test(read('renderer/jtcat-popout.html')), 'jtcat-popout.html loads it');
  const pop = read('renderer/jtcat-popout.js');
  assert.ok(/if \(window\.RxDirectSource\.jtcatPopoutUsesMainFeed\(audioSource\)\)/.test(pop), 'startPopoutAudio branches on jtcatPopoutUsesMainFeed');
  assert.ok(/processorOptions: window\.RxDirectSource\.jtcatPopoutFeedOptions\(audioSource\)/.test(pop), 'worklet options come from the module');
});

test('SSTV pop-out loads the module and gates its local capture with it', () => {
  assert.ok(/<script src="\.\.\/lib\/rx-direct-source\.js"><\/script>/.test(read('renderer/sstv-popout.html')), 'sstv-popout.html loads it');
  const pop = read('renderer/sstv-popout.js');
  assert.ok(/window\.RxDirectSource\.sstvLocalCaptureYields\(settings && settings\.audioSource, _lastVitaAudioTs, Date\.now\(\)\)/.test(pop),
    'the capture handler drops buffers while the radio stream is live');
  assert.ok(!/settings\.audioSource === 'smartsdr'\s*\n?\s*&& \(Date\.now\(\) - _lastVitaAudioTs\) < 3000/.test(pop), 'the SmartSDR-only gate is gone');
});

test('SSTV names Icom network audio, not the local device, as the radio source', () => {
  const pop = read('renderer/sstv-popout.js');
  assert.ok(/'Icom network audio'/.test(pop), 'status line names Icom network audio');
  assert.ok(/'Yaesu LAN audio'/.test(pop), 'status line names Yaesu LAN audio (#951)');
});

console.log(passed + ' passed');
