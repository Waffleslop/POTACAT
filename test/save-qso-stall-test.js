'use strict';
// Saving a QSO must not re-parse the whole log while no ECHOCAT device is
// connected (IK4IDF 2026-10-17: 124k QSOs, the parse held the main process
// ~1 s after every save and the courtesy 73 missed its slot).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const start = MAIN.indexOf('async function saveQsoRecord(');
assert.ok(start > 0, 'saveQsoRecord');
const body = MAIN.slice(start, MAIN.indexOf('\n}\n', start));
const parses = [...body.matchAll(/parseAllRawQsos\(/g)].map((m) => m.index);
assert.strictEqual(parses.length, 1, 'one full-log parse in saveQsoRecord');
const guard = body.lastIndexOf('if (', parses[0]);
assert.ok(/remoteServer\.hasClient\(\)/.test(body.slice(guard, parses[0])), 'the parse runs only with a device connected');
console.log('  ok  saveQsoRecord never re-parses the whole log with no device connected');
console.log('\nSave QSO stall: 1 passed, 0 failed');
