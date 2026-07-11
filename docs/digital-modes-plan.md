# Digital Modes — Unified View Plan

Status: PSK31 (Phase 2) shipped FIRST, 2026-07-11 — popout-only, one-shot Send
        (see "PSK31 as-built" below). RTTY (Phase 1) and JS8 (Phases 3-4)
        remain planned.
Filed: 2026-05-08
Scope: desktop, ECHOCAT Web, ECHOCAT iOS

## PSK31 as-built (2026-07-11) — deltas from this plan

Casey chose to build PSK31 before RTTY. What shipped and where it differs:

- **Engines live in main.js**, not the popout: `lib/psk-engine.js` (pure-JS
  DBPSK, inline, no worker) plugs into `JtcatManager.startSlice()` — this
  plan's "popout capture chain feeds the engine" wording was already stale
  for FT8 too. All audio routes (SmartSDR Direct, Icom UDP, renderer
  capture) feed it for free at the 12 kHz `feedAudio` choke points.
- **One-shot Send TX**, not a streaming TX queue: the typed buffer renders
  to a single PCM buffer (32-symbol idle preamble + varicode + 32-symbol
  carrier postamble) and rides the existing `tx-start` dispatch unchanged
  on every audio route. Live type-ahead streaming is a possible follow-up.
- **Desktop popout + ECHOCAT wire** (phone UI pending): the RX pane is
  `#jp-psk-pane` (applyWsprMode-style swap), IPC `jtcat-psk-rx` (250 ms char
  batches) + `jtcat-psk-send`. The same pair exists as WS messages for
  mobile (2f0c9be, 2026-07-11): `jtcat-psk-rx` with a ~2000-char replay
  tail on reconnect, `jtcat-psk-send`, remote jtcat-start/set-mode accept
  PSK31 (family switch rebuilds the slice), tx-status carries `durMs`.
  Phone UI handed off: `potacat-meta/work/open/psk31-mobile.md`. This plan's
  generic `digital-*` message family was NOT used — the messages are
  jtcat-namespaced to match the existing FT8/WSPR protocol.
- **Logging**: `lib/adif-writer.js` gained SUBMODE — PSK31 logs as
  MODE=PSK / SUBMODE=PSK31 (manual logging via the QSO popout; no QSO state
  machine for continuous modes).
- **Variants deferred**: engine is baud-parameterized but only PSK31 ships;
  PSK63/125 = variant picker + constants + tests later.
- Tests: `lib/psk-engine-test.js` (varicode round-trip, loopback, ±8 Hz AFC,
  noise, squelch, TX contract).

The JTCAT/FT8 popout (desktop) + FT8 screen (iOS) + FT8 view (ECHOCAT Web) become **the** digital-modes UI. Mode is a setting inside the view, not a separate window. One audio capture, one waterfall, one PTT route, one set of macros, one mobile screen. Switching from FT8 to PSK31 is a tab click, not an app navigation.

The window is conceptually renamed **JTCAT — Digital Modes**. Existing FT8/FT4/FT2 mode buttons at the top extend into a full mode bar.

## Window anatomy (shared shell, mode-specific panes)

```
┌─────────────────────────────────────────────────────────┐
│  Mode:  [FT8] [FT4] [FT2] [JS8] [PSK31] [RTTY]          │  ← mode bar
│  Band:  [40m 7.074 ▼]   Speed: [Normal ▼]               │  ← band + variant
├─────────────────────────────────────────────────────────┤
│             Waterfall (0–3000 Hz, shared)               │  ← single visual
│             [RX marker]   [TX marker]                   │
├─────────────────────────────────────────────────────────┤
│         RX PANE (mode-specific layout)                  │
├─────────────────────────────────────────────────────────┤
│         TX PANE (mode-specific composer)                │
├─────────────────────────────────────────────────────────┤
│  RX gain | TX power | Hold TX freq | macros | settings  │  ← shared footer
└─────────────────────────────────────────────────────────┘
```

### Mode bar

The buttons that exist today for FT8/FT4/FT2 grow to FT8/FT4/FT2/JS8/PSK31/RTTY. Active mode is highlighted. Clicking a mode:

1. Stops the current engine (decode worker, TX synth).
2. Wires up the new engine.
3. Swaps the RX and TX panes (DOM-level swap; both pre-rendered, just `display: none` toggled).
4. Updates the speed/variant picker if the mode has variants.
5. Updates the rig mode via the existing `rig-utils.js` mapping (already wired for all six modes).
6. Persists the choice in `settings.jtcatLastMode` so reopen lands on the same mode.

