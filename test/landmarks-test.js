#!/usr/bin/env node
'use strict';
// The Directory's Landmarks tab (Casey 2026-10-29): the catalog, its rules,
// the NCDXF beacon clock, and the wiring on every surface.
// Run: node test/landmarks-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const L = require('../lib/landmarks');
const { LandmarksFeed } = require('../lib/landmarks-feed');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const CATALOG = JSON.parse(R('data/landmarks.json'));
let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { passed++; console.log('  ok  ' + name); }, (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }));
      return;
    }
    passed++; console.log('  ok  ' + name);
  } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const at = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi || 0, s || 0);

// ── The catalog ─────────────────────────────────────────────────────────
test('data/landmarks.json passes the gate with no errors', () => {
  const c = L.sanitizeCatalog(CATALOG);
  assert.deepStrictEqual(c.errors, []);
  assert.ok(c.landmarks.length >= 30, 'at least 30 landmarks');
  assert.deepStrictEqual(c.categories.map((x) => x.id), L.CATEGORY_IDS);
});

test('every landmark is complete after helpFrom: a line, and helper text to read', () => {
  const c = L.sanitizeCatalog(CATALOG);
  for (const lm of c.landmarks) {
    assert.ok(lm.line, lm.id + ' line');
    assert.ok(lm.hear && lm.why, lm.id + ' hear/why');
    assert.ok(!('helpFrom' in lm), lm.id + ' helpFrom is resolved away');
    assert.ok(lm.line.length <= 90, lm.id + ' line fits a row');
  }
  assert.ok(c.landmarks.find((l) => l.id === 'wwv-10000'), 'the first-open hint tunes wwv-10000');
});

test('the helper text is written plainly: no exclamation marks, no em-dashes, no emoji', () => {
  for (const e of CATALOG.landmarks) {
    for (const k of ['name', 'line', 'hear', 'why', 'try', 'region']) {
      const v = e[k] || '';
      assert.ok(!/!/.test(v), `${e.id}.${k} has "!"`);
      assert.ok(!/—/.test(v), `${e.id}.${k} has an em-dash`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(v), `${e.id}.${k} has an emoji`);
    }
  }
});

