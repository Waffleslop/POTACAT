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
//
// 2026-11-21: the files run in parallel (every core but one; --jobs N or
// POTACAT_TEST_JOBS to change it, --jobs 1 for the old one-at-a-time run).
// Each file is still its own Node process; its output is buffered and printed
// whole when it ends. Files in SERIAL (below the list) run alone afterwards.
// `--changed [base]` runs only the tests for what changed (scripts/changed-tests.js).
// `--help` lists the options.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const TESTS = [
  'test/cw-spots-qrz-grid-test.js', // #1061: CW Spots placed by refineClusterSpotWithQrz (cache, low-priority queue, enableQrz); cached calls add no flush
  'test/syntax-check-test.js', // every source file parses (a main.js syntax error passed every other test)
  'test/icom-civ-address-learn-test.js', // sweep 3c: a USB Icom at another CI-V address is found from its own replies, used and saved
  'test/icom-usb-data-mod-test.js', // sweep 1a: over USB CI-V, DATA MOD to USB for a data session and put back (IC-7300, MK II, IC-7100, IC-7610 DATA1/2/3, IC-9700 #892 with CI-V byte tests)
  'test/icom-network-data-mod-test.js', // #853: over the network the IC-7610's LAN source follows the DATA number in use (DATA1/2/3 MOD 00 92/93/94)
  'test/icom-filter-readback-test.js', // NJ2DX 2026-11-21: an Icom's IF filter width is read back (1A 03), also right after a mode change, so the VFO shows the real width
  'test/rig-test.js',
  'test/icom-baud-list-test.js', // #238: every baud select offers 4800-115200; Icom path accepts each
  'test/cat-port-presence-test.js',
  'test/cat-connect-gate-test.js',
  'test/wsjtx-mode-notice-test.js',
  'test/guest-pass-listen-test.js',
  'test/guest-pass-state-541-test.js', // #541: a valid pass is never shown as revoked; Cloud answers, auth-fail codes, retry
  'test/guest-pass-state-step2-test.js', // #541 step 2: pass-state, four states with a reason, one wording table, the claim rule
  'test/guest-pass-owner-controls-test.js', // #200 / #541 step 3: Take the radio (Now / In 5 minutes), Give it back, Cancel pass
  'test/guest-pass-handback-test.js', // #200 / #541 step 4: after 5 idle owner minutes the guest may take the radio back; no automatic hand-back
  'test/rigctld-spawn-test.js',
  'test/rigctld-bind-test.js', // Casey 2026-11-22: POTACAT's own rigctld binds 127.0.0.1 (-T), dialled on 127.0.0.1
  'test/echocat-connect-diet-test.js',
  'test/cw-live-watchdog-test.js',
  'test/yaesu-cw-text-test.js',
  'test/cw-key-port-break-in-test.js', // #745: the CW Key Port turns BK-IN on like the CAT text path; no CAT keys as before
  'test/ftx1-cw-stuck-stop-test.js',
  'test/yaesu-audit-ft991a-test.js', // Yaesu CAT audit: FT-991A widths, AGC, ATT, PROC, power floor, CW text, RTTY-U
  'test/cw-stuck-wiring-test.js',
  'test/cw-tx-lockout-timer-test.js', // #583: the TX lockout ends when its timer fires a millisecond early
  'test/pass-radio-free-notify-test.js', // #541: the station tells Cloud the radio is free, once per idle offer
  'test/space-ptt-not-scan-test.js', // Space as Hold-a-key-to-talk never toggles scan (B9)
  'test/cw-sideband-test.js', // #753: CW or CW-R (CW-U or CW-L) per rig; Automatic is the rule before #753 on every band; one rule in lib/cw-sideband.js
  'test/rig-audio-jack-test.js', // #153: sound card on the data or mic jack, per rig: the one DATA-mode rule for every transmission
  'test/plain-ssb-for-digital-test.js', // a Winlink session keeps the data mode with JTCAT's plain-USB setting off (FTDX10 on flrig)
  'test/lz3aw-web-parity-test.js',
  'test/lz3aw-round5-test.js',
  'test/call-filter-test.js',
  'test/desktop-ux-test.js',
  'test/qso-sounds-test.js', // #1041: which sound for which contact, the milestones (1/10/25/50/100/250; 500 retired for the phone), defaults, the qso-milestone message
  'test/sound-guard-test.js', // #1041 the transmit guard: no sound on the radio's sound card, none while transmitting (held 3 s, then dropped)
  'test/sounds-pane-preview-test.js', // Settings > Sounds: Play beside the select, the Hear row, previews through the guard, never stacked (Casey 2026-11-24)
  'test/qso-sound-files-test.js', // #1041: renderer/sounds/*.wav are byte for byte what scripts/make-qso-sounds.js renders
  'test/host-port-test.js',
  'test/serial-callout-twin-test.js',
  'test/clock-offset-test.js',
  'test/require-exports-test.js',
  'test/scope-no-frames-log-test.js', // K3SBP 2026-11-21: a scope that shows nothing says so in the log (no frames vs misaligned)
  'test/cloud-signup-tidy-test.js', // ECHOCAT ask 2026-11-21: trial-first form, one tunnel label, BMAC for existing members, phone sign-up syncs
  'test/cloud-tunnel-enable-remote-test.js', // ECHOCAT ask 2026-11-21: an owner device turns the Cloud Tunnel on with Cloud access; never a Guest Pass
  'test/cloud-tunnel-auto-test.js', // ECHOCAT ask 2026-11-21: the Cloud Tunnel turns on when the account gets access; never after the operator turned it off
  'test/cloud-state-test.js', // ECHOCAT ask 2026-11-21: auth-ok carries the shack's Cloud state and cloud-state follows it; never to a Guest Pass
  'test/settings-sync-gone-test.js', // #379: the unused settings-sync wiring (cloud-get/put-settings, /v1/settings) stays removed
  'test/scan-run-test.js', // #37: a phone-started scan run on the desktop: the phone's 13 filter vectors, the desktop's exclusions, start/step/end rules, wire and glue
  'test/clock-platform-test.js', // NJ2DX 2026-11-21: each OS gets only the clock buttons it can honour; Time settings opens on a Mac
  'test/main-ismac-scope-test.js', // K3SBP 2026-11-21: isMac is not defined (opening APRS crashed); every isMac in main.js is declared in its own function
  'test/aprs-rf-phone-test.js', // ECHOCAT ask 2026-11-21: one radio beacon per press from the owner's phone; the window's gate and caps; Listen off is set up and put back
  'test/set-cw-xit-registry-test.js', // ECHOCAT 2026-11-22: the set-cw-xit registry row names value, the field the code reads
  'test/vfo-popout-70cm-test.js', // #891 NJ2DX: the VFO pop-out 70cm button sends 432 MHz, inside every 70 cm radio range (IC-9700 starts at 430)
  'test/smartsdr-meter-test.js',
  'test/smartsdr-udpport-reconnect-test.js', // K3SBP 2026-11-21: after a network drop the new Flex connection is told client udpport again (pan FFT, meters)
  'test/flex-slice-filter-test.js',
  'test/smartsdr-dax-tx-claim-test.js',
  'test/vfo-ptt-race-test.js',
  'test/park-field-length-test.js', // #507: multi-park fields fit six refs
  'test/mic-label-probe-test.js', // #743: device-name probes open the mic with voice processing off
  'test/vfo-ptt-mic-test.js', // #170: every VFO PTT press logs the mic it opened, the output and the level
  'test/vfo-audio-power-cycle-test.js', // #247: VFO window radio audio reattaches after a radio power cycle
  'test/vfo-monitor-tx-mute-test.js', // #713: VFO window radio monitor is silent while transmitting
  'test/vfo-log-spot-test.js',
  'test/vfo-wheel-direction-test.js', // #192 w0tlp: wheel up = frequency up in the VFO window
  'test/vfo-step-keys-test.js', // #256 LZ3AW / K4DZC: Step down / Step up buttons and arrow keys tune by the step (hold repeats), never while typing, lock kept; main-window arrows stay on spots
  'test/vfo-tx-power-test.js', // #199 w0tlp: TX power slider in the VFO window, the Rig panel's caps and dispatcher
  'test/smartsdr-self-slice-test.js',
  'test/bundle-mac-deps-test.js',
  'test/rig-controls-test.js',
  'test/rig-gain-steps-test.js',
  'test/rig-family-test.js',
  'test/tci-rig-test.js', // #195 (w5lee #632): Zeus / Thetis TCI link against a fake server; receive and control only
  'test/tci-gating-test.js', // #195: TCI branches gated on the TCI rig; every TX entry point refuses it
  'test/tci-audio-test.js', // #195: TCI RX1 audio into JTCAT, the VFO monitor and ECHOCAT
  'test/tci-scope-test.js', // #195: the band scope from a TCI server's float32 IQ
  'test/tci-tx-safety-test.js', // #195 #185: TCI transmit rules against a fake Zeus and Thetis (release, stall, cap, DIGU, Thetis RX-only)
  'test/tci-tx-wiring-test.js', // #195: JTCAT and ECHOCAT voice reach TCI transmit only through the existing guards
  'test/rigctld-attribution-test.js',
  'test/flrig-codec-test.js',
  'test/cw-text-unsupported-link-test.js',
  'test/cw-text-fallback-test.js',
  'test/cw-key-both-lines-test.js',
  'test/rigctld-crash-not-rf-505-test.js',
  'test/dxcluster-login-test.js',
  'test/dxcluster-backoff-test.js',
  'test/audio-backpressure-test.js',
  'test/spot-mute-rules-test.js',
  'test/spot-filter-presets-test.js',
  'test/websdr-test.js',
  'test/jtcat-websdr-source-test.js', // #243: JTCAT decodes from the WebSDR: source switch, dial follow, TX refused, 12 kHz resampler
  'test/ragchew-test.js',
  'test/echocat-protocol.test.js',
  'test/protocol-demux-parity-test.js',
  'test/jtcat-test.js',
  'test/jtcat-qso-view-test.js',     // #807: an older phone sees the RR73 step only once the QSO is logged
  'test/jtcat-parser-test.js',
  'test/jtcat-qso-card-test.js',     // QSO logged is a centred card in theme colours
  'test/ft8-engine-rebaseline-test.js',
  'test/guest-pass-test.js',
  'test/pass-code-log-test.js',
  'test/guest-pass-onair-call-test.js', // the pass's station call is the on-air call (K3SBP on W7RTA's pass)
  'test/guest-pass-lease-end-test.js', // the end of a pass stops every transmitter and closes the guest socket
  'test/guest-pass-hopping-test.js', // guests hop between rigs; the owner takes over and hands back
  'test/pass-guest-activity-test.js', // the take-over dialog learns whether the guest is connected and when they last used the radio
  'test/pass-list-used-by-test.js', // #1003 the Guest Pass list says guests have used the pass, not connected now
  'test/guest-sdr-test.js', // #543: a guest uses the station's own SDRs; a typed-in host and SDR settings writes are refused in words
  'test/guest-settings-secrets-test.js', // a guest never receives the station's SDR passwords or other settings secrets; refusals in plain words
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
  'test/sstv-tx-power-test.js', // #279: Transmit power for SSTV, set before a picture and put back after it, every way it ends
  'test/sstv-start-band-test.js', // #292: SSTV never tunes a radio to a band it is not set up for
  'test/sstv-quiet-wait-test.js', // #326: SSTV waits for a quiet frequency: busy waits, quiet sends, Send now, Cancel, the 4-minute give-up, off by default, the phone path, wiring
  'test/sstv-echocat-send-test.js', // #357: a picture from ECHOCAT: its own copy for the encoder, a status line not a dialog, tuned before it keys
  'test/sstv-freq-box-test.js', // #359: the frequency box is not overwritten while typing; kHz or MHz; FM from 2 m up
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
  'test/remote-scope-freq-test.js',
  'test/protocol-registration-test.js',
  'test/vara-mac-guide-link-test.js',
  'test/modem-rx-level-test.js',
  'test/watchlist-groups-test.js',
  'test/cert-san-policy-test.js',
  'test/merge-latest-mac-test.js',
  'test/lan-advertise-test.js',
  'test/custom-cat-parity-test.js',
  'test/vfo-custom-cat-slider-test.js', // #526: a custom CAT slider in the VFO window stays where it is dragged; no rebuild per push
  'test/custom-cat-25-test.js', // #164: up to 25 custom CAT buttons, no padding, a button may belong to some radios; one filter on every surface and in the reader
  'test/custom-cat-read-test.js', // #242: a custom toggle's own read command + ON-when rule; unknown, not OFF, when unread; no read during TX
  'test/worked-qsos-chunk-test.js',
  'test/worked-incremental-test.js', // #731: a worked-incremental client gets the full worked list once per connection, not after every QSO; ECHOCAT Web merges qso-added with the full list's entry rule
  'test/web-log-form-test.js',
  'test/bug-report-log-test.js',
  'test/audio-capture-device-test.js',
  'test/audio-settings-path-test.js', // #820: audio errors name Settings > Radio, Edit the rig, Audio Devices (labels that exist), never My Rigs > Audio
  'test/settings-path-test.js', // #827: no message names My Rigs; every Settings > X names a tab, a section on it, or a rig-editor label that exists
  'test/ft8-message-buffer-test.js',
  'test/ft8-native-decoder-test.js',
  'test/jtcat-hunt-off-test.js',
  'test/halt-tx-test.js',
  'test/refused-key-audio-test.js', // #214: a refused key-down plays no radio audio (Tune, SSTV, voice macro); a Tune stop during start-up wins
  'test/own-licence-tx-test.js',
  'test/guest-pass-owner-class-test.js',
  'test/privileges-one-source-test.js', // #250: lib/privileges.js is the one table (renderer loads it); unverified classes never refuse TX; no change vs master
  'test/privileges-verified-gate-test.js', // #250: the ATU wizard and Guest Pass never refuse for an unverified licence class
  'test/rigctld-power-scale-test.js',
  'test/rigctld-yaesu-power-read-test.js', // a Yaesu on rigctld reads its power with w PC; (#656); non-Yaesu rigs still send l RFPOWER
  'test/rigctld-kenwood-power-test.js', // a TS-590/TS-2000 behind Hamlib keeps its power: raw PC, never Hamlib's PC000/PC255 probe
  'test/jtcat-tx-watchdog-test.js',
  'test/jtcat-calling-time-test.js',
  'test/jtcat-run-refusal-test.js', // #1085: a refused Run keeps Run visible with the shack's reason, one sentence per cause, TX left off
  'test/jtcat-session-limit-test.js', // "Stop Run and Hunt after N minutes" (W5XY): off by default, waits for a contact in progress, no new CQ/call after, phone-started enforced in main
  'test/jtcat-replace-log-test.js',
  'test/jtcat-second-caller-test.js',
  'test/jtcat-quiet-freq-test.js', // CQ quiet frequency: main measures the engine audio while no waterfall draws (one rule, lib/jtcat-quiet-freq.js)
  'test/jtcat-auto-tone-passband-test.js', // #1032: the automatic CQ tone stays in 500..2400 Hz (inside every common DATA-mode TX filter); an operator's tone is never bounded
  'test/port-picker-test.js',
  'test/pota-parks-db-test.js',
  'test/elecraft-data-mode-test.js',
  'test/elecraft-atu-tune-test.js', // Elecraft tunes with SWT (K3 19, KX3 44, KX2 20 by OM;), never AC
  'test/ts590-atu-ac111-test.js', // TS-590S/SG starts a tune with AC111; per its PC command guide (VA2PSL #635); other Kenwoods keep AC011;
  'test/ft2000-atu-cmd-test.js', // #990: FT-2000 tune is AC002; per its CAT reference p. 5, not the Kenwood AC011;
  'test/ft950-model-test.js', // #1059: FT-950 model (FTDX3000 settings, AC002;, 5-100 W, HF+6 m)
  'test/freedv-spot-merge-test.js', // #742: one row per FreeDV station across PSKReporter + FreeDV Reporter; departed stations leave; rows keyed by mode too
  'test/freedv-display-mode-test.js', // #716: RADE, not DIGU/PKTUSB, on every surface while FreeDV runs
  'test/echocat-web-data-mode-test.js', // DIGU / DIGL in ECHOCAT Web's mode picker for radios that have them (lib/data-mode-picker.js)
  'test/vfo-ptt-row-test.js', // #190: ECHOCAT Web VFO-tab PTT row shows while the mode is unknown; hidden in CW/data
  'test/ws-liveness-test.js', // ECHOCAT Web: reconnect when no pong comes back or the screen wakes on a dead socket
  'test/ptt-release-test.js', // ECHOCAT Web: PTT lets go on blur/hidden/cancel, Space up with a box focused, and resends off after a reconnect (#935)
  'test/ws-limits-test.js', // ECHOCAT: 16 MiB maxPayload, a frame over 64 KiB before sign-in closes the socket unparsed (1009), sstv-photo over 4 MiB refused with sstv-tx-status error and never encoded
  'test/remote-origin-security-test.js', // ECHOCAT: foreign page Origin refused on LAN sockets, /api/ptt cross-site refused with no ACAO, device-writable settings allowlist, public source needs the token, directory cards escaped
  'test/ptt-api-plain-http-test.js', // /api/ptt on the plain-HTTP fallback: keying needs the ECHOCAT password, release always works, HTTPS unchanged, local usage stamp (lib/ptt-api-gate.js, lib/ptt-api-usage.js)
  'test/ptt-client-id-test.js', // #941: a reconnecting ECHOCAT Web page releases PTT its own dead socket holds; another id or none never does
  'test/error-banner-text-test.js', // #806: ECHOCAT Web error banner shows the message on iPhone Safari (stack has no message there)
  'test/freedv-diag-test.js', // #717: FreeDV audio in, sync on/off and capture failures in the session log, rate-limited
  'test/freedv-mac-mic-test.js', // #718: FreeDV capture runs the macOS microphone check and a 10 s silence watch, the shared rule
  'test/freedv-stop-during-open-test.js', // #905: a FreeDV stop during the capture open wins: the late stream is stopped and nothing is kept
  'test/freedv-ptt-refusal-test.js', // FDV1: voice PTT refused in FreeDV modes until FreeDV transmit exists; one sentence on every surface
  'test/freedv-echocat-test.js', // FDV1: decoded FreeDV speech on the ECHOCAT track, freedv-status, protocol drift fixed (agreed with ECHOCAT)
  'test/kenwood-filter-width-test.js',
  'test/cw-key-port-race-test.js',
  'test/guest-pass-emission-test.js',
  'test/guest-pass-sstv-phone-test.js',
  'test/jtcat-worked-update-test.js',
  'test/g90-tx-poll-test.js',
  'test/g90-fake-rigctld-test.js', // #109: a fake rigctld that dies on CAT in TX; the G90 keeps the link through an over, a generic model's reconnect unkeys first
  'test/g90-mode-on-spot-test.js', // #916: a spot click sets the G90's mode with Hamlib's M only, never a raw CI-V 06 frame; the raw-frame drop guard stays generic
  'test/wfm-mode-test.js',
  'test/jtcat-dial-follow-test.js',
  'test/js8-dial-follow-test.js',
  'test/winlink-fault-test.js',
  'test/direwolf-agw-probe-test.js',
  'test/ptt-cat-line-test.js',
  'test/rigctld-link-hints-test.js',
  'test/serial-cat-test-connection-test.js',
  'test/cat-test-kills-rigctld-test.js', // every serial Test Connection stops rigctld and waits before opening the port (#910)
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
  'test/qrz-detail-parse-test.js', // Contact details (Jump 2026-11-23): QRZ address, photo, QSL flags, class, aliases, time zone parsed from a fixture; older cached records refreshed once
  'test/contact-card-test.js', // Contact details: view model (worked/confirmed line, SP/LP bearing, distance in the operator's units, local time, address, missing fields hidden)
  'test/contact-weather-test.js', // Contact details: Open-Meteo weather at the grid-square centre, 30 min cache per square, stubbed fetch
  'test/contact-card-wiring-test.js', // Contact details: Logbook row Details and Log QSO Details open one themed window by call + QSO identity; it never writes the log
  'test/prefix-overlay-test.js',
  'test/dxpedition-dials-test.js',
  'test/renderer-global-api-test.js',
  'test/heard-grids-test.js',
  'test/jtcat-rr73-click-log-test.js', // #1060: a click on their RR73 while busy with another station or CQ logs with the reports exchanged earlier; none on record = not logged, with a notice
  'test/idle-rx-watching-test.js',
  'test/jtcat-picker-test.js',
  // Run by CI's test.yml but missing here until 2026-11-02 (a CI-only failure slipped past the local suite):
  'test/contest-history-test.js',
  'test/cw-key-line-test.js',
  'test/cw-paddle-availability-test.js',
  'test/cw-paddle-hint-test.js', // KX2/KX3: the paddle hint names Elecraft's menus, not Yaesu's
  'test/event-banner-pick-test.js',
  'test/event-decode-match-test.js',
  'test/event-geo-test.js',
  'test/event-progress-test.js',
  'test/event-registry-test.js',
  'test/events-catalog-test.js',
  'test/event-phone-sync-test.js', // #1030: event tracking changes reach the phone
  'test/hunted-park-test.js',
  'test/nfer-refs-test.js', // an n-fer's other parks, read from the activator's own spot comment (#353)
  'test/js8-audio-feed-test.js',
  'test/aprs-parser-test.js', // APRS phase 1: TNC2 lines (positions, compressed, Mic-E, objects, items, status, messages, weather, third party)
  'test/aprs-is-feed-test.js', // APRS phase 1: read-only APRS-IS feed (login -1, range filter, framing, keep-alive, backoff, stop)
  'test/aprs-stations-test.js', // APRS phase 1: the window's station list (distance, bearing, 60-minute age-out, sort, search, list window)
  'test/aprs-symbols-test.js', // APRS phase 1: symbol table and code to the nine map icons
  'test/aprs-map-test.js', // APRS phase 1: map clusterer, marker glide and fade
  'test/direwolf-aprs-config-test.js', // APRS phase 2: Dire Wolf's APRS config is MODEM 1200 with no PTT; the Winlink config is byte-identical
  'test/aprs-rf-frequency-test.js', // APRS phase 2: the 2 m APRS frequency by grid square, each entry from a published band plan
  'test/aprs-radio-return-test.js', // APRS phase 2: the radio goes back on stop, after a crash and after a quit
  'test/aprs-listen-test.js', // APRS phase 2: the refusal sentences, the packet mode, and the main.js wiring (receive only)
  'test/aprs-rx-filter-test.js', // #840: 30 m listening widens a narrow Flex receive filter to pass 1450-1950 Hz and puts it back (fake Flex left narrow); RIT warned, never changed
  'test/aprs-beacon-tx-readback-test.js', // #856: the radio beacon hears the radio's TX readback while POTACAT holds PTT (IC-7300 over CI-V), not only TX-state changes
  'test/aprs-listen-moved-test.js', // APRS listening pauses when the radio moves off the APRS frequency (any cause), the return is dropped; the once-a-minute audio line
  'test/aprs-auto-listen-test.js', // APRS window: listen on open (receive only), once per open, every switch refusal plus TX / JTCAT QSO / owner / Guest Pass, off stays off
  'test/aprs-start-stops-ft8-test.js', // APRS Start with FT8 decoding: halts JTCAT TX, stops FT8 the SSTV way, says so; automatic starts and guests keep the refusal
  'test/tune-link-pending-test.js', // a potacat://tune link that launches POTACAT waits for the radio (link up + a readback), tunes once; 60 s then a notice; only the latest link counts
  'test/radio-tune-route-test.js', // the one "radio reachable for tuning" decision: TCI, Flex Direct, CAT (APRS on a FLEX-8600M, 2026-11-18)
  'test/aprs-window-test.js', // APRS window layout: status cards (no heading), timer banner only with an interval, on-air banner only while keyed + Stop = the close abort, one-click beacon buttons, TX power -/+, two-line stations, "Within" in round units -> whole km, one-time range conversion
  'test/aprs-show-last-test.js', // APRS window: "Show the last" 15 min to 6 h (per profile, list and map), the 6 h store with a row cap, two-step age fading (ring at full colour), Clear local to the window (no IPC, ECHOCAT untouched)
  'test/aprs-rf-frames-test.js', // APRS phase 2: recorded Dire Wolf AGW frames -> APRS packets, direct or via a digipeater
  'test/aprs-rf-merge-test.js', // APRS phase 2: a station heard on the radio and on APRS-IS is one row with both marks
  'test/direwolf-aprs-hf-config-test.js', // APRS phase 3: the 30 m receive config is MODEM 300 1600:1800 A- 9@30 (the beacon keeps 7@30) with no PTT; 2 m and Winlink configs byte-identical
  'test/direwolf-aprs-hf-decode-test.js', // APRS phase 3: generated 300-baud AFSK decoded by the bundled Dire Wolf, on tune and 70 Hz off (skips without the build)
  'test/aprs-passcode-test.js', // APRS phase 4: the APRS-IS passcode against published callsign/passcode pairs
  'test/aprs-igate-test.js', // APRS phase 4: the receive-only iGate's rules, one test each (aprs-is.net IGating, q construct, dupes, login)
  'test/aprs-is-uplink-test.js', // APRS phase 4: the one APRS-IS uplink against a local fake server (verified only, keep-alive, reconnect)
  'test/aprs-idle-igate-wiring-test.js', // APRS phase 4: the APRS idle mode and the iGate wiring in main.js and Settings
  'test/aprs-beacon-test.js', // APRS phase 5: the beacon packet, approximate position, symbols, comment, the 10 min timer floor, refusals
  'test/aprs-beacon-wiring-test.js', // APRS phase 5: the beacon end to end against a local fake APRS-IS server, and its wiring
  'test/aprs-position-ambiguity-test.js', // APRS "Near my home (about 1 mile)": position ambiguity (minutes cut, both lat and lon), home = point/GPS/grid, the default and migration rule, what goes out at each precision, the marker label, the map's saved view and Home button
  'test/flex-gps-test.js', // the radio's GPS: the gps status parser (# pairs, spaces, deltas), the fix rule, the APRS position source (no fix = refusal, never 0,0)
  'test/smartsdr-gps-test.js', // the radio's GPS: one sub gps all per connection, a gps event per change, never a set
  'test/flex-gps-wiring-test.js', // the radio's GPS: both beacons ask one provider; Settings offers the GPS grid, never sets it
  'test/afsk-demod-test.js', // APRS phase 9 core: our own AFSK demodulator (1200 and 300 baud, offsets, noise floors, FCS, stuffing, real 30 m frames, CPU)
  'test/aprs-activation-test.js', // APRS extra 1: the activation (park, frequency, mode) in the beacon comment, within 43 characters, off by default
  'test/aprs-rf-gate-test.js', // APRS phase 7: the gate for a beacon over the radio, each refusal (window, listen, callsign, dial match, owner, PTT, in flight)
  'test/aprs-rf-beacon-test.js', // APRS phase 7: the RF packet and path per band, the per-transmission cap, the run against a fake shim and Dire Wolf
  'test/aprs-rf-beacon-wiring-test.js', // APRS phase 7: one click sends (no confirm step), no RF timer, unkey on window close / stop / TX limit, power never changed
  'test/aprs-rf-one-click-test.js', // APRS window: one-click radio beacon (button shows band/freq/power first, second click ignored), meters, TX power via set-tx-power, My APRS SSID
  'test/aprs-30m-tx-passband-test.js', // APRS 30 m beacon: a Flex's TX filter narrowed to 1400-2000 Hz for the beacon (inside 10.150 MHz) and put back on every way out; 2 m and other radios untouched
  'test/direwolf-aprs-tx-config-test.js', // APRS phase 7: the transmit config (PTT via the shim, channel access per band); listen and Winlink configs byte-identical
  'test/direwolf-aprs-tx-offline-test.js', // APRS phase 7: the bundled Dire Wolf keys a fake shim once and its audio decodes back (skips without the build)
  'test/aprs-echocat-test.js', // APRS phase 6: ECHOCAT devices: snapshot, 1.5 s deltas, feed and listen ownership, Guest Pass, aprs-state
  'test/aprs-heard-you-test.js', // ECHOCAT 2026-11-22: who heard my radio beacon (q construct, digis, 15-min feed watch, heardMe rows, beacon.rf.heard, window mark)
  'test/aprs-view-test.js', // ECHOCAT 2026-11-22: Map view (aprs-view area filter, antimeridian, 4000 km cap, per-device areas, feed.area)
  'test/aprs-find-band-test.js', // ECHOCAT 2026-11-21: rf.band on aprs-stations rows, aprs-find (follow one call beyond range, budlist, validated, guest allowed)
  'test/aprs-echocat-wire-test.js', // APRS phase 6: the 'aprs' capability on the wire (old clients untouched), guest refusals, main.js glue, ECHOCAT Web
  'test/aprs-message-test.js', // APRS A1: message, ack, rej and reply-ack formats (APRS 1.0.1 ch. 14), the 67-character limit, ours by SSID, the g/ filter
  'test/aprs-messenger-test.js', // APRS A1: retries 30 s/60 s/120 s/5 min (5 tries), stop on ack/rej/Stop, acks owed, 30 s duplicates, unread, bounds, the saved file
  'test/aprs-templates-test.js', // APRS A2: message templates: each built-in's fill and 67-character fit, activation/radio fields, the held-back gateways, my templates' round trip
  'test/aprs-templates-wiring-test.js', // APRS A2: templates as wired in main.js (context, per-profile list), the preload and the Messages view (nothing sends until Send)
  'test/aprs-messages-wiring-test.js', // APRS A1: messages end to end against a fake APRS-IS server, and the main.js/preload/window wiring (internet only)
  'test/aprs-rf-message-test.js', // APRS A3: messages over the radio: one press per try (automatic retries and radio acks only with their default-off settings, 2 m only), refusals in plain words, heard on radio, the frame and cap, end to end through the radio run and gate on a fake shim
  'test/aprs-rf-timer-test.js', // APRS: the timed radio beacon, 2 m only, off by default, 10 min floor, never on a pick or open, a skipped round waits a full interval, the same gate as the click
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
  'test/jtcat-spectrum-resume-test.js', // #943: an engine restart (band/mode change) resumes the phone's FT8 waterfall feed
  'test/rx-spectrum-test.js', // the phone's VFO waterfall with no FT8 engine: Flex/Icom streams, the rig's sound card
  'test/ft4222-library-test.js', // #360: FTDI's LibFT4222 names per platform (versioned Mac dylib + libftd2xx), Setup's copy plan, Mach-O archs, the loader's reason in Mac words
  'test/yaesu-scope-test.js', // the FT-710's own scope: frame parser, axis, helper exit codes, remote payload guard (was CI-only)
  'test/k4-pan-test.js', // #396: the Elecraft K4's network panadapter (PAN 0x02): header, dBm, 850 points, fixed axis, wiring
  'test/kenwood-scope-test.js', // #397: the TS-890S bandscope over USB/COM (DD0 5 -> DD4): lines, sweeps, axis, AI/DD0 read-first and put back, 115200, poll not disturbed
  'test/flex-scope-test.js', // the Flex's own panadapter as the band scope (Flex Direct), against a real 8600 capture
  'test/scope-digital-view-test.js', // the scope's tight view on a digital mode's decode window (Flex)
  'test/winlink-pan-view-test.js', // 2026-11-15 ECHOCAT ask: the Flex pan centres on the Winlink channel (USB, LSB, DIGU offset), 6 kHz, during a session or a device's ask; the operator zoom comes back
  'test/scope-watchers-test.js', // #358: each remote device watching the scope is counted; one leaving does not stop the others
  'test/sdr-failure-test.js', // #390: a WebSDR that would not come on says why in the VFO window, with Try again
  'test/kiwisdr-tls-test.js', // KiwiSDR with HTTPS on: https:// entries and a wss:// retry (DL0HC)
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
  'test/vfo-gain-steps-test.js', // #997: VFO window Preamp/Att step through the radio's ladder (FTX-1 AMP2, Att 12/18 dB)
  'test/split-up-test.js', // #689: Split up N from the VFO window and ECHOCAT Web (TX = RX + N, lock, caps)
  'test/vfo-freq-entry-test.js', // #672: the Small VFO's frequency is typed in place, a click grows to the keypad; Enter never tunes a hidden buffer
  'test/main-window-layout-fixes-test.js', // #285 Log button "L", #284 HF Nets check mark, #298 HOLD TO TALK off screen
  'test/status-bar-wrap-test.js', // spot count ran off a narrow window
  'test/wd3d-activator-test.js', // WD3D: toolbar wraps at full screen; a two-fer/n-fer spot fills every P2P park
  'test/wspr-run-time-test.js', // WSPR beacon runs as long as the operator sets (K2BDE); a PTT port keys on RTS by default (K5LEB)
  'test/remote-client-yield-test.js', // a desktop kicked by another of the owner's devices yields the rig (W0EGR)
  'test/remote-spots-one-writer-test.js', // #246: a remote PC's spot list has one writer (the shack's while linked)
  'test/favorites-test.js', // #329: starred Landmarks and Channels, per operator, in Directory, the VFO window, the band scope and ECHOCAT
  'test/icom-scope-test.js', // an Icom's own band scope over CI-V: parser, codec events, the owner's 30 s recording
  'test/adif-import-refs-test.js', // POTA_REF-only logs (QLog) get SIG/SIG_INFO on import; the Logbook shows them (KC9FOZ)
  'test/icom-lan-voice-test.js', // voice over an Icom's LAN: DATA mode, or USB/LSB when DATA OFF MOD = LAN (EA1BZN)
  'test/settings-file-test.js', // settings written via temp+rename with a .bak; a truncated file is restored, never read as a fresh install
  'test/profile-switch-guard-test.js', // #344: no settings save between an operator switch and the restart; the new operator keeps its own callsign, log and Cloud sign-in
  'test/rig-list-lost-test.js', // #314: moving the operator pointer keeps the rig list; a catTarget becomes a rig only from a file with no rig list, and the log says so
  'test/wsjtx-qdatetime-test.js', // QSO Logged dates are valid UTC; an invalid one never goes out as 1899 (ik4idf Logger32); comments capped at 50 UTF-8 bytes for Logger32, cut between characters (#520, #754)
  'test/kg4-us-calls-test.js', // #342 KG4 + two letters is Guantanamo, else US
  'test/dxcc-entity-prefix-test.js', // #522 KL7 is Alaska, KH8 American Samoa, 6W/IK2HKT Senegal with CALL whole; cty.dat's entity beats QRZ's country
  'test/operating-entity-test.js', // W1AW/KL7 is Alaska; the log takes QRZ's DXCC entity, not its mailing country
  'test/hound-log-call-test.js', // a hound calls the fox's base call but logs the full call (level_death 6W/IK2HKT)
  'test/jtcat-hound-chip-test.js', // #160: HOUND chip is a two-way toggle on the main screen
  'test/jtcat-waterfall-off-test.js', // #391: Show the audio waterfall (off hides the pane and stops drawing; decoding unaffected)
  'test/qrz-login-message-test.js', // Settings > Logging QRZ line: signed in vs no subscription vs bad password (K0DHW)
  'test/voice-tx-check-test.js', // 0 W / no ALC on a voice over: one hint naming the radio's audio-input menu
  'test/rig-test-saved-note-test.js', // a passing rig-editor Test says when its port is not saved yet
  'test/serial-reopen-test.js', // connectCat waits for the old port's release; Access denied on our own handle says so (KK6EZA)
  'test/serial-close-blocked-cts-test.js', // RTS/CTS write stuck on CTS: flush before close, bounded close, None keeps the close (#174)
  'test/yaesu-lines-low-test.js', // every Yaesu drops DTR/RTS at open (stein, G5HOW: keyed on connect)
  'test/yaesu-po-meter-test.js', // FT-710/FTDX10/FTDX101 read forward power on RM5; no false 'no CAT during TX' line (#581)
  'test/ftdx101-d-mp-split-test.js', // FTDX101D (100 W) and FTDX101MP (200 W) rows; saved FTDX101D/MP migrates to the D; ID; 0681/0682 (#744)
  'test/ftdx5000-power-scale-test.js', // FTDX5000 PC is 000-255, not watts (nicki3fiy 254 W)
  'test/yaesu-audit-ftdx10-test.js', // Yaesu CAT audit: FTDX10 width SH00nn + Table 3, AGC GT0 order, MD0 9/E/F, PC 5-100 (2308-F)
  'test/yaesu-audit-ftdx101-test.js', // Yaesu CAT audit: FTDX101 width SH00nn + its Table 3, AGC GT0 order, MD0 9/E/F, PC from 5 (2308-L)
  'test/yaesu-sd-break-in-delay-test.js', // Yaesu CAT audit: FT-710/FTDX10/FTDX101 SD is a two-digit index 00-33, sent and read
  'test/tx-audio-input-test.js', // TS-480/590/890/990 transmit audio input per rig; TS-480 asks on first transmit (#594)
  'test/ft891-tx-audio-input-test.js', // FT-891 transmit audio input per rig: MIC SELECT / DATA IN SELECT set while connected, put back after (#602)
  'test/tx-channel-test.js', // transmit on left only or both channels, per rig: modem bridge, FT8, Tune (#654)
  'test/rig-list-a11y-test.js', // #603: every rig-list control names its rig for VoiceOver
  'test/split-first-tune-test.js', // #113 item 2: no split OFF unless POTACAT turned split on
  'test/waterfall-palettes-test.js', // waterfall / band scope palettes = the ECHOCAT app's, wired into every waterfall
  'test/scope-view-test.js', // the scope's shared ticks + trace painter (every surface), the synced tuning step
  'test/scope-overlay-test.js', // the scope's passband, split TX marker and band plan (Phase 3)
  'test/flex-readback-test.js', // a Flex's controls read back from the radio's own status (real 8600 capture)
  'test/scope-pan-device-test.js', // FT-710 zoom + CENTER over CAT, band scope frames sized and paced per device
  'test/remote-scope-bins-test.js', // #772: the desktop remote asks the shack for 850-point scope frames, the only size its scope window draws
  'test/gpu-status-test.js', // #773: the GPU / WebGL2 state in the session log at startup, and the scope window's no-WebGL2 line
  'test/remote-shack-grid-test.js', // #774: a remote desktop's JTCAT map centres on the shack's grid (auth-ok settings.grid), its own otherwise
  'test/payload-field-sizes-test.js', // #776: at connect each ECHOCAT push line names its total and five largest fields in KB
  'test/gridtracker-roster-test.js', // GridTracker as JTCAT's call roster: decodes out, its double-click and stop back in
  'test/popout-theme-test.js', // every pop-out follows a theme change, from the quick toggle or Settings
  'test/vfo-voice-macros-test.js', // the VFO window's voice macro bar follows renames and recordings
  'test/jtcat-remote-anchor-test.js',
  'test/rsba1-transport.test.js',
  'test/activation-log-test.js',
  'test/activation-program-test.js',
  'test/adif-mode-test.js', // #381: MFSK submodes (JS8, JTTY, FT4, FT2) read by name everywhere
  'test/adif-ft4-mfsk-test.js', // #381: FT4/FT2 written as MFSK + SUBMODE; old records read both ways, LoTW batch + ADIF export copies mapped
  'test/qso-edit-test.js', // #509: My Park edit sets MY_SIG so Past Activations finds the QSO
  'test/activation-auto-end-test.js', // #147: a forgotten activation ends at the UTC day change or after 6 h with no contacts
  'test/activation-tune-ask-test.js', // #146: a device's activation start asks before the radio moves, never retunes silently
  'test/activation-relaunch-700-test.js', // #700: a saved activation clock that ran out while POTACAT was closed ends the activation at launch, not 33 s later
  'test/activation-device-ref-00z-test.js', // #734: the phone's own park is kept on a QSO that arrives after the desktop's activation ended (00Z)
  'test/activation-logging-388-test.js', // #388: a habit Tab after the RST jump is absorbed; a corrected park grid is kept per park
  'test/activation-announce-508-test.js', // #508: QSOs from the Log window (and ECHOCAT) join the live activation list, once
  'test/state-backfill-test.js', // #389: QRZ state fill counts only tracked entities (never VK) and names the QSOs left
  'test/diagnostic-snapshot-test.js',
  'test/mercury-process-test.js',
  'test/mercury-offer-test.js', // Mercury experimental: no 2750 bandwidth; the chat window hidden until on-air use (Casey 2026-11-22)
  'test/winlink-pat-test.js',
  'test/winlink-own-modem-test.js', // 2026-11-22 community-modem gateways (DATA2G and the like) after the standard rows, under their own heading
  'test/winlink-list-refresh-test.js', // the gateway list downloads again on Refresh and daily; Other service codes (plan docs/winlink-custom-gateways-plan.md 1-2)
  'test/winlink-reach-test.js',      // a radio session goes only where this radio can transmit
  'test/winlink-units-test.js',
  'test/winlink-spectrum-test.js',
  'test/winlink-wf-audio-test.js', // the Winlink waterfall says why it is black (no radio audio reaching POTACAT)
  'test/winlink-main-wiring-test.js',
  'test/winlink-vara-test.js',
  'test/vara-dial-test.js', // the first VARA call after a start: a dial VARA refused is placed again while nothing was keyed, never read as 'did not answer'; a box set to the radio's own sound card is not a virtual cable
  'test/winlink-vara-anywhere-test.js', // #287: VARA HF and VARA FM on Linux, macOS and Windows, at a host and port; a fake VARA TNC (real Pat when its binary is present)
  'test/winlink-connect-test.js', // #128: /api/connect over http.request with no headers timeout; VARA and ARDOP send the same request
  'test/direwolf-skipped-path-log-test.js', // #1031: a configured winlinkDirewolfPath that is missing or not executable is named in the log
  'test/direwolf-agw-monitor-test.js', // #128: what Dire Wolf heard, over its AGW port's monitor mode
  'test/packet-link-close-test.js', // #300: a packet link is closed (DISC answered) before Dire Wolf stops; a call on a link the gateway still holds is ended, not retried
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
  'test/winlink-my-gateways-test.js', // #585: Add a gateway: the form's checks, the dial from the centre, Mine entries (note, via, ARDOP bandwidth), Edit and Remove, their own group in the list
  'test/winlink-mine-web-test.js', // #585 phase 4: My own gateways in ECHOCAT Web (Add a gateway, Edit, Remove), the winlink-mine capability and the older-shack line, the shack's own check, Guest Pass refused
  'test/winlink-history-test.js', // #254: gateway history from Pat's event log, My gateways (saved gateways)
  'test/winlink-outcome-test.js', // #425: how a session ended is worded in one place; Pat's reply never reaches a status; one summary line per session
  'test/winlink-pat-recover-test.js', // #430: after an Abort, Connect restarts a Pat that is stuck on the last call; a session never starts on top of a dial (VARA)
  'test/winlink-auto-retry-test.js', // #425: one automatic retry after a dropped link, never after no answer or Abort; countdown, channel check, Cancel
  'test/winlink-arq-timeout-test.js', // #425: the ARDOP link timeout is a setting; it reaches our Pat build through the environment; the summary says the value in force
  'test/winlink-forms-gate-test.js', // #346 phase 0: forms only on Pat 1.0.1 or newer (v1.0.0 serves form pages same-origin with its unauthenticated API); bundled Pat and Go pins
  'test/winlink-forms-test.js', // #346 phase 1: Pat's form catalog, a filled form to compose and the Outbox with Pat's forminstance cookie, View form; the form window locked down (requests, navigation, permissions, geolocation from the grid); a real offline Pat when present
  'test/winlink-gpsd-test.js', // #346: forms' position is the Settings grid's centre, from a GPSd stand-in on 127.0.0.1 (Pat reads GPSd only); no grid, no fix; a real offline Pat when present
  'test/winlink-forms-reply-test.js', // #346 phase 2: Reply with form: the reply form named in the received form's XML, opened pre-linked (Pat's in-reply-to, path-checked in 1.0.1), its own XML on the reply; a real offline Pat when present
  'test/winlink-catalog-test.js', // Winlink catalog requests: the starter list, reading Winlink's LIST reply (hand-written fixture and hostile variants), search, grouping, the request messages (at most 10 IDs each), size advice, picks, every sentence
  'test/winlink-catalog-glue-test.js', // Winlink catalog: main.js's catalog functions lifted out and RUN with stand-ins for Pat, settings and the file write (which Outbox message is ours, no second LIST, an old catalog while pending, a stale Sent list, a failed save, an offer arriving during Use it, over 200 through the bridge)
  'test/winlink-catalog-wiring-test.js', // Winlink catalog: the panel, preload and main.js glue; one send path, no connect, the Inbox message never changed, no innerHTML with catalog text; the remote link's wire messages
  'test/winlink-contacts-test.js', // the Winlink address book, and the Position report and POTA spot forms
  'test/winlink-sent-routes-test.js', // #442: how each sent message went out (gateway, dial, mode or internet, time), kept by message id
  'test/winlink-summary-store-test.js', // #425: the session summary lines survive a restart, so Report a Bug still holds the session that dropped
  'test/winlink-mail-select-test.js', // #346: select several Winlink messages and delete them with one confirm
  'test/winlink-folders-test.js', // #462 #475: Archive and back, the Deleted folder (copies, Restore, purge after N days), Reply all; a real Pat when present
  'test/winlink-mode-note-test.js',
  'test/winlink-mail-views-test.js', // 2026-11-15 ECHOCAT ask: the dial stays on the gateway while a phone's Mail tab is open; two devices, the window and a phone, a closed socket
  'test/winlink-tx-level-test.js', // #300: Winlink's own TX level; the summary says the RX peak and what our overs sent; the pause between overs is not a gap
  'test/rigctld-shim-hamlib-test.js',
  'test/rigctld-died-test.js',
  'test/interface-ptt-test.js',
  'test/dial-snap-test.js',
  'test/web-ft8-running-test.js',
  'test/jtcat-band-pick-test.js',
  'test/jtcat-spot-restarts-stopped-test.js',
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
  'test/mac-mic-access-test.js', // #463: a Mac that refuses the microphone is named, logged and in Report a Bug
  'test/rx-direct-source-test.js', // #936: JTCAT/SSTV pop-outs hear Icom network audio, not the local input
  'test/capture-stall-test.js', // kc8zp_ryan: JTCAT capture rebuilt when the OS mutes/suspends it or it stops delivering
  'test/jtcat-capture-gate-test.js', // #133: a remote-started FT8 capture is restarted like a desktop one; one capture build at a time
  'test/remote-off-release-test.js', // #746: ECHOCAT turned off releases the radio input a phone-started FT8/JS8 held
  'test/rig-capture-layout-test.js', // #757: every capture of the radio input asks for 1 channel, so two captures of one Linux source share a layout
  'test/jtcat-log-comment-test.js', // dcxweaver: the "JTCAT FT8" COMMENT is optional (default on)
  'test/vfo-sdr-volume-test.js', // #118 df1vb: the SDR Volume row stands in when the VOL knob is hidden
  'test/wspr-power-memory-test.js',
  'test/wspr-scheduler-test.js', // #268: a beacon never keys two slots in a row unless TX % is over 50
  'test/wspr-hop-atu-test.js', // #747: a receive-only WSPR hop runs no band-change ATU tune
  'test/wspr-beacon-power-test.js', // #268: the beacon keeps the operator's RF power; rigctld reports the radio's power
  'test/wspr-beacon-power-scale-test.js', // #521: the beacon's level on each rig's scale (KX3, G90, Icom, Yaesu, Flex), never above the entry; none entered = power left alone
  'test/wspr-reported-dbm-test.js', // #268: the beacon reports the power it runs at (5 W = 37 dBm), or the operator's fixed pick, 0..60 dBm
  'test/js8-native-test.js',
  'test/check-required-natives-test.js', // release gate: ft8_native/js8_native exist, right arch (PE/ELF/Mach-O header), load
  'test/rade-native-test.js',
  'test/freedv-playback-test.js',
  'test/js8-varicode-test.js',
  'test/js8-qso-test.js',
  'test/js8-rx-assembler-test.js',
  'test/js8-engine-test.js',
  'test/js8-remote-test.js',
  'test/idle-activity-test.js',
  'test/auto-sstv-cancel-525-test.js',
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
  'test/mercury-listen-no-idle-lock-test.js',
  'test/mercury-audio-bridge-test.js',
  'test/mercury-app-protocol-test.js',
  'test/echocat-web-gate-test.js',
  'test/tunnel-webui-gate-test.js',
  'test/cloud-session-change-test.js',
  'test/cloud-device-revoked-test.js', // a computer removed from the Cloud account is signed out: tokens cleared, loops and tunnel stopped
  'test/cloud-log-sync-test.js',
  'test/cloud-sync-log-test.js', // B10: Cloud sync writes its pulls, errors and "not started" reason to the session log
  'test/cloud-pair-errors-test.js', // a second desktop registers before Cloud pairing; Cloud answers in plain words; its device id never leaves in an export
  'test/launch-origin-test.js',
  'test/cloud-merge-dupe-test.js',
  'test/cloud-pull-per-profile-test.js', // #245: profiles sharing one account: each pulls only its own QSOs; the dupe guard and journal stay per profile
  'test/cloud-delete-guard-test.js', // #245: delete pushes held (another profile's QSOs, or over 25 an hour) until the operator confirms; dupe guard keeps station callsigns apart
  'test/cloud-pull-forward-test.js', // #267/#838: this station's QSOs from a phone or any other device reach MacLoggerDX etc. via the pull, once, retried when a logger refuses; never another PC's or the history
  'test/swr-guard-test.js',
  'test/atu-wizard-test.js',         // Flex ATU Calibration Wizard: plan vs privileges, classifier, run loop on a fake Flex, wiring
  'test/ft8-worker-respawn-test.js',
  'test/rig-setup-notes-test.js',
  'test/rig-model-connection-test.js', // #1084: picking X6100 keeps a connection that reaches it or selects FLRig, never Serial CAT; other models unchanged
  'test/prop-empty-state-test.js',
  'test/rotctld-client-test.js',
  'test/station-setup-test.js',
  'test/station-setup-after-welcome-test.js',
  'test/launch-ping-test.js',
  'test/first-run-test.js', // a shorter first run: steps, resume, Esc keeps entries, firstRun turns false at the station step, local markers
  'test/rig-record-test.js', // a shorter first run, part 2: a radio saved in the first run has the Settings editor's record and connection-target shape
  'test/rig-quick-setup-test.js', // which radio: model search, connection/baud/CI-V from the model, the port offered from names only, saved as the radio in use
  'test/radio-check-test.js', // radio check: Station Setup's control and hearing steps inline, read-and-listen actions only, the sound input offered
  'test/first-run-radio-test.js', // which radio and radio check screens: no port opened to look for a radio, Flex search only listens, nothing transmits
  'test/grid-macros-test.js', // macros with no grid set: re-spot drops 'in {QTH}', PSK $GRID and CW {MYGRID} refused, SSTV drops 'Grid {GRID}'
  'test/setup-share-test.js',
  'test/lz3aw-round6-test.js',
  'test/cw-auto-sync-test.js',
  'test/remote-launcher-test.js',
  'test/launcher-unix-pids-test.js', // Remote Launcher on Linux/macOS: its own tray process and helpers are not "POTACAT is running"
  'test/launcher-cloud-test.js', // restart from anywhere: device token, tunnel policy, the launcher's own connector
  'test/echocat-token-test.js',
  'test/fresh-install-defaults-test.js',
  'test/review-ask-test.js',
  'test/rigctld-gain-fallback-test.js',
  'test/release-notes-format-test.js',
  'test/website-links-guard-test.js', // release.yml update-website pushes only version strings in the download block; anything else is a website handoff branch
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
  'test/cw-paddle-memory-test.js', // #244: ECHOCAT Web Paddle Memory setting (on/half/quarter/off); CW hold set before 'ptt'
  'test/web-keyer-heard-release-test.js', // #244: a late release never takes back an element that has started to sound
  'test/cw-playout-lateness-test.js', // #244 diagnostic: paddle playout edge lateness, one line per over
  'test/cw-sidetone-air-agree-test.js', // #244: ECHOCAT Web's sidetone and the air agree; an element is committed once it sounds
  'test/cw-keyer-setmode-same-mode-test.js', // ECHOCAT Web: a settings or config echo with the same keyer mode does not cut a CW over
  'test/cw-keyer-timing-diag-test.js', // #244 diagnostic: the page keyer's timing record of one over; keying identical with and without it
  'test/web-paddle-input-first-test.js', // #244 Part A: paddle keys and MIDI reach the web keyer first (capture phase); drawing pauses during a paddle over
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
  'test/window-security-test.js', // app windows: only the permissions POTACAT uses (mic, MIDI, CM108 WebHID, copy, audio output, full screen) for its own pages; no navigation away; no new windows, web links through the open-external allowlist
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
  'test/sstv-last-line-test.js', // #660: the last line is painted; clean dark pictures are not discarded
  'test/sstv-mobile-readiness-test.js',
  'test/sstv-template-sync-test.js',
  'test/sstv-gallery-test.js',
  'test/sstv-gallery-dir-test.js', // #123: the gallery folder is prepared async with a time limit, never sync on the SSTV window-open path
  'test/open-folder-546-test.js', // #546: every Open folder button makes a missing folder, then opens it; a failure is shown, never swallowed
  'test/sstv-keep-test.js',
  'test/sstv-help-test.js',
  'test/sstv-jtcat-handover-test.js',
  'scripts/validate-sstv-packs.js',
  'test/spot-age-pota-test.js',
  'test/spot-age-everywhere-test.js', // #502: VFO card, Spots pop-out, ECHOCAT, SmartSDR and TCI use the table's Max Spot Age
  'test/scope-spot-age-test.js', // #239: the scope/bandspread pop-outs apply the table's Max Spot Age, re-checked on a timer
  'test/cw-sidetone-schedule-test.js',
  'test/echocat-web-micgain-test.js',
  'test/cloud-billing-ui-test.js',
  'test/ts590-flow-control-test.js',
  'test/rts-asserted-no-flow-test.js', // #136: RTS line "Asserted, no flow control" (YT-1200 pass-through) + the CTS-low log line
  'test/github-issues-2026-10-26-test.js', // #107 FT-450 test, #106 interface PTT, #103 Auto RTS trial
  'test/duo-vfo-wire-test.js',        // iPhone Duo VFO pane: tuned-spot, swr-guard-state, atu-tune, tx-eq, status.meters
  'test/activator-hunter-parks-test.js', // WD3D: their parks as a comma list (n-fer P2P)
  'test/p2p-park-entry-506-test.js', // #506: a new callsign clears their park; the P2P box as shown is what is logged
  'test/vfo-power-button-test.js',    // KQ5O: Power On/Off at the bottom of the VFO window
  'test/dx-rule-test.js',            // G4BFG: DX = another entity, or the operator's HF / 6 m-up distance
  'test/park-entity-test.js',        // #662: a home call signed in a park abroad takes the park's DXCC entity
  'test/external-atu-carrier-test.js', // N8JMS: RF-sense tuner carrier in AM (CW over CAT is key-up)
  'test/tx-power-control-test.js', // N5XHI FT-857D 2026-11-24: the one rule "can POTACAT set this radio's TX power?", per radio and transport, the question's wording, the tune gate
  'test/ext-atu-own-power-test.js', // ... the real gate + tune in a sandbox: no power commands or power claims on such a radio, Cancel keys nothing, a device is refused or asked, power-capable radios unchanged
  'test/jtcat-map-popout-arcs-test.js', // TacticalIndex: QSO arcs in the JTCAT map pop-out
  'test/jtcat-map-popout-rr73-test.js', // #1029: RR73 is not a grid in the map pop-out
  'test/ae5je-settings-audio-test.js', // AE5JE: audio devices follow their name; bug report says whether settings saves land
  'test/page-script-globals-test.js', // one top-level scope per page: a second const of the same name stops a script (WB3EGD, the dead 1.13.5 audio heal)
  'test/window-min-size-test.js',     // N0KAH: no window shrinks past its own controls
  'test/window-rules-test.js',        // every window opens in the theme and remembers its place
  'test/mac-frameless-windows-test.js', // #866: every visible frameless window keeps the macOS traffic lights; the APRS and JTCAT map title bars keep their own controls on a Mac
  'test/linux-native-frame-test.js',  // #345: optional system title bar on Linux (off by default); one rule in lib/window-frame.js, the pages hide their own buttons
  'test/meter-box-test.js', // NJ2DX 2026-11-21: the S-meter box is clamped on screen as it appears, and draws with the theme's colours
  'test/yaesu-fa-digits-test.js',
  'test/yaesu-audit-ft891-test.js', // Yaesu CAT audit: FT-891 preamp, AGC, PROC, CW text, RTTY
  'test/log-as-test.js',
  'test/save-qso-stall-test.js',
  'test/pota-sync-login-test.js',
  'test/pota-sync-log-test.js', // #406: the pota.app Connect step logs names and lengths, never a value
  'test/qso-expand-test.js',
  'test/qso-my-rig-test.js', // #633 (w5lee): the radio a contact was logged on is ADIF MY_RIG; Logbook Rig column
  'test/qso-log-source-test.js', // #634 (w5lee): ECHOCAT contacts carry APP_POTACAT_LOG_SOURCE; Logbook Source column
  'test/dxcc-codes-test.js', // #554: logged contacts carry the ADIF DXCC entity number
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
  'test/external-url-test.js', // open-external: host compared exactly (no lookalikes, userinfo, trailing dot); file:// only inside the app folders
  'test/secret-file-test.js', // the ECHOCAT TLS key, the Tailscale key and settings.json are 0600; an older key is chmod'ed at start
  'test/fetch-policy-test.js',
  'test/icom-picker-models-test.js',
  'test/k9cyt-requests-test.js',
  'test/respot-templates-remote-test.js',
  'test/cw-remote-expand-test.js',
  'test/cw-esm-test.js', // #741 Enter Sends Message: Run and S&P state machine, log first then TU, Esc
  'test/cw-banks-test.js', // #741 the Run and S&P CW banks: N1MM positional keys, migration, variables
  'test/cw-esm-wiring-test.js', // #741 the main window's ESM keys: only the call field, only CW, only with ESM on
  'test/cw-greeting-test.js',
  'test/tqsl-test.js', // TQSL found where it is installed, Flatpak included; the TQSL program field (#343)
  'test/lotw-flags-test.js',
  'test/lotw-split-test.js',
  'test/station-county-test.js', // the operator's own state and county: per park on activations, home only from the home grid
  'test/guest-pass-station-location-test.js', // a Guest Pass contact carries the lending station's grid, state and county (#822)
  'test/guest-log-station-location-test.js', // #909: a guest desktop's own log forms on a pass stamp the station's location (settings.stationLocation)
  'test/sdr-scope-test.js',
  'test/sdr-scope-if-tap-test.js', // #394: an SDR on a radio's IF output stays on the IF
  'test/rtltcp-audio-test.js',
  'test/sdrconnect-protocol-test.js', // SDRconnect WebSocket API (SDRplay nRSP-ST): envelope, binary types, levels from bins, restore set
  'test/sdrconnect-client-test.js', // SDRconnect against a fake server: discovery, scope follows the dial, reconnect, failures, clean shutdown
  'test/sdrconnect-audio-test.js', // listening and JTCAT through SDRconnect: 48 kHz audio, demodulator, sharing the scope, main.js wiring
  'test/landmarks-test.js', // Directory > Landmarks: the catalog gate, hours, rig coverage, the NCDXF clock, the feed, wiring
  'test/directory-key-nav-test.js', // #501: Directory arrow keys move from the row you clicked; ends clamp; a tab switch resets
  'test/lz3aw-round14-test.js',
  'test/log-export-choice-test.js', // #698: Export ADIF for everything shown, a UTC time range, or the selected rows
  'test/logbook-map-filter-test.js', // #702: the Logbook map plots exactly the filtered rows; one filter for list, map and ECHOCAT Web
  'test/lz3aw-batch-b-test.js',
  'test/lotw-report-test.js',
  'test/import-confirmations-test.js', // Import Log merges QSL / LoTW confirmations into QSOs already logged (#461)
  'test/rumlogng-logbook-test.js',
  'test/wsjtx-status-bridge-test.js',
  'test/jtcat-tx-slot-test.js',
  'test/jtcat-mode-change-test.js',
  'test/activation-map-data-test.js',
  'test/log-freq-test.js',
  'test/log-freq-resolution-test.js',
  'test/log-tx-power-test.js',
  'test/log-fixed-power-test.js',
  'test/station-clock-test.js', // ECHOCAT device sets the FT8 slot clock
  'test/rig-bands-test.js',
  'test/rotor-bands-test.js', // #356 rotor only on chosen bands
  'test/band-last-freq-test.js',
  'test/spot-band-filter-test.js',
  'test/award-tables-test.js',
  'test/dxcc-progress-test.js',
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
  'test/jtcat-rx-slider-range-test.js',
  'test/cloud-phase2-ui-test.js',
  'test/onair-callsign-test.js',
  'test/activated-parks-test.js',
  'test/serial-port-busy-hint-test.js',
  'test/local-paddle-route-test.js',
  'test/bands-everywhere-test.js',
  'test/remote-tx-audio-diag-test.js',
  'test/welcome-cloud-signin-test.js',
  'test/welcome-pair-text-test.js',
  'test/welcome-rig-station-setup-test.js',
  'test/activation-filename-date-test.js',
  'test/remote-rig-test.js',
  'test/remote-rig-power-test.js', // #152: rig power on/off from a remote POTACAT; no Power Off under a TX
  'test/rig-power-on-cap-test.js', // #485: FTX-1 powers off over CAT but not on; Power On hidden everywhere
  'test/rig-power-off-guard-test.js', // #293: no Power Off for a radio POTACAT cannot switch back on, unless the rig allows it
  'test/rig-power-off-defaults-test.js', // #768: Power Off shown by default on a direct serial port or SCU-LAN10, hidden on Hamlib; a stored choice wins
  'test/amp-drive-limit-test.js', // B10 row 10: a per-rig amplifier drive limit, enforced in every radio client
  'test/g90-power-scale-test.js', // the Xiegu G90 through rigctld sends RFPOWER on its own 20 W full scale (20 W = 1.000, not 0.200); other radios' bytes unchanged (#989)
  'test/remote-multi-client-test.js',
  'test/remote-bridge-test.js',
  'test/aprs-remote-shack-test.js', // #868: a desktop driving a remote shack starts APRS listening there (aprs-listen), shows the shack's aprs-state and the stations its radio heard
  'test/winlink-remote-shack-test.js', // #299: a desktop driving a remote shack uses the shack's Winlink (mailbox, gateways, radio sessions) over the winlink-* wire
  'test/sstv-context-test.js',
  'test/tailscale-detect-test.js',
  'test/yaesu-legacy-codec-test.js',
  'test/yaesu-audit-ftx1-test.js', // Yaesu CAT audit: FTX-1 width SH00nn from Table 5, RTTY-U/PSK/DATA-FM-N readback
  'test/ftx1-preamp-readback-test.js', // the FTX-1 preamp is read back (PA0; -> PA02; = AMP2, PA1;/PA2; on 2 m / 70 cm), so a radio already on AMP2 shows it when a window opens (rev 2508-C p.22)
  'test/icom-network-log-routing-test.js',
  'test/icom-network-voice-test.js',
  'test/jtty-chats-test.js',
  'test/rig-presets-test.js',
  'test/web-row-alignment-test.js',
  'test/worked-other-test.js',
  'test/decode-contract-test.js',
  'test/ft8-wasm-bracket-test.js',
  'test/layout-alignment-test.js',
  'test/jtcat-stations-test.js', // #557: the Stations view, one line per station heard (fold, expiry, clear, sort, row, click)
  'test/jtcat-stations-needed-test.js', // #557 part 2: needed marks from the roster under the map's scope, the Park column, Wanted in Stations
  'test/jtcat-auto-compact-test.js', // #857: the JTCAT window picks a compact layout by itself when short (hysteresis; an explicit Full/Compact wins; never resizes the window)
  'test/jtcat-own-tx-offset-test.js', // #503: our own TX rows show the offset that slot went out on
  'test/jtcat-chimes-test.js', // optional JTCAT chimes: a station calls me, TX stopped by itself (off by default, one sound engine, sound only)
  'test/jtcat-run-callers-test.js', // Run answers the stations that called during a QSO before calling CQ again (W5XY 2026-11-25)
  'test/net-reminder-row-test.js', // a Net Reminders row always names its net (#284)
  'test/freq-dots-test.js', // every frequency an operator reads is written the VFO way, 14.074.00 (Casey 2026-11-11)
  'test/settings-contrast-test.js', // Settings meets the contrast rule in every theme (VARA button in She's On Frequency); rendered: scripts/settings-contrast-audit.js
  'test/settings-pi-test.js',
  'test/log-form-layout-test.js', // #240: the Log QSO form is wider, resizable with its width remembered, and its paired fields wrap at any Text size / display scale
  'test/g90-hamlib-model-test.js',
  'test/voice-data-mode-test.js',
  'test/n3fjp-pull-test.js',
  'test/tx-limit-test.js', // one stuck-TX limit over every key-down POTACAT starts; a radio keyed without us is logged
  'test/ptt-data-mode-order-test.js', // SSB-over-DATA keys only once the radio reports DATA; the voice mode is restored after unkey and confirmed
  'test/ssb-over-data-fm-test.js', // SSB-over-DATA leaves FM and AM alone on a radio with no FM or AM data form (#561)
  'test/winlink-compose-hint-test.js', // #188 NA4DQ: compose placeholder follows the mode (packet/VARA FM never say HF)
  'test/winlink-data-hold-test.js', // #187 NA4DQ IC-7300: a Winlink session holds DATA (no USB/DIGU flip per frame); the dial goes back once, logged
  'test/tx-no-freq-poll-test.js', // no frequency/mode poll while PTT is asserted; a frequency read during TX is ignored (kg6odijohn)
  'test/filter-width-untouched-test.js', // a spot click leaves the filter width alone: a width only from Filter Width settings or a rig preset
  'test/sstv-spec-timing-test.js', // Scottie, PD and Robot 72 send and read the spec line: exact scans, Robot 72's porch before each chroma
  'test/vfo-typed-freq-uhf-test.js', // 432100 and 1296100 typed in the VFO window are 70 cm and 23 cm, not 0.43 and 1.3 MHz (davidcappello IC-9700)
  'test/swr-rest-on-rx-test.js', // SWR and ALC go back to rest on receive (davidcappello IC-9700); the Icom SWR scale is Hamlib's
  'test/sculan10-test.js', // Yaesu SCU-LAN10 (experimental): wire protocol against the spec's reference values, the transport against a fake unit (login, setup, keepalives, CAT de-dup, RX audio, login timeout, password never logged)
  'test/sculan10-wiring-test.js', // SCU-LAN10 in POTACAT: a visible rig-editor choice, Yaesu codec over the transport, RX audio to JTCAT/SSTV/ECHOCAT, a key-down with LAN audio refused (never a silent carrier)
  'test/yaesu-lan-tx-test.js', // SCU-LAN10 TX owners (#227): one transmitter at a time; a second is refused before PTT, a release cancels only its own, nobody unkeys another's
  'test/sculan10-read-first-test.js', // FT-710 scope Enable reads SCU-LAN10 (EX030126) before writing: already ON is left alone and not turned off at close; no answer means no blind write (#113 item 7)
  'test/sculan10-scope-test.js', // SCU-LAN10 band scope: spec-shaped frames, inverted amplitude, the line is the first 850 bytes of a 4096-byte frame (#143), the boundary marker and its lock, 850-point resampling, bin-to-frequency
  'test/rig-full-power-test.js', // a radio's real full power (rig.fullPowerW): W5LEE's 5 W Hermes Lite behind deskHPSDR's 100 W TS-2000 emulation, slider, PC command, readback and log in real watts
  'test/cat-rts-advice-test.js', // #849: no surface says to set the radio's CAT RTS menu to Enable; the network-link tune warning says what it saw
  'test/kenwood-ts890-om-test.js', // #850: the TS-890S sets and reads its mode with OM (USB-D = OM0D;), never MD/DA (TS-890S reference rev1 p.51)
  'test/kenwood-pc-power-test.js', // the TCP Kenwood client (deskHPSDR, Zeus) sends PC on the model's scale, Full power included (6 W = PC100, not PC006), never drops the last slider level, and a radio that cannot report its power gets it again after a band change (#184)
  'test/zeus-cat-digu-test.js', // #185: Zeus through its TS-2000-style CAT port: FT8/FT4 go out as MD9 (DIGU), DIGL as plain LSB, no DA; other Kenwoods unchanged
  'test/power-restore-test.js', // the external-tuner / test restore: never a 100 W guess, never against the operator's own knob (GitHub #111, 1.13.10 regression)
  'test/activator-log-once-test.js', // the Activator log saves once per press, and a slow QRZ never holds up a save (.eddiejames duplicates)
  'test/serial-hs-trial-test.js', // the RTS/CTS no-answer trial covers Kenwood too (jcoreyc TS-480), never the legacy Yaesu protocol
  'test/rts-ptt-flow-voice-test-544-test.js', // #544: PTT on RTS vs RTS/CTS per port, no trial where RTS keys PTT, the voice test says keyed only with evidence
  'test/idle-radio-return-test.js', // #1051: every idle mode puts the radio back, never over the operator's own move
  'test/idle-mode-1051-wiring-test.js', // #1051: one return path, operator actions win, outside tuning is activity, Idle Mode off for new installs
  'test/idle-radio-use-test.js', // APRS listening is use of the radio: Idle Mode never starts or retunes under it (on air 2026-11-18)
  'test/idle-wspr-band-test.js', // idle-RX WSPR uses only the rig's bands and offers 2 m (artificialjumpprotection IC-7100)
  'test/park-db-check-test.js', // activator: only POTA refs are checked against the parks list (og3e WWFF/SOTA flagged as typos), and the warning never overflows
  'test/rigctld-passthrough-test.js', // custom CAT over rigctld: a + or \ command goes to rigctld as typed (electricfalcon)
  'test/mono-upmix-test.js', // the VFO monitor plays radio audio in both ears (hoogskev, macOS left-channel only)
  'test/setup-test-mode-test.js', // #755: the transmit test keys in the DATA mode FT8 uses (USB->DIGU on sound-card radios), says so, puts it back
  'test/setup-test-freq-test.js', // Station Setup test transmit: at the dial if the licence allows, else at the band's FT8 dial and back, else refused with why (w0tlp)
  'test/jtcat-spot-target-after-qso-test.js', // #518: a finished QSO (done, Skip, Cancel) with the spot target's call clears it, armed or engaged; the watcher never calls a worked station again
  'test/jtcat-hold-tx-resend-test.js', // #688: jtcat-start resends the Hold TX state so a phone FT8 screen opened after connect shows it; Hold TX Freq: ON reaches the CAT log
  'test/jtcat-hunt-filters-test.js', // Hunt filters (plan-jtcat-hunt-priorities): targets ANY, priority, Never answer, auto-skip, CQ DX/continent rule, quiet-reason text
  'test/jtcat-hunt-status-test.js', // Hunt status line (why Hunt is quiet) and Hide decodes below (nj2dx)
  'test/jtcat-hunt-new-grid-test.js', // Hunt: New grids target, Wanted split into New DXCC / New grid (level_death)
  'test/jtcat-hunt-priority-test.js', // Hunt: Who goes first (Strongest default, Farthest, Needed first)
  'test/jtcat-hunt-custom-test.js', // Hunt: Custom (ANY of the ticked targets), Hunt minimum dB in the Filters panel
  'test/jtcat-hunt-ignore-test.js', // Hunt: Never answer (right-click a decode) and 30-min auto-skip after a failed QSO
  'test/jtcat-hunt-direct-caller-worked-test.js', // Hunt answers a direct caller per "Call a station again after N days" (jtcatWorkedInfo)
  'test/jtcat-hunt-cq-dx-test.js', // Hunt: never answer a CQ DX from our own continent, nor a CQ NA/EU aimed elsewhere
  'test/jtcat-fake-it-test.js', // Split operation "Fake It" (level_death): tone 1500-1999 Hz, dial shifted per transmission and put back
  'test/jtcat-fake-it-default-test.js', // Fake It on for new installs, written off once for existing ones; plain offset where it cannot work (TCI, no CAT, split)
  'test/jtcat-hunt-echocat-test.js', // Hunt filters over ECHOCAT: jtcat-hunt-filters (Guest Pass refused), hunt-filters cap, web Filters sheet
  'test/civ-pacing-test.js', // one CI-V command in flight: an Icom abandons a reply when the next command arrives (NA4DQ IC-7300 Guest Pass)
  'test/guest-pass-no-power-test.js', // Guest Pass with no power report: plain refusal to the guest's windows, owner fix line, power read after the cap (NA4DQ/KF0WWL)
  'test/civ-pacing-adaptive-test.js', // CI-V pacing engages only on an Icom seen dropping replies; Auto / Always / Never per rig
  'test/log-false-p2p-test.js', // no false park-to-park: a General contact after a POTA spot or contact carries no park (web sheet, desktop banner)
  'test/n3fjp-confirm-keep-test.js', // N3FJP pull never deletes a confirmation; eQSL and ClubLog count as confirmed
  'test/n3fjp-deleted-test.js', // a contact deleted after an N3FJP pull is not brought back by the daily re-read
  'test/n3fjp-call-in-progress-test.js', // #712 the call in progress goes to N3FJP's entry window; debounced; never logs
  'test/kenwood-tx-latch-test.js', // a Kenwood is not latched in transmit after a hand-mic over (IF; P8 asked during TX)
  'test/civ-pacing-ptt-order-test.js', // CI-V pacing never sends TX OFF before TX ON; the newest key state wins
  'test/forced-data-no-tune-test.js', // a forced-DATA key-down sets the mode only; never a frequency write (Icom repeater memories)
  'test/rts-trial-keyed-test.js', // the RTS/CTS trial never saves a setting that keys the radio; a shorter no-answer wait
  'test/ptt-quiet-paths-test.js', // no 800 ms DATA wait on a radio that cannot confirm; hand-mic overs are not warnings; the voice hint needs our audio
  'test/qrz-upload-visible-test.js', // B8 row 3: every QRZ upload logs a [QRZ] line, a refusal toasts, a check never unticks the box
  'test/qrz-late-backfill-test.js', // a late QRZ answer fills the saved record's empty fields
  'test/qrz-request-timeout-test.js', // a stalled QRZ socket gives up at its timeout (activation review fix 1)
  'test/qrz-lookup-queue-test.js', // QRZ lookups: 2 in flight, 250 ms apart, operator first, bounded queue, one login, 2-min failure cache
  'test/log-qso-fast-reply-test.js', // #732: ECHOCAT's log-ok at the disk write; uploads and respots after, respot outcome as a follow-up
  'test/phone-tx-power-test.js', // ECHOCAT #85: log-qso keeps the phone's txPower (else the usual fill), log-ok records carry it, hello lists log-tx-power
  'test/phone-activation-gear-test.js', // #975: log-qso keeps the phone's rig and antenna (64 chars), desktop rig otherwise; MY_ANTENNA written and read back
  'test/log-qso-idempotent-test.js', // #733: log-qso idempotent by uuid; the log's uuid index; no duplicate uuid reaches the Cloud
  'test/qso-identity-test.js', // #988: which QSO a Logbook edit/delete means: uuid, else CALL+QSO_DATE+TIME_ON+BAND+MODE; refuse when no single match
  'test/logbook-delete-988-test.js', // #988: Logbook deletes/edits hit the clicked QSO after a delete; a uuid-less delete is written; ECHOCAT reports the real result
  'test/hunt-polish-test.js', // Hunt says who it is working; web Filters with Hunt off and for a guest; the list saved on every change; the review window closes on decline
  'test/tx-review-low-test.js', // drop detector paused in TX; Winlink re-key restarts the TX limit; full power on rigctld raw PC; multi-slice TX kind
  'test/lan-review-test.js', // VFO speaker plays LAN audio; a reopened port clears POTACAT's old close; FT-710 named; LAN scope text; LAN transport window and strangers
  'test/guest-pass-full-power-test.js', // a Guest Pass cap on a rig with Full power (W): real watts throughout; a 5 W rig transmits, a 100 W rig is capped
  'test/pacing-vs-mode-note-test.js', // a radio that drops replies gets only the pacing line; a wrong-model radio only the mode note
  'test/jtcat-tx-refused-test.js', // #190: a refused JS8 tx-start is not "fully transmitted"; FT8 refusal events identical to master; HALT never hidden by mode
  'test/run-tests-runner-test.js', // #175: this runner keeps going past a failing file, names every failure, exits non-zero; parallel output never interleaves
  'test/run-tests-changed-test.js', // --changed picks the tests that mention a changed file; main.js narrowed by changed function names and strings
  'test/update-check-feedback-test.js', // #186: a manual Check for Updates always ends in a visible message (checking, up to date, found, or the error + download page)
  'test/startup-prefetch-test.js', // the first window sooner: startup read-ahead, electron-updater on first use
  'test/tls-der-int-test.js', // ECHOCAT self-signed cert: the random serial is minimal DER (a leading 0x00 made OpenSSL reject ~1 in 512 certs)
  'test/rigctld-data-fm-test.js', // #259: DIGFM/DIGAM have rigctld tokens (PKTFM/PKTAM), so a packet key-down on FM sends the DATA mode
  'test/launcher-cert-der-test.js', // Remote Launcher cert: minimal DER serial; a saved cert that doesn't parse is regenerated
  'test/clean-exit-marker-test.js', // #550: a Launcher run never consumes the GUI's clean-exit marker or rotates its startup.log, so a clean quit is not reported as a crash
  'test/serial-quit-test.js', // #657: every serial port closed and every native serial call finished before quit (macOS SIGABRT)
  'test/remote-tune-click-label-test.js', // #756: the ECHOCAT Web tuneClick switch is labelled for the click sound, not "Tap to Tune"
  'test/tune-link-guard-test.js', // a potacat://tune link stops Run, Hunt, the WSPR beacon, the Spot Target, a QSO and TX before it tunes; notice in the main and JTCAT windows
  'test/test-manifest-complete-test.js', // every test/ and lib/ *-test.js / *.test.js is in TESTS or in EXCEPTIONS below, so no test file silently never runs
  // 2026-11-23: test files that existed but were on no list, so CI never ran them.
  'lib/psk-engine-test.js', // PSK31 engine: varicode round-trip, TX->RX loopback, AFC pull-in, squelch, Ft8Engine contract
  'test/all-qsos-cap-test.js', // legacy all-qsos frame bounded by bytes (iOS 1009 kill), chunked path, qso-added delta gate
  'test/aprs-is-test.js', // APRS-IS packet builders: passcode, gate, position packets
  'test/cloud-export-test.js', // Cloud ADIF export: 401 -> refresh + retry once; temp file then rename (local stub server)
  'test/cloud-tunnel-degraded-test.js', // Cloud Tunnel flags "degraded" when cloudflared loses DNS but does not exit
  'test/cloudflared-arch-test.js', // cloudflared EBADARCH (-86): system binary fallback or a clear message
  'test/cw-keyer-script-test.js', // the persistent CW keyer's generated Python keys the right line and dispatches commands
  'test/freedv-reporter-test.js', // FreeDV Reporter: an error with no listener never kills the process
  'test/js8-mailbox-test.js', // JS8 mailbox parsing and the SMS / email message builders
  'test/linux-sandbox-test.js', // #37: the Linux no-sandbox fallback fires only where launch would abort
  'test/local-ips-test.js', // which interfaces may be advertised as the LAN (VPN overlays dropped, bridged hypervisor kept)
  'test/lz3aw-round13-test.js', // LZ3AW round 13: Live CW button, log time, F-key macros, readable greys, multi-call filter
  'test/pair-request-retry-test.js', // tap-to-pair: a retry with the same requestId collects or re-attaches; a different one is busy
  'test/pair-confirm-test.js', // two-step pairing: a held pairing commits once, releases once, times out; old bodies never ask
  'test/pairing-session-test.js', // simpler pairing: the code renews itself, is replaced when used, dies with the screen; six-digit number; LAN rules; mDNS keys
  'test/pairing-screen-test.js', // simpler pairing: https link with the parameters after "#", one to one with potacat://pair; browser address; state line; ECHOCAT wording
  'test/pairing-server-test.js', // simpler pairing on a real server: trusted screen token, used/revoked codes, number on tap-to-pair, no pairing without the click
  'test/park-state-test.js', // a park spanning states writes a clean ADIF STATE
  'test/popout-theme-boot-test.js', // pop-outs open in the theme on the first frame; applyPopoutTheme takes a string or { theme, variant }
  'test/profile-dirs-test.js', // slash-callsign profile directories and the nested-dir migration
  'test/pskreporter-test.js', // PSKReporter: transient 5xx retried quietly, a real failure only after a run of them
  'test/pskreporter-tx-test.js', // PSKReporter IPFIX datagram decodes back to what was sent
  'test/qso-chunker-test.js', // chunked all-qsos: every chunk under the byte cap, order and every record kept
  'test/remote-client-dial-test.js', // RemoteClient: an unreachable leg never crashes the app; a fingerprint mismatch advances once
  'test/remote-tune-echo-test.js', // a tune is echoed to the client at once, not on the next CAT poll
  'test/revoke-kick.test.js', // revoking a device closes its live session (4004), spares others and blocks re-auth
  'test/kick-after-hello-test.js', // ECHOCAT: a no-token socket displaces no one until its hello and is closed by the auth timer; kicked.byName, tunnel byHost
  'test/kicked-by-test.js', // kicked.byName (guest call, paired name, "this computer") and byHost (cf-connecting-ip over the tunnel)
  'test/rig-audio-mirror-test.js', // an empty remoteAudioInput follows the rig's CODEC, never the built-in mic
  'test/rotorez-test.js', // Rotor-EZ wire format, reply parser and the brake-delay queue (fake serial port)
  'test/rx-level-test.js', // shack-side receive level: gain graph, live update, TX mute wins, Flex Direct stand-in capture
  'test/smartsdr-discovery-test.js', // SmartSDR: POTACAT's own previous GUI-client registration is not a foreign client
  'test/smartsdr-reconnect-test.js', // SmartSDR reconnect: fast retries, one give-up, then a background probe
  'test/wspr-bandhop-test.js', // WSPR band-hop schedule
  'test/wspr-decoder-test.js', // wsprd output parser and the WAV writer
  'test/wspr-encode-test.js', // WSPR encoder: 50-bit packing proved by an independent unpack
  'test/wspr-network-test.js', // WSPR band table and the wsprnet upload formatter (fake fetch)
  'test/wspr-stats-test.js', // WSPR stats: dBm to watts, miles per watt
  'test/wspr-wsprlive-test.js', // "Where am I heard" from wspr.live (fake fetch)
];

