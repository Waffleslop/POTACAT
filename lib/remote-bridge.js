// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Desktop-to-desktop, Phase B (docs/remote-desktop-parity-spec.md): the JTCAT
// pop-out drives the SHACK's FT8 engine. The engine, its audio and its
// transmitter never move to the laptop: the pop-out's IPC is mapped onto the
// ECHOCAT wire the phone and web client already use, and the shack's frames
// are mapped back onto the pop-out's channels. This file is that mapping and
// nothing else (pure, no Electron); main.js applies it in one place
// (bridgeIpc / bridgeInbound), so a feature never needs a remote twin.
//
// OUT[channel](args, state) returns one of:
//   { send: [wireMsg, ...], after? }  — send to the shack instead of running locally
//   { drop: true }                    — meaningless for a remote shack (local audio etc.)
//   { refuse: 'text' }                — say why, run nothing
// IN[wireType](msg) returns [[channel, payload], ...] for the pop-out windows.
//
// Shapes are from the channel-by-channel survey of 2026-10-21: the QSO state,
// decode, cycle, tx-status, auto-CQ, spot/chase target, WSPR, PSK, JTTY and
// tune payloads are the same objects on both sides; the differences are named
// where they are handled.
'use strict';

const s = (v, d = '') => (v == null ? d : String(v));

// Per-profile JTCAT preferences the pop-out saves with save-settings. The
// shack's state machine reads them, so a remote pop-out sends each change as
// jtcat-set-pref (the shack validates against the same table).
const JTCAT_PREFS = {
  jtcatFdMode: 'boolean',
  jtcatFdExch: 'string',
  jtcatMaxQsoAttempts: 'number',
  jtcatReworkDays: 'number',
  jtcatRelogCooldownMin: 'number',
  jtcatRunPauseAfter: 'number',
  jtcatHuntCqFallback: 'boolean',
  jtcatHuntSpotted: 'boolean',
  jtcatAnswerCallers: 'boolean',
  jtcatSkipTx1: 'boolean',
  jtcatHoundMode: 'boolean',
  wsprTxPct: 'number',
  wsprDbm: 'number',
  wsprUpload: 'boolean',
  pskAudioCenter: 'number',
  jttyAudioFreq: 'number',
  jttySerial: 'number',
  jttyMacroStyle: 'string',
};

// Pop-out IPC the shack runs through its OWN handler of the same name
// (jtcat-relay): no wire message of its own, and the handler needs nothing
// from the event.
const RELAY_CHANNELS = ['jtcat-set-tx-msg', 'jtcat-wspr-hop', 'jtcat-mode-hop'];

const drop = () => ({ drop: true });
const one = (msg) => ({ send: [msg] });

