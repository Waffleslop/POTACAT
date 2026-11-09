# Desktop architecture decisions

One file per decision: what was decided, the report or bug that forced it, and the test that guards it. These were the "Key Architecture Decisions" of the old CLAUDE.md (159 KB), moved here on 2026-11-09 so an agent reads a decision when it touches that area instead of loading all of them every session. Text is verbatim. Add a new file for a new decision; never edit history, append a dated note.

Undated entries from the first months carry 2026-03-01 as a stand-in date and say so.

| Date | Decision | Size |
|---|---|---|
| 2026-11-02 | [What a record carries beyond the form](2026-11-02-what-a-record-carries-beyond-the-form.md) | 1 KB |
| 2026-10-24 | [rig-presets.js grown: FIELDS, rules, Guest Pass tune (appendix 10/24)](2026-10-24-rig-presets-js-grown-fields-rules-guest-pass-tune-appendix-1.md) | 1 KB |
| 2026-10-23 | [worked-overlay legend, LoTW detail, modem RX level (appendix 10/23)](2026-10-23-worked-overlay-legend-lotw-detail-modem-rx-level-appendix-10.md) | 1 KB |
| 2026-10-21 | [Desktop-to-desktop: the shack is the radio, its engines never move](2026-10-21-desktop-to-desktop-the-shack-is-the-radio-its-engines-never.md) | 3 KB |
| 2026-10-19 | [A contact is logged ONE way, from every surface: `logContact(entry)` (main.js) + `lib/qso-expand.js`](2026-10-19-a-contact-is-logged-one-way-from-every-surface-logcontact-en.md) | 3 KB |
| 2026-10-17 | [Flex Direct makes its own slice when the radio restores none](2026-10-17-flex-direct-makes-its-own-slice-when-the-radio-restores-none.md) | 2 KB |
| 2026-10-16 | ["Log as" another operator: one QSO into another profile's logbook, with THEIR settings, without switching](2026-10-16-log-as-another-operator-one-qso-into-another-profiles-logboo.md) | 2 KB |
| 2026-10-16 | [CI-V DATA mode is two bytes, and a three-DATA Icom re-selects the D-number the radio reported](2026-10-16-ci-v-data-mode-is-two-bytes-and-a-three-data-icom-re-selects.md) | 2 KB |
| 2026-10-15 | [A courtesy 73/RR73 leg ends when its message has been TRANSMITTED, never after a count of decode cycles](2026-10-15-a-courtesy-73-rr73-leg-ends-when-its-message-has-been-transm.md) | 2 KB |
| 2026-10-06 | [States in the watchlist](2026-10-06-states-in-the-watchlist.md) | 1 KB |
| 2026-10-04 | ["No CAT control (VOX)" is a radio type, and the wrong-band TX guard trusts only a LIVE dial](2026-10-04-no-cat-control-vox-is-a-radio-type-and-the-wrong-band-tx-gua.md) | 2 KB |
| 2026-09-26 | [Contests: the server resolves dates, clients display them](2026-09-26-contests-the-server-resolves-dates-clients-display-them.md) | 2 KB |
| 2026-09-26 | [Every `remoteServer` listener or one-time setter goes through `onRemoteServer(fn)`](2026-09-26-every-remoteserver-listener-or-one-time-setter-goes-through.md) | 1 KB |
| 2026-09-26 | [SSTV: a lock must earn its keep, and SSTV transmits in DATA mode on Icoms](2026-09-26-sstv-a-lock-must-earn-its-keep-and-sstv-transmits-in-data-mo.md) | 1 KB |
| 2026-09-25 | [Activation window + share image](2026-09-25-activation-window-share-image.md) | 1 KB |
| 2026-09-24 | [Station Setup: one checklist per radio, every tick MEASURED](2026-09-24-station-setup-one-checklist-per-radio-every-tick-measured.md) | 5 KB |
| 2026-09-20 | [A native helper is a pipe, and a radio setting POTACAT changes is a setting POTACAT restores](2026-09-20-a-native-helper-is-a-pipe-and-a-radio-setting-potacat-change.md) | 2 KB |
| 2026-09-19 | [A wattmeter reading has to be forwarded, a held paddle has to keep keying, and a scrolling toolbar must never change its own overflow](2026-09-19-a-wattmeter-reading-has-to-be-forwarded-a-held-paddle-has-to.md) | 3 KB |
| 2026-09-18 | [The SSTV decoder normalises its input; every amplitude gate in it is calibrated for -25 to -3 dBFS](2026-09-18-the-sstv-decoder-normalises-its-input-every-amplitude-gate-i.md) | 2 KB |
| 2026-09-18 | [Journal entries belong to an ACCOUNT, and sign-in asks the cloud what it is missing](2026-09-18-journal-entries-belong-to-an-account-and-sign-in-asks-the-cl.md) | 2 KB |
| 2026-09-17 | [The Cloud Tunnel's "Live" means POTACAT is answering behind it, not just that cloudflared is connected](2026-09-17-the-cloud-tunnels-live-means-potacat-is-answering-behind-it.md) | 4 KB |
| 2026-09-16 | [Rig setup notes are data, and they quote POTACAT, never a typed value](2026-09-16-rig-setup-notes-are-data-and-they-quote-potacat-never-a-type.md) | 2 KB |
| 2026-09-14 | [A CW message holds `_transmitting` for its envelope, and Kenwood `IF;` P8 is the radio's PTT](2026-09-14-a-cw-message-holds-transmitting-for-its-envelope-and-kenwood.md) | 7 KB |
| 2026-09-14 | [Icom Network addresses the radio the radio names, and the RS-BA1 glue's methods must exist](2026-09-14-icom-network-addresses-the-radio-the-radio-names-and-the-rs.md) | 2 KB |
| 2026-09-12 | [A Guest Pass revoke must reach the shack that is hosting the guest](2026-09-12-a-guest-pass-revoke-must-reach-the-shack-that-is-hosting-the.md) | 2 KB |
| 2026-09-12 | [Special events are DATA, and a checklist station can be a PLACE](2026-09-12-special-events-are-data-and-a-checklist-station-can-be-a-pla.md) | 5 KB |
| 2026-09-11 | [ECHOCAT Web over POTACAT Cloud — sign in at login.potacat.com, then a cookie, never a token box](2026-09-11-echocat-web-over-potacat-cloud-sign-in-at-login-potacat-com.md) | 4 KB |
| 2026-09-09 | [A chosen audio device is never silently replaced — on EITHER side of the radio](2026-09-09-a-chosen-audio-device-is-never-silently-replaced-on-either-s.md) | 2 KB |
| 2026-09-07 | [Hunt while activating: home is snapshotted, never set](2026-09-07-hunt-while-activating-home-is-snapshotted-never-set.md) | 3 KB |
| 2026-09-06 | [PTT follows the same radio owner as the tune path](2026-09-06-ptt-follows-the-same-radio-owner-as-the-tune-path.md) | 2 KB |
| 2026-09-06 | [A Host field may contain a pasted `host:port`](2026-09-06-a-host-field-may-contain-a-pasted-host-port.md) | 1 KB |
| 2026-08-05 | [A tune echoes its own frequency — the poll is a correction, not the source](2026-08-05-a-tune-echoes-its-own-frequency-the-poll-is-a-correction-not.md) | 2 KB |
| 2026-08-05 | [A spot's Log button follows the standalone Log QSO window](2026-08-05-a-spots-log-button-follows-the-standalone-log-qso-window.md) | 2 KB |
| 2026-08-04 | [Preamp/ATT are LADDERS, not switches](2026-08-04-preamp-att-are-ladders-not-switches.md) | 1 KB |
| 2026-03-01 | [Every QSO-log write goes through `lib/qso-log.js`, and the cloud copy is `buildAdifFields()`](2026-03-01-every-qso-log-write-goes-through-lib-qso-log-js-and-the-clou.md) | 2 KB |
| 2026-03-01 | [Settings secrets live in ONE registry](2026-03-01-settings-secrets-live-in-one-registry.md) | 1 KB |
| 2026-03-01 | [The activation's own program is STORED, never inferred at log time](2026-03-01-the-activations-own-program-is-stored-never-inferred-at-log.md) | 3 KB |
| 2026-03-01 | [Rig-scoped UI](2026-03-01-rig-scoped-ui.md) | 1 KB |
| 2026-03-01 | [CSP is strict](2026-03-01-csp-is-strict.md) | 1 KB |
| 2026-03-01 | [No require() in renderer](2026-03-01-no-require-in-renderer.md) | 1 KB |
| 2026-03-01 | [Spots sent after did-finish-load](2026-03-01-spots-sent-after-did-finish-load.md) | 1 KB |
| 2026-03-01 | [POTA API spotTime has no Z suffix](2026-03-01-pota-api-spottime-has-no-z-suffix.md) | 1 KB |
| 2026-03-01 | [Map world-wrapping](2026-03-01-map-world-wrapping.md) | 1 KB |
| 2026-03-01 | [Column widths](2026-03-01-column-widths.md) | 1 KB |
| 2026-03-01 | [Settings](2026-03-01-settings.md) | 1 KB |
| 2026-03-01 | [DX Cluster spots are streaming, not polled](2026-03-01-dx-cluster-spots-are-streaming-not-polled.md) | 1 KB |
| 2026-03-01 | [RBN spots are client-side filtered](2026-03-01-rbn-spots-are-client-side-filtered.md) | 1 KB |
| 2026-03-01 | [Map popup persistence](2026-03-01-map-popup-persistence.md) | 1 KB |
| 2026-03-01 | [TCI mirrors SmartSDR pattern](2026-03-01-tci-mirrors-smartsdr-pattern.md) | 1 KB |
| 2026-03-01 | [Bug reports are complete-from-launch](2026-03-01-bug-reports-are-complete-from-launch.md) | 1 KB |
