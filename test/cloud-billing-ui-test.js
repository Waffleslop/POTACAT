#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// lib/cloud-billing-ui.js — Stripe checkout, billing notices and the Cloud
// prompt (2026-10-14; cloud handoffs BILLING_UX + CLOUD_PROMPT).
//
// Run:  node test/cloud-billing-ui-test.js

const fs = require('fs');
const path = require('path');
const B = require('../lib/cloud-billing-ui');

let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}
function assertEq(actual, expected, msg) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function section(name) { console.log(`\n=== ${name} ===`); }
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const day = 86400000;
function sub(status, billing, extra) {
  return Object.assign({ status, trialActive: false, trialDaysLeft: 0, trialExpiresAt: null, callsign: 'K3SBP', billing }, extra || {});
}
function bill(state, provider, extra) {
  return Object.assign({ state, reason: null, provider, autoRenews: provider === 'stripe' || provider === 'bmac' || provider === 'apple' || provider === 'google',
    expiresAt: null, graceEndsAt: null, daysLeft: null, action: null, message: '', notify: false }, extra || {});
}

section('Access follows billing.state, not the top-level status');
assert(B.hasAccess(sub('active', bill('ok', 'stripe'))), 'active stripe member has access');
assert(B.hasAccess(sub('canceled', bill('canceled', 'stripe', { expiresAt: new Date(NOW + 20 * day).toISOString() }))), 'cancel-at-period-end still has access');
assert(B.hasAccess(sub('billing_issue', bill('billing_issue', 'apple', { notify: true }))), 'card retry still has access');
assert(B.hasAccess(sub('active', bill('grace', 'donation', { notify: true }))), 'grace still has access');
assert(!B.hasAccess(sub('expired', bill('expired', 'donation', { notify: true }))), 'expired = no access');
assert(!B.hasAccess(sub('inactive', bill('none', 'none'))), 'never paid = no access');
assert(!B.hasAccess(sub('inactive', bill('trial_expired', 'trial'))), 'trial expired = no access');
assert(B.hasAccess(sub('trial', bill('trial', 'trial'), { trialActive: true, trialDaysLeft: 12 })), 'trial has access');
assert(B.hasAccess(sub('active', null)), 'older server (no billing): active has access');
assert(B.hasAccess(sub('canceled', null)), 'older server: canceled still has access');
assert(!B.hasAccess(sub('inactive', null)), 'older server: inactive none');
assert(B.hasAccess(sub('inactive', null, { trialActive: true, trialExpiresAt: new Date(NOW + 5 * day).toISOString() })), 'older server: trialActive counts');
assert(!B.hasAccess(null), 'null = no access');

section('Pill: a paying member is never red');
assertEq(B.describeBilling(sub('canceled', bill('canceled', 'stripe', { expiresAt: '2026-11-14T00:00:00Z' })), { now: NOW }).pill.tone, 'warn', 'canceled-with-time-left is warn, not bad');
assertEq(B.describeBilling(sub('billing_issue', bill('billing_issue', 'stripe', { notify: true })), { now: NOW }).pill.text, 'payment problem', 'billing_issue pill text');
assertEq(B.describeBilling(sub('active', bill('ok', 'bmac')), { now: NOW }).pill, { text: 'active', cls: 'connected', tone: 'ok' }, 'active pill');
assertEq(B.describeBilling(sub('expired', bill('expired', 'donation', { notify: true })), { now: NOW }).pill, { text: 'expired', cls: 'disconnected', tone: 'bad' }, 'expired pill');
assertEq(B.describeBilling(sub('trial', bill('trial', 'trial'), { trialActive: true, trialDaysLeft: 9 }), { now: NOW }).pill.text, 'free trial', 'trial pill');
assertEq(B.describeBilling(sub('inactive', bill('trial_expired', 'trial'), { trialActive: false, trialExpiresAt: '2026-09-01T00:00:00Z' }), { now: NOW }).pill.text, 'trial expired', 'trial expired pill');