test('ids are unique; the NCDXF rows are exactly the five beacon frequencies', () => {
  const ids = CATALOG.landmarks.map((l) => l.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  const ncdxf = CATALOG.landmarks.filter((l) => l.ncdxf).map((l) => l.khz).sort((a, b) => a - b);
  assert.deepStrictEqual(ncdxf, L.NCDXF.freqsKhz);
});

test('the gate refuses: bad mode, unknown category, bad hours, http url, helpFrom chains, duplicates', () => {
  const base = { id: 'x', name: 'X', khz: 10000, mode: 'AM', category: 'time', hours: '24h', line: 'l', hear: 'h', why: 'w' };
  const cats = CATALOG.categories;
  const errs = (lms) => L.sanitizeCatalog({ categories: cats, landmarks: lms }).errors;
  assert.deepStrictEqual(errs([base]), []);
  assert.ok(errs([{ ...base, mode: 'DIGI' }]).length);
  assert.ok(errs([{ ...base, category: 'nets' }]).length);
  assert.ok(errs([{ ...base, hours: '25:00-26:00' }]).length);
  assert.ok(errs([{ ...base, hours: 'sometimes' }]).length);
  assert.ok(errs([{ ...base, url: 'http://example.com/' }]).length);
  assert.ok(errs([{ ...base, url: 'javascript:alert(1)' }]).length);
  assert.ok(errs([base, { ...base }]).length, 'duplicate id');
  assert.ok(errs([base, { ...base, id: 'y', hear: '', why: '', helpFrom: 'z' }]).length, 'helpFrom to nothing');
  assert.ok(errs([base, { ...base, id: 'y', hear: '', why: '', helpFrom: 'x' }, { ...base, id: 'z', hear: '', why: '', helpFrom: 'y' }]).length, 'helpFrom chain');
  assert.ok(errs([{ ...base, khz: 14101, ncdxf: true }]).length, 'ncdxf off a beacon frequency');
  assert.ok(L.sanitizeCatalog({ categories: [], landmarks: [base] }).errors.length, 'categories missing');
  assert.ok(L.sanitizeCatalog(null).errors.length);
});

// ── Hours and status ────────────────────────────────────────────────────
test('hours: 24h is always live; blank has no badge', () => {
  assert.strictEqual(L.status({ hours: '24h' }, at(2026, 10, 29, 3)).status, 'live');
  assert.strictEqual(L.status({ hours: '' }, at(2026, 10, 29, 3)).status, 'none');
});

test('hours: daily windows, including one across midnight', () => {
  const s = (h, t) => L.status({ hours: h }, t);
  assert.strictEqual(s('12:00-13:00', at(2026, 10, 29, 12, 30)).status, 'live');
  assert.strictEqual(s('12:00-13:00', at(2026, 10, 29, 12, 30)).label, 'On air, 30m left');
  assert.strictEqual(s('12:00-13:00', at(2026, 10, 29, 11, 30)).status, 'soon');
  assert.strictEqual(s('12:00-13:00', at(2026, 10, 29, 6)).status, 'today');
  assert.strictEqual(s('23:00-01:00', at(2026, 10, 29, 0, 30)).status, 'live', 'after midnight');
  assert.strictEqual(s('23:00-01:00', at(2026, 10, 29, 23, 30)).status, 'live', 'before midnight');
  assert.strictEqual(s('06:00-07:00, 18:00-19:00', at(2026, 10, 29, 18, 10)).status, 'live');
});

test('hours: dated windows say when, and a past one has no badge', () => {
  const st = L.status({ hours: '2026-12-24 07:20-08:00' }, at(2026, 10, 29, 12));
  assert.strictEqual(st.status, 'later');
  assert.strictEqual(st.label, 'Next: 24 Dec 07:20 UTC');
  assert.strictEqual(L.status({ hours: '2026-12-24 07:20-08:00' }, at(2026, 12, 24, 7, 30)).status, 'live');
  assert.strictEqual(L.status({ hours: '2025-12-24 07:20-08:00' }, at(2026, 10, 29, 12)).status, 'none');
  assert.strictEqual(L.parseHours('2026-02-30 07:00-08:00'), null, 'no 30 February');
});

// ── Can this radio tune it? ─────────────────────────────────────────────
const HF6 = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
const HF_VU = HF6.concat(['2m', '70cm']);
test('receivable: an unrestricted rig sees everything', () => {
  for (const lm of CATALOG.landmarks) assert.ok(L.receivable(lm, null), lm.id);
});
test('receivable: an HF+6 m radio (IC-7300) gets HF general coverage and 6 m, not NOAA, 2 m or marine', () => {
  const ok = (khz) => L.receivable({ khz }, HF6);
  assert.ok(ok(10000) && ok(60) && ok(4625) && ok(27185), 'WWV, WWVB, the Buzzer, CB below 30 MHz');
  assert.ok(ok(50125) && ok(52525), '6 m calling');
  assert.ok(!ok(162550) && !ok(146520) && !ok(156800) && !ok(121500) && !ok(446000), 'nothing above 100 MHz');
});
test('receivable: an HF/VHF/UHF radio (FT-991A) adds 2 m, 70 cm and the VHF landmarks, not 1.25 m', () => {
  const ok = (khz) => L.receivable({ khz }, HF_VU);
  assert.ok(ok(162550) && ok(146520) && ok(156800) && ok(121500) && ok(446000) && ok(432100));
  assert.ok(!ok(223500), '1.25 m simplex needs 1.25 m');
});
test('receivable: a 2 m/70 cm-only radio gets VHF/UHF, not HF or 6 m', () => {
  const ok = (khz) => L.receivable({ khz }, ['2m', '70cm']);
  assert.ok(ok(162550) && ok(146520));
  assert.ok(!ok(10000) && !ok(50125));
});
test('bandLabel names the ham band, else the part of the spectrum', () => {
  assert.strictEqual(L.bandLabel(14100), '20m');
  assert.strictEqual(L.bandLabel(10000), 'SW');
  assert.strictEqual(L.bandLabel(60), 'LF');
  assert.strictEqual(L.bandLabel(162550), 'VHF');
  assert.strictEqual(L.bandLabel(146520), '2m');
});

// ── NCDXF beacon clock ──────────────────────────────────────────────────
test('NCDXF: 18 beacons, 10 s each, 3-minute cycle; 4U1UN opens 14100 at 00:00:00 UTC', () => {
  assert.strictEqual(L.NCDXF.beacons.length, 18);
  assert.strictEqual(L.NCDXF.beacons.length * L.NCDXF.slotSec, L.NCDXF.cycleSec);
  const t = at(2026, 10, 29, 0, 0, 3);
  const b = L.beaconAt(14100, t);
  assert.strictEqual(b.now.call, '4U1UN');
  assert.strictEqual(b.next.call, 'VE8AT');
  assert.strictEqual(b.after.call, 'W6WX');
  assert.ok(Math.abs(b.secondsInto - 3) < 1e-6 && Math.abs(b.secondsLeft - 7) < 1e-6);
});
test('NCDXF: each band is one beacon behind the band below; the cycle repeats every 3 minutes', () => {
  const t = at(2026, 10, 29, 14, 3, 0);
  const calls = L.NCDXF.freqsKhz.map((f) => L.beaconAt(f, t).now.call);
  assert.deepStrictEqual(calls, ['4U1UN', 'YV5B', 'OA4B', 'LU4AA', 'CS3B']);
  assert.strictEqual(L.beaconAt(18110, at(2026, 10, 29, 0, 0, 12)).now.call, '4U1UN', '4U1UN moves up to 18110 ten seconds later');
  assert.strictEqual(L.beaconAt(14100, at(2026, 10, 29, 0, 2, 55)).now.call, 'YV5B', 'the last slot');
  assert.strictEqual(L.beaconAt(14101, t), null, 'not a beacon frequency');
});
test('distanceKm: New York to Hawaii is about 8,000 km', () => {
  const ny = L.NCDXF.beacons[0], hi = L.NCDXF.beacons[3];
  const km = L.distanceKm(ny.lat, ny.lon, hi.lat, hi.lon);
  assert.ok(km > 7800 && km < 8100, String(km));
});

// ── The feed ────────────────────────────────────────────────────────────
function serve(body, status = 200) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
test('feed: bundled copy at launch; a good fetch replaces it and is cached; a bad fetch is refused whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmk-'));
  const cachePath = path.join(dir, 'cache.json');
  const lines = [];
  // https only in production; the test hands refresh() a local http transport.
  const good = JSON.parse(JSON.stringify(CATALOG));
  good.landmarks = good.landmarks.slice(0, 5);
  const srvGood = await serve(JSON.stringify(good));
  const srvBad = await serve(JSON.stringify({ ...good, landmarks: [{ ...good.landmarks[0], mode: 'NOPE' }] }));
  const via = (srv) => ({ fetchText: () => new Promise((res, rej) => http.get(`http://127.0.0.1:${srv.address().port}/`, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b));
  }).on('error', rej)) });
  try {
    const f = new LandmarksFeed({ cachePath, log: (l) => lines.push(l) });
    f.load();
    assert.strictEqual(f.source, 'bundled');
    assert.ok(f.catalog().landmarks.length >= 30);
    assert.strictEqual(await f.refresh(via(srvGood)), true);
    assert.strictEqual(f.source, 'feed');
    assert.strictEqual(f.catalog().landmarks.length, 5);
    assert.ok(fs.existsSync(cachePath), 'cached');
    assert.strictEqual(await f.refresh(via(srvBad)), false);
    assert.strictEqual(f.catalog().landmarks.length, 5, 'the last good copy stays');
    assert.ok(lines.some((l) => /refused/.test(l)), 'the refusal is logged');
    const f2 = new LandmarksFeed({ cachePath });
    f2.load();
    assert.strictEqual(f2.source, 'cache');
    assert.ok(f2.urlAllowed('https://www.ncdxf.org/beacon/') === good.landmarks.some((l) => l.url === 'https://www.ncdxf.org/beacon/'));
    assert.strictEqual(f2.urlAllowed('https://evil.example/'), false);
  } finally {
    srvGood.close(); srvBad.close();
  }
});

