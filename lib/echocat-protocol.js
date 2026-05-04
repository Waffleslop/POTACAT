'use strict';
//
// ECHOCAT WebSocket Protocol — schemas of record.
//
// This module is the single source of truth for the message types that
// flow between POTACAT desktop (server) and an ECHOCAT client (browser
// today, native mobile app coming).
//
// Constraints:
//  - Pure JavaScript. No DOM. No Node-only built-ins. Must work in
//    React Native, in the desktop main process, and in a Node CLI.
//  - Tiny: no schema-validation dep. We hand-roll a small validator
//    so the bundle stays small and the wire format stays explicit.
//  - Backward compatible with the existing browser ECHOCAT, which
//    pre-dates this module and does not send a `hello`.
//
// See docs/echocat-protocol.md for the human-readable catalog.
//

/** Current protocol major version. Bump when the wire format breaks. */
const PROTOCOL_VERSION = 1;

/**
 * WebSocket close codes. Application range is 4000-4999.
 *  - 4001 unsupported version: peer is too far ahead/behind to talk.
 *  - 4002 bad handshake: malformed `hello`.
 *  - 4003 auth failed terminally: stop reconnecting (client decides).
 */
const CLOSE_CODES = Object.freeze({
  PROTOCOL_VERSION_UNSUPPORTED: 4001,
  HANDSHAKE_INVALID: 4002,
  AUTH_FAILED_TERMINAL: 4003,
});

/**
 * Direction enum.
 *  - s2c: server → client only
 *  - c2s: client → server only
 *  - both: either direction
 */
const Dir = Object.freeze({ S2C: 's2c', C2S: 'c2s', BOTH: 'both' });

/**
 * Field-shape primitives the validator understands. Keep this small —
 * we want explicit shapes, not a general-purpose JSON schema.
 *  - 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
 *  - 'any' for fields whose shape is too dynamic to be worth pinning
 *  - { oneOf: [...] } for enum-of-strings
 *
 * `required: true` is the default. Set to `false` for optional fields.
 */

// Field shorthand used below to keep the registry readable.
const f = {
  string: { type: 'string' },
  optString: { type: 'string', required: false },
  number: { type: 'number' },
  optNumber: { type: 'number', required: false },
  integer: { type: 'integer' },
  optInteger: { type: 'integer', required: false },
  boolean: { type: 'boolean' },
  optBoolean: { type: 'boolean', required: false },
  array: { type: 'array' },
  optArray: { type: 'array', required: false },
  object: { type: 'object' },
  optObject: { type: 'object', required: false },
  any: { type: 'any', required: false },
  oneOf: (values) => ({ type: 'oneOf', values, required: true }),
  optOneOf: (values) => ({ type: 'oneOf', values, required: false }),
};

/**
 * Message registry.
 *
 * Keyed by `type` field. Each entry declares:
 *   - dir: which direction(s) it flows
 *   - fields: declared field shapes (extra fields allowed but undocumented)
 *   - feature: tag used by the catalog doc
 *
 * NOT every existing message has a fully-typed schema — many older
 * messages use `_` (any-bag) so the v1 cutover is non-breaking. Tighten
 * fields incrementally as features are touched.
 */