section('Strip: the server sentence, iff notify, with fixed tones');
{
  const d = B.describeBilling(sub('active', bill('ending_soon', 'donation', { notify: true, message: 'Ends soon.', action: { label: 'Subscribe', url: 'https://x' } })));
  assertEq(d.strip, { tone: 'yellow', state: 'ending_soon', message: 'Ends soon.', actionLabel: 'Subscribe' }, 'ending_soon strip');
  assert(d.banner === null, 'ending_soon: no main-window banner');
}
assertEq(B.describeBilling(sub('active', bill('grace', 'bmac', { notify: true, message: 'G' }))).strip.tone, 'orange', 'grace = orange');
assertEq(B.describeBilling(sub('billing_issue', bill('billing_issue', 'google', { notify: true, message: 'B' }))).strip.tone, 'orange', 'billing_issue = orange');
assertEq(B.describeBilling(sub('expired', bill('expired', 'admin', { notify: true, message: 'E' }))).strip.tone, 'red', 'expired = red');
assert(B.describeBilling(sub('active', bill('ok', 'stripe'))).strip === null, 'ok = no strip');
assert(B.describeBilling(sub('canceled', bill('canceled', 'stripe', { notify: false, message: 'ends' }))).strip === null, 'canceled before the last 7 days: nothing (notify false)');
assert(B.describeBilling(sub('active', bill('grace', 'bmac', { notify: false }))).strip === null, 'notify false = no strip, whatever the state');
assertEq(B.describeBilling(sub('active', bill('grace', 'bmac', { notify: true, message: 'G' }))).strip.actionLabel, 'Fix billing', 'missing action label falls back');

section('Banner: grace / billing_issue / expired, and the last 3 trial days');
assertEq(B.describeBilling(sub('active', bill('grace', 'bmac', { notify: true, message: 'G', action: { label: 'Update on BMAC', url: 'u' } }))).banner,
  { key: 'billing:grace', tone: 'orange', message: 'G', actionLabel: 'Update on BMAC', action: 'billing' }, 'grace banner');
assert(B.describeBilling(sub('expired', bill('expired', 'donation', { notify: true, message: 'E' }))).banner.tone === 'red', 'expired banner red');
assert(B.describeBilling(sub('active', bill('ending_soon', 'donation', { notify: true, message: 'S' }))).banner === null, 'ending_soon: card strip only');
{
  const t = (d) => B.describeBilling(sub('trial', bill('trial', 'trial'), { trialActive: true, trialDaysLeft: d }), { now: NOW });
  assert(t(12).banner === null, 'trial with 12 days: no banner');
  assert(t(3).banner && t(3).banner.action === 'subscribe' && t(3).banner.plan === 'monthly', 'trial with 3 days: subscribe banner');
  assert(/in 3 days/.test(t(3).banner.message), 'trial banner names the days');
  assert(/tomorrow/.test(t(1).banner.message), 'trial banner: tomorrow');
  assert(/today/.test(t(0).banner.message), 'trial banner: today');
  assertEq(t(2).banner.key, 'trial:2', 'trial banner key carries the day (a dismiss does not hide tomorrow\'s)');
  assert(t(12).trialLine.text === 'Free trial — 12 days left' && !t(12).trialLine.urgent, 'trial line 12 days, not urgent');
  assert(t(7).trialLine.urgent, 'trial line urgent at 7 days');
  assertEq(t(1).trialLine.text, 'Free trial — 1 day left', 'singular day');
}

