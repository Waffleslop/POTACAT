# POTACAT × Mercury — HF Data Modem Integration

Status: **Phase 1 shipped 2026-07-14** (launch + supervise + readiness probe).
Phases 2–7 designed, not started. Filed: 2026-07-14.

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

### Phase 2 — `lib/mercury-client.js` (TNC client)
Two `net.Socket`s (line-oriented control + raw data), modeled on `DxClusterClient`
(intent flag + backoff). Emits `mercury-ptt/connected/disconnected/busy/buffer/…`;
`sendData()` on the data socket. `connectMercury` swaps the readiness probe for a
persistent client. Tests: `test/mercury-client-test.js`.

### Phase 3 — Radio-owner arbiter + Mercury PTT
`mercury-ptt` → `handleRemotePtt(state,{audio:true})` (gates/pass-enforcement/
mode-switch). New `armMercuryTxFailsafe` (rolling, re-armed on PTT ON/BUFFER>0).
New pure `lib/radio-owner.js` (`none|jtcat|mercury|voice` mutex) so FT8 and Mercury
can never both key. **Highest-risk piece — build/test before the UI.**

### Phase 4 — Audio bridge (per-rig)
Generic rigs → real device (`-x wasapi|coreaudio|alsa`). Flex/Icom → `-x fifo`
bridged into the existing 3-route TX dispatch + `feedAudio` RX sinks (8k↔12k
resample via `resampleMonoFloat32`), obeying the "one owner, others early-return"
discipline. Windows-FIFO caveat: spike named-pipe vs loopback before committing.

### Phase 5 — Native chat/file UI (`mercury-popout`)
Own popout window cloned from the JTCAT popout lifecycle; connection bar, chat
transcript (PSK scrollback idiom), composer, file drop + BUFFER progress, status
strip. A tiny length-prefixed app framing over the data socket (POTACAT↔POTACAT v1).

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
