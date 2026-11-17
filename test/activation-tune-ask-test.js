#!/usr/bin/env node
'use strict';
/**
 * GitHub #146: starting an activation from an ECHOCAT phone moved the home
 * radio without asking. Casey's rule (2026-11-07): POTACAT never retunes the
 * radio silently for a phone activation; it asks first, and with more than
 * one rig it asks which one.
 *
 * lib/activation-tune-ask.js is the rule (pure). The wire tests drive
 * lib/remote-server.js the way a phone does: an older phone's bare tune just
 * before set-activator-park is never done, a new device is asked, and only a
 * yes from that same device tunes. Brief: docs/activation-ask-before-tune.md.
 *
 * Run: node test/activation-tune-ask-test.js
 */
require('./ws-stub-if-missing');
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const A = require('../lib/activation-tune-ask');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
const later = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { later.push(r.then(() => { passed++; console.log('  ok  ' + name); }, (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); })); return; }
    passed++; console.log('  ok  ' + name);
  } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('Activation: ask before the radio moves (#146)');

// ---- the rule ----
const oneRig = [{ id: 'r1', name: 'IC-7300' }];
const twoRigs = [{ id: 'r1', name: 'IC-7300' }, { id: 'r2', name: 'FT-710' }];
const onAir = { connected: true, freqKhz: 14074, mode: 'DIGU' };
const want = { freqKhz: '14285.0', mode: 'SSB' };

test('no frequency wanted: nothing to ask', () => {
  assert.strictEqual(A.decide({ want: null, canAsk: true, rig: onAir, rigs: oneRig, activeRigId: 'r1' }).action, 'none');
});

test('the radio is already there (USB and SSB are the same): nothing to ask', () => {
  const d = A.decide({ want: { freqKhz: 14285.02, mode: 'SSB' }, canAsk: true, rig: { connected: true, freqKhz: 14285, mode: 'USB' }, rigs: oneRig, activeRigId: 'r1' });
  assert.strictEqual(d.action, 'none');
});

test('one rig, new device: a yes/no question with the target and where it is now', () => {
  const d = A.decide({ want, canAsk: true, rig: onAir, rigs: oneRig, activeRigId: 'r1' });
  assert.strictEqual(d.action, 'ask');
  assert.strictEqual(d.ask.freqKhz, 14285);
  assert.strictEqual(d.ask.mode, 'SSB');
  assert.deepStrictEqual(d.ask.rigs, [], 'one rig: no picker');
  assert.ok(d.ask.text.startsWith('Move the radio to 14.285.00 MHz SSB for this activation?'), d.ask.text);
  assert.ok(d.ask.text.includes('It is on 14.074.00 MHz DIGU now.'), d.ask.text);
  assert.strictEqual(d.ask.expiresInMs, A.ASK_TTL_MS);
});

test('several rigs: the question names every rig and asks which', () => {
  const d = A.decide({ want, canAsk: true, rig: onAir, rigs: twoRigs, activeRigId: 'r1' });
  assert.strictEqual(d.action, 'ask');
  assert.deepStrictEqual(d.ask.rigs.map(r => [r.id, r.active, r.connected]), [['r1', true, true], ['r2', false, false]]);
  assert.ok(d.ask.text.includes('Choose the radio.'), d.ask.text);
});

test('radio not connected, one rig: started, not moved, told in words', () => {
  const d = A.decide({ want, canAsk: true, rig: { connected: false }, rigs: oneRig, activeRigId: 'r1' });
  assert.strictEqual(d.action, 'notice');
  assert.ok(/not connected/.test(d.text) && /did not move/.test(d.text), d.text);
});

test('radio not connected, several rigs: still asked (another radio may be chosen)', () => {
  const d = A.decide({ want, canAsk: true, rig: { connected: false }, rigs: twoRigs, activeRigId: 'r1' });
  assert.strictEqual(d.action, 'ask');
  assert.strictEqual(d.ask.current, null);
});

test('an older device that cannot be asked: a notice, never a tune', () => {
  const d = A.decide({ want, canAsk: false, rig: onAir, rigs: twoRigs, activeRigId: 'r1' });
  assert.strictEqual(d.action, 'notice');
  assert.ok(d.text.includes('POTACAT did not move the radio'), d.text);
  assert.ok(d.text.includes('14.285.00 MHz SSB'), d.text);
});

test('a Guest Pass operator connected: the question says so', () => {
  const d = A.decide({ want, canAsk: true, rig: onAir, rigs: oneRig, activeRigId: 'r1', guestOnAir: true });
  assert.ok(d.ask.guestOnAir && d.ask.text.includes('Guest Pass'), d.ask.text);
});

