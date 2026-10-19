// LZ3AW batch B (2026-10-19): the spotter column (item 2), CQ/ITU zones on
// the spot lists and logbooks (item 30), and choosing among the saved DX
// cluster nodes from the Spots menu (item 1) — desktop and ECHOCAT Web.
// Run: node test/lz3aw-batch-b-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadCtyDat, resolveZones } = require('../lib/cty');
const CallZones = require('../lib/call-zones');
const ClusterNodeChoice = require('../lib/cluster-node-choice');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const ROOT = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- zones
console.log('zones (cty.dat):');
const ctyDb = loadCtyDat(path.join(ROOT, 'assets', 'cty.dat'));

test('an entity with one zone answers it', () => {
  assert.deepStrictEqual(resolveZones('LZ3AW', ctyDb), { cqZone: 20, ituZone: 28 });
});
test('call-district overrides in cty.dat give the right zone in a multi-zone country', () => {
  assert.deepStrictEqual(resolveZones('K3SBP', ctyDb), { cqZone: 5, ituZone: 8 });
  assert.deepStrictEqual(resolveZones('W6ABC', ctyDb), { cqZone: 3, ituZone: 6 });
  assert.deepStrictEqual(resolveZones('VE7ABC', ctyDb), { cqZone: 3, ituZone: 2 });
  assert.deepStrictEqual(resolveZones('UA0ABC', ctyDb), { cqZone: 18, ituZone: 32 });
});
test('a portable suffix does not lose the zone', () => {
  assert.deepStrictEqual(resolveZones('NT6B/P', ctyDb), { cqZone: 3, ituZone: 6 });
});
test('nonsense and empty answer null', () => {
  assert.strictEqual(resolveZones('', ctyDb), null);
  assert.strictEqual(resolveZones('LZ3AW', null), null);
});

console.log('call-zones:');
test('zoneResolver caches answers but never a not-ready undefined', () => {
  let calls = 0, ready = false;
  const z = CallZones.zoneResolver((c) => { calls++; return ready ? { cqZone: 20, ituZone: 28 } : undefined; });
  assert.strictEqual(z('LZ3AW'), null);
  ready = true;
  assert.deepStrictEqual(z('lz3aw'), { cqZone: 20, ituZone: 28 });
  z('LZ3AW');
  assert.strictEqual(calls, 2, 'second lookup after ready is cached');
});
test('stampSpotZones writes cqZone/ituZone on every spot', () => {
  const spots = [{ callsign: 'LZ3AW' }, { callsign: '???' }];
  CallZones.stampSpotZones(spots, (c) => (c === 'LZ3AW' ? { cqZone: 20, ituZone: 28 } : null));
  assert.strictEqual(spots[0].cqZone, 20);
  assert.strictEqual(spots[0].ituZone, 28);
  assert.strictEqual(spots[1].cqZone, null);
});
test('withQsoZones derives _cqz/_ituz only when the record has none, and never mutates', () => {
  const own = { CALL: 'LZ3AW', CQZ: '15', ITUZ: '' };
  const bare = { CALL: 'LZ3AW' };
  const out = CallZones.withQsoZones([own, bare], () => ({ cqZone: 20, ituZone: 28 }));
  assert.strictEqual(out[0]._cqz, undefined, "the record's own CQZ wins");
  assert.strictEqual(String(out[0]._ituz), '28');
  assert.strictEqual(String(out[1]._cqz), '20');
  assert.ok(!('_cqz' in bare), 'input left alone');
  assert.strictEqual(CallZones.qsoZone(out[0], 'cq'), '15');
  assert.strictEqual(String(CallZones.qsoZone(out[1], 'itu')), '28');
});

// ---------------------------------------------------------- cluster nodes
console.log('cluster node choice:');
const NODES = [
  { id: 'a', name: 'W3LPL', host: 'w3lpl.net', port: 7373, enabled: true, password: 'secret' },
  { id: 'b', name: 'VE7CC', host: 'dxc.ve7cc.net', port: 23, enabled: false },
  { id: 'c', name: 'Local', host: '192.168.1.5', port: 7300, enabled: true },
  { id: 'd', name: 'Four', host: 'four.example', port: 23, enabled: true },
];
test('the menu list carries id/name/host/enabled/connected and never a password or port', () => {
  const list = ClusterNodeChoice.nodesForMenu(NODES);
  assert.strictEqual(list.length, 4);
  for (const n of list) assert.deepStrictEqual(Object.keys(n).sort(), ['connected', 'enabled', 'host', 'id', 'name']);
  // connected = the node's session is up; a switched-off node is never "connected".
  const up = ClusterNodeChoice.nodesForMenu(NODES, (id) => id === 'a' || id === 'b');
  for (const n of up) assert.strictEqual(n.connected, n.enabled && (n.id === 'a' || n.id === 'b'), n.id);
  assert.ok(!JSON.stringify(list).includes('secret'));
  assert.deepStrictEqual(ClusterNodeChoice.nodesForMenu(undefined), []);
});
test('turning a node off works and returns a new list', () => {
  const r = ClusterNodeChoice.setNodeEnabled(NODES, 'a', false);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.nodes[0].enabled, false);
  assert.strictEqual(NODES[0].enabled, true, 'input untouched');
  assert.strictEqual(r.nodes[0].password, 'secret', 'the stored node keeps its password');
});
test('a fourth enabled node is refused', () => {
  const three = NODES.map((n) => ({ ...n, enabled: n.id !== 'b' && n.id !== 'd' ? true : n.id === 'd' }));
  const r = ClusterNodeChoice.setNodeEnabled(three, 'b', true);
  assert.ok(r.error && /At most 3/.test(r.error));
});
test('an unknown id is refused and never adds a node', () => {
  const r = ClusterNodeChoice.setNodeEnabled(NODES, 'zzz', true);
  assert.ok(r.error);
  assert.ok(!r.nodes);
});
test('setting a node to what it already is is not a change', () => {
  assert.strictEqual(ClusterNodeChoice.setNodeEnabled(NODES, 'b', false).changed, false);
});

