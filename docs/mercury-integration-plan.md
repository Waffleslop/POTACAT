# POTACAT × Mercury — HF Data Modem Integration

Status: **Phases 1–3, 4a, 5 shipped 2026-07-14** (launch/supervise; TNC client;
radio-owner arbiter + PTT bridge; audio-bridge core + strategy; chat/file popout
UI). Phase 4b (FIFO transport + audio pumping) and 6–7 designed, not started.
Filed: 2026-07-14.

### Spike (2026-07-14): Mercury `fifo` backend is POSIX-only
`audioio/audioio.c` opens the FIFO with `open(path, O_RDONLY/O_WRONLY | O_NONBLOCK)`
under `#ifndef FF_WIN`, carrying raw **s32le mono @ 8 kHz**. Windows named pipes
cannot drive it. **Conclusion: the FIFO direct-bridge is Linux/mac only; Windows
uses a real audio device.** (Casey's primary machine is Windows, so the no-VAC
differentiator lands on the Pi/Linux/mac headless path, not his desktop.)

[Mercury](https://github.com/Rhizomatica/mercury) (Rhizomatica / HERMES,
**GPL-3.0-or-later**) is an external HF **data** modem: FreeDV/codec2 OFDM (the
DATAC mode ladder) with a VARA-compatible ARQ TNC and a KISS-over-TCP broadcast
plane. It gives POTACAT reliable keyboard-to-keyboard chat + file transfer over
HF, with a runway to Winlink and Reticulum.

## Why it grafts cleanly

1. **License fit is already solved.** POTACAT already ships a GPL binary (`wsprd`)
   as a *separate executable / mere aggregation* under `third_party/` + a `NOTICE`
   entry. Mercury follows that precedent — never linked, only spoken to over TCP.
   ECHOCAT (proprietary) is untouched.
2. **Spawn-and-talk-over-TCP is a known pattern** (`rigctld`): the launcher is a
   near-clone of `findRigctld`/`spawnRigctld`, and the TNC is reached like the
   post-spawn `TcpTransport`.
3. **Radio ownership stays with POTACAT.** Run Mercury with **no `-R/-A/-S` flags**
   and `radio_model = -1`: it does not key the rig — it emits `PTT ON`/`PTT OFF`
   on the control socket and leaves keying to the TCP client, so PTT flows through
   POTACAT's existing gated `handleRemotePtt()` with zero CAT contention. Only
   audio must be shared.

## Decisions (Casey, 2026-07-14)

- Scope: MVP **+ direct-radio audio bridge**; Winlink & Reticulum are later phases.
- Audio: **per-rig** — FIFO bridge into SmartSDR-Direct/Icom-Network on those rigs,
  a real audio device elsewhere (gated via `lib/rig-family.js`).
- Binary: **bundle** (mere aggregation, like `wsprd`) **+ honor `settings.mercuryPath`**.
- First UI: POTACAT-native **keyboard-to-keyboard chat + file transfer** (VarAC-style).

## Mercury TNC reference (repo branch `mercuryv2`)

VARA-compatible, CR-terminated ASCII on the control port. Control = base (8300),
data = base+1 (8301), broadcast = 8100.
- **Client→Mercury:** `MYCALL`, `LISTEN ON|OFF|CQ`, `PUBLIC`, `BW500|BW2300|BW2750`,
  `CONNECT <mycall> <theircall>`, `CQFRAME`, `DISCONNECT`, `ABORT`, `BUFFER`, `SN`,
  `BITRATE`, `RETRIES`, `CALLINT`, + VARA no-ops (`COMPRESSION/CHAT/P2P/…`).
- **Mercury→Client (async):** `CONNECTED <src> <dst> <bw>`, `DISCONNECTED`,
  `PENDING`/`CANCELPENDING`, `CQFRAME`, **`PTT ON`/`PTT OFF`**, `BUFFER <n>`, `SN`,
  `BUSY ON|OFF`, `BITRATE`, `IAMALIVE`.
- **Data port:** raw bytes both ways; Mercury segments internally; only flows when CONNECTED.
- Launch: omit radio flags (TCP-client keying); `-x fifo` = raw s32le @ 8 kHz (bridge hook);
  `[audio] tx_gain_db` for modem coexistence.

## Phases

