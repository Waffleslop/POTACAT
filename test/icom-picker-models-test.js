'use strict';
// Every Icom CI-V model POTACAT knows must be pickable where a CI-V radio is
// chosen (KD2E 2026-10-11: "No Icom IC-7000 ... it is not listed". The model
// entry had existed since 2026-08-25, but the Radio Model pickers never
// offered it, nor the IC-706MKII). Network-only pickers are exempt: neither
// radio has a LAN port.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const m = require('../lib/rig-models.js');
const RIG = m.RIG_MODELS || m;
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

function pickerOptions(id) {
  const i = html.indexOf('id="' + id + '"');
  assert.ok(i > 0, id);
  const block = html.slice(i, html.indexOf('</select>', i));
  return [...block.matchAll(/<option value="(0x[0-9A-Fa-f]+)">([^<]+)<\/option>/g)].map((x) => ({ addr: parseInt(x[1], 16), name: x[2].trim() }));
}
let passed = 0;
for (const id of ['set-icom-model', 'set-civ-tcp-model', 'welcome-icom-model']) {
  const opts = pickerOptions(id);
  for (const [name, mod] of Object.entries(RIG)) {
    if (mod.brand !== 'Icom' || mod.protocol !== 'civ') continue;
    const o = opts.find((x) => x.name === name);
    assert.ok(o, `${id} offers ${name}`);
    assert.strictEqual(o.addr, mod.civAddr, `${id}: ${name} address`);
  }
  passed++;
  console.log('  ok  ' + id + ' offers every Icom CI-V model at its own address');
}
console.log(`\nIcom pickers: ${passed} passed, 0 failed`);
