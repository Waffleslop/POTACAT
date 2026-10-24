// POTA self-spot by Winlink email (potaspot.tdod.org, W7RTA 2026-10-24).
// Run: node test/pota-email-spot-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/pota-email-spot');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

console.log('pota email spot');

test('the line is the service\'s own example', () => {
  assert.strictEqual(P.spotLine({ call: 'kc0zps', ref: 'us-0786', freqKhz: 14067.5, mode: 'CW' }), '!KC0ZPS POTA US-0786 14.0675 CW');
  assert.strictEqual(P.spotLine({ call: 'KC0ZPS', ref: 'US-0786', freqKhz: 14067.5, mode: 'CW', comment: 'CQ POTA' }), '!KC0ZPS POTA US-0786 14.0675 CW CQ POTA');
});

test('frequency in MHz, modes the way POTA names them', () => {
  assert.strictEqual(P.formatFreqMhz(14074), '14.074');
  assert.strictEqual(P.formatFreqMhz(7038), '7.038');
  assert.strictEqual(P.formatFreqMhz(0), '');
  assert.strictEqual(P.spotMode('USB'), 'SSB');
  assert.strictEqual(P.spotMode('lsb'), 'SSB');
  assert.strictEqual(P.spotMode('FT8'), 'FT8');
});

test('an n-fer is one line per park; what is missing is named', () => {
  const m = P.buildSpotMessage({ call: 'W7RTA', refs: ['US-0786', 'US-1234'], freqKhz: 14074, mode: 'FT8' });
  assert.strictEqual(m.to, 'spot@pota.tdod.org');
  assert.deepStrictEqual(m.body.split('\n'), ['!W7RTA POTA US-0786 14.074 FT8', '!W7RTA POTA US-1234 14.074 FT8']);
  assert.deepStrictEqual(m.missing, []);
  const e = P.buildSpotMessage({ call: 'W7RTA', refs: [], freqKhz: 0, mode: 'SSB' });
  assert.strictEqual(e.body, '!W7RTA POTA PARK FREQ SSB', 'placeholders, never an empty field');
  assert.strictEqual(P.splitSpotBody(e.body).ok, false);
  assert.deepStrictEqual(e.missing, ['the park', 'the frequency']);
});

test('the outgoing body splits into one message per spot line, and refuses an unfilled one', () => {
  const s = P.splitSpotBody('Hello\n!W7RTA POTA US-0786 14.074 FT8\n!W7RTA POTA US-1234 14.074 FT8 via Winlink\n');
  assert.deepStrictEqual(s.bodies, ['!W7RTA POTA US-0786 14.074 FT8', '!W7RTA POTA US-1234 14.074 FT8 via Winlink']);
  assert.strictEqual(P.splitSpotBody('!W7RTA POTA PARK 14.074 FT8').ok, false);
  assert.strictEqual(P.splitSpotBody('just text').ok, false);
  assert.strictEqual(P.splitSpotBody('!W7RTA POTA US-0786 14074kHz FT8').ok, false);
  assert.ok(P.isSpotAddress('SPOT@pota.tdod.org') && !P.isSpotAddress('someone@example.com'));
});

test('wiring: the send path splits spots; Mail window and Activation share one template', () => {
  const main = read('main.js');
  assert.ok(/if \(PotaEmailSpot\.isSpotAddress\(to\)\) \{\n\s*const sp = PotaEmailSpot\.splitSpotBody\(body\);/.test(main));
  assert.ok(/ipcMain\.handle\('winlink-pota-spot-template'/.test(main));
  assert.ok(/ipcMain\.on\('winlink-pota-spot-open'/.test(main));
  assert.ok(/liveActivationMyRefs\(\)\.filter\(\(r\) => r\.sig === 'POTA'\)/.test(main), 'POTA parks only');
  assert.ok(/id="wl-pota-spot"/.test(read('renderer/winlink-popout.html')));
  assert.ok(/winlink-compose-prefill/.test(read('preload-winlink-popout.js')));
  const app = read('renderer/app.js');
  assert.ok(/window\.api\.winlinkPotaSpotOpen\(\{ freqKhz: freq \|\| 0, mode \}\)/.test(app));
  assert.ok(/function activatorSpotTarget\(\)/.test(app) && /const \{ away, freq, mode \} = activatorSpotTarget\(\);/.test(app), 'both spot buttons use the calling frequency');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