section('Subscribe section: trial, after it, no access — never for a paying member');
assert(B.describeBilling(sub('trial', bill('trial', 'trial'), { trialActive: true, trialDaysLeft: 20 })).subscribe.show, 'trial shows subscribe');
assert(/not charged twice/.test(B.describeBilling(sub('trial', bill('trial', 'trial'), { trialActive: true, trialDaysLeft: 20 })).subscribe.heading), 'trial heading reassures');
assert(!B.describeBilling(sub('active', bill('ok', 'bmac'))).subscribe.show, 'active bmac: no subscribe');
assert(!B.describeBilling(sub('active', bill('ok', 'stripe'))).subscribe.show, 'active stripe: no subscribe');
assert(!B.describeBilling(sub('canceled', bill('canceled', 'stripe', { expiresAt: '2026-11-14T00:00:00Z', notify: true, message: 'c', action: { label: 'Resubscribe', url: null } }))).subscribe.show, 'canceled with time left: the strip\'s Resubscribe, not the subscribe section');
assert(B.describeBilling(sub('expired', bill('expired', 'donation', { notify: true }))).subscribe.show, 'expired shows subscribe');
assert(B.describeBilling(sub('inactive', bill('none', 'none'))).subscribe.show, 'never paid shows subscribe');
{
  const d = B.describeBilling(sub('inactive', bill('none', 'none')), { stripeConfigured: false });
  assert(d.subscribe.show && !d.subscribe.stripe && d.subscribe.bmac, '503 stripe_not_configured: BMAC only');
}
assert(B.describeBilling(sub('inactive', bill('none', 'none'))).subscribe.stripe, 'Stripe buttons by default');

section('Verify (BMAC email match) hides for Stripe / Apple / Google');
assert(B.describeBilling(sub('inactive', bill('none', 'none'))).verify.show, 'unknown provider: verify offered');
assert(B.describeBilling(sub('inactive', bill('trial_expired', 'trial'))).verify.show, 'trial expired: verify offered (may have paid on BMAC)');
assert(!B.describeBilling(sub('expired', bill('expired', 'stripe', { notify: true }))).verify.show, 'stripe: no verify');
assert(!B.describeBilling(sub('expired', bill('expired', 'apple', { notify: true }))).verify.show, 'apple: no verify');
assert(!B.describeBilling(sub('active', bill('ok', 'bmac'))).verify.show, 'active: no verify at all');

section('Manage by provider');
assertEq(B.manageFor(sub('active', bill('ok', 'stripe', { action: { label: 'Manage subscription', url: 'https://api.potacat.com/v1/stripe/portal-link?u=1&t=x' } }))),
  { label: 'Manage subscription', kind: 'portal', url: 'https://api.potacat.com/v1/stripe/portal-link?u=1&t=x', provider: 'stripe' }, 'stripe with signed link');
assertEq(B.manageFor(sub('active', bill('ok', 'stripe'))).url, null, 'stripe without link → portal endpoint');
assertEq(B.manageFor(sub('active', bill('ok', 'bmac'))), { label: 'Manage on Buy Me a Coffee', kind: 'url', url: B.BMAC_MEMBERSHIP_URL, provider: 'bmac' }, 'bmac');
assertEq(B.manageFor(sub('active', bill('ok', 'apple'))).url, B.STORE_URLS.apple, 'apple → App Store');
assertEq(B.manageFor(sub('active', bill('ok', 'google'))).url, B.STORE_URLS.google, 'google → Play');
assert(B.manageFor(sub('active', bill('ok', 'donation', { expiresAt: '2027-02-26T00:00:00Z' }))) === null, 'donation: nothing to manage');
assert(/Access through/.test(B.describeBilling(sub('active', bill('ok', 'donation', { expiresAt: '2027-02-26T00:00:00Z' }))).accessThrough), 'donation shows Access through <date>');
assert(B.manageFor(sub('trial', bill('trial', 'trial'), { trialActive: true })) === null, 'trial: nothing to manage');
assert(B.manageFor(sub('expired', bill('expired', 'stripe'))) === null, 'no access: nothing to manage');
assertEq(B.manageFor(sub('active', null)).provider, 'bmac', 'older server: the membership page');

