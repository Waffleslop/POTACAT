#!/usr/bin/env node
'use strict';
// A Guest Pass code is a key to the owner's station: it never goes into the
// log (the privacy policy says so, and Report a Bug copies the log).
//   1. PassEnforcement's own lines, through a whole session, never carry it.
//   2. No log call in main.js or lib/ interpolates a pass code: guest.code,
//      pass.code, _pass.code, cur.code, passCode, or ${code} on a pass line.
// Run: node test/pass-code-log-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const { PassEnforcement } = require('../lib/pass-enforcement');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const root = path.join(__dirname, '..');
const CODE = 'otter-newt-mosaic-rooster';

(async () => {
  console.log('pass codes stay out of the log');

  await test('a whole PassEnforcement session logs no pass code', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      status: 200, ok: true, statusText: '200',
      json: async () => ({
        code: CODE, owner_callsign: 'K3SBP', privilege_class: 'general', max_power_w: 100,
        allowed_modes: [], expires_at: new Date(Date.now() + 600000).toISOString(),
      }),
    });
    const lines = [];
    try {
      const pe = new PassEnforcement({ revalidateMs: 0, log: (m) => lines.push(String(m)) });
      await pe.loadPass(CODE);
      pe.pause();
      pe.resume();
      pe.endPass('owner_override');
      await new Promise((r) => setImmediate(r));
    } finally { global.fetch = realFetch; }
    assert.ok(lines.length >= 4, 'expected the active/paused/resumed/ended lines, got ' + lines.length);
    for (const l of lines) assert.ok(!l.toLowerCase().includes(CODE), 'a log line carries the code: ' + l);
  });

  await test('no log call in main.js or lib/ writes a pass code', () => {
    const files = ['main.js', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f)];
    const LOG = /\b(sendCatLog|console\.(log|warn|error|info)|this\._log|_log|log)\s*\(/;
    const CODE_REF = /\b(guest|pass|_pass|cur|session|_passSession)\.code\b|\bpassCode\b/;
    const BARE = /\$\{code\}|\+\s*code\b/;
    const bad = [];
    for (const f of files) {
      const src = readSrc(path.join(root, f));
      src.split(/\r?\n/).forEach((line, i) => {
        if (!LOG.test(line)) return;
        const after = line.slice(line.search(LOG));
        if (CODE_REF.test(after) || (BARE.test(after) && /pass|guest/i.test(after))) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(bad, [], 'log lines that write a pass code:\n       ' + bad.join('\n       '));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
