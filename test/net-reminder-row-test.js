'use strict';
// Issue #284: a Net Reminders row always says which net it is.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/net-reminder-row');

const net = { name: 'POTA Happy Hour', frequency: 14300, mode: 'SSB', startTime: '18:00', timeZone: 'utc', schedule: { type: 'weekly', days: [1, 3] } };
assert.strictEqual(R.title(net), 'POTA Happy Hour');
assert.strictEqual(R.detail(net), '14.300.00 MHz SSB • 18:00 UTC • Mon, Wed');
assert.strictEqual(R.title({ ...net, name: '   ' }), 'Net on 14.300.00 MHz SSB');
assert.strictEqual(R.title({}), 'Unnamed net');
assert.strictEqual(R.detail({ frequency: 7200, mode: 'SSB', startTime: '08:00' }), '7.200.00 MHz SSB • 08:00 Local • Daily');
assert.strictEqual(R.scheduleText({ type: 'dates', dates: ['2026-12-01'] }), '2026-12-01');

// The cause: `dialog input { width: 100% }` stretched the row's checkbox over the name.
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
assert.ok(/\.net-item input\[type="checkbox"\]\s*\{[^}]*width:\s*auto/.test(css), '.net-item checkbox must be width:auto');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
assert.ok(app.includes('NetReminderRow.title(net)'), 'renderNetList uses lib/net-reminder-row.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
assert.ok(html.includes('../lib/net-reminder-row.js'), 'index.html loads lib/net-reminder-row.js');
console.log('net-reminder-row-test: ok');