section('Summary card');
assertEq(B.summaryCard({ loggedIn: false }).actions, ['signup'], 'signed out → sign up (the free-trial form, not a payment page)');
{
  const v = B.summaryCard({ loggedIn: true, subscription: sub('trial', bill('trial', 'trial'), { trialActive: true, trialDaysLeft: 4 }) });
  assertEq(v.pill, 'Free Trial', 'trial pill');
  assertEq(v.actions, ['subscribe-monthly', 'sync-now'], 'trial card leads with subscribe');
  assert(/4 days left/.test(v.meta), 'trial card says days left');
}
assertEq(B.summaryCard({ loggedIn: true, subscription: sub('active', bill('ok', 'stripe')) }).actions, ['sync-now', 'manage'], 'active → sync + manage');
{
  const v = B.summaryCard({ loggedIn: true, subscription: sub('active', bill('grace', 'bmac', { notify: true, message: 'Grace.' })) });
  assertEq(v.actions, ['billing', 'sync-now'], 'grace → fix billing first');
  assertEq(v.meta, 'Grace.', 'grace meta is the server sentence');
}
assertEq(B.summaryCard({ loggedIn: true, subscription: sub('inactive', bill('trial_expired', 'trial'), { trialActive: false, trialExpiresAt: '2026-09-01T00:00:00Z' }) }).actions, ['subscribe-monthly', 'subscribe-yearly'], 'trial ended → both plans');
// K4PEZ: paid annual inside the first 30 days still carries trialActive=true.
assertEq(B.summaryCard({ loggedIn: true, subscription: sub('active', bill('ok', 'bmac'), { trialActive: true, trialDaysLeft: 10 }) }).pill, 'Active', 'active wins over trial (K4PEZ)');

section('Checkout watch');
assertEq(B.decideCheckoutPoll(NOW, NOW + 5000, sub('trial', bill('trial', 'trial'))).done, false, 'still trial at 5 s: keep polling');
assertEq(B.decideCheckoutPoll(NOW, NOW + 5000, null).nextInMs, B.CHECKOUT_POLL_MS, 'poll interval 5 s');
assertEq(B.decideCheckoutPoll(NOW, NOW + 12000, sub('active', bill('ok', 'stripe'))).result, 'active', 'active → done');
assertEq(B.decideCheckoutPoll(NOW, NOW + B.CHECKOUT_POLL_MAX_MS, sub('trial', bill('trial', 'trial'))).result, 'timeout', '3 min → timeout');

section('The Cloud prompt');
const base = { loggedIn: false, localQsos: 120, snoozedUntil: 0, radioBusy: false, otherCardVisible: false, shownThisLaunch: false, guestPass: false, now: NOW };
assertEq(B.decideCloudPrompt(base), { show: true, reason: 'ok', qsos: 120 }, 'the person it is for');
assertEq(B.decideCloudPrompt({ ...base, localQsos: 49 }).reason, 'few-qsos', '49 QSOs: not yet');
assertEq(B.decideCloudPrompt({ ...base, localQsos: 50 }).show, true, '50 QSOs: yes');
assertEq(B.decideCloudPrompt({ ...base, loggedIn: true }).reason, 'has-account', 'has an account: never');
assertEq(B.decideCloudPrompt({ ...base, snoozedUntil: NOW + day }).reason, 'snoozed', 'snoozed');
assertEq(B.decideCloudPrompt({ ...base, snoozedUntil: NOW - day }).show, true, 'snooze over');
assertEq(B.decideCloudPrompt({ ...base, shownThisLaunch: true }).reason, 'shown', 'once per launch');
assertEq(B.decideCloudPrompt({ ...base, radioBusy: true }), { show: false, reason: 'busy', retry: true }, 'never over a transmission; retries');
assertEq(B.decideCloudPrompt({ ...base, otherCardVisible: true }).retry, true, 'another launch card up: retry later');
assertEq(B.decideCloudPrompt({ ...base, guestPass: true }).reason, 'guest', 'guest pass: never');
assertEq(B.PROMPT_SNOOZE_MS, 30 * day, 'snooze is 30 days');
assert(/120 QSOs here and nowhere else/.test(B.promptCopy(120).body), 'copy names the count');
assert(/uploaded in the first step/.test(B.promptCopy(120).offer), 'copy promises the upload');