test('answers: no, too late, unknown rig, a chosen rig', () => {
  const p = { want: { freqKhz: 14285, mode: 'SSB' }, createdAt: 1000 };
  assert.strictEqual(A.answer(p, { tune: false }, 2000, ['r1']).tune, false);
  assert.strictEqual(A.answer(p, { tune: 'yes' }, 2000, ['r1']).tune, false, 'only a real true is a yes');
  const late = A.answer(p, { tune: true }, 1000 + A.ASK_TTL_MS + 1, ['r1']);
  assert.strictEqual(late.tune, false);
  assert.ok(/expired/.test(late.text));
  assert.strictEqual(A.answer(null, { tune: true }, 2000, []).tune, false, 'no open question: no tune');
  assert.deepStrictEqual(A.answer(p, { tune: true, rigId: 'nope' }, 2000, ['r1', 'r2']), { tune: true, freqKhz: 14285, mode: 'SSB', rigId: '' });
  assert.strictEqual(A.answer(p, { tune: true, rigId: 'r2' }, 2000, ['r1', 'r2']).rigId, 'r2');
});

test('who is an older phone; which tunes are held', () => {
  assert.strictEqual(A.isLegacyPhone('ios 18.1 phone', []), true);
  assert.strictEqual(A.isLegacyPhone('android 35 tablet', ['chunked-worked-qsos']), true);
  assert.strictEqual(A.isLegacyPhone('ios 18.1 phone', [A.CAP]), false);
  assert.strictEqual(A.isLegacyPhone('desktop-win32', []), false, 'desktop-to-desktop never tuned on start');
  assert.strictEqual(A.isLegacyPhone('', []), false, 'ECHOCAT Web never tuned on start');
  assert.strictEqual(A.isHoldableTune({ freqKhz: '14285.0', mode: 'SSB' }), true);
  assert.strictEqual(A.isHoldableTune({ freqKhz: '162550', channelId: 'noaa-1' }), false);
  assert.strictEqual(A.isHoldableTune({ freqKhz: '14200', pickSideband: true }), false);
  assert.strictEqual(A.isHoldableTune({ freqKhz: '14200', bearing: 45 }), false);
});

// ---- the wire ----
function shack(platform, caps) {
  const rs = new RemoteServer();
  const sent = [];
  const ws = { _authenticated: true, readyState: 1, send: (s) => sent.push(JSON.parse(s)), _clientPlatform: platform, _clientCapabilities: caps };
  rs._client = ws;
  rs._clients = new Set([ws]);
  const events = [];
  for (const e of ['tune', 'set-activator-park', 'activation-tune-answer']) rs.on(e, (d) => events.push([e, d]));
  return { rs, ws, sent, events, send: (m) => rs._handleMessage(ws, m, {}) };
}

test('older phone: the start tune is never done; the activation starts; a notice follows', async () => {
  const s = shack('ios 18.1 phone', []);
  s.send({ type: 'tune', freqKhz: '14285.0', mode: 'SSB' });
  s.send({ type: 'set-activator-park', parkRef: 'US-1234', parkRefs: ['US-1234'], sig: 'POTA' });
  const start = s.events.find(([e]) => e === 'set-activator-park');
  assert.ok(start, 'the activation started');
  assert.deepStrictEqual(start[1].tuneWant, { freqKhz: 14285, mode: 'SSB' });
  assert.strictEqual(start[1].clientCanAsk, false);
  assert.ok(start[1].tuneAskId);
  // main decides 'notice' for an older device; the notice reaches that phone as tune-blocked
  s.rs.sendActivationTuneNotice(start[1].tuneAskId, 'Your activation started. POTACAT did not move the radio.');
  await wait(A.HOLD_MS + 150);
  assert.strictEqual(s.events.filter(([e]) => e === 'tune').length, 0, 'no tune, ever');
  assert.ok(s.sent.some(m => m.type === 'tune-blocked' && /did not move/.test(m.reason)));
});

test('older phone: an ordinary tune still goes through, a moment late', async () => {
  const s = shack('android 35 phone', []);
  s.send({ type: 'tune', freqKhz: '7074.0', mode: 'FT8' });
  assert.strictEqual(s.events.filter(([e]) => e === 'tune').length, 0, 'held');
  await wait(A.HOLD_MS + 150);
  const t = s.events.filter(([e]) => e === 'tune');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0][1].freqKhz, 7074);
});

