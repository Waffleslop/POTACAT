'use strict';

// What a Guest Pass may ask the shack to do — the ONE allowlist for the
// ECHOCAT demux (lib/remote-server.js) and the rig-control dispatcher
// (main.js applyRigControl). Default DENY (private adversarial review of
// 1.13.9, 2026-11-03; potacat-meta work/in-progress/guest-pass-authority-fixes.md).
//
// Until this file existed every refusal was a per-case `if (ws._passSession)`
// inside a 300-case switch, so every message type nobody had thought about
// was a guest's: raw CAT, the owner's logbook (read, edit, delete), the
// owner's cloud account. The pass concept (potacat-meta
// guest-pass-and-tunnel-concept.md) is: a guest OPERATES the station —
// tune, key, log their own contacts, run the digital modes, shape the audio —
// under the pass's callsign, privilege class and power cap. They do not own
// the station, its settings, its data or its accounts.
//
// Both sets are built from what the two guest clients send today (the phone's
// echocatProtocol.ts C2S list and renderer/remote.js) crossed with the
// demux's case labels. test/guest-pass-authority-test.js holds every demux
// case to be in exactly ONE set, so a new message type is a decision, never
// an accident. The per-case checks that already exist inside the allowed
// cases (a guest with no verified call may not key JS8, a guest never sees
// the owner's recordings, ...) stay as they are — this is the outer wall.

// ── WebSocket message types ────────────────────────────────────────────
const GUEST_TYPES = new Set([
  // the link itself (pass-leave, pass-take-over and owner-presence are
  // answered BEFORE the wall, in the hopping block of _handleMessage).
  // clock-probe is a timing echo the phone sends on its own every few
  // minutes; it changes nothing (clock-apply is the one that does).
  'ping', 'signal', 'restart-audio', 'get-audio-devices', 'clock-probe',
  // the radio: tune, key, mode, filters, levels, the VFO
  'tune', 'ptt', 'estop', 'set-mode', 'set-filter', 'filter-step', 'set-nb',
  'set-vfo', 'swap-vfo', 'vfo-set-lock', 'set-rfgain', 'set-txpower',
  'set-tx-drive', 'set-rx-level', 'set-tune-step', 'set-cw-xit',
  'set-cw-filter', 'set-ssb-filter', 'set-digital-filter',
  'scan-control', 'scan-state', 'scan-step',
  'rig-control',                 // with the action allowlist below
  // spots: a guest filters and hides on their own device
  'set-sources', 'set-echo-filters', 'hide-spot', 'unhide-spot', 'skip-spot',
  'search-parks', 'nearby-parks',
  // logging: the guest's own outbox, lookups, the typed call
  'log-qso', 'typed-call', 'lookup-call', 'qrz-lookup',
  // JTCAT (FT8/FT4/FT2, WSPR, PSK31, JTTY). The pass gates every key-down
  // (tx_enable); jtcat-set-pref is the owner's operating policy — denied.
  'jtcat-start', 'jtcat-stop', 'jtcat-call-cq', 'jtcat-set-chase-target',
  'jtcat-reply', 'jtcat-enable-tx', 'jtcat-halt-tx', 'jtcat-wspr-beacon',
  'jtcat-full-auto-cq', 'jtcat-spot-target-set', 'jtcat-spot-target-clear',
  'jtcat-spot-target-call-now', 'jtcat-auto-cq-mode', 'jtcat-set-skip-tx1',
  'jtcat-set-hound-mode', 'jtcat-set-mode', 'jtcat-psk-set-sql',
  'jtcat-psk-send', 'jtcat-jtty-send', 'jtcat-jtty-set-profile',
  'jtcat-set-tx-freq', 'jtcat-set-tx-slot', 'jtcat-spectrum-subscribe',
  'jtcat-rx-gain', 'jtcat-tx-gain', 'jtcat-cancel-qso', 'jtcat-skip-phase',
  'jtcat-follow-radio', 'jtcat-log-qso', 'jtcat-set-band', 'jtcat-waterfall',
  'jtcat-tune-toggle', 'jtcat-set-auto-seq', 'jtcat-start-multi-remote',
  'jtcat-relay', 'jtcat-set-hold-tx-freq',
  // JS8: every case already distinguishes a guest with a verified call
  // (may operate) from one without (receive-only) and answers a refusal
  // the phone displays (js8-send-result). Kept inside, not duplicated here.
  'js8-start', 'js8-stop', 'js8-heartbeat', 'js8-send', 'js8-send-hb',
  'js8-set-hback', 'js8-set-aprs-gate', 'js8-send-sms', 'js8-mail-read',
  'js8-set-groups', 'js8-thread-open', 'js8-thread-closed', 'js8-set-band',
  'js8-log-prefill', 'js8-set-offset', 'js8-set-mail-opts',
  'js8-set-swr-autotune',
  // SSTV: a picture from the guest's device (sstv_tx gate), the gallery
  'sstv-open', 'sstv-photo', 'sstv-stop', 'sstv-pack-claims', 'sstv-halt-tx',
  'sstv-set-auto-enabled', 'sstv-get-gallery-image', 'sstv-get-gallery',
  'sstv-get-compose',
  // FreeDV (freedv-set-tx keys through gatedSetTransmit = the pass gate)
  'freedv-start', 'freedv-stop', 'freedv-set-mode', 'freedv-set-tx',
  'freedv-set-squelch',
  // the band scope (each emit carries guest:true)
  'scope-subscribe', 'scope-span', 'scope-anchor', 'scope-enable-radio', 'scope-digital-view',
  // CW: text and the paddle ask passTxAllowed('CW') in main
  'paddle', 'cw-key', 'cw-diag', 'cw-config', 'cw-stop', 'cw-text', 'cw-enable',
  // voice: play (the case refuses the owner's recordings), stop
  'voice-macro-get', 'voice-macro-play', 'voice-macro-play-audio',
  'voice-macro-stop',
  // TX EQ for the guest's own voice (undone when the lease ends)
  'tx-eq-get', 'tx-eq-set',
]);