const OUT = {
  // engine
  'jtcat-start': ([mode]) => ({ send: [{ type: 'jtcat-start', mode: s(mode, 'FT8') }], after: 'spectrum' }),
  'jtcat-stop': () => one({ type: 'jtcat-stop' }),
  'jtcat-set-mode': ([mode]) => ({ send: [{ type: 'jtcat-set-mode', mode: s(mode) }], after: 'spectrum' }),
  'jtcat-start-multi': () => ({ refuse: 'Multi-band FT8 runs on the shack PC. Start it there.' }),
  // frequency: a WSPR band pick is the shack's set-band (it derives the dial)
  'jtcat-set-wspr-dial': ([band]) => one({ type: 'jtcat-set-band', band: s(band) }),
  // The wire treats every tx-freq as the operator's (it overrides Hold), so
  // an automatic follow is dropped while Hold TX is on.
  'jtcat-set-tx-freq': ([hz, operator], st) => ((!operator && st && st.holdTx) ? { drop: true }
    : one({ type: 'jtcat-set-tx-freq', hz: Math.round(Number(hz) || 1500) })),
  // FT8 never reads the RX frequency; PSK31/JTTY's is an alias of the TX one.
  'jtcat-set-rx-freq': drop,
  'jtcat-set-tx-slot': ([slot]) => one({ type: 'jtcat-set-tx-slot', slot: s(slot, 'auto') }),
  // the shack's own audio feeds its engine, its waterfall and its quiet-frequency search
  'jtcat-audio': drop,
  'jtcat-slice-audio': drop,
  'jtcat-ip-audio-ready': drop,
  'jtcat-spectrum': drop,
  'jtcat-quiet-freq': drop,
  'jtcat-tx-complete': drop,
  // TX
  'jtcat-enable-tx': ([on]) => one({ type: 'jtcat-enable-tx', enabled: !!on }),
  // The wire's halt is narrower than the pop-out's (it leaves Full Auto CQ
  // and a tune running): send those stops too when they are on.
  'jtcat-halt-tx': (_a, st) => ({ send: [{ type: 'jtcat-halt-tx' }]
    .concat(st && st.fullAuto ? [{ type: 'jtcat-full-auto-cq', on: false }] : [])
    .concat(st && st.tune ? [{ type: 'jtcat-tune-toggle' }] : []) }),
  'jtcat-tune-toggle': () => one({ type: 'jtcat-tune-toggle' }),
  'jtcat-wspr-beacon': ([o]) => {
    o = o || {};
    const m = { type: 'jtcat-wspr-beacon' };
    if (o.enabled !== undefined) m.enabled = !!o.enabled;
    if (o.txPct !== undefined) m.txPct = Number(o.txPct);
    if (o.dBm !== undefined) m.dBm = Number(o.dBm);
    return one(m);
  },
  // PSK31 / JTTY
  'jtcat-psk-send': ([text]) => one({ type: 'jtcat-psk-send', text: s(text) }),
  'jtcat-psk-set-sql': ([v]) => one({ type: 'jtcat-psk-set-sql', value: Number(v) || 50 }),
  'jtcat-jtty-send': ([o]) => {
    o = (o && typeof o === 'object') ? o : { text: o };
    const m = { type: 'jtcat-jtty-send', text: s(o.text) };
    if (o.profile) m.profile = s(o.profile);
    return one(m);
  },
  'jtcat-jtty-set-profile': ([p]) => one({ type: 'jtcat-jtty-set-profile', profile: s(p) }),
  // QSO actions: this window becomes the shack's REMOTE QSO owner
  'jtcat-popout-reply': ([p]) => {
    p = p || {};
    if (!p.call) return { drop: true };
    const m = { type: 'jtcat-reply', call: s(p.call) };
    for (const k of ['grid', 'df', 'sliceId', 'text', 'nextStep', 'snr', 'slot', 'theirGrid', 'theirReport', 'rr73', 'report']) {
      if (p[k] !== undefined && p[k] !== null) m[k] = p[k];
    }
    return one(m);
  },
  'jtcat-popout-call-cq': ([modifier]) => one({ type: 'jtcat-call-cq', modifier: s(modifier) }),
  'jtcat-popout-cancel-qso': () => one({ type: 'jtcat-cancel-qso' }),
  'jtcat-popout-skip-phase': () => one({ type: 'jtcat-skip-phase' }),
  'jtcat-popout-auto-cq-mode': ([mode]) => one({ type: 'jtcat-auto-cq-mode', mode: s(mode, 'off') }),
  'jtcat-popout-set-chase-target': ([tag]) => one({ type: 'jtcat-set-chase-target', tag: s(tag) }),
  'jtcat-popout-full-auto-cq': ([o]) => one({ type: 'jtcat-full-auto-cq', on: !!(o && o.on), modifier: s(o && o.modifier) }),
  'jtcat-spot-target-clear': () => one({ type: 'jtcat-spot-target-clear' }),
  'jtcat-spot-target-call-now': () => one({ type: 'jtcat-spot-target-call-now' }),
  'jtcat-set-hold-tx-freq': ([on]) => one({ type: 'jtcat-set-hold-tx-freq', enabled: !!on }),
  // gains: the same domains on both sides (RX linear 0..1, TX gain 0..1)
  'jtcat-set-tx-gain': ([v]) => one({ type: 'jtcat-tx-gain', value: Math.max(0, Math.min(1, Number(v) || 0)) }),
  'jtcat-set-rx-gain': ([v]) => one({ type: 'jtcat-rx-gain', value: Math.max(0, Math.min(1, Number(v) || 0)) }),
};
for (const ch of RELAY_CHANNELS) OUT[ch] = (args) => one({ type: 'jtcat-relay', channel: ch, args: Array.isArray(args) ? args : [] });

