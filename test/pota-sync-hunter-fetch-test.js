#!/usr/bin/env node
'use strict';
// The hunter log download always settles (K3SBP review, 2026-11): a pota.app
// request that hangs used to leave the import's running flag set, so both
// buttons said "already running" until a restart. _getJson now aborts on a
// timeout and on an oversized reply, settles exactly once, and the whole
// download is capped. A reply with no usable count still downloads every
// page. Runs lib/pota-sync.js against a stubbed electron `net`.
// Run: node test/pota-sync-hunter-fetch-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// --- electron stub: net.request hands back a FakeRequest the test scripts ---
let script = () => {}; // (req) => void, run on req.end()
const made = [];
class FakeRequest extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.headers = {}; this.aborted = false; made.push(this); }
  setHeader(k, v) { this.headers[k] = v; }
  end() { script(this); }
  abort() { this.aborted = true; this.emit('abort'); } // Electron emits abort, not error
}
const respond = (req, status = 200) => {
  const res = new EventEmitter();
  res.statusCode = status;
  req.emit('response', res);
  return res;
};
const electronStub = { net: { request: (opts) => new FakeRequest(opts) }, session: {}, BrowserWindow: function () {} };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};
const { PotaSync, LOGBOOK_TIMEOUT_MS, LOGBOOK_MAX_BYTES, LOGBOOK_MAX_ENTRIES } = require('../lib/pota-sync');
Module._load = origLoad;

const newSync = () => {
  const s = new PotaSync({ settings: { potaSync: { connectedAt: 1 } }, logger: () => {} });
  s._getActiveToken = async () => ({ token: 'tok' });
  return s;
};
const rejectsWith = async (p, re) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, 'expected a rejection');
  assert.ok(re.test(err.message), `message "${err.message}" should match ${re}`);
  return err;
};

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the limits are what the review asked for: 20-30 s, a size cap, an entry cap', async () => {
  assert.ok(LOGBOOK_TIMEOUT_MS >= 20000 && LOGBOOK_TIMEOUT_MS <= 30000, String(LOGBOOK_TIMEOUT_MS));
  assert.strictEqual(LOGBOOK_TIMEOUT_MS, 25000);
  assert.strictEqual(LOGBOOK_MAX_BYTES, 5 * 1024 * 1024);
  assert.strictEqual(LOGBOOK_MAX_ENTRIES, 500000);
});

test('a normal reply resolves { status, text, json } with the bare token', async () => {
  script = (req) => { const res = respond(req); res.emit('data', Buffer.from('{"count":1,')); res.emit('data', Buffer.from('"entries":[]}')); res.emit('end'); };
  const r = await newSync()._getJson('https://x/', 'tok', { timeoutMs: 1000 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { count: 1, entries: [] });
  assert.strictEqual(made[made.length - 1].headers.Authorization, 'tok');
  assert.strictEqual(made[made.length - 1].aborted, false);
});

test('a non-2xx reply still resolves (fetchHunterLog decides), non-JSON body gives json null', async () => {
  script = (req) => { const res = respond(req, 502); res.emit('data', Buffer.from('<html>bad gateway')); res.emit('end'); };
  const r = await newSync()._getJson('https://x/', 'tok', { timeoutMs: 1000 });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.json, null);
});

test('a request that never answers is aborted and rejects at the timeout', async () => {
  script = () => {}; // hang
  const t0 = Date.now();
  await rejectsWith(newSync()._getJson('https://x/', 'tok', { timeoutMs: 60 }), /did not answer within/);
  assert.ok(Date.now() - t0 < 2000, 'rejected promptly');
  assert.strictEqual(made[made.length - 1].aborted, true, 'request aborted');
});

test('a reply that starts but never finishes is aborted at the same timeout', async () => {
  script = (req) => { const res = respond(req); res.emit('data', Buffer.from('{"count":')); };
  await rejectsWith(newSync()._getJson('https://x/', 'tok', { timeoutMs: 60 }), /did not answer within/);
  assert.strictEqual(made[made.length - 1].aborted, true);
});

test('the timeout message names the seconds', async () => {
  script = () => {};
  await rejectsWith(newSync()._getJson('https://x/', 'tok', { timeoutMs: 2000 }), /within 2 s\./);
});

test('a reply larger than the cap is aborted and rejects, without buffering the rest', async () => {
  let res;
  script = (req) => { res = respond(req); res.emit('data', Buffer.alloc(8)); res.emit('data', Buffer.alloc(8)); res.emit('data', Buffer.alloc(8)); res.emit('end'); };
  await rejectsWith(newSync()._getJson('https://x/', 'tok', { timeoutMs: 1000, maxBytes: 10 }), /larger than/);
  assert.strictEqual(made[made.length - 1].aborted, true);
});

