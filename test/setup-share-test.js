// "Share my working setup" (lib/setup-share.js): nothing leaves that is not
// on the allowlist, the preview names everything that does, and delivery
// keeps what it could not send.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/setup-share');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}

// A rig carrying every kind of thing that must never leave the computer.
const SECRETS = {
  host: '192.168.7.44', path: 'COM7', serialPort: '/dev/ttyUSB3', pttPort: 'COM9',
  username: 'k3sbp-admin', password: 'hunter2-radio', port: 50001, controlPort: 50002,
  inputId: 'a3f9c0e1d2b4inputhash', outputId: '77e1b2c3d4outputhash', keyPort: 'COM11',
};
const rig = {
  id: 'rig-1', name: 'Shack FT-710 (Bob\'s)', model: 'FT-710', audioSource: 'dax',
  catTarget: {
    type: 'icom-network', host: SECRETS.host, path: SECRETS.path, serialPort: SECRETS.serialPort,
    pttPort: SECRETS.pttPort, pttType: 'RTS', username: SECRETS.username, password: SECRETS.password,
    port: SECRETS.port, controlPort: SECRETS.controlPort, baudRate: 38400, dtrOff: true,
    civAddress: 0x94, civModel: 'IC-7300', rigId: 1049, networkTxGain: 0.72, flexApiHost: '10.0.0.9',
  },
  remoteAudioInput: SECRETS.inputId, remoteAudioOutput: SECRETS.outputId,
  cwKeyLine: 'dtr', cwKeyPort: SECRETS.keyPort, txDrive: 110,
  setupDone: ['ftdx10-pc-keying'], flexApiHost: '10.0.0.9',
};
const result = {
  steps: [
    { id: 'station-identity', state: 'ok' }, { id: 'radio-control', state: 'ok' },
    { id: 'rx-audio', state: 'ok' }, { id: 'tx-audio', state: 'ok' }, { id: 'tx-test', state: 'ok' },
    { id: 'clock', state: 'needs' }, { id: 'band-scope', state: 'skipped' },
  ],
  summary: { complete: true, requiredTotal: 5, requiredLeft: 0 },
};
const live = {
  rxTest: { result: 'ok', dbfs: -31.6 },
  txTest: { result: 'ok', watts: 5.04, swr: 1.23 },
  clock: { level: 'ok', offsetMs: -12.4 },
};
function build(over = {}) {
  return S.buildSetupShare({
    shareId: 'share-uuid-1', appVersion: '1.10.23', platform: 'win32', arch: 'x64',
    rig, radioType: 'icom-network', family: 'yaesu', modelInfo: { brand: 'Yaesu', maxPower: 100 },
    result, live, levels: { jtcatTxGain: 0.25, jtcatRxGain: 0.8 },
    audioLabels: { input: 'Microphone (USB Audio CODEC)', output: 'Speakers (USB Audio CODEC)' },
    answers: { menuNotes: 'Menu 03-01-26 SCU-LAN10 on', includeCallsign: false },
    callsign: 'k3sbp',
    ...over,
  });
}

console.log('setup share');

t('no secret, address, port, path, device id or rig name leaves', () => {
  const json = JSON.stringify(build());
  for (const [k, v] of Object.entries(SECRETS)) assert.ok(!json.includes(String(v)), `${k} (${v}) leaked`);
  assert.ok(!json.includes('10.0.0.9'), 'flexApiHost leaked');
  assert.ok(!json.includes('Bob'), 'the rig\'s own name leaked (operators put their names in it)');
  assert.ok(!json.includes('rig-1'), 'rig id leaked');
});

t('the CAT allowlist keeps HOW, not WHERE', () => {
  const p = build();
  assert.deepStrictEqual(p.cat, {
    type: 'icom-network', baudRate: 38400, dtrOff: true, civAddress: 0x94, civModel: 'IC-7300',
    rigId: 1049, pttType: 'RTS', networkTxGain: 0.72, separatePttPort: true,
  });
  assert.strictEqual(p.cw.separateKeyPort, true);
  assert.strictEqual(p.cw.keyLine, 'dtr');
});