### Speed/variant picker

Only appears when the mode has variants:

| Mode | Variants |
|---|---|
| FT8 | (none) |
| FT4 | (none) |
| FT2 | (none) |
| JS8 | Slow (6.25) / Normal (12.5) / Fast (25) / Turbo (50) baud |
| PSK31 | PSK31 / PSK63 / PSK125 |
| RTTY | 45.45 / 75 / 100 baud, 170 / 425 / 850 Hz shift |

For modes without variants the picker hides.

### Shared waterfall

The existing JTCAT waterfall (`popoutAnalyser` + canvas at 0–3000 Hz) handles all six modes — same audio passband, same FFT. Mode-specific:

- **FT8/FT4/FT2/JS8**: RX marker = decode passband target. TX marker = where outgoing slot will land.
- **PSK31/RTTY**: RX marker = audio center we're tracking (clicking the waterfall at a station's signal sets the center). TX marker = same; PSK/RTTY transmit at the same audio frequency they receive on.

Marker rendering already supports independent RX/TX positions, so this works with no waterfall changes.

### RX pane (mode-specific)

Two layout styles, switchable via `display:none`:

**Slot-based modes (FT8 / FT4 / FT2 / JS8)** — existing JTCAT decode list:
- Per-slot rows: timestamp, SNR, DT, freq, message
- Click a station's callsign to engage / start QSO state machine
- Filter chips: CQ-only, watchlist, needed entities

**Continuous modes (PSK31 / RTTY)** — scrolling text:
- Top region: scrolling decoded characters as they arrive
- Selectable text → click to copy to TX or to log fields
- Optional multi-station view: PSK can decode several stations in the passband; tabs per detected callsign
- Right-click a callsign in the stream to populate the LOG dialog

**JS8 hybrid** — slot list + conversation thread:
- Top: slot decode list (same as FT8)
- Bottom of RX pane: conversation thread for the currently-engaged station (chat-bubble layout). Switching engaged stations swaps the thread.

### TX pane (mode-specific)

**FT8/FT4/FT2** (existing): message templates (`CQ K3SBP FN20`, `K3ABC RR73`, etc.), Auto-Seq button, slot-aware "TX next slot" toggle, cycle countdown.

**JS8**: free-text input box (max ~140 chars per frame). Macros: Heartbeat, CQ, ACK, MSG, Beacon. "Directed to" dropdown — when set, TX is prefixed `@K3ABC ` for the selected station. Frame-count indicator showing how many transmission cycles the message will take at the current speed.

**PSK31/RTTY**: TX text buffer (multi-line), live cursor showing where the encoder currently is in the stream. Macros bar (`CQ`, `name`, `QTH`, `73`, `BTU`). Send button enters the buffer into the TX queue; PTT keys, encoder runs through the queue, drops PTT when buffer empties (or on a stop button).

The DOM for all three TX panes is pre-rendered and swapped on mode change.

### Shared footer

RX gain, TX power, Hold TX Freq toggle, audio device selector, settings gear — all the controls that already exist below the JTCAT TX area, unchanged. They apply to whichever engine is currently active.

## Architecture (engine swapping in the same shell)

### Single engine factory

```js
// lib/digital-modes-engine.js (new)
function createEngine(mode, opts) {
  switch (mode) {
    case 'FT8':
    case 'FT4':
    case 'FT2':
      return new Ft8Engine({ ...opts, mode });   // existing
    case 'JS8':
      return new Js8Engine(opts);                 // new (Phase 3-4)
    case 'PSK31':
      return new PskEngine(opts);                 // new (Phase 2)
    case 'RTTY':
      return new RttyEngine(opts);                // new (Phase 1)
  }
}
```

All engines implement the same interface:
- `start()` / `stop()`
- `feedAudio(samples)` — same shape Ft8Engine uses
- `setTxMessage(text)` — composer hands off here
- Events: `decode` (slot or character), `tx-status`, `silent`

The existing `jtcat-manager.js` becomes mode-agnostic — it owns the active engine and routes audio + lifecycle. Per-slice (multi-decoder) work continues to apply.

### Mode-specific decode workers

