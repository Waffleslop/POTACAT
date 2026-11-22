'use strict';
// #827 (after #820): every message that sends the operator into Settings must
// name a place that exists. "Settings > My Rigs" never did: the rigs are in
// Settings > Radio, and a rig's own settings open with its Edit button.
// This test reads every renderer and lib source file, main.js and the README
// (code comments are skipped) and checks that:
//   1. nothing user-facing names "My Rigs";
//   2. every "Settings > X" names a real Settings tab (the tab bar in
//      renderer/index.html), unless it is another program's Settings
//      (WSJT-X, SmartSDR, VARA, Windows, macOS System Settings, loggers);
//   3. a deeper "Settings > Tab > Y" names text that is on that tab;
//   4. "Settings > Radio, Edit the rig, Z" names a section, field or button
//      that is in the rig editor.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.endsWith('_native') || ent.name === 'vendor') continue;
        walk(rel);
      } else if (/\.(js|html)$/.test(ent.name) && !/\.min\.js$/.test(ent.name)) {
        out.push(rel);
      }
    }
  };
  walk('renderer');
  walk('lib');
  for (const f of fs.readdirSync(ROOT)) if (/^(main|preload.*)\.js$/.test(f)) out.push(f);
  out.push('README.md');
  return out;
}

const isComment = (line) => /^\s*(\/\/|\/\*|\*|<!--)/.test(line);
const lines = [];
for (const rel of sources()) {
  read(rel).split(/\r?\n/).forEach((text, i) => {
    if (!isComment(text)) lines.push({ where: `${rel.replace(/\\/g, '/')}:${i + 1}`, text });
  });
}

const indexHtml = read('renderer/index.html');
const appJs = read('renderer/app.js');

function plain(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—').replace(/&rarr;/g, '→').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

// The tab bar: label -> data-tab key.
const TABS = new Map();
for (const m of indexHtml.matchAll(/class="settings-tab(?: active)?" data-tab="([a-z]+)">([^<]+)</g)) TABS.set(m[2].trim(), m[1]);

// What each tab shows: every stretch of index.html from a data-settings-tab="key"
// to the next data-settings-tab.
function tabText(key) {
  const parts = indexHtml.split(/(?=data-settings-tab=")/);
  return plain(parts.filter((p) => p.startsWith(`data-settings-tab="${key}"`)).join(' '));
}
const rigEditorHtml = indexHtml.slice(indexHtml.indexOf('<div id="rig-editor"'));
const RIG_EDITOR = plain(rigEditorHtml.slice(0, rigEditorHtml.indexOf('data-settings-tab=')));

// Another program's Settings, named just before the path on the same line.
const OTHER_PROGRAM = /(WSJT-X|SmartSDR|VARA|\$\{name\}|Windows|System|Log4OM|N3FJP|MacLoggerDX)[^.]{0,120}$/;
// "Settings > Tab", "Settings -> Tab", "Settings &rarr; Tab", "Settings, then Tab";
// a deeper step only with an arrow ("Settings > Radio, then try again" is prose).
const STEP = ' ?(?:>|&gt;|->|&rarr;|→) ?';
const SEP = '(?:' + STEP + '|, then )';
const PATH_RE = new RegExp(`Settings${SEP}([A-Z][A-Za-z0-9 ]*)((?:${STEP}[^,.;:()<>"'\`—]+)?)`, 'g');
const EDIT_RE = /Settings (?:>|&gt;) Radio, Edit the rig, ([^,.;:()<"'`—]+)/g;

// The longest leading run of words found in `text` must be at least two words
// (one for a one-word name): "Baud Rate 115200" passes on "Baud Rate".
function namesLabelIn(name, text) {
  const words = name.trim().split(/\s+/);
  let n = 0;
  for (let k = words.length; k > 0; k--) if (text.includes(words.slice(0, k).join(' '))) { n = k; break; }
  return n >= Math.min(2, words.length);
}

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

t('the tab bar and the rig list are where the paths say', () => {
  assert.deepStrictEqual([...TABS.keys()].slice(0, 3), ['Summary', 'Station', 'Radio']);
  assert.ok(TABS.has('Radio') && TABS.has('ECHOCAT') && TABS.has('Spots') && TABS.has('Tuning') && TABS.has('Logging'));
  assert.ok(!TABS.has('My Rigs'), 'a "My Rigs" tab came back; update this test');
  assert.ok(/editBtn\.textContent = 'Edit';/.test(appJs), 'the rig list has no "Edit" button');
  assert.ok(/id="rig-add-btn"[^>]*>\+ Add Rig</.test(indexHtml), 'the Radio tab has no "+ Add Rig" button');
  for (const label of ['Serial Port', 'Baud Rate', 'RTS line', 'Transmit (PTT)', 'Rig Model', 'Radio Model',
    'Check all bands', 'Setup instructions', 'Record band scope data', 'Band scope from an SDR', 'Audio Devices',
    'CW keying line', 'Audio source for JTCAT / SSTV', 'Commander command sequences']) {
    assert.ok(RIG_EDITOR.includes(label), `the rig editor has no "${label}"`);
  }
});

t('nothing user-facing names "My Rigs" (there is no such place)', () => {
  const bad = lines.filter((l) => /My Rigs/.test(l.text)).map((l) => `${l.where}: ${l.text.trim().slice(0, 140)}`);
  assert.deepStrictEqual(bad, [], 'still names My Rigs:\n' + bad.join('\n'));
});

t('every "Settings > X" names a Settings tab, and a deeper step names text on that tab', () => {
  const bad = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(PATH_RE)) {
      if (OTHER_PROGRAM.test(l.text.slice(0, m.index))) continue;
      const tab = [...TABS.keys()].find((k) => m[1] === k || m[1].startsWith(k + ' '));
      if (!tab) { bad.push(`${l.where}: no tab "${m[1]}"`); continue; }
      const deeper = m[2] && m[1] === tab ? m[2].replace(new RegExp('^' + STEP), '') : '';
      if (deeper && !namesLabelIn(deeper, tabText(TABS.get(tab)))) bad.push(`${l.where}: "${deeper.trim()}" is not on the ${tab} tab`);
    }
  }
  assert.deepStrictEqual(bad, [], 'Settings paths that lead nowhere:\n' + bad.join('\n'));
});

t('every "Settings > Radio, Edit the rig, Z" names something in the rig editor', () => {
  const bad = [];
  let seen = 0;
  for (const l of lines) {
    for (const m of l.text.matchAll(EDIT_RE)) {
      seen++;
      if (!namesLabelIn(m[1], RIG_EDITOR)) bad.push(`${l.where}: "${m[1].trim()}"`);
    }
  }
  assert.ok(seen >= 10, 'expected the rig-editor paths to be found (' + seen + ')');
  assert.deepStrictEqual(bad, [], 'names that are not in the rig editor:\n' + bad.join('\n'));
});

console.log(`settings-path-test: ${pass} passed`);
