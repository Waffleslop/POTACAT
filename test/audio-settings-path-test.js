'use strict';
// #820: audio errors and hints must send the operator to a place that exists.
// They said "Settings > My Rigs > Audio"; there is no such tab or section.
// The radio's sound devices are chosen in Settings > Radio, Edit the rig,
// under "Audio Devices" (RX audio in / TX audio out). This test reads every
// renderer and lib source file and checks that:
//   1. no line mentions audio together with "My Rigs" (the old, wrong path);
//   2. every "Settings > Radio, Edit the rig, Audio Devices[, <field>]" names
//      labels that really exist in renderer/index.html and the rig list.
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
  return out;
}

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

const files = sources().map((rel) => ({ rel, text: read(rel) }));
const indexHtml = read('renderer/index.html');
const appJs = read('renderer/app.js');

t('no source line points audio at "My Rigs" (a place that does not exist)', () => {
  const bad = [];
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (/My Rigs/.test(line) && /audio/i.test(line)) bad.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepStrictEqual(bad, [], 'audio copy still names My Rigs:\n' + bad.join('\n'));
});

t('the labels in the path exist: Radio tab, Edit button, Audio Devices', () => {
  assert.ok(/class="settings-tab[^"]*" data-tab="radio">Radio</.test(indexHtml), 'Settings has no "Radio" tab');
  assert.ok(/editBtn\.textContent = 'Edit';/.test(appJs), 'the rig list has no "Edit" button');
  assert.ok(/<div id="rig-audio-devices"[\s\S]{0,200}>Audio Devices</.test(indexHtml), 'the rig editor has no "Audio Devices" section');
});

t('every audio path names a field that exists in the rig editor', () => {
  const re = /Settings (?:>|&gt;) Radio, Edit the rig, Audio Devices(?:, ([A-Za-z ]+[a-z]))?/g;
  const found = [];
  for (const f of files) {
    let m;
    while ((m = re.exec(f.text))) found.push({ rel: f.rel, field: m[1] || '' });
  }
  const where = new Set(found.map((x) => x.rel.replace(/\\/g, '/')));
  assert.ok(where.has('renderer/remote-audio.html'), 'remote-audio.html does not name the audio path');
  assert.ok(where.has('renderer/jtcat-popout.js'), 'jtcat-popout.js does not name the audio path');
  for (const x of found) {
    if (!x.field) continue;
    assert.ok(indexHtml.includes('<label>' + x.field + ' (') || indexHtml.includes('>' + x.field + ' ('),
      `${x.rel} names "${x.field}", which is not a label in the rig editor`);
  }
});

console.log(`audio-settings-path-test: ${pass} passed`);
