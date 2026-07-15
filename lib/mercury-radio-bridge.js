// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Mercury ↔ radio bridge — wires a MercuryClient's events to radio actions
// through INJECTED hooks, so the PTT / arbiter / failsafe policy is unit-
// testable without electron, real timers, or a rig. main.js supplies the hooks
// (keyPtt → handleRemotePtt, acquire/release → the radio-owner arbiter, etc.).
//
// Policy (the risky part of Phase 3, made explicit and tested):
//   - PTT ON  → mark active, key PTT, arm the rolling failsafe.
//   - PTT OFF → mark idle, clear failsafe, unkey PTT.
//   - BUFFER>0 while active → re-arm the failsafe (Mercury still has TX data).
//   - CONNECTED → try to acquire the radio; if refused (JTCAT owns), ABORT the
//     Mercury session to yield rather than collide.
//   - DISCONNECTED → clear failsafe, unkey if still keyed, release the radio.

'use strict';

/**
 * @param {import('events').EventEmitter} client  a MercuryClient (or any emitter)
 * @param {object} hooks
 * @param {(on:boolean)=>void} hooks.keyPtt        drive PTT (true=key, false=unkey)
 * @param {()=>boolean} hooks.acquire              try to take the radio; false = refused
 * @param {()=>void} hooks.release                 hand the radio back
 * @param {()=>void} hooks.abort                   abort the Mercury ARQ session
 * @param {()=>void} hooks.armFailsafe             (re)arm the rolling TX failsafe
 * @param {()=>void} hooks.clearFailsafe           cancel the TX failsafe
 * @param {(msg:string)=>void} hooks.log
 * @param {()=>void} [hooks.onIdle]                called after a session ends (e.g. re-LISTEN)
 * @returns {{isTxActive:()=>boolean}}
 */
function attachMercuryRadioBridge(client, hooks) {
  let txActive = false;

  client.on('ptt', (e) => {
    if (e && e.on) {
      txActive = true;
      hooks.keyPtt(true);
      hooks.armFailsafe();
    } else {
      txActive = false;
      hooks.clearFailsafe();
      hooks.keyPtt(false);
    }
  });

  client.on('buffer', (e) => {
    if (txActive && e && e.bytes > 0) hooks.armFailsafe();
  });

  client.on('connected', (e) => {
    if (!hooks.acquire()) {
      hooks.log('ARQ session collided — aborting to yield the radio');
      hooks.abort();
      return;
    }
    hooks.log(`ARQ connected: ${(e && e.source) || '?'} → ${(e && e.dest) || '?'} @ BW${(e && e.bandwidth) || '?'}`);
  });

  client.on('disconnected', () => {
    hooks.clearFailsafe();
    if (txActive) { txActive = false; hooks.keyPtt(false); }
    hooks.release();
    hooks.log('ARQ session ended');
    if (hooks.onIdle) hooks.onIdle();
  });

  return { isTxActive: () => txActive };
}

module.exports = { attachMercuryRadioBridge };