// ---------------------------------------------------------- source guards
console.log('wiring (source guards):');
const main = src('main.js');
const app = src('renderer/app.js');
const html = src('renderer/index.html');
const remote = src('renderer/remote.js');
const remoteHtml = src('renderer/remote.html');
const rs = src('lib/remote-server.js');
const proto = src('lib/echocat-protocol.js');
const popout = src('renderer/qso-popout.js');
const preload = src('preload.js');

test('main stamps zones on merged spots and derives logbook zones', () => {
  assert.ok(/CallZones\.stampSpotZones\(merged, callZonesOf\)/.test(main));
  const n = (main.match(/CallZones\.withQsoZones\(/g) || []).length;
  assert.ok(n >= 3, 'every logbook row path (desktop ipc, remote get-all-qsos, live push) — found ' + n);
});
test('every spot processor that has a spotter passes it on', () => {
  for (const fn of ['processPotaSpots', 'processSotaSpots', 'processWwffSpots', 'processGmaSpots', 'processParcSpots', 'processWwbotaSpots']) {
    const i = main.indexOf('function ' + fn + '(');
    assert.ok(i > 0, fn + ' exists');
    const body = main.slice(i, main.indexOf('\nfunction ', i + 10));
    assert.ok(/spotter:/.test(body), fn + ' carries spotter');
  }
});
test('one cluster-node writer, reached from desktop IPC and ECHOCAT', () => {
  assert.ok(/function applyClusterNodeChoice\(/.test(main));
  assert.ok(/ipcMain\.handle\('cluster-node-enable'[\s\S]{0,200}applyClusterNodeChoice/.test(main));
  const i = main.indexOf("remoteServer.on('set-cluster-node'");
  assert.ok(i > 0);
  const cr = main.indexOf('function connectRemote(');
  assert.ok(cr > 0 && i > cr, 'listener lives inside connectRemote (rewire rule)');
  assert.ok(/clusterNodeChoices: ClusterNodeChoice\.nodesForMenu\(settings\.clusterNodes, clusterNodeConnected\),/.test(main));
  assert.ok(/clusterNodeMax: ClusterNodeChoice\.MAX_ENABLED,/.test(main), 'the limit is advertised');
  assert.ok(/type: 'cluster-node-result', ok: !!r\.ok, error: r\.ok \? undefined : r\.error, reqId \}/.test(main), 'every request answered with its reqId');
});
test('the server refuses a Guest Pass and the protocol registers both messages', () => {
  const i = rs.indexOf("case 'set-cluster-node'");
  assert.ok(i > 0);
  assert.ok(/_passSession/.test(rs.slice(i, i + 600)), 'Guest Pass refused');
  assert.ok(/'cluster-node-choice'/.test(rs), 'hello capability');
  assert.ok(/'set-cluster-node'/.test(proto) && /'cluster-node-result'/.test(proto));
});
test('desktop: spotter/cqz/ituz columns exist and start hidden', () => {
  for (const k of ['spotter', 'cqz', 'ituz']) {
    assert.ok(new RegExp('data-col="' + k + '"').test(html), 'th ' + k);
    assert.ok(new RegExp('\\.hide-col-' + k).test(src('renderer/styles.css')), 'hide rule ' + k);
  }
  assert.ok(/'comments','grid','wpm','spotter','cqz','ituz'/.test(app.replace(/\s/g, '')), 'hidden by default');
  assert.ok(/clusterNodeEnable/.test(preload) && /renderClusterNodeChoices/.test(app));
  assert.ok(/id="spots-cluster-nodes"/.test(html));
});
test('desktop Logbook window: CQZ/ITUZ columns off by default', () => {
  assert.ok(/key:\s*'CQZ'[\s\S]{0,200}off:\s*true/.test(popout));
  assert.ok(/key:\s*'ITUZ'[\s\S]{0,200}off:\s*true/.test(popout));
});
test('web: cards, logbook and cluster node list', () => {
  for (const k of ['spotter', 'cqz', 'ituz']) assert.ok(new RegExp(k + ': colPrefs\\.' + k + ' === true').test(remote), 'web ' + k + ' off by default');
  assert.ok(/id="rc-cluster-nodes"/.test(remoteHtml));
  assert.ok(/type: 'set-cluster-node'/.test(remote));
  assert.ok(/case 'cluster-node-result'/.test(remote));
  assert.ok(/msg\.settings\.clusterNodeChoices/.test(remote));
  assert.ok(/data-field="CQZ"/.test(remote) && /data-field="ITUZ"/.test(remote));
  // A derived zone is a placeholder, never a saved value.
  assert.ok(/data-orig=/.test(remote) && /input\.dataset\.orig === ''/.test(remote));
  assert.ok(!/innerHTML[^;]*clusterNode/.test(remote), 'node names never go through innerHTML');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
