#!/usr/bin/env node
'use strict';
// QRZ lookup queue (CQ WW CW review, 2026-11-25). CW Spots and DX Cluster
// spots look up every new call on the operator's own QRZ.com account; a
// contest burst fired one HTTPS request per call at once, N parallel logins
// (N failed ones with a bad password), and retried a call that timed out on
// every later spot. Now: at most 2 lookups in flight, starts >= 250 ms apart,
// the operator's own lookups ahead of spot lookups, a bounded queue that drops
// the oldest spot lookup, one shared login, and a 2-minute failure cache.
// A fake https.get stands in for QRZ; no request leaves the machine.
// Run: node test/qrz-lookup-queue-test.js
const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

// --- Fake QRZ ---
const fake = {
  log: [],          // { kind: 'login' | 'lookup', call, at }
  inFlight: 0,
  maxInFlight: 0,
  latency: 40,
  password: 'right',
  fail: new Set(),  // calls whose lookup errors at the network
  hold: null,       // when set, responses wait on this promise
  reset() { this.log = []; this.inFlight = 0; this.maxInFlight = 0; this.latency = 40; this.password = 'right'; this.fail = new Set(); this.hold = null; },
};
https.get = function fakeGet(url, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const u = new URL(url);
  const req = new EventEmitter();
  req.destroy = (err) => { if (err) setImmediate(() => req.emit('error', err)); };
  const isLogin = u.searchParams.has('username');
  const call = u.searchParams.get('callsign');
  fake.log.push({ kind: isLogin ? 'login' : 'lookup', call, at: Date.now() });
  fake.inFlight++;
  fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
  const answer = async () => {
    await new Promise((r) => setTimeout(r, fake.latency));
    if (fake.hold) await fake.hold;
    fake.inFlight--;
    if (!isLogin && fake.fail.has(call)) { req.emit('error', new Error('ECONNRESET')); return; }
    let body;
    if (isLogin) {
      body = u.searchParams.get('password') === fake.password
        ? '<QRZDatabase><Session><Key>KEY1</Key><SubExp>2030-01-01</SubExp></Session></QRZDatabase>'
        : '<QRZDatabase><Session><Error>Username/password incorrect</Error></Session></QRZDatabase>';
    } else {
      body = `<QRZDatabase><Callsign><call>${call}</call><fname>Ann</fname><grid>FN31pr</grid></Callsign><Session><Key>KEY1</Key></Session></QRZDatabase>`;
    }
    const res = new EventEmitter();
    cb(res);
    res.emit('data', body);
    res.emit('end');
  };
  answer();
  return req;
};