const MESSAGES = Object.freeze({
  // ─── Handshake / connection ─────────────────────────────────────────
  hello: {
    dir: Dir.BOTH,
    feature: 'handshake',
    fields: {
      protocolVersion: f.integer,
      // Server-side fields
      serverVersion: f.optString,
      capabilities: f.optArray,
      // Client-side fields
      clientVersion: f.optString,
      clientPlatform: f.optString,
    },
  },
  'auth-mode': { dir: Dir.S2C, feature: 'handshake', fields: { mode: f.string } },
  auth: { dir: Dir.C2S, feature: 'handshake', fields: { token: f.optString, callsign: f.optString, password: f.optString } },
  'auth-ok': { dir: Dir.S2C, feature: 'handshake', fields: { settings: f.optObject } },
  'auth-fail': { dir: Dir.S2C, feature: 'handshake', fields: { reason: f.string } },
  kicked: { dir: Dir.S2C, feature: 'handshake', fields: { reason: f.string } },
  ping: { dir: Dir.C2S, feature: 'handshake', fields: { ts: f.optNumber } },
  pong: { dir: Dir.S2C, feature: 'handshake', fields: { ts: f.optNumber } },

  // ─── Spots / sources ────────────────────────────────────────────────
  spots: { dir: Dir.S2C, feature: 'spots', fields: { data: f.array } },
  sources: { dir: Dir.S2C, feature: 'spots', fields: { data: f.object } },
  'set-sources': { dir: Dir.C2S, feature: 'spots', fields: { sources: f.object } },
  'echo-filters': { dir: Dir.S2C, feature: 'spots', fields: { data: f.object } },
  'set-echo-filters': { dir: Dir.C2S, feature: 'spots', fields: { filters: f.object } },
  'worked-parks': { dir: Dir.S2C, feature: 'spots', fields: { refs: f.array } },
  'worked-qsos': { dir: Dir.S2C, feature: 'spots', fields: { entries: f.array } },

  // ─── Rig control / VFO ──────────────────────────────────────────────
  status: { dir: Dir.S2C, feature: 'rig' },
  // tune: phone sends `freqKhz` as a STRING (server parses it as a float
  // kHz value). Earlier the schema lied and declared `frequency: number` —
  // fixed when the mobile-app dev hit it. Optional `bearing` rotates an
  // antenna rotor for the spot's bearing. (Gap 5, 2026-05-03.)
  tune: { dir: Dir.C2S, feature: 'rig', fields: { freqKhz: f.string, mode: f.optString, bearing: f.optNumber } },
  'tune-blocked': { dir: Dir.S2C, feature: 'rig', fields: { reason: f.string } },
  'set-mode': { dir: Dir.C2S, feature: 'rig', fields: { mode: f.string } },
  'set-vfo': { dir: Dir.C2S, feature: 'rig', fields: { vfo: f.string } },
  'swap-vfo': { dir: Dir.C2S, feature: 'rig' },
  'set-filter': { dir: Dir.C2S, feature: 'rig', fields: { width: f.number } },
  'filter-step': { dir: Dir.C2S, feature: 'rig', fields: { dir: f.string } },
  'set-rfgain': { dir: Dir.C2S, feature: 'rig', fields: { value: f.number } },
  'set-txpower': { dir: Dir.C2S, feature: 'rig', fields: { value: f.number } },
  'set-nb': { dir: Dir.C2S, feature: 'rig', fields: { on: f.boolean } },
  'set-atu': { dir: Dir.C2S, feature: 'rig', fields: { on: f.boolean } },
  'set-enable-atu': { dir: Dir.C2S, feature: 'rig', fields: { on: f.boolean } },
  'set-enable-split': { dir: Dir.C2S, feature: 'rig', fields: { on: f.boolean } },
  'set-cw-xit': { dir: Dir.C2S, feature: 'rig', fields: { hz: f.number } },
  'set-cw-filter': { dir: Dir.C2S, feature: 'rig', fields: { width: f.number } },
  'set-ssb-filter': { dir: Dir.C2S, feature: 'rig', fields: { width: f.number } },
  'set-digital-filter': { dir: Dir.C2S, feature: 'rig', fields: { width: f.number } },
  'set-tune-click': { dir: Dir.C2S, feature: 'rig', fields: { mode: f.string } },
  'set-scan-dwell': { dir: Dir.C2S, feature: 'rig', fields: { seconds: f.number } },
  'set-max-age': { dir: Dir.C2S, feature: 'rig', fields: { minutes: f.number } },
  'set-dist-unit': { dir: Dir.C2S, feature: 'rig', fields: { unit: f.string } },
  'set-refresh-interval': { dir: Dir.C2S, feature: 'rig', fields: { seconds: f.number } },
  'scan-step': { dir: Dir.C2S, feature: 'rig', fields: { action: f.string } },
  'rig-control': { dir: Dir.C2S, feature: 'rig' },
  'rig-blocked': { dir: Dir.S2C, feature: 'rig', fields: { reason: f.string } },
  rigs: { dir: Dir.S2C, feature: 'rig', fields: { data: f.array, activeRigId: f.optString } },
  'switch-rig': { dir: Dir.C2S, feature: 'rig', fields: { rigId: f.string } },
  'tgxl-select-antenna': { dir: Dir.C2S, feature: 'rig', fields: { antenna: f.optString } },
  'toggle-rotor': { dir: Dir.C2S, feature: 'rig' },
  'vfo-set-lock': { dir: Dir.C2S, feature: 'rig', fields: { locked: f.boolean } },
  'vfo-lock-state': { dir: Dir.S2C, feature: 'rig', fields: { locked: f.boolean } },
  'vfo-profiles': { dir: Dir.BOTH, feature: 'rig', fields: { profiles: f.optArray } },
  'vfo-profiles-update': { dir: Dir.C2S, feature: 'rig', fields: { profiles: f.array } },
  'apply-vfo-profile': { dir: Dir.C2S, feature: 'rig', fields: { id: f.string } },
  'settings-update': { dir: Dir.S2C, feature: 'rig', fields: { settings: f.object } },
  'save-settings': { dir: Dir.C2S, feature: 'rig', fields: { settings: f.object } },

  // ─── PTT / WebRTC signaling ─────────────────────────────────────────
  ptt: { dir: Dir.C2S, feature: 'ptt', fields: { state: f.boolean } },
  estop: { dir: Dir.C2S, feature: 'ptt' },
  'ptt-timeout': { dir: Dir.S2C, feature: 'ptt' },
  'ptt-force-rx': { dir: Dir.S2C, feature: 'ptt' },
  'start-audio': { dir: Dir.C2S, feature: 'ptt' },
  signal: { dir: Dir.BOTH, feature: 'ptt', fields: { data: f.any } },
  // Legacy WebRTC envelopes — pre-`signal` clients still send these.
  // Server keeps accepting them; new clients should not.
  sdp: { dir: Dir.C2S, feature: 'ptt-legacy', fields: { sdp: f.any, sessionDescription: f.any } },
  ice: { dir: Dir.C2S, feature: 'ptt-legacy', fields: { candidate: f.any } },
  'get-audio-devices': { dir: Dir.C2S, feature: 'ptt' },
  'set-audio-device': { dir: Dir.C2S, feature: 'ptt', fields: { kind: f.string, deviceId: f.string } },

  // ─── Activator mode ─────────────────────────────────────────────────
  'activator-state': { dir: Dir.S2C, feature: 'activator' },
  'set-activator-park': { dir: Dir.C2S, feature: 'activator', fields: { parkRefs: f.optArray, activationName: f.optString, sig: f.optString, activationType: f.optString } },
  'session-contacts': { dir: Dir.S2C, feature: 'activator', fields: { contacts: f.array } },

  // ─── Logging ────────────────────────────────────────────────────────
  'log-qso': { dir: Dir.C2S, feature: 'logging' },
  'log-ok': { dir: Dir.S2C, feature: 'logging' },
  'get-all-qsos': { dir: Dir.C2S, feature: 'logging' },
  'all-qsos': { dir: Dir.S2C, feature: 'logging', fields: { data: f.array } },
  'update-qso': { dir: Dir.C2S, feature: 'logging', fields: { idx: f.integer, fields: f.object } },
  'qso-updated': { dir: Dir.S2C, feature: 'logging' },
  'delete-qso': { dir: Dir.C2S, feature: 'logging', fields: { idx: f.integer } },
  'qso-deleted': { dir: Dir.S2C, feature: 'logging' },
  'lookup-call': { dir: Dir.C2S, feature: 'logging', fields: { call: f.string } },
  'qrz-lookup': { dir: Dir.C2S, feature: 'logging', fields: { call: f.string } },
  'call-lookup': { dir: Dir.S2C, feature: 'logging' },
  'search-parks': { dir: Dir.C2S, feature: 'logging', fields: { query: f.string } },
  'park-results': { dir: Dir.S2C, feature: 'logging', fields: { results: f.array } },
  'get-past-activations': { dir: Dir.C2S, feature: 'logging', fields: { ref: f.string } },
  'past-activations': { dir: Dir.S2C, feature: 'logging', fields: { data: f.array } },
  'get-activation-map-data': { dir: Dir.C2S, feature: 'logging' },
  'activation-map-data': { dir: Dir.S2C, feature: 'logging' },

  // ─── Directory / donors ─────────────────────────────────────────────
  directory: { dir: Dir.S2C, feature: 'directory', fields: { nets: f.optArray, swl: f.optArray } },
  'donor-callsigns': { dir: Dir.S2C, feature: 'directory', fields: { callsigns: f.array } },

  // ─── JTCAT (FT8 / FT4 / FT2) ────────────────────────────────────────
  'jtcat-start': { dir: Dir.C2S, feature: 'jtcat', fields: { mode: f.optString } },
  'jtcat-stop': { dir: Dir.C2S, feature: 'jtcat' },
  'jtcat-status': { dir: Dir.S2C, feature: 'jtcat' },
  'jtcat-set-mode': { dir: Dir.C2S, feature: 'jtcat', fields: { mode: f.string } },
  'jtcat-set-band': { dir: Dir.C2S, feature: 'jtcat', fields: { band: f.string } },
  'jtcat-set-tx-freq': { dir: Dir.C2S, feature: 'jtcat', fields: { hz: f.number } },
  'jtcat-set-tx-slot': { dir: Dir.C2S, feature: 'jtcat', fields: { slot: f.string } },
  'jtcat-rx-gain': { dir: Dir.C2S, feature: 'jtcat', fields: { level: f.number } },
  'jtcat-tx-gain': { dir: Dir.C2S, feature: 'jtcat', fields: { level: f.number } },
  'jtcat-enable-tx': { dir: Dir.C2S, feature: 'jtcat', fields: { enabled: f.boolean } },
  'jtcat-halt-tx': { dir: Dir.C2S, feature: 'jtcat' },
  'jtcat-call-cq': { dir: Dir.C2S, feature: 'jtcat', fields: { modifier: f.optString } },
  'jtcat-reply': { dir: Dir.C2S, feature: 'jtcat' },
  'jtcat-cancel-qso': { dir: Dir.C2S, feature: 'jtcat' },
  'jtcat-skip-phase': { dir: Dir.C2S, feature: 'jtcat' },
  'jtcat-log-qso': { dir: Dir.C2S, feature: 'jtcat' },
  'jtcat-auto-cq-mode': { dir: Dir.C2S, feature: 'jtcat', fields: { mode: f.string } },
  'jtcat-auto-cq-state': { dir: Dir.S2C, feature: 'jtcat' },
  'jtcat-decode': { dir: Dir.S2C, feature: 'jtcat' },
  'jtcat-decode-batch': { dir: Dir.S2C, feature: 'jtcat', fields: { entries: f.array } },
  'jtcat-cycle': { dir: Dir.S2C, feature: 'jtcat' },
  'jtcat-tx-status': { dir: Dir.S2C, feature: 'jtcat' },
  'jtcat-qso-state': { dir: Dir.S2C, feature: 'jtcat' },
  'jtcat-spectrum': { dir: Dir.S2C, feature: 'jtcat', fields: { bins: f.array } },
  'jtcat-waterfall': { dir: Dir.C2S, feature: 'jtcat', fields: { enabled: f.boolean } },
  'jtcat-start-multi-remote': { dir: Dir.C2S, feature: 'jtcat' },
  // WSJT-X-style steady-tone Tune. Phone tap toggles; desktop emits state
  // back so the phone UI can light up the button + show the countdown.
  // (Gap 11, mobile dev report 2026-05-04.)
  'jtcat-tune-toggle': { dir: Dir.C2S, feature: 'jtcat' },
  'jtcat-tune-state': { dir: Dir.S2C, feature: 'jtcat', fields: { active: f.boolean, secondsRemaining: f.optInteger } },
  // Auto Seq: when true, the QSO state machine auto-advances on each
  // matching decode. When false, engine still records what it heard but
  // doesn't compose the next TX — user drives via Skip. (Gap 12.)
  'jtcat-set-auto-seq': { dir: Dir.C2S, feature: 'jtcat', fields: { enabled: f.boolean } },
  'jtcat-auto-seq-state': { dir: Dir.S2C, feature: 'jtcat', fields: { enabled: f.boolean } },

  // ─── FreeDV ─────────────────────────────────────────────────────────
  'freedv-start': { dir: Dir.C2S, feature: 'freedv', fields: { mode: f.optString } },
  'freedv-stop': { dir: Dir.C2S, feature: 'freedv' },
  'freedv-set-mode': { dir: Dir.C2S, feature: 'freedv', fields: { mode: f.string } },
  'freedv-set-tx': { dir: Dir.C2S, feature: 'freedv', fields: { on: f.boolean } },
  'freedv-set-squelch': { dir: Dir.C2S, feature: 'freedv', fields: { level: f.number } },
  'set-freedv': { dir: Dir.C2S, feature: 'freedv', fields: { enabled: f.boolean } },
  // freedv-enabled: server tells client whether the FreeDV master toggle is
  // on. Pushed at startup and whenever settings.enableFreedv changes. (Gap 1.)
  'freedv-enabled': { dir: Dir.S2C, feature: 'freedv', fields: { enabled: f.boolean } },

  // ─── CW ─────────────────────────────────────────────────────────────
  'cw-available': { dir: Dir.S2C, feature: 'cw', fields: { enabled: f.boolean } },
  'cw-paddle-available': { dir: Dir.S2C, feature: 'cw' },
  'cw-config': { dir: Dir.C2S, feature: 'cw', fields: { wpm: f.optNumber, mode: f.optString } },
  'cw-config-ack': { dir: Dir.S2C, feature: 'cw', fields: { wpm: f.number, mode: f.string } },
  'cw-state': { dir: Dir.S2C, feature: 'cw', fields: { keying: f.boolean } },
  'cw-text': { dir: Dir.C2S, feature: 'cw', fields: { text: f.string } },
  'cw-stop': { dir: Dir.C2S, feature: 'cw' },
  'cw-enable': { dir: Dir.C2S, feature: 'cw', fields: { enabled: f.boolean } },
  paddle: { dir: Dir.C2S, feature: 'cw', fields: { event: f.string } },
  'save-cw-macros': { dir: Dir.C2S, feature: 'cw', fields: { macros: f.array } },

  // ─── SSTV ───────────────────────────────────────────────────────────
  'sstv-open': { dir: Dir.C2S, feature: 'sstv' },
  'sstv-photo': { dir: Dir.C2S, feature: 'sstv' },
  'sstv-stop': { dir: Dir.C2S, feature: 'sstv' },
  'sstv-halt-tx': { dir: Dir.C2S, feature: 'sstv' },
  'sstv-get-gallery': { dir: Dir.C2S, feature: 'sstv' },
  'sstv-gallery': { dir: Dir.S2C, feature: 'sstv' },
  'sstv-get-compose': { dir: Dir.C2S, feature: 'sstv' },
  'sstv-compose-state': { dir: Dir.S2C, feature: 'sstv' },
  'sstv-rx-image': { dir: Dir.S2C, feature: 'sstv' },
  'sstv-rx-progress': { dir: Dir.S2C, feature: 'sstv' },
  'sstv-tx-status': { dir: Dir.S2C, feature: 'sstv' },
  'sstv-wf-bins': { dir: Dir.S2C, feature: 'sstv', fields: { bins: f.array } },
  // Mobile toggles auto-SSTV-on-idle remotely. Banner appears on the phone
  // when desktop pushes `sstv-tx-status: { state: 'auto-rx' }`; tapping it
  // sends `enabled: false`. (Gap 14.)
  'sstv-set-auto-enabled': { dir: Dir.C2S, feature: 'sstv', fields: { enabled: f.boolean } },

  // ─── Cloud (Cognito QSO sync) ───────────────────────────────────────
  'cloud-login': { dir: Dir.C2S, feature: 'cloud' },
  'cloud-login-result': { dir: Dir.S2C, feature: 'cloud' },
  'cloud-register': { dir: Dir.C2S, feature: 'cloud' },
  'cloud-register-result': { dir: Dir.S2C, feature: 'cloud' },
  'cloud-logout': { dir: Dir.C2S, feature: 'cloud' },
  'cloud-logout-result': { dir: Dir.S2C, feature: 'cloud' },
  'cloud-get-status': { dir: Dir.C2S, feature: 'cloud' },
  'cloud-status': { dir: Dir.S2C, feature: 'cloud' },
  'cloud-sync-now': { dir: Dir.C2S, feature: 'cloud' },
  'cloud-sync-result': { dir: Dir.S2C, feature: 'cloud' },
  'cloud-bulk-upload': { dir: Dir.C2S, feature: 'cloud' },
  'cloud-upload-result': { dir: Dir.S2C, feature: 'cloud' },
  'cloud-verify-subscription': { dir: Dir.C2S, feature: 'cloud' },
  'cloud-verify-result': { dir: Dir.S2C, feature: 'cloud' },
  'cloud-save-bmac-email': { dir: Dir.C2S, feature: 'cloud', fields: { bmacEmail: f.string } },
  'cloud-bmac-result': { dir: Dir.S2C, feature: 'cloud' },

  // ─── KiwiSDR / WebSDR ───────────────────────────────────────────────
  // `password` is forwarded to KiwiSDR servers that require auth (most are
  // open). See main.js:6230. (Gap 20b.)
  'kiwi-connect': { dir: Dir.C2S, feature: 'kiwi', fields: { host: f.string, password: f.optString } },
  'kiwi-disconnect': { dir: Dir.C2S, feature: 'kiwi' },
  // QSY the SDR receiver while connected. Mobile freq input wired to this.
  'kiwi-tune': { dir: Dir.C2S, feature: 'kiwi', fields: { freqKhz: f.string, mode: f.optString } },
  // Connection state + S-meter pushed back so mobile can render the SDR card.
  'kiwi-status': { dir: Dir.S2C, feature: 'kiwi', fields: { connected: f.boolean, host: f.optString, error: f.optString } },
  'kiwi-smeter': { dir: Dir.S2C, feature: 'kiwi', fields: { dbm: f.number } },
  // Raw PCM frames. WebSDR/Kiwi sample rates vary (8000..14238 Hz). Mobile
  // routes through WebRTC instead of decoding directly — this entry exists
  // for the desktop-renderer + ECHOCAT browser path.
  'kiwi-audio': { dir: Dir.S2C, feature: 'kiwi', fields: { pcm: f.array, sampleRate: f.number } },

  // ─── Propagation (RBN + PSKReporter Map) ────────────────────────────
  // Server pushes the full RBN spot array (where the user is being heard)
  // and PSKReporter Map spots (FT8/digital reception reports of the user).
  // Mirrors what the local Propagation popout receives. (Gaps 15, 19.)
  'rbn-prop-spots':  { dir: Dir.S2C, feature: 'prop', fields: { spots: f.array } },
  'pskr-map-spots':  { dir: Dir.S2C, feature: 'prop', fields: { spots: f.array } },
  'pskr-map-status': { dir: Dir.S2C, feature: 'prop', fields: { connected: f.boolean, spotCount: f.optNumber, nextPollAt: f.optNumber, pollUpdate: f.optBoolean } },

  // ─── Voice macros / preferences / decorations ───────────────────────
  // voice-macro-sync flows BOTH ways: phone uploads a recording (audio is
  // base64-encoded WebM), and at startup the server pushes existing
  // recordings down to the phone the same shape. Earlier the schema only
  // declared C2S. (Gap 3.)
  'voice-macro-sync': { dir: Dir.BOTH, feature: 'misc', fields: { idx: f.integer, label: f.optString, audio: f.optString } },
  'voice-macro-delete': { dir: Dir.C2S, feature: 'misc', fields: { idx: f.integer } },
  // Mobile macro-button tap → desktop plays the recorded clip out the rig
  // via the existing local voice-macro-ptt path. No payload back; TX state
  // surfaces via the regular status broadcast. (Gap 18.)
  'voice-macro-play': { dir: Dir.C2S, feature: 'misc', fields: { idx: f.integer } },
  // voice-macro-labels: server pushes the 5-slot label array on connect,
  // and again whenever the desktop UI saves new labels. (Gap 2.)
  'voice-macro-labels': { dir: Dir.S2C, feature: 'misc', fields: { labels: f.array } },
  'save-echo-pref': { dir: Dir.C2S, feature: 'misc' },
  'save-custom-cat-buttons': { dir: Dir.C2S, feature: 'misc', fields: { buttons: f.array } },
  'colorblind-mode': { dir: Dir.S2C, feature: 'misc', fields: { enabled: f.boolean } },
  'cluster-state': { dir: Dir.S2C, feature: 'misc', fields: { connected: f.boolean } },
  // qrz-names: server pushes a {CALLSIGN: 'Display Name'} map after each
  // batch QRZ lookup so the phone can label spot rows without doing its
  // own QRZ calls. (Gap 7.)
  'qrz-names': { dir: Dir.S2C, feature: 'misc', fields: { data: f.object } },
});