test('new device: tunes at once, no hold; tuneTo on the start is asked, the yes tunes', () => {
  const s = shack('ios 18.1 phone', [A.CAP]);
  s.send({ type: 'tune', freqKhz: '7074.0' });
  assert.strictEqual(s.events.filter(([e]) => e === 'tune').length, 1, 'not held');
  s.rs._lastTuneTime = 0;
  s.send({ type: 'set-activator-park', parkRef: 'US-1234', tuneTo: { freqKhz: 14285, mode: 'SSB' } });
  const start = s.events.find(([e]) => e === 'set-activator-park')[1];
  assert.strictEqual(start.clientCanAsk, true);
  const d = A.decide({ want: start.tuneWant, canAsk: true, rig: onAir, rigs: twoRigs, activeRigId: 'r1' });
  assert.ok(s.rs.sendActivationTuneAsk(start.tuneAskId, d.ask));
  const ask = s.sent.find(m => m.type === 'activation-tune-ask');
  assert.ok(ask && ask.id === start.tuneAskId && ask.rigs.length === 2);
  assert.ok(protocol.validate(ask, protocol.Dir.S2C).ok, 'the ask matches the registry');
  s.send({ type: 'activation-tune-answer', id: ask.id, tune: true, rigId: 'r2' });
  const yes = s.events.filter(([e]) => e === 'activation-tune-answer');
  assert.deepStrictEqual(yes.map(x => x[1]), [{ freqKhz: 14285, mode: 'SSB', rigId: 'r2' }]);
  s.send({ type: 'activation-tune-answer', id: ask.id, tune: true });
  assert.strictEqual(s.events.filter(([e]) => e === 'activation-tune-answer').length, 1, 'one answer per question');
});

test('a no, another device, or a locked VFO never tunes', () => {
  const s = shack('ios 18.1 phone', [A.CAP]);
  s.send({ type: 'set-activator-park', parkRef: 'US-1234', tuneTo: { freqKhz: 14285, mode: 'SSB' } });
  const id = s.events.find(([e]) => e === 'set-activator-park')[1].tuneAskId;
  s.rs.sendActivationTuneAsk(id, A.decide({ want: { freqKhz: 14285, mode: 'SSB' }, canAsk: true, rig: onAir, rigs: oneRig, activeRigId: 'r1' }).ask);
  // another device answering is ignored
  const other = { _authenticated: true, readyState: 1, send: () => {}, _clientPlatform: 'ios', _clientCapabilities: [A.CAP] };
  s.rs._handleMessage(other, { type: 'activation-tune-answer', id, tune: true }, {});
  s.send({ type: 'activation-tune-answer', id, tune: false });
  assert.strictEqual(s.events.filter(([e]) => e === 'activation-tune-answer').length, 0);
  // locked VFO
  s.send({ type: 'set-activator-park', parkRef: 'US-1234', tuneTo: { freqKhz: 7200 } });
  const id2 = s.events.filter(([e]) => e === 'set-activator-park')[1][1].tuneAskId;
  s.rs.sendActivationTuneAsk(id2, { freqKhz: 7200, mode: '', rigs: [], activeRigId: 'r1', text: 'x', expiresInMs: 1 });
  s.rs._vfoLocked = true;
  s.send({ type: 'activation-tune-answer', id: id2, tune: true });
  assert.strictEqual(s.events.filter(([e]) => e === 'activation-tune-answer').length, 0);
  assert.ok(s.sent.some(m => m.type === 'tune-blocked' && /VFO Locked/.test(m.reason)));
});

test('ending an activation asks nothing', () => {
  const s = shack('ios 18.1 phone', [A.CAP]);
  s.send({ type: 'set-activator-park', end: true, parkRefs: [], parkRef: '', tuneTo: { freqKhz: 14285 } });
  const e = s.events.find(([n]) => n === 'set-activator-park')[1];
  assert.strictEqual(e.tuneWant, null);
  assert.strictEqual(e.tuneAskId, '');
});

