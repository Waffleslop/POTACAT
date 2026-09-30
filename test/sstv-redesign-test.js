#!/usr/bin/env node
'use strict';
// The SSTV window redesign (Casey 2026-09-29): starters with per-station
// looks, the style-pack interpreter, two-click replies, the SWR trip reaching
// the SSTV window, and a guest's picture gated by the pass.
// Run: node test/sstv-redesign-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/sstv-templates');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

// A canvas stand-in that records what is drawn and keeps a numeric sanity
// check on every coordinate (NaN is the classic silent recipe bug).
function fakeCanvas(w = 320, h = 256) {
  const calls = [];
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
      if (prop === 'measureText') return (s) => ({ width: String(s).length * 10 });
      return (...args) => {
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(prop + ' got ' + a);
        calls.push(prop);
      };
    },
    set(target, prop, v) { target[prop] = v; return true; },
  });
  return { width: w, height: h, getContext: () => ctx, calls };
}

console.log('SSTV redesign');

test('a look is the same for the same call and shuffle, and changes with either', () => {
  const a = T.lookFor({ call: 'K3SBP', shuffle: 0 });
  const b = T.lookFor({ call: 'k3sbp', shuffle: 0 });
  assert.deepStrictEqual([a.font.id, a.pal.name, a.accent, a.panel, a.seed], [b.font.id, b.pal.name, b.accent, b.panel, b.seed]);
  const looks = new Set();
  for (let i = 0; i < 20; i++) { const l = T.lookFor({ call: 'K3SBP', shuffle: i }); looks.add(l.font.id + l.pal.name + l.accent + l.panel); }
  assert.ok(looks.size >= 12, 'shuffle gives variety (' + looks.size + ')');
  assert.notStrictEqual(T.lookFor({ call: 'N4ABC' }).seed, a.seed);
});

test('four fonts, none of them Oswald (too condensed to read)', () => {
  assert.strictEqual(T.FONTS.length, 4);
  assert.ok(!T.FONTS.some(f => /oswald/i.test(f.name)));
  for (const f of ['Bungee-Regular', 'ArchivoBlack-Regular', 'RussoOne-Regular', 'Rubik-ExtraBold', 'Rye-Regular']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'fonts', f + '.woff2')), f + ' bundled');
  }
  for (const l of ['bungee', 'archivoblack', 'russoone', 'rubik', 'rye']) {
    assert.ok(/SIL OPEN FONT LICENSE/i.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'fonts', 'OFL-' + l + '.txt'), 'utf8')), l + ' licence');
  }
});

test('every starter draws, carries the station call, and keeps text on the picture', () => {
  const ids = new Set();
  for (const st of T.STARTERS) {
    assert.ok(!ids.has(st.id), 'unique id ' + st.id); ids.add(st.id);
    const c = fakeCanvas();
    T.renderScene(c, st.id, T.lookFor({ call: 'K3SBP' }), {});
    assert.ok(c.calls.length > 3, st.id + ' drew something');
    assert.ok(st.texts.some(t => t.text.includes('{MYCALL}')), st.id + ' identifies the station');
    for (const t of st.texts) {
      assert.ok(t.x >= 8 && t.x <= 312 && t.y >= 20 && t.y <= 250, st.id + ' text inside the safe area: ' + t.text);
      assert.ok(t.size >= 14, st.id + ' text big enough for SSTV: ' + t.text);
    }
    if (st.reply) {
      const s = st.slot;
      assert.ok(s && s.x >= 0 && s.y >= 0 && s.x + s.w <= 320 && s.y + s.h <= 256, st.id + ' slot on the picture');
    }
  }
  assert.strictEqual(T.STARTERS.filter(s => s.reply).length, 3);
});

test('Robot modes (240 lines) scale text and the reply slot', () => {
  const t256 = T.textLayers('cq', 256), t240 = T.textLayers('cq', 240);
  assert.ok(t240[1].y < t256[1].y);
  assert.ok(T.replySlot('reply-big', 240).h < T.replySlot('reply-big', 256).h);
  assert.strictEqual(T.replySlot('cq', 256), null);
});

test('placeholders: a missing value is blank on air, a missing {CALL} shows ?', () => {
  assert.strictEqual(T.fillVars('{CALL} DE {MYCALL}', { MYCALL: 'K3SBP' }), '? DE K3SBP');
  assert.strictEqual(T.fillVars('CQ POTA {PARK}', {}), 'CQ POTA ');
  assert.strictEqual(T.fillVars('{ODD} stays', {}), '{ODD} stays');
  assert.strictEqual(T.fillVars('UR RSV {RSV}', { RSV: '595' }), 'UR RSV 595');
});