// ── JS8 (the JS8 window) ────────────────────────────────────────────────────
// JS8 runs natively on the shack (lib/js8-engine.js, the same engine slot as
// FT8). Sends map like JTCAT's; the window's INVOKES need a return value, so
// main answers them (bridgeInvokeToShack): from a cache of the shack's JS8
// frames, or by awaiting the shack's reply by reqId.
const JS8_OUT = {
  'js8-set-hback': ([on]) => one({ type: 'js8-set-hback', enabled: !!on }),
  'js8-set-aprs-gate': ([on]) => one({ type: 'js8-set-aprs-gate', enabled: !!on }),
  'js8-set-groups': ([raw]) => one({ type: 'js8-set-groups', groups: s(raw) }),
  'js8-mail-read': ([id]) => one({ type: 'js8-mail-read', id: s(id) }),
  'js8call-thread-closed': () => one({ type: 'js8-thread-closed' }),
  'js8-set-swr-autotune': ([on]) => one({ type: 'js8-set-swr-autotune', enabled: !!on }),
  'js8-set-mail-opts': ([o]) => {
    o = o || {};
    const m = { type: 'js8-set-mail-opts' };
    if (o.hold !== undefined) m.hold = !!o.hold;
    if (o.unattended !== undefined) m.unattended = !!o.unattended;
    return one(m);
  },
};
Object.assign(OUT, JS8_OUT);
// ── SSTV (the SSTV window) ──────────────────────────────────────────────────
// The shack's SSTV window hears its radio and decodes; this window composes
// and shows. A picture to send goes as sstv-photo (main turns the composed
// RGBA into a PNG data URL: {photo:true}); a received one comes back as a
// finished image (no line-by-line paint on the wire), with progress between.
const SSTV_OUT = {
  'sstv-encode': () => ({ photo: true }),
  'sstv-tx-complete': () => one({ type: 'sstv-halt-tx' }), // remotely only HALT produces it
  'sstv-stop': () => one({ type: 'sstv-stop', reason: 'user' }),
  'sstv-audio': drop, 'sstv-set-sample-rate': drop, 'sstv-wf-bins': drop,
  'sstv-compose-state': drop, 'sstv-stop-multi': drop, 'sstv-slice-audio': drop,
  'sstv-redecode': () => ({ refuse: 'Redecode replays the decoder\'s own audio, which is on the shack. Use it on the shack PC.' }),
  'sstv-start-multi': () => ({ refuse: 'Multi-slice SSTV runs on the shack PC. Start it there.' }),
  'swr-guard-override': () => ({ refuse: 'The SWR guard is the shack\'s. Reset it on the shack PC.' }),
};
Object.assign(OUT, SSTV_OUT);
const SSTV_INVOKES = ['sstv-atu-tune'];
const SSTV_LOCAL_ONLY = {
  'audio-ack': 'local VITA flow control', 'tune': 'bridged by the rig path', 'save-settings': 'this PC',
  'get-settings': 'this PC', 'sstv-get-gallery': 'this PC\'s gallery (a remote picture is saved here too)',
  'sstv-delete-image': 'this PC\'s gallery', 'sstv-load-file': 'this PC', 'sstv-gallery-set-call': 'this PC\'s gallery',
  'sstv-open-gallery-folder': 'this PC', 'sstv-keep-image': 'this PC (the picture shown here is saved to Received on this PC)', 'sstv-rig-state-get': 'mirrored rig state', 'sstv-context': 'this PC (call, grid, park)',
  'sstv-log-contact': 'this PC\'s log', 'sstv-templates-export': 'this PC', 'sstv-templates-import': 'this PC',
  'sstv-templates-sync-state': 'this PC', 'sstv-templates-sync-now': 'this PC', 'sstv-packs-list': 'this PC',
  'sstv-pack-get': 'this PC', 'sstv-pack-claim': 'this PC', 'sstv-pack-unclaim': 'this PC', 'sstv-pack-set-active': 'this PC',
  'sstv-popout-minimize': 'window', 'sstv-popout-maximize': 'window', 'sstv-popout-close': 'window',
  'rig-bands-get': 'answered here: in remote mode activeRigBands() reads the shack capabilities',
};

const JS8_INVOKES = ['js8-start', 'js8-stop', 'js8-heartbeat', 'js8-send-hb', 'js8call-send', 'js8-send-sms',
  'js8-log-prefill', 'js8call-threads', 'js8call-thread', 'js8-set-band', 'js8-set-offset'];
