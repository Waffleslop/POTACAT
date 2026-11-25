'use strict';
// #1061: CW Spots get the same QRZ grid placement as DX Cluster spots, through the one
// lookup path (refineClusterSpotWithQrz: qrz cache, lib/qrz.js lookup queue at low
// priority, enableQrz). The function is lifted out of main.js and run against stubs.
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { readSrc } = require('./_src');
const src = readSrc(path.join(__dirname, '..', 'main.js'));

const start = src.indexOf('function connectCwSpots()');
const end = src.indexOf('function disconnectCwSpots()');
assert(start > 0 && end > start, 'connectCwSpots found');
const body = src.slice(start, end);
assert(/refineClusterSpotWithQrz\(raw\.callsign, spot, myPos, \(\) => cwSpots\)/.test(body),
  'connectCwSpots refines each CW spot through refineClusterSpotWithQrz against cwSpots');
assert(!/qrz\.(lookup|batchLookup)\(/.test(body), 'CW Spots add no second lookup path');

const fs0 = src.indexOf('function refineClusterSpotWithQrz(');
const fe = src.indexOf('let clusterClients', fs0);
assert(fs0 > 0 && fe > fs0, 'refineClusterSpotWithQrz found');
const refineSrc = src.slice(fs0, fe);

function harness({ cache = new Map(), answer = {}, enableQrz = true, configured = true } = {}) {
  const calls = [];
  const timers = [];
  const ctx = {
    clusterSpots: [],
    cwSpots: [],
    clusterFlushTimer: null,
    flushes: 0,
    settings: { enableQrz },
    qrz: {
      configured,
      cached: (c) => (cache.has(c) ? cache.get(c) : undefined),
      lookup: (c, opts) => { calls.push({ c, priority: opts && opts.priority }); return Promise.resolve(answer[c] || null); },
    },
    gridToLatLon: (g) => (g === 'FN20' ? { lat: 40.5, lon: -75 } : g === 'JO62' ? { lat: 52.5, lon: 13 } : null),
    haversineDistanceMiles: () => 1234.4,
    bearing: () => 45.6,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
  };
  ctx.sendMergedSpots = () => { ctx.flushes++; };
  vm.createContext(ctx);
  vm.runInContext(refineSrc + '\nthis.refine = refineClusterSpotWithQrz;', ctx);
  return { ctx, calls, timers };
}
const spot = (callsign, band = '20m') => ({ callsign, band, lat: 51, lon: 10, coordSource: 'cty' });
const myPos = { lat: 39, lon: -77 };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // A new call: one low-priority lookup, the grid lands on the CW spot, a 200 ms flush.
  {
    const h = harness({ answer: { DL1ABC: { grid: 'JO62' } } });
    const s = spot('DL1ABC');
    h.ctx.cwSpots.push(s);
    h.ctx.refine('DL1ABC', s, myPos, () => h.ctx.cwSpots);
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].priority, 'low', 'spot placement waits behind the operator\'s lookups');
    await tick();
    assert.strictEqual(s.coordSource, 'qrz');
    assert.strictEqual(s.grid, 'JO62');
    assert.deepStrictEqual([s.lat, s.lon, s.distance, s.bearing], [52.5, 13, 1234, 46]);
    assert.strictEqual(h.timers.length, 1);
    assert.strictEqual(h.timers[0].ms, 200);
    h.timers[0].fn();
    assert.strictEqual(h.ctx.flushes, 1);
  }

  // The CW list is read when the answer arrives (cwSpots is reassigned when trimmed),
  // and the DX Cluster list is left alone.
  {
    const h = harness({ answer: { DL1ABC: { grid: 'JO62' } } });
    const old = spot('DL1ABC');
    const dx = spot('DL1ABC');
    h.ctx.clusterSpots.push(dx);
    h.ctx.refine('DL1ABC', old, myPos, () => h.ctx.cwSpots);
    const fresh = spot('DL1ABC');
    h.ctx.cwSpots = [fresh];
    await tick();
    assert.strictEqual(fresh.coordSource, 'qrz', 'the spot now in cwSpots is placed');
    assert.strictEqual(dx.coordSource, 'cty', 'a DX Cluster spot of the same call is not touched');
  }

  // DX Cluster callers still default to clusterSpots.
  {
    const h = harness({ answer: { W1AW: { grid: 'FN20' } } });
    const s = spot('W1AW');
    h.ctx.clusterSpots.push(s);
    h.ctx.refine('W1AW', s, myPos);
    await tick();
    assert.strictEqual(s.coordSource, 'qrz');
  }

  // Deduped out before the answer: nothing changes, no flush.
  {
    const h = harness({ answer: { DL1ABC: { grid: 'JO62' } } });
    const s = spot('DL1ABC');
    h.ctx.refine('DL1ABC', s, myPos, () => h.ctx.cwSpots);
    await tick();
    assert.strictEqual(s.coordSource, 'cty');
    assert.strictEqual(h.timers.length, 0);
  }

  // A cached call is placed at once, with no lookup and no extra flush: a stream of
  // known calls must not send the whole spot list every 200 ms.
  {
    const h = harness({ cache: new Map([['DL1ABC', { grid: 'JO62' }], ['K1NF', null]]) });
    for (let i = 0; i < 50; i++) {
      const s = spot('DL1ABC');
      h.ctx.cwSpots = [s];
      h.ctx.refine('DL1ABC', s, myPos, () => h.ctx.cwSpots);
      assert.strictEqual(s.coordSource, 'qrz', 'placed synchronously');
    }
    const nf = spot('K1NF');
    h.ctx.refine('K1NF', nf, myPos, () => h.ctx.cwSpots);
    await tick();
    assert.strictEqual(nf.coordSource, 'cty', 'a cached not-found keeps its fallback');
    assert.strictEqual(h.calls.length, 0, 'no lookups for cached calls');
    assert.strictEqual(h.timers.length, 0, 'no extra flushes for cached calls');
  }

  // QRZ off, QRZ not configured, an event placement, an existing QRZ placement: no lookup.
  {
    for (const opts of [{ enableQrz: false }, { configured: false }]) {
      const h = harness(Object.assign({ cache: new Map([['DL1ABC', { grid: 'JO62' }]]) }, opts));
      const s = spot('DL1ABC');
      h.ctx.refine('DL1ABC', s, myPos, () => h.ctx.cwSpots);
      assert.strictEqual(h.calls.length, 0);
      assert.strictEqual(s.coordSource, 'cty', 'the setting gates the cache path too');
    }
    const h = harness();
    for (const cs of ['event', 'qrz']) {
      const s = Object.assign(spot('W6K'), { coordSource: cs });
      h.ctx.refine('W6K', s, myPos, () => h.ctx.cwSpots);
    }
    assert.strictEqual(h.calls.length, 0);
  }

  // A failed lookup is non-fatal.
  {
    const h = harness();
    h.ctx.qrz.lookup = () => Promise.reject(new Error('net'));
    const s = spot('DL1ABC');
    h.ctx.cwSpots.push(s);
    h.ctx.refine('DL1ABC', s, myPos, () => h.ctx.cwSpots);
    await tick();
    assert.strictEqual(s.coordSource, 'cty');
  }

  console.log('cw-spots-qrz-grid-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