// Test files that CI does not run, each with the reason. A file named
// *-test.js or *.test.js in test/ or lib/ must be in TESTS or here
// (test/test-manifest-complete-test.js). Reasons start with one of:
// "manual:", "needs hardware:", "needs network:", "harness:", "superseded by ", "stale:".
const EXCEPTIONS = {
  'lib/jtcat-echocat-test.js': 'needs hardware: an in-app on-air harness (exports a function that takes the running app, keys a real radio at 5 W on 20 m / 15 m FT8 and FT4); nothing in the repo loads it',
};


// Files that must run alone, after the parallel pool. Each was seen to fail
// only when other files ran beside it (fixed ports, shared temp files, timing).
// A file goes here with the reason; better to fix the test and take it out.
const SERIAL = new Set([
  'test/atu-wizard-test.js', // runs the wizard on a 40x clock over real timers; under load a point times out (K3SBP run 1 case)
  'test/tci-audio-test.js', // 2 s budgets for a loopback TCI server to answer; missed in 2 of 9 parallel runs on a loaded machine, never alone
  'test/paddle-bounce-test.js', // web keyer element timing in real milliseconds; a dash was cut short once under load
  'test/civ-pacing-test.js', // fixed 60/200 ms waits on a fake CI-V radio; failed four pushes under parallel load on 2026-11-22, passes alone
  'test/ptt-client-id-test.js', // fixed port 17461; "Port 17461 busy" blocked two pushes under parallel load on 2026-11-23, passes alone
  // Added 2026-11-23 when they joined TESTS; not yet seen to fail, placed here up front:
  'test/revoke-kick.test.js', // fixed port 17310, a real ECHOCAT server and 300-1500 ms waits for the kick to land
  'test/kick-after-hello-test.js', // fixed ports 17491-17493, a real ECHOCAT server and 200-1500 ms waits
  'test/remote-client-dial-test.js', // fixed port 17320 and a 2.5 s window of dial rounds with backoff
  'test/pair-request-retry-test.js', // fixed port 17330, sockets killed after 150 ms and 300-400 ms waits
  'test/pairing-server-test.js', // fixed port 17366, a real ECHOCAT server and 300-500 ms waits for the held pair request
  'test/rotorez-test.js', // the brake-delay state machine on real timers (20-450 ms waits)
]);