test('settles once: the abort event and late reply events after a timeout change nothing', async () => {
  let req;
  script = (r) => { req = r; };
  // The timeout's own abort() emits 'abort' synchronously; the rejection must
  // still be the timeout's message, not "aborted".
  await rejectsWith(newSync()._getJson('https://x/', 'tok', { timeoutMs: 30 }), /did not answer within/);
  const res = respond(req); // the reply turns up late
  res.emit('data', Buffer.from('{}'));
  res.emit('end');
  req.emit('error', new Error('late error'));
  // Nothing to assert beyond "no throw, no unhandled rejection": the promise
  // already rejected once.
});

test('a network error and a mid-reply disconnect reject', async () => {
  script = (req) => req.emit('error', new Error('net::ERR_CONNECTION_RESET'));
  await rejectsWith(newSync()._getJson('https://x/', 'tok', { timeoutMs: 1000 }), /ERR_CONNECTION_RESET/);
  script = (req) => { const res = respond(req); res.emit('data', Buffer.from('{')); res.emit('aborted'); };
  await rejectsWith(newSync()._getJson('https://x/', 'tok', { timeoutMs: 1000 }), /closed the connection mid-reply/);
});

test('fetchHunterLog: a hung page fails the download instead of hanging it', async () => {
  script = () => {};
  const s = newSync();
  const real = PotaSync.prototype._getJson;
  s._getJson = (u, t) => real.call(s, u, t, { timeoutMs: 50 }); // the default is 25 s
  await rejectsWith(s.fetchHunterLog(), /did not answer within/);
});

test('fetchHunterLog: a download past the entry cap fails, nothing returned', async () => {
  // A server that reports a huge count and always sends a full page.
  const page = Array.from({ length: 100 }, () => ({}));
  const s = newSync();
  let pages = 0;
  s._getJson = async () => { pages++; return { status: 200, json: { count: 1e9, entries: page } }; };
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => setImmediate(fn); // skip the 250 ms page delay (5,001 pages)
  try {
    await rejectsWith(s.fetchHunterLog(), /larger than 500,000 entries; nothing was imported/);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.strictEqual(pages, LOGBOOK_MAX_ENTRIES / 100 + 1, 'stopped on the first page past the cap');
});

test('fetchHunterLog: a normal log still downloads page by page', async () => {
  const s = newSync();
  const urls = [];
  s._getJson = async (u) => {
    urls.push(u);
    const p = urls.length;
    return { status: 200, json: { count: 150, entries: Array.from({ length: p === 1 ? 100 : 50 }, () => ({})) } };
  };
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => setImmediate(fn);
  try {
    const { entries, count } = await s.fetchHunterLog();
    assert.strictEqual(entries.length, 150);
    assert.strictEqual(count, 150);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(/page=1&size=100/.test(urls[0]) && /page=2&size=100/.test(urls[1]));
});

// A missing count must not end the download after page 1 (review, 2026-11-03):
// Number(undefined) || 0 read as "0 entries", and 100 >= 0 stopped the loop.
const pagedServer = (count, total) => {
  const s = newSync();
  const calls = { pages: 0, progress: [] };
  s._getJson = async () => {
    calls.pages++;
    const left = total - (calls.pages - 1) * 100;
    return { status: 200, json: { count, entries: Array.from({ length: Math.max(0, Math.min(100, left)) }, () => ({})) } };
  };
  return { s, calls };
};
const fastPages = async (fn) => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (f) => setImmediate(f);
  try { return await fn(); } finally { global.setTimeout = realSetTimeout; }
};
test('fetchHunterLog: no count, a zero count or a non-numeric one still downloads every page', async () => {
  for (const count of [undefined, null, 0, '', 'abc', -5]) {
    const { s, calls } = pagedServer(count, 250);
    const r = await fastPages(() => s.fetchHunterLog({ onProgress: (p) => calls.progress.push(p) }));
    assert.strictEqual(r.entries.length, 250, `count=${JSON.stringify(count)}`);
    assert.strictEqual(calls.pages, 3, 'stopped on the short third page');
    assert.strictEqual(r.count, 0, 'an unknown total is reported as 0');
    assert.deepStrictEqual(calls.progress.map((p) => p.count), [0, 0, 0]);
  }
});
test('fetchHunterLog: no count and an exact multiple of the page size ends on the empty page', async () => {
  const { s, calls } = pagedServer(undefined, 200);
  const r = await fastPages(() => s.fetchHunterLog());
  assert.strictEqual(r.entries.length, 200);
  assert.strictEqual(calls.pages, 3, 'pages of 100, 100, then 0');
});
test('fetchHunterLog: a known count still stops on reaching it (no extra request)', async () => {
  const { s, calls } = pagedServer(200, 200);
  const r = await fastPages(() => s.fetchHunterLog());
  assert.strictEqual(r.entries.length, 200);
  assert.strictEqual(r.count, 200);
  assert.strictEqual(calls.pages, 2);
});
test('fetchHunterLog: a known count stays bounded by its page guard if the server ignores `page`', async () => {
  const s = newSync();
  let pages = 0;
  s._getJson = async () => { pages++; return { status: 200, json: { count: 150, entries: Array.from({ length: 100 }, () => ({})) } }; };
  const r = await fastPages(() => s.fetchHunterLog());
  assert.strictEqual(pages, 2, 'reached the count after two full pages');
  assert.strictEqual(r.entries.length, 200);
});
test('Settings + main: an unknown total reads as such, never "of 0"', async () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pota-sync-ui.js'), 'utf8');
  assert.ok(ui.includes('`Downloading… ${p.fetched.toLocaleString()} entries`'));
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes("const reportedText = count ? count.toLocaleString() : 'no total';"));
  assert.ok(!main.includes('(POTA.app reports ${count.toLocaleString()})'));
});

