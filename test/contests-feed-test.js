#!/usr/bin/env node
'use strict';
// lib/contests-feed.js — the desktop half of docs/contests-feed.md.
// Run: node test/contests-feed-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ContestsFeed, validateFeed, nextOccurrence } = require('../lib/contests-feed');
const db = require('../lib/contests-db');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ' + name); },
    (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); },
  ));
}

const bundled = db.getAllContests();
function feedFrom(entries, generated = '2026-09-27T06:00:00.000Z') {
  return {
    schemaVersion: 2, generated, catalogSha: 'x' + generated,
    contests: entries.map((c) => ({ ...c, occurrences: c.occurrences || [], links: c.links || { website: 'ok', rulesUrl: 'ok' } })),
  };
}
function sampleEntries() {
  return bundled.slice(0, 20).map((c) => ({ ...c }));
}
function memFs(initial) {
  const files = new Map(Object.entries(initial || {}));
  return { files, read: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); }, write: (p, s) => files.set(p, s) };
}
function make({ fsImpl, responses }) {
  const calls = [];
  const feed = new ContestsFeed({
    cachePath: 'cache.json',
    bundled: () => bundled,
    resolveLocal: (c, now) => db.resolveOccurrence(c, now),
    fs: fsImpl || memFs(),
    fetch: async (url, headers) => { calls.push({ url, headers }); const r = responses.shift(); if (r instanceof Error) throw r; return r; },
  });
  return { feed, calls };
}

console.log('contests feed');

test('validateFeed accepts a good feed and refuses bad ones', () => {
  assert.strictEqual(validateFeed(feedFrom(sampleEntries())), null);
  assert.ok(validateFeed({ schemaVersion: 1, contests: [] }));
  assert.ok(validateFeed(feedFrom(sampleEntries().slice(0, 3))), 'too few');
  const dup = sampleEntries(); dup[1].id = dup[0].id;
  assert.ok(/duplicate/.test(validateFeed(feedFrom(dup))));
  const bad = sampleEntries(); bad[0].occurrences = [{ start: 'nope', end: 'x' }];
  assert.ok(/bad occurrence/.test(validateFeed(feedFrom(bad))));
});

test('nextOccurrence picks the first whose END is after now (a running one counts)', () => {
  const occ = [
    { start: '2026-09-19T00:00:00Z', end: '2026-09-21T00:00:00Z' },
    { start: '2026-09-26T00:00:00Z', end: '2026-09-28T00:00:00Z' },
    { start: '2026-10-03T00:00:00Z', end: '2026-10-05T00:00:00Z' },
  ];
  assert.strictEqual(nextOccurrence(occ, new Date('2026-09-27T12:00:00Z')).start.toISOString(), '2026-09-26T00:00:00.000Z');
  assert.strictEqual(nextOccurrence(occ, new Date('2026-09-29T00:00:00Z')).start.toISOString(), '2026-10-03T00:00:00.000Z');
  assert.strictEqual(nextOccurrence(occ, new Date('2026-10-06T00:00:00Z')), null);
});

test('no feed: the bundled catalog and local resolver answer', () => {
  const { feed } = make({ responses: [] });
  assert.strictEqual(feed.hasFeed(), false);
  assert.strictEqual(feed.catalog().length, bundled.length);
  const r = feed.resolvedAt(new Date('2026-09-27T00:00:00Z'));
  assert.strictEqual(r.length, bundled.length);
  assert.deepStrictEqual(r.find((c) => c.id === 'cq-ww-ssb').start, db.resolveOccurrence(bundled.find((c) => c.id === 'cq-ww-ssb'), new Date('2026-09-27T00:00:00Z')).start);
});

