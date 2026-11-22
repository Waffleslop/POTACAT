# Mercury as a bundled Winlink modem: the plan

Filed 2026-11-22. Status: plan only. Nothing here is built yet beyond what "What exists" lists.

Mercury is experimental. It is a young modem that changes every week or two, few Winlink
gateways run it, and no Mercury Winlink session has completed in POTACAT's hands. Every
surface that offers it says "experimental", and so does every release note that mentions it.

## 1. The goal

An operator picks "Mercury (radio, experimental)" in the mail window's Send via, picks a
Mercury gateway from a list, and sends and receives Winlink mail. POTACAT does the rest, as it
already does for ARDOP (bundled ardopcf) and packet (bundled Dire Wolf):

- POTACAT ships a Mercury it built itself from a pinned upstream commit, on every system it
  ships for.
- POTACAT starts Mercury when the session starts and stops it when the session ends.
- Pat (bundled) speaks Winlink to Mercury over Mercury's TCP TNC.
- POTACAT owns the radio: the dial, the mode, PTT and, where it can, the audio.
- Nothing transmits unless the operator asked for this session.

## 2. What exists (master, 2026-11-22)

### The July 2026 Mercury chat and file feature
Built 2026-07-14 (`docs/mercury-integration-plan.md`). It has never been proven on the air.

| Piece | File | State |
|---|---|---|
| Find, configure and launch Mercury | `lib/mercury-process.js` (+ main.js `findMercury`, `spawnMercury`, `killMercury`) | Works. Pins `radio_model = -1` in the ini it writes, passes no `-R/-A/-S`. Finds a user-installed binary; nothing is bundled (`third_party/mercury/README.md` is a scaffold). |
| TNC client | `lib/mercury-client.js` | Works against a fake Mercury in tests. Parses the VARA-style control lines. |
| PTT bridge | `lib/mercury-radio-bridge.js` | `PTT ON/OFF` from Mercury keys POTACAT's own PTT, with a 30 s rolling failsafe. |
| One owner of the radio | `lib/radio-owner.js` | `none / jtcat / mercury / winlink`. |
| Audio strategy | `lib/mercury-audio-bridge.js` | Format helpers and the device-or-FIFO choice. The FIFO pump (phase 4b) was never built, so every rig uses a sound device Mercury opens itself. |
| Chat and file window | `renderer/mercury-popout.*` | Built, never used on the air. |

On the developer's station Mercury's ARQ TNC never opened: both audio device ids in its ini
were stale DAX endpoints that SmartSDR had deleted. Commit 8490f71 (2026-08-05) made Mercury's
stdout visible and added diagnostics. The lesson for this plan: a modem that opens its own
sound card by a stored id fails silently when that id goes away.

### Winlink
- Pat 1.0.1 is bundled, built from a pinned tag with one POTACAT patch
  (`third_party/pat/`, `scripts/build-winlink-helpers.sh`).
- ardopcf and Dire Wolf are bundled the same way, each with a POTACAT socket-audio patch
  (`third_party/ardopcf/potacat-socket-audio.patch`, `third_party/direwolf/...`). With the
  device set to `tcp:<port>`, the modem opens no sound card. POTACAT serves the radio's audio on
  a loopback port (`lib/modem-audio-server.js`) and carries it over Flex Direct, Icom Network or
  a sound device it opens itself.
- `.github/workflows/winlink-helpers.yml` builds and smoke-tests all three on Windows
  (windows-2022, MSYS2), Linux (ubuntu-22.04 and ubuntu-22.04-arm) and macOS (macos-15 and
  macos-15-intel), and runs the two-modems-no-radio loopback tests. `release.yml` builds them
  into every installer; `package.json` copies them to `resources/bin` (Dire Wolf to its own
  folder).
