'use strict';
// #329 (Casey 2026-11-10): star a NOAA station, or any Landmark or Channel;
// per operator; shown in Directory, in the VFO window and on the band scope;
// on the wire so ECHOCAT can star and tune them.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const F = require('../lib/favorites');

const ROOT = path.join(__dirname, '..');
const src = (p) => readSrc(path.join(ROOT, p));
const main = src('main.js');
const server = src('lib/remote-server.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('The module (lib/favorites.js)');
check('normalize: strings, trimmed, unique, capped, order kept', () => {
  assert.deepStrictEqual(F.normalize([' noaa-wx1', 'wwv-10000', 'noaa-wx1', 5, null, '']), ['noaa-wx1', 'wwv-10000']);
  assert.deepStrictEqual(F.normalize(undefined), []);
  assert.strictEqual(F.normalize(Array.from({ length: 150 }, (_, i) => 'id' + i)).length, F.MAX);
});
check('toggle: on appends, off removes, undefined flips, a full list takes no more', () => {
  let ids = F.toggle([], 'noaa-wx1', true);
  ids = F.toggle(ids, 'cb-9', true);
  assert.deepStrictEqual(ids, ['noaa-wx1', 'cb-9']);
  assert.deepStrictEqual(F.toggle(ids, 'noaa-wx1', true), ids, 'starring twice changes nothing');
  assert.deepStrictEqual(F.toggle(ids, 'noaa-wx1', false), ['cb-9']);
  assert.deepStrictEqual(F.toggle(ids, 'cb-9'), ['noaa-wx1']);
  const full = Array.from({ length: F.MAX }, (_, i) => 'id' + i);
  assert.strictEqual(F.toggle(full, 'one-more', true).length, F.MAX);
});
check('resolve: landmarks then channels, starred order, a missing id kept out of the list but not lost', () => {
  const landmarks = [{ id: 'wwv-10000', name: 'WWV', khz: 10000, mode: 'AM', line: 'Time' }, { id: 'noaa-wx1', name: 'NOAA WX1', khz: 162550, mode: 'FM', line: 'Weather' }];
  const channels = [{ id: 'cb-9', name: 'CB 9 Emergency', khz: 27065, mode: 'AM', group: 'CB (Citizens Band)' }];
  const items = F.resolve({ landmarks, channels, landmarkIds: ['noaa-wx1', 'gone', 'wwv-10000'], channelIds: ['cb-9'] });
  assert.deepStrictEqual(items.map((f) => f.kind + ':' + f.id), ['landmark:noaa-wx1', 'landmark:wwv-10000', 'channel:cb-9']);
  assert.deepStrictEqual(items[0], { kind: 'landmark', id: 'noaa-wx1', name: 'NOAA WX1', khz: 162550, mode: 'FM', note: 'Weather' });
  assert.strictEqual(items[2].note, 'CB (Citizens Band)');
  assert.deepStrictEqual(F.inSpan(items, 9990e3, 10010e3).map((f) => f.id), ['wwv-10000']);
  assert.deepStrictEqual(F.inSpan(items, 0, 0), []);
});
check('the star: an SVG button, pressed state, POTACAT blue via its class (never a yellow literal), no emoji', () => {
  const on = F.starHtml(true, 'NOAA "WX1"');
  assert.ok(/class="fav-star on"/.test(on) && /aria-pressed="true"/.test(on) && /data-fav="1"/.test(on) && /<svg/.test(on));
  assert.ok(/Remove NOAA WX1 from Favorites/.test(on), 'quotes stripped from the label');
  assert.ok(/aria-pressed="false"/.test(F.starHtml(false, 'x')) && /fill="none"/.test(F.starHtml(false, 'x')));
  assert.ok(!/[☀-➿\u{1F300}-\u{1FAFF}]/u.test(on));
});

console.log('Main, per operator, on the wire');
check('the two keys are per operator (not GLOBAL_KEYS)', () => {
  const g = main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS = new Set([')));
  assert.ok(!/landmarkFavorites|channelFavorites/.test(g));
});
check('main owns the list: one setter, saved, sent to every window and pushed to ECHOCAT', () => {
  const fn = main.slice(main.indexOf('function favoriteSet('), main.indexOf('/** The Landmarks part of every directory push'));
  assert.ok(/Favorites\.toggle\(before, String\(id \|\| ''\), on\)/.test(fn) && /saveSettings\(settings\)/.test(fn) && /favoritesBroadcast\(\)/.test(fn));
  const b = main.slice(main.indexOf('function favoritesBroadcast('), main.indexOf('function favoriteSet('));
  assert.ok(/wc\.send\('favorites', st\)/.test(b) && /pushDirectoryToRenderer\(\)/.test(b));
  assert.ok(/ipcMain\.handle\('favorites-get', \(\) => favoritesState\(\)\)/.test(main));
  assert.ok(/ipcMain\.handle\('favorite-set', /.test(main));
  assert.ok(/rs\.on\('favorite-set', \(\{ kind, id, on \}\) => \{ favoriteSet\(kind, id, on, 'ECHOCAT'\); \}\)/.test(main), 'ECHOCAT stars, inside onRemoteServer');
  assert.ok(/favoritesBroadcast\(\);   \/\/ a starred channel may have been edited/.test(main), 'a Channels edit re-sends them');
  assert.ok(/mode: Channels\.tuneMode\(f\.mode\)/.test(main), 'a channel tunes in the mode an SDR demodulates');
});
check('every directory payload (window, ECHOCAT push, server start, get-directory) carries the starred ids', () => {
  const n = (main.match(/\.\.\.favoritesPayload\(\)/g) || []).length;
  assert.ok(n >= 4, 'payloads with favourites: ' + n);
  const msg = server.slice(server.indexOf('_directoryMessage(data) {'), server.indexOf('_directoryMessage(data) {') + 2500);
  assert.ok(/landmarkFavorites: data\.landmarkFavorites \|\| \[\]/.test(msg) && /channelFavorites: data\.channelFavorites \|\| \[\]/.test(msg));
});
check('C2S favorite-set: kind and id checked, Guest Pass refused by the allow-list, capability advertised', () => {
  const c = server.slice(server.indexOf("case 'favorite-set': {"), server.indexOf("case 'tune': {"));
  assert.ok(/msg\.kind === 'landmark' \|\| msg\.kind === 'channel'/.test(c) && /this\.emit\('favorite-set'/.test(c));
  assert.strictEqual(require('../lib/guest-pass-authority').isGuestAllowed('favorite-set'), false, 'a guest never stars the owner\'s list');
  assert.ok(/'favorite-set',/.test(src('lib/guest-pass-authority.js')), 'classified as denied');
  assert.ok(/'favorites',/.test(server));
  const doc = src('docs/echocat-protocol.md');
  assert.ok(/\| `favorite-set` \| C→S \|/.test(doc) && /landmarkFavorites/.test(doc));
});

console.log('Surfaces');
check('Directory > Landmarks: star column, Favorites group first and filter, a starred row never hidden', () => {
  const html = src('renderer/index.html');
  assert.ok(/<th class="lmk-col-fav" aria-label="Favorite"><\/th>/.test(html));
  assert.ok(/<option value="favorites">Favorites<\/option>/.test(html));
  assert.ok(html.indexOf('<script src="../lib/favorites.js"></script>') < html.indexOf('<script src="channels-view.js"></script>'));
  const app = src('renderer/app.js');
  assert.ok(/\{ id: '__fav', label: 'Favorites'/.test(app));
  assert.ok(/rows\.filter\(r => r\.ok \|\| favLandmarkIds\.includes\(r\.lm\.id\)\)/.test(app));
  assert.ok(/favToggle\('landmark', lm\.id\)/.test(app) && /onFavorite: \(id\) => favToggle\('channel', id\)/.test(app));
  assert.ok(!/colspan="6"/.test(app.slice(app.indexOf('function renderDirvLandmarks('), app.indexOf('function lmkRenderPanel('))), 'every row spans the new column');
});
check('Directory > Channels: a star per row and a Favorites view', () => {
  const v = src('renderer/channels-view.js');
  assert.ok(/window\.Favorites\.starHtml\(favIds\.includes\(c\.id\), c\.name\)/.test(v));
  assert.ok(/<option value="' \+ FAV \+ '">Favorites<\/option>/.test(v));
  assert.ok(/setFavorites/.test(v));
  const css = src('renderer/channels.css');
  const fav = css.slice(css.indexOf('.fav-star {'));
  assert.ok(/\.fav-star\.on \{ color: var\(--accent-blue\); \}/.test(fav));
  assert.ok(!/#[0-9a-f]{3,6}/i.test(fav), 'theme tokens only');
});
check('VFO window: a Favorites section that tunes, moves and hides like the others', () => {
  const vfo = src('renderer/vfo-popout.html');
  assert.ok(/id="sec-favorites"/.test(vfo) && /id="fav-grid"/.test(vfo) && /id="s-favorites"/.test(vfo));
  assert.ok(/\{ key: 'favorites', el: 'sec-favorites', name: 'Favorites' \}/.test(vfo), 'in the Order list');
  assert.ok(/const SECTIONS = \[[^\]]*'favorites'/.test(vfo));
  assert.ok(/b\.addEventListener\('click', \(\) => window\.api\.tune\(String\(f\.khz\), f\.mode \|\| undefined\)\)/.test(vfo));
  assert.ok(/#sec-favorites\.empty \{ display: none; \}/.test(vfo), 'hidden until something is starred');
  const pre = src('preload-vfo-popout.js');
  assert.ok(/favoritesGet:/.test(pre) && /onFavorites:/.test(pre));
});
check('Band scope: markers on the top edge, theme blue, a click tunes', () => {
  const sc = src('renderer/scope-popout.js');
  assert.ok(/drawFavorites\(traceCanvas\.getContext\('2d'\), w, h, dpr\);/.test(sc));
  assert.ok(/getPropertyValue\('--accent-blue'\)/.test(sc));
  assert.ok(/if \(p\.fav\) window\.api\.tune\(String\(p\.fav\.khz\), p\.fav\.mode \|\| null\);/.test(sc));
  assert.ok(/<script src="\.\.\/lib\/favorites\.js"><\/script>/.test(src('renderer/scope-popout.html')));
  const pre = src('preload-scope-popout.js');
  assert.ok(/favoritesGet:/.test(pre) && /onFavorites:/.test(pre));
});
check('ECHOCAT Web: the module inlined, stars sent as favorite-set, Favorites first, none for a guest', () => {
  assert.ok(/<!-- favorites-js -->/.test(src('renderer/remote.html')));
  assert.ok(/\['favorites-js', 'favorites\.js'\]/.test(server));
  const r = src('renderer/remote.js');
  assert.ok(/type: 'favorite-set', kind: kind, id: id, on: on/.test(r));
  assert.ok(/msg\.landmarkFavorites/.test(r) && /msg\.channelFavorites/.test(r));
  assert.ok(/if \(window\.__echoGuestPass \|\| !window\.Favorites\) return '';/.test(r));
  assert.ok(/favToggle\('landmark', lm\.id\)/.test(r) && /favToggle\('channel', c\.id\)/.test(r));
});

console.log(`\nFavorites (#329): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
