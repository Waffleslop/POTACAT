/**
 * lib/cloud-billing-ui.js — what the Cloud card, the main-window banner, the
 * Summary card and the ECHOCAT web client say about a member's billing, and
 * which button they offer. One decision for every surface (2026-10-14,
 * Stripe checkout + billing notices + the Cloud prompt).
 *
 * Pure, dual-mode: `require()` in main/renderer, `window.CloudBillingUi` in
 * the ECHOCAT web page (remote-server inlines this file like scope-axis.js).
 *
 * The SERVER decides the billing state and writes the sentence
 * (`subscription.billing` from GET /v1/subscription/status, potacat-cloud
 * lib/billing-notice.js). This module only decides WHERE it shows and HOW
 * LOUD, which button sits next to it, and what the subscribe section offers:
 *
 *   - yellow = still working, a date is coming (ending_soon, canceled);
 *   - orange = act this week (grace, billing_issue);
 *   - red    = sync and tunnel are paused (expired).
 *
 * Why access follows `billing.state` and not the top-level status: a Stripe
 * member who cancels at period end reports status 'canceled' and a card in
 * the 16-day retry reports 'billing_issue' — both still have access, and the
 * old "anything not active/trial is red" rule would have shown a paying
 * member a red pill.
 *
 * Why the Verify button hides for Stripe/Apple/Google members: it is a
 * BuyMeACoffee email match (POST /v1/subscription/verify) and would tell a
 * paying Stripe member "no membership found".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CloudBillingUi = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BMAC_MEMBERSHIP_URL = 'https://buymeacoffee.com/potacat/membership';
  const JOIN_PAGE_URL = 'https://potacat.com/cloud/';
  const STORE_URLS = {
    apple: 'https://apps.apple.com/account/subscriptions',
    google: 'https://play.google.com/store/account/subscriptions',
  };
  const PLANS = {
    monthly: { label: 'Subscribe — $5/month', price: '$5/month', short: '$5/mo' },
    yearly: { label: '$50/year — 2 months free', price: '$50/year', short: '$50/yr' },
  };

  // The checkout watch: the Stripe webhook normally lands within ~10 s.
  const CHECKOUT_POLL_MS = 5000;
  const CHECKOUT_POLL_MAX_MS = 3 * 60 * 1000;
  // Status older than this is refreshed at launch (dated grants change state
  // at midnight UTC; a billing issue arrives by webhook and the next fetch
  // sees it).
  const STATUS_STALE_MS = 12 * 60 * 60 * 1000;
  // The in-app Cloud prompt (CLOUD_PROMPT handoff): a log this size and no
  // account is the person the prompt exists for.
  const PROMPT_MIN_QSOS = 50;
  const PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
  // Trial: the card always says how long is left; the main window speaks up
  // only in the last days, once per launch, dismissable.
  const TRIAL_BANNER_DAYS = 3;
  const TRIAL_URGENT_DAYS = 7;

  const ACCESS_OFF_STATES = ['expired', 'none', 'trial_expired'];
  const ACCESS_ON_STATUSES = ['active', 'trial', 'canceled', 'billing_issue'];

  function toneFor(state) {
    if (state === 'ending_soon' || state === 'canceled') return 'yellow';
    if (state === 'grace' || state === 'billing_issue') return 'orange';
    if (state === 'expired') return 'red';
    return null;
  }

  function fmtDay(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    // UTC, like the server's own sentence — a midnight-UTC expiry must not
    // read as the day before west of Greenwich.
    try {
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  function daysLeft(iso, now) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.ceil((t - (now || Date.now())) / 86400000));
  }

  /**
   * Does this member have Cloud access right now? Prefers the server's
   * billing state; falls back to the top-level status for an older server.
   */
  function hasAccess(sub) {
    if (!sub) return false;
    const b = sub.billing;
    const status = String(sub.status || '').toLowerCase();
    if (b && b.state) {
      if (ACCESS_OFF_STATES.indexOf(b.state) !== -1) return false;
      if (b.state === 'trial') return true;
      // 'ok' with no status (should not happen) still reads as access.
      return status !== 'inactive' && status !== 'expired' || b.state === 'ok';
    }
    if (status === 'trial' || (sub.trialActive === true && status !== 'active' && status !== 'expired')) return true;
    return ACCESS_ON_STATUSES.indexOf(status) !== -1;
  }

  function isTrial(sub) {
    if (!sub) return false;
    const status = String(sub.status || '').toLowerCase();
    if (status === 'active') return false;
    if (sub.billing && sub.billing.state === 'trial') return true;
    return status === 'trial' || (sub.trialActive === true && status !== 'expired');
  }

  function isTrialExpired(sub) {
    if (!sub) return false;
    if (sub.billing && sub.billing.state === 'trial_expired') return true;
    const status = String(sub.status || '').toLowerCase();
    return status !== 'active' && sub.trialActive === false && !!sub.trialExpiresAt && !hasAccess(sub);
  }

  /**
   * The "Manage subscription" control for a member with access, by provider.
   * `kind: 'portal'` means POST /v1/stripe/portal (the status endpoint's
   * action.url is a signed portal link and is preferred when present, but
   * the 403 body's copy carries null).
   */
  function manageFor(sub) {
    if (!sub || !hasAccess(sub) || isTrial(sub)) return null;
    const b = sub.billing || {};
    const provider = b.provider || null;
    const actionUrl = b.action && b.action.url ? b.action.url : null;
    switch (provider) {
      case 'stripe':
        return { label: 'Manage subscription', kind: 'portal', url: actionUrl, provider };
      case 'bmac':
        return { label: 'Manage on Buy Me a Coffee', kind: 'url', url: BMAC_MEMBERSHIP_URL, provider };
      case 'apple':
        return { label: 'Manage in App Store', kind: 'url', url: STORE_URLS.apple, provider };
      case 'google':
        return { label: 'Manage in Google Play', kind: 'url', url: STORE_URLS.google, provider };
      case 'donation':
      case 'admin':
        return null;
      default:
        // An older server (no billing object) — the membership page is the
        // only place a member could have paid before Stripe existed.
        if (!sub.billing) return { label: 'Manage subscription', kind: 'url', url: BMAC_MEMBERSHIP_URL, provider: 'bmac' };
        return null;
    }
  }

  /**
   * Everything a surface needs to draw the member's billing, in one object.
   *
   * @param {object|null} sub  the /v1/subscription/status payload (or the
   *   desktop's cached copy of it); null = unknown.
   * @param {object} [opts]
   *   stripeConfigured {boolean}  false after a 503 stripe_not_configured —
   *                               hide the Stripe buttons, keep BMAC.
   *   now {number}                for tests.
   */
  function describeBilling(sub, opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const stripeOk = opts.stripeConfigured !== false;
    const b = (sub && sub.billing) || null;
    const status = sub ? String(sub.status || '').toLowerCase() : '';
    const access = hasAccess(sub);
    const trial = isTrial(sub);
    const trialExpired = !trial && isTrialExpired(sub);
    const tDays = trial ? (typeof sub.trialDaysLeft === 'number' ? sub.trialDaysLeft : daysLeft(sub.trialExpiresAt, now)) : null;
    const provider = b ? b.provider : null;

    // Pill — what the status word says and its colour class.
    let pillText, pillClass, pillTone;
    if (!sub) { pillText = 'unknown'; pillClass = 'disconnected'; pillTone = 'bad'; }
    else if (trial) {
      pillText = 'free trial'; pillClass = 'connected'; pillTone = 'warn';
    } else if (b && (b.state === 'grace' || b.state === 'billing_issue')) {
      pillText = b.state === 'grace' ? 'grace period' : 'payment problem'; pillClass = 'connected'; pillTone = 'warn';
    } else if (b && b.state === 'canceled') {
      pillText = b.expiresAt ? 'ends ' + fmtDay(b.expiresAt) : 'canceled'; pillClass = 'connected'; pillTone = 'warn';
    } else if (b && b.state === 'expired') {
      pillText = 'expired'; pillClass = 'disconnected'; pillTone = 'bad';
    } else if (access) {
      pillText = 'active'; pillClass = 'connected'; pillTone = 'ok';
    } else if (trialExpired) {
      pillText = 'trial expired'; pillClass = 'disconnected'; pillTone = 'bad';
    } else {
      pillText = status === 'expired' ? 'expired' : (status || 'inactive'); pillClass = 'disconnected'; pillTone = 'bad';
    }

    // Strip in the Cloud card — the server's sentence, iff it says notify.
    let strip = null;
    if (b && b.notify === true && toneFor(b.state)) {
      strip = { tone: toneFor(b.state), state: b.state, message: b.message || '', actionLabel: (b.action && b.action.label) || 'Fix billing' };
    }

    // Main-window banner — only the states where this week matters, plus the
    // last days of a trial (one line, dismissable per launch).
    let banner = null;
    if (strip && (b.state === 'grace' || b.state === 'billing_issue' || b.state === 'expired')) {
      banner = { key: 'billing:' + b.state, tone: strip.tone, message: strip.message, actionLabel: strip.actionLabel, action: 'billing' };
    } else if (trial && tDays !== null && tDays <= TRIAL_BANNER_DAYS) {
      const when = tDays <= 0 ? 'today' : tDays === 1 ? 'tomorrow' : 'in ' + tDays + ' days';
      banner = {
        key: 'trial:' + tDays, tone: 'yellow',
        message: 'Your POTACAT Cloud free trial ends ' + when + '. Subscribe now and nothing changes that day: your backup, sync and remote tunnel keep running.',
        actionLabel: PLANS.monthly.label, action: 'subscribe', plan: 'monthly',
      };
    }

    // Trial line inside the card (always during a trial).
    let trialLine = null;
    if (trial) {
      const left = tDays === null ? '' : tDays <= 0 ? 'ends today' : tDays === 1 ? '1 day left' : tDays + ' days left';
      trialLine = { daysLeft: tDays, urgent: tDays !== null && tDays <= TRIAL_URGENT_DAYS, text: left ? 'Free trial — ' + left : 'Free trial' };
    }

    // Subscribe section: shown while on trial, after it, or with no access.
    const subscribeShow = trial || !access;
    const subscribe = {
      show: subscribeShow,
      stripe: subscribeShow && stripeOk,
      bmac: subscribeShow,
      heading: !subscribeShow ? '' : trial
        ? 'Keep everything running after the trial. Subscribe now; you are not charged twice and nothing changes on the day the trial ends.'
        : trialExpired
          ? 'Your free trial has ended. Subscribe to turn backup, sync and the remote tunnel back on.'
          : (b && b.state === 'expired')
            ? 'Your access has lapsed. Subscribe to turn backup, sync and the remote tunnel back on.'
            : 'Subscribe to back up your log, sync it everywhere, and reach this rig from anywhere.',
    };

    // Verify (BMAC email match) belongs only to a BMAC payer.
    const verify = { show: subscribeShow && provider !== 'stripe' && provider !== 'apple' && provider !== 'google' };

    const manage = manageFor(sub);
    // A dated grant still in the future; in grace the strip already says
    // the date has passed.
    const accessThrough = (access && !trial && !manage && b && (provider === 'donation' || provider === 'admin')
      && b.expiresAt && new Date(b.expiresAt).getTime() > now)
      ? 'Access through ' + fmtDay(b.expiresAt) : null;

    return {
      access, trial, trialExpired, provider, status,
      pill: { text: pillText, cls: pillClass, tone: pillTone },
      strip, banner, trialLine, subscribe, verify, manage, accessThrough,
    };
  }

  /**
   * What the Summary card (and ECHOCAT settings-tab twin) shows. `trial`
   * stays "Free Trial" but its action is now the subscribe button — the one
   * place a trial member looks every day.
   */
  function summaryCard(status) {
    const loggedIn = !!(status && status.loggedIn);
    if (!loggedIn) {
      return { pill: 'Inactive', tone: 'bad', backup: 'Your logbook is NOT backed up to the POTACAT Cloud.',
        meta: 'Start a free 30-day trial to back up your log and reach this rig from anywhere.', actions: ['signup'] };
    }
    const d = describeBilling(status.subscription || null);
    if (d.trial) {
      const left = d.trialLine && d.trialLine.daysLeft !== null ? ' (' + d.trialLine.text.replace('Free trial — ', '') + ')' : '';
      return { pill: 'Free Trial', tone: 'warn', backup: 'Your logbook is backed up to the POTACAT Cloud.',
        meta: 'Free trial' + left + '. Subscribe now and nothing changes when it ends.', actions: ['subscribe-monthly', 'sync-now'] };
    }
    if (d.access) {
      const warn = d.strip ? d.strip.message : '';
      return { pill: d.pill.text === 'active' ? 'Active' : d.pill.text, tone: d.strip ? 'warn' : 'ok',
        backup: 'Your logbook is backed up to the POTACAT Cloud.', meta: warn, actions: d.strip ? ['billing', 'sync-now'] : ['sync-now', 'manage'] };
    }
    return { pill: d.trialExpired ? 'Trial ended' : (d.pill.text === 'expired' ? 'Expired' : 'Signed in'), tone: 'bad',
      backup: 'Your logbook is NOT backed up — no active subscription.',
      meta: d.strip ? d.strip.message : (d.trialExpired ? 'Your free trial has ended.' : ''), actions: ['subscribe-monthly', 'subscribe-yearly'] };
  }

  /** Should the checkout watch keep polling? */
  function decideCheckoutPoll(startedAt, now, sub) {
    const elapsed = Math.max(0, (now || Date.now()) - startedAt);
    if (sub && String(sub.status || '').toLowerCase() === 'active') return { done: true, result: 'active', elapsed };
    if (elapsed >= CHECKOUT_POLL_MAX_MS) return { done: true, result: 'timeout', elapsed };
    return { done: false, result: null, elapsed, nextInMs: CHECKOUT_POLL_MS };
  }

  /**
   * The in-app Cloud prompt: 50+ local QSOs, no Cloud account, not snoozed,
   * once per launch, never while the radio is keyed or another launch card
   * is up.
   */
  function decideCloudPrompt(input) {
    const i = input || {};
    const now = i.now || Date.now();
    if (i.loggedIn) return { show: false, reason: 'has-account' };
    if (i.shownThisLaunch) return { show: false, reason: 'shown' };
    if (i.guestPass) return { show: false, reason: 'guest' };
    if (!(Number(i.localQsos) >= PROMPT_MIN_QSOS)) return { show: false, reason: 'few-qsos' };
    if (i.snoozedUntil && Number(i.snoozedUntil) > now) return { show: false, reason: 'snoozed' };
    if (i.radioBusy) return { show: false, reason: 'busy', retry: true };
    if (i.otherCardVisible) return { show: false, reason: 'other-card', retry: true };
    return { show: true, reason: 'ok', qsos: Number(i.localQsos) };
  }

  /** "Your log is not backed up yet" — an account that never uploaded. */
  function decideUploadNudge(input) {
    const i = input || {};
    if (!i.loggedIn) return { show: false };
    if (!hasAccess(i.subscription)) return { show: false };
    const local = Number(i.localQsos);
    if (!(local > 0)) return { show: false };
    // Only a KNOWN zero — null/undefined (status not fetched) is not "none".
    if (!(typeof i.cloudQsos === 'number' && i.cloudQsos === 0)) return { show: false };
    return { show: true, localQsos: local };
  }

  function promptCopy(qsos) {
    const n = Number(qsos) || 0;
    return {
      title: 'Your log lives on one disk.',
      body: 'You have ' + n.toLocaleString() + ' QSOs here and nowhere else. POTACAT Cloud backs them up, syncs them to your other shack PCs and ECHOCAT, and gives you a remote tunnel to this rig.',
      offer: '30 days free — your log is uploaded in the first step.',
      primary: 'Start free trial', secondary: 'Not now',
    };
  }

  /** The potacat.com join page with the form prefilled. */
  function joinPageUrl(prefill) {
    const p = prefill || {};
    const q = [];
    if (p.name) q.push('name=' + encodeURIComponent(String(p.name).slice(0, 80)));
    if (p.email) q.push('email=' + encodeURIComponent(p.email));
    if (p.callsign) q.push('callsign=' + encodeURIComponent(String(p.callsign).toUpperCase()));
    if (p.plan === 'yearly' || p.plan === 'monthly') q.push('plan=' + p.plan);
    return JOIN_PAGE_URL + (q.length ? '?' + q.join('&') : '');
  }

  function isStale(fetchedAt, now) {
    if (!fetchedAt) return true;
    return ((now || Date.now()) - Number(fetchedAt)) >= STATUS_STALE_MS;
  }

  return {
    BMAC_MEMBERSHIP_URL, JOIN_PAGE_URL, STORE_URLS, PLANS,
    CHECKOUT_POLL_MS, CHECKOUT_POLL_MAX_MS, STATUS_STALE_MS,
    PROMPT_MIN_QSOS, PROMPT_SNOOZE_MS, TRIAL_BANNER_DAYS, TRIAL_URGENT_DAYS,
    hasAccess, isTrial, isTrialExpired, manageFor, describeBilling, summaryCard,
    decideCheckoutPoll, decideCloudPrompt, decideUploadNudge, promptCopy, joinPageUrl,
    isStale, toneFor, fmtDay,
  };
}));