// ── Wiring ──────────────────────────────────────────────────────────────
test('main sends the landmarks with every directory push, and the link gate allows only catalog URLs', () => {
  const m = R('main.js');
  assert.ok(m.includes("require('./lib/landmarks-feed')"));
  assert.ok(/'directory-data', \{ nets: directoryNets, swl: directorySwl, \.\.\.landmarksPayload\(\)(, \.\.\.channelsPayload\(\))? \}/.test(m), 'window push');
  assert.ok(/broadcastDirectory\(\{[\s\S]{0,200}\.\.\.landmarksPayload\(\)/.test(m), 'ECHOCAT push');
  assert.ok(m.includes("ipcMain.handle('get-directory', () => ({ nets: directoryNets, swl: directorySwl, ...landmarksPayload(), ...channelsPayload() }))"));
  assert.ok(m.includes('landmarksFeed.refresh()'), 'fetched with the directory');
  assert.ok(m.includes('landmarksFeed.urlAllowed(url)'), 'open-external gate');
});
test('ECHOCAT: the directory message carries landmarks, categories and the beacon table, hydrated at connect', () => {
  const rs = R('lib/remote-server.js');
  assert.ok(/_directoryMessage\(data\) \{[\s\S]{0,900}landmarks: data\.landmarks \|\| \[\][\s\S]{0,120}landmarkCategories:[\s\S]{0,80}ncdxf:/.test(rs));
  assert.ok(rs.includes("this._sendTo(ws, this._directoryMessage(this._directoryData))"), 'hydrate at connect');
  assert.ok(rs.includes("['landmarks-js', 'landmarks.js']"), 'inlined into the web page');
  const proto = R('lib/echocat-protocol.js');
  assert.ok(/directory: \{[^\n]*landmarks: f\.optArray, landmarkCategories: f\.optArray, ncdxf: f\.any/.test(proto));
});
test('desktop window: the tab, the panel, the script, the stylesheet', () => {
  const html = R('renderer/index.html');
  for (const id of ['dirv-tab-landmarks', 'dirv-landmarks-container', 'dirv-category-filter', 'lmk-body', 'lmk-panel', 'lmk-hint']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('../lib/rig-bands.js') < html.indexOf('../lib/landmarks.js'), 'landmarks.js after rig-bands.js');
  assert.ok(html.includes('<link rel="stylesheet" href="landmarks.css">'));
  const app = R('renderer/app.js');
  assert.ok(app.includes("function renderDirvLandmarks(") && app.includes("setDirvTab('landmarks')"));
  assert.ok(app.includes('L.receivable(lm, rigBandsList)'), 'filtered by the active rig');
});
test('ECHOCAT Web: the tab, the inline module, the renderer', () => {
  const html = R('renderer/remote.html');
  assert.ok(html.includes('data-dtab="landmarks"') && html.includes('<!-- landmarks-js -->'));
  const js = R('renderer/remote.js');
  assert.ok(js.includes('function renderDirLandmarks(') && js.includes('L.receivable(lm, webRigBands)'));
});
test('theme: the Landmarks styles use theme variables only, never a colour literal', () => {
  const css = R('renderer/landmarks.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'hex colour in landmarks.css');
  assert.ok(!/\brgba?\(/i.test(css), 'rgb() in landmarks.css');
  assert.ok(!/(?<![-\w])(white|black)(?![-\w])/i.test(css), 'named colour in landmarks.css');
  const web = R('renderer/remote.css');
  const block = web.slice(web.indexOf('/* ── Dir > Landmarks'), web.indexOf('@media (prefers-reduced-motion: reduce) { .lmk-beacon-fill'));
  assert.ok(block.length > 500, 'found the web block');
  const wb = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(wb) && !/\brgba?\(/i.test(wb), 'colour literal in the web Landmarks block');
});

Promise.all(pending).then(() => {
  console.log(`\nLandmarks: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
