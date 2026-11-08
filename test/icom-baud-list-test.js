'use strict';
// GitHub #238: the Icom Baud Rate selects offered only 9600/19200/115200.
// Icom CI-V radios (e.g. IC-7610) also run at 4800, 38400 and 57600.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { civWakeupPreambleCount } = require('../lib/codecs/civ-codec');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const EXPECTED = ['4800', '9600', '19200', '38400', '57600', '115200'];
const IDS = ['set-icom-baud', 'welcome-icom-baud', 'set-serialcat-baud', 'set-rig-baud'];

function options(id) {
  const m = html.match(new RegExp(`<select id="${id}"[^>]*>([^]*?)</select>`));
  assert.ok(m, `select #${id} not found`);
  return { values: [...m[1].matchAll(/value="(\d+)"/g)].map(x => x[1]), selected: (m[1].match(/value="(\d+)"\s+selected/) || [])[1] };
}

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok', name); } catch (e) { fail++; console.log('  FAIL', name, '-', e.message); } }

for (const id of IDS) t(`#${id} offers all six rates`, () => assert.deepStrictEqual(options(id).values, EXPECTED));
t('Icom selects default to 115200', () => {
  assert.strictEqual(options('set-icom-baud').selected, '115200');
  assert.strictEqual(options('welcome-icom-baud').selected, '115200');
});
const table = { 4800: 7, 9600: 13, 19200: 25, 38400: 50, 57600: 75, 115200: 150 };
for (const b of EXPECTED) t(`Icom codec accepts ${b}`, () => assert.strictEqual(civWakeupPreambleCount(b), table[b]));

console.log(`icom-baud-list: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