// Refused to a guest INSIDE the case, with the TYPED reply that case already
// answers and the phone already displays (award-table-refused,
// winlink-refused, rig-presets-refused, worked-overlay-refused,
// swr-guard-refused, watchlist-result / cluster-node-result /
// idle-mode-result {ok:false}, diagnostic-snapshot {error:'not-authorized'},
// cloud-stripe-result {error:'guest_pass'}, the guest's own settings echoed
// back, main's clock-apply refusal). These pass the wall so that reply keeps
// its shape; test/guest-pass-authority-test.js holds each case to still
// carry its guest check, so a dropped check is a failing test, not an open
// door. A type refused inside with NO reply (a bare break or a log line)
// is NOT here — it goes to the wall and gets `refused`.
const GUEST_REFUSED_INSIDE = new Set([
  'request-diagnostic', 'award-table-get', 'apply-rig-preset',
  'rig-presets-update', 'worked-overlay-set', 'cloud-stripe-checkout',
  'cloud-stripe-portal', 'tx-eq-save-rig-default', 'swr-guard-override',
  'watchlist-edit', 'set-cluster-node', 'set-idle-rx', 'save-settings',
  'clock-apply',
  'winlink-list', 'winlink-read', 'winlink-attachment-get', 'winlink-delete',
  'winlink-compose', 'winlink-connect', 'winlink-abort', 'winlink-qsy',
  'winlink-qsy-restore', 'winlink-account-check', 'winlink-set-password',
  'winlink-register', 'winlink-recovery-email-get',
  'winlink-recovery-email-set', 'winlink-prompt', 'winlink-gateways-get',
  'winlink-posreport', 'winlink-accept-notice', 'winlink-set-mode',
  'winlink-watch',
]);