// SERIAL files that may be retried once after a failure (timing under load,
// never a logic failure). Every file here must also be in SERIAL.
const RETRY_ONCE = new Set(SERIAL);

// The longest files, started first so the pool does not wait on one that began
// late (sstv-quality alone is about 6 minutes under load). Order only, never results.
const SLOW_FIRST = [
  'test/sstv-quality-test.js',
  'test/sstv-lock-test.js',
  'test/sstv-realistic-rx-test.js',
  'test/sstv-e2e-test.js',
  'test/jtty-decoder-test.js',
  'test/external-atu-carrier-test.js',
  'test/sculan10-test.js',
  'test/flrig-codec-test.js',
  'test/sstv-spec-timing-test.js',
];

const root = path.join(__dirname, '..');

// Workers: --jobs N, then POTACAT_TEST_JOBS, then every core but one (at least 2).
function defaultJobs() {
  const env = parseInt(process.env.POTACAT_TEST_JOBS, 10);
  if (env > 0) return env;
  return Math.max(2, os.cpus().length - 1);
}

function why(code, signal) {
  return `exit ${code}${signal ? ', ' + signal : ''}`;
}

function finish(list, failed) {
  if (failed.length) {
    console.error(`\n[run-tests] ${list.length - failed.length} of ${list.length} test files passed, ${failed.length} failed:`);
    for (const f of failed) console.error(`[run-tests]   ${f}`);
    process.exit(1);
  }
  console.log(`\n[run-tests] all ${list.length} test files passed`);
  process.exit(0);
}