/**
 * First-message types accepted from a *legacy* (pre-v1) client. When a
 * client's first frame is one of these instead of `hello`, the server
 * should fall back to v0 behavior — i.e. skip the version handshake and
 * keep the connection alive, but mark capabilities as v0.
 *
 * The legacy browser ECHOCAT sends `auth` first. Keep that working
 * forever; native clients are expected to lead with `hello`.
 */
const LEGACY_FIRST_MESSAGE_TYPES = Object.freeze(['auth']);

/**
 * Return true if `type` is registered.
 */
function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(MESSAGES, type);
}

/**
 * Return the registry entry for `type` (or undefined).
 */
function describe(type) {
  return MESSAGES[type];
}

/**
 * Validate a parsed message object.
 *
 * Returns `{ ok: true }` on success, or
 * `{ ok: false, error: string, field?: string }` on failure.
 *
 * `expectedDir` is optional. When provided ('s2c' or 'c2s'), the
 * validator will refuse messages whose registered direction is the
 * opposite (i.e. a server that receives a `spots` push from a client
 * is misbehaving and we want to catch it).
 */
function validate(msg, expectedDir) {
  if (msg == null || typeof msg !== 'object') {
    return { ok: false, error: 'message must be an object' };
  }
  if (typeof msg.type !== 'string' || msg.type.length === 0) {
    return { ok: false, error: 'message.type missing or not a string' };
  }
  const def = MESSAGES[msg.type];
  if (!def) return { ok: false, error: 'unknown message type', field: 'type' };

  if (expectedDir && def.dir !== Dir.BOTH && def.dir !== expectedDir) {
    return { ok: false, error: `message ${msg.type} not allowed in direction ${expectedDir}` };
  }

  if (def.fields) {
    for (const [name, spec] of Object.entries(def.fields)) {
      const required = spec.required !== false;
      const present = Object.prototype.hasOwnProperty.call(msg, name) && msg[name] !== undefined;
      if (!present) {
        if (required) return { ok: false, error: `field ${name} is required`, field: name };
        continue;
      }
      const value = msg[name];
      const tcheck = checkType(value, spec);
      if (!tcheck.ok) return { ok: false, error: `field ${name}: ${tcheck.error}`, field: name };
    }
  }
  return { ok: true };
}

