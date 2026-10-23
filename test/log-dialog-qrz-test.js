'use strict';
// The in-window Log dialog looks up QRZ whenever the callsign is edited —
// including over a spot's prefilled call (a multi-op activation is spotted
// under one call; the op actually worked has their own name). The old guard
// returned early whenever the dialog came from a spot (Mac user, 2026-10-23).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const at = app.indexOf("logCallsign.addEventListener('input', () => {");
assert.ok(at > 0, 'handler found');
const body = app.slice(at, app.indexOf('}, 500);', at));
assert.ok(!/currentLogSpot && currentLogSpot\.callsign\) return/.test(body), 'no spot-prefill early return');
assert.ok(/window\.api\.qrzLookup\(cs\)/.test(body), 'looks the new call up');
assert.ok(/logOpName\.value = '';/.test(body), 'an unknown call clears the previous name');
console.log('Log dialog QRZ: 3 passed, 0 failed');