section('Upload nudge (an account that never uploaded)');
assert(B.decideUploadNudge({ loggedIn: true, subscription: sub('trial', bill('trial', 'trial'), { trialActive: true }), cloudQsos: 0, localQsos: 300 }).show, 'trial, 0 in cloud, 300 local → nudge');
assert(!B.decideUploadNudge({ loggedIn: true, subscription: sub('trial', bill('trial', 'trial'), { trialActive: true }), cloudQsos: 300, localQsos: 300 }).show, 'uploaded → no nudge');
assert(!B.decideUploadNudge({ loggedIn: true, subscription: sub('trial', bill('trial', 'trial'), { trialActive: true }), cloudQsos: null, localQsos: 300 }).show, 'unknown cloud count → no nudge');
assert(!B.decideUploadNudge({ loggedIn: true, subscription: sub('expired', bill('expired', 'donation')), cloudQsos: 0, localQsos: 300 }).show, 'no access → the subscribe section, not the nudge');
assert(!B.decideUploadNudge({ loggedIn: false, cloudQsos: 0, localQsos: 300 }).show, 'signed out → no nudge');
assert(!B.decideUploadNudge({ loggedIn: true, subscription: sub('active', bill('ok', 'bmac')), cloudQsos: 0, localQsos: 0 }).show, 'empty local log → nothing to upload');

section('Join page prefill (potacat.com/cloud/?email=&callsign=&plan=&name=)');
assertEq(B.joinPageUrl({ email: 'a@b.c', callsign: 'kw4fm', plan: 'yearly' }), 'https://potacat.com/cloud/?email=a%40b.c&callsign=KW4FM&plan=yearly', 'prefill, callsign uppercased');
assertEq(B.joinPageUrl({}), 'https://potacat.com/cloud/', 'bare');
assertEq(B.joinPageUrl({ plan: 'weekly' }), 'https://potacat.com/cloud/', 'unknown plan dropped');
assert(/name=Casey%20S/.test(B.joinPageUrl({ name: 'Casey S' })), 'name carried');

section('Staleness');
assert(B.isStale(0), 'never fetched = stale');
assert(B.isStale(NOW - 13 * 3600000, NOW), '13 h = stale');
assert(!B.isStale(NOW - 11 * 3600000, NOW), '11 h = fresh');