- A Mercury Winlink session is already wired and then switched off. `lib/winlink-modes.js` has
  `MERCURY_OFFERED = false` (#372, 2026-11-12: "no Winlink gateway runs it"). Behind that flag,
  main.js `winlinkStartSession` hands Mercury's TNC to Pat (`winlinkHandMercuryToPat`), points
  Pat's `varahf` transport at Mercury's port, and runs the same session as VARA HF.
- The operator can tag gateways as Mercury by hand (`settings.winlinkMercuryGateways`).

## 3. Licence check

Verdict: **POTACAT may bundle Mercury** as a separate program it builds from pinned source,
under the same mere-aggregation posture as Dire Wolf (GPL-2.0) and wsprd. No new licence
question arises, provided the build leaves out the optional libraries below.

| Component | Licence | In our build? | Source |
|---|---|---|---|
| Mercury | GPL-3.0-or-later | yes, the `mercury` engine binary only | README and `LICENSE`, https://github.com/Rhizomatica/mercury |
| FreeDV / codec2 data modes, vendored subset | LGPL-2.1 | yes, compiled into the engine | `LICENSE-freedv` in the repo; README "The FreeDV codec is vendored in-tree" |
| iniparser, vendored | MIT | yes | `common/iniparser/LICENSE` |
| ffaudio / ffbase, vendored | Unlicense (public domain) | yes | `audioio/ffaudio/UNLICENSE` |
| MinGW winpthread, libgcc (Windows static link) | MIT-style / GCC runtime exception | yes, Windows | the toolchain; same as ardopcf today |
| Hamlib | LGPL-2.1 | **no**: `HAVE_HAMLIB=0`. POTACAT keys the radio; Mercury never needs it. | `radio_io/hamlib-*/COPYING.LIB.txt` |
| hidapi | BSD / GPL-3 / HIDAPI (choice) | **no**: `HAVE_HIDAPI=0` | `radio_io/hidapi-*/LICENSE*.txt` |
| OpenSSL (wss for the UI websocket) | Apache-2.0 | **no**: `WS_TLS=0`, `ui_enabled = false` | Makefile comment at the `macos-universal` target |
| Fyne GUI (`mercury-ui`, Go) and its vendored GLFW | BSD / zlib | **no**: POTACAT ships the engine only | `gui_interface/fyne-ui/` |

LGPL-2.1 code combined into a GPL-3.0 program is allowed (LGPL-2.1 section 3 lets it be
relicensed under the GPL). The combined Mercury binary is GPL-3.0.

What POTACAT does to keep the GPL off its Apache-2.0 files, as it does for Dire Wolf:
- Mercury runs as its own process. POTACAT and Pat talk to it only over TCP. Nothing links it.
- `third_party/mercury/` holds `LICENSE` (GPL-3.0 text), `LICENSE-freedv`, `VERSION.txt` (tag,
  full commit hash, URL), `README.md`, and any POTACAT patch as a `.patch` file with its
  generator script, as for ardopcf.
- A `NOTICE` entry in the same words as Dire Wolf's: "independent, separate program, mere
  aggregation", with the source URL and the pinned commit.
- The corresponding source is the pinned public commit plus our patch in this public repo.
  GPL-3.0 section 6(d) is satisfied by pointing to both from the NOTICE and the README.
- A POTACAT patch to Mercury is itself GPL-3.0 (it modifies GPL code). It lives in
  `third_party/mercury/` under the GPL, not under Apache-2.0, and its header says so.
- ECHOCAT is untouched: it never receives Mercury code, only Winlink state over the existing
  ECHOCAT protocol.

Before the first release that ships it, re-run this table against the pinned commit. Mercury
moves fast, and a new vendored library would change the answer.

## 4. Builds per OS

Upstream state (checked 2026-11-22):
- Build system: plain `make` with a shared `config.mk`. No CMake. The engine is C (gnu11,
  pthreads). The optional GUI needs Go 1.26.9; we do not build it.
- Newest release on 2026-11-22: **1.9.25, 2026-11-21, tag commit 33efac4e3089f64f493fde1232b8e96305d15185**
  (https://github.com/Rhizomatica/mercury/releases). Upstream ships a Windows x64 zip and
  installer (MinGW cross-compiled on Debian), a universal macOS .dmg (`make macos-universal`,
  clang per arch then `lipo`), an Android .apk and an iOS .ipa. **No Linux binary is
  released**; Linux users build from source or use the `debian/` packaging.
- 1.9.25's release notes say it "does not connect to 1.9.24 or any older version, in either
  direction". Mercury's air protocol is not stable yet. This matters for the pin (section 4.3).

### 4.1 Per OS

| Target | Upstream | POTACAT build | Audio backends in the binary | Status |
|---|---|---|---|---|
| Windows x64 | Built and released (MinGW cross) | MSYS2 MINGW64 on windows-2022 in `winlink-helpers.yml`, or a Debian MinGW cross job as upstream does. `HAVE_HAMLIB=0 HAVE_HIDAPI=0 WS_TLS=0`, static libgcc and winpthread. | wasapi, dsound, hl2. **No fifo, sock or rtp** (all three are `#ifndef _WIN32` in `audioio/audioio.c`). | Should build; to prove in CI. |
| macOS arm64 | Built (universal dmg; unit tests on arm64 since 1.9.25) | macos-15 runner, `clang -arch arm64`, `WS_TLS=0` | coreaudio, fifo, sock, rtp, hl2 | Should build; to prove in CI. Needs signing with the app's identity like the other helpers. |
| macOS x64 | Built (universal dmg) | macos-15-intel runner, or one `make macos-universal` on macos-15 | as arm64 | Same. |
| Linux x64 | Source only | ubuntu-22.04, gcc, `libasound2-dev libpulse-dev`, `HAVE_HAMLIB=0` | alsa, pulse, oss, fifo, sock, rtp, hl2 | Should build. Upstream CI uses Debian 13 and ubuntu-26.04, so building on 22.04 (our glibc floor) is the thing to prove. |
| Linux arm64 | Upstream CI cross-compiles (Debian 13) | ubuntu-22.04-arm, native | as x64 | Same. Raspberry Pi CPU load is unmeasured by us (upstream notes mention a Pi 4 measurement in 1.9.18). |

The FIFO backend is POSIX-only (raw s32le mono at 8 kHz, `open(... O_NONBLOCK)` under
`#ifndef FF_WIN`). So are `sock` (an AF_UNIX lockstep socket for upstream's channel simulator,
not real time) and `rtp` (multicast on the loopback interface, paced by the "radio"). None of
them helps on Windows, which is where most operators are.

### 4.2 How it slots into our pipeline
- `scripts/build-winlink-helpers.sh` gains a `mercury` target: `checkout` of the pinned tag with
  the SHA check (refuse an unpinned commit), apply `third_party/mercury/potacat-*.patch` if any,
  `make` with the flags above, copy the `mercury[.exe]` engine to `assets/mercury/`.
- `winlink-helpers.yml`: build on all six runners, smoke test (`mercury -h`, and `mercury -x null`
  starting and opening its TNC port), then a two-Mercury loopback test (section 10).
- `release.yml`: the same call in each OS job, with `test -f assets/mercury/mercury` and, on the
  Intel Mac, a `lipo -archs` check, as for ardopcf.
- `package.json`: `assets/mercury` to `resources/bin`, filter `mercury`, `mercury.exe`.
- `lib/mercury-process.js mercuryPathCandidates` already looks in the bundled folder first after
  the operator's override; it moves from `third_party/mercury/` to `resources/bin`.

### 4.3 The pin
- Pin a release tag, never a branch. Record tag, SHA and date in `VERSION.txt`.
- Because Mercury versions do not talk across some boundaries (1.9.25 and older), the pin must
  match what gateways run. Rule: follow upstream releases within a POTACAT patch release when a
  release breaks compatibility, and say in the release note which Mercury version ships.
- The session log and the bug report's Winlink line name the Mercury version. A Mercury
  `VERSION` command answers with a VARA-style string by design, so the real version comes from
  the banner Mercury prints on start (stdout, now captured since 8490f71).

## 5. What of the VARA session code carries over

Mercury's TNC is a VARA HF work-alike on purpose: control on the base port (8300), data on base
plus one (8301), CR-terminated ASCII. Its own doc lists `MYCALL`, `LISTEN`, `PUBLIC`, `CHAT`,
`BW500/BW2300/BW2750`, `CONNECT <mycall> <theircall>`, `DISCONNECT`, `ABORT`, `BUFFER`, `SN`,
`BITRATE`, `CLEANTXBUFFER`, `VERSION`, and accepts `COMPRESSION`, `P2P`, `WINLINK SESSION`,
`CWID` as no-ops. It answers `OK/WRONG`, `CONNECTED`, `DISCONNECTED`, `PENDING`,
`CANCELPENDING`, `PTT ON/OFF`, `BUSY ON/OFF`, `BUFFER`, `IAMALIVE`, and `VERSION` with a
"VARA version 4.9.0" line (https://github.com/Rhizomatica/mercury/blob/mercuryv2/docs/TNC.md).
The same doc notes that Pat sends `WINLINK SESSION` or `P2P SESSION` before each `CONNECT` and
`CWID ON` at start, and Mercury now accepts all three.

**Pat needs nothing new to reach Mercury today.** Pat 1.0.1's `varahf` transport works against
it; upstream users have run Pat over Mercury on the air since 2026-06
(https://github.com/la5nta/pat/issues/523). A first-class Pat "mercury" transport is specified
(https://github.com/la5nta/pat/issues/546) but waits on a Pat refactor (#545, #558); when it
lands we can move to it, not before. One known difference: Mercury's `BW2750` currently behaves
as 2300 (stated in #546), so the bandwidth picker should not promise more speed at 2750.

| VARA-era piece | Carries over? | Note |
|---|---|---|
| Pat `varahf` config section, `writePatConfig({ varaAddr })` and the reload-before-connect in `winlinkStartSession` | **Yes, as is.** Already used for Mercury. | Mercury and VARA HF share `varahf.addr`; the session rewrites it per session (exists). |
| `sessionUrl` building `varahf:///CALL?bw=&freq=` (`lib/winlink-pat.js`) | **Yes.** | |
| `winlinkHandMercuryToPat` / `winlinkTakeMercuryBack` | **Yes.** | Only one client may hold Mercury's control port. When Mercury is started only for the session, the chat client is never connected and hand-over is a no-op. |
| QSY in data mode, dial restore, power/SWR display, abort, session cap, no-progress watchdog, SWR guard, amp drive limit | **Yes.** | Mode-agnostic session machinery. |
| PTT: Pat keys through the rigctld shim on the modem's `PTT ON/OFF`, 30 s rolling failsafe | **Yes.** | Same path ARDOP and VARA use. |
| Radio-owner lock `winlink` | **Yes.** | |
| Mode gating (`lib/winlink-modes.js`): label, port clash with VARA HF, no-CAT note | **Yes**, with new reasons (section 9). `MERCURY_OFFERED` is replaced by real gating. | |
| `parseControlLine` (`lib/mercury-client.js`) for a pre-check | **Yes.** | Probe = connect, wait for the TNC to answer, disconnect, before Pat connects. |
| Spectrum bandwidth markers, outcome words, favourites, sent routes, mail-view words | **Yes.** Already list `mercury`. | |
| `lib/vara-process.js` launch rules (detached, never killed, user's program) | **No.** | Mercury is ours: spawned per session, killed at session end, like ardopcf. Reuse `spawnMercury`/`killMercury` instead. |
| `lib/vara-setup.js` (edits VARA.ini, pairs virtual cables, VOX PTT) | **No.** | We write `mercury.ini` ourselves every start (exists), and the target audio route is the socket, not a cable. |
| VARA host field (VARA on another computer) | **No** for the first release. | Mercury is bundled and local. A remote Mercury is a later question. |
| Windows-only gating, "your own copy" copy, licence warnings | **No.** | |
| `winlinkVaraAudioReady` (cable checks) | **Partly.** | The device route keeps a device check; the socket route uses the ardopcf readiness check (`winlinkModemAudioConnected`). |

## 6. How operators find Mercury gateways

### 6.1 The reality on 2026-11-22
- **Winlink has no Mercury mode.** The Winlink channel list (the one Pat downloads from the
  Winlink gateway status API) has no "Mercury" value in its supported modes. We found no
  statement from the Winlink Development Team about adding one.
- **A handful of gateways run it anyway, listed as VARA HF channels with the service code
  `MERCURY`.** Mercury's Winlink guide says so and tells sysops to do it
  (https://github.com/Rhizomatica/mercury/blob/mercuryv2/docs/WINLINK.md). A gateway sysop in
  Mercury issue #554 reported seven Mercury gateways in late November 2026; the thread names
  KO0OOO (10.1455 MHz), KU0HN-10 (7.1013 MHz), AG7JC (14.105 MHz) and YO4CIL (7.041 MHz)
  (https://github.com/Rhizomatica/mercury/issues/554). WG0A publishes a Mercury gateway page
  (https://pages.wg0a.net/mercury-hf-modem.html). These are reports, not a registry; treat the
  calls as examples that will go stale.
- **The service code is a convention, not an enforcement.** RMS Trimode takes one service code
  per channel, so a sysop chooses `MERCURY` or `PUBLIC` for that channel. A Mercury gateway that
  kept `PUBLIC` looks exactly like a VARA HF gateway.
- **Both ends must run Mercury, and compatible versions.** A Mercury gateway cannot answer a VARA
  client, nor the reverse (WINLINK.md). 1.9.25 does not talk to 1.9.24.
- **Gateway-side problems are open.** RMS Trimode scans each frequency for about 4 s, and a
  Mercury call frame is about 3.7 s repeating every 7 s, so scanning gateways miss calls
  (https://github.com/Rhizomatica/mercury/issues/527, open on 2026-11-22). Session stalls have
  been reported (issues #392, #431).
- **Pat drops the service code.** Pat 1.0.1 downloads with `ServiceCodes=PUBLIC` unless
  `service_codes` in its config says otherwise, and its `RMS` rows (what POTACAT reads) carry
  no service code at all (`app/rmslist.go`, `internal/cmsapi/api.go` at v1.0.1). So today POTACAT
  cannot tell a Mercury channel from a VARA one in Pat's list. Pat's maintainer has a proof of
  concept that relabels `VARA` rows with service code `MERCURY` as mode `Mercury`
  (https://github.com/la5nta/pat/issues/564, open, 2026-11-15). POTACAT's bundled Pat also writes
  `service_codes: ['PUBLIC']` (`lib/winlink-pat.js`), so Mercury-coded gateways never reach the
  mail window now.

### 6.2 Ways to find them, and what each depends on

| # | Route | Works when | Depends on |
|---|---|---|---|
| A | **Winlink's channel list, filtered by service code `MERCURY`.** Pat downloads with `ServiceCodes=PUBLIC,MERCURY`. Rows with code `MERCURY` become the Mercury list; they are removed from the VARA HF list so a VARA operator never calls a Mercury gateway. | First release. | Either Pat #564 landing upstream (then bump our Pat pin), or a small addition to our existing Pat patch that puts the channel's `service_code` on each RMS row. Sysops keep using the `MERCURY` code. |
| B | **The operator's own tags** (`winlinkMercuryGateways`, exists). A call tagged by hand joins the Mercury list from the VARA rows. | Now. | Nothing. Catches gateways that kept `PUBLIC`. |
| C | **A Mercury mode in Winlink itself.** | Unknown. | The Winlink Development Team. Nothing public suggests it is coming. When it does, Pat's classifier and ours pick it up with a one-line change. |
| D | **A list kept by POTACAT Cloud.** After a Mercury session completes, the app may report gateway call, frequency, Mercury version and date (opt-in). Others see "last worked from POTACAT on <date> with Mercury <version>". | Later. | A CLOUD handoff (endpoint, storage), a privacy page update (website handoff), Casey's go. Adds value over A only by showing which gateways actually answered which version. |
| E | **Peer to peer Winlink between POTACAT stations.** Pat P2P over Mercury, with one station listening. | Later. | Casey's decision to let Pat listen (today Pat is never given `--listen`, by design: no unattended answering). Listening must be attended and operator-started. Both ends need the same Mercury version, which bundling gives POTACAT users for free. |
| F | **Mercury stations heard on the air.** Mercury reports decoded calls (`CQFRAME`, `MONITOR` lines); POTACAT could list "Mercury stations heard". | Later. | Gateways or stations sending CQ frames; whether gateways beacon at all is unknown. Receive only. |

Rhizomatica's HERMES network (Mercury plus UUCP store and forward, on sBitx radios) moves email
over HF, but with UUCP, not Winlink's B2F, and through Rhizomatica's own servers
(https://www.rhizomatica.org/hermes/, https://github.com/Rhizomatica/hermes-net). It is not a
source of Winlink gateways and is out of scope.

## 7. Audio, per rig

Mercury's modem runs at 8 kHz internally. With a real device it asks for 48 kHz from the
system. Two routes:

- **Device route (exists).** Mercury opens the radio's sound card itself (wasapi on Windows,
  alsa or pulse on Linux, coreaudio on macOS) by an id in `mercury.ini`. POTACAT is not in the
  audio path. Risks: stale ids (seen on the developer's station), a device held exclusively
  (blanks POTACAT's waterfall), and no way to reach a radio whose audio comes over the network.
  Mercury's Windows build falls back to a device of the same name when an id is gone
  (`input_device_name` / `output_device_name` in `mercury.ini.example`); we write both.
- **Socket route (to build).** As for ardopcf and Dire Wolf: Mercury opens no sound card, takes
  receive audio from a loopback TCP port POTACAT serves, and sends transmit audio back on it.
  POTACAT's `lib/modem-audio-server.js` already does this at 12 kHz (ardopcf) and 48 kHz (Dire
  Wolf); 8 kHz is one more rate. This needs a TCP audio backend in Mercury, because none of its
  existing non-device backends compiles on Windows. Two ways to get it: carry a POTACAT patch
  (`third_party/mercury/potacat-socket-audio.patch`, generated like `gen-ardopcf-patch.py`), or
  offer it upstream as a PR so we carry nothing. Upstream ships a release every week or two and
  a patch would need refreshing each time, so upstream is the better home (open question 3).
  The same patch should bind Mercury's TNC ports to 127.0.0.1 (section 8).

| Rig | Route | Why |
|---|---|---|
| USB-codec rigs (IC-7300, FT-710, FT-991A, TS-590, QMX and the rest) | Socket when built; device route until then | POTACAT already opens this device for its waterfall and other modes. One owner of the device ends the fight and the stale-id failure. |
| Flex, SmartSDR Direct | Socket only | POTACAT owns the audio over the network. DAX is the fallback for operators who run it, through the device route, with the DAX-era limits already written up in `docs/vara-integration-plan.md`. |
| Icom Network (IC-705, IC-7610, IC-9700 over LAN) | Socket only | No sound card exists on the computer for Mercury to open. Without the socket route Mercury is not offered on these rigs, and the mail window says why. |
| TCI rigs (Thetis, Zeus) | Socket only | Same: POTACAT holds the TCI audio stream. |
| Hermes-Lite 2 | Socket | Mercury has its own `hl2` backend, but it would make Mercury the radio. POTACAT keeps the radio. |
| No-CAT rigs keyed by VOX or a PTT line | Either | The session already handles no-CAT rigs; the operator sets the dial. |
| Remote (ECHOCAT, Guest Pass) | Same rules as ARDOP | The shack runs Mercury; the phone sees Winlink state only. |

On Linux and macOS the existing FIFO plan (phase 4b of the July plan) is superseded: one socket
backend serves all three systems, so there is one audio path to test, not two.

TX level: the session uses `lib/winlink-tx-level.js` like ARDOP. Mercury's own
`[audio] tx_gain_db` stays at 0 so there is one level control, POTACAT's.

## 8. PTT and safety

- **POTACAT keeps PTT authority.** Mercury runs with `radio_model = -1` and no `-R/-A/-S`
  (exists, `buildMercuryIni`). Add a `FORBIDDEN_FLAGS` refusal like `lib/ardop-process.js` has, so
  no future argument can give Mercury a radio or a PTT port. Mercury reports `PTT ON/OFF`; Pat
  keys through POTACAT's rigctld shim; POTACAT keys the radio through its one dispatcher.
- **Nothing transmits unless asked.** Mercury is started only when the operator starts a
  Winlink session (or opens the chat window and connects). `LISTEN` stays off; Pat never
  listens. POTACAT never sends `TUNE` (Mercury's `TUNE` makes a carrier for up to 60 s), `CQFRAME`
  or `BEACONMODE` in a Winlink session. Mercury is killed when the session ends, so an idle
  Mercury cannot answer a call.
- **Stuck-TX limits.** POTACAT's 30 s rolling failsafe stays, re-armed by `BUFFER` progress.
  Mercury's own maximum keydown is 30 s; we set `max_keydown_s` a little below POTACAT's so
  Mercury lets go first. POTACAT's global stuck-TX limit applies over both.
- **The TNC ports are open to the network.** Mercury listens on every interface with no
  authentication (README, "Restricting network access"). A stranger on the LAN who grabs the
  control port could start a connect. With POTACAT keying, their `PTT ON` would go to them, not
  to POTACAT, so the radio would not key unless it runs DATA VOX. Still: bind to 127.0.0.1 (in
  the socket patch or upstream), connect POTACAT's or Pat's client before anything else can, and
  never let Windows Firewall raise its "allow access" prompt for Mercury.
- **Version mismatch looks like silence.** When a gateway runs an incompatible Mercury, the call
  just goes unanswered. The session outcome for a Mercury call that got no answer says so in one
  line: "No answer. Mercury gateways must run a compatible Mercury version; this POTACAT has
  Mercury 1.9.25."
- **Radio-owner lock, SWR guard, amp drive limit, Guest Pass rules, out-of-band rules:** as for
  every Winlink radio mode. No new exceptions.

## 9. Settings and UI

- **Mail window, Send via:** "Mercury (radio, experimental)". Available when: the bundled (or
  overridden) binary is found; the rig has an audio route on this system (socket, or a device for
  the device route); no port clash with VARA HF. Each unavailable case has a reason line, for
  example "Mercury needs POTACAT's own audio for an Icom Network radio. Coming in a later
  release."
- **Gateway list:** the Mercury list from section 6 route A plus B. A short line under it while
  the list is small: "Experimental. Few gateways run Mercury, and both ends need a compatible
  Mercury version." An empty list says so plainly and points to the operator tags.
- **Settings > Station > Winlink > Mercury (experimental):** bandwidth (500 or 2300; 2750 shown
  as "2750 (same speed as 2300 today)" or hidden, open question 5), the gateway tag list
  (exists), an advanced "Use my own Mercury" path (`mercuryPath`, exists), and, for the device
  route only, the device pickers that exist today. No enable switch for Winlink: the mode is
  there when it can work.
- **The July chat window** keeps working, now on the bundled binary. Whether it stays visible
  is open question 6.
- **Bug report and session log:** Mercury version, route (socket or device), device names,
  pinned commit.
- **ECHOCAT:** the mode arrives in `winlink-state.modes` with its reason, as the other modes do.
  Phone parity: one ECHOCAT handoff line (new mode id is live; the "experimental" note shown the
  same way).
- **Release notes, platform truth:** say which systems carry Mercury and which rigs it works
  with, in that release's words. For example: "Mercury, experimental, bundled for Windows,
  macOS and Linux. Works with radios that have a USB sound card. Flex and Icom Network radios
  are not supported yet. A few Winlink gateways run Mercury; both ends need Mercury 1.9.25." No
  claim beyond what a test or an on-air session has shown.
- **Docs and website:** a docs.potacat.com section and a privacy page check, by handoff.

## 10. Tests

- `test/mercury-process-test.js` (exists): add `FORBIDDEN_FLAGS`, the bundled path in
  `resources/bin`, `max_keydown_s`, both device-name keys, and the socket device string.
- `test/winlink-units-test.js` / modes: Mercury gating reasons per rig family and OS; no
  `MERCURY_OFFERED` constant left.
- `test/winlink-pat-test.js`: `service_codes` includes `MERCURY`; rows with that code go to the
  Mercury list and leave the VARA HF list; tagged calls join the Mercury list.
- A packaging guard (in the style of the existing helper checks): `assets/mercury` in
  `package.json`, `third_party/mercury/LICENSE`, `LICENSE-freedv`, `VERSION.txt`, and the
  NOTICE entry all present; `VERSION.txt` SHA equals the SHA in `build-winlink-helpers.sh`. And
  the VARA guard still holds: nothing of VARA is bundled.
- `test/modem-loopback/mercury-session.js` in `winlink-helpers.yml`, on all six runners: two
  real Mercurys, crossed audio (socket route once it exists; on Linux and macOS the FIFO
  backend can stand in until then), two Pats, one mail each way, no radio. Then the stress set
  the ARDOP loopback uses (level, noise, clock error, dropouts).
- Electron layer: the real bridge window feeding Mercury at 8 kHz (as L3/L4 do for ardopcf).
- Not testable in CI: a real gateway. That is the on-air spike.

## 11. Phases

Each phase is its own branch and PR. None ships until Casey says so.

| Phase | What | Exit check |
|---|---|---|
| 0. Spike, no product change | Build pinned 1.9.25 by hand on Windows with our flags. Run Pat 1.0.1 over it to one Mercury gateway from a USB-codec rig (device route). Check the `PTT ON/OFF` lines reach Pat with `radio_model = -1`. Record the real version banner. | One mail sent and received on the air, session log kept. If no gateway answers, the plan stops here and Casey decides. |
| 1. Bundle the binary | `build-winlink-helpers.sh mercury`, `winlink-helpers.yml` on six runners, `release.yml`, `package.json`, `third_party/mercury/` (LICENSE, LICENSE-freedv, VERSION.txt, README), NOTICE. Licence table re-checked against the pin. | CI green on all six runners; smoke test starts Mercury and opens its TNC port; the packaging guard passes; an installer built by CI contains `resources/bin/mercury[.exe]`. |
| 2. Gateway list | Pat downloads `PUBLIC` and `MERCURY`; Mercury rows split out (Pat #564 if it has landed, else our Pat patch); tags merge in. | Unit tests; a live list on a test machine shows the `MERCURY` gateways and the VARA HF list no longer contains them. |
| 3. Winlink mode on, device route | Real gating replaces `MERCURY_OFFERED`; Mercury started per session and killed after; pre-check; outcome line for no answer; settings section; bug report line. Offered only for USB-codec rigs. | `mercury-session` loopback green on Linux and macOS (FIFO stand-in); one on-air session from Windows through POTACAT itself, start to finish, log reviewed. |
| 4. Socket audio | TCP audio backend in Mercury (upstream PR, or our patch); `modem-audio-server` at 8 kHz; Flex Direct, Icom Network and TCI offered; USB-codec rigs move to the socket route; ports bound to loopback. | Loopback green on all six runners through the socket; one on-air session each from a Flex over SmartSDR Direct and from an Icom over the network. |
| 5. ECHOCAT and docs | Phone handoff line, docs page, website privacy check, release-note wording. | Handoffs written; Casey has read the release-note lines. |
| Later | POTACAT Cloud gateway list (6.2 D), P2P (6.2 E), heard list (6.2 F), Pat's own Mercury transport when it lands. | Each needs its own go. |

## 12. Open questions for Casey

1. Phase 0 needs one on-air Mercury session to a gateway before anything is bundled. Is a
   USB-codec radio on your station available for that, or should a tester with a Mercury
   gateway in range run it?
2. Release scope: is it all right to ship Mercury for Winlink on USB-codec radios first
   (phase 3) and add Flex, Icom Network and TCI with the socket audio later (phase 4)? Or hold
   the mode until every rig family works?
3. Socket audio: offer a TCP audio backend to Rhizomatica as an upstream pull request (a public
   GitHub action, so your word is needed), or carry it as a POTACAT patch like ardopcf's?
4. Pin policy: Mercury breaks compatibility between some releases (1.9.25 does not talk to
   1.9.24). Do we follow each breaking upstream release in the next POTACAT patch release, or
   only when you say?
5. Bandwidth 2750: Mercury treats it as 2300 today. Hide it, or show it with "same speed as 2300
   today"?
6. The July chat and file window (More > Mercury HF Data): keep it visible once the binary is
   bundled, hide it until it has been used on the air, or remove it?
7. Gateway list route A needs a service code per row. Wait for Pat #564 upstream, or add it to
   our Pat patch now?
8. Peer to peer Winlink between POTACAT stations needs Pat to listen, attended and started by the
   operator. Is that a direction you want, or does "Pat never listens" stay?
9. A POTACAT Cloud list of gateways that answered (opt-in, with a privacy page update): worth a
   cloud handoff later, or not?
10. Should POTACAT's own Mercury ever answer calls (a POTACAT station as a Mercury gateway or
    P2P peer), or is it a client only?