### Phase 1 — Launch + locate + supervise ✅ (2026-07-14)
- `lib/mercury-process.js` (pure): `mercuryPathCandidates` (override → bundled
  `third_party/mercury/` → common dirs → PATH), `buildMercuryArgs` (no radio flags),
  `buildMercuryIni` (pins `radio_model=-1`, `ui_enabled=false`), `mercuryPorts`,
  `mercuryConfig`. Tests: `test/mercury-process-test.js` (15).
- main.js: `findMercury`/`writeMercuryIni`/`spawnMercury`/`killMercury`/
  `probeMercuryReady`/`connectMercury`/`disconnectMercury`/`sendMercuryStatus`
  (cloned from the rigctld flow). Startup init, `mercuryChanged` in save-settings
  (respawn-race guard), `killMercury` in `gracefulCleanup`.
- `third_party/mercury/README.md` scaffold (GPL/bundling checklist).
- Verified: `scripts/shot-mercury-phase1.mjs` — enabling Mercury boots without
  crashing, writes a correct ini, attempts spawn, degrades to "not found" cleanly.
- **Deferred within Phase 1:** the actual binary + `NOTICE` entry + `build.files`
  packaging wait on a per-platform Mercury build (macOS needs its own).

### Phase 2 — `lib/mercury-client.js` (TNC client) ✅ (2026-07-14)
- `MercuryClient` — two `net.Socket`s (line-oriented control + raw data), modeled
  on `DxClusterClient` (stale-socket guard, `_wantDisconnect` intent flag,
  exponential backoff, control watchdog on the IAMALIVE cadence). Emits
  `status`/`connected`/`disconnected`/`ptt`/`busy`/`pending`/`cqframe`/`buffer`/
  `sn`/`bitrate`/`iamalive`/`ack`/`line`/`data`. Commands: `myCall`, `listen`,
  `setPublic`, `setBandwidth`, `arqConnect`/`arqDisconnect`, `abort`, `cqFrame`,
  `queryBuffer/Sn/Bitrate`, `sendCommand`, and `sendData(buf)` on the data socket.
- Pure exported `parseControlLine()` (case-insensitive keyword, callsign case
  preserved) — the unit-test surface.
- main.js `openMercuryClient()` replaced the Phase 1 probe: creates the client,
  wires `status`→`sendMercuryStatus`, logs `connected`/`disconnected`/`cqframe`
  (and raw lines under `mercuryVerbose`), and connects. `killMercury` tears the
  client down.
- Tests: `test/mercury-client-test.js` (7 parser cases + a real two-socket
  loopback against a fake Mercury: commands sent, data delivered, CR-batched
  async status parsed, PTT true→false, `arqConnected` state).
- Not yet wired: the `ptt` event → `handleRemotePtt` (Phase 3), and any UI.

### Phase 3 — Radio-owner arbiter + Mercury PTT ✅ (2026-07-14)
- Pure `lib/radio-owner.js` (`none|jtcat|mercury` mutex): `decideAcquire`/
  `decideRelease`/`canAcquire`. main.js holds `radioOwner` + `acquireRadio`/
  `releaseRadio`/`forceReleaseRadio`. Tests: `test/radio-owner-test.js` (11).
- PTT / failsafe / session policy factored into the injectable, unit-tested
  `lib/mercury-radio-bridge.js` (`attachMercuryRadioBridge(client, hooks)`):
  PTT ON→key+arm failsafe; PTT OFF→clear+unkey; BUFFER>0→rolling re-arm;
  CONNECTED→acquire or ABORT-to-yield; DISCONNECTED→clear+unkey+release+onIdle.
  Tests: `test/mercury-radio-bridge-test.js` (7). main.js wires the real hooks
  (`keyPtt`→`handleRemotePtt(state,{audio:true})`, acquire/release→arbiter) and a
  30 s rolling `armMercuryTxFailsafe`.
- JTCAT side: `ft8Engine 'tx-start'` acquires `'jtcat'` and is BLOCKED (unwound via
  `txComplete()`) when Mercury owns; `tx-end` releases `'jtcat'` and, when Mercury
  owns, does NOT drop Mercury's PTT.
- `onMercuryReady`: on control (re)connect sends `MYCALL` + `BW`, and — opt-in
  `mercuryListen` (default OFF, Part 97 attended) — acquires the radio + `LISTEN ON`.