test('a fetched feed wins: its dates, its entries, dead rules link falls back to the website', async () => {
  const entries = sampleEntries();
  entries[0] = { ...entries[0], id: 'brand-new-event', name: 'Brand New Event', website: 'https://example.org/', rulesUrl: 'https://example.org/rules',
    occurrences: [{ start: '2026-10-10T00:00:00Z', end: '2026-10-11T00:00:00Z' }], links: { website: 'ok', rulesUrl: 'dead' } };
  const body = JSON.stringify(feedFrom(entries));
  const { feed } = make({ responses: [{ status: 200, etag: '"e1"', body }] });
  let updated = 0; feed.on('updated', () => updated++);
  assert.strictEqual(await feed.refresh(), 'updated');
  assert.strictEqual(updated, 1);
  const cat = feed.catalog();
  assert.strictEqual(cat.length, 20);
  const nb = cat.find((c) => c.id === 'brand-new-event');
  assert.strictEqual(nb.rulesUrl, 'https://example.org/', 'dead rules link replaced by website');
  assert.ok(!('occurrences' in nb) && !('links' in nb), 'feed-only fields stripped');
  const r = feed.resolvedAt(new Date('2026-09-27T00:00:00Z'));
  assert.strictEqual(r.find((c) => c.id === 'brand-new-event').start.toISOString(), '2026-10-10T00:00:00.000Z');
});

test('conditional GET: sends the ETag, a 304 changes nothing and emits nothing', async () => {
  const body = JSON.stringify(feedFrom(sampleEntries()));
  const { feed, calls } = make({ responses: [{ status: 200, etag: '"e1"', body }, { status: 304 }] });
  await feed.refresh();
  let updated = 0; feed.on('updated', () => updated++);
  assert.strictEqual(await feed.refresh(), 'unchanged');
  assert.strictEqual(calls[1].headers['If-None-Match'], '"e1"');
  assert.strictEqual(updated, 0);
});

test('bad responses keep the last good feed', async () => {
  const good = JSON.stringify(feedFrom(sampleEntries()));
  const { feed } = make({ responses: [
    { status: 200, etag: '"e1"', body: good },
    { status: 200, etag: '"e2"', body: '{not json' },
    { status: 200, etag: '"e3"', body: JSON.stringify({ schemaVersion: 2, contests: [] }) },
    { status: 503, body: '' },
    new Error('offline'),
  ] });
  await feed.refresh();
  assert.strictEqual(await feed.refresh(), 'rejected');
  assert.strictEqual(await feed.refresh(), 'rejected');
  assert.strictEqual(await feed.refresh(), 'failed');
  assert.strictEqual(await feed.refresh(), 'failed');
  assert.strictEqual(feed.catalog().length, 20);
});

test('the cache survives a restart; a corrupt cache is ignored', async () => {
  const fsImpl = memFs();
  const body = JSON.stringify(feedFrom(sampleEntries()));
  await make({ fsImpl, responses: [{ status: 200, etag: '"e1"', body }] }).feed.refresh();
  const again = make({ fsImpl, responses: [] }).feed;
  assert.strictEqual(again.load(), true);
  assert.strictEqual(again.catalog().length, 20);
  const broken = make({ fsImpl: memFs({ 'cache.json': '{"feed":{"schemaVersion":2,"contests":[]}}' }), responses: [] }).feed;
  assert.strictEqual(broken.load(), false);
  assert.strictEqual(broken.catalog().length, bundled.length);
});

test('an entry whose occurrences ran out falls back to the local resolver', async () => {
  const entries = sampleEntries();
  const cqww = bundled.find((c) => c.id === 'cq-ww-ssb');
  entries[0] = { ...cqww, occurrences: [{ start: '2025-10-25T00:00:00Z', end: '2025-10-27T00:00:00Z' }] };
  const { feed } = make({ responses: [{ status: 200, etag: '"e1"', body: JSON.stringify(feedFrom(entries)) }] });
  await feed.refresh();
  const now = new Date('2026-09-27T00:00:00Z');
  assert.deepStrictEqual(feed.resolvedAt(now).find((c) => c.id === 'cq-ww-ssb').start, db.resolveOccurrence(cqww, now).start);
});

test('main.js reads contests only through the feed; the row Rules link uses the contest allowlist', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const bare = main.split('\n').filter((l) => /getAllContests\(\)/.test(l) && !/bundled: \(\) => contestsDb\.getAllContests\(\)/.test(l));
  assert.deepStrictEqual(bare, [], 'bundled catalog read directly:\n' + bare.join('\n'));
  assert.ok(/const resolved = contestsFeed\.resolvedAt\(now\);/.test(main));
  assert.ok(/setInterval\(\(\) => \{ contestsFeed\.refresh\(\)/.test(main));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/window\.api\.openContestUrl\(url\); \/\/ the contest-catalog allowlist/.test(app));
  assert.ok(/window\.api\.onContestsUpdated\(/.test(app));
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
