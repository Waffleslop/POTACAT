// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Desktop-to-desktop: the shack's radio, as this desktop sees it.
//
// A laptop driving a remote shack has no rig of its own. Everything the rig
// panel, the VFO window and the pop-outs draw came from the LOCAL rig state
// (`_current*` in main.js) and the LOCAL model caps, so on a paired laptop
// every control was dark even though the shack sends its whole state in every
// `status` snapshot (Ride1226 2026-10-21: "the cat controls for my radio back
// home aren't lighting up"). This module keeps the shack's snapshot and merges
// the discrete frames that arrive between snapshots. main.js mirrors it into
// its `_current*` rig state (applyRemoteRigSnapshot) so every reader of that
// state (rig panel, VFO window, JTCAT power, SSTV) shows the shack's radio,
// and getRigCapabilities() returns the shack's caps. STATUS_TO_RIG_STATE is
// the contract test/remote-rig-test.js holds main.js to. Pure: no Electron.
//
// The snapshot is merged, never replaced: the shack omits `freq` while a
// phone-style tune is settling ("no change", see remote-server
// broadcastRadioStatus), and a missing field must hold the last value.
//
// Spec: docs/remote-desktop-parity-spec.md, Phase A2.
'use strict';

// Shack `status` snapshot field → renderer `rig-state` field. Names differ in
// four places (the snapshot predates the renderer's names); the rest match.
const STATUS_TO_RIG_STATE = {
  nb: 'nb',
  rfgain: 'rfGain',
  squelch: 'squelch',
  txpower: 'txPower',
  filterWidth: 'filterWidth',
  atu: 'atuActive',
  mode: 'mode',
  preamp: 'preamp',
  att: 'att',
  preampStep: 'preampStep',
  attStep: 'attStep',
  comp: 'comp',
  nr: 'nr',
  anf: 'anf',
  apf: 'apf',
  nrl: 'nrl',
  nrs: 'nrs',
  rnn: 'rnn',
  nrf: 'nrf',
  nrlLevel: 'nrlLevel',
  nrsLevel: 'nrsLevel',
  nrfLevel: 'nrfLevel',
  wnb: 'wnb',
  wnbLevel: 'wnbLevel',
  rfgainDb: 'rfgainDb',
  vox: 'vox',
  agc: 'agc',
  sliceDax: 'sliceDax',
  daxRouteOk: 'daxRouteOk',
  nrLevel: 'nrLevel',
  nbLevel: 'nbLevel',
  voxLevel: 'voxLevel',
  mon: 'mon',
  monLevel: 'monLevel',
  rit: 'rit',
  breakIn: 'breakIn',
  vfo: 'vfo',
  split: 'split',
};

// Discrete S2C frames the shack sends between snapshots ({type, value}) →
// the snapshot field they update.
const FRAME_TO_STATUS = {
  smeter: 'smeter',
  swr: 'swr',
  'swr-ratio': 'swrRatio',
  alc: 'alc',
  power: 'txpower',
  'fwd-power': 'fwdPower',
};

class RemoteRigState {
  constructor() { this.reset(); }

  reset() {
    this._snap = {};
    this._seen = false;
  }

  /** True once a snapshot has arrived from the shack this session. */
  get seen() { return this._seen; }

  /** Merge a `status` snapshot. Returns the fields that changed. */
  applyStatus(snap) {
    if (!snap || typeof snap !== 'object') return [];
    const changed = [];
    for (const [k, v] of Object.entries(snap)) {
      if (k === 'type' || v === undefined) continue;
      if (!sameValue(this._snap[k], v)) changed.push(k);
      this._snap[k] = v;
    }
    this._seen = true;
    return changed;
  }

  /** Merge a discrete frame. Returns the snapshot field it set, or null. */
  applyFrame(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const field = FRAME_TO_STATUS[msg.type];
    if (!field) return null;
    const v = Number(msg.value);
    if (!Number.isFinite(v)) return null;
    this._snap[field] = v;
    return field;
  }

  get(field) { return this._snap[field]; }

  /** The shack's capabilities ({} until a snapshot carried them). */
  capabilities() {
    const c = this._snap.capabilities;
    return c && typeof c === 'object' ? { ...c } : {};
  }

  /** Whether the shack's radio link is up (its own CAT/SmartSDR). */
  catConnected() { return !!this._snap.catConnected; }

  /** Whether the shack reports it is transmitting. */
  transmitting() { return !!this._snap.txState; }

}

function sameValue(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

module.exports = { RemoteRigState, STATUS_TO_RIG_STATE, FRAME_TO_STATUS };
