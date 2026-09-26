'use strict';

// The desktop's one-time "Rate ECHOCAT" ask (potacat-meta
// work/open/echocat-store-review-ask-desktop.md, Casey 2026-09-26).
//
// ECHOCAT has too few store reviews, and every ECHOCAT user is a POTACAT
// desktop user. On the phone the store rules allow only the rate-limited
// system sheet; the desktop may ask in plain words — under the same rules:
//   - no incentives, no gating (everyone eligible gets the same buttons),
//   - never while operating (the calm-moment gates are not optional),
//   - at most TWICE per install, ever.
//
// Pure: main gathers the facts, this decides. test/review-ask-test.js.

const DAY_MS = 24 * 3600 * 1000;
const MIN_PAIRED_DAYS = 7;       // first phone paired at least a week ago
const MIN_DAYS_SEEN = 3;         // a phone connected on 3 different days
const SNOOZE_DAYS = 30;          // "Not now"
const MAX_SHOWN = 2;             // the second "Not now" is final

const STORE_LINKS = {
  ios: 'https://apps.apple.com/app/id6766321194?action=write-review',
  android: 'https://play.google.com/store/apps/details?id=co.cmox.echocat',
};

function freshAsk() {
  return { state: 'pending', snoozedUntil: 0, shownCount: 0, daysSeen: [] };
}

function normalizeAsk(a) {
  const f = freshAsk();
  if (!a || typeof a !== 'object') return f;
  return {
    state: ['pending', 'snoozed', 'done'].includes(a.state) ? a.state : 'pending',
    snoozedUntil: Number(a.snoozedUntil) || 0,
    shownCount: Number(a.shownCount) || 0,
    daysSeen: Array.isArray(a.daysSeen) ? a.daysSeen.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, MIN_DAYS_SEEN) : [],
  };
}

/** Which stores the paired phones and tablets are on (web clients never count). */
function phoneStores(devices) {
  const out = new Set();
  for (const d of devices || []) {
    const p = String((d && d.platform) || '').toLowerCase();
    if (/^ios\b/.test(p)) out.add('ios');
    else if (/^android\b/.test(p)) out.add('android');
  }
  return ['ios', 'android'].filter(s => out.has(s));
}

/** A phone's hello platform ("ios 18.2 phone", "android 34 tablet")? */
function isPhonePlatform(platform) {
  return /^(ios|android)\b/i.test(String(platform || ''));
}

/** Record that a phone connected on local day `day` ('YYYY-MM-DD'). */
function recordDaySeen(ask, day) {
  const a = normalizeAsk(ask);
  if (a.daysSeen.length >= MIN_DAYS_SEEN || a.daysSeen.includes(day)) return a;
  return { ...a, daysSeen: [...a.daysSeen, day] };
}

/**
 * Should the card show now?
 * @param {object} o
 *   devices  listPairedDevices() (platform, addedAt)
 *   ask      settings.echocatReviewAsk
 *   now      ms
 *   calm     { ok: boolean, why: string } from main (TX, FT8, Run, QSO, pass, uptime)
 * @returns {{show: boolean, why: string, stores: string[]}}
 */
function decideReviewAsk(o) {
  const a = normalizeAsk(o.ask);
  const now = Number(o.now) || Date.now();
  const stores = phoneStores(o.devices);
  const no = (why) => ({ show: false, why, stores });
  if (a.state === 'done') return no('done');
  if (a.shownCount >= MAX_SHOWN) return no('shown twice');
  if (a.state === 'snoozed' && now < a.snoozedUntil) return no('snoozed');
  if (!stores.length) return no('no paired phone');
  const phones = (o.devices || []).filter(d => phoneStores([d]).length);
  const firstPaired = Math.min(...phones.map(d => Date.parse(d.addedAt)).filter(Number.isFinite));
  if (!Number.isFinite(firstPaired) || now - firstPaired < MIN_PAIRED_DAYS * DAY_MS) return no('paired less than a week ago');
  if (a.daysSeen.length < MIN_DAYS_SEEN) return no('phone seen on fewer than 3 days');
  if (!o.calm || !o.calm.ok) return no('busy: ' + ((o.calm && o.calm.why) || 'unknown'));
  return { show: true, why: 'eligible', stores };
}

/** The card was actually put on screen. */
function markShown(ask) {
  const a = normalizeAsk(ask);
  return { ...a, shownCount: a.shownCount + 1 };
}

/**
 * The operator's answer. 'rate' and 'never' end it; 'later' (Not now, or the
 * close button) snoozes 30 days, and a second 'later' ends it too.
 */
function applyAction(ask, action, now = Date.now()) {
  const a = normalizeAsk(ask);
  if (action === 'rate' || action === 'never') return { ...a, state: 'done', snoozedUntil: 0 };
  if (action === 'later') {
    if (a.shownCount >= MAX_SHOWN) return { ...a, state: 'done', snoozedUntil: 0 };
    return { ...a, state: 'snoozed', snoozedUntil: now + SNOOZE_DAYS * DAY_MS };
  }
  return a;
}

module.exports = {
  STORE_LINKS, MIN_PAIRED_DAYS, MIN_DAYS_SEEN, SNOOZE_DAYS, MAX_SHOWN,
  freshAsk, normalizeAsk, phoneStores, isPhonePlatform, recordDaySeen,
  decideReviewAsk, markShown, applyAction,
};
