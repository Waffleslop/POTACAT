#!/usr/bin/env node
'use strict';
/**
 * Winlink on a remote shack from this desktop (#299): lib/winlink-remote-shack.js.
 * Every request the Winlink window makes becomes the wire message ECHOCAT
 * sends, every field it sends is declared in the registry, and the shack's
 * replies come back in the shapes the window reads.
 *
 * Run: node test/winlink-remote-shack-test.js
 */
const assert = require('assert');
const W = require('../lib/winlink-remote-shack');
const { MESSAGES } = require('../lib/echocat-protocol');
const WinlinkSpectrum = require('../lib/winlink-spectrum');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const sample = {
  'winlink-cmd-list': ['in'],
  'winlink-cmd-read': [{ box: 'in', mid: 'ABC123' }],
  'winlink-cmd-delete': [{ box: 'in', mid: 'ABC123' }],
  'winlink-cmd-move': [{ box: 'in', mid: 'ABC123', to: 'archive' }],
  'winlink-cmd-save-attachment': [{ box: 'in', mid: 'ABC123', name: 'a.txt' }],
  'winlink-cmd-send': [{ to: 'W1AW', cc: '', subject: 'Hi', body: 'Body', attachments: [{ name: 'a.txt', size: 3, dataBase64: 'YWJj' }], formId: 'x' }],
  'winlink-cmd-posreport': [{ lat: 40.1, lon: -75.2, comment: 'here' }],
  'winlink-pota-spot-template': [{}],
  'winlink-cmd-connect': [{ mode: 'ardop', gateway: 'W5ABC', dialKhz: 7102, url: 'ardop:///W5ABC?freq=7102' }],
  'winlink-cmd-qsy': [{ dialKhz: 7102, mode: 'ardop' }],
  'winlink-cmd-retry': ['now'],
  'winlink-account-check': [],
  'winlink-register': [{ password: 'secret1', recoveryEmail: 'a@b.c', origin: 'mail window' }],
  'winlink-cmd-set-password': ['secret1'],
  'winlink-cmd-gateways': [{ mode: 'ardop', band: '40m' }],
  'winlink-cmd-history': [],
  'winlink-cmd-template': [{ op: 'save', t: { name: 'Weekly', to: 'W1AW', subject: 'Check-in', body: 'b' } }],
  'winlink-cmd-contact': [{ op: 'save', c: { name: 'Net', address: 'W1AW', note: '' } }],
  'winlink-cmd-contact-group': [{ op: 'save', g: { name: 'ARES', members: ['W1AW', 'K3SBP'] } }],
  'winlink-cmd-favourite': [{ op: 'add', call: 'W5ABC', mode: 'ardop', dialKhz: 7102, url: '' }],
  'winlink-cmd-accept-notice': [],
  // Winlink catalog requests (docs/winlink-catalog.md): the shack's catalog, picks and Outbox.
  'winlink-catalog-get': [],
  'winlink-catalog-request': [['PROP_3DAY', 'PROP_WWV']],
  'winlink-catalog-request-list': [true],
  'winlink-catalog-offer': [true],
  'winlink-catalog-star': [{ id: 'PROP_WWV', on: true }],
};

test('every invoke the window makes has a sample here', () => {
  const missing = W.WINLINK_INVOKES.filter((ch) => {
    const r = W.INVOKES[ch]([]);
    return (r.send || r.save) && !sample[ch];
  });
  assert.deepStrictEqual(missing, []);
});

test('every wire message is a registered C2S, with only declared fields', () => {
  for (const [ch, args] of Object.entries(sample)) {
    const r = W.INVOKES[ch](args);
    const m = r.send || r.save;
    assert.ok(m, ch + ' sends');
    const spec = MESSAGES[m.type];
    assert.ok(spec && spec.dir === 'c2s', `${ch} -> ${m.type} is C2S`);
    for (const k of Object.keys(m)) if (k !== 'type') assert.ok(k in spec.fields, `${m.type}.${k} is declared`);
  }
});

test('the messages carry what the shack needs', () => {
  assert.deepStrictEqual(W.INVOKES['winlink-cmd-connect'](sample['winlink-cmd-connect']).send,
    { type: 'winlink-connect', mode: 'ardop', gateway: 'W5ABC', dialKhz: 7102, url: 'ardop:///W5ABC?freq=7102' });
  const c = W.INVOKES['winlink-cmd-send'](sample['winlink-cmd-send']).send;
  assert.deepStrictEqual(c, { type: 'winlink-compose', to: 'W1AW', subject: 'Hi', body: 'Body', attachments: [{ name: 'a.txt', dataBase64: 'YWJj' }] });
  assert.deepStrictEqual(W.INVOKES['winlink-cmd-move'](sample['winlink-cmd-move']).send, { type: 'winlink-move', box: 'in', mid: 'ABC123', to: 'archive' });
  assert.deepStrictEqual(W.INVOKES['winlink-cmd-contact-group'](sample['winlink-cmd-contact-group']).send.members, ['W1AW', 'K3SBP']);
  assert.strictEqual(W.INVOKES['winlink-cmd-gateways'](sample['winlink-cmd-gateways']).ms, W.MS.gateways);
});

test('forms and the shack\'s sound settings are answered here, in words', () => {
  const cat = W.INVOKES['winlink-forms-catalog']([]).answer;
  assert.strictEqual(cat.allowed, false);
  assert.ok(/shack PC/.test(cat.why));
  assert.strictEqual(W.INVOKES['winlink-form-open']([]).answer.ok, false);
  assert.strictEqual(W.INVOKES['winlink-audio-rig']([]).answer.ok, false);
  assert.deepStrictEqual(W.INVOKES['winlink-cmd-state']([]), { cached: 'state' });
});