const JS8_LOCAL_ONLY = {
  'js8call-popout-minimize': 'window', 'js8call-popout-maximize': 'window', 'js8call-popout-close': 'window',
  'js8-map-popout': 'this PC (fed from the shack\'s heard lists)',
  'jtcat-halt-tx': 'bridged by the JTCAT table', 'jtcat-set-rx-gain': 'bridged by the JTCAT table',
  'jtcat-get-clock': 'this PC\'s clock', 'jtcat-check-clock': 'this PC\'s clock', 'jtcat-sync-clock': 'this PC\'s clock',
  'jtcat-open-time-settings': 'this PC', 'rig-control': 'bridged by the rig path', 'open-external': 'this PC',
  'rig-bands-get': 'answered here: in remote mode activeRigBands() reads the shack capabilities',
};

// Pop-out IPC that stays on this desktop by design (pure, local UI, or this
// PC's clock). Listed so the parity test can tell "decided" from "forgotten".
const LOCAL_ONLY = {
  // Worked-states / countries map tints: this PC's log and its own map switches
  // (the laptop's log is the one it fills from the shack's attributed QSOs).
  'worked-roster-get': 'this PC\'s log', 'worked-overlay-get': 'this PC\'s map switches',
  'worked-overlay-set': 'this PC\'s map switches', 'worked-overlay-geo': 'bundled map shapes',
  'worked-sync': 'this PC\'s log (LoTW / QRZ fill)',
  'jtcat-validate-tx-msg': 'pure validation, same codec here',
  'jtcat-jtty-validate': 'pure validation',
  'jtcat-get-clock': 'this PC\'s clock', 'jtcat-check-clock': 'this PC\'s clock',
  'jtcat-sync-clock': 'this PC\'s clock', 'jtcat-open-time-settings': 'this PC\'s settings',
  'jtcat-fd-window': 'local',
  'rig-bands-get': 'answered here: in remote mode activeRigBands() reads the shack capabilities',
  'jtcat-tx-slot-get': 'first paint only; the shack\'s lock follows as jtcat-tx-slot-state',
  'jtcat-log': 'this PC\'s log', 'audio-ack': 'local VITA flow control',
  'jtcat-scope-watch': 'bridged by the scope path (scope-subscribe)',
  'scope-enable-on-radio': 'bridged by the scope path',
  'rig-control': 'bridged by the rig path', 'tune': 'bridged by the rig path',
  'get-settings': 'this PC', 'save-settings': 'this PC (JTCAT_PREFS also go to the shack)',
  'qrz-lookup': 'this PC', 'open-external': 'this PC', 'log-popout-open': 'this PC',
  'qso-popout-open': 'this PC', 'jtcat-map-popout': 'this PC', 'actmap-popout-open': 'this PC',
  'jtcat-open-watchlist-settings': 'this PC', 'jtcat-popout-close': 'window',
  'jtcat-popout-minimize': 'window', 'jtcat-popout-maximize': 'window', 'jtcat-popout-focus-main': 'window',
};

const same = (ch) => (m) => [[ch, strip(m)]];
function strip(m) { const { type, ...rest } = m || {}; return rest; }