// One file, its own Node process. inherit = live output (a file running alone);
// otherwise stdout and stderr are kept in one buffer, in arrival order.
function runFile(f, inherit) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [f], {
      cwd: root,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    if (!inherit) {
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', (c) => chunks.push(c));
    }
    let done = false;
    const end = (code, signal) => {
      if (done) return;
      done = true;
      resolve({ f, code, signal, out: Buffer.concat(chunks), ms: Date.now() - t0 });
    };
    child.on('error', (e) => { chunks.push(Buffer.from(String(e && e.stack || e) + '\n')); end(-1, null); });
    child.on('close', end);
  });
}

// --jobs 1: today's behaviour exactly. One file after another, live output.
async function runSerial(list) {
  const failed = [];
  let n = 0;
  for (const f of list) {
    const r = await runFile(f, true);
    n++;
    if (r.code !== 0) {
      const w = why(r.code, r.signal);
      failed.push(`${f} (${w})`);
      console.error(`\n[run-tests] FAILED: ${f} (${w}) — ${n} of ${list.length} run, continuing`);
    }
  }
  finish(list, failed);
}

async function runParallel(list, jobs) {
  const order = new Map(list.map((f, i) => [f, i]));
  const slow = SLOW_FIRST.filter((f) => order.has(f) && !SERIAL.has(f));
  const pool = slow.concat(list.filter((f) => !SERIAL.has(f) && !slow.includes(f)));
  const alone = list.filter((f) => SERIAL.has(f));
  const failed = [];
  let n = 0;
  const report = (r) => {
    n++;
    process.stdout.write(`\n[run-tests] ${r.f} (${(r.ms / 1000).toFixed(1)} s)\n`);
    if (r.out && r.out.length) process.stdout.write(r.out);
    if (r.code !== 0) {
      const w = why(r.code, r.signal);
      failed.push({ i: order.get(r.f), s: `${r.f} (${w})` });
      console.error(`\n[run-tests] FAILED: ${r.f} (${w}) — ${n} of ${list.length} run, continuing`);
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < pool.length) report(await runFile(pool[next++], false));
  };
  await Promise.all(Array.from({ length: Math.min(jobs, pool.length) }, worker));
  if (alone.length) console.log(`\n[run-tests] ${alone.length} file(s) that run alone (SERIAL):`);
  for (const f of alone) {
    process.stdout.write(`\n[run-tests] ${f} (alone)\n`);
    let r = await runFile(f, true);
    // A timing test that failed gets one more try (Casey 2026-11-22: "Retry
    // timing tests"). These three fail when another agent's suite loads the
    // machine; a pass on the retry is printed as FLAKY so it stays visible.
    // Only SERIAL files are retried; every other failure counts at once.
    if (r.code !== 0 && RETRY_ONCE.has(f)) {
      console.error(`\n[run-tests] RETRY: ${f} failed (${why(r.code, r.signal)}); a timing test, so one more try`);
      r = await runFile(f, true);
      if (r.code === 0) console.log(`\n[run-tests] FLAKY: ${f} passed on the retry`);
    }
    r.out = null;
    r.ms = 0;
    n++;
    if (r.code !== 0) {
      const w = why(r.code, r.signal);
      failed.push({ i: order.get(f), s: `${f} (${w})` });
      console.error(`\n[run-tests] FAILED: ${f} (${w}) — ${n} of ${list.length} run, continuing`);
    }
  }
  failed.sort((a, b) => a.i - b.i);
  finish(list, failed.map((x) => x.s));
}

