// test/waterfall-palettes-test.js — waterfall / band scope palettes
// (lib/waterfall-palettes.js) and their wiring into every waterfall window.
//
// The eight phone palettes must match the ECHOCAT app exactly
// (potacat-app src/utils/panDisplay.ts, as the echocat session reported them
// 2026-11-04). If the app changes a palette, change it here AND in the lib.

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/waterfall-palettes');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const even = (h) => h.map((x, i) => [i / (h.length - 1), x]);

const PHONE = {
  beacon: { trace: '#f5c043', stops: even(['#07111b', '#10304a', '#2f7fb0', '#62b6e4', '#f5c043', '#fff3d1']) },
  campfire: { trace: '#ff8f45', stops: even(['#07111b', '#2a1418', '#8f2a22', '#ff8f45', '#f5c043', '#fff3d1']) },
  canopy: { trace: '#45d6a4', stops: even(['#07111b', '#0c2e2a', '#1f7a5c', '#45d6a4', '#c9e86a', '#f5c043']) },
  ultraviolet: { trace: '#e879f9', stops: even(['#0b0d18', '#1d1840', '#5b3fc4', '#b07cff', '#e879f9', '#fde7ff']) },
  slate: { trace: '#e9eef2', stops: even(['#07111b', '#142433', '#3c556b', '#8ea3b4', '#e9eef2', '#f5c043']) },
  tidepool: { trace: '#38bdf8', stops: [[0, '#0b0d10'], [0.35, '#0c2a3a'], [0.6, '#38bdf8'], [0.8, '#52c992'], [1, '#ff6b76']] },
  classic: { trace: '#00cccc', stops: [[0, '#000033'], [0.3, '#0000cc'], [0.55, '#00cccc'], [0.75, '#ffff00'], [1, '#ff0000']] },
  night: { trace: '#ff3b30', stops: [[0, '#0a0000'], [0.4, '#4a0000'], [0.75, '#b30000'], [1, '#ff3b30']] },
};
const PHONE_ORDER = ['beacon', 'campfire', 'canopy', 'ultraviolet', 'slate', 'tidepool', 'classic', 'night'];

console.log('waterfall palettes:');

t('the eight phone palettes, in the app\'s menu order, with its exact stops and trace colours', () => {
  const ids = P.PALETTES.filter(p => !p.desktop).map(p => p.id);
  assert.deepStrictEqual(ids, PHONE_ORDER);
  for (const id of PHONE_ORDER) {
    const p = P.PALETTES.find(x => x.id === id);
    assert.deepStrictEqual(p.stops, PHONE[id].stops, id + ' stops');
    assert.strictEqual(p.trace, PHONE[id].trace, id + ' trace');
  }
});

t('Tidepool in a light window is the phone\'s Light resolution', () => {
  const lut = P.lutRgb('tidepool', { light: true });
  assert.deepStrictEqual([lut[0], lut[1], lut[2]], [0xf4, 0xf5, 0xf7]);
  assert.deepStrictEqual([lut[765], lut[766], lut[767]], [0xc8, 0x25, 0x2f]);
  assert.strictEqual(P.trace('tidepool', { light: true }), '#0e7490');
  assert.strictEqual(P.trace('tidepool'), '#38bdf8');
  // Every other palette ignores light.
  assert.deepStrictEqual(P.lutRgb('beacon', { light: true }), P.lutRgb('beacon'));
});

t('colorAt is the phone\'s: linear sRGB between stops, rounded, clamped', () => {
  const s = PHONE.night.stops;
  assert.deepStrictEqual(P.colorAt(s, -1), [0x0a, 0, 0]);
  assert.deepStrictEqual(P.colorAt(s, 2), [0xff, 0x3b, 0x30]);
  assert.deepStrictEqual(P.colorAt(s, 0.4), [0x4a, 0, 0]);
  // Beacon, exactly halfway between 0 (#07111b) and 0.2 (#10304a): .5 rounds up.
  assert.deepStrictEqual(P.colorAt(PHONE.beacon.stops, 0.1), [12, 33, 51]);
});

t('a table is 256 RGB entries, entry i = colorAt(i / 255)', () => {
  for (const id of PHONE_ORDER) {
    const lut = P.lutRgb(id);
    assert.strictEqual(lut.length, 768);
    for (const i of [0, 1, 77, 128, 200, 254, 255]) {
      assert.deepStrictEqual([lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]], P.colorAt(PHONE[id].stops, i / 255), id + ' entry ' + i);
    }
  }
});

t('Standard (auto) is no table at all, so each window keeps its own colours', () => {
  assert.strictEqual(P.DEFAULT, 'auto');
  assert.strictEqual(P.lutRgb('auto'), null);
  assert.strictEqual(P.trace('auto'), null);
  assert.strictEqual(P.choices()[0].id, 'auto');
});