test('the POTA strip is white on deep green (dark on bright vanished under the outline)', () => {
  const pota = T.starter('pota');
  assert.strictEqual(pota.texts[0].text, 'CQ POTA');
  assert.strictEqual(pota.texts[0].color, '#ffffff');
  assert.ok(T.isDark('#0f3b2b') && !T.isDark('#ffffff') && !T.isDark('#4ecca3'));
});

const HALLOWEEN = JSON.parse(R('data/sstv-packs/halloween/pack.json'));

test('the Halloween pack passes its validator and every scene draws in every palette', () => {
  const { validatePack } = require('../lib/sstv-pack-validate');
  const v = validatePack(HALLOWEEN);
  assert.ok(v.ok, (v.errors || []).join('; '));
  for (const bg of HALLOWEEN.backgrounds) {
    for (const pal of HALLOWEEN.palettes) {
      const c = fakeCanvas();
      T.drawRecipe(c.getContext(), HALLOWEEN, bg, pal, T.rnd(5), {});
      assert.ok(c.calls.length > 2, bg.name + ' / ' + pal.name + ' drew');
    }
  }
});

test('a pack restyles headlines only; the station font stays on calls', () => {
  const look = T.lookFor({ call: 'K3SBP', pack: HALLOWEEN });
  assert.ok(HALLOWEEN.palettes.some(p => p.name === look.pal.name), 'pack palette');
  const layers = T.textLayers('event', 256);
  const head = T.textStyle(layers[0], look); // SSTV ACTIVITY
  assert.strictEqual(head.label, 'HALLOWEEN');
  assert.ok(/Rye/.test(head.fontCss));
  const call = T.textStyle(layers[2], look); // {MYCALL}
  assert.strictEqual(call.label, '{MYCALL}');
  assert.strictEqual(call.fontCss, look.font.css);
  // Starters draw the pack's scenery.
  const c = fakeCanvas();
  const name = (function () { const s = T.starter('cq'); const cc = c.getContext(); return T.renderScene(c, 'cq', look, {}) && s.name; })();
  assert.ok(name && c.calls.length > 3);
});

