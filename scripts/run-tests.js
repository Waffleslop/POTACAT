#!/usr/bin/env node
'use strict';
// The npm test chain. It outgrew cmd.exe's 8191-character command line as one
// `a && b && ...` string, so on Windows `npm test` printed "The command line
// is too long." and ran NOTHING (2026-10-23). Same order, one Node process per
// file. Add new tests to this list.
//
// Every file runs even after one fails (GitHub #175: stopping at file ~208 of
// 433 hid the other 225), then a summary names each failure and the run exits
// non-zero if any file failed. `node scripts/run-tests.js <substr>...` runs
// only the files whose path contains one of the substrings.
const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  'test/syntax-check-test.js', // every source file parses (a main.js syntax error passed every other test)
  'test/rig-test.js',
  'test/icom-baud-list-test.js', // #238: every baud select offers 4800-115200; Icom path accepts each
  'test/cat-port-presence-test.js',
  'test/guest-pass-listen-test.js',
  'test/rigctld-spawn-test.js',
  'test/echocat-connect-diet-test.js',
  'test/cw-live-watchdog-test.js',
  'test/yaesu-cw-text-test.js',
  'test/cw-stuck-wiring-test.js',
  'test/lz3aw-web-parity-test.js',
  'test/lz3aw-round5-test.js',
  'test/call-filter-test.js',
  'test/desktop-ux-test.js',
  'test/host-port-test.js',
  'test/serial-callout-twin-test.js',
  'test/clock-offset-test.js',
  'test/require-exports-test.js',
  'test/smartsdr-meter-test.js',
  'test/flex-slice-filter-test.js',
  'test/smartsdr-dax-tx-claim-test.js',
  'test/vfo-ptt-race-test.js',
  'test/vfo-ptt-mic-test.js', // #170: every VFO PTT press logs the mic it opened, the output and the level
  'test/vfo-audio-power-cycle-test.js', // #247: VFO window radio audio reattaches after a radio power cycle
  'test/vfo-log-spot-test.js',
  'test/vfo-wheel-direction-test.js', // #192 w0tlp: wheel up = frequency up in the VFO window
  'test/vfo-tx-power-test.js', // #199 w0tlp: TX power slider in the VFO window, the Rig panel's caps and dispatcher
  'test/smartsdr-self-slice-test.js',
  'test/bundle-mac-deps-test.js',
  'test/rig-controls-test.js',
  'test/rig-gain-steps-test.js',
  'test/rig-family-test.js',
  'test/rigctld-attribution-test.js',
  'test/flrig-codec-test.js',
  'test/cw-text-unsupported-link-test.js',
  'test/cw-text-fallback-test.js',
  'test/dxcluster-login-test.js',
  'test/dxcluster-backoff-test.js',
  'test/audio-backpressure-test.js',
  'test/spot-mute-rules-test.js',
  'test/websdr-test.js',
  'test/jtcat-websdr-source-test.js', // #243: JTCAT decodes from the WebSDR: source switch, dial follow, TX refused, 12 kHz resampler
  'test/ragchew-test.js',
  'test/echocat-protocol.test.js',
  'test/protocol-demux-parity-test.js',
  'test/jtcat-test.js',
  'test/jtcat-parser-test.js',
  'test/jtcat-qso-card-test.js',     // QSO logged is a centred card in theme colours
  'test/ft8-engine-rebaseline-test.js',
  'test/guest-pass-test.js',
  'test/pass-code-log-test.js',
  'test/guest-pass-onair-call-test.js', // the pass's station call is the on-air call (K3SBP on W7RTA's pass)
  'test/guest-pass-lease-end-test.js', // the end of a pass stops every transmitter and closes the guest socket
  'test/guest-pass-hopping-test.js', // guests hop between rigs; the owner takes over and hands back
  'test/guest-pass-authority-test.js', // a Guest Pass is default-deny: the allowlist wall in the demux + the rig-control action wall
  'test/guest-pass-tx-gate-test.js', // the TX gate judges the effective TX frequency (split) and the radio's reported power against the cap
  'test/revoke-device-test.js', // revoking a device closes EVERY socket of that device; a socket whose pairing is gone is closed on its next message
  'test/remote-access-test.js', // ECHOCAT access off | cloud | lan: migration, the loopback bind for Cloud only, Off starts no listener
  'test/pass-qso-outbox-test.js', // a guest's contacts reach the GUEST's cloud logbook, sent by the shack
  'test/clublog-test.js', // Club Log form/multipart bytes, response map, credentialKey
  'test/clublog-outbox-test.js', // #142: realtime Club Log uploads queue per operator; a 403 pauses that account
  'test/propagation-always-on-test.js', // RBN + PSKReporter Propagation has no switch
  'test/install-defaults-test.js', // logging/solar/band activity always on; SOTA/WWFF/LLOTA + a random cluster node once
  'test/pair-request-tunnel-gate-test.js',
  'test/sstv-test.js',
  'test/sstv-quality-test.js',
  'test/sstv-realistic-rx-test.js',
  'test/sstv-audio-device-test.js',
  'test/sstv-live-path-test.js',
  'test/sstv-drive-test.js', // #279: the SSTV Drive slider keeps 0, shows its value, and is never squeezed
  'test/sstv-start-band-test.js', // #292: SSTV never tunes a radio to a band it is not set up for
  'test/sstv-text-styles-test.js', // #327: typeface, outline, shadow, letter spacing per SSTV text layer
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
  'test/custom-cat-read-test.js', // #242: a custom toggle's own read command + ON-when rule; unknown, not OFF, when unread; no read during TX
  'test/worked-qsos-chunk-test.js',
  'test/web-log-form-test.js',
  'test/bug-report-log-test.js',
  'test/audio-capture-device-test.js',
  'test/ft8-message-buffer-test.js',
  'test/ft8-native-decoder-test.js',
  'test/jtcat-hunt-off-test.js',
  'test/halt-tx-test.js',
  'test/refused-key-audio-test.js', // #214: a refused key-down plays no radio audio (Tune, SSTV, voice macro); a Tune stop during start-up wins
  'test/own-licence-tx-test.js',
  'test/privileges-one-source-test.js', // #250: lib/privileges.js is the one table (renderer loads it); unverified classes never refuse TX; no change vs master
  'test/privileges-verified-gate-test.js', // #250: the ATU wizard and Guest Pass never refuse for an unverified licence class
  'test/rigctld-power-scale-test.js',
  'test/rigctld-kenwood-power-test.js', // a TS-590/TS-2000 behind Hamlib keeps its power: raw PC, never Hamlib's PC000/PC255 probe
  'test/jtcat-tx-watchdog-test.js',
  'test/jtcat-replace-log-test.js',
  'test/port-picker-test.js',
  'test/pota-parks-db-test.js',
  'test/elecraft-data-mode-test.js',
  'test/kenwood-filter-width-test.js',
  'test/cw-key-port-race-test.js',
  'test/guest-pass-emission-test.js',
  'test/jtcat-worked-update-test.js',
  'test/g90-tx-poll-test.js',
  'test/g90-fake-rigctld-test.js', // #109: a fake rigctld that dies on CAT in TX; the G90 keeps the link through an over, a generic model's reconnect unkeys first
  'test/wfm-mode-test.js',
  'test/jtcat-dial-follow-test.js',
  'test/winlink-fault-test.js',
  'test/direwolf-agw-probe-test.js',
  'test/ptt-cat-line-test.js',
  'test/rigctld-link-hints-test.js',
  'test/serial-cat-test-connection-test.js',
  'test/voice-recorder-test.js',
  'test/hf-net-row-test.js',
  'test/log-freq-follow-test.js',
  'test/freq-paste-test.js',
  'test/spot-source-cache-test.js',
  'test/map-marker-reconcile-test.js', // #246: map markers reconcile by spot key; CW/SOTA pins no longer blink out per push
  'test/ft-mode-filter-test.js',
  'test/jtcat-map-popup-test.js',
  'test/worked-matrix-test.js',
  'test/prior-contacts-test.js', // #154: Prior contacts card from the hunter table and FT8 decode list right-click; check mark hover
  'test/prefix-overlay-test.js',
  'test/dxpedition-dials-test.js',
  'test/renderer-global-api-test.js',
  'test/heard-grids-test.js',
  'test/idle-rx-watching-test.js',
  'test/jtcat-picker-test.js',
  // Run by CI's test.yml but missing here until 2026-11-02 (a CI-only failure slipped past the local suite):
  'test/contest-history-test.js',
  'test/cw-key-line-test.js',
  'test/cw-paddle-availability-test.js',
  'test/event-banner-pick-test.js',
  'test/event-decode-match-test.js',
  'test/event-geo-test.js',
  'test/event-progress-test.js',
  'test/event-registry-test.js',
  'test/events-catalog-test.js',
  'test/hunted-park-test.js',
  'test/nfer-refs-test.js', // an n-fer's other parks, read from the activator's own spot comment (#353)
  'test/js8-audio-feed-test.js',
  'test/log-comment-test.js',
  'test/raw-cat-command-test.js',
  'test/rigctld-stderr-test.js',
  'test/sdr-list-sync-test.js',
  'test/settings-secrets-test.js',
  'test/qrz-logging-pointer-test.js', // #202: Logging tab points to the QRZ logbook upload on the Station tab
  'test/sstv-e2e-test.js',
  'test/sstv-feed-gate-test.js',
  'test/wrl-packet-test.js',
  'test/jtcat-snr-floor-test.js', // Hunt does not call a CQ below the operator's signal floor (per band)
  'test/rx-spectrum-test.js', // the phone's VFO waterfall with no FT8 engine: Flex/Icom streams, the rig's sound card
  'test/ft4222-library-test.js', // #360: FTDI's LibFT4222 names per platform (versioned Mac dylib + libftd2xx), Setup's copy plan, Mach-O archs, the loader's reason in Mac words
  'test/yaesu-scope-test.js', // the FT-710's own scope: frame parser, axis, helper exit codes, remote payload guard (was CI-only)
  'test/k4-pan-test.js', // #396: the Elecraft K4's network panadapter (PAN 0x02): header, dBm, 850 points, fixed axis, wiring
  'test/kenwood-scope-test.js', // #397: the TS-890S bandscope over USB/COM (DD0 5 -> DD4): lines, sweeps, axis, AI/DD0 read-first and put back, 115200, poll not disturbed
  'test/flex-scope-test.js', // the Flex's own panadapter as the band scope (Flex Direct), against a real 8600 capture
  'test/scope-digital-view-test.js', // the scope's tight view on a digital mode's decode window (Flex)
  'test/sdr-failure-test.js', // #390: a WebSDR that would not come on says why in the VFO window, with Try again
  'test/kiwisdr-test.js', // KiwiSDR: settings after AR OK (firmware 1.902), receivers that allow no apps
  'test/listen-source-test.js', // who you hear: the radio, or the SDR where the radio cannot go (Casey 2026-10-30)
  'test/k4rvc-preset-flip-test.js', // an Icom's DATA flag folded into the mode the preset rules see; launch applies nothing
  'test/channels-test.js', // Directory > Channels: the saved frequency chart, CHIRP CSV both ways (KL4XQ, KC8DHX lists)
  'test/memory-recall-test.js', // #308: a Channels entry recalls the radio's own memory; any later tune leaves memory mode first
  'test/app-theme-test.js', // design-system themes reach every window; was missing from this list, so a stale check went unseen
  'test/design-tokens-test.js', // tokens.css is generated and current, theme ids and order match the phone; was missing from this list
  'test/look-picker-test.js', // #376: Light / Dark / System, the six swatches in order, contrast 4.5:1 per theme
  'test/vfo-compact-test.js', // VFO window: Audio on/off, the mini VFO strip, POTACAT colours for PTT, sliders and CW
  'test/vfo-layout-test.js', // VFO window: Large and Small VFO layouts, one-line Small VFO, CAT buttons, Scan
  'test/main-window-layout-fixes-test.js', // #285 Log button "L", #284 HF Nets check mark, #298 HOLD TO TALK off screen
  'test/wd3d-activator-test.js', // WD3D: toolbar wraps at full screen; a two-fer/n-fer spot fills every P2P park
  'test/wspr-run-time-test.js', // WSPR beacon runs as long as the operator sets (K2BDE); a PTT port keys on RTS by default (K5LEB)
  'test/remote-client-yield-test.js', // a desktop kicked by another of the owner's devices yields the rig (W0EGR)
  'test/remote-spots-one-writer-test.js', // #246: a remote PC's spot list has one writer (the shack's while linked)
  'test/favorites-test.js', // #329: starred Landmarks and Channels, per operator, in Directory, the VFO window, the band scope and ECHOCAT
  'test/icom-scope-test.js', // an Icom's own band scope over CI-V: parser, codec events, the owner's 30 s recording
  'test/adif-import-refs-test.js', // POTA_REF-only logs (QLog) get SIG/SIG_INFO on import; the Logbook shows them (KC9FOZ)
  'test/icom-lan-voice-test.js', // voice over an Icom's LAN: DATA mode, or USB/LSB when DATA OFF MOD = LAN (EA1BZN)
  'test/settings-file-test.js', // settings written via temp+rename with a .bak; a truncated file is restored, never read as a fresh install
  'test/wsjtx-qdatetime-test.js', // QSO Logged dates are valid UTC; an invalid one never goes out as 1899 (ik4idf Logger32)
  'test/operating-entity-test.js', // W1AW/KL7 is Alaska; the log takes QRZ's DXCC entity, not its mailing country
  'test/hound-log-call-test.js', // a hound calls the fox's base call but logs the full call (level_death 6W/IK2HKT)
  'test/jtcat-hound-chip-test.js', // #160: HOUND chip is a two-way toggle on the main screen
  'test/qrz-login-message-test.js', // Settings > Logging QRZ line: signed in vs no subscription vs bad password (K0DHW)
  'test/voice-tx-check-test.js', // 0 W / no ALC on a voice over: one hint naming the radio's audio-input menu
  'test/rig-test-saved-note-test.js', // a passing rig-editor Test says when its port is not saved yet
  'test/serial-reopen-test.js', // connectCat waits for the old port's release; Access denied on our own handle says so (KK6EZA)
  'test/serial-close-blocked-cts-test.js', // RTS/CTS write stuck on CTS: flush before close, bounded close, None keeps the close (#174)
  'test/yaesu-lines-low-test.js', // every Yaesu drops DTR/RTS at open (stein, G5HOW: keyed on connect)
  'test/split-first-tune-test.js', // #113 item 2: no split OFF unless POTACAT turned split on
  'test/waterfall-palettes-test.js', // waterfall / band scope palettes = the ECHOCAT app's, wired into every waterfall
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
  'test/activation-auto-end-test.js', // #147: a forgotten activation ends at the UTC day change or after 6 h with no contacts
  'test/activation-logging-388-test.js', // #388: a habit Tab after the RST jump is absorbed; a corrected park grid is kept per park
  'test/state-backfill-test.js', // #389: QRZ state fill counts only tracked entities (never VK) and names the QSOs left
  'test/diagnostic-snapshot-test.js',
  'test/mercury-process-test.js',
  'test/winlink-pat-test.js',
  'test/winlink-reach-test.js',      // a radio session goes only where this radio can transmit
  'test/winlink-units-test.js',
  'test/winlink-spectrum-test.js',
  'test/winlink-main-wiring-test.js',
  'test/winlink-vara-test.js',
  'test/winlink-vara-anywhere-test.js', // #287: VARA HF and VARA FM on Linux, macOS and Windows, at a host and port; a fake VARA TNC (real Pat when its binary is present)
  'test/winlink-connect-test.js', // #128: /api/connect over http.request with no headers timeout; VARA and ARDOP send the same request
  'test/direwolf-agw-monitor-test.js', // #128: what Dire Wolf heard, over its AGW port's monitor mode
  'test/packet-rig-mode-test.js', // #128 N5XHI FT-857D: Packet mode on the radio per rig; Automatic is the old behaviour for every family
  'test/packet-timing-test.js', // #257 NA4DQ IC-7100: Dire Wolf TX delay/tail settings, the packet PTT hold, no "decoded nothing" after Pat connected
  'test/modem-play-over-test.js', // #300: gaps and backlog drops inside a transmitted frame are counted and logged
  'test/modem-tx-burst-test.js', // #128: one log line per modem over — PTT, audio start/end, peak dBFS, unkey
  'test/winlink-voacap-probe-test.js', // #278: the hosted VOACAP is checked once; when it is missing Pat is not pointed at it
  'test/modem-prekey-test.js', // #289: modem audio that arrives before its PTT request is sent at key-down, not discarded
  'test/winlink-diag-test.js', // #295: the modem's events and the audio's health in the session log; modem logs in Report a Bug
  'test/winlink-busy-wait-test.js', // #296: Keep waiting stays chosen, Stop ends Pat's busy wait, the watchdog does not call the wait a stall
  'test/modem-audio-lane-test.js', // #187: the modem's audio off the main process; credit, drain, counted cuts
  'test/winlink-awake-test.js', // #187: a radio Winlink session holds off App Nap (the hidden bridge window starved on a Mac)
  'test/winlink-history-test.js', // #254: gateway history from Pat's event log, My gateways (saved gateways)
  'test/winlink-outcome-test.js', // #425: how a session ended is worded in one place; Pat's reply never reaches a status; one summary line per session
  'test/winlink-pat-recover-test.js', // #430: after an Abort, Connect restarts a Pat that is stuck on the last call; a session never starts on top of a dial (VARA)
  'test/winlink-auto-retry-test.js', // #425: one automatic retry after a dropped link, never after no answer or Abort; countdown, channel check, Cancel
  'test/winlink-arq-timeout-test.js', // #425: the ARDOP link timeout is a setting; it reaches our Pat build through the environment; the summary says the value in force
  'test/winlink-contacts-test.js', // the Winlink address book, and the Position report and POTA spot forms
  'test/winlink-summary-store-test.js', // #425: the session summary lines survive a restart, so Report a Bug still holds the session that dropped
  'test/rigctld-shim-hamlib-test.js',
  'test/rigctld-died-test.js',
  'test/interface-ptt-test.js',
  'test/dial-snap-test.js',
  'test/web-ft8-running-test.js',
  'test/jtcat-band-pick-test.js',
  'test/sstv-robot36-spec-test.js',
  'test/ui-batch-2026-11-05-test.js',
  'test/modem-audio-server-test.js',
  'test/modem-bridge-test.js',
  'test/wspr-daily-test.js',
  'test/wspr-spot-time-test.js', // W5JSS: wsprnet time = the 2-minute window start, not the decode finish
  'test/wsprd-depth-test.js', // N5IRU: a slow PC steps wsprd's search down instead of timing out every window
  'test/sstv-rx-ended-test.js', // boblk9tc: a decode that ends with no picture leaves Receiving on ECHOCAT
  'test/cloud-tunnel-claim-test.js', // KQ5O: one shack per Cloud address; Off keeps it for the others
  'test/cloud-shacks-test.js', // a Cloud address per shack (<call>-<name>.potacat.com), so the phone can switch shacks
  'test/icom-ptt-memory-mode-test.js', // nj7n_nate: no frequency re-send around an Icom PTT mode swap (memory mode)
  'test/ssb-sideband-tune-test.js', // a 60 m SSB spot tunes USB
  'test/ssb-sideband-one-rule-test.js', // #445: band buttons and typed frequencies pick LSB/USB by band in voice SSB; one copy of the rule
  'test/capture-stall-test.js', // kc8zp_ryan: JTCAT capture rebuilt when the OS mutes/suspends it or it stops delivering
  'test/jtcat-capture-gate-test.js', // #133: a remote-started FT8 capture is restarted like a desktop one; one capture build at a time
  'test/jtcat-log-comment-test.js', // dcxweaver: the "JTCAT FT8" COMMENT is optional (default on)
  'test/vfo-sdr-volume-test.js', // #118 df1vb: the SDR Volume row stands in when the VOL knob is hidden
  'test/wspr-power-memory-test.js',
  'test/js8-native-test.js',
  'test/js8-varicode-test.js',
  'test/js8-qso-test.js',
  'test/js8-rx-assembler-test.js',
  'test/js8-engine-test.js',
  'test/js8-remote-test.js',
  'test/idle-activity-test.js',
  'test/idle-mode-remote-test.js',
  'test/remote-web-ft8-first-open-test.js',
  'test/remote-web-mail-test.js', // #425 web W1, W2, W4: the Mail tab puts the radio back, shows how a session ended, and says why
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
  'test/cloud-pull-per-profile-test.js', // #245: profiles sharing one account: each pulls only its own QSOs; the dupe guard and journal stay per profile
  'test/cloud-pull-forward-test.js', // #267: a phone's off-grid QSOs of this station reach MacLoggerDX etc. via the pull, once; never another PC's or the history
  'test/swr-guard-test.js',
  'test/atu-wizard-test.js',         // Flex ATU Calibration Wizard: plan vs privileges, classifier, run loop on a fake Flex, wiring
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
  'test/web-keyer-late-release-test.js', // #244: a held paddle's late release withdraws an element not yet sounding
  'test/spot-hides-test.js',
  'test/mac-titlebar-test.js',
  'test/vfo-and-greyout-test.js',
  'test/test-connection-restore-test.js',
  'test/serial-path-test.js',
  'test/jtty-codec-test.js',
  'test/jtty-decoder-test.js',
  'test/jtty-engine-test.js',
  'test/jtcat-skip-tx1-steps-test.js', // the QSO steps show the report Faster contacts really sends
  'test/jtcat-auto-respot-test.js', // opt-in re-spot of a hunted activator after a JTCAT contact
  'test/jtty-remote-test.js',
  'test/jtty-txfreq-remote-test.js',
  'test/nocat-rig-test.js',
  'test/commander-codec-test.js',
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
  'test/sstv-gallery-dir-test.js', // #123: the gallery folder is prepared async with a time limit, never sync on the SSTV window-open path
  'test/sstv-keep-test.js',
  'test/sstv-help-test.js',
  'test/sstv-jtcat-handover-test.js',
  'scripts/validate-sstv-packs.js',
  'test/spot-age-pota-test.js',
  'test/scope-spot-age-test.js', // #239: the scope/bandspread pop-outs apply the table's Max Spot Age, re-checked on a timer
  'test/cw-sidetone-schedule-test.js',
  'test/echocat-web-micgain-test.js',
  'test/cloud-billing-ui-test.js',
  'test/ts590-flow-control-test.js',
  'test/rts-asserted-no-flow-test.js', // #136: RTS line "Asserted, no flow control" (YT-1200 pass-through) + the CTS-low log line
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
  'test/window-rules-test.js',        // every window opens in the theme and remembers its place
  'test/yaesu-fa-digits-test.js',
  'test/log-as-test.js',
  'test/save-qso-stall-test.js',
  'test/pota-sync-login-test.js',
  'test/pota-sync-log-test.js', // #406: the pota.app Connect step logs names and lengths, never a value
  'test/qso-expand-test.js',
  'test/sota-chase-test.js', // #191: a POTA-primary record carrying a sotaRef uploads its SOTA chase
  'test/spot-programs-test.js', // POTA + SOTA spot: both pills, summit in the Ref column
  'test/spot-park-state-test.js', // a multi-state park's state from the activator's spot locationCode (N0KAH)
  'test/log-dialog-qrz-test.js',
  'test/logging-parity-test.js',
  'test/log-review-test.js',
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
  'test/remote-rig-power-test.js', // #152: rig power on/off from a remote POTACAT; no Power Off under a TX
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
  'test/freq-dots-test.js', // every frequency an operator reads is written the VFO way, 14.074.00 (Casey 2026-11-11)
  'test/settings-contrast-test.js', // Settings meets the contrast rule in every theme (VARA button in She's On Frequency); rendered: scripts/settings-contrast-audit.js
  'test/settings-pi-test.js',
  'test/log-form-layout-test.js', // #240: the Log QSO form is wider, resizable with its width remembered, and its paired fields wrap at any Text size / display scale
  'test/g90-hamlib-model-test.js',
  'test/voice-data-mode-test.js',
  'test/n3fjp-pull-test.js',
  'test/tx-limit-test.js', // one stuck-TX limit over every key-down POTACAT starts; a radio keyed without us is logged
  'test/ptt-data-mode-order-test.js', // SSB-over-DATA keys only once the radio reports DATA; the voice mode is restored after unkey and confirmed
  'test/winlink-compose-hint-test.js', // #188 NA4DQ: compose placeholder follows the mode (packet/VARA FM never say HF)
  'test/winlink-data-hold-test.js', // #187 NA4DQ IC-7300: a Winlink session holds DATA (no USB/DIGU flip per frame); the dial goes back once, logged
  'test/tx-no-freq-poll-test.js', // no frequency/mode poll while PTT is asserted; a frequency read during TX is ignored (kg6odijohn)
  'test/filter-width-untouched-test.js', // a spot click leaves the filter width alone: a width only from Filter Width settings or a rig preset
  'test/sstv-spec-timing-test.js', // Scottie, PD and Robot 72 send and read the spec line: exact scans, Robot 72's porch before each chroma
  'test/vfo-typed-freq-uhf-test.js', // 432100 and 1296100 typed in the VFO window are 70 cm and 23 cm, not 0.43 and 1.3 MHz (davidcappello IC-9700)
  'test/swr-rest-on-rx-test.js', // SWR and ALC go back to rest on receive (davidcappello IC-9700); the Icom SWR scale is Hamlib's
  'test/sculan10-test.js', // Yaesu SCU-LAN10 (experimental): wire protocol against the spec's reference values, the transport against a fake unit (login, setup, keepalives, CAT de-dup, RX audio, login timeout, password never logged)
  'test/sculan10-wiring-test.js', // SCU-LAN10 in POTACAT: a visible rig-editor choice, Yaesu codec over the transport, RX audio to JTCAT/SSTV/ECHOCAT, a key-down with LAN audio refused (never a silent carrier)
  'test/sculan10-read-first-test.js', // FT-710 scope Enable reads SCU-LAN10 (EX030126) before writing: already ON is left alone and not turned off at close; no answer means no blind write (#113 item 7)
  'test/sculan10-scope-test.js', // SCU-LAN10 band scope: spec-shaped frames, inverted amplitude, the line is the first 850 bytes of a 4096-byte frame (#143), the boundary marker and its lock, 850-point resampling, bin-to-frequency
  'test/rig-full-power-test.js', // a radio's real full power (rig.fullPowerW): W5LEE's 5 W Hermes Lite behind deskHPSDR's 100 W TS-2000 emulation, slider, PC command, readback and log in real watts
  'test/power-restore-test.js', // the external-tuner / test restore: never a 100 W guess, never against the operator's own knob (GitHub #111, 1.13.10 regression)
  'test/activator-log-once-test.js', // the Activator log saves once per press, and a slow QRZ never holds up a save (.eddiejames duplicates)
  'test/serial-hs-trial-test.js', // the RTS/CTS no-answer trial covers Kenwood too (jcoreyc TS-480), never the legacy Yaesu protocol
  'test/idle-wspr-band-test.js', // idle-RX WSPR uses only the rig's bands and offers 2 m (artificialjumpprotection IC-7100)
  'test/park-db-check-test.js', // activator: only POTA refs are checked against the parks list (og3e WWFF/SOTA flagged as typos), and the warning never overflows
  'test/rigctld-passthrough-test.js', // custom CAT over rigctld: a + or \ command goes to rigctld as typed (electricfalcon)
  'test/mono-upmix-test.js', // the VFO monitor plays radio audio in both ears (hoogskev, macOS left-channel only)
  'test/setup-test-freq-test.js', // Station Setup test transmit: at the dial if the licence allows, else at the band's FT8 dial and back, else refused with why (w0tlp)
  'test/jtcat-hunt-filters-test.js', // Hunt filters (plan-jtcat-hunt-priorities): targets ANY, priority, Never answer, auto-skip, CQ DX/continent rule, quiet-reason text
  'test/jtcat-hunt-status-test.js', // Hunt status line (why Hunt is quiet) and Hide decodes below (nj2dx)
  'test/jtcat-hunt-new-grid-test.js', // Hunt: New grids target, Wanted split into New DXCC / New grid (level_death)
  'test/jtcat-hunt-priority-test.js', // Hunt: Who goes first (Strongest default, Farthest, Needed first)
  'test/jtcat-hunt-custom-test.js', // Hunt: Custom (ANY of the ticked targets), Hunt minimum dB in the Filters panel
  'test/jtcat-hunt-ignore-test.js', // Hunt: Never answer (right-click a decode) and 30-min auto-skip after a failed QSO
  'test/jtcat-hunt-cq-dx-test.js', // Hunt: never answer a CQ DX from our own continent, nor a CQ NA/EU aimed elsewhere
  'test/jtcat-fake-it-test.js', // Split operation "Fake It" (level_death): tone 1500-1999 Hz, dial shifted per transmission and put back
  'test/jtcat-hunt-echocat-test.js', // Hunt filters over ECHOCAT: jtcat-hunt-filters (Guest Pass refused), hunt-filters cap, web Filters sheet
  'test/civ-pacing-test.js', // one CI-V command in flight: an Icom abandons a reply when the next command arrives (NA4DQ IC-7300 Guest Pass)
  'test/guest-pass-no-power-test.js', // Guest Pass with no power report: plain refusal to the guest's windows, owner fix line, power read after the cap (NA4DQ/KF0WWL)
  'test/civ-pacing-adaptive-test.js', // CI-V pacing engages only on an Icom seen dropping replies; Auto / Always / Never per rig
  'test/log-false-p2p-test.js', // no false park-to-park: a General contact after a POTA spot or contact carries no park (web sheet, desktop banner)
  'test/n3fjp-confirm-keep-test.js', // N3FJP pull never deletes a confirmation; eQSL and ClubLog count as confirmed
  'test/n3fjp-deleted-test.js', // a contact deleted after an N3FJP pull is not brought back by the daily re-read
  'test/kenwood-tx-latch-test.js', // a Kenwood is not latched in transmit after a hand-mic over (IF; P8 asked during TX)
  'test/civ-pacing-ptt-order-test.js', // CI-V pacing never sends TX OFF before TX ON; the newest key state wins
  'test/forced-data-no-tune-test.js', // a forced-DATA key-down sets the mode only; never a frequency write (Icom repeater memories)
  'test/rts-trial-keyed-test.js', // the RTS/CTS trial never saves a setting that keys the radio; a shorter no-answer wait
  'test/ptt-quiet-paths-test.js', // no 800 ms DATA wait on a radio that cannot confirm; hand-mic overs are not warnings; the voice hint needs our audio
  'test/qrz-late-backfill-test.js', // a late QRZ answer fills the saved record's empty fields
  'test/hunt-polish-test.js', // Hunt says who it is working; web Filters with Hunt off and for a guest; the list saved on every change; the review window closes on decline
  'test/tx-review-low-test.js', // drop detector paused in TX; Winlink re-key restarts the TX limit; full power on rigctld raw PC; multi-slice TX kind
  'test/lan-review-test.js', // VFO speaker plays LAN audio; a reopened port clears POTACAT's old close; FT-710 named; LAN scope text; LAN transport window and strangers
  'test/guest-pass-full-power-test.js', // a Guest Pass cap on a rig with Full power (W): real watts throughout; a 5 W rig transmits, a 100 W rig is capped
  'test/pacing-vs-mode-note-test.js', // a radio that drops replies gets only the pacing line; a wrong-model radio only the mode note
  'test/jtcat-tx-refused-test.js', // #190: a refused JS8 tx-start is not "fully transmitted"; FT8 refusal events identical to master; HALT never hidden by mode
  'test/run-tests-runner-test.js', // #175: this runner keeps going past a failing file, names every failure, exits non-zero
  'test/update-check-feedback-test.js', // #186: a manual Check for Updates always ends in a visible message (checking, up to date, found, or the error + download page)
  'test/tls-der-int-test.js', // ECHOCAT self-signed cert: the random serial is minimal DER (a leading 0x00 made OpenSSL reject ~1 in 512 certs)
  'test/rigctld-data-fm-test.js', // #259: DIGFM/DIGAM have rigctld tokens (PKTFM/PKTAM), so a packet key-down on FM sends the DATA mode
  'test/launcher-cert-der-test.js', // Remote Launcher cert: minimal DER serial; a saved cert that doesn't parse is regenerated
];

const root = path.join(__dirname, '..');

function runAll(list) {
  const failed = [];
  let n = 0;
  for (const f of list) {
    const r = spawnSync(process.execPath, [f], { cwd: root, stdio: 'inherit' });
    n++;
    if (r.status !== 0) {
      const why = `exit ${r.status}${r.signal ? ', ' + r.signal : ''}`;
      failed.push(`${f} (${why})`);
      console.error(`
[run-tests] FAILED: ${f} (${why}) — ${n} of ${list.length} run, continuing`);
    }
  }
  if (failed.length) {
    console.error(`
[run-tests] ${list.length - failed.length} of ${list.length} test files passed, ${failed.length} failed:`);
    for (const f of failed) console.error(`[run-tests]   ${f}`);
    process.exit(1);
  }
  console.log(`
[run-tests] all ${list.length} test files passed`);
}

module.exports = { TESTS, runAll };

if (require.main === module) {
  const only = process.argv.slice(2);
  runAll(only.length ? TESTS.filter((f) => only.some((o) => f.includes(o))) : TESTS);
}