t('callsign only when the operator ticks the box', () => {
  assert.strictEqual(build().callsign, null);
  assert.ok(!JSON.stringify(build()).toUpperCase().includes('K3SBP'));
  assert.strictEqual(build({ answers: { includeCallsign: true } }).callsign, 'K3SBP');
});

t('network-audio radios send no sound-card labels', () => {
  const p = build({ rig: { ...rig, audioSource: 'smartsdr' } });
  assert.strictEqual(p.audio.inputLabel, null);
  assert.strictEqual(p.audio.outputLabel, null);
  assert.strictEqual(p.audio.source, 'smartsdr');
});

t('measurements are rounded; an operator-confirmed transmit sends no watts', () => {
  const p = build();
  assert.strictEqual(p.measured.rxDbfs, -32);
  assert.strictEqual(p.measured.txTestWatts, 5);
  assert.strictEqual(p.measured.txTestSwr, 1.2);
  assert.strictEqual(p.measured.clockOffsetMs, -12);
  const q = build({ live: { ...live, txTest: { result: 'ok', watts: 0, swr: 0, byOperator: true } } });
  assert.strictEqual(q.measured.txTestWatts, null);
  assert.strictEqual(q.measured.txConfirmedByOperator, true);
});

t('FT8 levels are reported as the sliders show them', () => {
  const p = build();
  assert.strictEqual(p.audio.ft8TxLevelPct, 50); // gain 0.25 = 50% on the square-curve slider
  assert.strictEqual(p.audio.ft8RxLevelPct, 80);
  assert.strictEqual(p.audio.txDrivePct, 110);
});

t('free text is capped and control characters flattened', () => {
  const p = build({ answers: { menuNotes: 'a\u0000b\n\nc' + 'x'.repeat(5000) } });
  assert.ok(p.menuNotes.startsWith('a b c'));
  assert.strictEqual(p.menuNotes.length, S.MENU_NOTES_MAX);
  assert.strictEqual(build({ answers: { menuNotes: '   ' } }).menuNotes, null);
});

t('only a complete checklist is eligible', () => {
  assert.strictEqual(S.eligibleToShare(result), true);
  assert.strictEqual(S.eligibleToShare({ summary: { complete: false, requiredTotal: 5 } }), false);
  assert.strictEqual(S.eligibleToShare({ summary: { complete: true, requiredTotal: 0 } }), false);
  assert.strictEqual(S.eligibleToShare(null), false);
});

t('the preview names every value that is sent', () => {
  const p = build({ answers: { menuNotes: 'Menu 03-01-26 SCU-LAN10 on', includeCallsign: true } });
  const text = S.describeShare(p).map(l => l.label + ': ' + l.value).join('\n');
  for (const must of ['Yaesu FT-710', '38400 baud', '94h', '1049', 'RTS', 'dtr (separate key port)',
    'Microphone (USB Audio CODEC)', 'Speakers (USB Audio CODEC)', '50%', '80%', '110%', '-32 dBFS',
    '5 W, SWR 1.2', '12 ms', '5 of 7 steps', 'Menu 03-01-26 SCU-LAN10 on', 'K3SBP', '1.10.23 on Windows',
    'DTR held off', 'Audio: sound card on this computer']) {
    assert.ok(text.includes(must), `preview is missing "${must}":\n${text}`);
  }
  assert.ok(S.describeShare(build()).some(l => l.label === 'Callsign' && l.value === 'not included'));
});

t('every top-level field is either described or deliberately internal', () => {
  const p = build();
  const described = ['radio', 'cat', 'cw', 'audio', 'measured', 'steps', 'confirmedNotes', 'menuNotes', 'callsign', 'app'];
  const internal = ['schema', 'shareId'];
  assert.deepStrictEqual(Object.keys(p).sort(), [...described, ...internal].sort(),
    'a new payload field needs a preview line (describeShare) before it may be sent');
});

