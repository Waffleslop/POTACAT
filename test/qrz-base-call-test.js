'use strict';
// A compound callsign looks up and links the STATION's own call on QRZ
// (N0KAH 2026-10-14: "M/NT6B" opened qrz.com/db/M — every caller took the
// text before the first "/").
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { baseCall } = require('../renderer/jtcat-parser');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
test('baseCall picks the station call from prefix and suffix forms', () => {
  const cases = {
    'M/NT6B': 'NT6B', 'NT6B/P': 'NT6B', 'KH6/K1A': 'K1A', 'DL/K3SBP/P': 'K3SBP', 'VP2E/K1ABC': 'K1ABC',
    'W1AW/4': 'W1AW', 'K9CYT/8': 'K9CYT', '<PJ4/K1ABC>': 'K1ABC', 'F/G4ABC/P': 'G4ABC', 'VE3/W1A': 'W1A',
    'KL7/N0X/M': 'N0X', '3D2/K1A': 'K1A', 'k1abc': 'K1ABC', '': '',
  };
  for (const [inp, want] of Object.entries(cases)) assert.strictEqual(baseCall(inp), want, inp);
});
test('no QRZ link or lookup takes the text before the first slash', () => {
  for (const f of ['renderer/app.js', 'renderer/remote.js', 'renderer/log-popout.js', 'renderer/map-popout.js',
    'renderer/prop-popout.js', 'renderer/spots-popout.js', 'renderer/jtcat-popout.js', 'main.js', 'lib/qrz.js']) {
    const src = R(f);
    for (const line of src.split('\n')) {
      if (/qrz\.com\/db\/|qrz\.lookup\(|qrzLookup|qrzData\.(get|set)\(|qrz-lookup/.test(line)) {
        assert.ok(!/split\('\/'\)\[0\]/.test(line), f + ': ' + line.trim());
      }
    }
  }
  assert.ok(/const upper = baseCall\(callsign\);/.test(R('lib/qrz.js')), 'the QRZ client itself keys by baseCall');
});
test('every window that builds a QRZ link loads the shared parser first', () => {
  for (const w of ['map-popout', 'prop-popout', 'log-popout', 'spots-popout']) {
    const html = R('renderer/' + w + '.html');
    assert.ok(html.indexOf('<script src="jtcat-parser.js"></script>') >= 0 && html.indexOf('<script src="jtcat-parser.js"></script>') < html.indexOf('<script src="' + w + '.js"></script>'), w);
  }
});
console.log(`\nQRZ base call: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