const IN = {
  'jtcat-decode': same('jtcat-decode'),
  // the shack replays its last decodes at connect
  'jtcat-decode-batch': (m) => (Array.isArray(m.entries) ? m.entries.map(e => ['jtcat-decode', e]) : []),
  'jtcat-cycle': same('jtcat-cycle'),
  // three shack paths send {running:false}; the pop-out reacts to state:'stopped'
  'jtcat-status': (m) => [['jtcat-status', m.running === false && !m.state ? { state: 'stopped' } : strip(m)]],
  'jtcat-qso-state': same('jtcat-qso-state'),
  'jtcat-tx-status': same('jtcat-tx-status'),
  'jtcat-auto-cq-state': same('jtcat-auto-cq-state'),
  // This window IS the shack's remote owner: 'remote' reads as its own run.
  'jtcat-ultracat-state': (m) => [
    ['jtcat-full-auto-cq-state', { active: !!m.fullAutoCq, owner: m.owner === 'remote' ? 'popout' : (m.owner || null), reason: m.reason || '' }],
    ['jtcat-ultracat', !!m.ultracat],
  ],
  'jtcat-spot-target': same('jtcat-spot-target'),
  'jtcat-chase-target': same('jtcat-chase-target'),
  'jtcat-wspr-spots': same('jtcat-wspr-spots'),
  'jtcat-wspr-beacon-state': same('jtcat-wspr-beacon-state'),
  'jtcat-psk-rx': same('jtcat-psk-rx'),
  'jtcat-jtty-rx': same('jtcat-jtty-rx'),
  'jtcat-jtty-refused': same('jtcat-jtty-refused'),
  'jtcat-tune-state': same('jtcat-tune-state'),
  // the shack's TX slot lock, and its refusal of a reply into the locked slot
  'jtcat-tx-slot-state': same('jtcat-tx-slot-state'),
  'jtcat-slot-refused': same('jtcat-slot-refused'),
  'jtcat-rx-gain-state': (m) => [['jtcat-set-rx-gain', Number(m.value)]],
  'jtcat-tx-gain-state': (m) => [['jtcat-set-tx-gain', Number(m.value)]],
  'jtcat-hold-tx-state': (m) => [['jtcat-flag-state', { key: 'jtcatHoldTxFreq', enabled: !!m.enabled }]],
  // one spectrum feeds whichever window is open (FT8 family or JS8)
  'jtcat-spectrum': (m) => (Array.isArray(m.bins) ? [['jtcat-remote-spectrum', m.bins], ['js8-spectrum', m.bins]] : []),
  // JS8: the JS8 window's own channels. js8-state lacks `connected`, which
  // the window reads as "the engine is up".
  'js8-state': (m) => [['js8call-status', { ...strip(m), connected: !!m.running }]],
  'js8-threads': same('js8call-threads'),
  'js8-heard': (m) => [['js8call-heard', Array.isArray(m.list) ? m.list : []]],
  'js8-activity': same('js8call-activity'),
  // SSTV (sstv-rx-image is converted and saved in main: remoteSstvInbound)
  'sstv-rx-progress': (m) => [['sstv-rx-line', { line: Number(m.line) || 0, totalLines: Number(m.totalLines) || 0, rgba: [] }]],
  'sstv-rx-fskid': same('sstv-rx-fskid'),
  // The shack plays the audio; this window shows a progress bar for it.
  'sstv-tx-status': (m) => (m.state === 'tx'
    ? [['sstv-tx-audio', { samples: [], durationSec: Number(m.durationSec) || 0, daxTx: true, directTxLabel: 'the shack' }]]
    : [['sstv-tx-status', { state: 'rx', error: m.error || undefined }]]),
  'sstv-decoder-state': (m) => [['sstv-status', { state: m.running ? 'running' : 'stopped' }]],
  'sstv-wf-bins': (m) => (Array.isArray(m.bins) ? [['sstv-remote-wf-bins', m.bins]] : []),
  'jtcat-mode-hopped': same('jtcat-mode-hopped'),
  // A hand-over between this window and the shack's own JTCAT window.
  'jtcat-owner': (m) => (m.owner === 'shack'
    ? [['jtcat-qso-state', { phase: 'error', error: String(m.message || 'The shack took over FT8.') }], ['jtcat-status', { state: 'stopped' }]]
    : [['jtcat-qso-notice', { message: String(m.message || 'You took over FT8 from the shack.') }]]),
};

/** What the bridge tracks from the shack's frames to make OUT decisions. */
function trackState(st, m) {
  if (!m || !m.type) return st;
  if (m.type === 'jtcat-hold-tx-state') st.holdTx = !!m.enabled;
  else if (m.type === 'jtcat-ultracat-state') st.fullAuto = !!m.fullAutoCq;
  else if (m.type === 'jtcat-tune-state') st.tune = !!m.active;
  else if (m.type === 'jtcat-status') st.running = m.state === 'running' || m.running === true;
  return st;
}

/** The per-profile prefs in a save-settings patch, as jtcat-set-pref messages. */
function prefMessages(patch) {
  const out = [];
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, type] of Object.entries(JTCAT_PREFS)) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (typeof v !== type) continue;
    out.push({ type: 'jtcat-set-pref', key, value: v });
  }
  return out;
}

/** The shack's check of an incoming jtcat-set-pref: the value to store, or undefined. */
function acceptPref(key, value) {
  const type = JTCAT_PREFS[key];
  if (!type || typeof value !== type) return undefined;
  if (type === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return Math.max(-1000000, Math.min(1000000, value));
  }
  if (type === 'string') return value.slice(0, 64);
  return value;
}

module.exports = { OUT, IN, LOCAL_ONLY, RELAY_CHANNELS, JTCAT_PREFS, JS8_OUT, JS8_INVOKES, JS8_LOCAL_ONLY, SSTV_OUT, SSTV_INVOKES, SSTV_LOCAL_ONLY, trackState, prefMessages, acceptPref };