test('the SWR trip stops the SSTV picture and shows the banner there', () => {
  const main = R('main.js');
  const trip = main.slice(main.indexOf('function tripSwrGuard('), main.indexOf('function tripSwrGuard(') + 2500);
  assert.ok(/sstvPopoutWin\.webContents\.send\('sstv-abort-tx'\)/.test(trip), 'abort the playing picture');
  assert.ok(/pushSstvRigState\(\);/.test(trip), 'banner');
  const clear = main.slice(main.indexOf('function clearSwrTrip('), main.indexOf('function clearSwrTrip(') + 1400);
  assert.ok(/pushSstvRigState\(\);/.test(clear), 'banner clears');
  assert.ok(/sstvPopoutWin\.webContents\.send\('cat-swr', val\)/.test(main), 'SWR reaches the window');
  assert.ok(/ipcMain\.handle\('sstv-atu-tune'[\s\S]{0,200}applyRigControl\(\{ action: 'atu-tune' \}/.test(main), 'ATU through the one dispatcher');
  const js = R('renderer/sstv-popout.js');
  assert.ok(/if \(tripped\) \{[\s\S]{0,300}if \(isTx\) abortTxLocal\(/.test(js), 'the window resets TRANSMIT');
});

test('a reply survives a transmission and a template change; double-click replies', () => {
  const js = R('renderer/sstv-popout.js');
  const fin = js.slice(js.indexOf('function finishTx()'), js.indexOf('function finishTx()') + 900);
  assert.ok(/noteReplySent\(\);/.test(fin) && !/replyImage = null/.test(fin), 'not cleared after TX');
  const apply = js.slice(js.indexOf('function applyStarter('), js.indexOf('function applyStarter(') + 1400);
  assert.ok(!/replySession = null/.test(apply) && !/replyImage = null/.test(apply), 'template change keeps the reply');
  assert.ok(/thumb\.addEventListener\('dblclick'[\s\S]{0,200}startReply\(entry\)/.test(js), 'gallery double-click');
  assert.ok(/rxBox\.addEventListener\('dblclick'[\s\S]{0,200}startReply\(lastRxImage\)/.test(js), 'live picture double-click');
  assert.ok(/REPLY_IDLE_MS = 15 \* 60 \* 1000/.test(js), '15-minute end');
  const tx = js.slice(js.indexOf("txBtn.addEventListener('click'"), js.indexOf("txBtn.addEventListener('click'") + 900);
  assert.ok(tx.indexOf('selectedText = null') < tx.indexOf('getImageData'), 'no editing handle on air');
});

test('a guest picture must be allowed by the pass', () => {
  const { PassEnforcement } = require('../lib/pass-enforcement');
  const pe = Object.create(PassEnforcement.prototype);
  pe._state = 'active';
  pe._expiresAtMs = Date.now() + 3600e3;
  pe._pass = { privilege_class: 'us_extra', allowed_modes: [] };
  assert.strictEqual(pe.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000 }).allowed, true, 'no mode list = all modes');
  pe._pass.allowed_modes = ['FT8', 'CW'];
  const no = pe.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000 });
  assert.strictEqual(no.allowed, false); assert.ok(/SSTV is not permitted/.test(no.userVisible));
  pe._pass.allowed_modes = ['PHONE'];
  assert.strictEqual(pe.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000 }).allowed, true, 'image goes where phone does');
  pe._pass = { privilege_class: 'us_technician', allowed_modes: [] };
  assert.strictEqual(pe.interceptCatCommand({ type: 'sstv_tx', freqHz: 14230000 }).allowed, false, 'a Technician has no 20 m phone');
  const main = R('main.js');
  assert.ok(/remoteServer\.on\('sstv-photo', \(\{ image, mode, guest \}\)[\s\S]{0,300}interceptCatCommand\(\{ type: 'sstv_tx'/.test(main));
});

test('templates travel: export and import in the settings popover', () => {
  const main = R('main.js');
  assert.ok(/ipcMain\.handle\('sstv-templates-export'/.test(main) && /ipcMain\.handle\('sstv-templates-import'/.test(main));
  assert.ok(/potacatSstvTemplates !== 1/.test(main), 'import refuses other files');
  const html = R('renderer/sstv-popout.html');
  assert.ok(/id="tpl-export"/.test(html) && /id="tpl-import"/.test(html));
});

test('no page scroll: the window is a fixed layout', () => {
  const html = R('renderer/sstv-popout.html');
  assert.ok(!/class="sstv-scroll"/.test(html), 'the scrolling wrapper is gone');
  assert.ok(/html, body \{[^}]*overflow: hidden/.test(html));
  assert.ok(/id="audio-input"/.test(html.slice(html.indexOf('id="gear-pop"'))), 'audio devices live in settings');
  assert.ok(/id="multi-row" hidden/.test(html), 'Flex multi-slice hidden until the rig is a Flex');
});

test('templates have categories; no PSE K on a picture (a picture is not an over)', () => {
  const ids = new Set(T.CATEGORIES.map(c => c.id));
  for (const need of ['all', 'cq', 'reply', 'pota', 'mine']) assert.ok(ids.has(need), need);
  for (const st of T.STARTERS) assert.ok(ids.has(st.category) && st.category !== 'all' && st.category !== 'mine', st.id + ' ' + st.category);
  assert.ok(!/PSE K/.test(R('lib/sstv-templates.js')));
  const js = R('renderer/sstv-popout.js');
  assert.ok(/st\.category !== cat/.test(js), 'the strip filters starters by chip');
  assert.ok(/category: activeStarterId/.test(js), 'a saved template keeps its starter category');
});

test('Drive sits by the meters; bands match the FT8 window; a look can be kept', () => {
  const html = R('renderer/sstv-popout.html');
  const top = html.slice(html.indexOf('id="bands"'), html.indexOf('id="m-swr"'));
  assert.ok(/id="tx-gain"/.test(top), 'Drive is in the top bar');
  assert.strictEqual((html.match(/id="tx-gain"/g) || []).length, 1);
  const js = R('renderer/sstv-popout.js');
  assert.ok(/jtcat-band-btn/.test(js) && /classList\.toggle\('active'/.test(js));
  assert.ok(/settings\.sstvLookLocked\) \{ statusBar/.test(js), 'Shuffle refuses while the look is kept');
  assert.ok(/getElementById\('tx-box'\)\.addEventListener\('contextmenu'/.test(js), 'right-click the picture');
  assert.ok(/fontCss: st\.fontCss/.test(js), 'a saved template freezes its lettering');
});

console.log(`\nSSTV redesign: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
