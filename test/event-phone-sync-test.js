// #1030: stopping event tracking on the desktop must reach the ECHOCAT phone.
// The phone alerts from the `eventSubscriptions` list the desktop sends in the
// settings payload. setEventOptIn (banner, Spots menu, Settings Track button)
// saved the setting but never re-broadcast, so the phone kept sending event
// alerts until it reconnected. Every event-state setter that changes a field
// the phone payload carries (optedIn, mutes, progress) must call
// updateRemoteSettings(). watchlistOn is desktop-only and is not in the payload.
//
// main.js is glue and cannot be required, so this is a source-text guard.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const src = readSrc(path.join(__dirname, '..', 'main.js'));

function body(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in main.js`);
  const next = src.indexOf('\nfunction ', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

for (const fn of ['setEventOptIn', 'setEventSubscription', 'setEventItemManual', 'markEventRegion']) {
  assert.ok(/updateRemoteSettings\(\)/.test(body(fn)), `${fn} must call updateRemoteSettings() so the phone converges`);
}

// The phone payload must not start carrying watchlistOn without setEventWatchlist following.
const payload = body('buildEventCatalogPayload');
if (/watchlistOn/.test(payload)) {
  assert.ok(/updateRemoteSettings\(\)/.test(body('setEventWatchlist')), 'setEventWatchlist must re-broadcast once the payload carries watchlistOn');
}

console.log('event-phone-sync-test: ok');