// Runs every file in the list, continues past failures, prints the summary and
// exits (non-zero when any file failed). opts.jobs: worker count (1 = serial).
function runAll(list, opts = {}) {
  const jobs = opts.jobs > 0 ? opts.jobs : defaultJobs();
  if (jobs <= 1 || list.length <= 1) return runSerial(list);
  return runParallel(list, jobs);
}

const HELP = `node scripts/run-tests.js [options] [substring...]

  (no options)      every file in the TESTS list, in parallel (${defaultJobs()} workers here);
                    files in SERIAL run alone after the pool. Continues past failures.
  substring...      only the files whose path contains one of the substrings.
  --jobs N, -j N    N workers (also POTACAT_TEST_JOBS=N). --jobs 1 runs one file at a
                    time with live output, the way the runner always worked.
  --changed [base]  a quick filter for while you work: the tests that mention a file
                    changed since 'git merge-base HEAD <base>' (default origin/master)
                    or in the working tree, the changed test files, and this runner's
                    own checks. Prints each pick and why. It is NOT the full run: the
                    whole suite runs before every push (scripts/git-hooks/pre-push) and in CI.
  --help            this text.`;

function parseArgs(argv) {
  const o = { jobs: 0, changed: false, base: 'origin/master', filters: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--jobs' || a === '-j') o.jobs = parseInt(argv[++i], 10) || 0;
    else if (a.startsWith('--jobs=')) o.jobs = parseInt(a.slice(7), 10) || 0;
    else if (a === '--changed') {
      o.changed = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) o.base = argv[++i];
    } else if (a.startsWith('--changed=')) { o.changed = true; o.base = a.slice(10); }
    else o.filters.push(a);
  }
  return o;
}

module.exports = { TESTS, EXCEPTIONS, SERIAL, RETRY_ONCE, SLOW_FIRST, runAll, parseArgs, defaultJobs };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); process.exit(0); }
  let list = TESTS;
  if (o.changed) {
    const { pickChangedTests } = require('./changed-tests');
    const picked = pickChangedTests({ root, tests: TESTS, base: o.base, log: console.log });
    list = TESTS.filter((f) => picked.has(f));
    console.log(`[run-tests] --changed: ${list.length} of ${TESTS.length} test files (a quick filter, not the full run)`);
    if (!list.length) process.exit(0);
  }
  if (o.filters.length) list = list.filter((f) => o.filters.some((s) => f.includes(s)));
  runAll(list, { jobs: o.jobs });
}
