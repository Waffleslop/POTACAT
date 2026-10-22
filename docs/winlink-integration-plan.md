# Winlink email in POTACAT (desktop) and ECHOCAT (phone) — plan

## Status (2026-10-22): Phases 1 and 2 BUILT, not yet run against a real Pat

Built in one pass after Casey approved the plan:
- `lib/winlink-pat.js` (args, config, connect URLs, rmslist/message/websocket parsers),
  `lib/winlink-client.js` (HTTP + /ws; answers Pat's Ping with Pong, answers prompts),
  `lib/winlink-state.js`, `lib/rigctld-server.js` (the loopback shim),
  `lib/ardop-process.js` (launch + fresh device listing every launch), `lib/winlink-modes.js`.
- main.js "Winlink" section after `disconnectMercury()`: Pat sidecar per profile, shim,
  ardopcf, Mercury hand-off, sessions (30 s PTT failsafe, session cap, 3-minute
  no-progress watchdog), internet auto-check, ECHOCAT handler; the mail window
  (`renderer/winlink-popout.*`), Settings > Station > Winlink, More > Winlink Mail,
  the `**Winlink:**` bug-report line; `'winlink'` radio owner.
- ECHOCAT: capability `winlink`, `winlink-*` messages (owner only), web Mail tab.
- Packaging: `scripts/build-winlink-helpers.sh` builds the pinned tags in every release
  job (continue-on-error until the first green run); `third_party/pat`, `third_party/ardopcf`, NOTICE.
- Tests: `test/winlink-pat-test.js`, `test/winlink-units-test.js` (incl. a fake Pat over
  HTTP + websocket and a real loopback shim socket), `test/winlink-main-wiring-test.js`.

Facts settled from Pat's source while building (they replace the spike questions):
- RMS `dial` and `url` already carry the DIAL (centre − 1500 Hz for ARDOP/VARA); the
  connect URL uses it verbatim. Pat QSYs before and QSXes after the session itself;
  POTACAT restores the MODE afterwards.
- Pat reads ONE reply line per rigctld command — every shim reply is one line.
- `/api/reload` restarts Pat in-process; POTACAT reloads only when the VARA port must
  change between a Mercury and a VARA session.
- Prompts over /ws: `password` (answered from the profile), `busy-channel` and
  `account-activation` (the operator decides, on every surface), `multi-select` (accept all).
- ardopcf on Windows takes a device index or a name SUBSTRING (31-char names); POTACAT
  lists fresh and resolves the operator's chosen name before every launch.
- Pat's tag commits `web/dist`, so `CGO_ENABLED=0 go build` (Go >= 1.24) is the whole build.

Added the same day (Casey: "ARDOP then AX.25"; VARA not offered in the first release):
- **Packet (AX.25)** — 1,261 Winlink packet gateways (14 within 80 km of FN20, K3FZT-10 at 5 km).
  Dire Wolf 1.8.1 (GPL-2.0, separate exe) launched per session, built WITH Hamlib; its only PTT
  is `PTT RIG 2 127.0.0.1:<shim>`, so it keys through POTACAT. The shim speaks Hamlib's NET-rig
  handshake (`\dump_state` replayed from Hamlib 4.7.0's Dummy rig; proven by
  `test/rigctld-shim-hamlib-test.js` running the bundled rigctld as a client). Sound devices come
  from ardopcf's listing (same waveIn indices on Windows, same ALSA names on Linux). Session QSY
  in FM; Pat `ax25` engine `agwpe`. Windows/Linux; macOS later. Settings: packet speed 1200/9600.
- **VARA hidden** (`settings.winlinkShowVara` brings it back).
- ARDOP matcher fixed for ardopcf's 31-char names (real 26-device listing is a fixture); the
  connect URL is the gateway list's own (keeps `bw=2000MAX`).

**ARDOP over Flex Direct / Icom Network (2026-10-22, after the first on-air try):** with the rig on
DAX, ardopcf keyed in step and the radio's TX source was DAX, yet 0 W — the DAX TX endpoint took no
audio from ardopcf (nor from ffplay). Same fragility Flex Direct exists to avoid, so ardopcf got a
**socket audio backend** (`third_party/ardopcf/src/SocketAudio.c` + a generated patch): device
`tcp:<port>` → it takes RX audio from, and sends TX audio to, `lib/modem-audio-server.js` on
loopback (12 kHz s16, raw), which POTACAT feeds from the dax_rx / RS-BA1 frames and drains into
dax_tx / RS-BA1 voice TX while the shim holds PTT. No DAX, no sound card, no device picking on
those rigs. Packet (Dire Wolf) and Mercury still open a device; a Dire Wolf UDP/stdin variant is
the natural next step. CI: winlink-helpers now compiles the backend on all runners.

Still owed: a CI run of the helper builds (Dire Wolf's Windows build against the official
Hamlib zip is the least certain step); Phase 0's live checks with a real account
(telnet session, wrong password, registration); a dummy-load bench of the shim with real
Pat; an on-air ARDOP session; Mercury P2P between two scratch instances; reading
winlink.org's terms in a browser before release.

## Context

Casey (2026-10-22): extend the Mercury integration so POTACAT can send email via Winlink, legally, in a way that reaches ECHOCAT iOS/Android — "or maybe there's a better platform than Winlink?"

**The platform.** For ham-radio email with real reach (gateways on every band, EmComm acceptance, delivery to ordinary email addresses) Winlink is the only network. Alternatives weighed:
- JS8Call `@APRSIS` email/SMS and APRS `EMAIL-2`: one-way, ~60 characters, no inbox. POTACAT already has it (`js8-send-sms`, docs/js8-aprs-messaging-spec.md).
- Reticulum/LXMF, Meshtastic: mandatory encryption → unusable on US amateur bands (97.113(a)(4)); no email gateways.
- HERMES/UUCP over Mercury: Rhizomatica's closed community networks; no public gateways.
- **Mercury as the modem** (Casey asked): Mercury exposes VARA's TCP interface, so a Winlink client's "VARA HF" transport and a BPQ32 gateway's VARA driver can both be pointed at it; the first Winlink messages over Mercury went out in 2026 (KM6LYW with Pat; K7EK-10 and EA8URF test gateways). It is early: Rhizomatica/mercury #392 (15 Oct 2026) reports messages lost in most attempts, 1.9.19↔1.9.20 cannot connect, and Winlink has said nothing about supporting it. A handful of experiments, not a network. **ARDOP is the mature open modem the gateway network accepts.**

**Decisions (Casey, 2026-10-22):**
1. **Pat as a sidecar** (la5nta/pat, Go, MIT, v1.0.0) driven over its local HTTP JSON API — never a native B2F implementation.
2. **Modems: ARDOP (bundled) + Mercury (already launched by POTACAT) + VARA as an optional port field** (operator-installed and licensed; nothing of VARA in POTACAT).
3. **Phone through the shack only**: the phone composes and reads; the shack holds the mailbox, the account and the radio session (the desktop-to-desktop rule: the shack is the radio). No Winlink code on the phone.

**Outcome.** Winlink email from the POTACAT desktop (Phase 1 over the internet, Phase 2 over the radio with ARDOP / Mercury / VARA), mirrored to ECHOCAT Web and, via a handoff, the mobile app; PTT and QSY always through POTACAT's one dispatcher; everything bundled is open-source, built from pinned source in CI.

## Facts established (checked 2026-10-22)

| Fact | Source |
|---|---|
| Pat is MIT; v1.0.0 (19 Apr). Official binaries: win i386, mac amd64, linux amd64/arm64/armhf → we build from source in CI (`go build`, CGO off). | github.com/la5nta/pat LICENSE, releases |
| Pat HTTP API, **no auth** → bind 127.0.0.1 on a POTACAT-chosen port: `GET /api/mailbox/{in,out,sent,archive}`, `GET/DELETE /api/mailbox/{box}/{mid}`, `GET …/{attachment}`, `POST …/{mid}/read`, `POST /api/mailbox/out` (multipart `to, cc, subject, body, p2ponly, date` RFC3339 **required**, `files[]`), `/api/connect?url=` → `{"NumReceived":n}`, `/api/disconnect`, `/api/status`, `/api/rmslist`, `/api/qsy`, `GET/PUT /api/config`, `POST /api/reload`, `POST /api/posreport`, `POST /api/winlink-account/registration`, `…/password-recovery-email`, websocket `/ws`. | pat/api/api.go, api/mailbox.go |
| Pat flags `--config --mbox --log --event-log --forms --mycall --listen --send-only`; config keys `mycall secure_login_password locator http_addr connect_aliases listen hamlib_rigs ardop varahf varafm telnet`. | pat/main.go, pkg.go.dev cfg |
| Pat's hamlib client sends ONLY `dump_caps`, `\chk_vfo`, `\get_freq`, `\set_freq N`, `t`, `\set_ptt 0|1`; CRLF; bare value or `RPRT n`; 1 s timeout, 3 tries. A tiny rigctld-protocol server satisfies it. | wl2k-go/rigcontrol/hamlib/rigctld.go |
| ardopcf is MIT; v1.0.4.x; author has stopped development; Linux `make` + libasound2-dev; Windows MinGW-w64 `mingw32-make` (not MSVC); **no macOS**. `ardopcf [--logdir D] [-G port] --hostcommands "…" 8515 <cap#> <play#>`; with no `-p/-c/-g/-k/-u` it never keys the radio. Windows devices chosen by NUMBER from the list it prints at startup (numbers shift with USB changes). | pflarue/ardop docs/* |
| Mercury = VARA-compatible TNC (control 8300 / data 8301), already found/spawned by POTACAT (lib/mercury-client.js, lib/mercury-radio-bridge.js, main.js 7869–8195). Pat's `varahf` driver pointed at it = the Mercury transport. **One host connection at a time** → POTACAT hands the TNC to Pat for the session (docs/mercury-integration-plan.md Phase 7's "hand the TNC to Pat"). | repo; mercury.hermes.radio |
| Winlink: secure login mandatory; accounts purged after 400 days without a client connection (telnet counts); B2F spec is public and forbids client-side compression/encryption beyond the documented LZHUF; third-party clients are in normal use (Pat, RadioMail, Paclink); the Winlink web-services API (gateway list, registration) needs a developer key — Pat carries its own, which POTACAT inherits. `winlink.org/terms_conditions` answered 403 to the fetcher: **read it in a browser before release.** | winlink.org/B2F, FAQ |
| FCC: 97.113(a)(4) no codes to obscure meaning (B2F compression is published → fine; no TLS on RF); 97.113(a)(2–3) no business/pecuniary; 97.115 third-party traffic (international only where agreements exist); 97.109/97.221 the client station needs a control operator — automatic control is for the gateway → **RF connects are operator-initiated only, never scheduled**; 97.307(f) as amended by FCC 23-93: 2.8 kHz cap on the listed HF segments (ARDOP 500/2000 Hz, Mercury ≤2.7 kHz, VARA 2300/2750 Hz comply); 97.119 ID — the modem sends MYCALL. | eCFR; FCC 23-93 |
| POTACAT's NOTICE already states the combined work is GPLv3-or-later (JS8 codec). Pat and ardopcf are MIT and separate processes anyway (wsprd precedent: third_party/<name>/{LICENSE,README.md,VERSION.txt} + NOTICE entry). | NOTICE, third_party/wsprd |
| Audio: an external modem must open a real sound device (DAX on a Flex under Windows, the rig's USB CODEC, VB-Cable). Flex Direct on mac/Linux and Icom Network have **no path for external audio** (Mercury FIFO bridge never built, POSIX-only). | lib/mercury-audio-bridge.js, main.js 7900–7910 |
| POTACAT exposes no inbound CAT server today; `lib/radio-owner.js` OWNERS = none/jtcat/mercury. | lib/radio-owner.js |

## Design

### Architecture in one paragraph
POTACAT runs `pat http` as a sidecar per operator profile (like rigctld/Mercury: find → spawn → supervise → kill in `gracefulCleanup`), talks to it over `127.0.0.1:<free port>`, and caches the mailbox and session state in MAIN (JS8-threads precedent) so the popout, ECHOCAT Web and the phone all render one payload. For RF sessions Pat does the Winlink protocol and the modem does the audio; **PTT and QSY come back into POTACAT** through a loopback rigctld-protocol shim that Pat's `hamlib_rigs` points at (`ptt_ctrl: true` on every transport), so keying goes through `handleRemotePtt` under a new radio owner `'winlink'` with the Mercury-style 30 s failsafe, and QSY through `tuneRadio` so the SWR latch, JTCAT dial guard and rig presets all apply.

### Phases
**Phase 0 — Spike** (scratch `--user-data-dir`, throwaway scripts in the scratchpad; nothing in main.js):
| Check | Pass criterion |
|---|---|
| Pat builds with `CGO_ENABLED=0 go build` from the v1.0.0 tag (does the tag commit `web/dist`?) | a binary; else fall back to `scripts/fetch-pat.js` (prebuilt release binaries, pinned checksums, cloudflared-style) |
| `--config/--mbox/--log/--event-log` + `http_addr: 127.0.0.1:<port>` | binds loopback only; `GET /api/status` answers |
| API shapes: mailbox list/message, `POST /api/mailbox/out`, `/api/rmslist?mode=ardop`, `/ws` event names | saved as `test/fixtures/winlink/*.json` |
| Telnet session with a real account; a wrong password | `NumReceived`; the login-failure string captured for `classifyPatEvent` |
| `POST /api/winlink-account/registration` | request/response documented; decide: POTACAT registers in-app vs deep-link |
| Pat's hamlib client against a fake shim (`ardop.rig: potacat, ptt_ctrl: true`, `GET /api/qsy`) | all six commands observed; **confirm whether `freq=` is the dial or the centre** (a 1.5 kHz error misses the gateway) |
| ardopcf device listing on Windows | numbered lists captured as a fixture for `parseArdopDeviceList`; is there a list-only flag? |
| **Mercury transport P2P**: two scratch POTACATs, Pat `varahf.addr` = Mercury 8300 on each, `pat connect varahf:///OTHER` over a loopback audio pair | a Winlink message moves POTACAT↔POTACAT with no gateway; confirms the TNC hand-off |

**Phase 1 — Internet mail, every surface.** Pat sidecar + telnet; Winlink popout (folders, read with attachments, compose with attachments, delete, mark read, position report, account registration / password recovery, "Check mail (internet)", first-use notice); Settings block; per-profile password; ECHOCAT wire + web Mail tab; mobile handoff. Zero RF risk; keeps accounts alive.

**Phase 2 — Over the radio: ARDOP, Mercury, VARA.** `lib/rigctld-server.js` shim; ardopcf sidecar (Windows/Linux CI build); Mercury transport (POTACAT disconnects its own `mercuryClient` from the TNC for the session, Pat's `varahf` points at `mercuryBasePort`; Pat keys via the shim from Mercury's `PTT ON/OFF`); VARA = `winlinkVaraPort` field, Windows, operator-installed (copy says "set VARA's PTT to None"); gateway picker from `/api/rmslist` (mode, band filter, Pat's distance order; Mercury gateways are listed by Winlink as VARA HF — the picker shows them under Mercury only when the operator tags a gateway as Mercury-capable, plus `winlinkMercuryGateways` free list); **Connect is a button, never a timer**; QSY → DIGU → acquire `'winlink'` → `/api/connect` → PTT via shim → release → refresh; per-rig-family gating (`lib/winlink-modes.js`); session progress on every surface; `[Winlink]` log lines and a bug-report line.

**Phase 3 — Documented only.** P2P via Pat `listen` (the Mercury P2P spike made product); VARA FM / Direwolf packet for VHF gateways; Pat forms catalog (ICS-213); macOS ARDOP if a CoreAudio backend appears; if Winlink ever lists Mercury as a mode, the picker filter becomes automatic.

### New files
| File | Responsibility | Pure/testable surface |
|---|---|---|
| `lib/winlink-pat.js` | Pat launch decisions (mirror of `lib/mercury-process.js`) | `patBinaryName`, `patPathCandidates({settings,isPackaged,resourcesPath,appDir,platform})`, `buildPatArgs({configPath, mboxDir, logPath, eventLogPath, formsDir})` (always `http`; never `--listen`/`--send-only`), `buildPatConfig({mycall, password, locator, httpPort, shimPort, transport:{ardopPort, ardopBw, varaAddr, varaBw}})` (never writes `schedule`; `listen: []`; Phase-1 shape omits rigs/modems), `connectUrl({mode, gateway, freqKhz, bw})`, `normalizeRmslist(json,{band})`, `normalizeMailbox`, `normalizeMessage`, `classifyPatEvent(wsEvent)` → progress/status/login-failed/busy/no-answer/log, `composeFields` |
| `lib/winlink-client.js` | HTTP + `/ws` client to Pat (global `fetch`, `ws` dep); EventEmitter | `mailbox, message, attachment, markRead, delete, send, connect(url), disconnect, rmslist, status, putConfig, reload, posreport, register, passwordRecovery`; injectable timeout |
| `lib/winlink-state.js` | Mail/session cache in MAIN | `WinlinkState`: `applyMailbox, applyMessage, markRead, remove, setSession, applyProgress, setGateways, setModes, snapshot(), totalUnread, clear` |
| `lib/rigctld-server.js` | Loopback rigctld-protocol server for Pat | pure `parseRigctldLine`, `rigctldReply(parsed, hooks)`; impure `createRigctldServer(hooks, {host:'127.0.0.1'})` — throws on any other host |
| `lib/ardop-process.js` | ardopcf launch decisions | `ardopPathCandidates`, `buildArdopArgs` (asserts no `-p/-c/-g/-k/-u`), `parseArdopDeviceList`, `resolveArdopDevices({captureLabel, playbackLabel, devices})` (label token match like `findMissingMercuryDevices`), `classifyArdopLine` |
| `lib/winlink-modes.js` | dual-mode gating of telnet/ardop/mercury/vara per rig family, OS, audio source | `winlinkModesFor({rigFamily, audioSource, platform, mercuryEnabled, varaPort})` → `[{id, available, reason}]` |
| `renderer/winlink-popout.html/.js`, `preload-winlink-popout.js` | the mail window (folders, list, read, compose, session panel, gateway picker, notice) | state arrives as `winlink-state` payloads |
| `assets/pat/`, `assets/ardopcf/` | CI outputs → `extraResources` → `resources/bin` | |
| `third_party/pat/`, `third_party/ardopcf/` `{LICENSE, README.md, VERSION.txt}` + NOTICE entries | attribution (wsprd precedent) | wiring test |
| `scripts/build-ardopcf.sh` | one build line for the Linux/MSYS2 jobs | |
| `docs/winlink-integration-plan.md` | this plan, kept with the code | |
| `D:\Projects\potacat-app\docs\desktop-handoffs\winlink-mail.md` | mobile handoff (format of `rig-presets.md`) | |
| Tests: `test/winlink-pat-test.js`, `winlink-state-test.js`, `rigctld-server-test.js`, `ardop-process-test.js`, `winlink-modes-test.js`, `winlink-main-wiring-test.js`, fixtures `test/fixtures/winlink/` | | |

### Existing files and hook points
| File | Where | Change |
|---|---|---|
| `main.js` | `GLOBAL_KEYS` L660 | `winlinkPatPath`, `winlinkArdopPath`, `winlinkVaraPort`, `winlinkArdopPort` (machine) |
| `main.js` | state block ~L1633 | `patProc, patClient, winlinkState, winlinkShim, ardopProc, winlinkTxActive, failsafe/cap/auto-check timers, winlinkPopoutWin` |
| `main.js` | `acquireRadio` L7742 preempted branch | `else if (d.preempted === 'winlink') winlinkAbortSession('preempted')` |
| `main.js` | after `disconnectMercury` L8197 | new Winlink section: `findPat, writePatConfig, spawnPat` (stdout flood guard as `spawnMercury`), `killPat, connectWinlink, disconnectWinlink, winlinkPush()` (popout + `remoteServer.broadcastWinlinkState`), `winlinkRefreshMailboxes, winlinkStartSession({mode, gateway, freqKhz}), winlinkEndSession, winlinkAbortSession, armWinlinkTxFailsafe/clear` (clone of L7772), `startWinlinkShim/stop`, `spawnArdop/killArdop/diagnoseArdop`, `winlinkHandMercuryToPat()/takeMercuryBack()` (disconnect/reconnect `mercuryClient`), `winlinkDiagLine()` |
| `main.js` | `handleRemotePtt` L21296, `tuneRadio` L27687 | **no change**; the shim calls them (`{audio:true, forceDataMode:isIcom}` as SSTV L31476; `tuneRadio(kHz,'DIGU',undefined,{origin:'winlink'})`) |
| `main.js` | startup L28726; settings-changed L36461 | `if (settings.enableWinlink) connectWinlink()`; `winlinkChanged` relaunch gate (enable, paths, ports, password, call/locator) |
| `main.js` | `openMercuryPopout` region L31005 | `openWinlinkPopout`, IPC `winlink-popout-open` (`refuseRemoteFeature('winlink')` for RF-only commands), `winlink-cmd-*`, `winlink-pick-attachments` |
| `main.js` | `open-external` allowlist L33534 | `https://winlink.org/`, `https://www.winlink.org/`, `https://getpat.io/`, `https://github.com/la5nta/`, `https://github.com/pflarue/`, `https://rosmodem.wordpress.com/` |
| `main.js` | `connectRemote()` L18161 / `onRemoteServer` L1718 | all `winlink-*` listeners (rewire test) |
| `main.js` | `gracefulCleanup` L39600 | `disconnectWinlink({quit:true})` after the first `handleRemotePtt(false)`, before `killRigctld()` |
| `main.js` | diagnostic snapshot build (~L4028) | `winlink: winlinkDiagLine()` → bug reports |
| `lib/radio-owner.js` | OWNERS | `+ 'winlink'` |
| `lib/settings-secrets.js` | SECRET_KEYS | `+ 'winlinkPassword'` |
| `lib/remote-features.js` | FEATURES | `winlink: 'here'` for mail; RF connect greyed in remote mode with the reason |
| `lib/echocat-protocol.js` | MESSAGES (`feature:'winlink'`) | the wire table below |
| `lib/remote-server.js` | capabilities L2882; demux L3251; `_replyWs` L4776 / `_sendToAll` L4794; `_hydrateClient` L5242 | `'winlink'`; one case per C2S with the Guest Pass refusal first; `broadcastWinlinkState`, `sendWinlinkReply`, `_sendWinlinkHydration` (owner only) |
| `preload.js`; `renderer/index.html` L197 + after L2984; `renderer/app.js` L1338/2016/5067/16340/17200/17249 | Mercury-block mirror: `view-winlink-btn`, Settings ▸ Station ▸ "Winlink (email over radio)" |
| `renderer/remote.html` L934–947 / L1313; `renderer/remote.js` L1559 `handleMessage`, L6509 `switchTab`, L9221 `TAB_DEFS` | Mail tab with unread badge |
| `package.json` build.files / extraResources / scripts.test | third_party licences; `assets/pat → bin`, `assets/ardopcf → bin`; new tests in the chain |
| `.github/workflows/release.yml` | every job | `actions/setup-go` + `CGO_ENABLED=0 go build` Pat (pinned tag) on win/mac arm64/mac x64/linux; ardopcf `mingw32-make` on Windows MSYS2, `make` on Linux (libasound2-dev); none on mac; `test -f` gates like wsprd |
| `NOTICE` | third-party list | Pat and ardopcf: separate executables, never linked |
| existing tests | `radio-owner-test`, `protocol-demux-parity-test`, `external-links-allowed-test`, `remote-server-rewire-test`, `fresh-install-defaults-test`, `window-lifecycle-test` | updated for the new owner/messages/links/popout |

### Settings keys
| Key | Scope | Default |
|---|---|---|
| `enableWinlink` | profile | `false` |
| `winlinkPassword` | profile, **secret** | `''` |
| `winlinkNoticeAcceptedAt` | profile | `''` (compose/connect disabled until set) |
| `winlinkTelnetAutoCheck` / `winlinkTelnetAutoCheckMin` | profile | `false` / `30` (internet only, by construction) |
| `winlinkDefaultMode` | profile | `'telnet'` (telnet/ardop/mercury/vara, coerced to an available one) |
| `winlinkBand`, `winlinkLastGateway`, `winlinkMercuryGateways` | profile | `''`, `null`, `[]` |
| `winlinkArdopBw` / `winlinkVaraBw` | profile | `500` / `2300` |
| `winlinkSessionCapMin` | profile | `30` (10–60) |
| `winlinkPopoutBounds` | profile | — |
| `winlinkPatPath`, `winlinkArdopPath`, `winlinkArdopPort`, `winlinkVaraPort` | **global** | `''`, `''`, `8515`, `8300` — VARA and Mercury both enabled on one port is refused with a log line |
| `rig.winlinkAudio` | on the rig | absent → labels from `rig.remoteAudioInput/Output` at Discover time |
| Pat http port, shim port | chosen at launch | first free in 8590–8599 / 4540–4549 (`net.createServer` probe idiom, L17724) |

### rigctld shim (`lib/rigctld-server.js`)
| Pat sends | Reply | Action |
|---|---|---|
| `dump_caps` | `Model name:\tPOTACAT` | ping |
| `\chk_vfo` | `CHKVFO 0` | Pat uses CurrentVFO |
| `\get_freq` | bare Hz | `_currentFreqHz` |
| `\set_freq <hz>` | `RPRT 0` / `RPRT -1` | `tuneRadio(hz/1000,'DIGU',…,{origin:'winlink rigctld shim'})`; refused unless owner is `'winlink'` and the SWR latch is clear |
| `t` | `0`/`1` | `winlinkTxActive` |
| `\set_ptt 1|3` | `RPRT 0` / `RPRT -1` | `handleRemotePtt(true,{audio:true, forceDataMode:isIcom})` + failsafe; refused unless a session is armed |
| `\set_ptt 0` | `RPRT 0` | clear failsafe, `handleRemotePtt(false)` |
| other | `RPRT -11` | |
Loopback only; replies are written before the async CAT work (Pat's 1 s timeout).

### Pat config POTACAT writes (`profiles/<CALL>/winlink/pat-config.json`, regenerated per launch and per RF session via `/api/reload`)
```json
{ "mycall": "K3SBP", "secure_login_password": "…", "locator": "FN20", "http_addr": "127.0.0.1:8591",
  "connect_aliases": { "telnet": "telnet://{mycall}:CMSTelnet@cms.winlink.org:8772/wl2k" }, "listen": [],
  "hamlib_rigs": { "potacat": { "address": "127.0.0.1:4541", "network": "tcp" } },
  "ardop":  { "addr": "127.0.0.1:8515", "rig": "potacat", "ptt_ctrl": true, "arq_bandwidth": { "Forced": false, "Max": 500 }, "beacon_interval": 0, "cwid_enabled": true },
  "varahf": { "addr": "127.0.0.1:8300", "rig": "potacat", "ptt_ctrl": true, "bandwidth": 2300 } }
```
`varahf.addr` is Mercury's control port for a Mercury session and `winlinkVaraPort` for a VARA session (one `varahf` slot in Pat; POTACAT rewrites + reloads before connecting). Phase 1 omits `hamlib_rigs`/`ardop`/`varahf`.

### ECHOCAT wire (hello capability `winlink`)
| Type | Dir | Fields |
|---|---|---|
| `winlink-state` | S2C | `enabled, patReady, mycall, hasPassword, noticeAccepted, mode, modes[{id,available,reason}], unread, counts{in,out,sent,archive}, session{state,gateway,mode,freqKhz,progress,startedAt,capSec,error}, autoCheck{enabled,min,lastAt}` — hydrated at connect (owner only), pushed to all |
| `winlink-mailbox` | S2C | `box, messages[{mid,from,to,subject,date,read,size,attachments}], reqId?` |
| `winlink-message` | S2C | `box, mid, message{from,to,cc,subject,date,body,attachments[{name,size}]}, reqId` (asker) |
| `winlink-attachment` | S2C | `mid, name, dataUrl, reqId` (≤2 MB) |
| `winlink-gateways` | S2C | `mode, band, list[{call,freqKhz,dialKhz,mode,bw,distKm,bearing,grid}], reqId` |
| `winlink-session` | S2C | `state idle|connecting|connected|disconnecting|done|error, gateway, mode, freqKhz, text, pct, sent, received, ptt, remainingSec, error` (all) |
| `winlink-result` | S2C | `ok, op, error?, reqId` (asker) |
| `winlink-refused` | S2C | `reason guest-pass|disabled|remote|radio-busy, reqId?` |
| `winlink-list`, `winlink-read`, `winlink-attachment-get`, `winlink-delete` | C2S | `box, mid?, name?, reqId?` |
| `winlink-compose` | C2S | `to, cc?, subject, body, p2p?, attachments?[{name,dataBase64}], reqId?` (refused until `noticeAccepted`; 2 MB cap) |
| `winlink-connect` / `winlink-disconnect` / `winlink-abort` | C2S | `mode, gateway?, freqKhz?, reqId?` (RF refused when unavailable or radio busy) |
| `winlink-gateways-get`, `winlink-posreport`, `winlink-accept-notice`, `winlink-set-mode` | C2S | `mode, band?` / `lat?, lon?, comment?` / — / `mode` |
Guest Pass: every C2S → `winlink-refused {guest-pass}`, no hydration. Multi-client: replies to the asker, state/mailbox/session to all. Registration and password recovery are desktop-only.

### Sidecar lifecycle
| Process | Starts | Stops |
|---|---|---|
| Pat | `enableWinlink` at startup / on enable / after a relaunch-relevant key change | disable, quit, profile switch (app relaunch) |
| shim | with Pat when any RF mode is available (Phase 2); `set_ptt` answers `RPRT -1` outside a session | with Pat |
| ardopcf | when the popout selects ARDOP (so device errors surface before Connect) and on `winlink-connect {ardop}`; devices mapped from labels at every launch | popout closed with no session (60 s), mode/rig change, disable, quit |
| Mercury TNC hand-off | `winlink-connect {mercury}`: POTACAT's `mercuryClient` disconnects, Pat connects | session end: Pat `/api/disconnect`, `mercuryClient` reconnects (re-LISTEN if `mercuryListen`) |
| VARA.exe | never launched by POTACAT; pointed at only | — |
| radio owner `'winlink'` | `winlinkStartSession` before QSY | `winlinkEndSession` on success/error/abort/failsafe/quit |

### Operating rules encoded as behaviour
- RF connects only from the Connect button / `winlink-connect`; `buildPatConfig` never writes `schedule`, `buildPatArgs` never passes `--listen` (tests); the telnet auto-check refuses non-telnet by construction.
- First-use notice gates compose and connect (amateur use only, no business traffic, nothing needing privacy, international third-party traffic only where permitted); same text on every surface.
- Identification = the modem's (MYCALL = profile callsign; ARDOP `cwid_enabled`).
- 30 s rolling PTT failsafe (re-armed on each `\set_ptt 1`); **session cap 30 min default with a visible countdown + a 3-minute no-progress watchdog** (not a 10-minute cut: ID is the modem's job, a message with an attachment at 500 Hz legitimately runs longer, and a mid-transfer cut wastes the gateway's time; the real risks — a stalled session and an inattentive operator — are the watchdog and the ever-present Abort).
- Icom: session QSY to `DIGU`, so `rigPresetOnMode` fires the digital preset for free; `forceDataMode` on PTT as SSTV.
- After a session: no silent restore; the previous dial/mode is logged and offered as a "Return to 14.250 USB" button.

### Failure modes → log tells (`[Winlink]`, one actionable line each)
Pat missing (ENOENT → "bundled copy missing; set its path in Settings"), no free API port, Pat refuses config (last stderr line + config path, no respawn loop), API never answers (10 s watchdog + pat.log path), CMS login failed (password never logged), no password set, ardopcf missing/not this OS (mode greyed with reason), ardopcf device missing (`"USB Audio CODEC" not in ardopcf's list (3 found) — re-pick in Settings`), ardopcf port busy (another ARDOP running), VARA not reachable, VARA/Mercury port clash, gateway busy / no answer (release, unkey, suggest the next gateway), radio busy (`acquireRadio` refused → `winlink-refused {radio-busy}`), SWR guard tripped (session not started), stuck PTT (failsafe + abort), session cap, Pat died mid-session (unkey, release, kill ardopcf), attachment too large.

### Tests
| Test | Covers |
|---|---|
| `winlink-pat-test.js` | candidates order; args always `http`, never `--listen/--send-only`; config loopback-only, no `schedule`, `ptt_ctrl:true` + `rig:'potacat'` when a shim port is given, Phase-1 shape has no modems; `connectUrl` incl. `bw`/`freq`; rmslist band filter keeps order; `classifyPatEvent` on fixtures |
| `winlink-state-test.js` | unread/markRead/remove, snapshot shape, session transitions, progress merge |
| `rigctld-server-test.js` | the six commands + unknown; refusal when not armed; CRLF/LF; real socket round-trip on 127.0.0.1; any other host throws |
| `ardop-process-test.js` | args never carry `-p/-c/-g/-k/-u`; device-list fixture; label→index incl. missing and shifted numbers |
| `winlink-modes-test.js` | telnet everywhere; ardop unavailable on darwin and for Flex Direct/Icom Network audio with the reason; mercury only when Mercury is enabled; vara Windows-only and port-clash |
| `winlink-main-wiring-test.js` | SECRET_KEYS, GLOBAL_KEYS, OWNERS, listeners inside `onRemoteServer`/`connectRemote`, `gracefulCleanup` calls `disconnectWinlink`, shim PTT path calls `handleRemotePtt(` with `audio: true`, `createRigctldServer(` given `'127.0.0.1'`, no timer path reaches `winlinkStartSession` with a non-telnet mode, hello capabilities include `'winlink'`, NOTICE names Pat + ardopcf, extraResources entries |

## Verification (always a scratch `--user-data-dir`; never Casey's own POTACAT)
1. Phase 0 table above; fixtures saved.
2. Phase 1: enable in the scratch profile with a test account → `[Winlink] Pat ready on 127.0.0.1:859x`; Check mail → `NumReceived`; compose to the same account with a small attachment → Sent, then Inbox on the next check; unread badge survives closing the popout; delete; position report on winlink.org's map; wrong password → the login-failed line, password absent from Report a Bug.
3. ECHOCAT: a paired browser sees the Mail tab hydrated; a second client sees the push; a Guest Pass gets `winlink-refused` and no hydration; `node test/protocol-demux-parity-test.js`.
4. Phase 2 bench (dummy load): shim with a fake Pat, then real `/api/qsy` → dial moves, USB-D, rig-preset log line; `\set_ptt 1` keys and the failsafe fires at 30 s with no `\set_ptt 0`; JTCAT running → `[radio] winlink could not take the radio`.
5. ardopcf: unplug the CODEC → device-missing line, no launch; replug → numbers shifted, resolved by label.
6. Mercury transport: two scratch instances P2P over a loopback audio pair; then one of the Mercury-capable test gateways if reachable.
7. On air: nearest 40 m ARDOP gateway, Connect, progress on popout + web + phone, mail transfers, radio released, mode logged; Abort unkeys within a frame; countdown and watchdog visible.
8. Quit mid-session → PTT off first, Pat/ardopcf gone, Mercury client back.
9. Packaging: a CI build on a branch carries `resources/bin/pat(.exe)` everywhere and `ardopcf(.exe)` on Windows/Linux; licences present; `VERSION.txt` match the built tags.

## Handoffs and records (desktop-only rule)
- Mobile: `potacat-app/docs/desktop-handoffs/winlink-mail.md` (wire table above, `echocatProtocol.ts` mirror lines, suggested UI: Mail tab with folders/compose/session panel, gate on capability).
- Docs/website: a message to the `potacat docs` / `potacat website` sessions after Phase 1 ships (setup page: account, password, the notice, ARDOP audio devices, VARA "PTT None").
- Memory: `project_winlink_mail.md` + a feedback note that Casey prefers open modems (ARDOP/Mercury) and dislikes VARA.
- Append to `D:\alan\decisions.md`: Pat sidecar; ARDOP + Mercury + VARA-field; phone through the shack.

## Risks
- Pat's web bundle may not be committed at the tag → build `web/` in CI or fetch prebuilt binaries (decide in the spike).
- `freq=` dial-vs-centre semantics — pinned by the spike and a test.
- ardopcf is discontinued; kept as a separate exe behind the mode gate so dropping it costs nothing.
- Mercury Winlink is experimental (open message-loss bug, version lock-step); labelled as such in the UI; the P2P path is the dependable use.
- Port 8300 is both VARA's and Mercury's default; the clash check covers it.
- VARA with its own PTT configured would double-key; Settings copy says "set VARA PTT to None".
- No external audio path on Flex Direct (mac/Linux) and Icom Network → RF modes hidden there with the reason.
- `/api/connect` is a long call; the session state machine treats a dropped `/ws` as `error`.
- Mail privacy: owner-only hydration; bodies never logged; the password is in SECRET_KEYS and redacted from reports.
