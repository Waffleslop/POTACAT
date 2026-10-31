#!/usr/bin/env node
'use strict';
// The npm test chain. It outgrew cmd.exe's 8191-character command line as one
// `a && b && ...` string, so on Windows `npm test` printed "The command line
// is too long." and ran NOTHING (2026-10-23). Same order, same stop-on-first-
// failure, one Node process per file. Add new tests to this list.
const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  'test/syntax-check-test.js', // every source file parses (a main.js syntax error passed every other test)
  'test/rig-test.js',
  'test/cat-port-presence-test.js',
  'test/guest-pass-listen-test.js',
  'test/rigctld-spawn-test.js',
  'test/echocat-connect-diet-test.js',
  'test/cw-live-watchdog-test.js',
  'test/yaesu-cw-text-test.js',
  'test/lz3aw-web-parity-test.js',
  'test/lz3aw-round5-test.js',
  'test/call-filter-test.js',
  'test/desktop-ux-test.js',
  'test/host-port-test.js',
  'test/serial-callout-twin-test.js',
  'test/clock-offset-test.js',
  'test/require-exports-test.js',
  'test/smartsdr-meter-test.js',
  'test/smartsdr-dax-tx-claim-test.js',
  'test/vfo-ptt-race-test.js',
  'test/vfo-log-spot-test.js',
  'test/smartsdr-self-slice-test.js',
  'test/bundle-mac-deps-test.js',
  'test/rig-controls-test.js',
  'test/rig-gain-steps-test.js',
  'test/rig-family-test.js',
  'test/rigctld-attribution-test.js',
  'test/flrig-codec-test.js',
  'test/dxcluster-login-test.js',
  'test/dxcluster-backoff-test.js',
  'test/audio-backpressure-test.js',
  'test/spot-mute-rules-test.js',
  'test/websdr-test.js',
  'test/ragchew-test.js',
  'test/echocat-protocol.test.js',
  'test/protocol-demux-parity-test.js',
  'test/jtcat-test.js',
  'test/jtcat-parser-test.js',
  'test/ft8-engine-rebaseline-test.js',
  'test/guest-pass-test.js',
  'test/guest-pass-onair-call-test.js', // the pass's station call is the on-air call (K3SBP on W7RTA's pass)
  'test/guest-pass-lease-end-test.js', // the end of a pass stops every transmitter and closes the guest socket
  'test/guest-pass-hopping-test.js', // guests hop between rigs; the owner takes over and hands back
  'test/pass-qso-outbox-test.js', // a guest's contacts reach the GUEST's cloud logbook, sent by the shack
  'test/propagation-always-on-test.js', // RBN + PSKReporter Propagation has no switch
  'test/install-defaults-test.js', // logging/solar/band activity always on; SOTA/WWFF/LLOTA + a random cluster node once
  'test/pair-request-tunnel-gate-test.js',
  'test/sstv-test.js',
  'test/sstv-quality-test.js',
  'test/sstv-realistic-rx-test.js',
  'test/sstv-audio-device-test.js',
  'test/sstv-live-path-test.js',
  'test/sstv-input-level-test.js',
  'test/voice-macros-test.js',
  'test/ts-wss-url-test.js',
  'test/cq-target-test.js',
  'test/cq-target-relay-test.js',
  'test/remote-audio-answerer-test.js',
  'test/remote-ptt-test.js',
  'test/echocat-protocol-test.js',
  'test/remote-desktop-e2e-test.js',
  'test/wwbota-test.js',
  'test/gma-test.js',
  'test/parc-test.js',
  'test/worked-before-test.js',
  'test/worked-roster-test.js',
  'test/grid-state-test.js',
  'test/worked-overlay-test.js',
  'test/modem-rx-level-test.js',
  'test/watchlist-groups-test.js',
  'test/cert-san-policy-test.js',
  'test/merge-latest-mac-test.js',
  'test/lan-advertise-test.js',
  'test/custom-cat-parity-test.js',
  'test/worked-qsos-chunk-test.js',
  'test/web-log-form-test.js',
  'test/bug-report-log-test.js',
  'test/audio-capture-device-test.js',
  'test/ft8-message-buffer-test.js',
  'test/ft8-native-decoder-test.js',
  'test/jtcat-hunt-off-test.js',
  'test/jtcat-snr-floor-test.js', // Hunt does not call a CQ below the operator's signal floor (per band)
  'test/rx-spectrum-test.js', // the phone's VFO waterfall with no FT8 engine: Flex/Icom streams, the rig's sound card
  'test/yaesu-scope-test.js', // the FT-710's own scope: frame parser, axis, helper exit codes, remote payload guard (was CI-only)
  'test/flex-scope-test.js', // the Flex's own panadapter as the band scope (Flex Direct), against a real 8600 capture
  'test/scope-digital-view-test.js', // the scope's tight view on a digital mode's decode window (Flex)
  'test/kiwisdr-test.js', // KiwiSDR: settings after AR OK (firmware 1.902), receivers that allow no apps
  'test/listen-source-test.js', // who you hear: the radio, or the SDR where the radio cannot go (Casey 2026-10-30)
  'test/k4rvc-preset-flip-test.js', // an Icom's DATA flag folded into the mode the preset rules see; launch applies nothing
  'test/channels-test.js', // Directory > Channels: the saved frequency chart, CHIRP CSV both ways (KL4XQ, KC8DHX lists)
  'test/wd3d-activator-test.js', // WD3D: toolbar wraps at full screen; a two-fer/n-fer spot fills every P2P park
  'test/wspr-run-time-test.js', // WSPR beacon runs as long as the operator sets (K2BDE); a PTT port keys on RTS by default (K5LEB)
  'test/remote-client-yield-test.js', // a desktop kicked by another of the owner's devices yields the rig (W0EGR)
  'test/icom-scope-test.js', // an Icom's own band scope over CI-V: parser, codec events, the owner's 30 s recording
  'test/adif-import-refs-test.js', // POTA_REF-only logs (QLog) get SIG/SIG_INFO on import; the Logbook shows them (KC9FOZ)
  'test/icom-lan-voice-test.js', // voice over an Icom's LAN: DATA mode, or USB/LSB when DATA OFF MOD = LAN (EA1BZN)
  'test/scope-view-test.js', // the scope's shared ticks + trace painter (every surface), the synced tuning step
  'test/scope-overlay-test.js', // the scope's passband, split TX marker and band plan (Phase 3)
  'test/flex-readback-test.js', // a Flex's controls read back from the radio's own status (real 8600 capture)
  'test/scope-pan-device-test.js', // FT-710 zoom + CENTER over CAT, band scope frames sized and paced per device
  'test/gridtracker-roster-test.js', // GridTracker as JTCAT's call roster: decodes out, its double-click and stop back in
  'test/popout-theme-test.js', // every pop-out follows a theme change, from the quick toggle or Settings
  'test/vfo-voice-macros-test.js', // the VFO window's voice macro bar follows renames and recordings
  'test/jtcat-remote-anchor-test.js',
  'test/rsba1-transport.test.js',
  'test/activation-log-test.js',
  'test/activation-program-test.js',
  'test/diagnostic-snapshot-test.js',
  'test/mercury-process-test.js',
  'test/winlink-pat-test.js',
  'test/winlink-units-test.js',
  'test/winlink-spectrum-test.js',
  'test/winlink-main-wiring-test.js',
  'test/winlink-vara-test.js',
  'test/rigctld-shim-hamlib-test.js',
  'test/modem-audio-server-test.js',
  'test/modem-bridge-test.js',
  'test/wspr-daily-test.js',
  'test/wspr-power-memory-test.js',
  'test/js8-native-test.js',
  'test/js8-varicode-test.js',
  'test/js8-qso-test.js',
  'test/js8-rx-assembler-test.js',
  'test/js8-engine-test.js',
  'test/js8-remote-test.js',
  'test/idle-activity-test.js',
  'test/idle-mode-remote-test.js',
  'test/js8call-threads-test.js',
  'test/js8call-main-wiring-test.js',
  'test/renderer-csp-test.js',
  'test/index-html-balance-test.js',
  'test/window-lifecycle-test.js',
  'test/mercury-client-test.js',
  'test/radio-owner-test.js',
  'test/mercury-radio-bridge-test.js',
  'test/mercury-audio-bridge-test.js',
  'test/mercury-app-protocol-test.js',
  'test/echocat-web-gate-test.js',
  'test/tunnel-webui-gate-test.js',
  'test/cloud-session-change-test.js',
  'test/cloud-log-sync-test.js',
  'test/launch-origin-test.js',
  'test/cloud-merge-dupe-test.js',
  'test/swr-guard-test.js',
  'test/ft8-worker-respawn-test.js',
  'test/rig-setup-notes-test.js',
  'test/prop-empty-state-test.js',
  'test/rotctld-client-test.js',
  'test/station-setup-test.js',
  'test/setup-share-test.js',
  'test/lz3aw-round6-test.js',
  'test/cw-auto-sync-test.js',
  'test/remote-launcher-test.js',
  'test/launcher-cloud-test.js', // restart from anywhere: device token, tunnel policy, the launcher's own connector
  'test/echocat-token-test.js',
  'test/fresh-install-defaults-test.js',
  'test/review-ask-test.js',
  'test/rigctld-gain-fallback-test.js',
  'test/release-notes-format-test.js',
  'test/contests-view-test.js',
  'test/remote-server-rewire-test.js',
  'test/sstv-tx-data-mode-test.js',
  'test/contests-feed-test.js',
  'test/activation-share-test.js',
  'test/contests-db-test.js',
  'test/sstv-lock-test.js',
  'test/jtcat-session-worked-test.js',
  'test/spot-on-freq-test.js',
  'test/lz3aw-round7-test.js',
  'test/lz3aw-round8-test.js',
  'test/lz3aw-round9-test.js',
  'test/lz3aw-round10-test.js',
  'test/lz3aw-round11-test.js',
  'test/lz3aw-round12-test.js',
  'test/paddle-bounce-test.js',
  'test/spot-hides-test.js',
  'test/mac-titlebar-test.js',
  'test/vfo-and-greyout-test.js',
  'test/test-connection-restore-test.js',
  'test/serial-path-test.js',
  'test/jtty-codec-test.js',
  'test/jtty-decoder-test.js',
  'test/jtty-engine-test.js',
  'test/jtty-remote-test.js',
  'test/jtty-txfreq-remote-test.js',
  'test/nocat-rig-test.js',
  'test/logger-cat-test.js',
  'test/cm108-ptt-test.js',
  'test/removed-features-test.js',
  'test/dxpedition-contests-test.js',
  'test/vfo-meters-test.js',
  'test/dxe-remote-test.js',
  'test/oh7dsq-rx-after-tx-test.js',
  'test/trusdx-poll-test.js',
  'test/rigctld-sideband-width-test.js',
  'test/ft8-decode-deadline-test.js',
  'lib/ft8-engine-test.js',
  'test/echocat-usb-tx-graph-test.js',
  'test/sstv-decoder-state-test.js',
  'test/sstv-fskid-test.js',
  'test/sstv-packs-test.js',
  'test/sstv-redesign-test.js',
  'test/sstv-first-column-test.js',
  'test/sstv-mobile-readiness-test.js',
  'test/sstv-template-sync-test.js',
  'test/sstv-gallery-test.js',
  'test/sstv-keep-test.js',
  'test/sstv-help-test.js',
  'test/sstv-jtcat-handover-test.js',
  'scripts/validate-sstv-packs.js',
  'test/spot-age-pota-test.js',
  'test/cw-sidetone-schedule-test.js',
  'test/echocat-web-micgain-test.js',
  'test/cloud-billing-ui-test.js',
  'test/ts590-flow-control-test.js',
  'test/github-issues-2026-10-26-test.js', // #107 FT-450 test, #106 interface PTT, #103 Auto RTS trial
  'test/duo-vfo-wire-test.js',        // iPhone Duo VFO pane: tuned-spot, swr-guard-state, atu-tune, tx-eq, status.meters
  'test/activator-hunter-parks-test.js', // WD3D: their parks as a comma list (n-fer P2P)
  'test/vfo-power-button-test.js',    // KQ5O: Power On/Off at the bottom of the VFO window
  'test/dx-rule-test.js',            // G4BFG: DX = another entity, or the operator's HF / 6 m-up distance
  'test/external-atu-carrier-test.js', // N8JMS: RF-sense tuner carrier in AM (CW over CAT is key-up)
  'test/jtcat-map-popout-arcs-test.js', // TacticalIndex: QSO arcs in the JTCAT map pop-out
  'test/ae5je-settings-audio-test.js', // AE5JE: audio devices follow their name; bug report says whether settings saves land
  'test/page-script-globals-test.js', // one top-level scope per page: a second const of the same name stops a script (WB3EGD, the dead 1.13.5 audio heal)
  'test/window-min-size-test.js',     // N0KAH: no window shrinks past its own controls
  'test/yaesu-fa-digits-test.js',
  'test/log-as-test.js',
  'test/save-qso-stall-test.js',
  'test/pota-sync-login-test.js',
  'test/qso-expand-test.js',
  'test/spot-park-state-test.js', // a multi-state park's state from the activator's spot locationCode (N0KAH)
  'test/log-dialog-qrz-test.js',
  'test/logging-parity-test.js',
  'test/pskr-map-band-cap-test.js',
  'test/watchlist-sync-test.js',
  'test/echocat-oct19-asks-test.js',
  'test/cw-speed-test.js',
  'test/echocat-kicked-audio-test.js',
  'test/jtcat-split-panes-test.js',
  'test/qrz-base-call-test.js',
  'test/external-links-allowed-test.js',
  'test/fetch-policy-test.js',
  'test/icom-picker-models-test.js',
  'test/k9cyt-requests-test.js',
  'test/respot-templates-remote-test.js',
  'test/cw-remote-expand-test.js',
  'test/cw-greeting-test.js',
  'test/lotw-flags-test.js',
  'test/lotw-split-test.js',
  'test/station-county-test.js', // the operator's own state and county: per park on activations, home only from the home grid
  'test/sdr-scope-test.js',
  'test/rtltcp-audio-test.js',
  'test/landmarks-test.js', // Directory > Landmarks: the catalog gate, hours, rig coverage, the NCDXF clock, the feed, wiring
  'test/lz3aw-round14-test.js',
  'test/lz3aw-batch-b-test.js',
  'test/lotw-report-test.js',
  'test/rumlogng-logbook-test.js',
  'test/wsjtx-status-bridge-test.js',
  'test/jtcat-tx-slot-test.js',
  'test/activation-map-data-test.js',
  'test/log-freq-test.js',
  'test/station-clock-test.js', // ECHOCAT device sets the FT8 slot clock
  'test/rig-bands-test.js',
  'test/award-tables-test.js',
  'test/wspr-legend-test.js',
  'test/directory-echocat-seed-test.js',
  'test/pota-email-spot-test.js',
  'test/kf0u-stuck-ptt-test.js',
  'test/active-rig-heal-test.js',
  'test/cw-popover-clamp-test.js',
  'test/atu-keep-on-test.js',
  'test/cloud-api-keys-test.js',
  'test/adif-clean-test.js',
  'test/cloud-tab-ui-test.js',
  'test/jtcat-slider-wheel-test.js',
  'test/cloud-phase2-ui-test.js',
  'test/onair-callsign-test.js',
  'test/activated-parks-test.js',
  'test/serial-port-busy-hint-test.js',
  'test/local-paddle-route-test.js',
  'test/bands-everywhere-test.js',
  'test/remote-tx-audio-diag-test.js',
  'test/welcome-cloud-signin-test.js',
  'test/activation-filename-date-test.js',
  'test/remote-rig-test.js',
  'test/remote-multi-client-test.js',
  'test/remote-bridge-test.js',
  'test/sstv-context-test.js',
  'test/tailscale-detect-test.js',
  'test/yaesu-legacy-codec-test.js',
  'test/icom-network-log-routing-test.js',
  'test/icom-network-voice-test.js',
  'test/jtty-chats-test.js',
  'test/rig-presets-test.js',
  'test/web-row-alignment-test.js',
  'test/worked-other-test.js',
  'test/decode-contract-test.js',
  'test/layout-alignment-test.js',
  'test/g90-hamlib-model-test.js',
  'test/voice-data-mode-test.js',
  'test/n3fjp-pull-test.js',
  'test/pota-hunter-import-test.js',
];

const root = path.join(__dirname, '..');
const only = process.argv.slice(2);
const list = only.length ? TESTS.filter((f) => only.some((o) => f.includes(o))) : TESTS;
let n = 0;
for (const f of list) {
  const r = spawnSync(process.execPath, [f], { cwd: root, stdio: 'inherit' });
  n++;
  if (r.status !== 0) {
    console.error(`
[run-tests] FAILED: ${f} (exit ${r.status}${r.signal ? ', ' + r.signal : ''}) — ${n} of ${list.length} run`);
    process.exit(r.status || 1);
  }
}
console.log(`
[run-tests] all ${list.length} test files passed`);
