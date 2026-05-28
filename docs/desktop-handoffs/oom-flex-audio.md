# OOM crash — Flex Direct audio, ~1.7 GB after ~50 min

Status: ROOT-CAUSED + fixed 2026-05-28 (cd1d74a) — pending long-run confirmation
Filed: 2026-05-22
Repo: POTACAT desktop (`D:\Projects\potacat-dev`)
Reporter: K3SBP (Casey) — and prior reports 2026-05-18, 2026-05-20

## Resolution (2026-05-28)

Two leaks, both in the audio path, now addressed:

1. **main→renderer RX fan-out native IPC buffers** — fixed earlier by
   `audioSafeSend` bounded per-consumer queues (`be1051f`).
2. **dax_tx mic stream running during RX** (this commit, `cd1d74a`) —
   the real remaining leak. When the iOS app's WebRTC audio is connected,
   `startDaxTxTap` (remote-audio.html) runs an AudioWorklet that forwards
   the phone mic to the radio's `dax_tx` stream **continuously at ~188
   packets/sec, regardless of TX/RX**. So just *listening* on ECHOCAT
   pumped a nonstop silent TX stream — churning IPC + native buffers on
   both renderer and main until OOM. K3SBP's crash log showed the pipe at
   chunk #40000, peak 0.0000 (silence) during an RX-only listen.

   Fix: gate the dax_tx mic forwarding on TX state — renderer only posts
   chunks when `kiwiTxMuted` (the remote-tx-state broadcast) is set; main
   drops any chunk unless `_isEffectivelyTransmitting()`. Voice TX from the
   phone still flows (PTT sets `_remoteTxState`).

Confirm with a 50+ min ECHOCAT-connected RX listen and the per-process
`[Mem]` heartbeat — no process should climb now.

## Symptom

POTACAT crashes **entirely** (the whole Electron app exits) with
`FATAL ERROR: ... JavaScript heap out of memory`, V8 Mark-Compact stuck
at ~1723 MB, after roughly 50 minutes of uptime. Flex Direct audio was
running. Recurs across sessions.

## This is a known, recurring crash

`main.js` (the `audio-frame` handler, ~line 4035) carries a comment from
earlier reports: *"Main process OOM'd at ~1.7 GB after ~46 min of normal
operation (K3SBP 2026-05-18 and 2026-05-20 reports, both crashed at
identical heap ceiling)."* Commit `6e0ea58` ("Fix main-process OOM after
~46 min on SmartSDR Direct / Flex audio") addressed one aspect — it
stopped forwarding audio frames as plain `Array`s (24-byte HeapNumbers)
and kept them as `Float32Array`s, cutting GC thrash. **The crash still
happens** (2026-05-22), so that fix was incomplete or something
re-opened it.

## Log evidence (2026-05-22 crash)

- Main-process `[Mem]` heartbeat at the crash: `heap=45.5/51.5MB
  rss=1908.9MB ext=3.7MB ab=0.0MB`. Earlier the *same session* it read
  `rss=155.8MB`. So **main-process RSS grew ~155 MB → ~1.9 GB**, while
  the **JS heap stayed ~45 MB** and `arrayBuffers` stayed 0.
  → The main-process growth is **native / off-heap**, not JS objects.
- The fatal `JavaScript heap out of memory` is a V8 heap hitting ~1.7 GB.
  Main's own JS heap is only 45 MB — so the JS-heap OOM is in a
  **different process** (a renderer or worker). The whole app then
  exits (the `npm start` shell prompt returns).

So there are likely **two intertwined problems**: a native RSS leak in
the main process, and a JS-heap blow-up in a child process. They may
share a root cause (the audio path feeding both).

## The audio path

`smartSdrAudio.on('audio-frame', ...)` — `main.js:4034`. Under Flex
Direct this fires **~190×/sec**. It forwards `{ pcm, sampleRate }` via
`webContents.send('smartsdr-audio-frame', ...)` to:

- `remoteAudioWin` (`main.js:4045`) — the ECHOCAT audio bridge.
- `vfoPopoutWin` (`main.js:4051`) — **added 2026-05-21 this session**
  for the VFO popout's VOL audio monitor.
- the SSTV engine (`feedAudio`, upsampled) and JTCAT.

## Suspects, in priority order

1. **A renderer buffering frames unbounded.** A renderer that receives
   190 frames/sec and accumulates them in an array/queue grows ~1.7 GB
   and OOMs — and if it's a critical window, the app exits. Prime
   suspect: `remoteAudioWin` — does it queue audio for a WebRTC peer
   that may not be connected? Read its `smartsdr-audio-frame` handler
   (inline in `renderer/remote-audio.html`, exposed by
   `preload-remote-audio.js`). `6e0ea58`'s TypedArray fix would NOT cure
   an unbounded buffer.
2. **The `vfoPopoutWin` send (`main.js:4051`) — this session's change.**
   A 5th `webContents.send` per frame whenever the VFO popout is open.
   A/B test: does the OOM still happen with the VFO popout closed? The
   VFO popout's `onSmartSdrAudio` handler creates an `AudioBufferSource`
   per frame (~190/sec) when the monitor is on — confirm those are
   released, not retained.
3. **Native RSS leak in main.** RSS 155 MB → 1.9 GB with JS heap flat —
   `lib/smartsdr-audio.js` UDP/VITA-49 handling, or a native addon.

## Recommended first step — make the next run definitive

The `[Mem]` heartbeat only measures the **main** process, so we're blind
to renderer/worker memory. Add `app.getAppMetrics()` to the heartbeat
(it returns per-process memory for *every* Electron process). One ~50-min
run then shows exactly which process climbs — main vs. a specific
renderer vs. the GPU process. That converts guesswork into a pinpoint.

## Diagnostic procedure

1. Add per-process memory logging (above), or watch Task Manager →
   Details → the multiple POTACAT/Electron processes during a ~50-min
   Flex Direct run; note which one's memory climbs.
2. If a renderer: open its DevTools, take heap snapshots ~10 min apart,
   diff them — find the growing retainer (likely an array of audio
   frames).
3. A/B isolate: still OOM with the VFO popout closed? With SSTV decode
   off? With no ECHOCAT phone connected vs. connected?

## Workaround

Restart POTACAT — it takes ~50 min to recur.