section('Source guards');
{
  // Every Stripe URL opens from main: cloud-ipc uses shell.openExternal for
  // checkout + portal, and the renderer never passes a Stripe URL through
  // the allow-listed open-external IPC (which has no Stripe host and fails
  // closed silently).
  const ipc = read('lib/cloud-ipc.js');
  assert(/\/v1\/stripe\/checkout/.test(ipc) && /\/v1\/stripe\/portal/.test(ipc), 'cloud-ipc calls the Stripe endpoints');
  assert(/shell\.openExternal\(res\.url\)/.test(ipc), 'cloud-ipc opens the checkout URL itself');
  assert(!/ipcMain\.handle\('cloud-open-subscribe', async \(\) => \{\s*const settings = ctx\.getSettings\(\);\s*const bmacUrl/.test(ipc), 'the old BMAC-only subscribe handler is gone');
  const main = read('main.js');
  const allow = main.slice(main.indexOf("ipcMain.on('open-external'"), main.indexOf("ipcMain.on('open-external'") + 3000);
  assert(!/stripe\.com/.test(allow), 'no Stripe host on the renderer allow-list (they open from main)');
  for (const f of ['renderer/cloud-ui.js', 'renderer/app.js']) {
    const src = read(f);
    assert(!/openExternal\([^)]*stripe/i.test(src), `${f}: no Stripe URL through open-external`);
    assert(!/buymeacoffee\.com\/potacat\/membership/.test(src), `${f}: the membership URL lives only in lib/cloud-billing-ui.js and cloud-ipc`);
  }
  // Donations stay on Buy Me a Coffee (Casey: keep BMAC everywhere).
  assert(/buymeacoffee\.com\/potacat'\)/.test(read('renderer/app.js')), 'the coffee links (donations) are untouched');
}
{
  // The web client renders from the same module the desktop does.
  const rs = read('lib/remote-server.js');
  assert(/cloud-billing-ui\.js/.test(rs) && /<!-- cloud-billing-ui-js -->/.test(rs), 'remote-server inlines lib/cloud-billing-ui.js');
  assert(/<!-- cloud-billing-ui-js -->/.test(read('renderer/remote.html')), 'remote.html has the placeholder');
  assert(/'cloud-billing'/.test(rs), 'hello advertises cloud-billing');
  // A Guest Pass never reaches the owner's billing.
  const demux = rs.slice(rs.indexOf("case 'cloud-stripe-checkout'"), rs.indexOf("case 'cloud-stripe-portal'") + 400);
  assert((demux.match(/ws\._passSession/g) || []).length >= 2, 'both Stripe C2S messages refuse a Guest Pass');
  assert(/client\._passSession \|\| client\.readyState/.test(rs), 'billing broadcasts skip Guest Pass clients');
  const proto = read('lib/echocat-protocol.js');
  for (const m of ['cloud-stripe-checkout', 'cloud-stripe-portal', 'cloud-stripe-result', 'cloud-billing-state', 'cloud-checkout-state']) {
    assert(new RegExp(`'${m}':`).test(proto), `protocol declares ${m}`);
  }
  // Every billing push from cloud-ipc reaches the web/app clients via main.
  const main = read('main.js');
  assert(/onBillingState: \(payload\) => \{ if \(remoteServer\) remoteServer\.broadcastCloudBilling\(payload\); \}/.test(main), 'main fans cloud-ipc billing state out to ECHOCAT clients');
  // The web bridge's cloud-status carries the live subscription (the old
  // bridge returned a cached stub with no subscription at all).
  assert(/cloudBridge\('cloud-get-status'[\s\S]{0,900}refreshSubscription\('web-status'\)/.test(main), 'web cloud-status carries the live subscription');
  // Renderer loads the module.
  assert(/lib\/cloud-billing-ui\.js/.test(read('renderer/index.html')), 'index.html loads lib/cloud-billing-ui.js');
}
{
  // The main-window banner and the prompt never fetch on a pushed state
  // (cloud-get-status itself emits cloud-billing-state — a fetch would loop).
  const app = read('renderer/app.js');
  const block = app.slice(app.indexOf('function _summaryCloudFromBillingState'), app.indexOf('function _summaryCloudFromBillingState') + 700);
  assert(!/cloudGetStatus/.test(block), 'summary repaint from a pushed state never fetches');
  const cu = read('renderer/cloud-ui.js');
  const onState = cu.slice(cu.indexOf('window.api.onCloudBillingState((p)'), cu.indexOf('window.api.onCloudBillingState((p)') + 500);
  assert(!/refreshStatus\(\)/.test(onState) && !/cloudGetStatus/.test(onState), 'Cloud card repaint from a pushed state never fetches');
  // Sign-up from the prompt runs the upload (the activation event).
  assert(/_autoUploadAfterRegister[\s\S]{0,200}runInitialUpload\(\{ confirm: false \}\)/.test(cu), 'prompt sign-up uploads the log without a second ask');
  // A new account syncs from the first contact (the emails promise it);
  // the toggle used to default OFF.
  const ipc = read('lib/cloud-ipc.js');
  const reg = ipc.slice(ipc.indexOf("ipcMain.handle('cloud-register'"), ipc.indexOf("ipcMain.handle('cloud-register'") + 1400);
  assert(/settings\.cloudSyncEnabled = true;/.test(reg), 'register turns QSO Cloud Sync on');
  const login = ipc.slice(ipc.indexOf("ipcMain.handle('cloud-login'"), ipc.indexOf("ipcMain.handle('cloud-login'") + 1200);
  assert(/cloudSyncEnabled === undefined\) settings\.cloudSyncEnabled = true/.test(login), 'first sign-in on a PC turns sync on, a deliberate OFF is kept');
  // The card has the Refresh control the Stripe return page and the emails name.
  assert(/id="cloud-refresh-link"[^>]*>Refresh</.test(read('renderer/index.html')), 'Cloud card has a Refresh link');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
