// #756: the ECHOCAT Web switch for settings.tuneClick says what it does.
// It only plays a click on the POTACAT computer when the radio confirms a
// frequency change (renderer/app.js playTuneClick); tapping a spot tunes the
// radio whatever it says. It was labelled "Tap to Tune", which sent an
// operator looking for a tuner button.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.html'), 'utf8');
const m = html.match(/<button[^>]*id="so-tune-click-btn"[^>]*>([^<]*)<\/button>/);
assert.ok(m, 'so-tune-click-btn exists in remote.html');
const tag = m[0];
const label = m[1].trim();
const title = (tag.match(/title="([^"]*)"/) || [])[1] || '';

assert.strictEqual(label, 'Tune Click Sound', 'label names the click sound');
assert.ok(/click/i.test(title) && /frequency change/i.test(title),
  'title says it plays a click on a frequency change: ' + title);
assert.ok(!/tap to tune/i.test(label + ' ' + title), 'no "Tap to Tune" wording');
assert.ok(!/tap a spot/i.test(title), 'title does not claim to control spot tapping');

console.log('remote-tune-click-label-test: OK');
