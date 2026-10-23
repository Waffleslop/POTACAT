'use strict';
// The dim "worked today on another band/mode" checkmark (Casey 2026-10-23).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/spot-row');
const t = '20261023';
const e = [{ date: t, band: '20M', mode: 'SSB' }, { date: '20261001', band: '40M', mode: 'CW' }];
assert.deepStrictEqual(S.workedElsewhereToday(e, '40M', 'SSB', t), ['20M SSB'], 'moved band today: named');
assert.deepStrictEqual(S.workedElsewhereToday(e, '20M', 'SSB', t), [], 'worked HERE: the real checkmark, not this');
assert.deepStrictEqual(S.workedElsewhereToday(e, '40M', 'CW', t), ['20M SSB'], 'an older day never counts');
assert.deepStrictEqual(S.workedElsewhereToday(undefined, '40M', 'CW', t), []);
assert.ok(/worked-check other/.test(S.spotRowHtml({ callsign: 'K1ABC', frequency: '7200', mode: 'SSB', source: 'pota' }, { workedOther: 'x' }, {})));
assert.ok(!/worked-check other/.test(S.spotRowHtml({ callsign: 'K1ABC', frequency: '7200', mode: 'SSB', source: 'pota' }, { workedEver: true, workedOther: 'x' }, {})), 'the real check wins');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
assert.ok(/SpotRow\.workedElsewhereToday\(/.test(app) && /tr\.classList\.add\('worked-other'\)/.test(app), 'desktop table');
assert.ok(/SpotRow\.workedElsewhereToday\(/.test(web) && /workedEver, workedOther, isSkipped/.test(web), 'web table');
console.log('Worked elsewhere: 8 passed, 0 failed');