// ---- the question follows the device, not the socket (review 2026-11-17, item 8) ----
test('who asked is the paired device; the re-sent question keeps its id and only the time left', () => {
  assert.strictEqual(A.askerKey('d1'), 'dev:d1');
  assert.strictEqual(A.askerKey(''), '');
  assert.strictEqual(A.askerKey(null), '');
  const ws1 = {}, ws2 = {};
  const p = { ws: ws1, askerKey: 'dev:d1', createdAt: 1000, ask: { freqKhz: 14285, mode: 'SSB', text: 'Move?', expiresInMs: A.ASK_TTL_MS } };
  assert.strictEqual(A.isAsker(p, ws1, ''), true);
  assert.strictEqual(A.isAsker(p, ws2, 'dev:d1'), true, 'the same device on a new socket');
  assert.strictEqual(A.isAsker(p, ws2, 'dev:d2'), false, 'another device');
  assert.strictEqual(A.isAsker({ ws: ws1, askerKey: '', createdAt: 0 }, ws2, ''), false, 'no identity: that socket only');
  const r = A.resendAsk(p, 'tq1', 1000 + 30000);
  assert.deepStrictEqual(r, { type: 'activation-tune-ask', id: 'tq1', freqKhz: 14285, mode: 'SSB', text: 'Move?', expiresInMs: A.ASK_TTL_MS - 30000 });
  assert.strictEqual(A.resendAsk(p, 'tq1', 1000 + A.ASK_TTL_MS), null, 'expired: nothing to re-send');
  assert.strictEqual(A.resendAsk({ createdAt: 1000 }, 'tq1', 1001), null, 'never asked: nothing to re-send');
});

function pairedPhone(rs, deviceId, caps) {
  const sent = [];
  const ws = { _authenticated: true, readyState: 1, send: (x) => sent.push(JSON.parse(x)), _clientPlatform: 'ios 18.1 phone', _clientCapabilities: caps, _pairedDevice: { id: deviceId, name: 'Phone ' + deviceId } };
  return { ws, sent, send: (m) => rs._handleMessage(ws, m, {}) };
}
function askFrom(rs, phone, events) {
  phone.send({ type: 'set-activator-park', parkRef: 'US-1234', tuneTo: { freqKhz: 14285, mode: 'SSB' } });
  const id = events.filter(([e]) => e === 'set-activator-park').pop()[1].tuneAskId;
  assert.ok(rs.sendActivationTuneAsk(id, A.decide({ want: { freqKhz: 14285, mode: 'SSB' }, canAsk: true, rig: onAir, rigs: twoRigs, activeRigId: 'r1' }).ask));
  return id;
}
function pairedShack() {
  const rs = new RemoteServer();
  rs._pairedDevices = [{ id: 'd1', name: 'Phone d1' }, { id: 'd2', name: 'Phone d2' }];
  const events = [];
  for (const e of ['tune', 'set-activator-park', 'activation-tune-answer']) rs.on(e, (d) => events.push([e, d]));
  return { rs, events };
}

test('the phone slept during the question: on reconnect it gets the same question again, and its yes tunes', () => {
  const { rs, events } = pairedShack();
  const a = pairedPhone(rs, 'd1', [A.CAP]);
  rs._client = a.ws; rs._clients = new Set([a.ws]);
  const id = askFrom(rs, a, events);
  const first = a.sent.find(m => m.type === 'activation-tune-ask');
  assert.ok(first && first.id === id);
  // the screen sleeps: the socket dies, the same device comes back on a new one
  a.ws.readyState = 3;
  rs._tuneAsks.get(id).createdAt -= 40000;
  const b = pairedPhone(rs, 'd1', [A.CAP]);
  rs._client = b.ws; rs._clients = new Set([b.ws]);
  rs._hydrateClient(b.ws);
  const again = b.sent.filter(m => m.type === 'activation-tune-ask');
  assert.strictEqual(again.length, 1, 'sent once on reconnect');
  const { expiresInMs: e1, ...rest1 } = first;
  const { expiresInMs: e2, ...rest2 } = again[0];
  assert.deepStrictEqual(rest2, rest1, 'the same question, same id');
  assert.ok(e2 <= A.ASK_TTL_MS - 40000 && e2 > A.ASK_TTL_MS - 41000, 'only the time left: ' + e2);
  assert.ok(protocol.validate(again[0], protocol.Dir.S2C).ok, 'the wire format is unchanged');
  rs._hydrateClient(b.ws);
  assert.strictEqual(b.sent.filter(m => m.type === 'activation-tune-ask').length, 1, 'not repeated to the same socket');
  b.send({ type: 'activation-tune-answer', id, tune: true, rigId: 'r2' });
  assert.deepStrictEqual(events.filter(([e]) => e === 'activation-tune-answer').map(x => x[1]), [{ freqKhz: 14285, mode: 'SSB', rigId: 'r2' }]);
});