test('replies come back in the window\'s shapes', () => {
  assert.deepStrictEqual(W.reply('winlink-cmd-delete', { type: 'winlink-result', op: 'delete', ok: true }), { ok: true });
  assert.deepStrictEqual(W.reply('winlink-cmd-delete', { type: 'winlink-result', op: 'delete', ok: false, error: 'Pat is not running' }), { ok: false, error: 'Pat is not running' });
  assert.deepStrictEqual(W.reply('winlink-cmd-read', { type: 'winlink-message', box: 'in', mid: 'A', message: { subject: 'x' } }), { ok: true, message: { subject: 'x' } });
  assert.strictEqual(W.reply('winlink-cmd-read', { type: 'winlink-result', op: 'read', ok: false, error: 'gone' }).error, 'gone');
  assert.deepStrictEqual(W.reply('winlink-account-check', { type: 'winlink-account', callsign: 'K3SBP', exists: true }), { ok: true, callsign: 'K3SBP', exists: true });
  const g = W.reply('winlink-cmd-gateways', { type: 'winlink-gateways', mode: 'ardop', band: '40m', list: [{ call: 'W5ABC' }], predicted: true, note: '', leftOut: 2 });
  assert.deepStrictEqual(g, { ok: true, mode: 'ardop', band: '40m', list: [{ call: 'W5ABC' }], predicted: true, note: '', leftOut: 2 });
  assert.deepStrictEqual(W.reply('winlink-cmd-history', { type: 'winlink-history', gateways: [1] }), { ok: true, gateways: [1] });
  const spot = W.reply('winlink-pota-spot-template', { type: 'winlink-pota-spot', to: 'spot@x', subject: 'POTA', parks: ['US-1111'], body: 'b', missing: [], reqId: 'r' });
  assert.deepStrictEqual(spot.refs, ['US-1111']);
  assert.ok(!('type' in spot) && !('reqId' in spot));
  assert.deepStrictEqual(W.reply('winlink-cmd-save-attachment', { type: 'winlink-attachment', name: 'a.txt', dataBase64: 'YWJj', size: 3 }), { ok: true, name: 'a.txt', dataBase64: 'YWJj' });
});

test('no answer and a Guest Pass refusal are sentences', () => {
  assert.deepStrictEqual(W.reply('winlink-cmd-connect', null), { ok: false, error: W.NO_ANSWER });
  const g = W.reply('winlink-cmd-connect', { type: 'winlink-refused', reason: 'guest-pass' });
  assert.strictEqual(g.ok, false);
  assert.ok(/Guest Pass/.test(g.error));
});

test('the shack\'s state is the window\'s, marked as the shack\'s', () => {
  const st = W.windowState({ type: 'winlink-state', enabled: true, patReady: true, modes: [{ id: 'ardop', available: true }], reqId: 'x' });
  assert.deepStrictEqual(st, { enabled: true, patReady: true, modes: [{ id: 'ardop', available: true }], remoteShack: true });
  assert.strictEqual(W.waitingState().patReady, false);
});

test('the shack\'s waterfall frame comes back as the window\'s magnitudes, the dB scale kept', () => {
  const mags = new Float32Array(256);
  for (let i = 0; i < 256; i++) mags[i] = i === 100 || i === 101 ? 5 : 1;  // one signal 4 ln-units (17 dB) over the floor
  const wire = WinlinkSpectrum.wireBins(mags);
  const back = W.magsFromWireBins(wire);
  assert.strictEqual(back.length, 256);
  const dB = (back[100] - back[10]) * 10 / Math.LN10;
  assert.ok(Math.abs(dB - 4 * 10 / Math.LN10) < 0.5, 'the signal is ' + dB.toFixed(1) + ' dB over the floor');
  assert.strictEqual(back[10], 0);
  assert.deepStrictEqual(W.magsFromWireBins(null).length, 256);
});

test('the channels the shack feeds while one is driven', () => {
  assert.deepStrictEqual(W.SHACK_CHANNELS.slice().sort(), ['winlink-mailbox', 'winlink-remote-watch', 'winlink-session', 'winlink-state']);
});

test('#585: the favourite invoke carries a typed gateway\'s mine, note, via, bw and was to the shack', () => {
  const m = W.INVOKES['winlink-cmd-favourite']([{ op: 'edit', call: 'W2XYZ-10', mode: 'packet', dialKhz: 145050, mine: true, note: 'club net', via: ['W2ABC-1'], bw: 0, was: { call: 'W2XYZ-10', mode: 'packet', dialKhz: 145030 } }]).send;
  assert.deepStrictEqual(m, { type: 'winlink-favourite', op: 'edit', call: 'W2XYZ-10', mode: 'packet', dialKhz: 145050, mine: true, note: 'club net', via: ['W2ABC-1'], was: { call: 'W2XYZ-10', mode: 'packet', dialKhz: 145030 } });
  for (const k of ['mine', 'note', 'via', 'bw', 'was']) assert.ok(k in MESSAGES['winlink-favourite'].fields, k + ' is declared');
  const star = W.INVOKES['winlink-cmd-favourite']([{ op: 'add', call: 'W5ABC', mode: 'ardop', dialKhz: 7102, url: '' }]).send;
  assert.strictEqual(star.mine, undefined, 'the star never sends mine');
});
test('#585: a QSY names the picked gateway, so the shack can find a typed one', () => {
  const m = W.INVOKES['winlink-cmd-qsy']([{ dialKhz: 145050, mode: 'packet', gateway: 'W2XYZ-10' }]).send;
  assert.strictEqual(m.gateway, 'W2XYZ-10');
  assert.ok('gateway' in MESSAGES['winlink-qsy'].fields);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