function checkType(value, spec) {
  switch (spec.type) {
    case 'any':
      return { ok: true };
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, error: 'expected string' };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true }
        : { ok: false, error: 'expected finite number' };
    case 'integer':
      return Number.isInteger(value)
        ? { ok: true }
        : { ok: false, error: 'expected integer' };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, error: 'expected boolean' };
    case 'array':
      return Array.isArray(value)
        ? { ok: true }
        : { ok: false, error: 'expected array' };
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true }
        : { ok: false, error: 'expected object' };
    case 'oneOf':
      return spec.values.includes(value)
        ? { ok: true }
        : { ok: false, error: `expected one of [${spec.values.join(',')}]` };
    default:
      return { ok: false, error: `unknown spec type ${spec.type}` };
  }
}

/**
 * Parse + validate a raw text frame from the wire.
 *
 * Returns `{ ok: true, msg }` or `{ ok: false, error }`.
 */
function parse(rawText, expectedDir) {
  let msg;
  try {
    msg = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const v = validate(msg, expectedDir);
  if (!v.ok) return { ok: false, error: v.error, field: v.field, raw: msg };
  return { ok: true, msg };
}

/**
 * Encode a message object to the wire format. Validates first; throws
 * on a malformed message rather than silently sending garbage.
 *
 * Server sites that broadcast structured-but-untyped payloads can pass
 * `{skipValidate: true}` to opt out — we do this for `status` and a
 * handful of pass-through messages whose shapes haven't been pinned
 * yet. Audit and remove these escapes over time.
 */
function encode(msg, opts = {}) {
  if (!opts.skipValidate) {
    const v = validate(msg);
    if (!v.ok) {
      const err = new Error(`echocat-protocol: refused to encode invalid message: ${v.error}`);
      err.code = 'PROTOCOL_INVALID';
      err.field = v.field;
      throw err;
    }
  }
  return JSON.stringify(msg);
}

/**
 * Server hello builder. Server sends this immediately after the WS
 * upgrade — before auth-mode — for any client that has indicated
 * (via a `hello` first frame) that it speaks v1+.
 */
function buildServerHello(opts) {
  return {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    serverVersion: opts && opts.serverVersion ? String(opts.serverVersion) : '',
    capabilities: opts && opts.capabilities ? opts.capabilities : [],
  };
}

/**
 * Client hello builder. Native and CLI clients send this first.
 * Browser ECHOCAT does not, and falls back to legacy v0 mode.
 */
function buildClientHello(opts) {
  return {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: opts && opts.clientVersion ? String(opts.clientVersion) : '',
    clientPlatform: opts && opts.clientPlatform ? String(opts.clientPlatform) : '',
  };
}

/**
 * Decide compatibility between a remote `hello` and the local
 * PROTOCOL_VERSION. Both sides should call this with the peer's
 * advertised version.
 *
 * Returns:
 *   - { compatible: true }                        — same major
 *   - { compatible: true, downgrade: true }       — peer is older but within range
 *   - { compatible: false, reason: string }       — close the socket
 */
function checkCompatibility(peerVersion) {
  if (typeof peerVersion !== 'number' || !Number.isInteger(peerVersion) || peerVersion < 0) {
    return { compatible: false, reason: 'peer protocolVersion missing or not an integer' };
  }
  if (peerVersion === PROTOCOL_VERSION) return { compatible: true };
  if (Math.abs(peerVersion - PROTOCOL_VERSION) > 1) {
    return {
      compatible: false,
      reason: `peer protocolVersion ${peerVersion} is too far from ours (${PROTOCOL_VERSION})`,
    };
  }
  return { compatible: true, downgrade: peerVersion < PROTOCOL_VERSION };
}

module.exports = {
  PROTOCOL_VERSION,
  CLOSE_CODES,
  Dir,
  MESSAGES,
  LEGACY_FIRST_MESSAGE_TYPES,
  isKnownType,
  describe,
  validate,
  parse,
  encode,
  buildServerHello,
  buildClientHello,
  checkCompatibility,
};