// The 'POTA.app user' placeholder is a display label, not a call (K3SBP
// review): it must not reach the hunter import's own-call check.
const withConnectedAs = (v) => {
  const s = new PotaSync({ settings: { potaSync: { connectedAt: 1, connectedAs: v } }, logger: () => {} });
  return s;
};
test('connectedCallsign: the placeholder and other non-calls are not a callsign', async () => {
  for (const v of ['POTA.app user', '', null, undefined, '   ', 'not a call', 'K1ABC <x>']) {
    assert.strictEqual(withConnectedAs(v).connectedCallsign(), '', JSON.stringify(v));
  }
  assert.strictEqual(new PotaSync({ settings: {}, logger: () => {} }).connectedCallsign(), '', 'never connected');
});
test('connectedCallsign: a real call comes back upper-cased and trimmed', async () => {
  assert.strictEqual(withConnectedAs('K1ABC').connectedCallsign(), 'K1ABC');
  assert.strictEqual(withConnectedAs(' ve3/k1abc ').connectedCallsign(), 'VE3/K1ABC');
  assert.strictEqual(withConnectedAs('K1ABC/P').connectedCallsign(), 'K1ABC/P');
});
test('pull() still refuses the placeholder, through the same rule, without a request', async () => {
  const before = made.length;
  const r = await withConnectedAs('POTA.app user').pull();
  assert.strictEqual(r.ok, false);
  assert.ok(/Could not read your callsign/.test(r.error), r.error);
  assert.strictEqual(made.length, before, 'no network request made');
  assert.ok(/const callsign = this\.connectedCallsign\(\);/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pota-sync.js'), 'utf8')));
});
test('main: the hunter import\'s own calls use connectedCallsign, not the display label', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('pota-hunter-import'");
  const h = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  assert.ok(h.includes('const myCalls = [settings.myCallsign, potaSync.connectedCallsign()].filter(Boolean);'));
  assert.ok(!h.includes('status().connectedAs'), 'the raw connectedAs is not used');
});

test('main: the import always clears its running flag, so a failed download frees the buttons', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('pota-hunter-import'");
  const h = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  const set = h.indexOf('potaHunterImportRunning = true;');
  const tryAt = h.indexOf('try {', set);
  const fetch = h.indexOf('potaSync.fetchHunterLog(', tryAt);
  assert.ok(set > 0 && tryAt > set && fetch > tryAt, 'the download runs inside the try');
  assert.ok(/\} finally \{\s*potaHunterImportRunning = false;\s*\}/.test(h), 'finally clears the flag');
});

// A hang regression must FAIL, not pass: a promise that never settles leaves
// Node with nothing to do, and it would exit 0 mid-run. beforeExit catches
// that; the watchdog catches a hang that keeps a timer alive.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) { console.log('  FAIL a test never settled (a request hung with no timeout)'); process.exit(1); }
});
const watchdog = setTimeout(() => { console.log('  FAIL the suite hung for 60 s'); process.exit(1); }, 60000);

(async () => {
  console.log('POTA.app hunter log download: timeout, size and entry caps');
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  finished = true;
  clearTimeout(watchdog);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