const { QrzClient } = require('../lib/qrz');
function client(password) {
  const c = new QrzClient();
  c.configure('K3SBP', password || 'right');
  return c;
}
const lookups = () => fake.log.filter((e) => e.kind === 'lookup');
const logins = () => fake.log.filter((e) => e.kind === 'login');
const calls = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix || 'K'}${i}AA`);

let pass = 0, fail = 0;
async function test(name, fn) {
  fake.reset();
  const realConsoleError = console.error;
  console.error = () => {};
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  finally { console.error = realConsoleError; }
}

(async () => {
  await test('a burst of 8 spot lookups: at most 2 in flight, starts at least ~250 ms apart', async () => {
    const c = client();
    await c.login();
    fake.log = [];
    const res = await Promise.all(calls(8).map((cs) => c.lookup(cs, { priority: 'low' })));
    assert.ok(res.every((r) => r && r.grid === 'FN31pr'), 'every lookup answered');
    assert.ok(fake.maxInFlight <= 2, `max in flight was ${fake.maxInFlight}`);
    const starts = lookups().map((e) => e.at);
    assert.strictEqual(starts.length, 8);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] - starts[i - 1] >= 240, `start ${i} came ${starts[i] - starts[i - 1]} ms after the one before`);
    }
  });

  await test('the operator\'s lookup goes ahead of spot lookups already waiting', async () => {
    const c = client();
    await c.login();
    fake.log = [];
    const spots = calls(6, 'W').map((cs) => c.lookup(cs, { priority: 'low' }));
    const mine = c.lookup('K3SBP'); // default: the operator's own (Log QSO, a typed call)
    await Promise.all([...spots, mine]);
    const order = lookups().map((e) => e.call);
    // Two spot lookups may already have started; the operator's is next.
    assert.ok(order.indexOf('K3SBP') <= 2, `operator lookup ran at position ${order.indexOf('K3SBP')}: ${order.join(' ')}`);
  });

  await test('an operator lookup for a call waiting as a spot lookup moves it up', async () => {
    const c = client();
    await c.login();
    fake.log = [];
    const spots = calls(6, 'N').map((cs) => c.lookup(cs, { priority: 'low' }));
    const mine = c.lookup('N5AA');
    await Promise.all([...spots, mine]);
    const order = lookups().map((e) => e.call);
    assert.strictEqual(order.filter((x) => x === 'N5AA').length, 1, 'looked up once');
    assert.ok(order.indexOf('N5AA') <= 2, `ran at position ${order.indexOf('N5AA')}: ${order.join(' ')}`);
  });

  await test('the queue holds 200: the oldest spot lookups are dropped, the operator\'s never', async () => {
    const c = client();
    await c.login();
    fake.log = [];
    let release;
    fake.hold = new Promise((r) => { release = r; });
    // 2 start at once and stall on the hold; 200 more fill the queue.
    const first = calls(2, 'F').map((cs) => c.lookup(cs, { priority: 'low' }));
    await new Promise((r) => setTimeout(r, 300)); // second start waits out the spacing
    const queued = calls(200, 'Q').map((cs) => c.lookup(cs, { priority: 'low' }));
    const mine = c.lookup('K3SBP');               // queue full: drops Q0
    const extra = calls(3, 'X').map((cs) => c.lookup(cs, { priority: 'low' })); // drop Q1..Q3
    const settled = await Promise.race([
      Promise.all(queued.slice(0, 4)).then((v) => v),
      new Promise((r) => setTimeout(() => r('still waiting'), 200)),
    ]);
    assert.deepStrictEqual(settled, [null, null, null, null], 'the 4 oldest spot lookups were dropped (null)');
    assert.strictEqual(lookups().length, 2, 'no request for a dropped lookup');
    // Clear the 197 still waiting rather than run them 250 ms apart.
    if (c._qLow) c._qLow.splice(0).forEach((e) => e.resolve(null));
    release();
    const r = await mine;
    assert.ok(r && r.call === 'K3SBP', 'the operator\'s lookup still ran');
    await Promise.all([...first, ...extra, ...queued]);
  });

  await test('a burst needing a session sends one login', async () => {
    const c = client();
    const res = await Promise.all(calls(5, 'L').map((cs) => c.lookup(cs)));
    assert.ok(res.every((r) => r && r.call), 'every lookup answered');
    assert.strictEqual(logins().length, 1, `${logins().length} logins`);
  });

  await test('a bad password in a burst of 10: exactly 1 failed login reaches QRZ', async () => {
    const c = client('wrong');
    const res = await Promise.all(calls(10, 'B').map((cs) => c.lookup(cs, { priority: 'low' })));
    assert.ok(res.every((r) => r === null));
    assert.strictEqual(logins().length, 1, `${logins().length} logins`);
    assert.strictEqual(lookups().length, 0, 'no lookup without a session');
  });

  await test('a network error is remembered 2 minutes for spot lookups, then retried', async () => {
    const c = client();
    await c.login();
    fake.log = [];
    fake.fail.add('E1AA');
    assert.strictEqual(await c.lookup('E1AA', { priority: 'low' }), null);
    assert.strictEqual(lookups().length, 1);
    assert.strictEqual(await c.lookup('E1AA', { priority: 'low' }), null);
    assert.strictEqual(await c.lookup('E1AA', { priority: 'low' }), null);
    assert.strictEqual(lookups().length, 1, 'not asked again on every spot');
    assert.strictEqual(c.cached('E1AA'), undefined, 'not put in the not-found cache');
    fake.fail.clear();
    const realNow = Date.now;
    const t0 = realNow();
    try {
      Date.now = () => t0 + 60 * 1000;
      assert.strictEqual(await c.lookup('E1AA', { priority: 'low' }), null, 'still skipped at 1 min');
      assert.strictEqual(lookups().length, 1);
      Date.now = () => t0 + 121 * 1000;
      const r = await c.lookup('E1AA', { priority: 'low' });
      assert.ok(r && r.call === 'E1AA', 'looked up again after 2 min');
      assert.strictEqual(lookups().length, 2);
    } finally { Date.now = realNow; }
  });

  await test('cache hits answer at once while the queue is busy', async () => {
    const c = client();
    await c.login();
    c._cache.set('C1AA', { call: 'C1AA', grid: 'FN20' });
    c._cache.set('C2AA', null);
    fake.log = [];
    fake.latency = 400;
    const busy = calls(10, 'D').map((cs) => c.lookup(cs, { priority: 'low' }));
    const t = Date.now();
    const hit = await c.lookup('C1AA', { priority: 'low' });
    const miss = await c.lookup('C2AA');
    assert.ok(Date.now() - t < 50, `cache answered after ${Date.now() - t} ms`);
    assert.strictEqual(hit.grid, 'FN20');
    assert.strictEqual(miss, null);
    if (c._qLow) c._qLow.splice(0).forEach((e) => e.resolve(null));
    await Promise.all(busy);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