t('fingerprint ignores when/where, follows what the setup says', () => {
  const a = S.shareFingerprint(build());
  assert.strictEqual(a, S.shareFingerprint(build({ appVersion: '1.10.99', live: { ...live, rxTest: { result: 'ok', dbfs: -20 } } })));
  assert.notStrictEqual(a, S.shareFingerprint(build({ answers: { menuNotes: 'something else' } })));
  assert.notStrictEqual(a, S.shareFingerprint(build({ rig: { ...rig, catTarget: { ...rig.catTarget, baudRate: 9600 } } })));
});

t('pending shares: newest per radio, none older than 30 days, capped', () => {
  const now = 1_800_000_000_000;
  const e = (id, ago) => ({ payload: { shareId: id }, queuedAt: now - ago });
  const out = S.prunePending([e('a', 5000), e('a', 1000), e('b', S.PENDING_MAX_AGE_MS + 1), null, { payload: null }], now);
  assert.deepStrictEqual(out.map(x => [x.payload.shareId, now - x.queuedAt]), [['a', 1000]]);
  const many = Array.from({ length: 25 }, (_, i) => e('r' + i, i * 1000));
  assert.strictEqual(S.prunePending(many, now).length, S.PENDING_MAX);
  assert.deepStrictEqual(S.prunePending(undefined, now), []);
});

t('delivery: 2xx sent; unreachable, 404, 429 and 5xx kept; other refusals dropped', () => {
  assert.strictEqual(S.deliveryOutcome(201), 'sent');
  for (const c of [0, 404, 408, 429, 500, 503]) assert.strictEqual(S.deliveryOutcome(c), 'retry', String(c));
  for (const c of [400, 401, 413, 422]) assert.strictEqual(S.deliveryOutcome(c), 'drop', String(c));
});

// --- wiring guards ----------------------------------------------------------
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rend = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'station-setup.js'), 'utf8');

t('main: preview and send build the same payload; the POST carries only it', () => {
  const pre = main.slice(main.indexOf("ipcMain.handle('station-setup-share-preview'"), main.indexOf("ipcMain.handle('station-setup-share-send'"));
  assert.ok(/stationSetupShareBuild\(/.test(pre), 'preview must use stationSetupShareBuild');
  const send = main.slice(main.indexOf('async function stationSetupShareSend'), main.indexOf('async function flushPendingSetupShares'));
  assert.ok(/stationSetupShareBuild\(/.test(send), 'send must use stationSetupShareBuild');
  const post = main.slice(main.indexOf('async function postSetupShare'), main.indexOf('function stationSetupQueueShare'));
  assert.ok(/fetch\(process\.env\.POTACAT_SETUP_SHARE_URL \|\| SetupShare\.SHARE_URL,/.test(post), 'posts only to SHARE_URL (or the dev stand-in)');
  assert.ok(/body: JSON\.stringify\(payload\)/.test(post), 'posts only the built payload');
  const build = main.slice(main.indexOf('function stationSetupShareBuild'), main.indexOf('async function postSetupShare'));
  assert.ok(/eligibleToShare\(res\)/.test(build), 'refuses an incomplete checklist');
});

t('main: undelivered shares are machine-global and retried at launch; share fields survive Settings saves', () => {
  assert.ok(/'setupSharePending',/.test(main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS')))));
  assert.ok(/SETUP_KEYS = \[[^\]]*'setupShareId'[^\]]*'setupShared'/.test(main));
  assert.ok(/flushPendingSetupShares\(\)/.test(main.slice(main.indexOf('_stationSetupLaunchLastVersion = settings.lastVersion'))));
  assert.ok(/'setupShareId', 'setupShared'\]/.test(rend), 'renderer keeps Settings\' rig copy in step');
});

t('renderer: never sends anything itself, and shows the preview before Send', () => {
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(rend));
  assert.ok(/stationSetupSharePreview/.test(rend) && /stationSetupShareSend/.test(rend));
  const send = rend.indexOf("btn(shareMode === 'sending' ? 'Sending…' : 'Send'");
  assert.ok(send > rend.indexOf("// preview / sending"), 'Send button lives only in the preview');
});

console.log(`Setup share: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
