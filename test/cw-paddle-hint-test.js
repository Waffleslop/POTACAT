'use strict';
// The "paddle cannot make CW" log hint names the right radio's menus.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { txrxPttOnlyHint } = require('../lib/cw-paddle-hint');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }

const kx = RIG_MODELS['KX2/KX3'];
const ftdx10 = Object.values(RIG_MODELS).find(m => m.brand === 'Yaesu' && m.protocol === 'kenwood');

t('KX2/KX3: no Yaesu menus or ports, names CW KEY1 = HAND and the text box', () => {
  const s = txrxPttOnlyHint(kx);
  assert.ok(!/PC KEYING|FTDX10|FT-710|Standard|Enhanced|BK-IN/.test(s), s);
  assert.ok(/CW KEY1 to HAND/.test(s));
  assert.ok(/CW text box/.test(s));
  assert.ok(/CW Key Port/.test(s));
});

t('Yaesu/Kenwood wording is unchanged', () => {
  const s = txrxPttOnlyHint(ftdx10);
  assert.ok(/PC KEYING \(or USB Keying \(CW\)\) = DTR or RTS/.test(s));
  assert.strictEqual(txrxPttOnlyHint(null), s);
});

t('main.js takes the hint from lib/cw-paddle-hint.js, not inline text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/txrxPttOnlyHint\(rigModel\)/.test(src));
  assert.ok(!/Paddle keying on this Yaesu\/Kenwood rig would only key PTT/.test(src));
});

console.log(`cw-paddle-hint: ${passed} passed`);