t('ids: unknown → auto, the phone\'s legacy "ember" → campfire', () => {
  assert.strictEqual(P.normalize('ember'), 'campfire');
  assert.strictEqual(P.normalize('nope'), 'auto');
  assert.strictEqual(P.normalize(undefined), 'auto');
  assert.strictEqual(P.normalize('turbo'), 'turbo');
});

t('Turbo and Spectrum are exactly the desktop shader\'s two maps', () => {
  const src = read('renderer/waterfall.js');
  const map = (fn) => {
    const body = src.slice(src.indexOf('vec3 ' + fn + '(float t)'), src.indexOf('}', src.indexOf('vec3 ' + fn + '(float t)')));
    const vecs = [...body.matchAll(/vec3\(([^)]*)\)/g)].map(m => m[1].split(',').map(Number))
      .map(v => v.length === 1 ? [v[0], v[0], v[0]] : v);
    const seen = [];
    for (const v of vecs) if (!seen.some(s => s.join() === v.join())) seen.push(v);
    return seen.map(v => '#' + v.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join(''));
  };
  assert.deepStrictEqual(P.PALETTES.find(p => p.id === 'turbo').stops.map(s => s[1]), map('cmTurbo'));
  assert.deepStrictEqual(P.PALETTES.find(p => p.id === 'spectrum').stops.map(s => s[1]), map('cmClassic'));
});

console.log('wiring:');

t('every page that loads waterfall.js loads the palettes first', () => {
  for (const f of fs.readdirSync(path.join(root, 'renderer')).filter(f => f.endsWith('.html'))) {
    const html = read('renderer/' + f);
    const wf = html.indexOf('<script src="waterfall.js"></script>');
    if (wf < 0) continue;
    const pal = html.indexOf('<script src="../lib/waterfall-palettes.js"></script>');
    assert.ok(pal >= 0 && pal < wf, f + ' must load ../lib/waterfall-palettes.js before waterfall.js');
  }
});

t('every new Waterfall(...) starts on the machine\'s palette', () => {
  for (const f of ['renderer/jtcat-popout.js', 'renderer/sstv-popout.js', 'renderer/winlink-popout.js']) {
    const src = read(f);
    const calls = src.split('new Waterfall(').slice(1);
    assert.ok(calls.length > 0, f);
    for (const c of calls) assert.ok(/palette:/.test(c.slice(0, 300)), f + ': a Waterfall without palette:');
    assert.ok(/WaterfallPalettes\.follow\(window\.api/.test(src), f + ' follows the setting');
  }
  assert.ok(/WaterfallPalettes\.follow\(window\.api/.test(read('renderer/scope-popout.js')), 'scope pop-out follows');
});

t('the FT8 window\'s 2D waterfalls use the table when a palette is chosen', () => {
  const src = read('renderer/jtcat-popout.js');
  assert.strictEqual((src.match(/if \(wfPalLut\) \{ var li =/g) || []).length, 2, 'audio waterfall + per-slice minis');
});

t('every waterfall window\'s preload has the palette IPC', () => {
  for (const f of ['preload.js', 'preload-jtcat-popout.js', 'preload-scope-popout.js', 'preload-sstv-popout.js', 'preload-winlink-popout.js']) {
    const src = read(f);
    for (const k of ['getWaterfallPalette', 'setWaterfallPalette', 'onWaterfallPalette']) assert.ok(src.includes(k + ':'), f + ' ' + k);
  }
});

t('main: one writer, a machine key, a broadcast to every window', () => {
  const src = read('main.js');
  assert.ok(/ipcMain\.handle\('set-waterfall-palette'/.test(src));
  assert.ok(/ipcMain\.handle\('get-waterfall-palette'/.test(src));
  assert.ok(/'waterfallPalette',\s+\/\/ waterfall/.test(src), 'GLOBAL_KEYS');
  assert.ok(/delete newSettings\.waterfallPalette;/.test(src), 'save-settings must not write it (a stale copy would undo a choice)');
  assert.ok(/wc\.send\('waterfall-palette'/.test(src));
});

t('ECHOCAT Web: palettes inlined, a per-device choice, used by both waterfalls and the trace', () => {
  assert.ok(read('renderer/remote.html').includes('<!-- waterfall-palettes-js -->'));
  assert.ok(read('lib/remote-server.js').includes("['waterfall-palettes-js', 'waterfall-palettes.js']"));
  const src = read('renderer/remote.js');
  assert.ok(src.includes("'echocat-waterfall-palette'"));
  assert.strictEqual((src.match(/if \(wfPalLut\) \{/g) || []).length, 2, 'scope rows + FT8 waterfall');
  assert.ok(src.includes('traceColor: wfPalTrace'));
});

console.log('\nwaterfall palettes: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