```
lib/
  ft8-engine.js          existing
  js8-engine.js          new (Phase 3+)
  js8-worker.js          new (Phase 3+) — uses native LDPC/Costas
  js8_native/            new (Phase 3+) — C++ codec, mirrors ft8_native
  psk-engine.js          new (Phase 2) — pure-JS, runs inline
  rtty-engine.js         new (Phase 1) — pure-JS, runs inline
```

PSK and RTTY don't need workers — their decode CPU is tiny (~1–2% per channel). FT8/FT4/FT2 keep their existing worker. JS8 needs a worker because of LDPC.

### Audio capture stays shared

The existing JTCAT capture chain (`getUserMedia` → `popoutAudioCtx` → `popoutRxGainNode` → `popoutAnalyser` + AudioWorklet) feeds whatever engine is active. The worklet posts samples; the popout decides which engine receives them based on `currentMode`. No new audio infrastructure.

The PSK/RTTY engines accept the same 12 kHz sample stream; they internally decimate/filter to their working rate (8 kHz or even narrower for PSK31's tone-tracking PLL).

### Settings persistence

```
settings.jtcatLastMode       'FT8' | 'FT4' | 'FT2' | 'JS8' | 'PSK31' | 'RTTY'
settings.jtcatLastVariant    per-mode last-selected variant
settings.jtcatRxGain         already exists
settings.jtcatHoldTxFreq     already exists
settings.js8HeartbeatEnabled (new, Phase 4)
settings.js8DefaultSpeed     (new, Phase 4)
settings.pskAudioCenter      default 1500 Hz (new, Phase 2)
settings.rttyShift           default 170 Hz (new, Phase 1)
```

## ECHOCAT (Web + iOS) — same unification

The browser ECHOCAT FT8 view (`renderer/remote.html` / `remote.js`) and the iOS `Ft8Screen.tsx` get the same mode bar at the top. Same swap-pane shape. Mobile picks decoded data from new WS message types:

```
S2C (server → client)
  digital-mode-set       which mode the desktop is in (the desktop is source of truth)
  digital-decode         { mode, … } — slot decode (FT8/FT4/JS8) OR character batch (PSK/RTTY)
  digital-tx-status      { mode, state, message? }
  digital-spectrum       same as today's jtcat-spectrum

C2S (client → server)
  digital-mode-set       mobile asks desktop to switch modes
  digital-tx             { mode, message, freq? }
  digital-tx-stop
  digital-set-variant    speed / shift / etc.
```

The existing `jtcat-decode-batch`, `jtcat-status`, `jtcat-tx-status` messages stay (FT8 family is the most common) but get a `mode` field; new messages cover the new cases. Backwards-compatible.

The iOS app's existing FT8 screen subscribes to the new `digital-decode` channel; per-mode rendering branches inside the screen. Single screen, same pattern.

## Reused infrastructure (already done)

- **Rig tune mappings** — `lib/rig-utils.js` routes all six modes correctly.
- **Spot table** — PSK31/RTTY/JS8 filter chips + Digital (all) preset.
- **DX cluster mode inference** — recognizes PSK31/RTTY/JS8 in comment text.
- **CW_DIGI_MODES** — license-privilege check covers all six.
- **ADIF logging** — `saveQsoRecord` accepts arbitrary mode strings; broadcasts to mobile on save.

## Per-mode technical brief

### RTTY (Baudot 45.45)
AFSK at mark=2125 / space=1955 (170 Hz shift). Mark/space tone detection via Goertzel filters at the two frequencies, edge detect on start bit, sample 5 data bits at symbol-period midpoints, track LTRS/FIGS shift state. ~200 LOC. TX is two-tone FSK; trivial generation. Reference: fldigi RTTY source.

### PSK31 (and PSK63 / PSK125)
BPSK at 31.25/62.5/125 baud, 1500 Hz audio center, ±15 Hz wide. Costas/PLL phase tracking per symbol period, threshold the cumulative phase shift, decode through varicode (variable-length self-synchronizing prefix code). ~300–400 LOC. TX synth is cosine-windowed BPSK; ~150 LOC. References: fldigi, jspsk.

### JS8Call
4-FSK derived from FT8 — Costas-array sync at slot start, payload, CRC, LDPC FEC. Slot length depends on speed (Normal = 15s like FT8, Slow = 30s, Fast = 10s, Turbo = 6s). Native addon for the LDPC + Costas decoder (mirrors `lib/ft8_native`); pure-JS would CPU-spike on busy bands. The directed-message and conversation layer is the bigger UX piece — `@CALLSIGN MSG`, heartbeat, beacon, relay. Source: github.com/js8call/js8call.

## Phasing

### Phase 1 — RTTY inside the unified shell

Smallest mode, simplest DSP, tests the engine-swapping pattern.

- Add RTTY to mode bar (desktop + iOS + web)
- `lib/rtty-engine.js` (~400 LOC)
- RX text-stream pane (new, reused for PSK in Phase 2)
- TX buffer + macros pane (new, reused for PSK)
- Engine factory + swap logic in jtcat-popout
- ECHOCAT new message types: `digital-mode-set`, `digital-decode` (text variant), `digital-tx`, `digital-tx-status`
- iOS handoff: add RTTY tab to FT8 screen + character-stream subview

Delivers: end-to-end RTTY RX+TX via desktop and iOS.

Estimated: 3 sessions, ~1200 LOC desktop, ~400 LOC iOS handoff spec.

### Phase 2 — PSK31

- Add PSK31 to mode bar
- `lib/psk-engine.js` (~600 LOC)
- Reuses Phase 1's text-stream pane
- Click-to-tune-audio-center on the waterfall
- Variant picker (PSK31/63/125)
- iOS handoff: enable PSK31 in the same Digital Modes screen

Estimated: 2 sessions, ~700 LOC desktop.

### Phase 3 — JS8Call RX

- Native codec build (`lib/js8_native/`)
- `lib/js8-engine.js` (~600 LOC JS shell over native)
- JS8 added to mode bar
- Slot list pane (reuses FT8 slot list with mode-aware rendering)
- Speed picker
- ECHOCAT: extend `digital-decode` for JS8 slot batches
- CI: native addon build for JS8 mirrors ft8_native (windows-2022 pin already done)

Estimated: 4 sessions, ~400 LOC native, ~600 LOC JS, ~400 LOC popout.

### Phase 4 — JS8Call TX + messaging

- Encoder + native LDPC encode side
- Free-text composer + macros (Heartbeat, CQ, ACK, MSG, Beacon)
- Conversation thread pane (chat layout, swaps with engaged station)
- Heartbeat scheduler (auto-TX every N minutes when enabled)
- Directed-message protocol: `@CALLSIGN MSG`, parse incoming directed frames, push notification (mobile) when one arrives
- iOS handoff: chat-style conversation view

Estimated: 4 sessions, ~800 LOC desktop, ~500 LOC iOS handoff spec.

### Phase 5 — Polish + multi-station decode

- PSK31 multi-decoder: scan the entire passband, decode multiple concurrent BPSK streams, tab UI per station
- RTTY waterfall fine-tune (click to land on the mark tone exactly)
- ECHOCAT bandwidth optimization: text-stream throttling for slow links
- ADIF SUBMODE field for "PSK31"/"PSK63" granularity (separate from MODE = "PSK")

Estimated: 2–3 sessions.

## Risks and tradeoffs

1. **Window real estate.** The unified shell has to fit FT8's slot list, PSK's text stream, AND JS8's chat. Pre-rendered DOM with `display:none` toggles handles it; total weight is fine.
2. **JS8Call native build.** Same risk profile as ft8_native — MSVC variable-length-array workarounds, the windows-2022 CI pin we already have. Manageable but slow.
3. **Audio device contention.** Solved at engine-swap time: stop the previous engine cleanly before starting the new one. Same pattern as today's FT8↔FT4 switch.
4. **Branding.** "JTCAT" historically meant WSJT family. Adding PSK31/RTTY stretches the name. Default: keep "JTCAT — Digital Modes" in window title; no code symbol churn.
5. **iOS surface area growth.** A single Digital Modes screen with five+ modes inside it gets dense. The iOS team may want a master/detail pattern: top-level mode picker → per-mode subview. Worth a conversation in the Phase 1 handoff.
6. **Scope creep — SSTV.** SSTV is also "digital" but its workflow (image upload, manual TX, no QSO automation) is unlike the others. Keep SSTV in its own popout; do not absorb it into the Digital Modes shell.

## Sequencing

Ship Phase 1 (RTTY) first as the proof of the unified-shell architecture. Once engine-swap, mode-bar, pane-toggle, and ECHOCAT-protocol-extension patterns are settled, Phase 2 (PSK31) is mechanical reuse. JS8 stays last because it's the heaviest piece and benefits from the patterns being settled first.
