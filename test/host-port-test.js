#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// lib/host-port.js — a host field with the port pasted into it (N5ZC 2026-09-06).
//
// Run:  node test/host-port-test.js

const { splitHostPort } = require('../lib/host-port');

let pass = 0;
let fail = 0;
const failures = [];

function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; return; }
  fail++;
  failures.push(msg);
  console.log(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

section('The reported case');
// Exactly what was in N5ZC's settings: the endpoint in Host, the port also in
// Port. The old code dialled host "127.0.0.1:4532" and lost the whole CAT link
// to a DNS failure.
assertEq(splitHostPort('127.0.0.1:4532', 4532), { host: '127.0.0.1', port: 4532, corrected: true },
  'host:port with a matching Port field splits cleanly');

section('Ordinary hosts are untouched');
assertEq(splitHostPort('127.0.0.1', 4532), { host: '127.0.0.1', port: 4532, corrected: false },
  'a bare IPv4 address is left alone');
assertEq(splitHostPort('flex.local', 5002), { host: 'flex.local', port: 5002, corrected: false },
  'a bare hostname is left alone');
assertEq(splitHostPort('  192.168.1.36  ', 4992), { host: '192.168.1.36', port: 4992, corrected: false },
  'surrounding whitespace is trimmed');
assertEq(splitHostPort('', 4532), { host: '', port: 4532, corrected: false },
  'an empty host stays empty — the caller owns the default');
assertEq(splitHostPort(null, 4532), { host: '', port: 4532, corrected: false },
  'null does not throw');

section('The embedded port wins, and says so');
// Honouring the half the user typed while discarding the other half is the one
// outcome nobody expects, so the pasted pair wins and `corrected` makes the
// disagreement visible in the log.
assertEq(splitHostPort('192.168.1.36:4533', 4532), { host: '192.168.1.36', port: 4533, corrected: true },
  'a host-embedded port overrides a conflicting Port field');
assertEq(splitHostPort('rig.example.com:50001', 4532), { host: 'rig.example.com', port: 50001, corrected: true },
  'hostnames split the same way as addresses');

section('IPv6');
// The brackets exist precisely to disambiguate address colons from a port.
assertEq(splitHostPort('[::1]:4532', 4532), { host: '::1', port: 4532, corrected: true },
  'bracketed IPv6 with a port splits and drops the brackets');
assertEq(splitHostPort('[fe80::1]', 4532), { host: 'fe80::1', port: 4532, corrected: false },
  'bracketed IPv6 without a port keeps the Port field');
// A bare IPv6 literal must NOT be split: the last colon is part of the address,
// and splitting there would mangle a perfectly valid host into an unreachable
// one — the exact failure mode this module exists to prevent.
assertEq(splitHostPort('fe80::1', 4532), { host: 'fe80::1', port: 4532, corrected: false },
  'a bare IPv6 literal is never split on its own colons');
assertEq(splitHostPort('2001:db8::8a2e:370:7334', 4532),
  { host: '2001:db8::8a2e:370:7334', port: 4532, corrected: false },
  'a long bare IPv6 literal is left alone');

section('Nonsense is left for the transport to reject');
// Better a clear connect error naming what the operator typed than a silent
// rewrite into something they never entered.
assertEq(splitHostPort('127.0.0.1:0', 4532), { host: '127.0.0.1:0', port: 4532, corrected: false },
  'port 0 is not a usable port, so nothing is split');
assertEq(splitHostPort('127.0.0.1:70000', 4532), { host: '127.0.0.1:70000', port: 4532, corrected: false },
  'a port above 65535 is not split');
assertEq(splitHostPort('127.0.0.1:abcd', 4532), { host: '127.0.0.1:abcd', port: 4532, corrected: false },
  'a non-numeric tail is not a port');
assertEq(splitHostPort(':4532', 4532), { host: ':4532', port: 4532, corrected: false },
  'an empty host half is not split');

console.log('\n' + '='.repeat(52));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('All tests passed.');
