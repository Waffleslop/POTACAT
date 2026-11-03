#!/usr/bin/env node
'use strict';
/**
 * The desktop VFO window's pieces on the ECHOCAT wire, for a device VFO pane
 * (iPhone Duo, potacat-app docs/desktop-handoffs/duo-vfo-pane.md, 2026-10-26):
 *   - S2C tuned-spot {ops}: the activator card, deduped, hydrated at connect
 *   - S2C swr-guard-state + C2S swr-guard-override (Guest Pass refused)
 *   - C2S atu-tune and rig-control {action:'atu-tune'} reach the one dispatcher
 *   - tx-eq-* registered; set/save refused for a Guest Pass
 *   - status.meters from vfoMetersAvailable()
 *
 * Run: node test/duo-vfo-wire-test.js
 */
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function rig(opts) {
  const rs = new RemoteServer();
  const sent = [];
  const ws = { _authenticated: true, readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  if (opts && opts.guest) ws._passSession = { code: 'PASS1' };
  rs._client = ws;
  return { rs, ws, sent, send: (m) => rs._handleMessage(ws, m, {}) };
}
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');

console.log('Duo VFO pane over ECHOCAT');

test('every new message is registered with the right direction', () => {
  const M = protocol.MESSAGES;
  for (const [t, d] of [['tuned-spot', 's2c'], ['swr-guard-state', 's2c'], ['swr-guard-refused', 's2c'],
    ['swr-guard-override', 'c2s'], ['atu-tune', 'c2s'], ['tx-eq-get', 'c2s'], ['tx-eq-set', 'c2s'],
    ['tx-eq-state', 's2c'], ['tx-eq-save-rig-default', 'c2s'], ['tx-eq-saved', 's2c'], ['tx-eq-refused', 's2c']]) {
    assert.ok(M[t], t + ' is registered');
    assert.strictEqual(M[t].dir, d, t + ' direction');
  }
});

test('the hello advertises the four capabilities', () => {
  for (const c of ['tuned-spot', 'swr-guard-state', 'atu-tune', 'tx-eq']) {
    assert.ok(server.includes(`'${c}'`), c);
  }
});

test('tuned-spot is sent on change only and hydrates a new device', () => {
  const { rs, sent, ws } = rig();
  const ops = [{ callsign: 'K3SBP', reference: 'US-0001', isDupe: false }];
  rs.sendTunedSpot({ ops });
  rs.sendTunedSpot({ ops: [...ops] });
  assert.strictEqual(sent.filter(m => m.type === 'tuned-spot').length, 1, 'the repeat is dropped');
  rs.sendTunedSpot({ ops: [] });
  assert.deepStrictEqual(sent.filter(m => m.type === 'tuned-spot').pop().ops, [], 'off every spot = empty ops');
  assert.ok(protocol.validate(sent[0], protocol.Dir.S2C).ok, 'valid against the registry');
  sent.length = 0;
  rs._hydrateClient(ws);
  assert.ok(sent.some(m => m.type === 'tuned-spot'), 'hydrated at connect');
});

test('swr-guard-state is deduped, normalised and hydrated', () => {
  const { rs, sent, ws } = rig();
  rs.sendSwrGuardState({ tripped: true, message: 'SWR 4.2:1', swr: 4.2, limit: 3, band: '20m', atuFailed: false });
  rs.sendSwrGuardState({ tripped: true, message: 'SWR 4.2:1', swr: 4.2, limit: 3, band: '20m', atuFailed: false });
  const got = sent.filter(m => m.type === 'swr-guard-state');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].swr, 4.2);
  assert.ok(protocol.validate(got[0], protocol.Dir.S2C).ok);
  rs.sendSwrGuardState({ tripped: false, swr: null, limit: 3 });
  assert.strictEqual(sent.filter(m => m.type === 'swr-guard-state').pop().swr, null);
  sent.length = 0;
  rs._hydrateClient(ws);
  assert.ok(sent.some(m => m.type === 'swr-guard-state' && m.tripped === false), 'hydrated at connect');
});