// Denied at the wall: the owner's station, the owner's data, the owner's
// accounts — every type the switch used to let a guest through, or dropped
// in silence. Listed so the parity test can hold every demux case to a
// decision; isGuestAllowed never consults this set.
const GUEST_DENIED_TYPES = new Set([
  // the owner's logbook and activation
  'get-all-qsos', 'update-qso', 'delete-qso',
  'get-activation-map-data', 'get-past-activations', 'set-activator-park',
  'set-park-county',
  // the owner's cloud account (login/register also refuse inside the case)
  'cloud-login', 'cloud-register', 'cloud-logout', 'cloud-get-status',
  'cloud-sync-now', 'cloud-bulk-upload', 'cloud-verify-subscription',
  'cloud-save-bmac-email',
  // the owner's settings
  'save-custom-cat-buttons', 'save-cw-macros', 'save-echo-pref',
  'set-refresh-interval', 'set-max-age', 'set-dist-unit', 'set-scan-dwell',
  'set-spot-mute-rules', 'set-event-subscription', 'set-event-progress',
  'refresh-events', 'set-tune-click', 'set-enable-split', 'set-enable-atu',
  'set-freedv', 'jtcat-set-pref', 'jtcat-hunt-filters',
  // the owner's station: which rig, its power, antenna, tuner, audio devices
  'switch-rig', 'rig-reconnect', 'set-audio-device', 'set-atu', 'atu-tune',
  'toggle-rotor', 'tgxl-select-antenna', 'vfo-profiles-update',
  'apply-vfo-profile', 'unpair-self',
  // the owner's listen source
  'kiwi-connect', 'kiwi-disconnect', 'kiwi-tune',
  // the owner's recordings
  'voice-macro-sync', 'voice-macro-delete',
]);

// ── rig-control actions ────────────────────────────────────────────────
// What a guest may do through the one rig dispatcher: receiver and audio
// shaping, the levels the pass already bounds (set-tx-power is clamped by
// gatedSetTxPower), the VFO. Never raw CAT (the whole pass can be bypassed
// in one string), never split or the other VFO (the pass authorises the TX
// frequency it can see), never power-on/off, the tuner or the antenna port.
const GUEST_RIG_ACTIONS = new Set([
  'get-state', 'set-tx-power', 'set-vfo', 'swap-vfo', 'set-filter-width',
  'set-preamp', 'set-att', 'set-nb', 'set-nb-level', 'set-nr', 'set-nr-level',
  'set-anf', 'set-apf', 'set-nrl', 'set-nrl-level', 'set-nrs', 'set-nrs-level',
  'set-rnn', 'set-nrf', 'set-nrf-level', 'set-wnb', 'set-wnb-level',
  'set-agc', 'set-rf-gain', 'set-rf-gain-db', 'set-af-gain', 'set-squelch',
  'set-comp', 'set-comp-level', 'set-vox', 'set-vox-level', 'set-mon',
  'set-mon-level', 'set-rit', 'set-clar-rx', 'set-clar-tx', 'set-clar-offset',
  'set-mic-gain', 'set-dnr-level', 'set-break-in', 'set-break-in-delay',
  'set-cw-sidetone',
]);

const GUEST_DENIED_RIG_ACTIONS = new Set([
  'send-custom-cat', 'custom-cat-read', 'set-split', 'set-freq-other', 'power-on', 'power-off',
  'atu-tune', 'set-antenna-port', 'set-preamp-target',
]);

/** May this message type pass the wall for a Guest Pass? (A type in
 *  GUEST_REFUSED_INSIDE passes and is then refused by its own case, with
 *  the typed reply the phone displays.) */
function isGuestAllowed(type) {
  return typeof type === 'string' && (GUEST_TYPES.has(type) || GUEST_REFUSED_INSIDE.has(type));
}

function isGuestRigAction(action) {
  return typeof action === 'string' && GUEST_RIG_ACTIONS.has(action);
}

/** What the guest's device is told. One wording for every refusal. */
function guestRefusedText(what) {
  return `Not available on a Guest Pass: ${what}. Ask the host.`;
}

module.exports = {
  GUEST_TYPES,
  GUEST_REFUSED_INSIDE,
  GUEST_DENIED_TYPES,
  GUEST_RIG_ACTIONS,
  GUEST_DENIED_RIG_ACTIONS,
  isGuestAllowed,
  isGuestRigAction,
  guestRefusedText,
};