test('a reconnect whose hello comes after auth gets the question at hello', () => {
  const { rs, events } = pairedShack();
  const a = pairedPhone(rs, 'd1', [A.CAP]);
  rs._client = a.ws; rs._clients = new Set([a.ws]);
  const id = askFrom(rs, a, events);
  a.ws.readyState = 3;
  const b = pairedPhone(rs, 'd1', []);
  rs._client = b.ws; rs._clients = new Set([b.ws]);
  rs._hydrateClient(b.ws);
  assert.strictEqual(b.sent.filter(m => m.type === 'activation-tune-ask').length, 0, 'no capability yet');
  b.send({ type: 'hello', protocolVersion: protocol.PROTOCOL_VERSION, clientPlatform: 'ios 18.1 phone', clientVersion: '1.6.0', capabilities: [A.CAP] });
  const again = b.sent.filter(m => m.type === 'activation-tune-ask');
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].id, id);
});

test('another paired device, an expired question, or a socket with no pairing: nothing re-sent, no tune', () => {
  const { rs, events } = pairedShack();
  const a = pairedPhone(rs, 'd1', [A.CAP]);
  rs._client = a.ws; rs._clients = new Set([a.ws]);
  const id = askFrom(rs, a, events);
  a.ws.readyState = 3;
  const other = pairedPhone(rs, 'd2', [A.CAP]);
  rs._hydrateClient(other.ws);
  assert.strictEqual(other.sent.filter(m => m.type === 'activation-tune-ask').length, 0);
  other.send({ type: 'activation-tune-answer', id, tune: true });
  assert.strictEqual(events.filter(([e]) => e === 'activation-tune-answer').length, 0);
  // expired: the same device comes back too late
  rs._tuneAsks.get(id).createdAt -= A.ASK_TTL_MS + 1;
  const late = pairedPhone(rs, 'd1', [A.CAP]);
  rs._hydrateClient(late.ws);
  assert.strictEqual(late.sent.filter(m => m.type === 'activation-tune-ask').length, 0);
  late.send({ type: 'activation-tune-answer', id, tune: true });
  assert.strictEqual(events.filter(([e]) => e === 'activation-tune-answer').length, 0);
  // no pairing (shared token): the question stays with its socket, as before
  const s = shack('ios 18.1 phone', [A.CAP]);
  s.send({ type: 'set-activator-park', parkRef: 'US-1234', tuneTo: { freqKhz: 14285, mode: 'SSB' } });
  const id2 = s.events.find(([e]) => e === 'set-activator-park')[1].tuneAskId;
  s.rs.sendActivationTuneAsk(id2, A.decide({ want: { freqKhz: 14285, mode: 'SSB' }, canAsk: true, rig: onAir, rigs: oneRig, activeRigId: 'r1' }).ask);
  const sent2 = [];
  const ws2 = { _authenticated: true, readyState: 1, send: (x) => sent2.push(JSON.parse(x)), _clientPlatform: 'ios', _clientCapabilities: [A.CAP] };
  s.rs._hydrateClient(ws2);
  assert.strictEqual(sent2.filter(m => m.type === 'activation-tune-ask').length, 0);
});

test('the shack advertises the capability; registry, guest wall and main glue', () => {
  const rsSrc = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  assert.ok(rsSrc.includes("'activation-ask-tune',"), 'server hello lists activation-ask-tune');
  assert.strictEqual(protocol.MESSAGES['activation-tune-answer'].dir, protocol.Dir.C2S);
  assert.strictEqual(protocol.MESSAGES['activation-tune-ask'].dir, protocol.Dir.S2C);
  assert.ok(protocol.MESSAGES['set-activator-park'].fields.tuneTo);
  const { isGuestAllowed } = require('../lib/guest-pass-authority');
  assert.strictEqual(isGuestAllowed('activation-tune-answer'), false);
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  // The start handler itself never tunes: it hands the want to the ask.
  const m = main.match(/remoteServer\.on\('set-activator-park',[\s\S]*?\n {2}\}\);\n/);
  assert.ok(m, 'set-activator-park handler found');
  assert.ok(!/tuneRadio\(|emit\('tune'/.test(m[0]), 'the activation start never tunes');
  assert.ok(m[0].includes('activationTuneAskFollow(tuneAskId, tuneWant, clientCanAsk)'));
  assert.ok(/remoteServer\.on\('activation-tune-answer'/.test(main));
  const doc = readSrc(path.join(__dirname, '..', 'docs', 'echocat-protocol.md'));
  for (const t of ['activation-tune-ask', 'activation-tune-answer', 'activation-ask-tune', 'tuneTo']) assert.ok(doc.includes(t), 'protocol doc names ' + t);
});

Promise.all(later).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