test('swr-guard-override reaches main for the owner, is refused for a Guest Pass', () => {
  const owner = rig();
  let n = 0;
  owner.rs.on('swr-guard-override', () => n++);
  owner.send({ type: 'swr-guard-override' });
  assert.strictEqual(n, 1);

  const guest = rig({ guest: true });
  let g = 0;
  guest.rs.on('swr-guard-override', () => g++);
  guest.rs.sendSwrGuardState({ tripped: true, swr: 5, limit: 3 });
  guest.sent.length = 0;
  guest.send({ type: 'swr-guard-override' });
  assert.strictEqual(g, 0, 'not emitted');
  assert.ok(guest.sent.some(m => m.type === 'swr-guard-refused'), 'told why');
  assert.ok(guest.sent.some(m => m.type === 'swr-guard-state' && m.tripped), 'and sent the real state');
});

test('atu-tune and rig-control atu-tune reach the same dispatcher action', () => {
  const { rs, send } = rig();
  const got = [];
  rs.on('rig-control', (d) => got.push(d));
  send({ type: 'atu-tune' });
  send({ type: 'rig-control', data: { action: 'atu-tune' } });
  assert.deepStrictEqual(got.map(d => d.action), ['atu-tune', 'atu-tune']);
  assert.ok(/remoteServer\.on\('rig-control', \(data\) => applyRigControl\(data, 'echocat'\)\)/.test(main),
    'main hands rig-control to applyRigControl');
  assert.ok(/case 'atu-tune': \{/.test(main), 'applyRigControl has an atu-tune case');
});

test('tx-eq set and save: owner through, Guest Pass refused with the true state', () => {
  const owner = rig();
  const ev = [];
  owner.rs.on('tx-eq-set', (c) => ev.push(['set', c.preset]));
  owner.rs.on('tx-eq-save-rig-default', () => ev.push(['save']));
  owner.send({ type: 'tx-eq-set', enabled: true, preset: 'contest' });
  owner.send({ type: 'tx-eq-save-rig-default' });
  assert.deepStrictEqual(ev, [['set', 'contest'], ['save']]);

  const guest = rig({ guest: true });
  let g = 0;
  guest.rs.on('tx-eq-set', () => g++);
  guest.rs.on('tx-eq-save-rig-default', () => g++);
  guest.rs.broadcastTxEqState({ enabled: false, preset: 'ragchew' });
  guest.sent.length = 0;
  guest.send({ type: 'tx-eq-set', enabled: true, preset: 'contest' });
  guest.send({ type: 'tx-eq-save-rig-default' });
  assert.strictEqual(g, 0);
  assert.strictEqual(guest.sent.filter(m => m.type === 'tx-eq-refused').length, 2);
  assert.ok(guest.sent.some(m => m.type === 'tx-eq-state' && m.enabled === false), 'controls snap back');
});

test('main.js wiring', () => {
  assert.ok(/meters: vfoMetersAvailable\(\),\s*\n\s*capabilities: getRigCapabilities\(rigType\)/.test(main),
    'status carries meters');
  assert.ok(/remoteServer\.sendSwrGuardState\(state\)/.test(main), 'pushVfoSwrState feeds devices');
  assert.ok(/remoteServer\.sendTunedSpot\(\{ ops:/.test(main), 'vfo-tuned-spot feeds devices');
  assert.ok(/remoteServer\.on\('swr-guard-override', \(\) => clearSwrTrip\(/.test(main), 'override clears the latch');
  assert.ok(/remoteServer\.on\('tx-eq-save-rig-default'[\s\S]{0,300}saveTxEqRigDefault\(/.test(main), 'save uses the desktop function');
  assert.ok(/ipcMain\.handle\('tx-eq-save-rig-default', \(_e, eqConfig\) => saveTxEqRigDefault\(eqConfig\)\)/.test(main),
    'one save function for both');
  assert.ok(/^function saveTxEqRigDefault\(/m.test(main), 'at module scope, reachable from connectRemote');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
