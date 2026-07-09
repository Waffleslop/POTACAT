#!/usr/bin/env node
'use strict';
//
// SSTV ingress-gate table test (lib/sstv-feed-gate.js).
//
// The v1.8.15–17 outage was exactly this class of bug: a gate keyed on a
// connection object existing while the stream delivered nothing, starving
// the decoder with no fallback — and no test could reach the inline gate.
// Every (source, stream-alive, freshness, breaker) combination is asserted
// here so the next gate change is a red diff instead of a field report.
//
// Run: node test/sstv-feed-gate-test.js
//
const { rendererAudioDecision, streamAudioDecision, isFresh, FRESH_WINDOW_MS } =
  require('../lib/sstv-feed-gate');

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; }
  else { fail++; console.log(`  ✗ ${msg}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function section(n) { console.log('\n=== ' + n + ' ==='); }

const NOW = 1_000_000;
const FRESH = NOW - 1000;          // 1 s ago — inside the window
const STALE = NOW - FRESH_WINDOW_MS - 1;

// Base state: engine running, breaker off, soundcard source, nothing fresh.
const base = () => ({
  engineRunning: true, feedPaused: false, audioSource: 'default',
  smartSdrAudioUp: false, lastVitaFeedMs: 0,
  k4Connected: false, lastK4FeedMs: 0,
  icomConnected: false, lastIcomFeedMs: 0,
  now: NOW,
});

section('isFresh');
eq(isFresh(FRESH, NOW), true, 'recent feed is fresh');
eq(isFresh(STALE, NOW), false, 'old feed is stale');
eq(isFresh(0, NOW), false, 'never-fed is stale');
eq(isFresh(undefined, NOW), false, 'undefined is stale');

section('rendererAudioDecision — kill switches');
eq(rendererAudioDecision({ ...base(), engineRunning: false }).accept, false, 'engine off rejects');
eq(rendererAudioDecision({ ...base(), feedPaused: true }).accept, false, 'breaker rejects');

section('rendererAudioDecision — soundcard/DAX-device source');
eq(rendererAudioDecision(base()).accept, true, 'plain soundcard source accepts renderer audio');
eq(rendererAudioDecision({ ...base(), smartSdrAudioUp: true, lastVitaFeedMs: FRESH }).accept, true,
  'stray VITA frames do NOT block renderer when audioSource is not smartsdr');

section('rendererAudioDecision — SmartSDR Direct source');
{
  const s = { ...base(), audioSource: 'smartsdr', smartSdrAudioUp: true, lastVitaFeedMs: FRESH };
  eq(rendererAudioDecision(s), { accept: false, reason: 'vita-live' },
    'live VITA stream outranks renderer capture');
}
{
  // THE OUTAGE CASE: stream object exists, no frames flowing (muted slice /
  // DAX conflict / yielded slot). Renderer fallback MUST engage.
  const s = { ...base(), audioSource: 'smartsdr', smartSdrAudioUp: true, lastVitaFeedMs: STALE };
  eq(rendererAudioDecision(s).accept, true,
    'smartsdr stream up but STALE → renderer fallback engages (v1.8.15-17 outage class)');
}
{
  const s = { ...base(), audioSource: 'smartsdr', smartSdrAudioUp: false, lastVitaFeedMs: 0 };
  eq(rendererAudioDecision(s).accept, true,
    'smartsdr selected but audio client not even up → renderer fallback');
}

section('rendererAudioDecision — K4 network');
{
  const s = { ...base(), k4Connected: true, lastK4FeedMs: FRESH };
  eq(rendererAudioDecision(s), { accept: false, reason: 'k4-live' }, 'live K4 stream outranks renderer');
}
{
  const s = { ...base(), k4Connected: true, lastK4FeedMs: STALE };
  eq(rendererAudioDecision(s).accept, true, 'K4 connected but silent → renderer fallback');
}

section('rendererAudioDecision — Icom RS-BA1');
{
  const s = { ...base(), audioSource: 'icom-network', icomConnected: true, lastIcomFeedMs: FRESH };
  eq(rendererAudioDecision(s), { accept: false, reason: 'icom-live' }, 'live Icom stream outranks renderer');
}
{
  const s = { ...base(), audioSource: 'icom-network', icomConnected: true, lastIcomFeedMs: STALE };
  eq(rendererAudioDecision(s).accept, true, 'Icom connected but silent → renderer fallback');
}
{
  const s = { ...base(), audioSource: 'icom-network', icomConnected: false, lastIcomFeedMs: FRESH };
  eq(rendererAudioDecision(s).accept, true, 'icom source without CAT connection → renderer fallback');
}

section('streamAudioDecision');
eq(streamAudioDecision({ engineRunning: false, feedPaused: false, audioSource: 'smartsdr', path: 'smartsdr' }).accept,
  false, 'engine off rejects stream frames');
eq(streamAudioDecision({ engineRunning: true, feedPaused: true, audioSource: 'smartsdr', path: 'smartsdr' }).accept,
  false, 'breaker rejects stream frames');
eq(streamAudioDecision({ engineRunning: true, feedPaused: false, audioSource: 'smartsdr', path: 'smartsdr' }).accept,
  true, 'smartsdr frame accepted when source matches');
eq(streamAudioDecision({ engineRunning: true, feedPaused: false, audioSource: 'default', path: 'smartsdr' }).accept,
  false, 'smartsdr frame rejected when source is soundcard');
eq(streamAudioDecision({ engineRunning: true, feedPaused: false, audioSource: 'default', path: 'k4', k4Connected: true }).accept,
  true, 'K4 frames key on CAT connection, not audioSource');
eq(streamAudioDecision({ engineRunning: true, feedPaused: false, audioSource: 'default', path: 'k4', k4Connected: false }).accept,
  false, 'K4 frames rejected without CAT connection');
eq(streamAudioDecision({ engineRunning: true, feedPaused: false, audioSource: 'icom-network', path: 'icom-network' }).accept,
  true, 'icom frame accepted when source matches');
eq(streamAudioDecision({ engineRunning: true, feedPaused: false, audioSource: 'smartsdr', path: 'bogus' }).accept,
  false, 'unknown path rejected');

console.log('\n' + '='.repeat(52));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('FAILURES PRESENT'); process.exit(1); }
console.log('All feed-gate tests passed.');
