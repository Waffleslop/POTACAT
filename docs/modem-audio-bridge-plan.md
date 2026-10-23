# Modem audio bridge — plan (explicit)

**Status: phase 1 BUILT 2026-10-23** (bridge window + sound-device route on every rig, ARDOP never opens a device; proven by test/modem-bridge-test.js against Chromium's fake audio device + a real ModemAudioServer; not yet run on a real USB-CODEC rig). Phases 2–4 planned. Owner: desktop. Casey asked for the detail after the
VARA plan showed that every external modem's problems come from the modem opening the radio's
sound card itself. This plan makes POTACAT the only program that ever touches the radio's audio,
and feeds every modem (ardopcf today, Dire Wolf, VARA via a virtual cable, Mercury later) over the
one socket ARDOP already uses on Flex Direct.

**What it buys, in order of who asked:** ARDOP on macOS (no mac build exists only because of ALSA);
ARDOP on a USB-CODEC rig with no device picker, no 31-character names, no PipeWire "device busy";
VARA HF on a Flex without DAX; the end of the "two programs on one sound card" fight.

## What exists (the pieces this plan connects)

| Piece | Where | Role |
|---|---|---|
| `ModemAudioServer` | `lib/modem-audio-server.js` | loopback TCP, raw s16 mono **12 kHz** both ways, no framing. `feedRx(pcm, sampleRate)` resamples in; `'tx'` event emits 24 kHz Float32 chunks; drops when the modem stalls. |
| ardopcf socket backend | `third_party/ardopcf/src/SocketAudio.c` + patch; device `tcp:<port>` | the modem reads/writes the socket instead of a sound card. Pure BSD/winsock sockets. |
| Socket route gate | main.js `winlinkSocketAudioRoute()` (= audioSource smartsdr or icom-network), `startWinlinkAudio()`, `winlinkFeedRx()`, the `'tx'` → `smartSdrAudio.pushTxAudioChunk` / `pushIcomNetworkVoiceChunk` while `winlinkTxActive` | the radio side for the two IP-audio rigs |
| ECHOCAT audio bridge window | `renderer/remote-audio.html` (hidden BrowserWindow) | the proven pattern for capturing a rig input with `getUserMedia({deviceId:{exact}})`, playing to a rig output with `setSinkId`, an AudioWorklet (`dax-tx-processor`) that posts 24 kHz chunks to main over IPC (`dax-tx-chunk`), and main → window frames through `audioSafeSend` (bounded by ACKs). Refuses a missing device, never substitutes the default mic. |
| Per-rig devices | `rig.remoteAudioInput` / `rig.remoteAudioOutput` (mirrored to `settings.remoteAudioInput/Output`; healed by `lib/rig-audio-mirror.js`) | the devices FT8 and ECHOCAT already use — the modem's devices by definition |
| TX level | `applyJtcatTxGain` → `_jtcatDirectTxGainLevel`; renderer `txGain.gain.value` | the level that already works for FT8 into this rig's ALC |
| Resampler | `mercuryAudioBridge.StreamingResampler(from, to)` | continuity-preserving, used by the server and RS-BA1 |

## Design

### The one rule
**A modem never opens a sound device.** It opens `tcp:<port>` (ardopcf; Dire Wolf after its patch),
or a virtual cable that POTACAT owns the other end of (VARA). The radio side is one of three
POTACAT-owned sources, chosen by the active rig's `audioSource`:

| Radio side | RX into the server | TX out of the server |
|---|---|---|
| Flex Direct (`smartsdr`) | `smartSdrAudio` `audio-frame` (24 kHz) → `feedRx` (exists) | `pushTxAudioChunk` (exists) |
| Icom Network (`icom-network`) | `handleIcomNetworkPacedRxFrame` → `feedRx` (exists) | `pushIcomNetworkVoiceChunk` (exists) |
| **Sound-device rig (`dax`, `usb`, everything else) — NEW** | the **modem bridge window** captures `rig.remoteAudioInput` → IPC → `feedRx` | `'tx'` chunks → IPC → the window plays to `rig.remoteAudioOutput` |

`winlinkSocketAudioRoute()` becomes `true` for every rig; the branch is only *which radio side*.

### The modem bridge window (`renderer/modem-audio-bridge.html` + `preload-modem-audio-bridge.js`)
Hidden BrowserWindow, created by main on the first modem session that needs it, kept for the
session, destroyed at session end (and in `gracefulCleanup`). Cloned from the ECHOCAT bridge, with
the WebRTC parts removed.

- **Start:** main sends `modem-bridge-start {inputId, outputId, txGain, rigName}`.
- **Capture:** `getUserMedia({audio:{deviceId:{exact:inputId}, echoCancellation:false,
  noiseSuppression:false, autoGainControl:false, channelCount:1}})`. A failure is **fatal for the
  session** with the ECHOCAT bridge's exact wording ("Radio audio input not found … the microphone
  was NOT used"): `modem-bridge-status {error}` → main ends the session with that text. A raw
  `alsa:` id is refused with the "pick the PulseAudio/PipeWire entry" text (the ALSA addon is
  capture-only and would still leave TX impossible).
- **Capture path:** `MediaStreamSource → GainNode(1.0) → AudioWorklet 'modem-capture'` which
  accumulates **256-sample Float32 frames at the context rate** (48 kHz = 5.3 ms) and posts
  **20 ms batches** (960 samples) to the preload → `ipcRenderer.send('modem-bridge-rx', {pcm:
  Float32Array, sampleRate})`. Main: `winlinkFeedRx(pcm, sampleRate)` → server resamples to 12 kHz.
  (20 ms batches = 50 IPC messages/s, the rate the ECHOCAT bridge already sustains.)
- **Playback path:** main → `audioSafeSend(win, 'modem-bridge-tx', {pcm: Float32Array @24 kHz})` on
  every server `'tx'` chunk. The window feeds an `AudioWorklet 'modem-play'` ring buffer (target
  60 ms ahead, max 300 ms — beyond that it drops the oldest, like `ModemAudioServer` does on the
  other side) → `GainNode(txGain)` → `AudioContext` whose sink is `rig.remoteAudioOutput` via
  `ctx.setSinkId(outputId)` (Chromium ≥ 110; Electron 39 has it). A `setSinkId` throw is fatal for
  the session (the JTCAT TX rule: no audio beats the wrong audio).
- **Level:** the GainNode uses `_jtcatDirectTxGainLevel` (what FT8 uses into this rig); ardopcf's
  `DRIVELEVEL` stays at its setting. A `modem-bridge-level {rms}` message every 500 ms carries the
  captured RMS so the mail window's waterfall and the `RX AUDIO LOW` badge work from the same
  numbers as the IP-audio routes.
- **Backpressure, both ways:** rx uses a credit counter in the preload like
  `winlink-audio-frame`'s ACKs (main stops forwarding when 120 frames are unacked); tx uses
  `audioSafeSend`. Neither direction may block the main thread or the worklet.
- **Lifetime:** `modem-bridge-stop` releases the tracks and closes the context so the device is
  free again for JTCAT/ECHOCAT the moment the session ends.

### Sharing the device with FT8 and ECHOCAT
Windows (WASAPI shared), macOS (CoreAudio) and PulseAudio/PipeWire all let two Chromium contexts
capture one input and play to one output at once, so the FT8 waterfall keeps running during a
session — the radio-owner lock (`winlink`) is what stops FT8 *transmitting*. Raw ALSA ids are the
one exclusive case and are refused (above). No "pause JTCAT" step is needed; if a user's exclusive-
mode CODEC fights, the fatal-start message names the device and the fix.

### Latency budget (ARDOP tolerates ~150 ms of round-trip audio delay before its timing suffers)
capture worklet 5 ms + 20 ms batch + IPC ~2 ms + resample ~1 ms + socket ~1 ms → modem: ~30 ms.
Modem → socket → server chunk (ModemAudioServer emits per received block, ≤ 20 ms) → IPC → play
ring 60 ms target → device ~10 ms: ~90 ms. Total ~120 ms, under the budget; measured in the spike
with ardopcf's own `PTT`-to-first-sample timing in its log.

### Device selection — removed, not moved
The ARDOP "Find the radio's sound devices" card, `proposeArdopDevices`, `matchArdopDevice`, the
31-char name matching, `rig.winlinkAudio`, `winlinkSaveRigAudio` and the Settings picker all go.
The rig's FT8 devices are the modem's devices. A rig with none set is already a Station Setup
"needs" step; the mail window says "Choose the radio's audio in Settings > My Rigs > Audio" and
links there. `ArdopProcess.parseArdopDeviceList` stays only as a diagnostic (`ardopcf -l` output in
a bug report), never as a chooser.

### macOS ardopcf (the socket-only build)
`src/linux/ALSASound.c` and `LinSerial.c` are POSIX (termios, mman, sockets) plus
`<alsa/asoundlib.h>` with ~190 `snd_*` calls that are only reached when a real device is opened.
The mac build compiles the Linux sources against a **stub header** `helpers/alsa-stub/alsa/
asoundlib.h` (every `snd_*` symbol an inline no-op returning `-ENOSYS`, the handful of types as
opaque structs) with `-I helpers/alsa-stub`, and drops `-lrt -lasound`. The socket backend
(`sa_active()`) is taken before any `snd_*` call on the `tcp:` device, so the stubs are never
executed. `scripts/build-winlink-helpers.sh ardop` gains the darwin branch; `winlink-helpers.yml`
builds it on macos-14 and macos-15-intel with the existing `--hostcommands … tcp:` smoke; the
release mac jobs add `ardop`; `bundle-mac-deps` signs it like rigctld. `ArdopProcess.ardopSupported`
returns true on darwin; the "no macOS build" reason goes.

### Dire Wolf (packet) over the bridge
Dire Wolf's audio layer is one abstraction (`audio_open/get/put/flush` in `audio.c` / `audio_win.c`),
so a `tcp:<port>` backend is the ardopcf patch again: `third_party/direwolf/potacat-socket-audio.patch`
generated by a sibling of `gen-ardopcf-patch.py` from the pinned 1.8.1 source, `ADEVICE tcp:<port>`.
Until it lands, packet keeps the device route; on Flex Direct / Icom Network packet stays
unavailable with the existing reason. (GPL-2: a patch to a separately built, separately run program;
the patch ships in the repo with the source pointer, as the ardopcf one does.)

### VARA (closed source) — the virtual cable
VARA can only open a Windows sound device, so the operator installs a virtual cable (VB-Cable or
similar). The bridge window then opens the **cable's** input/output instead of the rig's, and the
radio side is whatever the rig's `audioSource` says (Flex Direct stream, Icom Network, or a second
bridge instance on the CODEC). Two bridge instances is the only new shape: `rig.modemCable
{inputId, outputId}` on the rig; the mail window's "Radio sound:" line reads "VARA ↔ cable ↔ Flex
Direct". Detail in `docs/vara-integration-plan.md`.