- **Follow-ups:** SSTV/WSPR/tune `tx-start` guards; multi-slice JTCAT holds `'jtcat'`
  per-slice-TX only (session-level Mercury hold already blocks all JTCAT keying).

### Phase 4a — Audio bridge core + strategy ✅ (2026-07-14)
- `lib/mercury-audio-bridge.js` (pure): `s32leToF32`/`f32ToS32LE` (Mercury FIFO
  format), `StreamingResampler` (continuity-preserving linear 8k↔12k, carries
  fractional phase + boundary sample across chunks — no per-buffer edge clicks),
  and `resolveMercuryAudio({settings,rigFamily,platform,fifoDir})` (device vs FIFO;
  Windows always device; `auto`→fifo for Flex/Icom-network on POSIX). FIFO paths
  are `path.posix`. Tests: `test/mercury-audio-bridge-test.js` (14).
- `buildMercuryArgs`/`buildMercuryIni` take an optional resolved `audio` (emits
  `-x fifo` + the FIFO paths, else device). main.js `resolveMercuryAudioStrategy`
  computes it from the active rig family + OS and logs the choice.

### Phase 4b — FIFO transport + audio pumping (deferred; needs Linux+Mercury+rig)
Generic rigs already work via the device path (Phase 1 + 4a). For Flex/Icom on
Linux/mac: create the two POSIX FIFOs (mkfifo) before spawn; pump `txFifo`
(Mercury modem TX, s32le@8k) → `s32leToF32` → resample 8k→12k → the existing
3-route TX dispatch (`smartSdrAudio`/`_icomNetworkTransport` chunk-push); tap the
`feedAudio` RX sinks → resample 12k→8k → `f32ToS32LE` → `rxFifo`, obeying the
"one owner, others early-return" discipline. Until built, a resolved `fifo`
strategy is logged and coerced to `device`.

### Phase 5 — Native chat/file UI (`mercury-popout`) ✅ (2026-07-14)
- `lib/mercury-app-protocol.js` (pure): length-prefixed framing over the raw data
  socket — `[type u8][len u32][payload]`, types CHAT/FILE_META/FILE_DATA/FILE_END,
  `encode*` + `FrameReassembler` (reassembles across TCP chunk boundaries, resets
  on a bogus oversize length) + `interpretFrame`. Tests: `test/mercury-app-protocol-test.js` (8).
- Own popout window (`mercury-popout.{html,js}` + `preload-mercury-popout.js`,
  cloned from the JTCAT popout lifecycle): connection bar (MYCALL, their-call,
  Connect/Disconnect/Abort, BW, Listen), status strip (state/PTT/BUSY/SN/BITRATE),
  chat transcript (RX/TX/system), composer (Enter=send), Send File…, dbl-click a
  callsign to capture it. Launch via a `view-mercury-btn` (shown when
  `enableMercury`) → `mercury-popout-open`.
- main.js: data socket → `handleMercuryData` (chat → transcript; files →
  `<userData>/mercury-downloads/`, 5 MB cap); `mercury-cmd-*` handlers drive the
  client (connect/disconnect/abort/listen/bw/send-text/send-file via a picker);
  session/link events mirror to the popout; a 200-line transcript tail replays on
  reopen. Tests: `scripts/shot-mercury-popout.mjs` (13 e2e, injects main→renderer
  events — no rig needed).
- **Follow-ups:** file backpressure (pace off `BUFFER` instead of one synchronous
  queue); drag-and-drop; interop framing with VarAC/Pat.

### Phase 6 — ECHOCAT phone mirror
`broadcastMercuryRx` + replay tail + `mercury-send` in `lib/remote-server.js`;
register the pair in `lib/echocat-protocol.js`; consumer in `renderer/remote.js`.

### Phase 7 — Later (documented, not built)
Winlink email (hand the TNC to Pat, or B2F in POTACAT); Reticulum over the KISS
broadcast port.

## Risks
Audio+PTT contention is the whole project (Phase 3). Windows FIFO. 8k↔12k resample
latency. GPL hygiene at bundle time (re-confirm before a signed release; macOS
build). Mercury `mercuryv2` is evolving — pin a commit in `third_party/`. Respawn
races — gate on `mercuryChanged`, never blind kill+respawn.
