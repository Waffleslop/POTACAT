// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The Cloud Tunnel switches itself on when this desktop's account gets Cloud
// access (ECHOCAT ask 2026-11-21 "cloud trial just works", item 1; Casey:
// "yes absolutely"). A trial from POST /v1/auth/register (the desktop's form
// or ECHOCAT's cloud-register) or a change from no access to paid (Stripe or
// BMAC) turns it on, which makes the Stripe success page's "the tunnel
// switches on within a minute" true. It never reopens a tunnel the operator
// turned off: that choice is remembered (settings.cloudTunnelUserOff) until
// they turn it on again themselves.
//
// Pure: the decision only. main.js calls it on every billing state and does
// the enabling.
'use strict';

/** 'trial' | 'paid' | 'none' for a subscription, with the Cloud card's own rules (lib/cloud-billing-ui.js). */
function accessOf(sub, CloudBillingUi) {
  if (!sub || typeof sub !== 'object') return 'none';
  if (!CloudBillingUi.hasAccess(sub)) return 'none';
  return CloudBillingUi.isTrial(sub) ? 'trial' : 'paid';
}

/**
 * @param {object} o
 * @param {string} o.prev        the access seen last time ('none' when never seen)
 * @param {string} o.now         the access now
 * @param {boolean} o.signedIn
 * @param {boolean} o.tunnelOn   the tunnel is already enabled
 * @param {boolean} o.userOff    the operator turned it off themselves
 * @returns {{enable:boolean, why:string}}
 */
function decide({ prev, now, signedIn, tunnelOn, userOff } = {}) {
  if (!signedIn) return { enable: false, why: 'signed-out' };
  if (now === 'none') return { enable: false, why: 'no-access' };
  if (prev && prev !== 'none') return { enable: false, why: 'no-change' }; // trial -> paid is not a new start
  if (tunnelOn) return { enable: false, why: 'already-on' };
  if (userOff) return { enable: false, why: 'operator-off' };
  return { enable: true, why: now === 'trial' ? 'trial-started' : 'paid' };
}

module.exports = { accessOf, decide };