### Mercury
Later: Mercury's own FIFO backend is POSIX-only; a `tcp:` backend patch like ardopcf's would put
it on the same bridge. Not in this plan's phases.

## Settings and wire
- No new user-facing setting for the bridge itself. Removed: the ARDOP device picker and
  `rig.winlinkAudio`. New per-rig (VARA phase only): `rig.modemCable`.
- `winlink-state.audio` keeps its shape; `viaPotacat` becomes `true` for every rig, `capture` /
  `playback` carry the device labels the bridge opened (the mobile Mail tab shows them; handoff:
  one line, no new field).
- Bug report `**Winlink:**` line: `audio: bridge (USB Audio CODEC → USB Audio CODEC, 48 kHz, rx
  ok, tx ok)` or the fatal reason.

## Tests
| Test | What it proves |
|---|---|
| `test/modem-bridge-test.js` (Electron harness like `layout-alignment-test`, flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`) | the bridge window captures the fake device's tone, 20 ms batches reach a real `ModemAudioServer` at 12 kHz with the right frequency; `modem-bridge-tx` chunks play without error through `setSinkId('default')`; a bogus input id → the exact fatal text, no capture; stop frees the tracks |
| `test/modem-audio-server-test.js` (exists) | the socket side |
| `test/winlink-main-wiring-test.js` additions | `winlinkSocketAudioRoute` has no rig branch; session start builds the bridge for a sound-device rig; a bridge error ends the session; no code path opens a device by index; the picker is gone |
| `test/winlink-units-test.js` | `winlinkModesFor` — ardop available on darwin; packet gating unchanged until the Dire Wolf patch |
| `winlink-helpers.yml` | ardopcf builds and smokes on all five runners (mac via the stub) |

## Phases
1. **Bridge window + sound-device route (Windows/Linux, ardopcf):** the window, the IPC, the
   server hookup, the fatal-start rules, removal of the picker, tests. Verified on the IC-7300 /
   FTDX10 class of rig (USB CODEC): an ARDOP session with the same devices FT8 uses, nothing picked.
2. **macOS ardopcf:** stub header, build script darwin branch, CI, release jobs, gating. Verified
   by CI smoke + the first Mac user with a Flex (Flex Direct needs no bridge) or a CODEC rig.
3. **Dire Wolf socket patch:** packet joins the bridge; packet on Flex Direct / Icom Network and
   on macOS.
4. **VARA via cable** (its own plan).

## Verification (always a scratch `--user-data-dir`)
1. Phase 1 on Casey's QMX (`audioSource` dax? — it is a USB-CODEC class rig in his rig list) or any
   CODEC rig: session start logs `[Winlink] modem audio: bridge on "USB Audio CODEC" → "USB Audio
   CODEC"`, the mail-window waterfall paints from the bridge's frames, ARDOP calls a gateway, the
   wattmeter shows RF, PTT in step; stop → FT8 works again immediately.
2. Unplug the CODEC mid-session → session ends with the device text; replug → next session works
   without re-picking.
3. The latency figure from ardopcf's log printed into `[Winlink]`.
4. Phase 2: CI green on macos-14/macos-15-intel; a Mac user's log shows the bridge line.

## Risks
- `AudioContext.setSinkId` on Linux/PipeWire has had sink-selection bugs in Chromium; fallback is
  an `<audio>` element with `setSinkId` fed by a `MediaStreamDestination` (the ECHOCAT bridge's
  older route). Decide in the spike, keep one.
- Capture at 48 kHz → 12 kHz resample lands on the server's resampler; CPU is trivial, but the
  window must stay a *visible-false* BrowserWindow, not an offscreen one (offscreen windows
  throttle timers and the worklet with them — the actmap/share lesson).
- The hidden window is one more renderer during a session (~100 MB); destroyed at session end.
- A user who deliberately runs ardopcf's own device mode today (none known) loses nothing: the
  socket route is what shipped for Flex Direct and is the only route after phase 1.
